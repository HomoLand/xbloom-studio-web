"""Phase C1 backend network/auth security tests.

No BLE/bridge side effects. Uses injected clocks, temp state dirs, and
create_app factories so global main.app / env cannot leak across cases.

Run from backend/:

    python -m pytest tests/test_phase_c1_security.py -q
"""

from __future__ import annotations

import ipaddress
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient as _BaseTestClient

from web_security.config import (
    LOOPBACK_DEV_ORIGINS,
    WebSecurityConfig,
    load_web_security_config,
    loopback_origins_for_bind_port,
    parse_public_origin,
    parse_trusted_proxies,
)
from web_security.store import AuthStore

BACKEND_DIR = Path(__file__).resolve().parent.parent

PUBLIC_ORIGIN = "https://studio.local.test"
TRUSTED_PROXY = "10.0.0.2"
CLIENT_IP = "192.168.1.50"


class _PeerOverrideApp:
    """Inject a socket peer for Starlette versions before TestClient(client=)."""

    def __init__(self, app: Any, peer: tuple[str, int]) -> None:
        self.app = app
        self.peer = peer

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") in {"http", "websocket"}:
            scope = dict(scope)
            scope["client"] = self.peer
        await self.app(scope, receive, send)


class TestClient(_BaseTestClient):
    """Compatibility client with deterministic ASGI peer injection."""

    def __init__(self, app: Any, *, client: tuple[str, int] | None = None, **kwargs):
        wrapped = _PeerOverrideApp(app, client) if client is not None else app
        super().__init__(wrapped, **kwargs)


class FakeClock:
    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.t = float(start)

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += float(seconds)


def _lan_config(**overrides: Any) -> WebSecurityConfig:
    base = dict(
        mode="lan",
        public_origin=PUBLIC_ORIGIN,
        trusted_proxies=parse_trusted_proxies(f"{TRUSTED_PROXY}/32,127.0.0.1/32"),
        session_ttl_s=3600,
        pairing_ttl_s=300,
        pairing_rate_limit_max=5,
        pairing_rate_limit_window_s=600,
        bind_host="127.0.0.1",
        bind_port=8000,
    )
    base.update(overrides)
    return WebSecurityConfig(**base)


def _loopback_config(**overrides: Any) -> WebSecurityConfig:
    base = dict(mode="loopback")
    base.update(overrides)
    return WebSecurityConfig(**base)


def _make_app(
    *,
    config: WebSecurityConfig,
    store: AuthStore,
    monkeypatch: pytest.MonkeyPatch,
):
    import main as main_mod

    async def _noop():
        return None

    monkeypatch.setattr(main_mod, "_ensure_bridge_daemon", _noop)
    return main_mod.create_app(
        web_config=config,
        auth_store=store,
        lifespan_handler=_empty_lifespan(),
    )


def _empty_lifespan():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(_app):
        yield

    return lifespan


@contextmanager
def lan_client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    clock: FakeClock | None = None,
    config: WebSecurityConfig | None = None,
    peer: tuple[str, int] = (TRUSTED_PROXY, 443),
) -> Iterator[tuple[TestClient, AuthStore, FakeClock, WebSecurityConfig]]:
    clk = clock or FakeClock()
    cfg = config or _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=clk)
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)
    # HTTPS base so Secure cookies are accepted by the test client.
    with TestClient(
        app,
        base_url="https://testserver",
        client=peer,
        raise_server_exceptions=True,
    ) as client:
        yield client, store, clk, cfg


@contextmanager
def loopback_client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    peer: tuple[str, int] = ("testclient", 50000),
    config: WebSecurityConfig | None = None,
) -> Iterator[tuple[TestClient, AuthStore, WebSecurityConfig]]:
    cfg = config or _loopback_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)
    with TestClient(app, client=peer) as client:
        yield client, store, cfg


def _proxy_headers(
    *,
    client_ip: str = CLIENT_IP,
    origin: str | None = PUBLIC_ORIGIN,
    host: str = "studio.local.test",
    proto: str = "https",
) -> dict[str, str]:
    headers = {
        "X-Forwarded-For": client_ip,
        "X-Forwarded-Proto": proto,
        "X-Forwarded-Host": host,
    }
    if origin is not None:
        headers["Origin"] = origin
    return headers


