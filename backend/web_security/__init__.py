"""Phase C1 web network/auth security.

Public surface for app wiring. Pairing/session logic never imports bridge/BLE.
"""

from __future__ import annotations

from web_security.config import (
    CORS_ALLOW_HEADERS,
    CORS_ALLOW_METHODS,
    LOOPBACK_DEV_ORIGINS,
    WebSecurityConfig,
    load_web_security_config,
)
from web_security.errors import SecurityError
from web_security.middleware import WebSecurityMiddleware
from web_security.routes import install_security_exception_handlers, router as auth_router
from web_security.store import AuthStore

__all__ = [
    "AuthStore",
    "CORS_ALLOW_HEADERS",
    "CORS_ALLOW_METHODS",
    "LOOPBACK_DEV_ORIGINS",
    "SecurityError",
    "WebSecurityConfig",
    "WebSecurityMiddleware",
    "auth_router",
    "install_security_exception_handlers",
    "load_web_security_config",
]
