"""xBloom Studio Web backend.

A local FastAPI service that exposes xBloom capabilities (scan, typed bridge
control, recipe validation, catalog, history) over HTTP for the browser
frontend.

Startup ensures the bridge daemon process without connecting BLE. Hardware
actions go through the typed Web adapter (``bridge_client`` → core
``TypedBridgeClient``); only passive scan uses BLE discovery directly. Probe
is a bridge one-shot. Shutdown never stops the independent daemon.

Run from the backend directory:

    uvicorn main:app --reload --host 127.0.0.1 --port 8000

Prerequisites:

    # Release install (pinned GitHub wheel):
    pip install -r requirements.txt
    # Local core development (editable; no release wheel):
    pip install -r requirements-dev.txt
    set XBLOOM_ASSETS_DIR to the knowledge bundle's assets directory for templates
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

from routes import catalog, device, history, recipes
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
    """App lifespan: ensure bridge once on startup; never stop it on shutdown."""

    await _ensure_bridge_daemon()
    yield
    # Deliberately do nothing on shutdown so the independent daemon is preserved.


app = FastAPI(
    title="xBloom Studio Web",
    description="Local web control surface for the xBloom Studio Skill.",
    version="0.1.0",
    lifespan=lifespan,
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:4173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(device.router)
app.include_router(recipes.router)
app.include_router(catalog.router)
app.include_router(history.router)

# Serve the built frontend (SPA) from the same process.
_frontend_env = os.environ.get("XBLOOM_FRONTEND_DIR", "").strip()
_frontend_dir = (
    Path(_frontend_env).expanduser()
    if _frontend_env
    else Path(__file__).resolve().parent.parent / "frontend" / "dist"
)

if _frontend_dir.is_dir():
    _frontend_root = _frontend_dir.resolve()

    @app.get("/{path:path}")
    def serve_frontend(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="not found")
        candidate = (_frontend_dir / path).resolve()
        if str(candidate).startswith(str(_frontend_root)) and candidate.is_file():
            return FileResponse(candidate)
        index = _frontend_dir / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(status_code=404, detail="frontend index.html not found")