def _bootstrap_pair(
    client_factory_app,
    store: AuthStore,
    cfg: WebSecurityConfig,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> tuple[str, str, str]:
    """Return (session_cookie, csrf_cookie, session_id) after loopback pair create + proxy exchange."""

    # Loopback bootstrap client on same store/config/app instance.
    app = client_factory_app
    with TestClient(
        app,
        base_url="https://testserver",
        client=("127.0.0.1", 9),
    ) as local:
        created = local.post("/api/auth/pairing/new", json={})
        assert created.status_code == 200, created.text
        token = created.json()["token"]
        assert created.json()["pairing_url"].startswith(PUBLIC_ORIGIN)

    with TestClient(
        app,
        base_url="https://testserver",
        client=(TRUSTED_PROXY, 443),
    ) as remote:
        res = remote.post(
            "/api/auth/pair",
            json={"token": token, "client_label": "phone"},
            headers=_proxy_headers(),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        session_id = body["session_id"]
        # Cookies set on response
        session_cookie = res.cookies.get(cfg.session_cookie_name)
        csrf_cookie = res.cookies.get(cfg.csrf_cookie_name)
        assert session_cookie
        assert csrf_cookie
        return session_cookie, csrf_cookie, session_id


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def test_config_default_is_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XBLOOM_WEB_MODE", raising=False)
    monkeypatch.delenv("XBLOOM_PUBLIC_ORIGIN", raising=False)
    monkeypatch.delenv("XBLOOM_TRUSTED_PROXIES", raising=False)
    cfg = load_web_security_config(environ={})
    assert cfg.mode == "loopback"
    assert cfg.public_origin is None
    assert cfg.bind_host == "127.0.0.1"
    assert "*" not in cfg.cors_origins
    assert set(LOOPBACK_DEV_ORIGINS).issubset(set(cfg.cors_origins)) or cfg.cors_origins == list(
        LOOPBACK_DEV_ORIGINS
    )


def test_config_rejects_invalid_mode() -> None:
    with pytest.raises(ValueError, match="XBLOOM_WEB_MODE"):
        load_web_security_config(environ={"XBLOOM_WEB_MODE": "public"})


def test_config_lan_requires_origin_and_proxies() -> None:
    with pytest.raises(ValueError, match="XBLOOM_PUBLIC_ORIGIN"):
        load_web_security_config(environ={"XBLOOM_WEB_MODE": "lan"})
    with pytest.raises(ValueError, match="XBLOOM_TRUSTED_PROXIES"):
        load_web_security_config(
            environ={
                "XBLOOM_WEB_MODE": "lan",
                "XBLOOM_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
            }
        )


@pytest.mark.parametrize(
    "origin",
    [
        "http://studio.local.test",  # not https
        "https://studio.local.test/path",
        "https://studio.local.test?x=1",
        "https://studio.local.test#frag",
        "https://user:pass@studio.local.test",
        "https://*.local.test",
        "https://localhost",
        "https://127.0.0.1",
        "",
    ],
)
def test_config_rejects_bad_public_origin(origin: str) -> None:
    with pytest.raises(ValueError):
        parse_public_origin(origin)


def test_config_accepts_exact_https_origin() -> None:
    assert parse_public_origin("https://Studio.Local.Test") == "https://studio.local.test"
    assert (
        parse_public_origin("https://studio.local.test:8443")
        == "https://studio.local.test:8443"
    )


def test_config_rejects_wildcard_proxies_and_ttl_bounds() -> None:
    with pytest.raises(ValueError):
        parse_trusted_proxies("*")
    with pytest.raises(ValueError):
        parse_trusted_proxies("")
    with pytest.raises(ValueError):
        parse_trusted_proxies("0.0.0.0/0")
    with pytest.raises(ValueError):
        parse_trusted_proxies("8.8.8.8/32")
    with pytest.raises(ValueError, match="XBLOOM_SESSION_TTL_S"):
        load_web_security_config(
            environ={
                "XBLOOM_WEB_MODE": "loopback",
                "XBLOOM_SESSION_TTL_S": "5",
            }
        )
    with pytest.raises(ValueError, match="XBLOOM_PAIRING_TTL_S"):
        load_web_security_config(
            environ={
                "XBLOOM_WEB_MODE": "loopback",
                "XBLOOM_PAIRING_TTL_S": "5",
            }
        )


def test_config_lan_happy() -> None:
    cfg = load_web_security_config(
        environ={
            "XBLOOM_WEB_MODE": "lan",
            "XBLOOM_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
            "XBLOOM_TRUSTED_PROXIES": "10.0.0.2/32, 127.0.0.1",
            "XBLOOM_SESSION_TTL_S": "7200",
            "XBLOOM_PAIRING_TTL_S": "120",
        }
    )
    assert cfg.is_lan
    assert cfg.public_origin == PUBLIC_ORIGIN
    assert cfg.cors_origins == [PUBLIC_ORIGIN]
    assert cfg.cors_allow_credentials is True
    assert cfg.cookie_secure is True
    assert cfg.session_ttl_s == 7200
    assert any(
        ipaddress.ip_address("10.0.0.2") in net for net in cfg.trusted_proxies
    )


def test_loopback_bind_port_origins_exact_accept_and_reject() -> None:
    """Configured bind_port is merged into exact loopback origins; other ports stay out."""

    cfg = load_web_security_config(environ={"XBLOOM_BIND_PORT": "8010"})
    assert cfg.bind_port == 8010
    assert "*" not in cfg.cors_origins
    assert "http://localhost:8010" in cfg.cors_origins
    assert "http://127.0.0.1:8010" in cfg.cors_origins
    assert "http://localhost:8011" not in cfg.cors_origins
    assert "http://127.0.0.1:8011" not in cfg.cors_origins
    # Fixed dev origins remain; no arbitrary-port expansion.
    assert set(LOOPBACK_DEV_ORIGINS).issubset(set(cfg.cors_origins))
    assert cfg.cors_origins == list(loopback_origins_for_bind_port(8010))

    assert cfg.allowed_origin("http://localhost:8010", peer_host="127.0.0.1") is True
    assert cfg.allowed_origin("http://127.0.0.1:8010", peer_host="127.0.0.1") is True
    assert cfg.allowed_origin("http://localhost:8011", peer_host="127.0.0.1") is False
    assert cfg.allowed_origin("http://127.0.0.1:8011", peer_host="127.0.0.1") is False
    assert cfg.allowed_origin("http://192.168.1.1:8010", peer_host="127.0.0.1") is False


def test_loopback_bind_port_default_unchanged() -> None:
    cfg = load_web_security_config(environ={})
    assert cfg.bind_port == 8000
    assert cfg.cors_origins == list(loopback_origins_for_bind_port(8000))
    # Deduped: default port already in LOOPBACK_DEV_ORIGINS.
    assert cfg.cors_origins.count("http://127.0.0.1:8000") == 1


def test_lan_bind_port_loopback_bootstrap_only_public_cors() -> None:
    """LAN public CORS stays [public_origin]; local bootstrap may use bind-port loopback origins."""

    cfg = load_web_security_config(
        environ={
            "XBLOOM_WEB_MODE": "lan",
            "XBLOOM_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
            "XBLOOM_TRUSTED_PROXIES": "10.0.0.2/32",
            "XBLOOM_BIND_PORT": "8010",
        }
    )
    assert cfg.cors_origins == [PUBLIC_ORIGIN]
    assert "*" not in cfg.cors_origins
    assert "http://127.0.0.1:8010" in cfg.loopback_origins
    # Direct local bootstrap peer may use exact loopback bind-port origin.
    assert cfg.allowed_origin("http://127.0.0.1:8010", peer_host="127.0.0.1") is True
    assert cfg.allowed_origin("http://localhost:8010", peer_host="127.0.0.1") is True
    assert cfg.allowed_origin("http://127.0.0.1:8011", peer_host="127.0.0.1") is False
    # Proxied / non-bootstrap peer: only exact HTTPS public origin.
    assert cfg.allowed_origin("http://127.0.0.1:8010", peer_host="10.0.0.2") is False
    assert cfg.allowed_origin(PUBLIC_ORIGIN, peer_host="10.0.0.2") is True
    assert cfg.allowed_origin("https://evil.example", peer_host="10.0.0.2") is False


def test_static_asset_accepts_configured_bind_port_origin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Browser-like SPA asset requests (Vite crossorigin Origin) must not 403."""

    cfg = _loopback_config(bind_port=8010)
    frontend_dist = BACKEND_DIR.parent / "frontend" / "dist"
    assets_dir = frontend_dist / "assets"
    asset_name = None
    if assets_dir.is_dir():
        for candidate in assets_dir.iterdir():
            if candidate.suffix in {".js", ".css"} and candidate.is_file():
                asset_name = candidate.name
                break

    with loopback_client(monkeypatch, tmp_path, config=cfg) as (client, _, resolved):
        assert "http://127.0.0.1:8010" in resolved.cors_origins
        origin_ok = "http://127.0.0.1:8010"
        origin_bad = "http://127.0.0.1:8011"

        health = client.get("/api/health", headers={"Origin": origin_ok})
        assert health.status_code == 200

        denied = client.get("/api/health", headers={"Origin": origin_bad})
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "origin_denied"

        # Same-origin static surface (index + built asset when present).
        index_res = client.get("/", headers={"Origin": origin_ok})
        assert index_res.status_code != 403
        if index_res.headers.get("content-type", "").startswith("application/json"):
            body = index_res.json()
            assert body.get("error", {}).get("code") != "origin_denied"

        if asset_name is not None:
            asset_res = client.get(
                f"/assets/{asset_name}",
                headers={"Origin": origin_ok},
            )
            assert asset_res.status_code == 200, asset_res.text
            assert asset_res.status_code != 403

            asset_denied = client.get(
                f"/assets/{asset_name}",
                headers={"Origin": origin_bad},
            )
            assert asset_denied.status_code == 403
            assert asset_denied.json()["error"]["code"] == "origin_denied"


def test_loopback_origins_helper_no_wildcard() -> None:
    origins = loopback_origins_for_bind_port(8010)
    assert "*" not in origins
    assert "http://localhost:8010" in origins
    assert "http://127.0.0.1:8010" in origins
    # Only exact listed + bind_port; never a port range or scheme wildcard.
    for origin in origins:
        assert origin.startswith("http://")
        assert "*" not in origin


# ---------------------------------------------------------------------------
# Loopback network boundary
# ---------------------------------------------------------------------------


def test_loopback_accepts_testclient_and_local(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with loopback_client(monkeypatch, tmp_path, peer=("testclient", 50000)) as (
        client,
        _store,
        cfg,
    ):
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/auth/config").json()["mode"] == "loopback"
        assert client.get("/api/auth/config").json()["pairing_required"] is False
        # Protected API usable without pairing in loopback.
        res = client.get("/api/device/bridge")
        assert res.status_code != 401
        assert res.status_code != 403 or "network" not in res.text


def test_loopback_accepts_127(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with loopback_client(monkeypatch, tmp_path, peer=("127.0.0.1", 9)) as (client, _, _):
        assert client.get("/api/health").status_code == 200


def test_loopback_denies_nonlocal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with loopback_client(monkeypatch, tmp_path, peer=("192.168.1.9", 9)) as (
        client,
        _,
        _,
    ):
        res = client.get("/api/health")
        assert res.status_code == 403
        body = res.json()
        assert body["error"]["category"] == "network"
        assert body["error"]["code"] == "network_denied"


def test_loopback_denies_nonlocal_cors_preflight(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with loopback_client(monkeypatch, tmp_path, peer=("192.168.1.9", 9)) as (
        client,
        _,
        _,
    ):
        res = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "network_denied"


# ---------------------------------------------------------------------------
# LAN proxy / forwarded headers
# ---------------------------------------------------------------------------


def test_lan_rejects_untrusted_peer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with lan_client(
        monkeypatch, tmp_path, peer=("203.0.113.9", 443)
    ) as (client, _, _, _):
        res = client.get("/api/health", headers=_proxy_headers())
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "network_denied"


def test_lan_rejects_untrusted_forwarded_headers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """X-Forwarded-* from a non-proxy peer must not grant access."""

    with lan_client(
        monkeypatch, tmp_path, peer=("203.0.113.9", 443)
    ) as (client, _, _, _):
        res = client.get(
            "/api/auth/config",
            headers=_proxy_headers(),
        )
        assert res.status_code == 403


def test_lan_requires_https_and_exact_host(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with lan_client(monkeypatch, tmp_path) as (client, _, _, _):
        bad_proto = client.get(
            "/api/health",
            headers=_proxy_headers(proto="http"),
        )
        assert bad_proto.status_code == 403

        bad_host = client.get(
            "/api/health",
            headers=_proxy_headers(host="evil.example"),
        )
        assert bad_host.status_code == 403

        ok = client.get("/api/health", headers=_proxy_headers())
        assert ok.status_code == 200


def test_lan_rejects_mismatched_origin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with lan_client(monkeypatch, tmp_path) as (client, _, _, _):
        res = client.get(
            "/api/health",
            headers=_proxy_headers(origin="https://evil.example"),
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "origin_denied"


def test_lan_protected_unauthenticated_denied(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with lan_client(monkeypatch, tmp_path) as (client, _, _, _):
        res = client.get("/api/device/bridge", headers=_proxy_headers())
        assert res.status_code == 401
        assert res.json()["error"]["category"] == "authentication"


def test_loopback_proxy_peer_is_not_remote_bootstrap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A local reverse proxy must not turn every remote user into localhost."""

    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)

    with TestClient(
        app, base_url="https://testserver", client=("127.0.0.1", 443)
    ) as proxied:
        res = proxied.post(
            "/api/auth/pairing/new",
            json={},
            headers=_proxy_headers(),
        )
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "auth_required"


# ---------------------------------------------------------------------------
# Pairing + sessions
# ---------------------------------------------------------------------------


def test_pairing_bootstrap_atomic_one_time_and_cookies(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)

    with TestClient(app, base_url="https://testserver", client=("127.0.0.1", 9)) as local:
        created = local.post("/api/auth/pairing/new", json={"client_label": "qr"})
        assert created.status_code == 200
        data = created.json()
        token = data["token"]
        assert data["pairing_id"].startswith("pair_")
        assert data["pairing_url"] == f"{PUBLIC_ORIGIN}/pair#token={token}"
        # Secrets must not appear in logs via response keys beyond intentional payload.
        assert "token_hash" not in data

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as remote:
        first = remote.post(
            "/api/auth/pair",
            json={"token": token, "client_label": "phone"},
            headers=_proxy_headers(),
        )
        assert first.status_code == 200, first.text
        assert first.json()["session_id"].startswith("sess_")
        assert first.headers["cache-control"] == "no-store"
        assert first.headers["referrer-policy"] == "no-referrer"
        assert "max-age=31536000" in first.headers["strict-transport-security"]

        # Cookie attributes
        set_cookies = first.headers.get_list("set-cookie")
        joined = "\n".join(set_cookies)
        joined_l = joined.lower()
        assert "httponly" in joined_l
        assert "secure" in joined_l
        assert "samesite=strict" in joined_l
        # Session cookie HttpOnly; CSRF cookie not HttpOnly.
        sess_line = next(
            c for c in set_cookies if c.lower().startswith(f"{cfg.session_cookie_name}=")
        )
        csrf_line = next(
            c for c in set_cookies if c.lower().startswith(f"{cfg.csrf_cookie_name}=")
        )
        assert "httponly" in sess_line.lower()
        assert "httponly" not in csrf_line.lower()

        session_cookie = first.cookies.get(cfg.session_cookie_name)
        csrf_cookie = first.cookies.get(cfg.csrf_cookie_name)
        assert session_cookie and csrf_cookie

        # Reuse rejected
        reuse = remote.post(
            "/api/auth/pair",
            json={"token": token},
            headers=_proxy_headers(),
        )
        assert reuse.status_code == 401
        assert reuse.json()["error"]["code"] == "pairing_invalid"

        # Authenticated GET works
        authed = remote.get(
            "/api/auth/session",
            headers=_proxy_headers(),
            cookies={
                cfg.session_cookie_name: session_cookie,
                cfg.csrf_cookie_name: csrf_cookie,
            },
        )
        assert authed.status_code == 200
        assert authed.json()["authenticated"] is True

    persisted = b"".join(
        path.read_bytes()
        for path in tmp_path.glob("web_auth.sqlite3*")
        if path.is_file()
    )
    assert token.encode("utf-8") not in persisted
    assert session_cookie.encode("utf-8") not in persisted
    assert csrf_cookie.encode("utf-8") not in persisted


def test_pairing_consume_is_atomic_under_concurrency(tmp_path: Path) -> None:
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    pairing = store.create_pairing(
        ttl_s=300,
        public_origin=PUBLIC_ORIGIN,
    )

    def consume(index: int):
        return store.consume_pairing_and_create_session(
            pairing.token,
            session_ttl_s=3600,
            client_ip=f"192.168.1.{index + 10}",
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(consume, range(8)))

    assert sum(result is not None for result in results) == 1
    assert len(store.list_sessions()) == 1


def test_csrf_required_and_bound_to_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)
    session_cookie, csrf_cookie, session_id = _bootstrap_pair(
        app, store, cfg, monkeypatch, tmp_path
    )
    cookies = {
        cfg.session_cookie_name: session_cookie,
        cfg.csrf_cookie_name: csrf_cookie,
    }

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        # POST without CSRF header -> fail
        no_csrf = client.post(
            "/api/auth/sessions/" + session_id + "/revoke",
            headers=_proxy_headers(),
            cookies=cookies,
        )
        assert no_csrf.status_code == 403
        assert no_csrf.json()["error"]["code"] == "csrf_failed"

        # Wrong CSRF
        bad = client.post(
            "/api/auth/sessions/" + session_id + "/revoke",
            headers={**_proxy_headers(), "X-CSRF-Token": "not-the-token"},
            cookies=cookies,
        )
        assert bad.status_code == 403

        # Cookie alone is not enough for mutations (header required)
        # already covered by no_csrf

        # Valid CSRF
        # First list sessions (GET, no CSRF)
        listed = client.get(
            "/api/auth/sessions",
            headers=_proxy_headers(),
            cookies=cookies,
        )
        assert listed.status_code == 200
        ids = [s["session_id"] for s in listed.json()["sessions"]]
        assert session_id in ids

        # Create second session to revoke without logging ourselves out
        with TestClient(
            app, base_url="https://testserver", client=("127.0.0.1", 9)
        ) as local:
            t2 = local.post("/api/auth/pairing/new").json()["token"]
        with TestClient(
            app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
        ) as remote2:
            s2 = remote2.post(
                "/api/auth/pair",
                json={"token": t2, "client_label": "other"},
                headers=_proxy_headers(client_ip="192.168.1.60"),
            )
            other_id = s2.json()["session_id"]

        ok = client.post(
            f"/api/auth/sessions/{other_id}/revoke",
            headers={**_proxy_headers(), "X-CSRF-Token": csrf_cookie},
            cookies=cookies,
        )
        assert ok.status_code == 200
        assert ok.json()["revoked"] is True


