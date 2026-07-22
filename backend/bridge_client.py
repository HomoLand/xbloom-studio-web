"""Typed Web adapter around core TypedBridgeClient (Phase A9).

Hardware actions go through explicit methods on a long-lived
``TypedBridgeClient(client_name=\"xbloom-studio-web\")``. There is no public
``call(method, params)`` pass-through.

Observation (``status`` / ``events``) and ``disconnect`` only address an
existing daemon and never start one or connect BLE. Hardware methods let the
typed client ensure the daemon process on first use (still without BLE until
the bridge needs it). Passive scan stays outside this module.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from xbloom_ble.bridge import BridgeError, bridge_is_running, bridge_record_path
from xbloom_ble.bridge_client import TypedBridgeClient

__all__ = [
    "BridgeError",
    "client",
    "is_running",
    "record_path",
    "public_response",
    "status",
    "events",
    "probe",
    "connect",
    "disconnect",
    "coffee_load",
    "coffee_start",
    "tea_load",
    "tea_start",
    "pause",
    "resume",
    "stop",
    "cancel",
    "recovery_reconcile",
    "water_start",
]

# Never surface these keys in HTTP/MCP responses (nested values included).
_REDACT_KEYS = frozenset({"serial_number", "token", "auth_token", "password", "secret"})


def public_response(value: Any) -> Any:
    """Recursively drop secret-bearing keys from bridge payloads."""

    if isinstance(value, dict):
        return {
            k: public_response(v)
            for k, v in value.items()
            if str(k).casefold() not in _REDACT_KEYS
        }
    if isinstance(value, list):
        return [public_response(v) for v in value]
    if isinstance(value, tuple):
        return tuple(public_response(v) for v in value)
    return value

# Module-level long-lived client. Construction does not start the daemon or BLE.
client = TypedBridgeClient(client_name="xbloom-studio-web")


def is_running() -> bool:
    return bridge_is_running(record_path=record_path())


def record_path() -> Path:
    return bridge_record_path()


def status() -> dict[str, Any]:
    """Read bridge status without ensuring the daemon or touching BLE.

    When no daemon is reachable, returns a useful offline snapshot instead of
    raising, so HTTP/MCP observers can render availability without side effects.
    """

    if not is_running():
        return {
            "running": False,
            "available": False,
            "connected": False,
            "hint": (
                "bridge is not running; the backend tries to start one on "
                "startup. Restart the backend, check backend logs, or run: "
                "xbloom-bridge start (or: python -m xbloom_ble.bridge start)"
            ),
        }
    try:
        result = client.status(require_hello=False)
    except BridgeError as exc:
        # Preserve category when surfaceable; still give offline-shaped state.
        out: dict[str, Any] = {
            "running": False,
            "available": False,
            "connected": False,
            "error": str(exc),
            "hint": (
                "bridge record exists but the daemon is not responding; "
                "inspect bridge.log or restart with xbloom-bridge start"
            ),
        }
        category = getattr(exc, "category", None)
        if category:
            out["category"] = str(category)
        return out
    return {"running": True, "available": True, **result}


def events(*, since: int = 0, workflow_id: str) -> dict[str, Any]:
    """Poll events for an explicit workflow. Never ensures daemon or BLE."""

    wid = (workflow_id or "").strip()
    if not wid:
        raise BridgeError(
            "events requires an explicit workflow_id",
            category="invalid_request",
        )
    if not is_running():
        return {"running": False, "events": [], "next_since": int(since)}
    return client.events(since=int(since), workflow_id=wid)


def probe(
    *,
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    """One-shot redacted machine probe via bridge (never direct Bleak)."""

    return public_response(
        client.probe(address=address, scan_timeout=float(scan_timeout))
    )


def connect(
    *,
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    """Debug connect: holds BLE until explicit disconnect."""

    return client.connect(address=address, scan_timeout=float(scan_timeout))


def disconnect() -> dict[str, Any]:
    """Release an explicit debug link. Never starts a missing daemon."""

    return client.disconnect()


def coffee_load(
    *,
    recipe: str,
    request_id: str | None = None,
    address: str | None = None,
    scan_timeout: float = 8.0,
    recipe_revision_id: str | None = None,
) -> dict[str, Any]:
    return client.coffee_load(
        recipe=recipe,
        request_id=request_id,
        address=address,
        scan_timeout=float(scan_timeout),
        recipe_revision_id=recipe_revision_id,
    )


def coffee_start(
    *,
    workflow_id: str,
    confirmation: str,
    request_id: str | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    return client.coffee_start(
        workflow_id=workflow_id,
        confirmation=confirmation,
        request_id=request_id,
        timeout=timeout,
    )


def tea_load(
    *,
    recipe: str,
    request_id: str | None = None,
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    return client.tea_load(
        recipe=recipe,
        request_id=request_id,
        address=address,
        scan_timeout=float(scan_timeout),
    )


def tea_start(
    *,
    workflow_id: str,
    confirmation: str,
    request_id: str | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    return client.tea_start(
        workflow_id=workflow_id,
        confirmation=confirmation,
        request_id=request_id,
        timeout=timeout,
    )


def pause(
    *,
    workflow_id: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    return client.pause(workflow_id=workflow_id, request_id=request_id)


def resume(
    *,
    workflow_id: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    return client.resume(workflow_id=workflow_id, request_id=request_id)


def stop(
    *,
    workflow_id: str | None = None,
    request_id: str | None = None,
    emergency: bool = False,
) -> dict[str, Any]:
    return client.stop(
        workflow_id=workflow_id,
        request_id=request_id,
        emergency=bool(emergency),
    )


def cancel(
    *,
    workflow_id: str | None = None,
    request_id: str | None = None,
    emergency: bool = False,
) -> dict[str, Any]:
    return client.cancel(
        workflow_id=workflow_id,
        request_id=request_id,
        emergency=bool(emergency),
    )


def recovery_reconcile(
    *,
    workflow_id: str,
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    return client.recovery_reconcile(
        workflow_id=workflow_id,
        address=address,
        scan_timeout=float(scan_timeout),
    )


def water_start(
    *,
    volume_ml: float,
    temp_c: int,
    confirmation: str,
    flow_ml_s: float = 3.5,
    pattern: str = "center",
    water_source: str = "auto",
    request_id: str | None = None,
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    return client.water_start(
        volume_ml=volume_ml,
        temp_c=temp_c,
        confirmation=confirmation,
        flow_ml_s=flow_ml_s,
        pattern=pattern,
        water_source=water_source,
        request_id=request_id,
        address=address,
        scan_timeout=float(scan_timeout),
    )
