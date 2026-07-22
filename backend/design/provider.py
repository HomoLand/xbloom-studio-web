"""LLM provider protocol and OpenAI-compatible adapter.

Only the selected OpenAI-compatible adapter is implemented. Boundaries are
kept suitable for future Anthropic/Gemini adapters without fake stubs.
Configuration uses separate env vars (see ``design.config``). The API key is
never logged or returned.
"""

from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

import httpx

from design.config import DesignConfig
from design.errors import DesignConfigError, DesignProviderError, DesignTimeoutError
from design.image_processing import SanitizedImage
from design.prompts import DesignPrompt

logger = logging.getLogger(__name__)

SUPPORTED_PROVIDERS = frozenset({"openai-compatible"})


@dataclass(frozen=True)
class ProviderRequest:
    """Normalized request to a design provider."""

    prompt: DesignPrompt
    image: SanitizedImage | None = None
    timeout_s: float = 45.0


@dataclass(frozen=True)
class ProviderResponse:
    """Provider completion as raw text plus optional parsed JSON."""

    text: str
    parsed: dict[str, Any] | None = None
    model: str = ""
    provider: str = ""
    usage: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class DesignProvider(Protocol):
    """Adapter boundary for design LLM backends."""

    name: str
    model: str
    supports_vision: bool
    supports_structured_output: bool

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        """Run one completion. Must not log or return API keys."""


class OpenAICompatibleProvider:
    """OpenAI Chat Completions-compatible HTTP adapter (injectable httpx client)."""

    name = "openai-compatible"
    supports_vision = True
    supports_structured_output = True

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str,
        client: httpx.AsyncClient | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not base_url:
            raise DesignConfigError(
                "XBLOOM_LLM_BASE_URL is required for openai-compatible provider",
                code="llm_base_url_required",
            )
        self.model = model
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._owns_client = client is None
        if client is not None:
            self._client = client
        else:
            self._client = httpx.AsyncClient(transport=transport, timeout=60.0)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _build_messages(self, request: ProviderRequest) -> list[dict[str, Any]]:
        user_content: Any
        if request.image is not None:
            b64 = base64.standard_b64encode(request.image.data).decode("ascii")
            data_url = f"data:{request.image.mime_type};base64,{b64}"
            user_content = [
                {"type": "text", "text": request.prompt.user_text},
                {
                    "type": "image_url",
                    "image_url": {"url": data_url},
                },
            ]
        else:
            user_content = request.prompt.user_text

        return [
            {"role": "system", "content": request.prompt.system},
            {"role": "user", "content": user_content},
        ]

    def _build_body(self, request: ProviderRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": self._build_messages(request),
            "temperature": 0.2,
        }
        # Prefer structured JSON schema when the proxy supports it.
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "xbloom_design_output",
                "strict": True,
                "schema": request.prompt.response_schema,
            },
        }
        return body

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        if request.image is not None and not self.supports_vision:
            raise DesignProviderError(
                "provider does not support vision images",
                code="provider_capability",
                status_code=503,
            )

        url = f"{self._base_url}/chat/completions"
        body = self._build_body(request)
        # Log only non-secret metadata.
        logger.info(
            "design provider request provider=%s model=%s has_image=%s timeout_s=%s",
            self.name,
            self.model,
            request.image is not None,
            request.timeout_s,
        )

        try:
            response = await self._client.post(
                url,
                headers=self._headers(),
                json=body,
                timeout=request.timeout_s,
            )
        except httpx.TimeoutException as exc:
            raise DesignTimeoutError(
                "LLM provider timed out",
                details={"provider": self.name, "model": self.model},
            ) from exc
        except httpx.HTTPError as exc:
            raise DesignProviderError(
                f"LLM provider transport error: {type(exc).__name__}",
                code="provider_transport",
                details={"provider": self.name},
            ) from exc

        if response.status_code >= 400:
            # Never include response headers that may echo Authorization.
            raise DesignProviderError(
                f"LLM provider returned HTTP {response.status_code}",
                code="provider_http_error",
                details={"status_code": response.status_code, "provider": self.name},
                status_code=502,
            )

        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise DesignProviderError(
                "LLM provider returned non-JSON body",
                code="provider_invalid_response",
            ) from exc

        text = _extract_message_text(payload)
        parsed = _try_parse_json_object(text)
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        model = str(payload.get("model") or self.model)
        return ProviderResponse(
            text=text,
            parsed=parsed,
            model=model,
            provider=self.name,
            usage=usage,
        )


def _extract_message_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise DesignProviderError(
            "LLM provider response missing choices",
            code="provider_invalid_response",
        )
    first = choices[0]
    if not isinstance(first, dict):
        raise DesignProviderError(
            "LLM provider choice is not an object",
            code="provider_invalid_response",
        )
    message = first.get("message")
    if not isinstance(message, dict):
        raise DesignProviderError(
            "LLM provider message missing",
            code="provider_invalid_response",
        )
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Some APIs return content parts.
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text") or ""))
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    raise DesignProviderError(
        "LLM provider message content missing",
        code="provider_invalid_response",
    )


def _try_parse_json_object(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    # Strip optional markdown fences without accepting non-JSON bodies silently later.
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def build_provider(
    config: DesignConfig,
    *,
    client: httpx.AsyncClient | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> DesignProvider:
    """Construct the configured provider adapter.

    Unsupported provider names fail with a clear configuration error (no fake
    Anthropic/Gemini implementations).
    """

    name = (config.provider or "").strip().lower()
    if name not in SUPPORTED_PROVIDERS:
        raise DesignConfigError(
            f"unsupported XBLOOM_LLM_PROVIDER {config.provider!r}; "
            f"supported: {', '.join(sorted(SUPPORTED_PROVIDERS))}",
            code="unsupported_provider",
            details={"provider": config.provider},
        )
    if name == "openai-compatible":
        return OpenAICompatibleProvider(
            base_url=config.base_url,
            model=config.model,
            api_key=config.api_key,
            client=client,
            transport=transport,
        )
    raise DesignConfigError(
        f"unsupported XBLOOM_LLM_PROVIDER {config.provider!r}",
        code="unsupported_provider",
    )
