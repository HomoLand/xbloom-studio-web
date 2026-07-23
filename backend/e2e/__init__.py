"""Test-only E2E launcher package (Phase C9).

Import and run only from Playwright harnesses or explicit ``python -m e2e``
invocations. This package is **never** imported by production ``main:app`` /
``python -m serve``. Fake design provider, fake typed bridge, and control
ledger routes exist only when this package builds the ASGI app.
"""

from __future__ import annotations

__all__ = ["create_e2e_app", "E2ERuntime"]
