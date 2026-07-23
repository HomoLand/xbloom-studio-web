"""xBloom Studio Web backend.

A local FastAPI service that exposes xBloom capabilities (scan, typed bridge
control, recipe validation, catalog, history) over HTTP for the browser
frontend.

Startup ensures the bridge daemon process without connecting BLE. Hardware
actions go through the typed Web adapter (``bridge_client`` -> core
``TypedBridgeClient``); only passive scan uses BLE discovery directly. Probe
is a bridge one-shot. Shutdown never stops the independent daemon.

Network/auth (Phase C1): default mode is loopback-only. LAN mode requires a
trusted HTTPS reverse proxy, exact public origin, pairing, sessions, and CSRF.
See README and ``web_security`` for configuration.

Run from the backend directory:

    python -m serve
    # or:
    uvicorn main:app --reload --host 127.0.0.1 --port 8000

Prerequisites:

    # Release install (pinned GitHub wheel):
    pip install -r requirements.txt
    # Local core development (editable; no release wheel):
    pip install -r requirements-dev.txt
    set XBLOOM_ASSETS_DIR to the knowledge bundle's assets directory for templates
    set XBLOOM_KNOWLEDGE_DIR to a validated knowledge bundle for POST /api/design
    set XBLOOM_LLM_BASE_URL (required) and optional XBLOOM_LLM_* / XBLOOM_DESIGN_* vars
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from design.body_limit import DesignRequestBodyLimitMiddleware
from design.routes import (
    close_design_service,
    initialize_design_at_startup,
    router as design_router,
)
from routes import catalog, device, history, recipes
from web_security import (
    CORS_ALLOW_HEADERS,
    CORS_ALLOW_METHODS,
    AuthStore,
    WebSecurityConfig,
    WebSecurityMiddleware,
    auth_router,
    install_security_exception_handlers,
    load_web_security_config,
)
from xbloom_ble.bridge import ensure_bridge_daemon


logger = logging.getLogger(__name__)


def _log_ensure_result(result: object) -> None:
    """Log ensure_bridge_daemon outcomes without crashing the HTTP backend."""

    if not isinstance(result, dict):
        logger.warning("ensure_bridge_daemon returned unexpected result: %r", result)
        return

    status = result.get("status")
    message = result.get("message") or result.get("reason")
    client_ready = bool(result.get("client_ready"))
    upgrade_pending = bool(result.get("upgrade_pending"))

    if not client_ready or upgrade_pending:
        logger.warning(
            "bridge daemon not client-ready (status=%s, upgrade_pending=%s, "
            "client_ready=%s): %s",
            status,
            upgrade_pending,
            client_ready,
            message or result,
        )
        return

    config_mismatch = (
        result.get("config_match") is False
        or status in ("config_mismatch_idle", "config_mismatch_active")
        or bool(result.get("idle_restart_recommended"))
    )
    if config_mismatch:
        logger.warning(
            "bridge daemon config mismatch (status=%s) but client_ready; usable: %s",
            status,
            message or result,
        )
        return

    logger.info(
        "bridge daemon ready (status=%s, started=%s, already_running=%s)",
        status,
        result.get("started"),
        result.get("already_running"),
    )


async def _ensure_bridge_daemon() -> None:
    """Ensure a standalone bridge daemon is running as an independent process.

    Calls core-owned ``ensure_bridge_daemon()`` (no Skill script path, no
    sibling-checkout walk). That helper starts or reuses the daemon process
    without connecting BLE. The backend never owns the bridge lifecycle: it
    does not stop the bridge on shutdown/reload, so an in-progress brew is
    not killed by a backend restart or crash.
    """

    try:
        result = await asyncio.to_thread(ensure_bridge_daemon)
    except Exception:
        # Don't crash the HTTP backend; the UI will surface bridge unavailability.
        logger.exception(
            "failed to ensure bridge daemon; HTTP backend continues without a ready bridge"
        )
        return
    _log_ensure_result(result)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """App lifespan: ensure bridge on startup; optional design validation; close design on shutdown.

    When any design env is configured (LLM base URL, knowledge dir/dev root,
    provider, or design mode), validate config/provider/knowledge during startup
    so unsupported capabilities fail before the app accepts traffic rather than
    on the first design call. No network LLM request and no BLE connect during
    that validation. With no design env, design remains lazy (control-only
    startup still works).

    Never stops the independent bridge daemon on shutdown/reload so an
    in-progress brew is not killed by a backend restart.
    """

    await _ensure_bridge_daemon()
    # Eager design init only when design env is present; raises on misconfig during startup.
    initialize_design_at_startup()
    try:
        yield
    finally:
        # Close design httpx client only if design was initialized.
        # Does not construct a service merely to shut it down.
        await close_design_service()


def create_app(
    *,
    web_config: WebSecurityConfig | None = None,
    auth_store: AuthStore | None = None,
    lifespan_handler=lifespan,
) -> FastAPI:
    """Application factory (preferred for tests; ``main.app`` remains the default).

    Inject ``web_config`` / ``auth_store`` to avoid cross-test global env leakage.
    """

    config = web_config if web_config is not None else load_web_security_config()
    # Default store re-resolves XBLOOM_STATE_DIR on use (no import-time path pin).
    store = auth_store if auth_store is not None else AuthStore()

    application = FastAPI(
        title="xBloom Studio Web",
        description="Local web control surface for the xBloom Studio Skill.",
        version="0.1.0",
        lifespan=lifespan_handler,
    )

    application.state.web_security_config = config
    application.state.auth_store = store

    install_security_exception_handlers(application)

    # Middleware order: last added runs first on the request. Keep the network
    # boundary outermost so even CORS preflight cannot bypass peer validation.
    application.add_middleware(DesignRequestBodyLimitMiddleware)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=config.cors_allow_credentials,
        allow_methods=list(CORS_ALLOW_METHODS),
        allow_headers=list(CORS_ALLOW_HEADERS),
    )
    application.add_middleware(
        WebSecurityMiddleware,
        config=config,
        store=store,
    )

    @application.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    application.include_router(auth_router)
    application.include_router(device.router)
    application.include_router(recipes.router)
    application.include_router(catalog.router)
    application.include_router(history.router)
    application.include_router(design_router)

    # Serve the built frontend (SPA) from the same process.
    frontend_env = os.environ.get("XBLOOM_FRONTEND_DIR", "").strip()
    frontend_dir = (
        Path(frontend_env).expanduser()
        if frontend_env
        else Path(__file__).resolve().parent.parent / "frontend" / "dist"
    )

    if frontend_dir.is_dir():
        frontend_root = frontend_dir.resolve()

        @application.get("/{path:path}")
        def serve_frontend(path: str) -> FileResponse:
            if path.startswith("api/"):
                raise HTTPException(status_code=404, detail="not found")
            candidate = (frontend_dir / path).resolve()
            if candidate.is_relative_to(frontend_root) and candidate.is_file():
                return FileResponse(candidate)
            index = frontend_dir / "index.html"
            if index.is_file():
                return FileResponse(index)
            raise HTTPException(status_code=404, detail="frontend index.html not found")

    return application


# Default ASGI app for uvicorn ``main:app`` and existing TestClient imports.
app = create_app()