def test_session_expiry_logout_list_revoke(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    clock = FakeClock()
    cfg = _lan_config(session_ttl_s=100, pairing_ttl_s=60)
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=clock)
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)
    session_cookie, csrf_cookie, session_id = _bootstrap_pair(
        app, store, cfg, monkeypatch, tmp_path
    )
    cookies = {
        cfg.session_cookie_name: session_cookie,
        cfg.csrf_cookie_name: csrf_cookie,
    }

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        assert (
            client.get(
                "/api/auth/session",
                headers=_proxy_headers(),
                cookies=cookies,
            ).status_code
            == 200
        )

        # Expire
        clock.advance(101)
        expired = client.get(
            "/api/auth/session",
            headers=_proxy_headers(),
            cookies=cookies,
        )
        assert expired.status_code == 401

    # Fresh session for logout / revoke
    clock.advance(1)
    session_cookie, csrf_cookie, session_id = _bootstrap_pair(
        app, store, cfg, monkeypatch, tmp_path
    )
    cookies = {
        cfg.session_cookie_name: session_cookie,
        cfg.csrf_cookie_name: csrf_cookie,
    }

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        # Create another session, list, revoke it, logout current
        with TestClient(
            app, base_url="https://testserver", client=("127.0.0.1", 9)
        ) as local:
            t2 = local.post("/api/auth/pairing/new").json()["token"]
        with TestClient(
            app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
        ) as remote2:
            other_id = remote2.post(
                "/api/auth/pair",
                json={"token": t2},
                headers=_proxy_headers(client_ip="192.168.1.70"),
            ).json()["session_id"]

        listed = client.get(
            "/api/auth/sessions",
            headers=_proxy_headers(),
            cookies=cookies,
        )
        assert listed.status_code == 200
        assert len(listed.json()["sessions"]) >= 2

        rev = client.post(
            f"/api/auth/sessions/{other_id}/revoke",
            headers={**_proxy_headers(), "X-CSRF-Token": csrf_cookie},
            cookies=cookies,
        )
        assert rev.status_code == 200

        out = client.post(
            "/api/auth/logout",
            headers={**_proxy_headers(), "X-CSRF-Token": csrf_cookie},
            cookies=cookies,
        )
        assert out.status_code == 200
        assert out.json()["logged_out"] is True

        after = client.get(
            "/api/auth/session",
            headers=_proxy_headers(),
            cookies=cookies,
        )
        assert after.status_code == 401


