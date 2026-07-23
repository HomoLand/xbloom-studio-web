"""Network/auth security middleware (Phase C1).

Enforcement boundary:
- loopback mode: deny real non-loopback peers; accept loopback + TestClient synthetic peer
- LAN mode: direct peer must be loopback/testclient (bootstrap) or a trusted proxy;
  trust X-Forwarded-* only from trusted proxies; require https + exact public host
- Origin must match allowed list when present
- LAN protected /api routes require a valid session cookie
- State-changing authenticated requests require session-bound CSRF
"""

from __future__ import annotations

import ipaddress
import logging
import secrets
from typing import Callable
from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from web_security.config import (
    WebSecurityConfig,
    ip_in_networks,
    is_local_bootstrap_peer,
    is_testclient_peer,
)
from web_security.errors import (
    SecurityError,
    auth_required,
    csrf_failed,
    network_denied,
    origin_denied,
    session_invalid,
)
from web_security.store import AuthStore, AuthenticatedSession

logger = logging.getLogger(__name__)

# Always public under /api (LAN). Pair exchange is the only unauthenticated
# LAN mutation that creates a session.
_PUBLIC_API_EXACT = frozenset(
    {
        "/api/health",
        "/api/auth/config",
        "/api/auth/pair",
        "/api/auth/logout",
    }
)

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _header(request: Request, name: str) -> str | None:
    value = request.headers.get(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped else None


def peer_host(request: Request) -> str | None:
    if request.client is None:
        return None
    return request.client.host


def parse_x_forwarded_for(value: str | None) -> list[str]:
    if not value:
        return []
    hops: list[str] = []
    for part in value.split(","):
        hop = part.strip()
        if not hop:
            continue
        # Drop optional port on IPv4 host:port (not for IPv6).
        if hop.count(":") == 1 and not hop.startswith("["):
            host_part, maybe_port = hop.rsplit(":", 1)
            if maybe_port.isdigit():
                hop = host_part
        hops.append(hop)
    return hops


def rightmost_forwarded_client(xff: str | None) -> str | None:
    """Derive client IP from the rightmost valid X-Forwarded-For hop."""

    hops = parse_x_forwarded_for(xff)
    if not hops:
        return None
    for hop in reversed(hops):
        try:
            ipaddress.ip_address(hop)
            return hop
        except ValueError:
            continue
    return None


def public_host_from_origin(origin: str) -> str:
    parsed = urlparse(origin)
    return (parsed.netloc or "").lower()


class WebSecurityMiddleware(BaseHTTPMiddleware):
    """Application-boundary network and session enforcement."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        config: WebSecurityConfig,
        store: AuthStore,
    ) -> None:
        super().__init__(app)
        self.config = config
        self.store = store

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        try:
            self._enforce(request)
        except SecurityError as exc:
            response = exc.to_response()
        else:
            response = await call_next(request)
        self._apply_response_headers(request, response)
        return response

    def _apply_response_headers(self, request: Request, response: Response) -> None:
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/api/auth"):
            response.headers["Cache-Control"] = "no-store"
        if self.config.is_lan:
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000",
            )

    def _enforce(self, request: Request) -> None:
        cfg = self.config
        host = peer_host(request)
        method = (request.method or "GET").upper()
        path = request.url.path or ""

        request.state.web_peer_host = host
        request.state.web_client_ip = host
        request.state.web_via_trusted_proxy = False
        request.state.web_session = None
        request.state.web_security_config = cfg

        if method == "OPTIONS":
            self._check_peer_network(request, host)
            return

        self._check_peer_network(request, host)

        origin = _header(request, "origin")
        if origin is not None and not cfg.allowed_origin(origin, peer_host=host):
            raise origin_denied()

        # Loopback mode: no session gate; normal API usable without pairing.
        if cfg.is_loopback:
            self._maybe_bind_session(request)
            return

        # --- LAN mode ---
        if self._is_public_api(request, path, method, host):
            # Optional session bind (e.g. logout with a still-valid cookie).
            self._maybe_bind_session(request)
            session = getattr(request.state, "web_session", None)
            if (
                session is not None
                and method in _MUTATING_METHODS
                and not self._csrf_exempt(request, path, method, host)
            ):
                self._require_csrf(request, session)
            return

        session = self._require_session(request)
        request.state.web_session = session

        if method in _MUTATING_METHODS and not self._csrf_exempt(
            request, path, method, host
        ):
            self._require_csrf(request, session)

    def _is_public_api(
        self,
        request: Request,
        path: str,
        method: str,
        host: str | None,
    ) -> bool:
        if not path.startswith("/api"):
            return True  # static / non-API: no session gate
        if path in _PUBLIC_API_EXACT:
            return True
        # Local bootstrap pairing creation (direct loopback / TestClient only).
        if (
            path == "/api/auth/pairing/new"
            and method == "POST"
            and is_local_bootstrap_peer(host)
            and not bool(getattr(request.state, "web_via_trusted_proxy", False))
        ):
            return True
        return False

    def _check_peer_network(self, request: Request, host: str | None) -> None:
        cfg = self.config

        if cfg.is_loopback:
            if is_local_bootstrap_peer(host):
                request.state.web_client_ip = host or "loopback"
                return
            raise network_denied("non-loopback client rejected in loopback mode")

        # LAN: bootstrap from direct loopback/testclient OR trusted proxy peer.
        # When loopback is also listed as a trusted proxy (common for local
        # reverse proxies), only apply forwarding rules if the proxy actually
        # sent X-Forwarded-* headers; pure local bootstrap has none.
        if is_local_bootstrap_peer(host):
            if (
                host
                and not is_testclient_peer(host)
                and ip_in_networks(host, cfg.trusted_proxies)
                and self._has_forwarded_headers(request)
            ):
                self._apply_trusted_forwarding(request, host)
            else:
                request.state.web_client_ip = host or "loopback"
            return

        if host and ip_in_networks(host, cfg.trusted_proxies):
            self._apply_trusted_forwarding(request, host)
            return

        raise network_denied("direct peer is not a trusted proxy")

    def _has_forwarded_headers(self, request: Request) -> bool:
        return any(
            _header(request, name) is not None
            for name in (
                "x-forwarded-for",
                "x-forwarded-proto",
                "x-forwarded-host",
                "forwarded",
            )
        )

    def _apply_trusted_forwarding(self, request: Request, peer: str) -> None:
        cfg = self.config
        assert cfg.public_origin is not None

        # Only trust X-Forwarded-* from this peer.
        proto = (_header(request, "x-forwarded-proto") or "").lower()
        if proto != "https":
            raise network_denied("trusted proxy must forward proto https")

        xf_host = _header(request, "x-forwarded-host")
        expected_host = public_host_from_origin(cfg.public_origin)
        if not xf_host or xf_host.lower() != expected_host:
            raise network_denied("forwarded host does not match public origin")

        origin = _header(request, "origin")
        if origin is not None and origin != cfg.public_origin:
            raise origin_denied()

        client_ip = rightmost_forwarded_client(_header(request, "x-forwarded-for"))
        if client_ip is None:
            raise network_denied("missing or invalid X-Forwarded-For from trusted proxy")

        request.state.web_via_trusted_proxy = True
        request.state.web_client_ip = client_ip
        request.state.web_peer_host = peer

    def _csrf_exempt(
        self,
        request: Request,
        path: str,
        method: str,
        host: str | None,
    ) -> bool:
        if path == "/api/auth/pair" and method == "POST":
            return True
        if path == "/api/auth/pairing/new" and method == "POST":
            if is_local_bootstrap_peer(host) and not bool(
                getattr(request.state, "web_via_trusted_proxy", False)
            ):
                return True
        return False

    def _maybe_bind_session(self, request: Request) -> None:
        token = request.cookies.get(self.config.session_cookie_name)
        if not token:
            return
        session = self.store.authenticate_session(token)
        if session is not None:
            request.state.web_session = session

    def _require_session(self, request: Request) -> AuthenticatedSession:
        token = request.cookies.get(self.config.session_cookie_name)
        if not token:
            raise auth_required()
        session = self.store.authenticate_session(token)
        if session is None:
            raise session_invalid()
        return session

    def _require_csrf(self, request: Request, session: AuthenticatedSession) -> None:
        cfg = self.config
        header_token = _header(request, cfg.csrf_header_name)
        cookie_token = request.cookies.get(cfg.csrf_cookie_name)
        if not header_token or not cookie_token:
            raise csrf_failed()
        if not secrets.compare_digest(header_token, cookie_token):
            raise csrf_failed()
        if not self.store.verify_csrf(session, header_token):
            raise csrf_failed()
