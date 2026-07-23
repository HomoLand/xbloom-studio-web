"""Design-service configuration from environment variables.

Secrets (``XBLOOM_LLM_API_KEY``) are held only in memory and must never be
logged or returned in HTTP responses.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


DEFAULT_PROVIDER = "openai-compatible"
DEFAULT_MODEL = "grok-4.5"
DEFAULT_DESIGN_MODE = "vision"
DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MiB
DEFAULT_MAX_IMAGE_PIXELS = 20_000_000  # 20 MP decoded
DEFAULT_TIMEOUT_S = 60.0
DEFAULT_PROVIDER_TIMEOUT_S = 45.0
DEFAULT_OCR_TIMEOUT_S = 15.0
DEFAULT_ALLOWED_MIME = frozenset({"image/jpeg", "image/png", "image/webp"})
PROMPT_TEMPLATE_VERSION = "design-v1"

# Request-body budget beyond the image: text (8k) + beverage (32) + multipart framing.
DESIGN_TEXT_MAX_CHARS = 8000
DESIGN_BEVERAGE_MAX_CHARS = 32
DESIGN_BODY_TEXT_OVERHEAD_BYTES = 16 * 1024  # text + beverage + field headers
DESIGN_BODY_MULTIPART_FRAMING_BYTES = 8 * 1024


def max_design_request_body_bytes(max_image_bytes: int) -> int:
    """Upper bound for ``POST /api/design`` raw body (image + tightly bounded overhead)."""

    return int(max_image_bytes) + DESIGN_BODY_TEXT_OVERHEAD_BYTES + DESIGN_BODY_MULTIPART_FRAMING_BYTES


def _env(name: str, default: str | None = None) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    stripped = raw.strip()
    return stripped if stripped else default


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def _env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


@dataclass(frozen=True)
class DesignConfig:
    """Resolved design configuration (no secrets in ``repr``)."""

    provider: str = DEFAULT_PROVIDER
    base_url: str = ""
    model: str = DEFAULT_MODEL
    api_key: str = field(default="", repr=False)
    design_mode: str = DEFAULT_DESIGN_MODE
    knowledge_dir: str | None = None
    knowledge_dev_root: str | None = None
    max_image_bytes: int = DEFAULT_MAX_IMAGE_BYTES
    max_image_pixels: int = DEFAULT_MAX_IMAGE_PIXELS
    timeout_s: float = DEFAULT_TIMEOUT_S
    provider_timeout_s: float = DEFAULT_PROVIDER_TIMEOUT_S
    ocr_timeout_s: float = DEFAULT_OCR_TIMEOUT_S
    allowed_mime: frozenset[str] = DEFAULT_ALLOWED_MIME
    prompt_template_version: str = PROMPT_TEMPLATE_VERSION

    @property
    def max_request_body_bytes(self) -> int:
        return max_design_request_body_bytes(self.max_image_bytes)

    def redacted_dict(self) -> dict[str, object]:
        """Safe summary for diagnostics (never includes the API key)."""

        return {
            "provider": self.provider,
            "base_url": self.base_url,
            "model": self.model,
            "api_key_configured": bool(self.api_key),
            "design_mode": self.design_mode,
            "knowledge_dir_set": bool(self.knowledge_dir),
            "knowledge_dev_root_set": bool(self.knowledge_dev_root),
            "max_image_bytes": self.max_image_bytes,
            "max_image_pixels": self.max_image_pixels,
            "timeout_s": self.timeout_s,
            "provider_timeout_s": self.provider_timeout_s,
            "ocr_timeout_s": self.ocr_timeout_s,
            "max_request_body_bytes": self.max_request_body_bytes,
            "allowed_mime": sorted(self.allowed_mime),
            "prompt_template_version": self.prompt_template_version,
        }


def load_design_config() -> DesignConfig:
    """Load design config from process environment.

    Raises ``ValueError`` for malformed numeric bounds (caught as config error).
    """

    provider = (_env("XBLOOM_LLM_PROVIDER", DEFAULT_PROVIDER) or DEFAULT_PROVIDER).lower()
    model = _env("XBLOOM_LLM_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL
    base_url = _env("XBLOOM_LLM_BASE_URL", "") or ""
    api_key = os.environ.get("XBLOOM_LLM_API_KEY", "")  # preserve exact secret value
    design_mode = (_env("XBLOOM_DESIGN_MODE", DEFAULT_DESIGN_MODE) or DEFAULT_DESIGN_MODE).lower()
    if design_mode not in {"vision", "text"}:
        raise ValueError("XBLOOM_DESIGN_MODE must be 'vision' or 'text'")

    allowed_raw = _env("XBLOOM_DESIGN_ALLOWED_MIME")
    if allowed_raw:
        allowed = frozenset(part.strip().lower() for part in allowed_raw.split(",") if part.strip())
        if not allowed:
            raise ValueError("XBLOOM_DESIGN_ALLOWED_MIME is empty after parsing")
    else:
        allowed = DEFAULT_ALLOWED_MIME

    return DesignConfig(
        provider=provider,
        base_url=base_url.rstrip("/"),
        model=model,
        api_key=api_key,
        design_mode=design_mode,
        knowledge_dir=_env("XBLOOM_KNOWLEDGE_DIR"),
        knowledge_dev_root=_env("XBLOOM_KNOWLEDGE_DEV_ROOT"),
        max_image_bytes=_env_int(
            "XBLOOM_DESIGN_MAX_IMAGE_BYTES",
            DEFAULT_MAX_IMAGE_BYTES,
            minimum=1_024,
            maximum=25 * 1024 * 1024,
        ),
        max_image_pixels=_env_int(
            "XBLOOM_DESIGN_MAX_IMAGE_PIXELS",
            DEFAULT_MAX_IMAGE_PIXELS,
            minimum=10_000,
            maximum=100_000_000,
        ),
        timeout_s=_env_float(
            "XBLOOM_DESIGN_TIMEOUT_S",
            DEFAULT_TIMEOUT_S,
            minimum=1.0,
            maximum=300.0,
        ),
        provider_timeout_s=_env_float(
            "XBLOOM_DESIGN_PROVIDER_TIMEOUT_S",
            DEFAULT_PROVIDER_TIMEOUT_S,
            minimum=1.0,
            maximum=300.0,
        ),
        ocr_timeout_s=_env_float(
            "XBLOOM_DESIGN_OCR_TIMEOUT_S",
            DEFAULT_OCR_TIMEOUT_S,
            minimum=0.5,
            maximum=120.0,
        ),
        allowed_mime=allowed,
    )
