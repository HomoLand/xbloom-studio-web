"""Phase B9b browser HTTP boundary: revision-only load, public sanitizer, no path leaks.

No BLE hardware. Mocks the typed bridge adapter. Run from backend/:

    python -m pytest tests/test_phase_b9_browser_boundary.py -q
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    state = tmp_path / "xbloom-state"
    state.mkdir()
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(state))
    return state


@pytest.fixture
def client(monkeypatch):
    import main as main_mod
    from unittest.mock import patch

    monkeypatch.setenv("XBLOOM_WEB_MODE", "loopback")
    with patch(
        "main.ensure_bridge_daemon",
        return_value={"status": "ok", "client_ready": True},
    ):
        app = main_mod.create_app()
        with TestClient(app) as tc:
            yield tc


def _assert_no_local_path_leak(text: str, *needles: str) -> None:
    for needle in needles:
        assert needle not in text
    assert "C:\\Users" not in text
    assert "C:/Users" not in text
    assert "/home/" not in text
    assert "file://" not in text.casefold()


# ---------------------------------------------------------------------------
# OpenAPI / body contract for coffee & tea load
# ---------------------------------------------------------------------------


def test_openapi_load_bodies_require_revision_forbid_recipe(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    paths = schema["paths"]

    for route in ("/api/device/coffee/load", "/api/device/tea/load"):
        post = paths[route]["post"]
        body_schema = post["requestBody"]["content"]["application/json"]["schema"]
        # Resolve $ref if present.
        if "$ref" in body_schema:
            ref = body_schema["$ref"].split("/")[-1]
            model = schema["components"]["schemas"][ref]
        else:
            model = body_schema

        required = set(model.get("required") or [])
        props = set((model.get("properties") or {}).keys())
        assert "recipe_revision_id" in required
        assert "recipe_revision_id" in props
        assert "recipe" not in props
        # Strict: extra fields forbidden.
        assert model.get("additionalProperties") is False


def test_http_coffee_load_rejects_recipe_path_no_echo(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import bridge_client as bc

    load_mock = MagicMock(return_value={"workflow_id": "wf_x"})
    monkeypatch.setattr(bc, "coffee_load", load_mock)

    secret_path = "C:/Users/secret/recipes/evil.yaml"
    res = client.post(
        "/api/device/coffee/load",
        json={"recipe": secret_path, "request_id": "r1"},
    )
    assert res.status_code == 422
    body = res.json()
    detail = body["detail"]
    assert detail["category"] == "validation"
    assert secret_path not in res.text
    _assert_no_local_path_leak(res.text, secret_path)
    # Must not echo raw request input blobs.
    assert "input" not in res.text.casefold() or secret_path not in res.text
    load_mock.assert_not_called()


def test_http_tea_load_rejects_recipe_path_no_echo(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import bridge_client as bc

    load_mock = MagicMock(return_value={"workflow_id": "wf_x"})
    monkeypatch.setattr(bc, "tea_load", load_mock)

    secret_path = "/home/secret/tea-recipe.yaml"
    res = client.post(
        "/api/device/tea/load",
        json={"recipe": secret_path},
    )
    assert res.status_code == 422
    assert secret_path not in res.text
    _assert_no_local_path_leak(res.text, secret_path)
    load_mock.assert_not_called()


def test_http_coffee_and_tea_load_revision_only_adapter_calls(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import bridge_client as bc

    coffee_mock = MagicMock(
        return_value={
            "workflow_id": "wf_coffee",
            "phase": "loaded",
            "pathway": "bridge",
            "tokenizer": "none",
            "used_image": False,
            "candidate_hash": "a" * 64,
        }
    )
    tea_mock = MagicMock(
        return_value={
            "workflow_id": "wf_tea",
            "phase": "loaded",
            "pathway": "bridge",
        }
    )
    monkeypatch.setattr(bc, "coffee_load", coffee_mock)
    monkeypatch.setattr(bc, "tea_load", tea_mock)

    coffee_res = client.post(
        "/api/device/coffee/load",
        json={
            "recipe_revision_id": "rev_coffee_1",
            "request_id": "req_c1",
            "scan_timeout": 5.0,
        },
    )
    assert coffee_res.status_code == 200, coffee_res.text
    assert coffee_res.json()["workflow_id"] == "wf_coffee"
    # Safe fields preserved.
    assert coffee_res.json()["pathway"] == "bridge"
    assert coffee_res.json()["tokenizer"] == "none"
    assert coffee_res.json()["used_image"] is False
    assert coffee_res.json()["candidate_hash"] == "a" * 64

    ckwargs = coffee_mock.call_args.kwargs
    assert ckwargs["recipe_revision_id"] == "rev_coffee_1"
    assert ckwargs["request_id"] == "req_c1"
    assert "recipe" not in ckwargs or ckwargs.get("recipe") in (None, "")

    tea_res = client.post(
        "/api/device/tea/load",
        json={"recipe_revision_id": "rev_tea_1", "request_id": "req_t1"},
    )
    assert tea_res.status_code == 200, tea_res.text
    assert tea_res.json()["workflow_id"] == "wf_tea"
    tkwargs = tea_mock.call_args.kwargs
    assert tkwargs["recipe_revision_id"] == "rev_tea_1"
    assert "recipe" not in tkwargs or tkwargs.get("recipe") in (None, "")


def test_http_load_rejects_extra_fields(client: TestClient) -> None:
    res = client.post(
        "/api/device/coffee/load",
        json={
            "recipe_revision_id": "rev_1",
            "unexpected": True,
        },
    )
    assert res.status_code == 422
    assert res.json()["detail"]["category"] == "validation"


@pytest.mark.parametrize(
    ("route", "body"),
    [
        (
            "/api/device/coffee/start",
            {"workflow_id": "wf_1", "confirmation": "ready"},
        ),
        ("/api/device/pause", {"workflow_id": "wf_1"}),
        ("/api/device/resume", {"workflow_id": "wf_1"}),
        ("/api/device/stop", {"workflow_id": "wf_1"}),
        ("/api/device/cancel", {"workflow_id": "wf_1"}),
        ("/api/device/recovery/reconcile", {"workflow_id": "wf_1"}),
        ("/api/device/connect", {}),
    ],
)
def test_all_device_mutation_bodies_reject_unsafe_extras_without_echo(
    client: TestClient,
    route: str,
    body: dict[str, Any],
) -> None:
    secret_path = "C:/Users/secret/should-not-echo.yaml"
    res = client.post(route, json={**body, "recipe_path": secret_path})

    assert res.status_code == 422
    assert res.json()["detail"]["category"] == "validation"
    _assert_no_local_path_leak(res.text, secret_path)


# ---------------------------------------------------------------------------
# bridge_client adapters: dual source, tea parity, MCP path compatibility
# ---------------------------------------------------------------------------


def test_bridge_client_coffee_tea_revision_only_and_path_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import bridge_client as bc

    seen: list[dict[str, Any]] = []

    def fake_coffee_load(**kwargs):
        seen.append({"op": "coffee", **kwargs})
        return {"ok": True, "op": "coffee"}

    def fake_tea_load(**kwargs):
        seen.append({"op": "tea", **kwargs})
        return {"ok": True, "op": "tea"}

    monkeypatch.setattr(bc.client, "coffee_load", fake_coffee_load)
    monkeypatch.setattr(bc.client, "tea_load", fake_tea_load)

    # Revision-only (browser path).
    out = bc.coffee_load(recipe_revision_id="rev_abc")
    assert out["ok"] is True
    assert seen[-1]["recipe_revision_id"] == "rev_abc"
    assert "recipe" not in seen[-1]

    out = bc.tea_load(recipe_revision_id="rev_tea")
    assert seen[-1]["recipe_revision_id"] == "rev_tea"
    assert "recipe" not in seen[-1]

    # Path-only (MCP/Skill).
    out = bc.coffee_load(recipe="C:/recipes/hot.yaml")
    assert seen[-1]["recipe"] == "C:/recipes/hot.yaml"
    assert "recipe_revision_id" not in seen[-1]

    out = bc.tea_load(recipe="/home/agent/tea.yaml")
    assert seen[-1]["recipe"] == "/home/agent/tea.yaml"
    assert "recipe_revision_id" not in seen[-1]


def test_bridge_client_requires_at_least_one_source_and_preserves_dual_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    with pytest.raises(BridgeError) as neither:
        bc.coffee_load()
    assert neither.value.category == "invalid_request"

    with pytest.raises(BridgeError):
        bc.tea_load()

    coffee = MagicMock(return_value={"ok": True})
    tea = MagicMock(return_value={"ok": True})
    monkeypatch.setattr(bc.client, "coffee_load", coffee)
    monkeypatch.setattr(bc.client, "tea_load", tea)

    bc.coffee_load(recipe="C:/r.yaml", recipe_revision_id="rev_1")
    assert coffee.call_args.kwargs["recipe"] == "C:/r.yaml"
    assert coffee.call_args.kwargs["recipe_revision_id"] == "rev_1"

    bc.tea_load(recipe="/tmp/t.yaml", recipe_revision_id="rev_t")
    assert tea.call_args.kwargs["recipe"] == "/tmp/t.yaml"
    assert tea.call_args.kwargs["recipe_revision_id"] == "rev_t"


def test_mcp_local_path_input_compatibility() -> None:
    """MCP tools still accept recipe_path and call adapter with recipe=path."""

    mcp_path = BACKEND_DIR / "mcp_server.py"
    source = mcp_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(mcp_path))

    coffee_load_fn = None
    tea_load_fn = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            if node.name == "xbloom_coffee_load":
                coffee_load_fn = node
            elif node.name == "xbloom_tea_load":
                tea_load_fn = node

    assert coffee_load_fn is not None
    assert tea_load_fn is not None

    def _arg_names(fn: ast.FunctionDef) -> set[str]:
        return {a.arg for a in fn.args.args}

    assert "recipe_path" in _arg_names(coffee_load_fn)
    assert "recipe_path" in _arg_names(tea_load_fn)

    # Signature of adapters still accept local path.
    import bridge_client as bc

    coffee_sig = inspect.signature(bc.coffee_load)
    tea_sig = inspect.signature(bc.tea_load)
    assert "recipe" in coffee_sig.parameters
    assert "recipe_revision_id" in coffee_sig.parameters
    assert "recipe" in tea_sig.parameters
    assert "recipe_revision_id" in tea_sig.parameters
    assert coffee_sig.parameters["recipe"].default is None
    assert tea_sig.parameters["recipe"].default is None

    # Source still passes recipe=resolved for MCP path flow.
    assert "bc.coffee_load(recipe=resolved" in source
    assert "bc.tea_load(recipe=resolved" in source


# ---------------------------------------------------------------------------
# Public sanitizer: bridge status / events / mutations
# ---------------------------------------------------------------------------


def test_sanitize_public_output_drops_secrets_paths_images_reasoning() -> None:
    from public_contract import sanitize_public_output

    raw = {
        "workflow_id": "wf_1",
        "pathway": "device",
        "tokenizer": "tiktoken",
        "used_image": True,
        "candidate_hash": "b" * 64,
        "recipe_path": "C:/Users/secret/recipe.yaml",
        "source_path": "/home/secret/src.yaml",
        "filepath": "C:/tmp/x.yaml",
        "path": "C:/hidden",
        "serial_number": "SN-SECRET",
        "token": "tok",
        "password": "pw",
        "secret": "s",
        "reasoning": "chain of thought here",
        "image_base64": "AAAA",
        "raw_image": "blob",
        "command": "rm -rf /",
        "shell": "bash",
        "neutral_binary": b"do-not-serialize",
        "nested": {
            "ok": 1,
            "auth_token": "at",
            "note": "see C:/Users/secret/notes.txt for details",
            "deep": [
                {"password": "p", "x": 2},
                {"recipe_path": "/home/secret/r.yaml", "y": 3},
            ],
        },
        "events": (
            {"type": "tick", "msg": "loaded from file:///C:/Users/secret/r.yaml"},
        ),
    }
    cleaned = sanitize_public_output(raw)

    assert cleaned["workflow_id"] == "wf_1"
    assert cleaned["pathway"] == "device"
    assert cleaned["tokenizer"] == "tiktoken"
    assert cleaned["used_image"] is True
    assert cleaned["candidate_hash"] == "b" * 64

    for bad in (
        "recipe_path",
        "source_path",
        "filepath",
        "path",
        "serial_number",
        "token",
        "password",
        "secret",
        "reasoning",
        "image_base64",
        "raw_image",
    ):
        assert bad not in cleaned

    # Existing descriptive response fields remain public; unsafe command/shell
    # fields are rejected on request input instead of silently changing output.
    assert cleaned["command"] == "rm -rf /"
    assert cleaned["shell"] == "bash"
    assert cleaned["neutral_binary"] == "[redacted-binary]"

    assert cleaned["nested"]["ok"] == 1
    assert "auth_token" not in cleaned["nested"]
    assert "C:/Users/secret" not in cleaned["nested"]["note"]
    assert "[redacted-path]" in cleaned["nested"]["note"]
    assert cleaned["nested"]["deep"] == [{"x": 2}, {"y": 3}]
    assert "file://" not in cleaned["events"][0]["msg"].casefold()
    assert "[redacted-path]" in cleaned["events"][0]["msg"]


def test_http_bridge_status_events_mutations_sanitized(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import bridge_client as bc

    secret_path = "C:/Users/secret/bridge-state.json"

    monkeypatch.setattr(
        bc,
        "status",
        lambda: {
            "running": True,
            "available": True,
            "connected": True,
            "serial_number": "SN-1",
            "token": "t",
            "recipe_path": secret_path,
            "pathway": "ok",
            "hint": f"see log at {secret_path}",
        },
    )
    status_res = client.get("/api/device/bridge")
    assert status_res.status_code == 200
    body = status_res.json()
    assert body["pathway"] == "ok"
    assert "serial_number" not in body
    assert "token" not in body
    assert "recipe_path" not in body
    assert secret_path not in status_res.text
    assert "[redacted-path]" in body["hint"]

    monkeypatch.setattr(bc, "is_running", lambda: True)
    monkeypatch.setattr(
        bc,
        "events",
        lambda **kwargs: {
            "events": [
                {
                    "type": "loaded",
                    "recipe_path": secret_path,
                    "password": "x",
                    "msg": f"loaded {secret_path}",
                }
            ],
            "next_since": 3,
            "reasoning": "should drop",
        },
    )
    events_res = client.get("/api/device/events?workflow_id=wf_1&since=0")
    assert events_res.status_code == 200
    ev_body = events_res.json()
    assert "reasoning" not in ev_body
    assert secret_path not in events_res.text
    assert "password" not in events_res.text
    assert "recipe_path" not in events_res.text
    assert ev_body["next_since"] == 3
    assert "[redacted-path]" in ev_body["events"][0]["msg"]

    monkeypatch.setattr(
        bc,
        "pause",
        MagicMock(
            return_value={
                "ok": True,
                "image_base64": "AAAA",
                "source_path": secret_path,
                "workflow_id": "wf_1",
            }
        ),
    )
    pause_res = client.post(
        "/api/device/pause", json={"workflow_id": "wf_1", "request_id": "r1"}
    )
    assert pause_res.status_code == 200
    assert pause_res.json()["workflow_id"] == "wf_1"
    assert "image_base64" not in pause_res.json()
    assert "source_path" not in pause_res.json()
    assert secret_path not in pause_res.text


def test_bridge_error_paths_redacted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import bridge_client as bc
    from xbloom_ble.bridge import BridgeError

    secret = "C:/Users/secret/missing-recipe.yaml"

    def boom(**_kwargs):
        raise BridgeError(
            f"failed to load recipe at {secret}",
            category="invalid_request",
        )

    monkeypatch.setattr(bc, "coffee_load", boom)
    res = client.post(
        "/api/device/coffee/load",
        json={"recipe_revision_id": "rev_missing"},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert detail["category"] == "invalid_request"
    assert secret not in res.text
    assert "C:/Users/secret" not in res.text
    assert "[redacted-path]" in detail["message"]


# ---------------------------------------------------------------------------
# Catalog / history: no local paths in HTTP responses
# ---------------------------------------------------------------------------


def test_catalog_and_history_responses_omit_local_paths(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import routes.catalog as catalog_mod
    import routes.history as history_mod

    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text("{}", encoding="utf-8")
    secret_entry_path = str(tmp_path / "recipes" / "hot.yaml")

    fake_catalog = {
        "updated_at": "2020-01-01T00:00:00Z",
        "entries": [
            {
                "id": "e1",
                "kind": "coffee",
                "name": "Test",
                "executable": True,
                "slot_compatible": True,
                "recipe_path": secret_entry_path,
                "path": secret_entry_path,
            }
        ],
    }

    monkeypatch.setattr(
        catalog_mod,
        "_load",
        lambda: (fake_catalog, catalog_path),
    )
    monkeypatch.setattr(
        catalog_mod,
        "list_entries",
        lambda catalog, **kwargs: list(catalog.get("entries") or []),
    )
    monkeypatch.setattr(
        catalog_mod,
        "get_entry",
        lambda catalog, id: (catalog.get("entries") or [])[0],
    )

    status = client.get("/api/catalog/status")
    assert status.status_code == 200
    assert "path" not in status.json()
    assert str(catalog_path) not in status.text
    assert secret_entry_path not in status.text

    listed = client.get("/api/catalog/list")
    assert listed.status_code == 200
    body = listed.json()
    assert "path" not in body
    assert body["count"] == 1
    entry = body["entries"][0]
    assert "recipe_path" not in entry
    assert "path" not in entry
    assert secret_entry_path not in listed.text

    shown = client.get("/api/catalog/show?id=e1")
    assert shown.status_code == 200
    assert "recipe_path" not in shown.json()["entry"]
    assert secret_entry_path not in shown.text

    monkeypatch.setattr(
        catalog_mod,
        "import_payload",
        lambda catalog, payload, **kwargs: {
            "candidates": 1,
            "added": 1,
            "updated": 0,
            "rejected": 0,
            "recipe_path": secret_entry_path,
            "note": f"imported from {secret_entry_path}",
        },
    )
    monkeypatch.setattr(catalog_mod, "save_catalog", lambda catalog, path: None)
    imported = client.post(
        "/api/catalog/import",
        files={"file": ("recipes.json", b'{"recipes": []}', "application/json")},
    )
    assert imported.status_code == 200
    assert "path" not in imported.json()
    assert "recipe_path" not in imported.json()
    assert secret_entry_path not in imported.text
    assert "[redacted-path]" in imported.json()["note"]

    hist_path = str(tmp_path / "history.jsonl")
    monkeypatch.setattr(
        history_mod,
        "history_summary",
        lambda: {
            "path": hist_path,
            "exists": True,
            "total": 1,
            "by_outcome": {"ok": 1},
            "by_source": {"web": 1},
            "latest_recorded_at": "2020-01-01T00:00:00Z",
        },
    )
    monkeypatch.setattr(
        history_mod,
        "list_events",
        lambda **kwargs: [
            {
                "event_id": "ev1",
                "recipe_name": "Hot",
                "recipe_path": secret_entry_path,
                "outcome": "ok",
                "source": "web",
                "note": f"brewed from {secret_entry_path}",
            }
        ],
    )

    h_status = client.get("/api/history/status")
    assert h_status.status_code == 200
    assert "path" not in h_status.json()
    assert hist_path not in h_status.text

    h_list = client.get("/api/history/list")
    assert h_list.status_code == 200
    events = h_list.json()["events"]
    assert len(events) == 1
    assert "recipe_path" not in events[0]
    assert secret_entry_path not in h_list.text
    assert "[redacted-path]" in events[0]["note"]


# ---------------------------------------------------------------------------
# No generic bridge call route
# ---------------------------------------------------------------------------


def test_no_generic_bridge_call_route(client: TestClient) -> None:
    found_call = False
    for r in client.app.routes:
        if getattr(r, "path", None) == "/api/device/call":
            found_call = True
    assert not found_call
    res = client.post("/api/device/call", json={"method": "status"})
    assert res.status_code in (404, 405)


# ---------------------------------------------------------------------------
# recipes still import shared public contract (behavior preserved)
# ---------------------------------------------------------------------------


def test_recipes_module_uses_shared_public_contract() -> None:
    recipes_src = (BACKEND_DIR / "routes" / "recipes.py").read_text(encoding="utf-8")
    assert "from public_contract import" in recipes_src
    assert "SafeValidationRoute" in recipes_src
    assert "reject_browser_unsafe_payload" in recipes_src
    # Local duplicates removed.
    assert "class SafeValidationRoute" not in recipes_src
    assert "def reject_browser_unsafe_payload" not in recipes_src
