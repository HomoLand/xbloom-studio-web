"""Typed auth HTTP routes (Phase C1). Never touch BLE/bridge."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from public_contract import SafeValidationRoute
from web_security.config import WebSecurityConfig, is_local_bootstrap_peer
from web_security.errors import (
    SecurityError,
    auth_required,
    forbidden,
    pairing_invalid,
    pairing_rate_limited,
)
from web_security.middleware import peer_host
from web_security.store import AuthStore, AuthenticatedSession, SessionSecrets

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/auth",
    tags=["auth"],
    route_class=SafeValidationRoute,
)


class PairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(..., min_length=16, max_length=256)
    client_label: str | None = Field(default=None, max_length=128)


class PairingNewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_label: str | None = Field(default=None, max_length=128)


def _cfg(request: Request) -> WebSecurityConfig:
    cfg = getattr(request.app.state, "web_security_config", None)
    if cfg is None:
        cfg = getattr(request.state, "web_security_config", None)
    if cfg is None:
        raise RuntimeError("web security config not configured on app")
    return cfg  # type: ignore[return-value]


def _store(request: Request) -> AuthStore:
    store = getattr(request.app.state, "auth_store", None)
    if store is None:
        raise RuntimeError("auth store not configured on app")
    return store  # type: ignore[return-value]


def _session(request: Request) -> AuthenticatedSession | None:
    return getattr(request.state, "web_session", None)


def _client_ip(request: Request) -> str:
    ip = getattr(request.state, "web_client_ip", None)
    if isinstance(ip, str) and ip:
        return ip
    host = peer_host(request)
    return host or "unknown"


def _set_session_cookies(
    response: Response,
    cfg: WebSecurityConfig,
    secrets: SessionSecrets,
) -> None:
    response.set_cookie(
        key=cfg.session_cookie_name,
        value=secrets.session_token,
        httponly=True,
        secure=cfg.cookie_secure,
        samesite="strict",
        path="/",
        max_age=cfg.session_ttl_s,
    )
    # CSRF cookie is readable by JS for double-submit (not HttpOnly).
    response.set_cookie(
        key=cfg.csrf_cookie_name,
        value=secrets.csrf_token,
        httponly=False,
        secure=cfg.cookie_secure,
        samesite="strict",
        path="/",
        max_age=cfg.session_ttl_s,
    )


def _clear_session_cookies(response: Response, cfg: WebSecurityConfig) -> None:
    response.delete_cookie(
        key=cfg.session_cookie_name,
        path="/",
        secure=cfg.cookie_secure,
        httponly=True,
        samesite="strict",
    )
    response.delete_cookie(
        key=cfg.csrf_cookie_name,
        path="/",
        secure=cfg.cookie_secure,
        httponly=False,
        samesite="strict",
    )


@router.get("/config")
def auth_config(request: Request) -> dict[str, Any]:
    """Truthful mode/config report (no secrets)."""

    cfg = _cfg(request)
    return {
        "mode": cfg.mode,
        "pairing_required": cfg.is_lan,
        "public_origin": cfg.public_origin,
        "session_ttl_s": cfg.session_ttl_s,
        "pairing_ttl_s": cfg.pairing_ttl_s,
        "csrf_header": "X-CSRF-Token",
        "session_cookie": cfg.session_cookie_name,
        "csrf_cookie": cfg.csrf_cookie_name,
    }


@router.post("/pairing/new")
def pairing_new(
    request: Request,
    body: PairingNewRequest | None = None,
) -> dict[str, Any]:
    """Create a short-lived one-time pairing token.

    Allowed from:
    - direct loopback / TestClient peer (local bootstrap, no session)
    - already authenticated + CSRF LAN session (middleware-enforced)
    """

    cfg = _cfg(request)
    store = _store(request)
    host = peer_host(request)
    session = _session(request)
    payload = body or PairingNewRequest()
    via_proxy = bool(getattr(request.state, "web_via_trusted_proxy", False))

    direct_local = is_local_bootstrap_peer(host) and not via_proxy
    if cfg.is_lan and not direct_local and session is None:
        raise auth_required("pairing creation requires loopback bootstrap or a session")

    record = store.create_pairing(
        ttl_s=cfg.pairing_ttl_s,
        public_origin=cfg.public_origin,
        created_by_session_id=session.session_id if session else None,
        client_label=payload.client_label,
    )
    # Never log the token secret.
    logger.info(
        "pairing created pairing_id=%s expires_at=%s",
        record.pairing_id,
        record.expires_at,
    )
    return {
        "pairing_id": record.pairing_id,
        "token": record.token,
        "expires_at": record.expires_at,
        "pairing_url": record.pairing_url,
    }


@router.post("/pair")
def pair(request: Request, body: PairRequest) -> Response:
    """Exchange a one-time pairing token for a durable session.

    This is the only unauthenticated LAN mutation. Does not touch BLE.
    """

    cfg = _cfg(request)
    store = _store(request)
    client_ip = _client_ip(request)

    if store.check_pairing_rate_limit(
        client_ip,
        max_failures=cfg.pairing_rate_limit_max,
        window_s=cfg.pairing_rate_limit_window_s,
    ):
        raise pairing_rate_limited()

    secrets = store.consume_pairing_and_create_session(
        body.token,
        session_ttl_s=cfg.session_ttl_s,
        client_ip=client_ip,
        client_label=body.client_label,
    )
    if secrets is None:
        # Durable failure accounting; enforcement is the pre-check above so
        # the Nth failure still returns pairing_invalid and N+1 is rate-limited.
        store.record_pairing_failure(
            client_ip,
            max_failures=cfg.pairing_rate_limit_max,
            window_s=cfg.pairing_rate_limit_window_s,
        )
        raise pairing_invalid()

    store.clear_pairing_failures(client_ip)
    logger.info(
        "pairing consumed session_id=%s client_ip=%s",
        secrets.session_id,
        client_ip,
    )

    response = JSONResponse(
        content={
            "session_id": secrets.session_id,
            "expires_at": secrets.expires_at,
            "client_label": secrets.client_label,
        }
    )
    _set_session_cookies(response, cfg, secrets)
    return response


@router.get("/session")
def current_session(request: Request) -> dict[str, Any]:
    cfg = _cfg(request)
    session = _session(request)
    if session is None:
        if cfg.is_loopback:
            return {"authenticated": False, "mode": cfg.mode}
        raise auth_required()
    return {
        "authenticated": True,
        "mode": cfg.mode,
        "session": {
            "session_id": session.session_id,
            "expires_at": session.expires_at,
            "client_label": session.client_label,
            "client_ip": session.client_ip,
            "current": True,
        },
    }


@router.get("/sessions")
def list_sessions(request: Request) -> dict[str, Any]:
    cfg = _cfg(request)
    store = _store(request)
    session = _session(request)
    if cfg.is_lan and session is None:
        raise auth_required()

    current_id = session.session_id if session else None
    rows = store.list_sessions()
    return {
        "sessions": [
            {
                "session_id": r.session_id,
                "created_at": r.created_at,
                "expires_at": r.expires_at,
                "last_seen_at": r.last_seen_at,
                "client_label": r.client_label,
                "client_ip": r.client_ip,
                "current": r.session_id == current_id,
            }
            for r in rows
        ]
    }


@router.post("/sessions/{session_id}/revoke")
def revoke_session(session_id: str, request: Request) -> dict[str, Any]:
    cfg = _cfg(request)
    store = _store(request)
    session = _session(request)
    if cfg.is_lan and session is None:
        raise auth_required()

    ok = store.revoke_session(session_id)
    if not ok:
        raise forbidden("session not found or already revoked")
    return {"revoked": True, "session_id": session_id}


@router.post("/logout")
def logout(request: Request) -> Response:
    cfg = _cfg(request)
    store = _store(request)
    token = request.cookies.get(cfg.session_cookie_name)
    if token:
        store.revoke_session_token(token)
    response = JSONResponse(content={"logged_out": True})
    _clear_session_cookies(response, cfg)
    return response


def install_security_exception_handlers(app: Any) -> None:
    """Map SecurityError to structured JSON (also for route-raised errors)."""

    @app.exception_handler(SecurityError)
    async def _security_error_handler(
        _request: Request, exc: SecurityError
    ) -> JSONResponse:
        return exc.to_response()
