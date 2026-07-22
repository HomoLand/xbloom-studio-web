"""Typed ``POST /api/design`` HTTP adapter (JSON + multipart)."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.datastructures import UploadFile as StarletteUploadFile

from design.config import DESIGN_BEVERAGE_MAX_CHARS, DESIGN_TEXT_MAX_CHARS
from design.errors import DesignError, DesignValidationError
from design.prompts import ALLOWED_BEVERAGE_HINTS
from design.service import (
    DesignInput,
    DesignService,
    design_env_configured,
    design_service_from_env,
    initialize_design_service_from_env,
    redact_public_string,
    redact_public_value,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["design"])

# Shared service instance for the process; tests override via dependency injection.
_service: DesignService | None = None

_ALLOWED_JSON_FIELDS = frozenset({"text", "beverage"})
_ALLOWED_MULTIPART_FIELDS = frozenset({"text", "beverage", "image"})
_BANNED_PATH_FIELDS = frozenset({"path", "file_path", "image_path", "local_path"})

# OpenAPI-only schema pieces (runtime still uses a single Request-based endpoint).
_BEVERAGE_OPENAPI = {
    "anyOf": [
        {"type": "string", "enum": sorted(ALLOWED_BEVERAGE_HINTS)},
        {"type": "null"},
    ],
    "description": "Optional beverage family hint; only coffee or tea (case-insensitive).",
    "default": None,
}
_JSON_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {
            "type": "string",
            "maxLength": DESIGN_TEXT_MAX_CHARS,
            "description": "User design notes (required, non-empty for JSON).",
        },
        "beverage": _BEVERAGE_OPENAPI,
    },
    "required": ["text"],
}
_MULTIPART_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {
            "type": "string",
            "maxLength": DESIGN_TEXT_MAX_CHARS,
            "description": "User design notes (optional when image is provided).",
        },
        "beverage": _BEVERAGE_OPENAPI,
        "image": {
            "type": "string",
            "format": "binary",
            "description": "Optional bag/recipe image (JPEG/PNG/WebP; size limited by config).",
        },
    },
}


def get_design_service() -> DesignService:
    global _service
    if _service is None:
        _service = design_service_from_env()
    return _service


def get_design_service_if_initialized() -> DesignService | None:
    """Return the process service when already constructed; never constructs."""

    return _service


def set_design_service(service: DesignService | None) -> None:
    """Test helper to inject/replace the process-wide design service."""

    global _service
    _service = service


def initialize_design_at_startup() -> DesignService | None:
    """Eager design init when design env is configured; otherwise leave lazy.

    Validates config, provider name/capability, and knowledge bundle with no
    network call and no BLE. Raises on misconfiguration so lifespan fails before
    yield. Returns the retained service, or None when design remains lazy.
    """

    global _service
    if not design_env_configured():
        return None
    if _service is not None:
        # Tests may inject a service before lifespan; still validate it.
        _service.initialize()
        return _service
    service = initialize_design_service_from_env()
    _service = service
    return service


async def close_design_service() -> None:
    """Close the lazily owned design service if it was initialized.

    Does **not** construct a service merely to shut it down. Safe to call when
    design was never used in this process.
    """

    global _service
    service = _service
    _service = None
    if service is None:
        return
    close = getattr(service, "aclose", None)
    if close is not None:
        await close()


class DesignJsonBody(BaseModel):
    """JSON body for text-only design requests (OpenAPI / contract documentation)."""

    text: str = Field(default="", max_length=DESIGN_TEXT_MAX_CHARS)
    beverage: Literal["coffee", "tea"] | None = Field(
        default=None,
        description="Optional hint: coffee or tea only",
    )


def _api_key_for_redaction() -> str:
    service = _service
    if service is None:
        return ""
    return getattr(service.config, "api_key", "") or ""


def _error_response(exc: DesignError) -> JSONResponse:
    body = redact_public_value(exc.to_body(), api_key=_api_key_for_redaction())
    return JSONResponse(status_code=exc.status_code, content=body)


def _normalize_beverage(raw: object, *, source: str) -> str | None:
    """Accept only null/empty or normalized ``coffee`` / ``tea``."""

    if raw is None:
        return None
    if not isinstance(raw, str):
        raise DesignValidationError(
            f"beverage must be a string ({source})",
            code="invalid_request",
        )
    if raw == "":
        return None
    if len(raw) > DESIGN_BEVERAGE_MAX_CHARS:
        raise DesignValidationError(
            f"beverage exceeds max length {DESIGN_BEVERAGE_MAX_CHARS}",
            code="invalid_request",
        )
    normalized = raw.strip().lower()
    if normalized not in ALLOWED_BEVERAGE_HINTS:
        raise DesignValidationError(
            "beverage must be 'coffee' or 'tea'",
            code="invalid_request",
            details={"allowed": sorted(ALLOWED_BEVERAGE_HINTS)},
        )
    return normalized


@router.post(
    "/design",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": _JSON_REQUEST_SCHEMA,
                },
                "multipart/form-data": {
                    "schema": _MULTIPART_REQUEST_SCHEMA,
                },
            },
        }
    },
)
async def design_recipe(request: Request) -> Any:
    """Generate a recipe candidate from text and optional image.

    Content types:
    - ``application/json``: text-only body (``text``, optional ``beverage``).
    - ``multipart/form-data``: ``text`` field plus optional ``image`` file.

    Other content types are rejected with a structured error.
    """

    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()

    try:
        if content_type == "application/json":
            design_input = await _parse_json_request(request)
        elif content_type == "multipart/form-data":
            design_input = await _parse_multipart_request(request)
        else:
            raise DesignValidationError(
                f"unsupported Content-Type: {content_type or '(missing)'}; "
                "use application/json or multipart/form-data",
                code="unsupported_content_type",
                details={
                    "allowed": ["application/json", "multipart/form-data"],
                    "got": content_type or None,
                },
            )

        service = get_design_service()
        result = await service.design(design_input)
        return result
    except DesignError as exc:
        # Structured domain errors; do not log secrets or absolute paths.
        logger.info(
            "design error code=%s status=%s message=%s",
            exc.code,
            exc.status_code,
            redact_public_string(exc.message, api_key=_api_key_for_redaction()),
        )
        return _error_response(exc)


async def _parse_json_request(request: Request) -> DesignInput:
    try:
        payload = await request.json()
    except Exception as exc:
        raise DesignValidationError(
            "malformed JSON body",
            code="malformed_json",
        ) from exc
    if not isinstance(payload, dict):
        raise DesignValidationError(
            "JSON body must be an object",
            code="malformed_json",
        )
    unknown = set(payload) - _ALLOWED_JSON_FIELDS
    if unknown:
        raise DesignValidationError(
            f"unknown JSON fields: {sorted(unknown)}",
            code="invalid_request",
            details={"unknown": sorted(unknown)},
        )
    if _BANNED_PATH_FIELDS & set(payload):
        raise DesignValidationError(
            "local file paths are not accepted",
            code="invalid_request",
        )
    text = payload.get("text", "")
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise DesignValidationError("text must be a string", code="invalid_request")
    if len(text) > DESIGN_TEXT_MAX_CHARS:
        raise DesignValidationError(
            f"text exceeds max length {DESIGN_TEXT_MAX_CHARS}",
            code="invalid_request",
        )
    beverage = _normalize_beverage(payload.get("beverage"), source="json")
    if not text.strip():
        raise DesignValidationError(
            "text is required for JSON design requests (non-empty)",
            code="invalid_request",
        )
    return DesignInput(text=text, beverage_hint=beverage)


async def _parse_multipart_request(request: Request) -> DesignInput:
    """Parse multipart form: text + optional image.

    Bounds form parts via Starlette (max_files/fields/part_size) and defensively
    reads at most ``max_image_bytes + 1`` from the upload stream. Uses
    ``async with request.form(...)`` so every UploadFile is closed on all
    success and error paths (unknown fields, validation, oversize, read failure).
    """

    service = get_design_service()
    max_image_bytes = service.config.max_image_bytes
    # Part budget: image is the largest allowed part; text/beverage are tiny.
    max_part_size = max(max_image_bytes, DESIGN_TEXT_MAX_CHARS + 64)

    try:
        async with request.form(
            max_files=1,
            max_fields=3,
            max_part_size=max_part_size,
        ) as form:
            return await _parse_multipart_form(form, max_image_bytes=max_image_bytes)
    except DesignError:
        raise
    except Exception as exc:
        # Starlette raises on oversize parts / too many fields; treat as client error.
        message = str(exc).lower()
        if "part" in message and ("large" in message or "exceed" in message or "max" in message):
            raise DesignValidationError(
                f"multipart part exceeds max size of {max_part_size} bytes",
                code="image_too_large",
                status_code=413,
                details={"max_bytes": max_part_size},
            ) from exc
        raise DesignValidationError(
            "malformed multipart body",
            code="malformed_multipart",
        ) from exc


async def _parse_multipart_form(form: Any, *, max_image_bytes: int) -> DesignInput:
    # Reject unknown and duplicate fields.
    for key in form.keys():
        if key in _BANNED_PATH_FIELDS:
            raise DesignValidationError(
                "local file paths are not accepted",
                code="invalid_request",
            )
        if key not in _ALLOWED_MULTIPART_FIELDS:
            raise DesignValidationError(
                f"unknown multipart fields: {[key]}",
                code="invalid_request",
                details={"unknown": [key]},
            )
        values = form.getlist(key)
        if len(values) > 1:
            raise DesignValidationError(
                f"duplicate multipart field: {key}",
                code="invalid_request",
                details={"field": key},
            )

    text_val = form.get("text")
    if text_val is None:
        text = ""
    elif isinstance(text_val, str):
        text = text_val
    else:
        raise DesignValidationError("text form field must be a string", code="invalid_request")
    if len(text) > DESIGN_TEXT_MAX_CHARS:
        raise DesignValidationError(
            f"text exceeds max length {DESIGN_TEXT_MAX_CHARS}",
            code="invalid_request",
        )

    beverage = _normalize_beverage(form.get("beverage"), source="multipart")

    image_bytes: bytes | None = None
    image_content_type: str | None = None
    image_field = form.get("image")
    if image_field is not None and image_field != "":
        if not isinstance(image_field, StarletteUploadFile) and not hasattr(
            image_field, "read"
        ):
            raise DesignValidationError(
                "image form field must be a file upload",
                code="invalid_request",
            )
        upload = image_field
        # Defensive bound: never buffer more than max+1 even if part limit failed.
        try:
            raw = await upload.read(max_image_bytes + 1)
        except Exception as exc:
            raise DesignValidationError(
                "failed to read uploaded image",
                code="invalid_image",
            ) from exc
        data = raw if isinstance(raw, (bytes, bytearray)) else bytes(raw)
        if len(data) > max_image_bytes:
            raise DesignValidationError(
                f"image exceeds max size of {max_image_bytes} bytes",
                code="image_too_large",
                status_code=413,
                details={"max_bytes": max_image_bytes, "got_bytes": len(data)},
            )
        image_bytes = bytes(data)
        image_content_type = getattr(upload, "content_type", None) or None
        # FormData.close() on context exit also closes uploads; best-effort early release.
        close = getattr(upload, "close", None)
        if close is not None:
            try:
                await close()
            except Exception:
                pass

    if not text.strip() and image_bytes is None:
        raise DesignValidationError(
            "text or image is required (non-empty text and/or image file)",
            code="invalid_request",
        )

    return DesignInput(
        text=text,
        image_bytes=image_bytes,
        image_content_type=image_content_type,
        beverage_hint=beverage,
    )


# Keep DesignJsonBody referenced for OpenAPI / contract introspection.
_ = DesignJsonBody
