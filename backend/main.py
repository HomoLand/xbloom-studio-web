"""xBloom Studio Web backend.

A local FastAPI service that exposes the existing Skill capabilities
(scan, probe, recipe validation, catalog, history, bridge status) over HTTP
for the browser frontend. BLE ownership stays with the existing bridge daemon;
this backend never holds a BLE connection of its own.

Run from the backend directory:

    uvicorn main:app --reload --host 127.0.0.1 --port 8000

Prerequisites:

    pip install -e "<path-to-xbloom-studio-brew>/skills/xbloom-studio-brew/scripts"
    pip install -r requirements.txt
    set XBLOOM_ASSETS_DIR to the Skill's assets directory for templates
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from routes import catalog, device, history, recipes
from xbloom_ble.bridge import BridgeCore, BridgeServer, bridge_is_running


app = FastAPI(
    title="xBloom Studio Web",
    description="Local web control surface for the xBloom Studio Skill.",
    version="0.1.0",
)

_bridge_server: BridgeServer | None = None
_bridge_task: asyncio.Task | None = None


@app.on_event("startup")
async def _start_embedded_bridge() -> None:
    """Start an embedded bridge daemon if no external one is running."""

    global _bridge_server, _bridge_task
    if bridge_is_running():
        return
    try:
        core = BridgeCore()
        _bridge_server = BridgeServer(core=core)
        _bridge_task = asyncio.create_task(_bridge_server.run())
    except Exception:
        _bridge_server = None
        _bridge_task = None


@app.on_event("shutdown")
async def _stop_embedded_bridge() -> None:
    global _bridge_server, _bridge_task
    if _bridge_server is not None:
        _bridge_server.shutdown_event.set()
    if _bridge_task is not None:
        try:
            await asyncio.wait_for(_bridge_task, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            _bridge_task.cancel()
    _bridge_server = None
    _bridge_task = None


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
