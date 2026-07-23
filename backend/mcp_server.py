"""xBloom Studio MCP server.

Exposes xBloom Studio capabilities (scan, typed bridge control, catalog,
recipes, history) as MCP tools for AI agents. Uses stdio transport — the agent
spawns this process and communicates via JSON-RPC over stdin/stdout.

Hardware tools use the typed Web adapter (``bridge_client`` → core
``TypedBridgeClient``). There is no raw ``bridge_call`` pass-through and no
manual ``ensure_bridge_daemon`` in this module. Observation tools (status /
events) never ensure the daemon or touch BLE. Only passive scan uses BLE
discovery directly; probe is a bridge one-shot.

Run:
    python mcp_server.py

Prerequisites:
    # From the backend directory:
    pip install -r requirements-dev.txt   # local editable core
    # or: pip install -r requirements.txt  # release wheel
    set XBLOOM_ASSETS_DIR to the knowledge bundle's assets directory for templates
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

import bridge_client as bc
from xbloom_ble.bridge import BridgeError
from xbloom_catalog import (
    CatalogError,
    default_catalog_path,
    get_entry,
    list_entries,
    load_catalog,
)
from xbloom_history import history_summary, list_events
from xbloom_paths import skill_state_dir


mcp = FastMCP("xbloom-studio")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _bridge_error_payload(exc: BaseException) -> dict[str, Any]:
    """Structured error dict retaining BridgeError.category when present."""

    # Keep category/message useful; only strip secret-bearing keys if nested.
    payload: dict[str, Any] = {"error": str(exc)}
    category = getattr(exc, "category", None)
    if category:
        payload["category"] = str(category)
    return bc.public_response(payload)


def _catalog_load() -> tuple[dict[str, Any], Path]:
    path = default_catalog_path(skill_state_dir())
    return load_catalog(path), path


def _assets_dir() -> Path | None:
    configured = os.environ.get("XBLOOM_ASSETS_DIR", "").strip()
    if configured:
        p = Path(configured).expanduser()
        return p if p.is_dir() else None
    return None


# ---------------------------------------------------------------------------
# Discovery & observation (status/events never ensure)
# ---------------------------------------------------------------------------


@mcp.tool()
async def xbloom_scan(timeout: float = 8.0) -> dict[str, Any]:
    """Scan for nearby xBloom Studio machines without connecting.

    Returns a list of discovered machines with their BLE addresses. Does not
    require the bridge daemon — this is a passive BLE scan.
    """
    from xbloom_ble.client import scan

    devices = await scan(timeout=timeout)
    return {
        "count": len(devices),
        "machines": [
            {"name": getattr(d, "name", None) or "xBloom", "address": d.address}
            for d in devices
        ],
    }


@mcp.tool()
def xbloom_probe(
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    """One-shot redacted machine probe via the bridge daemon (never direct Bleak).

    Connects through the typed bridge, reads public machine info, and releases.
    Does not hold an explicit debug connection.
    """
    try:
        result = bc.probe(address=address, scan_timeout=float(scan_timeout))
        cleaned = bc.public_response(result)
        if not isinstance(cleaned, dict):
            cleaned = {"result": cleaned}
        return {"command": "probe", **cleaned}
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_status() -> dict[str, Any]:
    """Get the BLE bridge daemon status: connection, activity, phase, telemetry.

    Observation only: does not start the daemon or connect BLE. Returns
    running=False with a hint when the bridge is not available. Includes
    active_workflow_id when a durable workflow is present.
    """
    try:
        return bc.status()
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_events(workflow_id: str, since: int = 0) -> dict[str, Any]:
    """Poll bridge daemon events for an explicit workflow_id.

    Observation only: does not ensure the daemon or connect BLE. Returns events
    with seq numbers greater than 'since'. Use next_since from the previous
    response as the next 'since' value for incremental polling.
    """
    wid = (workflow_id or "").strip()
    if not wid:
        return {
            "error": "events requires an explicit workflow_id",
            "category": "invalid_request",
        }
    try:
        return bc.events(since=int(since), workflow_id=wid)
    except BridgeError as exc:
        return _bridge_error_payload(exc)


# ---------------------------------------------------------------------------
# Connection management (debug hold)
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_connect(address: str | None = None) -> dict[str, Any]:
    """Connect the bridge to an xBloom machine (explicit debug hold).

    If address is omitted, the daemon scans for exactly one nearby machine.
    Holds the BLE session until xbloom_disconnect. Prefer workflow load/start
    for normal brewing — those ensure connection as part of the workflow.
    """
    try:
        return bc.connect(address=address)
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_disconnect() -> dict[str, Any]:
    """Disconnect an explicit debug BLE link on a running daemon.

    Never starts a missing daemon. Refuses if an activity is loaded or running
    — stop or cancel it first.
    """
    try:
        return bc.disconnect()
    except BridgeError as exc:
        return _bridge_error_payload(exc)


# ---------------------------------------------------------------------------
# Coffee
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_coffee_load(
    recipe_path: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Load a coffee recipe into the machine (arms it).

    The recipe_path must be a local YAML file. The bridge validates it
    strictly, connects if needed, and sends the load command. Returns a durable
    workflow_id that must be passed to start/pause/resume/stop/cancel/events.
    Loaded recipes wait for start or explicit cancel; there is no time-driven
    expiry.
    """
    try:
        resolved = str(Path(recipe_path).expanduser().resolve(strict=True))
        return bc.coffee_load(recipe=resolved, request_id=request_id)
    except (BridgeError, OSError) as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_coffee_start(
    workflow_id: str,
    confirmation: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Start brewing the loaded coffee recipe for the given workflow_id.

    Requires the confirmation phrase 'cup-filter-water-beans' — this is the
    safety gate confirming the cup is in place, the filter is ready, water is
    loaded, and beans are ground. The bridge also requires the
    XBLOOM_ENABLE_REMOTE_START env var to be set on the daemon.

    Pass the exact workflow_id returned by xbloom_coffee_load (or status).
    Do not invent or guess a workflow_id. Supply one request_id per attempt;
    never auto-retry uncertain mutations.
    """
    wid = (workflow_id or "").strip()
    if not wid:
        return {
            "error": "coffee.start requires an explicit workflow_id",
            "category": "invalid_request",
        }
    try:
        return bc.coffee_start(
            workflow_id=wid,
            confirmation=confirmation,
            request_id=request_id,
        )
    except BridgeError as exc:
        return _bridge_error_payload(exc)


# ---------------------------------------------------------------------------
# Tea
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_tea_load(
    recipe_path: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Load a tea recipe into the machine.

    The recipe_path must be a local YAML file (tea recipe format). Returns a
    durable workflow_id for subsequent start/control/events. Loaded recipes
    wait for start or explicit cancel; there is no time-driven expiry.
    """
    try:
        resolved = str(Path(recipe_path).expanduser().resolve(strict=True))
        return bc.tea_load(recipe=resolved, request_id=request_id)
    except (BridgeError, OSError) as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_tea_start(
    workflow_id: str,
    confirmation: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Start brewing the loaded tea recipe for the given workflow_id.

    Requires the confirmation phrase 'tea-brewer-water-cup-clear'. Pass the
    exact workflow_id from load/status; do not invent one.
    """
    wid = (workflow_id or "").strip()
    if not wid:
        return {
            "error": "tea.start requires an explicit workflow_id",
            "category": "invalid_request",
        }
    try:
        return bc.tea_start(
            workflow_id=wid,
            confirmation=confirmation,
            request_id=request_id,
        )
    except BridgeError as exc:
        return _bridge_error_payload(exc)


# ---------------------------------------------------------------------------
# Flow control
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_pause(
    workflow_id: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Pause the running coffee, grinder, or water activity for workflow_id."""
    wid = (workflow_id or "").strip()
    if not wid:
        return {
            "error": "pause requires an explicit workflow_id",
            "category": "invalid_request",
        }
    try:
        return bc.pause(workflow_id=wid, request_id=request_id)
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_resume(
    workflow_id: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Resume a paused coffee, grinder, or water activity for workflow_id."""
    wid = (workflow_id or "").strip()
    if not wid:
        return {
            "error": "resume requires an explicit workflow_id",
            "category": "invalid_request",
        }
    try:
        return bc.resume(workflow_id=wid, request_id=request_id)
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_stop(
    workflow_id: str | None = None,
    request_id: str | None = None,
    emergency: bool = False,
) -> dict[str, Any]:
    """Stop the current activity for workflow_id.

    Normal stop requires an explicit workflow_id. Only when emergency=true may
    workflow_id be omitted (explicit emergency path). Do not invent a
    workflow_id. Supply one request_id per attempt; never auto-retry.
    """
    if not emergency and not (workflow_id or "").strip():
        return {
            "error": (
                "stop requires workflow_id unless emergency=true "
                "(do not invent a workflow_id)"
            ),
            "category": "invalid_request",
        }
    try:
        return bc.stop(
            workflow_id=workflow_id,
            request_id=request_id,
            emergency=bool(emergency),
        )
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_cancel(
    workflow_id: str | None = None,
    request_id: str | None = None,
    emergency: bool = False,
) -> dict[str, Any]:
    """Cancel the current activity for workflow_id.

    Normal cancel requires an explicit workflow_id. Only when emergency=true may
    workflow_id be omitted. Do not invent a workflow_id.
    """
    if not emergency and not (workflow_id or "").strip():
        return {
            "error": (
                "cancel requires workflow_id unless emergency=true "
                "(do not invent a workflow_id)"
            ),
            "category": "invalid_request",
        }
    try:
        return bc.cancel(
            workflow_id=workflow_id,
            request_id=request_id,
            emergency=bool(emergency),
        )
    except BridgeError as exc:
        return _bridge_error_payload(exc)


@mcp.tool()
def xbloom_recovery_reconcile(
    workflow_id: str,
    address: str | None = None,
    scan_timeout: float = 8.0,
) -> dict[str, Any]:
    """Reconcile machine state for a recovery workflow (query only, no re-start).

    Requires the matching workflow_id. Connects and queries fresh state; never
    re-sends load/start control writes.
    """
    wid = (workflow_id or "").strip()
    if not wid:
        return {
            "error": "recovery.reconcile requires an explicit workflow_id",
            "category": "invalid_request",
        }
    try:
        return bc.recovery_reconcile(
            workflow_id=wid,
            address=address,
            scan_timeout=float(scan_timeout),
        )
    except BridgeError as exc:
        return _bridge_error_payload(exc)


# ---------------------------------------------------------------------------
# Hot water (FreeSolo)
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_water_start(
    volume_ml: float,
    temp_c: int,
    confirmation: str,
    flow_ml_s: float = 3.5,
    pattern: str = "center",
    request_id: str | None = None,
) -> dict[str, Any]:
    """Start dispensing hot water (FreeSolo mode).

    volume_ml: 20-360 ml.
    temp_c: room temperature (25) or 40-98 C.
    flow_ml_s: 3.0-3.5 ml/s in 0.1 steps.
    pattern: center, spiral, or circular.
    confirmation: must be 'vessel-water-clear' — confirms the vessel is in
    place, water is loaded, and the area is clear. The bridge also requires
    XBLOOM_ENABLE_REMOTE_START on the daemon.
    """
    try:
        return bc.water_start(
            volume_ml=volume_ml,
            temp_c=temp_c,
            flow_ml_s=flow_ml_s,
            pattern=pattern,
            confirmation=confirmation,
            request_id=request_id,
        )
    except BridgeError as exc:
        return _bridge_error_payload(exc)


# ---------------------------------------------------------------------------
# Catalog (no BLE needed)
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_catalog_list(
    kind: str | None = None,
    executable_only: bool | None = None,
) -> dict[str, Any]:
    """List private recipe catalog entries.

    kind: filter by 'coffee' or 'tea' (optional).
    executable_only: if True, only show recipes that can run on the machine.
    Does not require BLE or the bridge daemon.
    """
    try:
        catalog, path = _catalog_load()
        kwargs: dict[str, Any] = {}
        if kind is not None:
            kwargs["kind"] = kind
        if executable_only is not None:
            kwargs["executable_only"] = executable_only
        entries = list_entries(catalog, **kwargs)
        return {"path": str(path), "count": len(entries), "entries": entries}
    except CatalogError as exc:
        return {"error": str(exc)}


@mcp.tool()
def xbloom_catalog_show(id: str) -> dict[str, Any]:
    """Show full details of a catalog entry by ID or unambiguous name.

    Includes the recipe parameters (doses, pours, temperatures), validation
    status, warnings, and slot compatibility. Does not require BLE.
    """
    try:
        catalog, _ = _catalog_load()
        entry = get_entry(catalog, id)
        return {"entry": entry}
    except CatalogError as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Recipes (no BLE needed)
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_recipe_templates() -> dict[str, Any]:
    """List bundled recipe templates (hot, flash-brew, official tea).

    Returns template files with their key parameters. Set XBLOOM_ASSETS_DIR
    to the Skill's assets directory for these to appear. Does not require BLE.
    """
    import yaml

    templates: list[dict[str, Any]] = []
    assets = _assets_dir()
    if assets and assets.is_dir():
        for path in sorted(assets.glob("*.yaml")):
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            is_tea = path.name.startswith("tea-")
            templates.append(
                {
                    "file": path.name,
                    "path": str(path),
                    "name": data.get("name", path.stem),
                    "kind": data.get("kind", "tea" if is_tea else "hot"),
                    "water_ml": data.get("water_ml"),
                    "pours": len(data.get("pours", []))
                    if isinstance(data.get("pours"), list)
                    else 0,
                    "tea": is_tea,
                }
            )
    return {
        "templates": templates,
        "assets_dir": str(assets) if assets else None,
        "hint": None if assets else "set XBLOOM_ASSETS_DIR to list bundled templates",
    }


@mcp.tool()
def xbloom_recipe_validate(path: str, slot: bool = False) -> dict[str, Any]:
    """Strictly validate a local recipe YAML file. Never touches BLE.

    path: local file path to the recipe YAML.
    slot: if True, also check slot compatibility (for A/B/C preset saving).
    Returns valid=True with a summary, or valid=False with an error.
    """
    from xbloom_safety import load_strict_recipe, recipe_summary, validate_slot_compatible

    resolved = Path(path).expanduser()
    if not resolved.is_file():
        return {"valid": False, "error": f"recipe not found: {resolved}"}
    try:
        recipe = load_strict_recipe(resolved)
        summary = recipe_summary(recipe, resolved)
        if slot:
            validate_slot_compatible(recipe)
        return {"valid": True, "summary": summary, "slot_compatible": slot or None}
    except Exception as exc:
        return {"valid": False, "error": str(exc), "type": type(exc).__name__}


# ---------------------------------------------------------------------------
# History (no BLE needed)
# ---------------------------------------------------------------------------


@mcp.tool()
def xbloom_history_list(limit: int = 20) -> dict[str, Any]:
    """List recent brew history events.

    Returns the most recent events (capped by limit). Does not require BLE.
    """
    state_dir = skill_state_dir()
    history_path = state_dir / "brew-history.jsonl"
    if not history_path.is_file():
        return {"events": [], "summary": {"total": 0}}
    events = list_events(path=history_path, limit=limit)
    summary = history_summary(history_path)
    return {"events": events, "summary": summary}


if __name__ == "__main__":
    mcp.run()
