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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import catalog, device, history, recipes


app = FastAPI(
    title="xBloom Studio Web",
    description="Local web control surface for the xBloom Studio Skill.",
    version="0.1.0",
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