def test_pairing_rate_limit_durable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    clock = FakeClock()
    cfg = _lan_config(pairing_rate_limit_max=3, pairing_rate_limit_window_s=600)
    db = tmp_path / "web_auth.sqlite3"
    store = AuthStore(db_path=db, clock=clock)
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        for i in range(3):
            res = client.post(
                "/api/auth/pair",
                json={"token": "a" * 32},
                headers=_proxy_headers(),
            )
            assert res.status_code == 401
        limited = client.post(
            "/api/auth/pair",
            json={"token": "b" * 32},
            headers=_proxy_headers(),
        )
        assert limited.status_code == 429
        assert limited.json()["error"]["code"] == "pairing_rate_limited"

    # Restart store on same DB; limit still holds.
    store2 = AuthStore(db_path=db, clock=clock)
    app2 = _make_app(config=cfg, store=store2, monkeypatch=monkeypatch)
    with TestClient(
        app2, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client2:
        still = client2.post(
            "/api/auth/pair",
            json={"token": "c" * 32},
            headers=_proxy_headers(),
        )
        assert still.status_code == 429


def test_pairing_creation_from_authenticated_lan_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)
    session_cookie, csrf_cookie, _ = _bootstrap_pair(
        app, store, cfg, monkeypatch, tmp_path
    )
    cookies = {
        cfg.session_cookie_name: session_cookie,
        cfg.csrf_cookie_name: csrf_cookie,
    }

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        # Unauthenticated remote pairing/new denied
        denied = client.post(
            "/api/auth/pairing/new",
            headers=_proxy_headers(),
        )
        assert denied.status_code == 401

        ok = client.post(
            "/api/auth/pairing/new",
            json={},
            headers={**_proxy_headers(), "X-CSRF-Token": csrf_cookie},
            cookies=cookies,
        )
        assert ok.status_code == 200
        assert "token" in ok.json()


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


