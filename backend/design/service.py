"""Design service orchestration (B1–B7).

Flow: parse input → knowledge → sanitize/OCR → provider → schema/core validate
→ optional single repair → provenance response. No catalog/BLE writes.

``sanitize_image`` and OCR run in worker threads so ``asyncio.wait_for`` can
enforce the total request timeout. Text mode never sends image bytes.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

from design.config import DesignConfig, load_design_config
from design.errors import (
    DesignConfigError,
    DesignError,
    DesignTimeoutError,
    DesignUnavailableError,
    DesignValidationError,
)
from design.image_processing import SanitizedImage, sanitize_image
from design.knowledge import KnowledgeBundle, load_knowledge_bundle
from design.ocr import OcrAdapter, default_ocr_adapter
from design.prompts import DesignPrompt, build_design_prompt, build_repair_prompt
from design.provider import DesignProvider, ProviderRequest, build_provider
from design.schema import schema_version
from design.validation import ValidationResult, validate_design_document

logger = logging.getLogger(__name__)

# Absolute local paths only — do not treat relative ``home/foo`` as absolute.
# Windows: drive letter + backslash or forward slash (``C:\...`` / ``C:/...``).
_WIN_ABS_PATH_RE = re.compile(
    r"(?i)\b[a-z]:(?:\\+|/+)\S*"
)
# POSIX-style absolute roots only when the path starts with ``/`` (not ``home/foo``).
_POSIX_ABS_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_])/(?:home|Users|tmp|var|etc|root|opt|usr|private)"
    r"/[^\s\"'<>|]+"
)


@dataclass(frozen=True)
class DesignInput:
    """Normalized design request from JSON or multipart."""

    text: str
    image_bytes: bytes | None = None
    image_content_type: str | None = None
    beverage_hint: str | None = None


class DesignService:
    """Coordinates knowledge, media, provider, and validation for one design call."""

    def __init__(
        self,
        config: DesignConfig,
        *,
        provider: DesignProvider | None = None,
        knowledge: KnowledgeBundle | None = None,
        ocr: OcrAdapter | None = None,
        http_client: httpx.AsyncClient | None = None,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.config = config
        self._provider = provider
        self._knowledge = knowledge
        self._ocr = ocr or default_ocr_adapter(default_timeout_s=config.ocr_timeout_s)
        self._http_client = http_client
        self._http_transport = http_transport
        self._owns_provider = provider is None

    def _ensure_provider(self) -> DesignProvider:
        if self._provider is None:
            self._provider = build_provider(
                self.config,
                client=self._http_client,
                transport=self._http_transport,
            )
        return self._provider

    def _ensure_knowledge(self) -> KnowledgeBundle:
        if self._knowledge is None:
            self._knowledge = load_knowledge_bundle(
                knowledge_dir=self.config.knowledge_dir,
                knowledge_dev_root=self.config.knowledge_dev_root,
            )
        return self._knowledge

    async def aclose(self) -> None:
        if self._owns_provider and self._provider is not None:
            close = getattr(self._provider, "aclose", None)
            if close is not None:
                await close()
        self._provider = None

    def _sanitize_optional_image(self, design_input: DesignInput) -> SanitizedImage | None:
        if design_input.image_bytes is None:
            return None
        return sanitize_image(
            design_input.image_bytes,
            content_type=design_input.image_content_type,
            allowed_mime=self.config.allowed_mime,
            max_bytes=self.config.max_image_bytes,
            max_pixels=self.config.max_image_pixels,
        )

    def _ocr_text(self, image: SanitizedImage) -> str:
        """Run OCR once. ``OcrAdapter.extract_text`` requires ``timeout_s``; no retry."""

        return self._ocr.extract_text(image, timeout_s=self.config.ocr_timeout_s)

    def initialize(self) -> None:
        """Eagerly validate provider capability and knowledge (no network, no BLE).

        Raises design config/unavailable errors so startup can fail closed when
        design is explicitly configured. Safe to call more than once.
        """

        knowledge = self._ensure_knowledge()
        provider = self._ensure_provider()
        if self.config.design_mode == "vision" and not getattr(
            provider, "supports_vision", False
        ):
            raise DesignConfigError(
                "configured provider does not support vision; "
                "set XBLOOM_DESIGN_MODE=text or use a vision-capable provider",
                code="vision_unavailable",
            )
        # Touch fields so static analyzers / tests know both are loaded.
        _ = knowledge.version
        _ = provider.name

    async def design(self, design_input: DesignInput) -> dict[str, Any]:
        """Run a full design request and return the public response body."""

        try:
            return await asyncio.wait_for(
                self._design_inner(design_input),
                timeout=self.config.timeout_s,
            )
        except asyncio.TimeoutError as exc:
            raise DesignTimeoutError(
                f"design processing exceeded {self.config.timeout_s}s",
                details={"timeout_s": self.config.timeout_s},
            ) from exc

    async def _design_inner(self, design_input: DesignInput) -> dict[str, Any]:
        if not isinstance(design_input.text, str):
            raise DesignValidationError("text must be a string", code="invalid_request")

        knowledge = self._ensure_knowledge()
        provider = self._ensure_provider()
        mode = self.config.design_mode

        sanitized: SanitizedImage | None = None
        ocr_text: str | None = None
        image_for_provider: SanitizedImage | None = None

        try:
            if design_input.image_bytes is not None:
                # Offload CPU-bound decode/sanitize so the event loop can honor timeouts.
                sanitized = await asyncio.to_thread(self._sanitize_optional_image, design_input)
                if mode == "vision":
                    if not getattr(provider, "supports_vision", False):
                        raise DesignConfigError(
                            "configured provider does not support vision; "
                            "set XBLOOM_DESIGN_MODE=text or use a vision-capable provider",
                            code="vision_unavailable",
                        )
                    image_for_provider = sanitized
                elif mode == "text":
                    # Real local OCR on a worker thread; never send image bytes to the provider.
                    assert sanitized is not None
                    ocr_text = await asyncio.to_thread(self._ocr_text, sanitized)
                    image_for_provider = None
                else:
                    raise DesignConfigError(
                        f"invalid design mode: {mode}",
                        code="configuration_error",
                    )
            else:
                image_for_provider = None

            prompt = build_design_prompt(
                knowledge=knowledge,
                user_text=design_input.text,
                ocr_text=ocr_text,
                has_image=image_for_provider is not None,
                beverage_hint=design_input.beverage_hint,
            )

            # First provider attempt.
            first = await provider.complete(
                ProviderRequest(
                    prompt=prompt,
                    image=image_for_provider,
                    timeout_s=self.config.provider_timeout_s,
                )
            )
            # Clear image reference ASAP after first call; repair may still need it in vision.
            result = validate_design_document(first.text, first.parsed)
            repaired = False
            provider_model = first.model or self.config.model
            provider_name = first.provider or provider.name

            if not result.valid:
                # Single constrained repair attempt only.
                repair_prompt = build_repair_prompt(
                    original=prompt,
                    invalid_output=first.text,
                    errors=result.error_messages(),
                )
                second = await provider.complete(
                    ProviderRequest(
                        prompt=repair_prompt,
                        image=image_for_provider if mode == "vision" else None,
                        timeout_s=self.config.provider_timeout_s,
                    )
                )
                repaired_result = validate_design_document(second.text, second.parsed)
                repaired = True
                result = repaired_result
                provider_model = second.model or provider_model
                provider_name = second.provider or provider_name

            return self._build_response(
                result=result,
                knowledge=knowledge,
                prompt=prompt,
                provider_name=provider_name,
                provider_model=provider_model,
                design_mode=mode,
                repaired=repaired,
                used_image=image_for_provider is not None,
                used_ocr=ocr_text is not None,
            )
        finally:
            # Drop large buffers; never persist.
            sanitized = None
            image_for_provider = None
            design_input = DesignInput(text=design_input.text)  # drop image bytes reference

    def _build_response(
        self,
        *,
        result: ValidationResult,
        knowledge: KnowledgeBundle,
        prompt: DesignPrompt,
        provider_name: str,
        provider_model: str,
        design_mode: str,
        repaired: bool,
        used_image: bool,
        used_ocr: bool,
    ) -> dict[str, Any]:
        provenance = {
            "provider": provider_name,
            "model": provider_model,
            "knowledge_version": knowledge.version,
            "knowledge_content_hash": knowledge.content_hash,
            "knowledge_source": knowledge.source,
            "prompt_template_version": prompt.prompt_template_version,
            "schema_version": schema_version(),
            "candidate_hash": result.candidate_hash,
            "design_mode": design_mode,
            "repaired": repaired,
            "used_image": used_image,
            "used_ocr": used_ocr,
        }
        # Explicit redaction guarantees for public response.
        body: dict[str, Any] = {
            "recipe_candidate": result.recipe_candidate,
            "design_rationale": result.design_rationale,
            "evidence": result.evidence,
            "validation": {
                "valid": result.valid,
                "errors": [e.to_dict() for e in result.errors],
                "beverage": result.beverage,
                "repaired": repaired,
            },
            "provenance": provenance,
        }
        return _redact_public_response(body, api_key=self.config.api_key)


def redact_public_string(value: str, *, api_key: str = "") -> str:
    """Redact API-key material and recognizable absolute local paths from a string."""

    out = value
    if api_key:
        # Replace every occurrence of the configured secret value.
        out = out.replace(api_key, "[redacted-secret]")
    out = _WIN_ABS_PATH_RE.sub("[redacted-path]", out)
    out = _POSIX_ABS_PATH_RE.sub("[redacted-path]", out)
    return out


def redact_public_value(obj: Any, *, api_key: str = "") -> Any:
    """Walk dict/list/str structures and redact secrets and absolute paths.

    Unlike response allowlisting, this keeps structure (for error bodies) and only
    rewrites string leaves.
    """

    if isinstance(obj, dict):
        return {k: redact_public_value(v, api_key=api_key) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_public_value(v, api_key=api_key) for v in obj]
    if isinstance(obj, str):
        return redact_public_string(obj, api_key=api_key)
    return obj


def _redact_public_response(body: dict[str, Any], *, api_key: str = "") -> dict[str, Any]:
    """Ensure secrets, raw images, CoT, and absolute local paths are not present."""

    forbidden_keys = {
        "api_key",
        "authorization",
        "XBLOOM_LLM_API_KEY",
        "raw_image",
        "image_base64",
        "image_bytes",
        "chain_of_thought",
        "reasoning",
        "thinking",
        "local_path",
        "file_path",
        "image_path",
        "path",
        "command",
        "shell",
        "secret",
        "secrets",
        "token",
        "password",
    }

    def walk(obj: Any) -> Any:
        if isinstance(obj, dict):
            out: dict[str, Any] = {}
            for key, value in obj.items():
                key_l = key.lower() if isinstance(key, str) else key
                if key in forbidden_keys or key_l in forbidden_keys:
                    continue
                out[key] = walk(value)
            return out
        if isinstance(obj, list):
            return [walk(v) for v in obj]
        if isinstance(obj, str):
            return redact_public_string(obj, api_key=api_key)
        return obj

    return walk(body)


def design_env_configured() -> bool:
    """True when any design-related env var is explicitly set (non-empty).

    Used by lifespan to decide eager startup validation vs lazy first-request init.
    Control-only deployments with no design env remain backward-compatible.
    """

    for name in (
        "XBLOOM_LLM_BASE_URL",
        "XBLOOM_KNOWLEDGE_DIR",
        "XBLOOM_KNOWLEDGE_DEV_ROOT",
        "XBLOOM_LLM_PROVIDER",
        "XBLOOM_DESIGN_MODE",
    ):
        raw = os.environ.get(name)
        if raw is not None and raw.strip():
            return True
    return False


def design_service_from_env(
    *,
    provider: DesignProvider | None = None,
    knowledge: KnowledgeBundle | None = None,
    ocr: OcrAdapter | None = None,
    http_client: httpx.AsyncClient | None = None,
    http_transport: httpx.AsyncBaseTransport | None = None,
) -> DesignService:
    """Build a DesignService from environment configuration (not yet initialized)."""

    try:
        config = load_design_config()
    except ValueError as exc:
        raise DesignConfigError(str(exc), code="configuration_error") from exc
    return DesignService(
        config,
        provider=provider,
        knowledge=knowledge,
        ocr=ocr,
        http_client=http_client,
        http_transport=http_transport,
    )


def initialize_design_service_from_env(
    *,
    provider: DesignProvider | None = None,
    knowledge: KnowledgeBundle | None = None,
    ocr: OcrAdapter | None = None,
    http_client: httpx.AsyncClient | None = None,
    http_transport: httpx.AsyncBaseTransport | None = None,
) -> DesignService:
    """Load config, validate provider name/capability and knowledge; no network.

    Call at process startup when design env is configured so unsupported providers
    or missing knowledge fail before the first design request. Does not connect
    BLE and does not call the LLM.
    """

    service = design_service_from_env(
        provider=provider,
        knowledge=knowledge,
        ocr=ocr,
        http_client=http_client,
        http_transport=http_transport,
    )
    service.initialize()
    return service


# Re-export error types used by routes.
__all__ = [
    "DesignInput",
    "DesignService",
    "design_env_configured",
    "design_service_from_env",
    "initialize_design_service_from_env",
    "redact_public_string",
    "redact_public_value",
    "DesignError",
    "DesignConfigError",
    "DesignUnavailableError",
    "DesignValidationError",
    "DesignTimeoutError",
]
