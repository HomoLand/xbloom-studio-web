"""Shared pytest fixtures for backend tests.

Keeps host shell deployment env (LAN mode, public origin, LLM keys, knowledge
paths, etc.) from leaking into unit tests. Tests that need LAN or design must
set their own env / inject WebSecurityConfig via create_app(...).
"""

from __future__ import annotations

import pytest


# Env vars that pin a real workstation deployment and must not affect default tests.
_DEPLOY_ENV_CLEAR = (
    # Network / auth
    "XBLOOM_WEB_MODE",
    "XBLOOM_PUBLIC_ORIGIN",
    "XBLOOM_TRUSTED_PROXIES",
    "XBLOOM_WEB_ORIGINS",
    "XBLOOM_WEB_PUBLIC_ORIGIN",
    "XBLOOM_WEB_TRUSTED_PROXIES",
    "XBLOOM_BIND_HOST",
    "XBLOOM_BIND_PORT",
    "XBLOOM_FRONTEND_DIR",
    # Design / knowledge (eager lifespan init when any of these are set)
    "XBLOOM_LLM_BASE_URL",
    "XBLOOM_LLM_PROVIDER",
    "XBLOOM_LLM_MODEL",
    "XBLOOM_LLM_API_KEY",
    "XBLOOM_DESIGN_MODE",
    "XBLOOM_KNOWLEDGE_DIR",
    "XBLOOM_KNOWLEDGE_DEV_ROOT",
    "XBLOOM_ASSETS_DIR",
    "XBLOOM_REFERENCES_DIR",
)


@pytest.fixture(autouse=True)
def _isolate_web_deploy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force loopback + no design env for every test unless the test opts in.

    Prefer ``create_app(web_config=...)`` when a test needs explicit isolation
    from the module-level ``main.app`` object (import-time config snapshot).
    """

    for name in _DEPLOY_ENV_CLEAR:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("XBLOOM_WEB_MODE", "loopback")
