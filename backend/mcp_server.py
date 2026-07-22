"""xBloom Studio MCP server.

Exposes xBloom Studio capabilities (scan, bridge control, catalog, recipes,
history) as MCP tools for AI agents. Uses stdio transport — the agent spawns
this process and communicates via JSON-RPC over stdin/stdout.

The MCP server is a client of the shared BLE bridge daemon (loopback RPC) and
the xbloom-studio-core library. It never holds a BLE connection of its own and
never touches hardware directly — all physical actions go through the bridge,
which enforces the safety model (owner gates, confirmation phrases, firmware
checks).

Run:
    python mcp_server.py

Prerequisites:
    # From the backend directory:
    pip install -r requirements-dev.txt   # local editable core
    # or: pip install -r requirements.txt  # release wheel
    set XBLOOM_ASSETS_DIR to the knowledge bundle's assets directory for templates

Bridge tools call core-owned ensure_bridge_daemon() on first use so a
persistent bridge process is established or reused without a sibling Skill
checkout. Starting/ensuring the daemon does not connect BLE; BLE connects only
on explicit hardware operations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from xbloom_ble.bridge import BridgeError, bridge_call, ensure_bridge_daemon
from xbloom_catalog import (
    CatalogError,
    catalog_summary,
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

def _require_bridge() -> dict[str, Any] | None:
    """Ensure a client-ready bridge daemon exists; return None or an error dict.

    Calls core-owned ``ensure_bridge_daemon()`` once per tool invocation so the
    first MCP/Skill use can start or reuse the persistent bridge process without
    a sibling checkout. Does not connect BLE. Never force-stops active/recovery
    work; surfaces upgrade_pending / not-ready results to the caller.
    """
    try:
        result = ensure_bridge_daemon()
    except Exception as exc:
        return {
            "error": f"failed to ensure bridge daemon: {exc}",
            "client_ready": False,
        }

    if not isinstance(result, dict):
        return {
            "error": f"ensure_bridge_daemon returned unexpected result: {result!r}",
            "client_ready": False,
        }

    if result.get("client_ready"):
        # Config mismatch may still be client_ready and remains usable.
        return None

    err: dict[str, Any] = {
        "error": (
            result.get("message")
            or result.get("reason")
            or "bridge daemon is not client-ready"
        ),
        "client_ready": False,
        "status": result.get("status"),
    }
    if result.get("upgrade_pending"):
        err["upgrade_pending"] = True
    return err


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
# Discovery & status (no BLE connection needed)
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
def xbloom_status() -> dict[str, Any]:
    """Get the BLE bridge daemon status: connection, activity, phase, telemetry.

    This is the primary status check. Returns running=False if the bridge is
    not running. When connected, includes machine name, firmware, current
    activity/phase, live telemetry, and the last operation result.
    """
    err = _require_bridge()
    if err is not None:
        return err
    return bridge_call("status")


@mcp.tool()
def xbloom_events(since: int = 0) -> dict[str, Any]:
    """Poll bridge daemon events since a sequence number.

    Returns events with seq numbers greater than 'since'. Use next_since from
    the previous response as the next 'since' value for incremental polling.
    """
    err = _require_bridge()
    if err is not None:
        return {"running": False, "events": [], "next_since": since}
    return bridge_call("events", {"since": since})


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

@mcp.tool()
def xbloom_connect(address: str | None = None) -> dict[str, Any]:
    """Connect the bridge to an xBloom machine.

    If address is omitted, scans for exactly one nearby machine. Once
    connected, the bridge holds the BLE session (the machine shows as
    connected). Only one machine can be connected at a time.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("connect", {"address": address} if address else {})
    except BridgeError as exc:
        return {"error": str(exc)}


@mcp.tool()
def xbloom_disconnect() -> dict[str, Any]:
    """Disconnect the bridge from the current machine.

    Refuses if an activity (brew/grinder/water) is loaded or running — stop
    or cancel it first.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("disconnect")
    except BridgeError as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Coffee
# ---------------------------------------------------------------------------

@mcp.tool()
def xbloom_coffee_load(recipe_path: str) -> dict[str, Any]:
    """Load a coffee recipe into the machine (arms it).

    The recipe_path must be a local YAML file. The bridge validates it
    strictly, connects if needed, and sends the load command. The machine
    enters 'armed' state. The recipe must be slot-compatible.

    After loading, use xbloom_coffee_start to begin brewing.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        resolved = str(Path(recipe_path).expanduser().resolve(strict=True))
        return bridge_call("coffee.load", {"recipe": resolved})
    except (BridgeError, OSError) as exc:
        return {"error": str(exc)}


@mcp.tool()
def xbloom_coffee_start(confirmation: str) -> dict[str, Any]:
    """Start brewing the loaded coffee recipe.

    Requires the confirmation phrase 'cup-filter-water-beans' — this is the
    safety gate confirming the cup is in place, the filter is ready, water is
    loaded, and beans are ground. The bridge also requires the
    XBLOOM_ENABLE_REMOTE_START env var to be set on the daemon.

    A loaded recipe expires after 5 minutes; reload if it's stale.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("coffee.start", {"confirmation": confirmation})
    except BridgeError as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Tea
# ---------------------------------------------------------------------------

@mcp.tool()
def xbloom_tea_load(recipe_path: str) -> dict[str, Any]:
    """Load a tea recipe into the machine.

    The recipe_path must be a local YAML file (tea recipe format). The bridge
    validates it, connects if needed, and sends the tea load command.

    After loading, use xbloom_tea_start to begin brewing.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        resolved = str(Path(recipe_path).expanduser().resolve(strict=True))
        return bridge_call("tea.load", {"recipe": resolved})
    except (BridgeError, OSError) as exc:
        return {"error": str(exc)}


@mcp.tool()
def xbloom_tea_start(confirmation: str) -> dict[str, Any]:
    """Start brewing the loaded tea recipe.

    Requires the confirmation phrase 'tea-brewer-water-cup-clear' — this is
    the safety gate confirming the tea brewer is in place, water is loaded,
    the cup is ready, and the area is clear. The bridge also requires the
    XBLOOM_ENABLE_REMOTE_START env var to be set on the daemon.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("tea.start", {"confirmation": confirmation})
    except BridgeError as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Flow control
# ---------------------------------------------------------------------------

@mcp.tool()
def xbloom_pause() -> dict[str, Any]:
    """Pause the running coffee, grinder, or water activity."""
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("pause")
    except BridgeError as exc:
        return {"error": str(exc)}


@mcp.tool()
def xbloom_resume() -> dict[str, Any]:
    """Resume a paused coffee, grinder, or water activity."""
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("resume")
    except BridgeError as exc:
        return {"error": str(exc)}


@mcp.tool()
def xbloom_stop() -> dict[str, Any]:
    """Stop or cancel the current activity, or recover a stale loaded recipe.

    If an activity is running, sends a cancel. If nothing is running but a
    loaded-recipe record exists, recovers it (cancels on the machine and
    clears the record). Safe to call when idle.
    """
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call("stop")
    except BridgeError as exc:
        return {"error": str(exc)}


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
    err = _require_bridge()
    if err is not None:
        return err
    try:
        return bridge_call(
            "water.start",
            {
                "volume_ml": volume_ml,
                "temp_c": temp_c,
                "flow_ml_s": flow_ml_s,
                "pattern": pattern,
                "confirmation": confirmation,
            },
        )
    except BridgeError as exc:
        return {"error": str(exc)}


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
