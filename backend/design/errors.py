"""Structured design-service errors with stable HTTP mapping."""

from __future__ import annotations

from typing import Any


class DesignError(Exception):
    """Base class for design endpoint failures."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details or {}

    def to_body(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "error": {
                "code": self.code,
                "message": self.message,
            }
        }
        if self.details:
            body["error"]["details"] = self.details
        return body


class DesignConfigError(DesignError):
    """Missing or invalid configuration / capability."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "configuration_error",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, code=code, status_code=503, details=details)


class DesignUnavailableError(DesignError):
    """Knowledge bundle or design capability unavailable."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "knowledge_unavailable",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, code=code, status_code=503, details=details)


class DesignValidationError(DesignError):
    """Client input failed validation (MIME, size, JSON shape, etc.)."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "invalid_request",
        details: dict[str, Any] | None = None,
        status_code: int = 400,
    ) -> None:
        super().__init__(message, code=code, status_code=status_code, details=details)


class DesignProviderError(DesignError):
    """Upstream provider failure (timeout, transport, unexpected payload)."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "provider_error",
        details: dict[str, Any] | None = None,
        status_code: int = 502,
    ) -> None:
        super().__init__(message, code=code, status_code=status_code, details=details)


class DesignTimeoutError(DesignError):
    """Design processing exceeded configured timeout."""

    def __init__(
        self,
        message: str = "design processing timed out",
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            message,
            code="timeout",
            status_code=504,
            details=details,
        )
