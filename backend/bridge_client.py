"""Bridge RPC client for the xBloom Web backend.

Reuses the existing loopback JSON-line bridge daemon. The web backend never
holds a BLE connection of its own; when the bridge is running it is the sole
BLE owner, and one-shot scan/probe paths refuse to race it.
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
