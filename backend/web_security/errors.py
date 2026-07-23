"""Structured web security errors (no secrets / local paths)."""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


class SecurityError(Exception):
    """Application-boundary security failure with stable category/code."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        category: str,
        status_code: int = 403,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.category = category
        self.status_code = status_code
        self.details = details or {}

    def to_body(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "error": {
                "code": self.code,
                "category": self.category,
                "message": self.message,
            }
        }
        if self.details:
            # Never include secrets; callers must only pass safe metadata.
            body["error"]["details"] = self.details
        return body

    def to_response(self) -> JSONResponse:
        return JSONResponse(status_code=self.status_code, content=self.to_body())


def network_denied(message: str = "request denied by network policy") -> SecurityError:
    return SecurityError(
        message,
        code="network_denied",
        category="network",
        status_code=403,
    )


def origin_denied(message: str = "origin not allowed") -> SecurityError:
    return SecurityError(
        message,
        code="origin_denied",
        category="network",
        status_code=403,
    )


def auth_required(message: str = "authentication required") -> SecurityError:
    return SecurityError(
        message,
        code="auth_required",
        category="authentication",
        status_code=401,
    )


def session_invalid(message: str = "session invalid or expired") -> SecurityError:
    return SecurityError(
        message,
        code="session_invalid",
        category="authentication",
        status_code=401,
    )


def csrf_failed(message: str = "csrf validation failed") -> SecurityError:
    return SecurityError(
        message,
        code="csrf_failed",
        category="csrf",
        status_code=403,
    )


def pairing_invalid(message: str = "pairing token invalid or already used") -> SecurityError:
    return SecurityError(
        message,
        code="pairing_invalid",
        category="authentication",
        status_code=401,
    )


def pairing_rate_limited(message: str = "too many invalid pairing attempts") -> SecurityError:
    return SecurityError(
        message,
        code="pairing_rate_limited",
        category="rate_limit",
        status_code=429,
    )


def forbidden(message: str = "forbidden") -> SecurityError:
    return SecurityError(
        message,
        code="forbidden",
        category="authorization",
        status_code=403,
    )