def test_exact_cors_loopback_no_wildcard(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with loopback_client(monkeypatch, tmp_path) as (client, _, cfg):
        origin = cfg.cors_origins[0]
        res = client.options(
            "/api/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )
        assert res.headers.get("access-control-allow-origin") == origin
        allow = res.headers.get("access-control-allow-origin", "")
        assert allow != "*"
        methods = res.headers.get("access-control-allow-methods", "")
        assert "*" not in methods


def test_exact_cors_lan_public_origin_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with lan_client(monkeypatch, tmp_path) as (client, _, _, cfg):
        res = client.options(
            "/api/health",
            headers={
                **_proxy_headers(),
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-csrf-token",
            },
        )
        assert res.headers.get("access-control-allow-origin") == PUBLIC_ORIGIN
        assert res.headers.get("access-control-allow-origin") != "*"
        assert res.headers.get("access-control-allow-credentials") == "true"
        methods = res.headers.get("access-control-allow-methods", "")
        assert "*" not in methods
        headers = res.headers.get("access-control-allow-headers", "")
        assert "*" not in headers

        # Disallowed origin: no ACAO reflection of evil origin.
        evil = client.options(
            "/api/health",
            headers={
                **_proxy_headers(origin="https://evil.example"),
                "Access-Control-Request-Method": "GET",
            },
        )
        assert evil.headers.get("access-control-allow-origin") not in {
            "*",
            "https://evil.example",
        }


# ---------------------------------------------------------------------------
# Auth never invokes bridge/BLE
# ---------------------------------------------------------------------------


def test_auth_paths_never_call_bridge(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import bridge_client as bc

    probe = MagicMock()
    status = MagicMock()
    monkeypatch.setattr(bc, "probe", probe)
    monkeypatch.setattr(bc, "status", status)
    # Also ensure import side: xbloom_ble.client should not be used by auth
    import main as main_mod

    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)

    with TestClient(
        app, base_url="https://testserver", client=("127.0.0.1", 9)
    ) as local:
        token = local.post("/api/auth/pairing/new").json()["token"]

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        client.get("/api/auth/config", headers=_proxy_headers())
        client.post(
            "/api/auth/pair",
            json={"token": token},
            headers=_proxy_headers(),
        )
        # session cookie from pair
        cookies = {
            cfg.session_cookie_name: client.cookies.get(cfg.session_cookie_name),
            cfg.csrf_cookie_name: client.cookies.get(cfg.csrf_cookie_name),
        }
        csrf = cookies[cfg.csrf_cookie_name]
        client.get("/api/auth/session", headers=_proxy_headers(), cookies=cookies)
        client.get("/api/auth/sessions", headers=_proxy_headers(), cookies=cookies)
        client.post(
            "/api/auth/logout",
            headers={**_proxy_headers(), "X-CSRF-Token": csrf or ""},
            cookies=cookies,
        )

    probe.assert_not_called()
    status.assert_not_called()


# ---------------------------------------------------------------------------
# Existing global app remains loopback-compatible for TestClient
# ---------------------------------------------------------------------------


def test_global_main_app_testclient_still_works(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Existing Phase A/B pattern: import main.app + TestClient peer testclient."""

    import main as main_mod

    monkeypatch.setenv("XBLOOM_STATE_DIR", str(tmp_path / "state"))
    # Do not force LAN mode; global app was built at import. Ensure loopback.
    # If import-time mode was loopback (default), TestClient must pass.

    async def _noop():
        return None

    monkeypatch.setattr(main_mod, "_ensure_bridge_daemon", _noop)

    # Rebuild app in loopback to avoid import-time env pollution from other tests.
    store = AuthStore(db_path=tmp_path / "g.sqlite3")
    app = main_mod.create_app(
        web_config=_loopback_config(),
        auth_store=store,
        lifespan_handler=_empty_lifespan(),
    )
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/auth/config").json()["mode"] == "loopback"


def test_errors_never_echo_secrets_or_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)
    secret = "SUPER_SECRET_PAIRING_TOKEN_VALUE_xx"
    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        res = client.post(
            "/api/auth/pair",
            json={"token": secret},
            headers=_proxy_headers(),
        )
        assert secret not in res.text
        assert str(tmp_path) not in res.text
        assert "web_auth.sqlite3" not in res.text

        oversized_secret = "PAIRING_SECRET_" + ("x" * 300)
        invalid = client.post(
            "/api/auth/pair",
            json={"token": oversized_secret},
            headers=_proxy_headers(),
        )
        assert invalid.status_code == 422
        assert oversized_secret not in invalid.text


def test_rightmost_xff_used_for_client_ip(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from web_security.middleware import rightmost_forwarded_client

    assert rightmost_forwarded_client("1.1.1.1, 2.2.2.2, 3.3.3.3") == "3.3.3.3"
    assert rightmost_forwarded_client("bad, 10.0.0.5") == "10.0.0.5"

    cfg = _lan_config()
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3", clock=FakeClock())
    app = _make_app(config=cfg, store=store, monkeypatch=monkeypatch)

    with TestClient(
        app, base_url="https://testserver", client=("127.0.0.1", 9)
    ) as local:
        token = local.post("/api/auth/pairing/new").json()["token"]

    with TestClient(
        app, base_url="https://testserver", client=(TRUSTED_PROXY, 443)
    ) as client:
        res = client.post(
            "/api/auth/pair",
            json={"token": token, "client_label": "xff"},
            headers={
                **_proxy_headers(),
                "X-Forwarded-For": "10.9.9.9, 192.168.1.50",
            },
        )
        assert res.status_code == 200
        session_id = res.json()["session_id"]
        row = store.get_session(session_id)
        assert row is not None
        assert row.client_ip == "192.168.1.50"
