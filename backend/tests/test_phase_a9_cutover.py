"""Phase A9 Web/MCP typed bridge cutover tests.

No BLE hardware, no real bridge daemon. Uses a temp XBLOOM_STATE_DIR and
mocks the typed Web adapter / core TypedBridgeClient. Run from backend/:

    python -m pytest tests/ -q
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    state = tmp_path / "xbloom-state"
    state.mkdir()
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(state))
    return state


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _parse(path: Path) -> ast.AST:
    return ast.parse(_read(path), filename=str(path))


def _imported_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
                names.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            names.add(mod)
            for alias in node.names:
                names.add(alias.name)
                if mod:
                    names.add(f"{mod}.{alias.name}")
    return names


def _called_names(tree: ast.AST) -> set[str]:
    """Collect simple call identifiers: foo(), mod.foo(), obj.foo()."""

    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            names.add(func.id)
        elif isinstance(func, ast.Attribute):
            names.add(func.attr)
            # dotted prefix when base is a Name
            parts: list[str] = [func.attr]
            cur = func.value
            while isinstance(cur, ast.Attribute):
                parts.append(cur.attr)
                cur = cur.value
            if isinstance(cur, ast.Name):
                parts.append(cur.id)
                names.add(".".join(reversed(parts)))
    return names


def _function_defs(tree: ast.AST) -> set[str]:
    return {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _route_paths(app) -> set[tuple[str, str]]:
    """Return {(METHOD, path)} for registered FastAPI routes."""

    out: set[tuple[str, str]] = set()
    for route in app.routes:
        methods = getattr(route, "methods", None) or set()
        path = getattr(route, "path", None)
        if not path:
            continue
        for method in methods:
            out.add((method.upper(), path))
    return out


# ---------------------------------------------------------------------------
# Source contracts (AST / routes — not docstring substring traps)
# ---------------------------------------------------------------------------


def test_no_public_bridge_call_pass_through():
    tree = _parse(BACKEND_DIR / "bridge_client.py")
    defs = _function_defs(tree)
    assert "call" not in defs
    src = _read(BACKEND_DIR / "bridge_client.py")
    assert "TypedBridgeClient" in src
    assert "xbloom-studio-web" in src


def test_device_routes_register_explicit_endpoints_not_generic_call():
    import main as main_mod

    routes = _route_paths(main_mod.app)
    assert ("POST", "/api/device/call") not in routes
    assert ("POST", "/api/device/coffee/load") in routes
    assert ("POST", "/api/device/coffee/start") in routes
    assert ("POST", "/api/device/tea/load") in routes
    assert ("POST", "/api/device/tea/start") in routes
    assert ("POST", "/api/device/pause") in routes
    assert ("POST", "/api/device/resume") in routes
    assert ("POST", "/api/device/stop") in routes
    assert ("POST", "/api/device/cancel") in routes
    assert ("POST", "/api/device/recovery/reconcile") in routes
    assert ("POST", "/api/device/connect") in routes
    assert ("POST", "/api/device/disconnect") in routes
    assert ("GET", "/api/device/scan") in routes
    assert ("GET", "/api/device/probe") in routes
    assert ("GET", "/api/device/bridge") in routes
    assert ("GET", "/api/device/events") in routes

    device_tree = _parse(BACKEND_DIR / "routes" / "device.py")
    # Sync bridge work must be offloaded.
    assert "to_thread" in _called_names(device_tree)


def test_only_passive_scan_uses_xbloom_client_discovery():
    """AST: XBloomClient never imported; scan import only in scan tools."""

    for rel in (
        "bridge_client.py",
        "main.py",
        "mcp_server.py",
        "routes/device.py",
    ):
        tree = _parse(BACKEND_DIR / rel)
        imported = _imported_names(tree)
        assert "XBloomClient" not in imported, f"{rel} imports XBloomClient"
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == "XBloomClient":
                pytest.fail(f"{rel} references XBloomClient")

    device_tree = _parse(BACKEND_DIR / "routes" / "device.py")
    device_imports = _imported_names(device_tree)
    assert "scan" in device_imports
    # probe goes through adapter (bc.probe / bridge_client.probe), not XBloomClient.
    device_attrs = {
        node.attr
        for node in ast.walk(device_tree)
        if isinstance(node, ast.Attribute)
    }
    assert "probe" in device_attrs
    assert "coffee_load" in device_attrs or "coffee_load" in _called_names(device_tree)

    mcp_tree = _parse(BACKEND_DIR / "mcp_server.py")
    mcp_imports = _imported_names(mcp_tree)
    assert "scan" in mcp_imports


def test_mcp_does_not_import_or_call_raw_bridge_call_or_manual_ensure():
    tree = _parse(BACKEND_DIR / "mcp_server.py")
    imported = _imported_names(tree)
    called = _called_names(tree)
    defs = _function_defs(tree)

    assert "bridge_call" not in imported
    assert "bridge_call" not in called
    assert "ensure_bridge_daemon" not in imported
    assert "ensure_bridge_daemon" not in called
    assert "_require_bridge" not in defs
    assert "_require_bridge" not in called
    # Typed adapter is used.
    assert "bridge_client" in imported or "bc" in {
        n.asname or n.name
        for n in ast.walk(tree)
        if isinstance(n, ast.alias)
    } or any(
        isinstance(n, ast.Import)
        and any(a.name == "bridge_client" for a in n.names)
        for n in ast.walk(tree)
    )

    # No stale five-minute loaded expiry wording in tool docstrings/source.
    src = _read(BACKEND_DIR / "mcp_server.py")
    assert "expires after 5" not in src
    assert "5 minutes" not in src
    assert re.search(r"\bfive[- ]minute\b", src, re.I) is None


def test_frontend_explicit_workflow_and_cancel_no_generic_call():
    """Phase C5-C8: typed client, brew confirmation, Dashboard monitor.

    Dashboard polls status/events with exact workflow IDs, typed controls, and
    reconcile — never generic RPC. Closing/unmounting never mutates hardware.
    """

    api_src = _read(REPO_ROOT / "frontend" / "src" / "api.ts")
    dash_src = _read(REPO_ROOT / "frontend" / "src" / "pages" / "Dashboard.tsx")
    brew_src = _read(
        REPO_ROOT / "frontend" / "src" / "components" / "BrewConfirmDialog.tsx"
    )
    monitor_src = _read(REPO_ROOT / "frontend" / "src" / "lib" / "monitorLogic.ts")
    errors_src = _read(REPO_ROOT / "frontend" / "src" / "lib" / "apiErrors.ts")
    auth_src = _read(REPO_ROOT / "frontend" / "src" / "auth" / "AuthContext.tsx")

    assert "bridgeCall" not in api_src
    assert "bridgeCall" not in dash_src
    assert re.search(r"/device/call\b", api_src) is None
    assert "coffeeLoad" in api_src
    assert "cancel:" in api_src or "cancel =" in api_src or "cancel(" in api_src
    assert "/device/cancel" in api_src
    assert "active_workflow_id" in api_src
    # Load is revision-id only (no recipe path field on device load).
    assert "recipe_revision_id" in api_src
    assert re.search(r"coffeeLoad\([^)]*path", api_src) is None
    # release_state is not part of the bridge contract.
    assert "release_state" not in api_src or "release_state does not exist" in api_src
    assert "release_pending" in api_src
    assert "gap_detected" in api_src
    assert "instance_id" in api_src

    # Dashboard: exact workflow tracking + event polling (C5).
    assert "selectTrackedWorkflowId" in dash_src or "active_workflow_id" in dash_src
    assert "api.bridgeEvents" in dash_src
    assert "workflow_id" in dash_src or "trackedId" in dash_src
    # Non-overlapping poll guards.
    assert "statusInFlight" in dash_src or "InFlight" in dash_src
    # Controls mint fresh request_id per click; reconcile never uses request_id.
    assert "newRequestId" in dash_src
    assert "recoveryReconcile" in dash_src
    assert "api.pause" in dash_src
    assert "api.resume" in dash_src
    assert "api.stop" in dash_src
    assert "api.cancel" in dash_src
    # No generic RPC and no normal manual disconnect in workflow UI.
    assert "bridgeCall" not in dash_src
    assert "api.disconnect" not in dash_src
    assert "release_state" not in dash_src
    # Unmount/cleanup must not stop/cancel/disconnect.
    assert "stopPollsRef" in dash_src or "cancelled = true" in dash_src
    assert re.search(
        r"return\s*\(\)\s*=>\s*\{[^}]*api\.(stop|cancel|disconnect)",
        dash_src,
        re.S,
    ) is None
    # C6/C7 observability + terminal release labels.
    assert "connection_scope" in dash_src or "connectionScope" in dash_src
    assert "device_busy_external" in dash_src or "busyExternal" in dash_src
    assert "BLE released" in dash_src or "bleReleaseLabel" in dash_src
    assert "/history" in dash_src
    assert "buildFinalSummary" in dash_src or "FinalSummaryPanel" in dash_src
    # Event observation epoch + poll constant (no hard-coded 2000 for events).
    assert "isEventObservationCurrent" in dash_src
    assert "eventGenerationRef" in dash_src
    assert "EVENTS_POLL_MS" in dash_src
    # Sticky busy cleared only on explicit refresh / successful control.
    assert "clearStickyBusy" in dash_src
    assert "clearStickyBusyPendingRef" in dash_src
    # Explicit event rearm survives in-flight polls (generation bump).
    assert "applyExplicitEventRearm" in dash_src
    assert "applyExplicitEventRearm" in monitor_src
    # Stale workflow requires explicit UI acknowledgement (no silent control).
    assert "Use active workflow" in dash_src
    assert "ackedActiveId" in dash_src or "needsAcknowledgement" in dash_src
    assert "needsAcknowledgement" in monitor_src
    # Event observation errors are separate from status errors.
    assert "eventError" in dash_src
    assert 'handleObserveFailure(e, "events")' in dash_src or 'surface === "events"' in dash_src
    # connection_scope null displays none; do not invent daemon/connected source labels.
    assert '"none"' in dash_src or "'none'" in dash_src
    assert 'connected ? "connected"' not in dash_src
    assert 'running ? "daemon"' not in dash_src
    assert '? "bridge"' not in dash_src or "summary?.source" in dash_src
    # Do not invent stored kind on status success.
    assert 'kind: "coffee"' not in dash_src and "kind: 'coffee'" not in dash_src
    # No visible implementation/tutorial copy in user-facing strings.
    assert "never sends a request ID" not in dash_src
    assert "IDs are never invented here" not in dash_src
    assert "Observation never starts the daemon" not in dash_src
    assert "This is not a loading state" not in dash_src
    assert "will not resync until" not in dash_src
    assert "will not resync until" not in monitor_src
    # gap_reason surfaced for persistent event gaps.
    assert "gap_reason" in api_src
    assert "formatEventSyncWarning" in dash_src or "eventSyncWarning" in dash_src
    assert "Timeline unavailable" in monitor_src

    # Pure logic contracts.
    assert "selectTrackedWorkflowId" in monitor_src
    assert "applyInstanceChange" in monitor_src
    assert "applyGapDetected" in monitor_src
    assert "applyResyncPageResult" in monitor_src
    assert "isEventObservationCurrent" in monitor_src
    assert "captureEventObservation" in monitor_src
    assert "buildFinalSummary" in monitor_src
    assert "findLatestTerminalEvent" in monitor_src
    assert "mergeDurableEvents" in monitor_src
    assert "bleReleaseLabel" in monitor_src
    assert "validControlsForPhase" in monitor_src
    assert "EVENTS_POLL_MS" in monitor_src
    assert "device_busy_external" in errors_src
    assert "recovery_required" in errors_src
    assert "auth_expired" in errors_src or "isAuthExpiredError" in errors_src
    # Provider timeout only when explicit or Design context (not every timeout).
    assert "isProviderTimeoutError" in errors_src

    # Auth 401 -> refresh pairing gate (no request loop).
    assert "setAuthExpiredHandler" in api_src
    assert "setAuthExpiredHandler" in auth_src

    # Brew confirmation owns load/start with one newRequestId per action.
    assert "newRequestId" in brew_src
    assert "newRequestId(" in brew_src
    assert "recipe_revision_id" in brew_src or "recipeRevisionId" in brew_src
    assert "coffeeLoad" in brew_src or "api.coffeeLoad" in brew_src
    assert "workflow_id" in brew_src
    # Start failure must preserve workflow id (no automatic second load).
    assert "Loaded workflow" in brew_src or "preserve" in brew_src.lower()
    assert "setLoadedWorkflowId" in brew_src
    # request_id comes from newRequestId; workflow_id comes only from load/status.
    assert "newRequestId(\"load\")" in brew_src or "newRequestId('load')" in brew_src
    assert "newRequestId(\"start\")" in brew_src or "newRequestId('start')" in brew_src


def test_frontend_dashboard_typed_controls_and_reconcile_semantics():
    """Typed control bodies: request_id on mutations; never on reconcile."""

    dash_src = _read(REPO_ROOT / "frontend" / "src" / "pages" / "Dashboard.tsx")
    api_src = _read(REPO_ROOT / "frontend" / "src" / "api.ts")

    # recoveryReconcile adapter must not send request_id.
    reconcile_block = api_src[
        api_src.index("recoveryReconcile") : api_src.index("recoveryReconcile") + 500
    ]
    assert "workflow_id" in reconcile_block
    assert "request_id" not in reconcile_block

    # Dashboard reconcile path uses recoveryReconcile(workflowId) only.
    assert "api.recoveryReconcile(workflowId)" in dash_src or re.search(
        r"recoveryReconcile\(\s*workflowId", dash_src
    )
    # Pause/resume/stop/cancel receive a fresh request id.
    assert "newRequestId(action)" in dash_src or "newRequestId(" in dash_src
    assert "api.pause(workflowId, requestId)" in dash_src
    assert "api.resume(workflowId, requestId)" in dash_src
    assert "api.stop(workflowId, requestId)" in dash_src
    assert "api.cancel(workflowId, requestId)" in dash_src

    # Events require workflow_id query param (exact tracked id).
    assert "bridgeEvents" in api_src
    assert "workflow_id=" in api_src
    assert "encodeURIComponent(workflowId)" in api_src

    # Dashboard validates workflow_id on both incremental and zero-resync pages.
    assert dash_src.count("page.workflow_id") >= 1
    assert "full.workflow_id" in dash_src
    # Unmount finally must guard React state setters.
    assert "stopPollsRef.current" in dash_src
    # No manual disconnect action in workflow UI (status last_disconnect_* fields OK).
    assert "api.disconnect" not in dash_src
    assert re.search(r"\bonClick=\{[^}]*disconnect", dash_src) is None
    assert re.search(r">\s*Disconnect\s*<", dash_src) is None


def test_frontend_monitor_logic_exports_race_and_summary_helpers():
    """Source-contract: race/gap/summary helpers exist as real exports."""

    monitor_src = _read(REPO_ROOT / "frontend" / "src" / "lib" / "monitorLogic.ts")
    errors_src = _read(REPO_ROOT / "frontend" / "src" / "lib" / "apiErrors.ts")
    test_monitor = _read(
        REPO_ROOT / "frontend" / "src" / "lib" / "monitorLogic.test.ts"
    )
    test_errors = _read(REPO_ROOT / "frontend" / "src" / "lib" / "apiErrors.test.ts")

    for name in (
        "export function isEventObservationCurrent",
        "export function captureEventObservation",
        "export function applyResyncPageResult",
        "export function buildFinalSummary",
        "export function findLatestTerminalEvent",
        "export const EVENTS_POLL_MS",
    ):
        assert name in monitor_src, name

    assert "export function isProviderTimeoutError" in errors_src
    # Prefer server details.workflow_id over known stale id.
    assert "detailsWorkflowId" in errors_src or "details.workflow_id" in errors_src

    # Deterministic tests cover race, persistent gap, summary, timeout split.
    assert "rejects response after workflow identity change" in test_monitor
    assert "rejects response after instance change" in test_monitor
    assert "persistent gap on zero-resync" in test_monitor
    assert "builds summary from latest same-workflow terminal event" in test_monitor
    assert "terminal event proves durable terminal" in test_monitor
    assert "Design timeout as provider_timeout" in test_errors
    assert "hardware control timeout" in test_errors
    assert "prefers server details.workflow_id" in test_errors


def test_main_still_ensures_daemon_on_startup_not_shutdown():
    tree = _parse(BACKEND_DIR / "main.py")
    called = _called_names(tree)
    assert "ensure_bridge_daemon" in called or "ensure_bridge_daemon" in _imported_names(
        tree
    )
    src = _read(BACKEND_DIR / "main.py")
    # Lifespan is defined before create_app / default app assignment (Phase C1 factory).
    end_markers = ("\ndef create_app", "\napp = create_app", "\napp = FastAPI")
    end = min(src.index(m) for m in end_markers if m in src)
    lifespan_body = src[src.index("async def lifespan") : end]
    before_yield, after_yield = lifespan_body.split("yield", 1)
    assert "await _ensure_bridge_daemon()" in before_yield
    assert "stop_bridge" not in after_yield
    assert "ensure_bridge_daemon" not in after_yield


# ---------------------------------------------------------------------------
# Adapter behavior
# ---------------------------------------------------------------------------


def test_status_offline_without_ensure(monkeypatch):
    import bridge_client as bc

    ensure = MagicMock(side_effect=AssertionError("status must not ensure"))
    monkeypatch.setattr(bc.client, "ensure_daemon", ensure)
    monkeypatch.setattr(bc, "is_running", lambda: False)
    monkeypatch.setattr(
        bc.client, "status", MagicMock(side_effect=AssertionError("no status rpc"))
    )
    out = bc.status()
    assert out["running"] is False
    assert out.get("available") is False
    ensure.assert_not_called()


def test_events_requires_workflow_id_and_does_not_ensure(monkeypatch):
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    ensure = MagicMock(side_effect=AssertionError("events must not ensure"))
    monkeypatch.setattr(bc.client, "ensure_daemon", ensure)
    monkeypatch.setattr(bc, "is_running", lambda: False)

    with pytest.raises(BridgeError) as ei:
        bc.events(since=0, workflow_id="")
    assert getattr(ei.value, "category", None) == "invalid_request"
    ensure.assert_not_called()

    out = bc.events(since=3, workflow_id="wf_1")
    assert out["running"] is False
    assert out["events"] == []
    assert out["next_since"] == 3
    ensure.assert_not_called()


def test_disconnect_never_starts_daemon(monkeypatch):
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    ensures: list[int] = []
    monkeypatch.setattr(
        "xbloom_ble.bridge_client.ensure_bridge_daemon",
        lambda **k: ensures.append(1) or {"client_ready": True},
    )
    monkeypatch.setattr(
        "xbloom_ble.bridge_client.bridge_is_running",
        lambda **k: False,
    )
    monkeypatch.setattr(bc, "is_running", lambda: False)
    with pytest.raises(BridgeError) as ei:
        bc.disconnect()
    assert ensures == []
    assert getattr(ei.value, "category", None) == "daemon_not_running"


def test_probe_uses_typed_client_and_redacts_secrets(monkeypatch):
    import bridge_client as bc

    mock_probe = MagicMock(
        return_value={
            "firmware": "1.0",
            "address": "AA:BB",
            "serial_number": "SECRET",
            "nested": {"token": "t", "ok": True},
        }
    )
    monkeypatch.setattr(bc.client, "probe", mock_probe)
    out = bc.probe(address="AA:BB", scan_timeout=5.0)
    mock_probe.assert_called_once()
    assert out["firmware"] == "1.0"
    assert "serial_number" not in out
    assert "token" not in out.get("nested", {})
    assert out["nested"]["ok"] is True


def test_public_response_recursive_redaction():
    import bridge_client as bc

    cleaned = bc.public_response(
        {
            "ok": True,
            "serial_number": "S",
            "token": "T",
            "deep": [{"password": "p", "x": 1}, {"auth_token": "a"}],
        }
    )
    assert cleaned == {"ok": True, "deep": [{"x": 1}, {}]}


def test_coffee_start_preserves_request_and_workflow_id(monkeypatch):
    import bridge_client as bc

    seen: dict = {}

    def fake_start(**kwargs):
        seen.update(kwargs)
        return {"status": "running", "workflow_id": kwargs["workflow_id"]}

    monkeypatch.setattr(bc.client, "coffee_start", fake_start)
    out = bc.coffee_start(
        workflow_id="wf_abc",
        confirmation="cup-filter-water-beans",
        request_id="req_keep",
    )
    assert seen["workflow_id"] == "wf_abc"
    assert seen["request_id"] == "req_keep"
    assert out["workflow_id"] == "wf_abc"


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    import main as main_mod

    async def _noop():
        return None

    monkeypatch.setattr(main_mod, "_ensure_bridge_daemon", _noop)
    return TestClient(main_mod.app)


def test_http_no_registered_device_call_route(client):
    """No POST /api/device/call route; request may be 404 or 405."""
    import main as main_mod

    routes = _route_paths(main_mod.app)
    assert ("POST", "/api/device/call") not in routes
    res = client.post("/api/device/call", json={"method": "status"})
    assert res.status_code in (404, 405)


def test_http_events_requires_workflow_id(client, monkeypatch):
    import bridge_client as bc

    monkeypatch.setattr(bc, "is_running", lambda: True)
    monkeypatch.setattr(
        bc, "events", MagicMock(return_value={"events": [], "next_since": 0})
    )
    res = client.get("/api/device/events?since=0")
    assert res.status_code == 422  # missing required query

    res = client.get("/api/device/events?workflow_id=wf_1&since=0")
    assert res.status_code == 200
    bc.events.assert_called_once()
    kwargs = bc.events.call_args.kwargs
    assert kwargs.get("workflow_id") == "wf_1" or (
        bc.events.call_args.args and "wf_1" in bc.events.call_args.args
    )


def test_http_coffee_load_start_propagate_ids(client, monkeypatch):
    import bridge_client as bc

    load_mock = MagicMock(
        return_value={"workflow_id": "wf_loaded", "phase": "loaded"}
    )
    start_mock = MagicMock(
        return_value={"workflow_id": "wf_loaded", "phase": "running"}
    )
    monkeypatch.setattr(bc, "coffee_load", load_mock)
    monkeypatch.setattr(bc, "coffee_start", start_mock)

    # B9b: browser load is revision-only (no local recipe path field).
    res = client.post(
        "/api/device/coffee/load",
        json={
            "recipe_revision_id": "rev_loaded_1",
            "request_id": "req_load_1",
        },
    )
    assert res.status_code == 200
    assert res.json()["workflow_id"] == "wf_loaded"
    assert load_mock.call_args.kwargs["request_id"] == "req_load_1"
    assert load_mock.call_args.kwargs["recipe_revision_id"] == "rev_loaded_1"
    assert load_mock.call_args.kwargs.get("recipe") in (None, "")

    res = client.post(
        "/api/device/coffee/start",
        json={
            "workflow_id": "wf_loaded",
            "confirmation": "cup-filter-water-beans",
            "request_id": "req_start_1",
        },
    )
    assert res.status_code == 200
    assert start_mock.call_args.kwargs["workflow_id"] == "wf_loaded"
    assert start_mock.call_args.kwargs["request_id"] == "req_start_1"


def test_http_stop_requires_workflow_unless_emergency(client, monkeypatch):
    import bridge_client as bc

    stop_mock = MagicMock(return_value={"ok": True})
    monkeypatch.setattr(bc, "stop", stop_mock)

    res = client.post("/api/device/stop", json={})
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert detail["category"] == "invalid_request"
    stop_mock.assert_not_called()

    res = client.post(
        "/api/device/stop",
        json={"emergency": True, "request_id": "req_em"},
    )
    assert res.status_code == 200
    assert stop_mock.call_args.kwargs["emergency"] is True


def test_http_bridge_error_category_mapping(client, monkeypatch):
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    monkeypatch.setattr(
        bc,
        "pause",
        MagicMock(
            side_effect=BridgeError("no running bridge", category="daemon_not_running")
        ),
    )
    res = client.post(
        "/api/device/pause",
        json={"workflow_id": "wf_1", "request_id": "r1"},
    )
    assert res.status_code == 503
    detail = res.json()["detail"]
    assert detail["category"] == "daemon_not_running"
    assert "no running bridge" in detail["message"]

    monkeypatch.setattr(
        bc,
        "pause",
        MagicMock(
            side_effect=BridgeError(
                "device held elsewhere", category="device_busy_external"
            )
        ),
    )
    res = client.post(
        "/api/device/pause",
        json={"workflow_id": "wf_1", "request_id": "r2"},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["category"] == "device_busy_external"


def test_http_disconnect_maps_daemon_not_running(client, monkeypatch):
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    monkeypatch.setattr(
        bc,
        "disconnect",
        MagicMock(
            side_effect=BridgeError(
                "no running bridge daemon to disconnect",
                category="daemon_not_running",
            )
        ),
    )
    res = client.post("/api/device/disconnect")
    assert res.status_code == 503
    assert res.json()["detail"]["category"] == "daemon_not_running"


def test_http_probe_uses_adapter_not_xbloom_client(client, monkeypatch):
    import bridge_client as bc

    probe_mock = MagicMock(
        return_value={
            "firmware": "x",
            "model": "studio",
            "serial_number": "SECRET",
            "nested": {"token": "t"},
        }
    )
    monkeypatch.setattr(bc, "probe", probe_mock)
    res = client.get("/api/device/probe")
    assert res.status_code == 200
    body = res.json()
    assert body["command"] == "probe"
    assert body.get("firmware") == "x"
    assert body.get("model") == "studio"
    assert "serial_number" not in body
    assert "token" not in body.get("nested", {})
    probe_mock.assert_called_once()


def test_http_status_observation_no_hardware(client, monkeypatch):
    import bridge_client as bc

    monkeypatch.setattr(
        bc,
        "status",
        MagicMock(
            return_value={
                "running": True,
                "available": True,
                "active_workflow_id": "wf_live",
                "phase": "running",
            }
        ),
    )
    res = client.get("/api/device/bridge")
    assert res.status_code == 200
    assert res.json()["active_workflow_id"] == "wf_live"
    bc.status.assert_called_once()


# ---------------------------------------------------------------------------
# MCP tools
# ---------------------------------------------------------------------------


def test_mcp_status_does_not_ensure(monkeypatch):
    import mcp_server as mcp_mod
    import bridge_client as bc

    ensure = MagicMock(side_effect=AssertionError("must not ensure"))
    monkeypatch.setattr(bc.client, "ensure_daemon", ensure)
    monkeypatch.setattr(
        bc, "status", MagicMock(return_value={"running": False, "available": False})
    )
    out = mcp_mod.xbloom_status()
    assert out["running"] is False
    ensure.assert_not_called()


def test_mcp_events_requires_workflow_id(monkeypatch):
    import mcp_server as mcp_mod
    import bridge_client as bc

    monkeypatch.setattr(
        bc, "events", MagicMock(return_value={"events": [], "next_since": 1})
    )
    out = mcp_mod.xbloom_events(workflow_id="")
    assert out.get("category") == "invalid_request"
    bc.events.assert_not_called()

    out = mcp_mod.xbloom_events(workflow_id="wf_9", since=2)
    assert out["next_since"] == 1
    bc.events.assert_called_once()


def test_mcp_start_requires_workflow_id(monkeypatch):
    import mcp_server as mcp_mod
    import bridge_client as bc

    monkeypatch.setattr(bc, "coffee_start", MagicMock())
    out = mcp_mod.xbloom_coffee_start(
        workflow_id="", confirmation="cup-filter-water-beans"
    )
    assert out.get("category") == "invalid_request"
    bc.coffee_start.assert_not_called()


def test_mcp_stop_emergency_may_omit_workflow(monkeypatch):
    import mcp_server as mcp_mod
    import bridge_client as bc

    stop_mock = MagicMock(return_value={"ok": True})
    monkeypatch.setattr(bc, "stop", stop_mock)

    out = mcp_mod.xbloom_stop()
    assert out.get("category") == "invalid_request"
    stop_mock.assert_not_called()

    out = mcp_mod.xbloom_stop(emergency=True, request_id="req_e")
    assert out.get("ok") is True
    assert stop_mock.call_args.kwargs["emergency"] is True


def test_mcp_structured_error_retains_category(monkeypatch):
    import mcp_server as mcp_mod
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    monkeypatch.setattr(
        bc,
        "pause",
        MagicMock(
            side_effect=BridgeError("held by phone", category="device_busy_external")
        ),
    )
    out = mcp_mod.xbloom_pause(workflow_id="wf_1", request_id="r1")
    assert out["category"] == "device_busy_external"
    assert "held by phone" in out["error"]


def test_mcp_probe_uses_adapter(monkeypatch):
    import mcp_server as mcp_mod
    import bridge_client as bc

    monkeypatch.setattr(
        bc,
        "probe",
        MagicMock(return_value={"firmware": "f", "serial_number": "S", "token": "t"}),
    )
    out = mcp_mod.xbloom_probe()
    assert out["command"] == "probe"
    assert "serial_number" not in out
    assert "token" not in out
