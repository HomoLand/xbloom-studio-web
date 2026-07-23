"""Phase C9: production app surface must not expose E2E control routes.

Proves ordinary ``main.create_app`` / ``main.app`` have no ``/__e2e__`` paths
and no ``app.state.e2e_runtime``. Intentionally does **not** import
``e2e.launcher`` (or any other e2e package module).
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

from web_security.config import WebSecurityConfig
from web_security.store import AuthStore


def _empty_lifespan():
    @asynccontextmanager
    async def lifespan(_app):
        yield

    return lifespan


def _route_paths(app: Any) -> set[str]:
    paths: set[str] = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        if isinstance(path, str):
            paths.add(path)
    return paths


def _assert_no_e2e_surface(app: Any, *, label: str) -> None:
    paths = _route_paths(app)
    e2e_paths = sorted(p for p in paths if "__e2e__" in p)
    assert e2e_paths == [], f"{label} must not mount /__e2e__ routes, got {e2e_paths}"
    assert not hasattr(app.state, "e2e_runtime"), (
        f"{label} must not set app.state.e2e_runtime"
    )


def test_production_main_app_and_create_app_have_no_e2e_surface(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Ordinary production factory / module app omit E2E-only control surface."""

    # Guard: this isolation check must not pull in the E2E launcher.
    assert "e2e.launcher" not in sys.modules

    import main as main_mod

    monkeypatch.setenv("XBLOOM_STATE_DIR", str(tmp_path / "state"))

    async def _noop():
        return None

    monkeypatch.setattr(main_mod, "_ensure_bridge_daemon", _noop)

    # Default module-level ASGI app used by uvicorn main:app / python -m serve.
    _assert_no_e2e_surface(main_mod.app, label="main.app")

    # Fresh factory instance (same path production tests use with injected deps).
    store = AuthStore(db_path=tmp_path / "web_auth.sqlite3")
    app = main_mod.create_app(
        web_config=WebSecurityConfig(mode="loopback"),
        auth_store=store,
        lifespan_handler=_empty_lifespan(),
    )
    _assert_no_e2e_surface(app, label="main.create_app(...)")

    # Still never imported the launcher while asserting production isolation.
    assert "e2e.launcher" not in sys.modules
