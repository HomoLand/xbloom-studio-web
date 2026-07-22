"""Bridge RPC adapter for bridge-backed operations in the xBloom Web backend.

Thin wrapper over the existing loopback JSON-line bridge daemon. This module
only covers bridge-backed RPCs; it does not own BLE itself. Passive scan and
one-shot direct probe live outside this module in Phase 0.6. Race-safe typed
RPC convergence is a Phase A/A9 target.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from xbloom_ble.bridge import (
    BridgeError,
    bridge_call,
    bridge_is_running,
    bridge_record_path,
)


def is_running() -> bool:
    return bridge_is_running()


def status() -> dict[str, Any]:
    return bridge_call("status")


def events(since: int = 0) -> dict[str, Any]:
    return bridge_call("events", {"since": since})


def call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return bridge_call(method, params)


def record_path() -> Path:
    return bridge_record_path()
