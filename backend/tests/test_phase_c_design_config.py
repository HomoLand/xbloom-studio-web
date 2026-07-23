"""Focused tests for GET /api/design/config (Phase C frontend disclosure).

Read-only, no provider network, no BLE. Run from backend/:

    python -m pytest tests/test_phase_c_design_config.py -q
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from design.config import DesignConfig
from design.routes import set_design_service
from design.service import DesignService


class _NoopProvider:
    name = "noop"
    supports_vision = True

    async def complete(self, request: Any) -> Any:  # pragma: no cover
        raise AssertionError("design config must not call the provider")


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(state))
    # Ensure design env does not force eager init with broken knowledge.
    monkeypatch.delenv("XBLOOM_KNOWLEDGE_DIR", raising=False)
    monkeypatch.delenv("XBLOOM_KNOWLEDGE_DEV_ROOT", raising=False)
    monkeypatch.delenv("XBLOOM_LLM_BASE_URL", raising=False)

    with patch(
        "main.ensure_bridge_daemon",
        return_value={"status": "ok", "client_ready": True},
    ):
        from main import app

        set_design_service(None)
        with TestClient(app) as tc:
            yield tc
        set_design_service(None)


def test_design_config_route_registered(client: TestClient) -> None:
    paths = {getattr(r, "path", None) for r in client.app.routes}
    assert "/api/design/config" in paths


def _resolve_schema_ref(components: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Resolve a local OpenAPI $ref (or return the schema itself)."""

    if "$ref" not in schema:
        return schema
    ref = schema["$ref"]
    assert isinstance(ref, str) and ref.startswith("#/components/schemas/")
    name = ref.rsplit("/", 1)[-1]
    assert name in components, f"missing component schema: {name}"
    return components[name]


def test_design_config_openapi_response_schema(client: TestClient) -> None:
    """OpenAPI must document DesignConfigResponse with closed nested models."""

    schema = client.app.openapi()
    components = schema.get("components", {}).get("schemas", {})
    path = schema["paths"]["/api/design/config"]["get"]
    success = path["responses"]["200"]
    content = success["content"]["application/json"]["schema"]

    # Prefer the exact DesignConfigResponse component when present.
    if "DesignConfigResponse" in components:
        model = components["DesignConfigResponse"]
    else:
        model = _resolve_schema_ref(components, content)

    assert model.get("type") == "object" or "properties" in model
    props = model.get("properties") or {}
    for key in ("provider", "model", "design_mode", "image_data_fate"):
        assert key in props, f"DesignConfigResponse missing property: {key}"
    required = set(model.get("required") or [])
    assert {
        "provider",
        "model",
        "design_mode",
        "image_data_fate",
    }.issubset(required)
    # Structurally closed public shape.
    assert model.get("additionalProperties") is False

    fate_schema = _resolve_schema_ref(components, props["image_data_fate"])
    fate_props = fate_schema.get("properties") or {}
    for key in ("original_image_stored", "when_image_attached", "summary"):
        assert key in fate_props, f"DesignImageDataFate missing property: {key}"
    fate_required = set(fate_schema.get("required") or [])
    assert {
        "original_image_stored",
        "when_image_attached",
        "summary",
    }.issubset(fate_required)
    assert fate_schema.get("additionalProperties") is False

    when_schema = _resolve_schema_ref(components, fate_props["when_image_attached"])
    when_props = when_schema.get("properties") or {}
    for key in ("image_bytes_leave_machine", "ocr_text_leave_machine"):
        assert key in when_props, f"DesignImageWhenAttached missing property: {key}"
    when_required = set(when_schema.get("required") or [])
    assert {
        "image_bytes_leave_machine",
        "ocr_text_leave_machine",
    }.issubset(when_required)
    assert when_schema.get("additionalProperties") is False


def test_design_config_from_env_defaults(client: TestClient) -> None:
    """Without an injected service, config loads from env defaults (no network)."""

    resp = client.get("/api/design/config")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body.keys()) == {"provider", "model", "design_mode", "image_data_fate"}
    assert body["provider"]
    assert body["model"]
    assert body["design_mode"] in {"vision", "text"}
    fate = body["image_data_fate"]
    assert set(fate.keys()) == {
        "original_image_stored",
        "when_image_attached",
        "summary",
    }
    assert fate["original_image_stored"] is False
    when = fate["when_image_attached"]
    assert set(when.keys()) == {
        "image_bytes_leave_machine",
        "ocr_text_leave_machine",
    }
    assert isinstance(when["image_bytes_leave_machine"], bool)
    assert isinstance(when["ocr_text_leave_machine"], bool)
    assert isinstance(fate["summary"], str) and fate["summary"]
    # No secrets / paths / api key fields in response.
    blob = resp.text.lower()
    assert "api_key" not in blob
    assert "authorization" not in blob
    assert "c:\\\\" not in blob
    assert "/home/" not in blob
    assert "secret" not in blob
    # Exact public shape only - no extra nested implementation fields.
    assert "base_url" not in body
    assert "knowledge_dir" not in body


def test_design_config_vision_image_fate(
    client: TestClient, tmp_path: Path
) -> None:
    cfg = DesignConfig(
        provider="openai-compatible",
        base_url="http://example.invalid/v1",
        model="test-vision-model",
        api_key="secret-key-must-not-leak",
        design_mode="vision",
        knowledge_dir=str(tmp_path / "missing"),
    )
    service = DesignService(cfg, provider=_NoopProvider())  # type: ignore[arg-type]
    set_design_service(service)
    try:
        resp = client.get("/api/design/config")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["provider"] == "openai-compatible"
        assert body["model"] == "test-vision-model"
        assert body["design_mode"] == "vision"
        when = body["image_data_fate"]["when_image_attached"]
        assert when["image_bytes_leave_machine"] is True
        assert when["ocr_text_leave_machine"] is False
        assert body["image_data_fate"]["original_image_stored"] is False
        assert "secret-key" not in resp.text
    finally:
        set_design_service(None)


def test_design_config_text_image_fate(
    client: TestClient, tmp_path: Path
) -> None:
    cfg = DesignConfig(
        provider="openai-compatible",
        base_url="http://example.invalid/v1",
        model="test-text-model",
        api_key="another-secret",
        design_mode="text",
        knowledge_dir=str(tmp_path / "missing"),
    )
    service = DesignService(cfg, provider=_NoopProvider())  # type: ignore[arg-type]
    set_design_service(service)
    try:
        resp = client.get("/api/design/config")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["design_mode"] == "text"
        assert body["model"] == "test-text-model"
        when = body["image_data_fate"]["when_image_attached"]
        assert when["image_bytes_leave_machine"] is False
        assert when["ocr_text_leave_machine"] is True
        assert body["image_data_fate"]["original_image_stored"] is False
        assert "another-secret" not in resp.text
    finally:
        set_design_service(None)


def test_design_config_is_get_only_no_mutation(client: TestClient) -> None:
    """Config endpoint must not accept body mutations via POST."""

    resp = client.post("/api/design/config", json={"provider": "x"})
    # Either 405 method not allowed or 404 if not registered for POST.
    assert resp.status_code in {404, 405, 422}
