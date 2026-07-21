"""Device discovery and bridge status routes."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from bridge_client import is_running as bridge_is_running, status as bridge_status, events as bridge_events


router = APIRouter(prefix="/api/device", tags=["device"])


def _public_machine_info(info: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in info.items() if k != "serial_number"}


async def _resolve_address(address: str | None, timeout: float) -> tuple[str, str]:
    if address:
        return address, "xBloom Studio"
    from xbloom_ble.client import scan

    devices = await scan(timeout=timeout)
    if len(devices) != 1:
        raise HTTPException(
            status_code=409,
            detail=f"expected exactly one nearby xBloom; found {len(devices)}",
        )
    device = devices[0]
    return device.address, getattr(device, "name", None) or "xBloom Studio"


@router.get("/scan")
async def scan_devices(timeout: float = Query(8.0, ge=1.0, le=30.0)) -> dict[str, Any]:
    """Discover nearby xBloom machines without connecting or writing."""

    from xbloom_ble.client import scan

    devices = await scan(timeout=timeout)
    return {
        "command": "scan",
        "count": len(devices),
        "machines": [
            {"name": getattr(d, "name", None) or "xBloom", "address": d.address}
            for d in devices
        ],
    }


@router.get("/probe")
async def probe_machine(
    address: str | None = Query(None),
    timeout: float = Query(8.0, ge=1.0, le=30.0),
) -> dict[str, Any]:
    """Connect, read redacted machine info, then disconnect. Never writes.

    Refuses while a loaded-recipe record exists, matching the CLI guard.
    """

    from xbloom_paths import skill_state_dir

    state_dir = skill_state_dir()
    for name in ("armed-state.json", "tea-loaded-state.json"):
        if (state_dir / name).exists():
            raise HTTPException(
                status_code=409,
                detail=f"a loaded-recipe record ({name}) exists; recover or cancel first",
            )

    from xbloom_ble.client import XBloomClient

    addr, name = await _resolve_address(address, timeout)
    client = XBloomClient(addr)
    try:
        await client.connect()
        await client.open_session()
        await client.request_status()
        info = _public_machine_info(await client.read_machine_info())
    finally:
        try:
            await client.close_session()
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass
    return {"command": "probe", "machine": name, "address": addr, **info}


@router.get("/bridge")
def bridge_state() -> dict[str, Any]:
    """Report bridge daemon status. Does not start or connect the bridge."""

    if not bridge_is_running():
        return {
            "running": False,
            "available": False,
            "hint": "start the bridge with: python scripts/xbloom.py bridge start",
        }
    return {"running": True, "available": True, **bridge_status()}


@router.get("/events")
def bridge_events_endpoint(since: int = Query(0)) -> dict[str, Any]:
    """Poll bridge daemon events since a sequence number."""

    if not bridge_is_running():
        return {"running": False, "events": [], "next_since": since}
    return bridge_events(since)


class CallBody(BaseModel):
    method: str
    params: dict[str, Any] | None = None


@router.post("/call")
def bridge_call_endpoint(body: CallBody) -> dict[str, Any]:
    """Forward a RPC call to the running bridge daemon."""

    if not bridge_is_running():
        raise HTTPException(status_code=409, detail="bridge is not running")
    from bridge_client import call as bridge_call_fn

    return bridge_call_fn(body.method, body.params)
