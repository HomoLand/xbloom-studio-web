"""Device discovery and typed bridge control routes (Phase A9).

Passive GET /scan is the only path that uses ``xbloom_ble.client`` discovery.
Probe and all hardware mutations go through the typed Web bridge adapter.
There is no generic ``POST /call`` pass-through.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import bridge_client as bc
from xbloom_ble.bridge import BridgeError


router = APIRouter(prefix="/api/device", tags=["device"])


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------

_AVAILABILITY_CATEGORIES = frozenset(
    {
        "daemon_not_running",
        "daemon_not_client_ready",
        "protocol_incompatible",
    }
)
_CONFLICT_CATEGORIES = frozenset(
    {
        "device_busy_external",
        "busy",
        "workflow_mismatch",
        "workflow_conflict",
        "idempotency_conflict",
        "durable_state_unreadable",
    }
)
_VALIDATION_CATEGORIES = frozenset(
    {
        "invalid_request",
        "validation_error",
        "missing_workflow_id",
    }
)


def _http_status_for_bridge_error(exc: BridgeError) -> int:
    category = (getattr(exc, "category", None) or "").strip()
    message = str(exc).casefold()

    if category in _AVAILABILITY_CATEGORIES:
        return 503
    if category in _VALIDATION_CATEGORIES:
        return 400
    if category in _CONFLICT_CATEGORIES:
        return 409

    if any(
        m in message
        for m in (
            "not responding",
            "not running",
            "not client-ready",
            "incompatible",
            "daemon_not",
        )
    ):
        return 503
    if any(
        m in message
        for m in (
            "requires an explicit workflow_id",
            "workflow_id",
            "request_id",
            "invalid",
            "must equal",
            "required",
        )
    ) and "busy" not in message:
        # Missing/invalid caller inputs → 400; leave real conflicts to 409.
        if "workflow" in message and any(
            m in message for m in ("mismatch", "conflict", "not match", "active")
        ):
            return 409
        if "requires" in message or "invalid" in message or "must" in message:
            return 400
    if any(
        m in message
        for m in ("busy", "conflict", "mismatch", "not idle", "loaded-recipe")
    ):
        return 409
    return 409


def _raise_bridge_http(exc: BridgeError) -> None:
    category = getattr(exc, "category", None) or "bridge_error"
    raise HTTPException(
        status_code=_http_status_for_bridge_error(exc),
        detail={"category": str(category), "message": str(exc)},
    ) from exc


async def _to_thread(fn, /, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class LoadBody(BaseModel):
    recipe: str
    request_id: str | None = None
    address: str | None = None
    scan_timeout: float = Field(default=8.0, ge=1.0, le=60.0)
    recipe_revision_id: str | None = None


class StartBody(BaseModel):
    workflow_id: str
    confirmation: str
    request_id: str | None = None


class WorkflowMutationBody(BaseModel):
    workflow_id: str
    request_id: str | None = None


class StopCancelBody(BaseModel):
    workflow_id: str | None = None
    request_id: str | None = None
    emergency: bool = False


class RecoveryBody(BaseModel):
    workflow_id: str
    address: str | None = None
    scan_timeout: float = Field(default=8.0, ge=1.0, le=60.0)


class ConnectBody(BaseModel):
    address: str | None = None
    scan_timeout: float = Field(default=8.0, ge=1.0, le=60.0)


class ProbeBody(BaseModel):
    address: str | None = None
    scan_timeout: float = Field(default=8.0, ge=1.0, le=60.0)


# ---------------------------------------------------------------------------
# Discovery (passive) + probe (typed bridge)
# ---------------------------------------------------------------------------


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
    """One-shot redacted probe via the typed bridge (never direct Bleak)."""

    try:
        result = await _to_thread(
            bc.probe, address=address, scan_timeout=float(timeout)
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)
    cleaned = bc.public_response(result)
    if not isinstance(cleaned, dict):
        cleaned = {"result": cleaned}
    return {"command": "probe", **cleaned}


# ---------------------------------------------------------------------------
# Observation (no ensure / no BLE)
# ---------------------------------------------------------------------------


@router.get("/bridge")
async def bridge_state() -> dict[str, Any]:
    """Report bridge daemon status. Does not start the daemon or connect BLE."""

    return await _to_thread(bc.status)


@router.get("/events")
async def bridge_events_endpoint(
    workflow_id: str = Query(..., min_length=1),
    since: int = Query(0, ge=0),
) -> dict[str, Any]:
    """Poll bridge events for an explicit workflow_id. Observation only."""

    try:
        return await _to_thread(
            bc.events, since=int(since), workflow_id=workflow_id
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


# ---------------------------------------------------------------------------
# Debug connect / disconnect
# ---------------------------------------------------------------------------


@router.post("/connect")
async def bridge_connect(body: ConnectBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.connect,
            address=body.address,
            scan_timeout=float(body.scan_timeout),
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/disconnect")
async def bridge_disconnect() -> dict[str, Any]:
    """Release an explicit debug link. Never starts a missing daemon."""

    try:
        return await _to_thread(bc.disconnect)
    except BridgeError as exc:
        _raise_bridge_http(exc)


# ---------------------------------------------------------------------------
# Coffee / tea
# ---------------------------------------------------------------------------


@router.post("/coffee/load")
async def coffee_load(body: LoadBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.coffee_load,
            recipe=body.recipe,
            request_id=body.request_id,
            address=body.address,
            scan_timeout=float(body.scan_timeout),
            recipe_revision_id=body.recipe_revision_id,
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/coffee/start")
async def coffee_start(body: StartBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.coffee_start,
            workflow_id=body.workflow_id,
            confirmation=body.confirmation,
            request_id=body.request_id,
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/tea/load")
async def tea_load(body: LoadBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.tea_load,
            recipe=body.recipe,
            request_id=body.request_id,
            address=body.address,
            scan_timeout=float(body.scan_timeout),
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/tea/start")
async def tea_start(body: StartBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.tea_start,
            workflow_id=body.workflow_id,
            confirmation=body.confirmation,
            request_id=body.request_id,
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


# ---------------------------------------------------------------------------
# Flow control
# ---------------------------------------------------------------------------


@router.post("/pause")
async def pause(body: WorkflowMutationBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.pause, workflow_id=body.workflow_id, request_id=body.request_id
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/resume")
async def resume(body: WorkflowMutationBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.resume, workflow_id=body.workflow_id, request_id=body.request_id
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/stop")
async def stop(body: StopCancelBody) -> dict[str, Any]:
    if not body.emergency and not (body.workflow_id or "").strip():
        raise HTTPException(
            status_code=400,
            detail={
                "category": "invalid_request",
                "message": (
                    "stop requires workflow_id unless emergency=true "
                    "(do not invent a workflow_id)"
                ),
            },
        )
    try:
        return await _to_thread(
            bc.stop,
            workflow_id=body.workflow_id,
            request_id=body.request_id,
            emergency=bool(body.emergency),
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/cancel")
async def cancel(body: StopCancelBody) -> dict[str, Any]:
    if not body.emergency and not (body.workflow_id or "").strip():
        raise HTTPException(
            status_code=400,
            detail={
                "category": "invalid_request",
                "message": (
                    "cancel requires workflow_id unless emergency=true "
                    "(do not invent a workflow_id)"
                ),
            },
        )
    try:
        return await _to_thread(
            bc.cancel,
            workflow_id=body.workflow_id,
            request_id=body.request_id,
            emergency=bool(body.emergency),
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)


@router.post("/recovery/reconcile")
async def recovery_reconcile(body: RecoveryBody) -> dict[str, Any]:
    try:
        return await _to_thread(
            bc.recovery_reconcile,
            workflow_id=body.workflow_id,
            address=body.address,
            scan_timeout=float(body.scan_timeout),
        )
    except BridgeError as exc:
        _raise_bridge_http(exc)
