"""Deterministic fake typed bridge for Phase C9 Playwright E2E.

Models the public status/events/workflow contract used by Web routes without
starting a real bridge process, scanning BLE, or touching hardware.

Observation (status/events) never mutates connection or workflow state.
Mutations are ledgered for assertions. BLE is held across load->start->
telemetry and released promptly only after confirmed terminal/cancel/stop.
There is no five-minute loaded expiry.
"""

from __future__ import annotations

import copy
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


class FakeBridgeError(Exception):
    """Mirrors core BridgeError surface for HTTP mapping."""

    def __init__(self, message: str, *, category: str = "bridge_error") -> None:
        super().__init__(message)
        self.category = category


# Coffee start confirmation used by the browser.
COFFEE_START_CONFIRMATION = "cup-filter-water-beans"
TEA_START_CONFIRMATION = "tea-brewer-water-cup-clear"

TERMINAL_STATES = frozenset(
    {"completed", "complete", "cancelled", "canceled", "stopped", "failed", "error"}
)


@dataclass
class LedgerEntry:
    op: str
    at: float
    kwargs: dict[str, Any] = field(default_factory=dict)


class FakeBridge:
    """In-process fake of the typed Web bridge adapter surface."""

    def __init__(self, *, instance_id: str | None = None) -> None:
        self._lock = threading.RLock()
        self.instance_id = instance_id or f"brg_e2e_{uuid.uuid4().hex[:12]}"
        self.core_version = "1.2.0-e2e"
        self.config_fingerprint = "e2e-fake"
        self.started_at = time.time()
        self.running = True

        self.connected = False
        self.connection_scope: str | None = None
        self.machine_name: str | None = None
        self.firmware: str | None = None
        self.release_pending = False
        self.last_disconnect_reason: str | None = None
        self.last_disconnect_time: float | None = None
        self.last_disconnect_error: str | None = None

        self.activity: str | None = None
        self.phase: str | None = None
        self.machine_state: str | None = None
        self.active_workflow_id: str | None = None
        self.targets: dict[str, Any] = {}
        self.telemetry: dict[str, Any] = {}
        self.last_operation: dict[str, Any] | None = None
        self.last_error: str | None = None
        self._recovery_required = False
        self._recovery_detail: dict[str, Any] = {}

        # Durable workflows keyed by id (survives active clear for status summary).
        self._workflows: dict[str, dict[str, Any]] = {}
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._event_seq = 0
        self._connect_count = 0
        self._ledger: list[LedgerEntry] = []
        # Optional sticky prior disconnect fields for correlation tests.
        self._prior_disconnect_error: str | None = None
        self._prior_disconnect_time: float | None = None

    # ------------------------------------------------------------------
    # Ledger / control (test-only)
    # ------------------------------------------------------------------

    def ledger_snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {"op": e.op, "at": e.at, "kwargs": copy.deepcopy(e.kwargs)}
                for e in self._ledger
            ]

    def ledger_counts(self) -> dict[str, int]:
        with self._lock:
            counts: dict[str, int] = {}
            for e in self._ledger:
                counts[e.op] = counts.get(e.op, 0) + 1
            return counts

    def reset_ledger(self) -> None:
        with self._lock:
            self._ledger.clear()

    def _record(self, op: str, **kwargs: Any) -> None:
        self._ledger.append(LedgerEntry(op=op, at=time.time(), kwargs=dict(kwargs)))

    def control_set_phase(
        self,
        *,
        phase: str,
        telemetry: dict[str, Any] | None = None,
        machine_state: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self.active_workflow_id is None:
                raise FakeBridgeError(
                    "no active workflow to set phase", category="invalid_request"
                )
            self.phase = phase
            if machine_state is not None:
                self.machine_state = machine_state
            if telemetry:
                self.telemetry.update(telemetry)
            wf = self._workflows.get(self.active_workflow_id)
            if wf is not None:
                wf["machine_phase"] = phase
                wf["state"] = phase if phase not in TERMINAL_STATES else wf.get("state")
                wf["updated_at"] = _iso_now()
            self._append_event(
                self.active_workflow_id,
                event_type="phase",
                payload={"phase": phase, "telemetry": dict(self.telemetry)},
            )
            return self.status()

    def control_emit_telemetry(self, telemetry: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if self.active_workflow_id is None:
                raise FakeBridgeError(
                    "no active workflow for telemetry", category="invalid_request"
                )
            self.telemetry.update(telemetry)
            self._append_event(
                self.active_workflow_id,
                event_type="telemetry",
                payload=dict(telemetry),
            )
            return self.status()

    def control_complete(
        self,
        *,
        result: str = "completed",
        release: bool = True,
        release_error: str | None = None,
        disconnect_reason: str = "workflow_terminal",
    ) -> dict[str, Any]:
        """Confirm durable terminal and optionally release BLE promptly."""

        with self._lock:
            wid = self.active_workflow_id
            if not wid:
                raise FakeBridgeError(
                    "no active workflow to complete", category="invalid_request"
                )
            return self._terminalize(
                wid,
                result=result,
                release=release,
                release_error=release_error,
                disconnect_reason=disconnect_reason,
            )

    def control_inject_prior_disconnect_error(
        self,
        *,
        error: str,
        disconnect_time: float | None = None,
    ) -> None:
        """Seed a stale prior-workflow disconnect error (before current terminal)."""

        with self._lock:
            t = float(disconnect_time if disconnect_time is not None else time.time() - 3600)
            self.last_disconnect_error = error
            self.last_disconnect_time = t
            self.last_disconnect_reason = "prior_workflow_release_failed"
            self._prior_disconnect_error = error
            self._prior_disconnect_time = t

    def control_set_active_workflow(
        self,
        *,
        recipe_revision_id: str,
        kind: str = "coffee",
    ) -> dict[str, Any]:
        """Create a newer active workflow without going through coffee_load HTTP.

        Used to simulate another client starting a brew while an old page still
        holds a stale local workflow_id.
        """

        with self._lock:
            # Terminalize any previous active without release if already free.
            if self.active_workflow_id and self.phase not in TERMINAL_STATES:
                self._terminalize(
                    self.active_workflow_id,
                    result="cancelled",
                    release=True,
                    disconnect_reason="superseded",
                )
            wid = f"wf_e2e_{uuid.uuid4().hex}"
            now = _iso_now()
            self._ensure_connected(source="control_set_active")
            summary = {
                "workflow_id": wid,
                "kind": kind,
                "state": "running",
                "source": "e2e-control",
                "owner": "e2e",
                "snapshot_sha256": "e2e" + "0" * 60,
                "recipe_revision_id": recipe_revision_id,
                "machine_phase": "running",
                "recovery": None,
                "created_at": now,
                "updated_at": now,
                "terminal_at": None,
                "metadata": {},
            }
            self._workflows[wid] = summary
            self._events.setdefault(wid, [])
            self.active_workflow_id = wid
            self.activity = kind
            self.phase = "running"
            self.machine_state = "brewing"
            self.connection_scope = "workflow"
            self.targets = {"volume_ml": 240}
            self.telemetry = {
                "dispensed_water_ml": 10.0,
                "dispensed_water_peak_ml": 10.0,
                "cup_weight_g": 12.0,
                "cup_delta_peak_g": 2.0,
            }
            self._append_event(
                wid,
                event_type="workflow_started",
                payload={"workflow_id": wid, "recipe_revision_id": recipe_revision_id},
            )
            self._record("control_set_active_workflow", workflow_id=wid)
            return {"workflow_id": wid, "status": self.status()}

    def control_reset(self) -> None:
        """Full state reset preserving instance_id (ledger cleared)."""

        with self._lock:
            instance_id = self.instance_id
            self.connected = False
            self.connection_scope = None
            self.machine_name = None
            self.firmware = None
            self.release_pending = False
            self.last_disconnect_reason = None
            self.last_disconnect_time = None
            self.last_disconnect_error = None
            self.activity = None
            self.phase = None
            self.machine_state = None
            self.active_workflow_id = None
            self.targets = {}
            self.telemetry = {}
            self.last_operation = None
            self.last_error = None
            self._recovery_required = False
            self._recovery_detail = {}
            self._workflows = {}
            self._events = {}
            self._event_seq = 0
            self._connect_count = 0
            self._ledger = []
            self._prior_disconnect_error = None
            self._prior_disconnect_time = None
            self.instance_id = instance_id

    # ------------------------------------------------------------------
    # Public adapter surface (mirrors bridge_client module functions)
    # ------------------------------------------------------------------

    def is_running(self) -> bool:
        return True

    def status(self) -> dict[str, Any]:
        with self._lock:
            # Pure observation: do not mutate ledger for status itself, but
            # record an observation so tests can prove no connect/load/start.
            self._record("status")
            workflow_summary = None
            if self.active_workflow_id and self.active_workflow_id in self._workflows:
                workflow_summary = copy.deepcopy(self._workflows[self.active_workflow_id])
            elif self._workflows:
                # Prefer latest terminal summary when no active.
                latest = max(
                    self._workflows.values(),
                    key=lambda w: str(w.get("updated_at") or ""),
                )
                workflow_summary = copy.deepcopy(latest)

            recovery_state = None
            if self._recovery_required or self._recovery_detail:
                recovery_state = {
                    "required": bool(self._recovery_required),
                    "detail": dict(self._recovery_detail),
                }

            public_telemetry = dict(self.telemetry)
            if "dispensed_water_ml" in public_telemetry:
                public_telemetry["water_ml"] = public_telemetry["dispensed_water_ml"]
            if "cup_weight_g" in public_telemetry:
                public_telemetry["coffee_g"] = public_telemetry["cup_weight_g"]

            liquid_progress: dict[str, Any] | None = None
            target = self.targets.get("volume_ml")
            dispensed = self.telemetry.get("dispensed_water_peak_ml") or self.telemetry.get(
                "dispensed_water_ml"
            )
            if target is not None or dispensed is not None:
                liquid_progress = {}
                if target is not None:
                    liquid_progress["target_dispensed_water_ml"] = target
                if dispensed is not None:
                    liquid_progress["dispensed_water_ml"] = dispensed
                if self.telemetry.get("cup_delta_peak_g") is not None:
                    liquid_progress["cup_delta_g"] = self.telemetry["cup_delta_peak_g"]

            return {
                "running": True,
                "available": True,
                "protocol_version": 3,
                "rpc_protocol_min": 3,
                "rpc_protocol_max": 3,
                "rpc_protocol_current": 3,
                "record_format_version": 1,
                "instance_id": self.instance_id,
                "core_version": self.core_version,
                "config_fingerprint": self.config_fingerprint,
                "started_at": self.started_at,
                "pid": 0,
                "connected": self.connected,
                "machine": self.machine_name if self.connected else None,
                "address_configured": True,
                "connection_scope": self.connection_scope,
                "release_pending": self.release_pending,
                "last_disconnect_reason": self.last_disconnect_reason,
                "last_disconnect_time": self.last_disconnect_time,
                "last_disconnect_error": self.last_disconnect_error,
                "idle_disconnect_s": 300,
                "idle_orphan_since": None,
                "idle_orphan_deadline": None,
                "activity": self.activity,
                "phase": self.phase,
                "machine_state": self.machine_state,
                "firmware": self.firmware if self.connected else None,
                "targets": dict(self.targets),
                "telemetry": public_telemetry,
                "liquid_progress": liquid_progress,
                "last_operation": copy.deepcopy(self.last_operation),
                "last_error": self.last_error,
                "recovery_records": [],
                "idle": self.active_workflow_id is None and not self.connected,
                "active_workflow_id": self.active_workflow_id,
                "workflow": workflow_summary,
                "recovery": recovery_state,
            }

    def events(self, *, since: int = 0, workflow_id: str) -> dict[str, Any]:
        with self._lock:
            self._record("events", since=since, workflow_id=workflow_id)
            wid = (workflow_id or "").strip()
            if not wid:
                raise FakeBridgeError(
                    "events requires an explicit workflow_id",
                    category="invalid_request",
                )
            rows = self._events.get(wid)
            if rows is None:
                return {
                    "running": True,
                    "events": [],
                    "next_since": int(since),
                    "gap_detected": True,
                    "gap_reason": "unknown_workflow",
                    "workflow_id": wid,
                    "instance_id": self.instance_id,
                }
            selected = [e for e in rows if int(e["seq"]) > int(since)]
            next_since = int(since)
            if selected:
                next_since = max(int(e["seq"]) for e in selected)
            elif rows:
                next_since = max(int(e["seq"]) for e in rows)
            return {
                "running": True,
                "events": copy.deepcopy(selected),
                "next_since": next_since,
                "gap_detected": False,
                "gap_reason": None,
                "workflow_id": wid,
                "instance_id": self.instance_id,
            }

    def connect(self, *, address: str | None = None, scan_timeout: float = 8.0) -> dict[str, Any]:
        with self._lock:
            self._ensure_connected(source="debug_connect", address=address)
            self.connection_scope = "explicit"
            self._record("connect", address=address, scan_timeout=scan_timeout)
            return self.status()

    def disconnect(self) -> dict[str, Any]:
        with self._lock:
            self._record("disconnect")
            self._release(reason="debug_disconnect", error=None)
            return self.status()

    def coffee_load(
        self,
        *,
        recipe: str | None = None,
        request_id: str | None = None,
        address: str | None = None,
        scan_timeout: float = 8.0,
        recipe_revision_id: str | None = None,
    ) -> dict[str, Any]:
        return self._load(
            kind="coffee",
            recipe=recipe,
            request_id=request_id,
            address=address,
            scan_timeout=scan_timeout,
            recipe_revision_id=recipe_revision_id,
        )

    def tea_load(
        self,
        *,
        recipe: str | None = None,
        request_id: str | None = None,
        address: str | None = None,
        scan_timeout: float = 8.0,
        recipe_revision_id: str | None = None,
    ) -> dict[str, Any]:
        return self._load(
            kind="tea",
            recipe=recipe,
            request_id=request_id,
            address=address,
            scan_timeout=scan_timeout,
            recipe_revision_id=recipe_revision_id,
        )

    def coffee_start(
        self,
        *,
        workflow_id: str,
        confirmation: str,
        request_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        return self._start(
            kind="coffee",
            workflow_id=workflow_id,
            confirmation=confirmation,
            request_id=request_id,
            expected_phrase=COFFEE_START_CONFIRMATION,
        )

    def tea_start(
        self,
        *,
        workflow_id: str,
        confirmation: str,
        request_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        return self._start(
            kind="tea",
            workflow_id=workflow_id,
            confirmation=confirmation,
            request_id=request_id,
            expected_phrase=TEA_START_CONFIRMATION,
        )

    def pause(self, *, workflow_id: str, request_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            self._require_workflow(workflow_id)
            self._record("pause", workflow_id=workflow_id, request_id=request_id)
            self.phase = "paused"
            self.machine_state = "paused"
            wf = self._workflows[workflow_id]
            wf["state"] = "paused"
            wf["machine_phase"] = "paused"
            wf["updated_at"] = _iso_now()
            self._append_event(workflow_id, event_type="paused", payload={})
            return {"ok": True, "workflow_id": workflow_id, "phase": "paused"}

    def resume(self, *, workflow_id: str, request_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            self._require_workflow(workflow_id)
            self._record("resume", workflow_id=workflow_id, request_id=request_id)
            self.phase = "running"
            self.machine_state = "brewing"
            wf = self._workflows[workflow_id]
            wf["state"] = "running"
            wf["machine_phase"] = "running"
            wf["updated_at"] = _iso_now()
            self._append_event(workflow_id, event_type="resumed", payload={})
            return {"ok": True, "workflow_id": workflow_id, "phase": "running"}

    def stop(
        self,
        *,
        workflow_id: str | None = None,
        request_id: str | None = None,
        emergency: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            wid = (workflow_id or self.active_workflow_id or "").strip()
            if not emergency and not wid:
                raise FakeBridgeError(
                    "stop requires workflow_id unless emergency=true",
                    category="invalid_request",
                )
            if wid:
                self._require_workflow(wid, allow_emergency=emergency)
            self._record(
                "stop",
                workflow_id=wid or None,
                request_id=request_id,
                emergency=emergency,
            )
            if wid:
                return self._terminalize(
                    wid,
                    result="stopped",
                    release=True,
                    disconnect_reason="stop",
                )
            return {"ok": True}

    def cancel(
        self,
        *,
        workflow_id: str | None = None,
        request_id: str | None = None,
        emergency: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            wid = (workflow_id or self.active_workflow_id or "").strip()
            if not emergency and not wid:
                raise FakeBridgeError(
                    "cancel requires workflow_id unless emergency=true",
                    category="invalid_request",
                )
            if wid:
                self._require_workflow(wid, allow_emergency=emergency)
            self._record(
                "cancel",
                workflow_id=wid or None,
                request_id=request_id,
                emergency=emergency,
            )
            if wid:
                return self._terminalize(
                    wid,
                    result="cancelled",
                    release=True,
                    disconnect_reason="cancel",
                )
            return {"ok": True}

    def recovery_reconcile(
        self,
        *,
        workflow_id: str,
        address: str | None = None,
        scan_timeout: float = 8.0,
    ) -> dict[str, Any]:
        with self._lock:
            self._require_workflow(workflow_id)
            self._record(
                "recovery_reconcile",
                workflow_id=workflow_id,
                address=address,
                scan_timeout=scan_timeout,
            )
            # Observation-style reconcile: connect+query only if recovery.
            if not self.connected:
                self._ensure_connected(source="recovery_reconcile")
            self._recovery_required = False
            self._recovery_detail = {}
            return self.status()

    def probe(
        self,
        *,
        address: str | None = None,
        scan_timeout: float = 8.0,
    ) -> dict[str, Any]:
        with self._lock:
            self._record("probe", address=address, scan_timeout=scan_timeout)
            return {
                "machine": "e2e-fake",
                "firmware": "e2e-0",
                "connected": False,
            }

    def water_start(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            self._record("water_start", **kwargs)
            raise FakeBridgeError("water not used in e2e", category="invalid_request")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _load(
        self,
        *,
        kind: str,
        recipe: str | None,
        request_id: str | None,
        address: str | None,
        scan_timeout: float,
        recipe_revision_id: str | None,
    ) -> dict[str, Any]:
        with self._lock:
            has_recipe = recipe is not None and str(recipe).strip() != ""
            has_rev = (
                recipe_revision_id is not None
                and str(recipe_revision_id).strip() != ""
            )
            if not has_recipe and not has_rev:
                raise FakeBridgeError(
                    f"{kind}.load requires a local recipe path or recipe_revision_id",
                    category="invalid_request",
                )
            if self.active_workflow_id and self.phase not in TERMINAL_STATES:
                raise FakeBridgeError(
                    "device has an active workflow; cannot load",
                    category="workflow_conflict",
                )

            self._ensure_connected(source=f"{kind}.load", address=address)
            wid = f"wf_e2e_{uuid.uuid4().hex}"
            now = _iso_now()
            rev = str(recipe_revision_id).strip() if has_rev else None
            summary = {
                "workflow_id": wid,
                "kind": kind,
                "state": "loaded",
                "source": "web",
                "owner": "xbloom-studio-web",
                "snapshot_sha256": "e2e" + "a" * 60,
                "recipe_revision_id": rev,
                "machine_phase": "loaded",
                "recovery": None,
                "created_at": now,
                "updated_at": now,
                "terminal_at": None,
                "metadata": {},
            }
            self._workflows[wid] = summary
            self._events[wid] = []
            self.active_workflow_id = wid
            self.activity = kind
            self.phase = "loaded"
            self.machine_state = "armed"
            self.connection_scope = "workflow"
            self.release_pending = False
            self.targets = {"volume_ml": 240}
            self.telemetry = {
                "dispensed_water_ml": 0.0,
                "dispensed_water_peak_ml": 0.0,
                "cup_weight_g": 0.0,
            }
            self._append_event(
                wid,
                event_type="loaded",
                payload={
                    "workflow_id": wid,
                    "recipe_revision_id": rev,
                    "kind": kind,
                },
            )
            self._record(
                "load",
                kind=kind,
                workflow_id=wid,
                recipe_revision_id=rev,
                request_id=request_id,
                scan_timeout=scan_timeout,
            )
            # Connect is implicit on first load of a free device.
            return {
                "ok": True,
                "workflow_id": wid,
                "recipe_revision_id": rev,
                "phase": "loaded",
                "connected": self.connected,
            }

    def _start(
        self,
        *,
        kind: str,
        workflow_id: str,
        confirmation: str,
        request_id: str | None,
        expected_phrase: str,
    ) -> dict[str, Any]:
        with self._lock:
            wid = (workflow_id or "").strip()
            self._require_workflow(wid)
            if confirmation != expected_phrase:
                raise FakeBridgeError(
                    "confirmation phrase mismatch",
                    category="invalid_request",
                )
            if self.phase not in ("loaded", "loading"):
                raise FakeBridgeError(
                    f"cannot start from phase {self.phase!r}",
                    category="invalid_request",
                )
            # Connection must already be held from load — never a second connect.
            if not self.connected:
                raise FakeBridgeError(
                    "not connected; load must establish the link",
                    category="bridge_error",
                )
            self.phase = "running"
            self.machine_state = "brewing"
            wf = self._workflows[wid]
            wf["state"] = "running"
            wf["machine_phase"] = "running"
            wf["updated_at"] = _iso_now()
            self.telemetry = {
                "dispensed_water_ml": 5.0,
                "dispensed_water_peak_ml": 5.0,
                "cup_weight_g": 8.0,
                "cup_delta_peak_g": 1.5,
            }
            self._append_event(
                wid,
                event_type="started",
                payload={"workflow_id": wid, "kind": kind},
            )
            self._record(
                "start",
                kind=kind,
                workflow_id=wid,
                request_id=request_id,
            )
            return {
                "ok": True,
                "workflow_id": wid,
                "phase": "running",
                "connected": True,
            }

    def _require_workflow(self, workflow_id: str, *, allow_emergency: bool = False) -> None:
        wid = (workflow_id or "").strip()
        if not wid:
            raise FakeBridgeError("missing workflow_id", category="invalid_request")
        if wid not in self._workflows:
            raise FakeBridgeError(
                f"unknown workflow_id {wid}",
                category="invalid_request",
            )
        if self.active_workflow_id and self.active_workflow_id != wid:
            if not allow_emergency:
                raise FakeBridgeError(
                    f"workflow_id mismatch: active is {self.active_workflow_id}",
                    category="workflow_mismatch",
                )

    def _ensure_connected(self, *, source: str, address: str | None = None) -> None:
        if self.connected:
            return
        self._connect_count += 1
        self.connected = True
        self.machine_name = "xBloom Studio E2E"
        self.firmware = "e2e-fake-1"
        self.connection_scope = "workflow"
        self.release_pending = False
        # A successful connect clears release-pending; prior disconnect error
        # remains until a successful terminal release overwrites it.
        self._record("connect", source=source, address=address)

    def _terminalize(
        self,
        workflow_id: str,
        *,
        result: str,
        release: bool,
        release_error: str | None = None,
        disconnect_reason: str = "workflow_terminal",
    ) -> dict[str, Any]:
        wid = workflow_id
        now_iso = _iso_now()
        now_ts = time.time()
        wf = self._workflows.get(wid)
        if wf is None:
            raise FakeBridgeError(f"unknown workflow {wid}", category="invalid_request")
        wf["state"] = result
        wf["machine_phase"] = result
        wf["terminal_at"] = now_iso
        wf["updated_at"] = now_iso
        self.phase = result
        self.machine_state = result
        self.last_operation = {
            "result": result,
            "activity": self.activity,
            "workflow_id": wid,
            "finished_at": now_iso,
            "terminal_at": now_iso,
            "release_reason": disconnect_reason,
            "target_dispensed_water_ml": self.targets.get("volume_ml"),
            "dispensed_water_ml": self.telemetry.get("dispensed_water_ml"),
            "cup_delta_g": self.telemetry.get("cup_delta_peak_g"),
        }
        self._append_event(
            wid,
            event_type="terminal",
            payload={
                "result": result,
                "state": result,
                "activity": self.activity,
                "workflow_id": wid,
                "finished_at": now_iso,
                "terminal_at": now_iso,
                "release_reason": disconnect_reason,
                "target_dispensed_water_ml": self.targets.get("volume_ml"),
                "dispensed_water_ml": self.telemetry.get(
                    "dispensed_water_peak_ml", self.telemetry.get("dispensed_water_ml")
                ),
                "cup_delta_g": self.telemetry.get("cup_delta_peak_g"),
            },
            created_at=now_iso,
        )
        self.active_workflow_id = None
        self.activity = None
        self._record("terminal", workflow_id=wid, result=result)

        if release:
            self.release_pending = True
            self._record("release_begin", workflow_id=wid)
            # Prompt release after confirmed terminal (no idle wait).
            self._release(reason=disconnect_reason, error=release_error, at=now_ts)
        return {
            "ok": True,
            "workflow_id": wid,
            "result": result,
            "connected": self.connected,
            "release_pending": self.release_pending,
        }

    def _release(
        self,
        *,
        reason: str,
        error: str | None,
        at: float | None = None,
    ) -> None:
        ts = float(at if at is not None else time.time())
        self.connected = False
        self.connection_scope = None
        self.machine_name = None
        self.firmware = None
        self.release_pending = False
        self.last_disconnect_reason = reason
        self.last_disconnect_time = ts
        self.last_disconnect_error = error
        self._record("release", reason=reason, error=error)

    def _append_event(
        self,
        workflow_id: str,
        *,
        event_type: str,
        payload: dict[str, Any],
        created_at: str | None = None,
    ) -> None:
        self._event_seq += 1
        row = {
            "seq": self._event_seq,
            "event_type": event_type,
            "state_name": event_type,
            "workflow_id": workflow_id,
            "created_at": created_at or _iso_now(),
            "payload": dict(payload),
        }
        self._events.setdefault(workflow_id, []).append(row)


def _iso_now() -> str:
    # UTC-ish ISO without external deps; fine for correlation tests.
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def install_fake_bridge(bridge: FakeBridge, bridge_client_module: Any) -> None:
    """Replace ``bridge_client`` public functions with the fake instance.

    Also maps FakeBridgeError onto the module's BridgeError so HTTP routes
    continue to map categories correctly.
    """

    # Make raise paths use BridgeError when possible.
    BridgeError = getattr(bridge_client_module, "BridgeError", FakeBridgeError)

    def _wrap(fn):
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except FakeBridgeError as exc:
                raise BridgeError(str(exc), category=exc.category) from exc

        return inner

    bridge_client_module.is_running = bridge.is_running
    bridge_client_module.status = _wrap(bridge.status)
    bridge_client_module.events = _wrap(bridge.events)
    bridge_client_module.probe = _wrap(bridge.probe)
    bridge_client_module.connect = _wrap(bridge.connect)
    bridge_client_module.disconnect = _wrap(bridge.disconnect)
    bridge_client_module.coffee_load = _wrap(bridge.coffee_load)
    bridge_client_module.coffee_start = _wrap(bridge.coffee_start)
    bridge_client_module.tea_load = _wrap(bridge.tea_load)
    bridge_client_module.tea_start = _wrap(bridge.tea_start)
    bridge_client_module.pause = _wrap(bridge.pause)
    bridge_client_module.resume = _wrap(bridge.resume)
    bridge_client_module.stop = _wrap(bridge.stop)
    bridge_client_module.cancel = _wrap(bridge.cancel)
    bridge_client_module.recovery_reconcile = _wrap(bridge.recovery_reconcile)
    bridge_client_module.water_start = _wrap(bridge.water_start)
    # Preserve public_response if present.
