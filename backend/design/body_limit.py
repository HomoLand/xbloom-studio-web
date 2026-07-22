"""Pure-ASGI request-body size limit for ``POST /api/design``.

Rejects oversized bodies **before** JSON/multipart parsing so an attacker cannot
force unbounded memory/disk use. Counts streamed chunks and also rejects
oversize ``Content-Length`` headers. Returns the design service structured 413.

After sending 413, return immediately — do **not** drain the receive stream.
Draining can hang clients that use Expect/response-before-upload (or otherwise
stall body transmission after a Content-Length rejection).
"""

from __future__ import annotations

import json
from typing import Callable

from design.config import DEFAULT_MAX_IMAGE_BYTES, load_design_config, max_design_request_body_bytes

DESIGN_PATH = "/api/design"

# Tight overhead for text (8k) + beverage (32) + multipart framing/headers.
_DEFAULT_MAX_BODY = max_design_request_body_bytes(DEFAULT_MAX_IMAGE_BYTES)


def _resolve_max_body_bytes() -> int:
    """Best-effort max body from env config; fall back to defaults on error."""

    try:
        cfg = load_design_config()
        return max_design_request_body_bytes(cfg.max_image_bytes)
    except Exception:
        return _DEFAULT_MAX_BODY


def _413_body(max_bytes: int, got_bytes: int | None = None) -> bytes:
    details: dict[str, object] = {"max_bytes": max_bytes}
    if got_bytes is not None:
        details["got_bytes"] = got_bytes
    payload = {
        "error": {
            "code": "image_too_large",
            "message": f"request body exceeds max size of {max_bytes} bytes",
            "details": details,
        }
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


class DesignRequestBodyLimitMiddleware:
    """Pure ASGI middleware: bound ``POST /api/design`` body size pre-parse."""

    def __init__(
        self,
        app: Callable,
        *,
        max_body_bytes: int | None = None,
        get_max_body_bytes: Callable[[], int] | None = None,
    ) -> None:
        self.app = app
        self._fixed_max = max_body_bytes
        self._get_max = get_max_body_bytes or _resolve_max_body_bytes

    def _max_bytes(self) -> int:
        if self._fixed_max is not None:
            return self._fixed_max
        return int(self._get_max())

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        if scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        path = scope.get("path") or ""
        # Match exact design route only (no prefix bleed).
        if path != DESIGN_PATH:
            await self.app(scope, receive, send)
            return

        max_bytes = self._max_bytes()
        content_length = _content_length(scope)
        if content_length is not None and content_length > max_bytes:
            # Reject immediately; never await receive (Expect / stall-safe).
            await _send_413(send, max_bytes, content_length)
            return

        received = 0
        chunks: list[bytes] = []
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] != "http.request":
                # Unexpected (disconnect); forward empty body and continue.
                async def _empty_receive() -> dict:
                    return {"type": "http.request", "body": b"", "more_body": False}

                await self.app(scope, _empty_receive, send)
                return
            chunk = message.get("body", b"") or b""
            received += len(chunk)
            if received > max_bytes:
                # Already over budget from this chunk; do not drain remaining body.
                await _send_413(send, max_bytes, received)
                return
            if chunk:
                chunks.append(chunk)
            more_body = bool(message.get("more_body", False))

        body = b"".join(chunks)
        sent = False

        async def replay_receive() -> dict:
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)


def _content_length(scope: dict) -> int | None:
    for key, value in scope.get("headers") or []:
        if key.lower() == b"content-length":
            try:
                return int(value.decode("latin-1").strip())
            except (ValueError, UnicodeDecodeError):
                return None
    return None


async def _send_413(send: Callable, max_bytes: int, got_bytes: int | None) -> None:
    payload = _413_body(max_bytes, got_bytes)
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
