"""Phase 0.6 Web cutover tests.

No BLE hardware, no real bridge daemon. Uses a temp XBLOOM_STATE_DIR and
mocks core-owned ensure_bridge_daemon. Run from the backend directory with
PYTHONPATH pointed at a local reviewed core source tree, e.g.:

    $env:PYTHONPATH = "C:\\path\\to\\xbloom-studio-brew\\packages\\core"
    $env:XBLOOM_STATE_DIR = (New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory }).FullName
    python -m pytest tests/test_phase06_cutover.py -q
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Stable imports when pytest is run from backend/ (or repo root with backend on path).
BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    """Never touch the default user state directory."""
    state = tmp_path / "xbloom-state"
    state.mkdir()
    monkeypatch.setenv("XBLOOM_STATE_DIR", str(state))
    return state


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Source / packaging contract
# ---------------------------------------------------------------------------


def test_main_source_has_no_skill_script_walk():
    src = _read(BACKEND_DIR / "main.py")
    assert "_skill_cli_script" not in src
    assert "XBLOOM_SKILL_SCRIPT" not in src
    assert "start_bridge_daemon" not in src
    assert "ensure_bridge_daemon" in src
    assert "asyncio.to_thread" in src


def test_main_source_and_app_use_lifespan_not_on_event():
    """Phase 0.6 wiring: FastAPI lifespan, no deprecated @app.on_event."""
    src = _read(BACKEND_DIR / "main.py")
    assert "lifespan=lifespan" in src
    assert "@asynccontextmanager" in src
    assert "async def lifespan" in src
    assert "@app.on_event" not in src
    assert 'on_event("startup")' not in src
    assert 'on_event("shutdown")' not in src

    import main as main_mod

    # FastAPI may wrap the user lifespan in a merger; require a non-null context
    # and no deprecated on_event startup/shutdown handlers.
    assert main_mod.app.router.lifespan_context is not None
    assert callable(main_mod.app.router.lifespan_context)
    assert main_mod.app.router.on_startup == []
    assert main_mod.app.router.on_shutdown == []
    assert callable(main_mod.lifespan)


def test_mcp_source_uses_ensure_not_skill_script_hint():
    src = _read(BACKEND_DIR / "mcp_server.py")
    assert "ensure_bridge_daemon" in src
    assert "XBLOOM_SKILL_SCRIPT" not in src
    assert "xbloom.py bridge start" not in src
    assert "scripts/xbloom.py" not in src


def test_no_skill_script_bridge_start_in_user_facing_sources():
    """Standalone Web must not instruct users to run Skill scripts/xbloom.py.

    Scans README, backend (excluding tests), and frontend/src. Needles are
    assembled so this contract test file does not self-match.
    """
    script = "scripts/" + "xbloom.py"
    forbidden = (
        script + " bridge start",
        "python " + script,
    )
    scan_roots = [
        REPO_ROOT / "README.md",
        BACKEND_DIR,
        REPO_ROOT / "frontend" / "src",
    ]
    text_suffixes = {".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".txt", ".json"}
    skip_dir_names = {
        "__pycache__",
        "node_modules",
        ".venv",
        "dist",
        ".git",
        "tests",
    }
    offenders: list[str] = []

    def _scan_file(path: Path) -> None:
        if path.suffix.lower() not in text_suffixes and path.name != "README.md":
            return
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return
        for needle in forbidden:
            if needle in text:
                rel = path.relative_to(REPO_ROOT).as_posix()
                offenders.append(f"{rel}: contains {needle!r}")

    for root in scan_roots:
        if root.is_file():
            _scan_file(root)
            continue
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if skip_dir_names.intersection(path.parts):
                continue
            _scan_file(path)

    assert not offenders, "forbidden Skill-script instructions:\n" + "\n".join(offenders)


def test_module_docs_do_not_claim_backend_never_holds_ble():
    """Phase 0.6 still has passive scan + one-shot direct probe outside bridge_client.

    Needles are assembled so this contract test does not self-match.
    """
    forbidden = (
        "BLE ownership stays with" + " the existing bridge daemon",
        "never holds a BLE" + " connection of its own",
        "one-shot scan/probe paths refuse" + " to race it",
        "refuse to race" + " it",
    )
    for rel in ("main.py", "bridge_client.py"):
        src = _read(BACKEND_DIR / rel)
        for needle in forbidden:
            assert needle not in src, (
                f"{rel} must not claim {needle!r} "
                "(Phase 0.6 still has direct probe/scan outside bridge_client)"
            )


def test_requirements_pin_release_wheel_url_and_hash():
    req = _read(BACKEND_DIR / "requirements.txt")
    url = (
        "https://github.com/HomoLand/xbloom-studio-brew/releases/download/"
        "v1.2.0/xbloom_studio_core-1.2.0-py3-none-any.whl"
    )
    sha = "9a90c781e4a9bd756f60103ef4f51d1966b83ef5be466c5cf88e7d8264b5b918"
    assert url in req
    assert f"#sha256={sha}" in req
    assert "-e ../../" not in req
    assert "-r requirements-runtime.txt" in req


def test_requirements_dev_uses_editable_core_not_release_url():
    dev = _read(BACKEND_DIR / "requirements-dev.txt")
    assert "-e ../../xbloom-studio-brew/packages/core" in dev
    assert "releases/download/v1.2.0" not in dev
    assert "xbloom_studio_core-1.2.0" not in dev
    assert "pytest" in dev
    assert "-r requirements-runtime.txt" in dev


def test_requirements_runtime_every_package_line_is_exact_pin():
    """Every direct package line uses == (extras like uvicorn[standard] allowed)."""
    import re

    runtime = _read(BACKEND_DIR / "requirements-runtime.txt")
    assert "starlette==0.41.3" in runtime
    assert "fastapi==0.115.6" in runtime
    assert "mcp==1.28.1" in runtime

    runtime_pkgs = [
        line.strip()
        for line in runtime.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert runtime_pkgs, "requirements-runtime.txt must list packages"
    assert not any(
        "xbloom-studio-core" in line or "xbloom_studio_core" in line for line in runtime_pkgs
    )
    # name[extras]==version  or  name==version  (no ranges, no unpinned)
    exact_pin = re.compile(
        r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?==[A-Za-z0-9][A-Za-z0-9._+-]*$"
    )
    for line in runtime_pkgs:
        assert exact_pin.match(line), (
            f"requirements-runtime package line must be exact == pin, got: {line!r}"
        )


# ---------------------------------------------------------------------------
# Backend startup: ensure_bridge_daemon via asyncio.to_thread
# ---------------------------------------------------------------------------


def test_lifespan_startup_calls_helper_once_shutdown_does_not_stop_bridge():
    """lifespan awaits _ensure_bridge_daemon once; shutdown does not stop bridge."""
    import main as main_mod
    from unittest.mock import AsyncMock

    ensure_mock = AsyncMock()
    # If main ever gained a stop helper, lifespan must not call it on exit.
    stop_mock = MagicMock(name="stop_bridge_daemon")

    with patch.object(main_mod, "_ensure_bridge_daemon", ensure_mock):
        with patch.object(main_mod, "stop_bridge_daemon", stop_mock, create=True):

            async def _run() -> None:
                async with main_mod.lifespan(main_mod.app):
                    ensure_mock.assert_awaited_once_with()
                # After context exit (shutdown path): still exactly one ensure.
                ensure_mock.assert_awaited_once_with()

            asyncio.run(_run())

    ensure_mock.assert_awaited_once_with()
    stop_mock.assert_not_called()

    # Shutdown side of lifespan must not invoke ensure or stop the daemon.
    src = _read(BACKEND_DIR / "main.py")
    lifespan_body = src[src.index("async def lifespan") : src.index("\napp = FastAPI")]
    assert "await _ensure_bridge_daemon()" in lifespan_body
    before_yield, after_yield = lifespan_body.split("yield", 1)
    assert "await _ensure_bridge_daemon()" in before_yield
    assert "await " not in after_yield
    assert "stop_bridge" not in after_yield
    assert "ensure_bridge_daemon" not in after_yield


def test_startup_calls_ensure_exactly_once_without_script_arg(caplog):
    import main as main_mod

    ready = {
        "client_ready": True,
        "ensured": True,
        "started": True,
        "already_running": False,
        "upgrade_pending": False,
        "status": "running",
    }
    mock_ensure = MagicMock(return_value=ready)

    with patch.object(main_mod, "ensure_bridge_daemon", mock_ensure):
        with caplog.at_level(logging.INFO, logger=main_mod.logger.name):
            asyncio.run(main_mod._ensure_bridge_daemon())

    mock_ensure.assert_called_once_with()
    # No positional script path.
    args, kwargs = mock_ensure.call_args
    assert args == ()
    assert kwargs == {}
    assert any("bridge daemon ready" in r.message for r in caplog.records)


def test_startup_client_ready_logs_info(caplog):
    import main as main_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": True,
            "ensured": True,
            "already_running": True,
            "started": False,
            "upgrade_pending": False,
            "status": "running",
        }
    )
    with patch.object(main_mod, "ensure_bridge_daemon", mock_ensure):
        with caplog.at_level(logging.INFO, logger=main_mod.logger.name):
            asyncio.run(main_mod._ensure_bridge_daemon())
    assert any("ready" in r.message.lower() for r in caplog.records)
    assert not any(r.levelno >= logging.ERROR for r in caplog.records)


def test_startup_config_mismatch_client_ready_warns(caplog):
    import main as main_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": True,
            "ensured": True,
            "config_match": False,
            "idle_restart_recommended": True,
            "status": "config_mismatch_idle",
            "message": "running daemon config fingerprint differs",
            "upgrade_pending": False,
        }
    )
    with patch.object(main_mod, "ensure_bridge_daemon", mock_ensure):
        with caplog.at_level(logging.WARNING, logger=main_mod.logger.name):
            asyncio.run(main_mod._ensure_bridge_daemon())
    assert any("config mismatch" in r.message.lower() for r in caplog.records)
    assert not any(r.levelno >= logging.ERROR for r in caplog.records)


def test_startup_upgrade_pending_not_ready_warns(caplog):
    import main as main_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": False,
            "ensured": False,
            "upgrade_pending": True,
            "status": "upgrade_pending",
            "message": "legacy daemon busy; preserving active work",
        }
    )
    with patch.object(main_mod, "ensure_bridge_daemon", mock_ensure):
        with caplog.at_level(logging.WARNING, logger=main_mod.logger.name):
            asyncio.run(main_mod._ensure_bridge_daemon())
    assert any("not client-ready" in r.message for r in caplog.records)
    assert any("upgrade_pending" in r.message for r in caplog.records)


def test_startup_exception_logs_and_does_not_crash(caplog):
    import main as main_mod

    mock_ensure = MagicMock(side_effect=RuntimeError("spawn failed"))
    with patch.object(main_mod, "ensure_bridge_daemon", mock_ensure):
        with caplog.at_level(logging.ERROR, logger=main_mod.logger.name):
            # Must not raise — HTTP backend stays up.
            asyncio.run(main_mod._ensure_bridge_daemon())
    assert any("failed to ensure bridge daemon" in r.message for r in caplog.records)
    assert any(r.exc_info for r in caplog.records)


def test_startup_uses_asyncio_to_thread():
    """ensure_bridge_daemon is invoked via asyncio.to_thread, not inline."""
    import main as main_mod

    mock_ensure = MagicMock(
        return_value={"client_ready": True, "status": "running", "upgrade_pending": False}
    )
    recorded = []

    async def fake_to_thread(fn, /, *args, **kwargs):
        recorded.append((fn, args, kwargs))
        return fn(*args, **kwargs)

    with patch.object(main_mod, "ensure_bridge_daemon", mock_ensure):
        with patch.object(main_mod.asyncio, "to_thread", fake_to_thread):
            asyncio.run(main_mod._ensure_bridge_daemon())

    assert len(recorded) == 1
    fn, args, kwargs = recorded[0]
    assert fn is mock_ensure
    assert args == ()
    assert kwargs == {}
    mock_ensure.assert_called_once_with()


# ---------------------------------------------------------------------------
# MCP first-use ensure / reuse / not-ready
# ---------------------------------------------------------------------------


def test_mcp_require_bridge_ensures_and_returns_none_when_ready():
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": True,
            "ensured": True,
            "upgrade_pending": False,
            "status": "running",
        }
    )
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        err = mcp_mod._require_bridge()
    assert err is None
    mock_ensure.assert_called_once_with()


def test_mcp_require_bridge_reuses_same_ensure_per_call():
    """One tool call → one ensure; second tool call may ensure again (reuse path)."""
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": True,
            "ensured": True,
            "already_running": True,
            "upgrade_pending": False,
        }
    )
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        assert mcp_mod._require_bridge() is None
        assert mcp_mod._require_bridge() is None
    assert mock_ensure.call_count == 2
    for call in mock_ensure.call_args_list:
        assert call.args == ()
        assert call.kwargs == {}


def test_mcp_require_bridge_not_ready_returns_upgrade_pending():
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": False,
            "ensured": False,
            "upgrade_pending": True,
            "status": "upgrade_pending",
            "message": "busy legacy daemon; not force-stopping",
        }
    )
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        err = mcp_mod._require_bridge()
    assert err is not None
    assert err.get("client_ready") is False
    assert err.get("upgrade_pending") is True
    assert "busy" in err["error"] or "not client-ready" in err["error"]
    mock_ensure.assert_called_once_with()


def test_mcp_require_bridge_exception_returns_error():
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(side_effect=OSError("cannot spawn"))
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        err = mcp_mod._require_bridge()
    assert err is not None
    assert err.get("client_ready") is False
    assert "cannot spawn" in err["error"]


def test_mcp_status_tool_does_not_double_ensure():
    """xbloom_status calls _require_bridge once then bridge_call — one ensure total."""
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(
        return_value={"client_ready": True, "ensured": True, "upgrade_pending": False}
    )
    mock_call = MagicMock(return_value={"running": True, "activity": None})
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        with patch.object(mcp_mod, "bridge_call", mock_call):
            result = mcp_mod.xbloom_status()
    mock_ensure.assert_called_once_with()
    mock_call.assert_called_once_with("status")
    assert result.get("running") is True


def test_mcp_status_surfaces_not_ready_without_bridge_call():
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": False,
            "upgrade_pending": True,
            "status": "upgrade_pending",
            "message": "preserving active work",
        }
    )
    mock_call = MagicMock()
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        with patch.object(mcp_mod, "bridge_call", mock_call):
            result = mcp_mod.xbloom_status()
    mock_call.assert_not_called()
    assert result.get("upgrade_pending") is True
    assert result.get("client_ready") is False


def test_mcp_config_mismatch_client_ready_still_proceeds():
    import mcp_server as mcp_mod

    mock_ensure = MagicMock(
        return_value={
            "client_ready": True,
            "config_match": False,
            "status": "config_mismatch_idle",
            "idle_restart_recommended": True,
        }
    )
    mock_call = MagicMock(return_value={"running": True})
    with patch.object(mcp_mod, "ensure_bridge_daemon", mock_ensure):
        with patch.object(mcp_mod, "bridge_call", mock_call):
            result = mcp_mod.xbloom_status()
    mock_call.assert_called_once()
    assert result.get("running") is True
