"""Service-managed deployments must never fork a second BLE owner."""

import asyncio
import importlib
from unittest.mock import Mock


def test_managed_bridge_never_spawns_on_startup_or_probe(monkeypatch):
    import bridge_client
    import main
    import xbloom_ble.bridge_client as core_client

    with monkeypatch.context() as patch:
        patch.setenv("XBLOOM_BRIDGE_MANAGED", "1")
        importlib.reload(bridge_client)
        spawn = Mock(side_effect=AssertionError("must not spawn a managed bridge"))
        patch.setattr(main, "ensure_bridge_daemon", spawn)
        patch.setattr(core_client, "ensure_bridge_daemon", spawn)
        rpc = Mock(return_value={"status": "probed"})
        patch.setattr(core_client, "bridge_call", rpc)
        try:
            asyncio.run(main._ensure_bridge_daemon())
            assert bridge_client.client.probe() == {"status": "probed"}
            assert rpc.call_args.args[0] == "probe"
            spawn.assert_not_called()
        finally:
            patch.delenv("XBLOOM_BRIDGE_MANAGED")
            importlib.reload(bridge_client)
