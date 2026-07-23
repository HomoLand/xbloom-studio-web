"""Shared browser-facing public contract helpers (Phase B9b).

Centralizes:
- Safe FastAPI 422 responses that never echo rejected request input
- Absolute local path detection and redaction
- Browser-unsafe request payload rejection
- Recursive public-output sanitization for device/catalog/history responses

MCP/Skill local recipe-path inputs are intentionally out of scope here; those
remain on the internal local-agent surface (``mcp_server`` + bridge adapters).
"""

from __future__ import annotations

import re
from typing import Any, Mapping

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from xbloom_storage import (
    StorageError,
    reject_forbidden_provenance,
)

__all__ = [
    "SafeValidationRoute",
    "contains_absolute_local_path",
    "redact_paths",
    "reject_browser_unsafe_payload",
    "sanitize_public_output",
]


# Absolute local paths only - never leak into HTTP error bodies or responses.
_WIN_ABS_PATH_RE = re.compile(r"(?i)\b[a-z]:(?:\\+|/+)\S*")
_POSIX_ABS_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_])/(?:home|Users|tmp|var|etc|root|opt|usr|private|"
    r"mnt|srv|data|run|Volumes|workspace|app)/[^\s\"'<>|]+"
)
_FILE_URL_RE = re.compile(r"(?i)\bfile://[^\s\"'<>|]+")

_CAMEL_BOUNDARY_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")
_BROWSER_ONLY_FORBIDDEN_TOKENS = frozenset({"command", "shell"})
# Bridge hardware identifiers that must never reach the browser.
_BROWSER_DROP_KEYS_CASEFOLD = frozenset({"serial_number"})


def redact_paths(message: str) -> str:
    """Replace recognizable absolute local paths in a free-form string."""

    out = _WIN_ABS_PATH_RE.sub("[redacted-path]", message)
    out = _POSIX_ABS_PATH_RE.sub("[redacted-path]", out)
    out = _FILE_URL_RE.sub("[redacted-path]", out)
    return out


def contains_absolute_local_path(value: str) -> bool:
    """True when a string value embeds a Windows, POSIX, or file:// local path."""

    if value.strip().casefold().startswith("file://"):
        return True
    if _WIN_ABS_PATH_RE.search(value):
        return True
    if _POSIX_ABS_PATH_RE.search(value):
        return True
    return False


def _browser_only_forbidden_key(key: str) -> bool:
    """Reject command-bearing fields not covered by core provenance policy."""

    tokens: list[str] = []
    for chunk in re.split(r"[^A-Za-z0-9]+", str(key)):
        tokens.extend(piece.lower() for piece in _CAMEL_BOUNDARY_RE.findall(chunk))
    return any(token in _BROWSER_ONLY_FORBIDDEN_TOKENS for token in tokens)


def _should_drop_public_key(key: str) -> bool:
    """Whole-token drop policy for browser-facing response keys.

    Reuses core provenance key policy (path/secret/raw-image/reasoning) so
    ``pathway`` / ``tokenizer`` / ``candidate_hash`` / ``used_image`` stay.
    Adds bridge serial redaction. Command-like request fields are rejected on
    input, but descriptive response fields such as ``command: scan`` remain
    part of the existing public API.
    """

    key_s = str(key)
    if key_s.casefold() in _BROWSER_DROP_KEYS_CASEFOLD:
        return True
    try:
        # Reuse the public core policy without importing its private matcher.
        # False is also the valid shape for safe metadata such as used_image.
        reject_forbidden_provenance({key_s: False}, path="public")
    except StorageError:
        return True
    return False


def reject_browser_unsafe_payload(value: Any, *, path: str = "$") -> None:
    """Recursively reject forbidden keys and absolute local path string values.

    Raises ``ValueError`` (FastAPI -> 422) so unsafe data never reaches handlers.
    Reuses core ``reject_forbidden_provenance`` for provenance/secret/image policy.
    """

    try:
        reject_forbidden_provenance(value, path=path)
    except StorageError as exc:
        raise ValueError(str(exc)) from exc

    def walk(current: Any, current_path: str) -> None:
        if isinstance(current, Mapping):
            for key, child in current.items():
                key_s = str(key)
                child_path = f"{current_path}.{key_s}"
                if _browser_only_forbidden_key(key_s):
                    raise ValueError(f"forbidden field {key_s!r} at {child_path}")
                walk(child, child_path)
            return
        if isinstance(current, (list, tuple)):
            for index, child in enumerate(current):
                walk(child, f"{current_path}[{index}]")
            return
        if isinstance(current, str) and contains_absolute_local_path(current):
            raise ValueError(
                f"absolute local path values are not allowed at {current_path}"
            )

    walk(value, path)


def sanitize_public_output(value: Any) -> Any:
    """Recursively drop unsafe keys and redact absolute paths in string leaves.

    Safe fields such as ids, hashes, used_image, pathway, and tokenizer are
    preserved. Nested dict/list/tuple structures are sanitized in place of a
    deep copy of structure (new containers; leaves reused when unchanged).
    """

    if isinstance(value, dict):
        return {
            k: sanitize_public_output(v)
            for k, v in value.items()
            if not _should_drop_public_key(str(k))
        }
    if isinstance(value, list):
        return [sanitize_public_output(v) for v in value]
    if isinstance(value, tuple):
        return tuple(sanitize_public_output(v) for v in value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "[redacted-binary]"
    if isinstance(value, str):
        return redact_paths(value)
    return value


class SafeValidationRoute(APIRoute):
    """Return validation details without echoing the rejected request input."""

    def get_route_handler(self):
        original_handler = super().get_route_handler()

        async def safe_handler(request: Request):
            try:
                return await original_handler(request)
            except RequestValidationError as exc:
                errors = [
                    {
                        "type": str(error.get("type") or "validation_error"),
                        "loc": [str(part) for part in error.get("loc", ())],
                        "message": redact_paths(
                            str(error.get("msg") or "invalid request")
                        ),
                    }
                    for error in exc.errors()
                ]
                return JSONResponse(
                    status_code=422,
                    content={
                        "detail": {
                            "category": "validation",
                            "message": "request validation failed",
                            "errors": errors,
                        }
                    },
                )

        return safe_handler
