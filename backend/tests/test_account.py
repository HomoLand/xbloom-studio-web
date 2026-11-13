"""Persistent host account boundaries; no live cloud or hardware calls."""

import os
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from routes import account
from main import create_app
from tests.test_phase_c1_security import lan_client, _proxy_headers


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(account, "_ephemeral_account_session", lambda **kwargs: (
        kwargs["region"], {
            "token": "private-bearer", "memberId": 42, "languageType": 1,
            "clientSecretStr": "private-client", "interfaceVersion": 19700101,
        },
    ))

    @asynccontextmanager
    async def lifespan(app):
        yield

    with TestClient(create_app(lifespan_handler=lifespan)) as result:
        yield result


def sign_in(client):
    response = client.post("/api/account/login", json={
        "email": "me@example.test", "password": "private-password", "region": "china",
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_saved_session_survives_new_client_without_password(client):
    saved = sign_in(client)
    disk = account._path().read_text(encoding="utf-8")
    assert "private-password" not in disk
    assert "private-bearer" in disk
    with TestClient(create_app(lifespan_handler=client.app.router.lifespan_context)) as reopened:
        restored = reopened.get("/api/account/status")
    assert restored.json() == saved
    assert restored.headers["Cache-Control"] == "no-store"
    for secret in ("private-bearer", "private-client", "private-password"):
        assert secret not in restored.text
    if os.name != "nt":
        assert account._path().stat().st_mode & 0o777 == 0o600
        assert account._path().parent.stat().st_mode & 0o777 == 0o700


def test_failed_login_and_validation_do_not_expose_or_replace_session(client, monkeypatch):
    saved = sign_in(client)
    def reject(**kwargs):
        raise account.CatalogError("provider echoed private-password private-bearer")
    monkeypatch.setattr(account, "_ephemeral_account_session", reject)
    response = client.post("/api/account/login", json={
        "email": "me@example.test", "password": "private-password", "region": "china",
    })
    assert response.status_code == 400
    assert "private-password" not in response.text
    response = client.post("/api/account/login", json={
        "email": "me@example.test", "password": "private-password", "region": "invalid",
    })
    assert response.status_code == 422
    assert "private-password" not in response.text
    assert client.get("/api/account/status").json() == saved


def test_proxy_uses_saved_identity_and_strips_response_secrets(client, monkeypatch):
    saved = sign_in(client)
    calls = []
    def send(**kwargs):
        calls.append(kwargs)
        return {"result": "success", "token": "private-bearer",
                "nested": {"clientSecretStr": "private-client"}, "list": [{"theName": "Coffee"}]}
    monkeypatch.setattr(account, "_cloud_request", send)
    response = client.post("/api/account/request", json={
        "endpoint": "tuRecipeAdd.tuhtml", "form": {
            **saved["session"], "memberId": 999, "creatorId": 999,
            "token": "attacker-token", "clientSecretStr": "attacker-client",
            "theName": "Coffee", "password": "private-password",
        },
    })
    assert response.status_code == 200, response.text
    assert len(calls) == 1
    assert calls[0]["base_url"] == account.BASE_URLS["china"]
    form = calls[0]["form"]
    assert form["memberId"] == form["creatorId"] == 42
    assert form["token"] == "private-bearer"
    assert form["clientSecretStr"] == "private-client"
    assert form["interfaceVersion"] == 20240918
    assert "password" not in form and "hostSession" not in form
    assert "private-" not in response.text
    assert response.json()["list"] == [{"theName": "Coffee"}]


def test_proxy_rejects_unknown_endpoints_stale_session_and_unowned_delete(client, monkeypatch):
    saved = sign_in(client)
    calls = []
    def send(**kwargs):
        calls.append(kwargs["endpoint"])
        return {"result": "success", "list": []}
    monkeypatch.setattr(account, "_cloud_request", send)
    for endpoint in ("tMemberLogin.thtml", "https://elsewhere.test/", "../admin"):
        assert client.post("/api/account/request", json={
            "endpoint": endpoint, "form": saved["session"],
        }).status_code == 422
    assert client.post("/api/account/request", json={
        "endpoint": "tuMyTeaRecipeCreated.tuhtml", "form": {"hostSession": "old"},
    }).status_code == 409
    assert calls == []
    assert client.post("/api/account/request", json={
        "endpoint": "tuRecipeDelete.tuhtml", "form": {**saved["session"], "tableId": 123},
    }).status_code == 403
    assert calls == [account.ENDPOINTS["created"]]
    assert client.post("/api/account/logout").status_code == 200
    assert not account._path().exists()
    assert client.get("/api/account/status").json() == {"configured": False}
    assert client.post("/api/account/request", json={
        "endpoint": "tuBrewRecordList.tuhtml", "form": saved["session"],
    }).status_code == 409


def test_cloud_failure_is_not_retried_or_returned_raw(client, monkeypatch):
    saved = sign_in(client)
    calls = []
    def send(**kwargs):
        calls.append(kwargs)
        return {"result": "fail", "info": "private-bearer"}
    monkeypatch.setattr(account, "_cloud_request", send)
    response = client.post("/api/account/request", json={
        "endpoint": "tuRecipeAdd.tuhtml", "form": saved["session"],
    })
    assert response.status_code == 409
    assert "private-bearer" not in response.text
    assert len(calls) == 1


def test_owned_delete_checks_current_account_before_dispatch(client, monkeypatch):
    saved = sign_in(client)
    calls = []
    def send(**kwargs):
        calls.append(kwargs)
        return {"result": "success", "list": [{
            "tableId": 123, "theName": "Owned coffee", "pourDataJSONStr": "[]", "cupType": 2,
        }]}
    monkeypatch.setattr(account, "_cloud_request", send)
    response = client.post("/api/account/request", json={
        "endpoint": "tuRecipeDelete.tuhtml", "form": {**saved["session"], "tableId": 123},
    })
    assert response.status_code == 200, response.text
    assert [call["endpoint"] for call in calls] == [account.ENDPOINTS["created"], "tuRecipeDelete.tuhtml"]
    assert calls[-1]["form"]["memberId"] == 42
    assert calls[-1]["form"]["tableId"] == 123


def test_lan_requires_pairing_and_csrf(monkeypatch, tmp_path):
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(tmp_path))
    with lan_client(monkeypatch, tmp_path) as (client, store, clock, config):
        headers = _proxy_headers()
        assert client.get("/api/account/status", headers=headers).status_code == 401
        assert client.post("/api/account/login", headers=headers, json={}).status_code == 401
        # A paired browser still cannot mutate the shared account without CSRF.
        pairing = store.create_pairing(public_origin=config.public_origin, ttl_s=300)
        response = client.post("/api/auth/pair", headers=headers, json={"token": pairing.token})
        assert response.status_code == 200
        assert client.get("/api/account/status", headers=headers).status_code == 200
        assert client.post("/api/account/logout", headers=headers).status_code == 403
