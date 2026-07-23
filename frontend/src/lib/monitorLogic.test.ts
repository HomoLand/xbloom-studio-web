/**
 * Deterministic unit tests for Dashboard monitor logic (C5-C7).
 * Run: node --experimental-strip-types --test src/lib/*.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyExplicitEventRearm,
  applyGapDetected,
  applyInstanceChange,
  applyResyncPageResult,
  bleReleaseLabel,
  buildFinalSummary,
  captureEventObservation,
  findLatestTerminalEvent,
  formatEventSyncWarning,
  hasDurableTerminal,
  initialEventCursor,
  isEventObservationCurrent,
  mergeDurableEvents,
  resolveControlWorkflowId,
  selectTrackedWorkflowId,
  validControlsForPhase,
} from "./monitorLogic.ts";

// Lightweight shapes (avoid importing browser api module under node:test).
type BridgeState = {
  running: boolean;
  active_workflow_id?: string | null;
  workflow?: { workflow_id?: string } | null;
  connected?: boolean;
  release_pending?: boolean;
  last_disconnect_error?: string | null;
  phase?: string | null;
  last_operation?: { result?: string; workflow_id?: string } | null;
};

type BridgeEvent = {
  seq: number;
  event_type?: string;
  workflow_id?: string;
  created_at?: string;
  payload?: Record<string, unknown> | null;
};

describe("selectTrackedWorkflowId", () => {
  it("prefers active_workflow_id over summary and local", () => {
    const bridge = {
      running: true,
      active_workflow_id: "wf_active",
      workflow: { workflow_id: "wf_summary" },
    } as BridgeState;
    assert.equal(selectTrackedWorkflowId(bridge as never, "wf_local"), "wf_active");
  });

  it("uses summary when no active id", () => {
    const bridge = {
      running: true,
      active_workflow_id: null,
      workflow: { workflow_id: "wf_summary" },
    } as BridgeState;
    assert.equal(selectTrackedWorkflowId(bridge as never, "wf_local"), "wf_summary");
  });

  it("falls back to exact local id and never invents", () => {
    assert.equal(selectTrackedWorkflowId(null, "wf_local"), "wf_local");
    assert.equal(selectTrackedWorkflowId(null, null), null);
    assert.equal(selectTrackedWorkflowId({ running: false } as never, "  "), null);
  });
});

describe("resolveControlWorkflowId stale mismatch", () => {
  it("blocks control until the actual active id is acknowledged", () => {
    const bridge = {
      running: true,
      active_workflow_id: "wf_new",
    } as BridgeState;
    const r = resolveControlWorkflowId(bridge as never, "wf_old");
    assert.equal(r.staleMismatch, true);
    assert.equal(r.needsAcknowledgement, true);
    // Do not silently control the newly active workflow on a stale-page click.
    assert.equal(r.controlId, null);
    assert.equal(r.actualActiveId, "wf_new");
  });

  it("after acknowledgement, controls use exactly the displayed active id", () => {
    const bridge = {
      running: true,
      active_workflow_id: "wf_new",
    } as BridgeState;
    const r = resolveControlWorkflowId(bridge as never, "wf_old", "wf_new");
    assert.equal(r.staleMismatch, false);
    assert.equal(r.needsAcknowledgement, false);
    assert.equal(r.controlId, "wf_new");
    assert.equal(r.actualActiveId, "wf_new");
  });

  it("requires a new acknowledgement when active_workflow_id changes again", () => {
    const r = resolveControlWorkflowId(
      { running: true, active_workflow_id: "wf_newer" } as never,
      "wf_old",
      "wf_new",
    );
    assert.equal(r.staleMismatch, true);
    assert.equal(r.needsAcknowledgement, true);
    assert.equal(r.controlId, null);
    assert.equal(r.actualActiveId, "wf_newer");
  });

  it("acknowledgement for a different id does not unlock controls", () => {
    const r = resolveControlWorkflowId(
      { running: true, active_workflow_id: "wf_new" } as never,
      "wf_old",
      "wf_other",
    );
    assert.equal(r.needsAcknowledgement, true);
    assert.equal(r.controlId, null);
  });

  it("allows terminal observation of page id when no active", () => {
    const r = resolveControlWorkflowId(
      { running: true, active_workflow_id: null } as never,
      "wf_done",
    );
    assert.equal(r.staleMismatch, false);
    assert.equal(r.needsAcknowledgement, false);
    assert.equal(r.controlId, "wf_done");
  });
});

describe("event observation generation rejects stale responses", () => {
  it("rejects response after workflow identity change", () => {
    let generation = 1;
    const captured = captureEventObservation("wf_a", generation);
    // Tracked workflow switches to B and generation bumps.
    generation += 1;
    assert.equal(
      isEventObservationCurrent(captured, {
        workflowId: "wf_b",
        generation,
      }),
      false,
    );
    assert.equal(
      isEventObservationCurrent(captured, {
        workflowId: "wf_a",
        generation: 1,
      }),
      true,
    );
  });

  it("rejects response after instance change bumps generation", () => {
    const cursor = { since: 42, instanceId: "inst_a", gapResyncArmed: true };
    const { reset } = applyInstanceChange(cursor, "inst_b");
    assert.equal(reset, true);
    let generation = 3;
    const captured = captureEventObservation("wf_1", generation);
    // Instance reset bumps observation generation before applying events.
    if (reset) generation += 1;
    assert.equal(
      isEventObservationCurrent(captured, {
        workflowId: "wf_1",
        generation,
      }),
      false,
    );
    const fresh = captureEventObservation("wf_1", generation);
    assert.equal(
      isEventObservationCurrent(fresh, {
        workflowId: "wf_1",
        generation,
      }),
      true,
    );
  });

  it("rejects when current workflow is cleared", () => {
    const captured = captureEventObservation("wf_a", 2);
    assert.equal(
      isEventObservationCurrent(captured, { workflowId: null, generation: 2 }),
      false,
    );
  });
});

describe("instance change and gap resync", () => {
  it("resets cursor on instance_id change", () => {
    const cursor = { since: 42, instanceId: "inst_a", gapResyncArmed: true };
    const { cursor: next, reset } = applyInstanceChange(cursor, "inst_b");
    assert.equal(reset, true);
    assert.equal(next.since, 0);
    assert.equal(next.instanceId, "inst_b");
    assert.equal(next.gapResyncArmed, true);
  });

  it("gap_detected clears and arms one resync from zero", () => {
    const cursor = initialEventCursor("inst");
    cursor.since = 10;
    const first = applyGapDetected(cursor, true);
    assert.equal(first.clearEvents, true);
    assert.equal(first.resyncFromZero, true);
    assert.equal(first.cursor.since, 0);
    assert.equal(first.cursor.gapResyncArmed, false);

    const second = applyGapDetected(first.cursor, true);
    assert.equal(second.resyncFromZero, false);
    assert.equal(second.clearEvents, false);
  });

  it("persistent gap on zero-resync does not accept timeline or loop", () => {
    const afterGap = applyGapDetected(initialEventCursor("inst"), true);
    assert.equal(afterGap.resyncFromZero, true);

    const resync = applyResyncPageResult(afterGap.cursor, {
      gapDetected: true,
      gapReason: "unknown_workflow",
      nextSince: 0,
    });
    assert.equal(resync.acceptEvents, false);
    assert.equal(resync.clearEvents, true);
    assert.equal(resync.persistentGap, true);
    assert.equal(resync.gapReason, "unknown_workflow");
    assert.equal(resync.cursor.gapResyncArmed, false);
    assert.equal(resync.cursor.since, 0);

    // Still disarmed: no immediate second resync loop.
    const again = applyGapDetected(resync.cursor, true);
    assert.equal(again.resyncFromZero, false);

    const warning = formatEventSyncWarning(resync.gapReason);
    assert.match(warning, /timeline unavailable/i);
    assert.match(warning, /unknown workflow/i);
    assert.doesNotMatch(warning, /will not resync|guard|resync until/i);
  });

  it("clean zero-resync accepts events and rearms guard", () => {
    const afterGap = applyGapDetected(
      { since: 5, instanceId: "i", gapResyncArmed: true },
      true,
    );
    const resync = applyResyncPageResult(afterGap.cursor, {
      gapDetected: false,
      nextSince: 12,
    });
    assert.equal(resync.acceptEvents, true);
    assert.equal(resync.persistentGap, false);
    assert.equal(resync.cursor.since, 12);
    assert.equal(resync.cursor.gapResyncArmed, true);
  });

  it("explicit rearm resets cursor and bumps generation before in-flight check", () => {
    // Persistent gap left the guard disarmed at since=0.
    const disarmed = {
      since: 0,
      instanceId: "inst",
      gapResyncArmed: false,
    };
    const generation = 4;
    const rearmed = applyExplicitEventRearm(disarmed, generation);
    assert.equal(rearmed.cursor.since, 0);
    assert.equal(rearmed.cursor.gapResyncArmed, true);
    assert.equal(rearmed.generation, 5);

    // Old in-flight response (generation 4) is rejected after rearm.
    const staleToken = captureEventObservation("wf_1", generation);
    assert.equal(
      isEventObservationCurrent(staleToken, {
        workflowId: "wf_1",
        generation: rearmed.generation,
      }),
      false,
    );

    // Next poll may attempt one more resync from zero.
    const gap = applyGapDetected(rearmed.cursor, true);
    assert.equal(gap.resyncFromZero, true);
    assert.equal(gap.cursor.gapResyncArmed, false);
  });

  it("persistent gap warning is operational, not mechanical", () => {
    const warning = formatEventSyncWarning("gap_detected");
    assert.match(warning, /timeline unavailable/i);
    assert.match(warning, /refresh/i);
    assert.doesNotMatch(warning, /guard|will not resync|resync until/i);
  });
});

describe("mergeDurableEvents", () => {
  it("dedupes by seq, sorts ascending, caps rows", () => {
    const existing: BridgeEvent[] = [
      { seq: 2, event_type: "b" },
      { seq: 1, event_type: "a" },
    ];
    const incoming: BridgeEvent[] = [
      { seq: 2, event_type: "b2" },
      { seq: 3, event_type: "c" },
    ];
    const merged = mergeDurableEvents(existing as never, incoming as never, 2);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].seq, 2);
    assert.equal(merged[0].event_type, "b2");
    assert.equal(merged[1].seq, 3);
  });
});

describe("final summary and terminal event proof", () => {
  it("builds summary from latest same-workflow terminal event", () => {
    const events: BridgeEvent[] = [
      {
        seq: 1,
        event_type: "terminal",
        workflow_id: "wf_other",
        payload: { result: "wrong" },
      },
      {
        seq: 3,
        event_type: "terminal",
        workflow_id: "wf_1",
        created_at: "2026-01-02T00:00:00Z",
        payload: {
          result: "completed",
          activity: "brew",
          release_reason: "workflow_terminal",
          dispensed_water_ml: 250,
          target_dispensed_water_ml: 260,
          cup_delta_g: 18.5,
        },
      },
      {
        seq: 2,
        event_type: "phase",
        workflow_id: "wf_1",
        payload: { state: "running" },
      },
    ];
    const summary = buildFinalSummary(events as never, "wf_1");
    assert.equal(summary.source, "terminal_event");
    assert.equal(summary.result, "completed");
    assert.equal(summary.activity, "brew");
    assert.equal(summary.releaseReason, "workflow_terminal");
    assert.equal(summary.dispensedWaterMl, 250);
    assert.equal(summary.targetWaterMl, 260);
    assert.equal(summary.cupDeltaG, 18.5);
    assert.equal(summary.finishedAt, "2026-01-02T00:00:00Z");

    // Other-workflow terminal is ignored.
    assert.equal(findLatestTerminalEvent(events as never, "wf_1")?.seq, 3);
  });

  it("falls back to same-workflow last_operation when no terminal event", () => {
    const summary = buildFinalSummary([], "wf_1", {
      workflow_id: "wf_1",
      result: "cancelled",
      activity: "idle",
      release_reason: "user_stop",
      dispensed_water_ml: 10,
    });
    assert.equal(summary.source, "last_operation");
    assert.equal(summary.result, "cancelled");
    assert.equal(summary.releaseReason, "user_stop");
  });

  it("does not use last_operation from another workflow", () => {
    const summary = buildFinalSummary([], "wf_1", {
      workflow_id: "wf_other",
      result: "completed",
    });
    assert.equal(summary.source, "none");
    assert.equal(summary.result, null);
  });

  it("terminal event proves durable terminal for release labels", () => {
    const bridge = {
      running: true,
      connected: true,
      release_pending: true,
      last_disconnect_error: null,
      active_workflow_id: "wf_1",
      phase: "running",
    } as BridgeState;
    // Status not yet terminal, but durable event is proof.
    assert.equal(hasDurableTerminal(bridge as never, null), false);
    assert.equal(
      hasDurableTerminal(bridge as never, null, { terminalEventProof: true }),
      true,
    );
    const label = bleReleaseLabel(bridge as never, null, {
      terminalEventProof: true,
    });
    assert.equal(label.kind, "finishing");
  });
});

describe("bleReleaseLabel", () => {
  it("says BLE released only when durable terminal and fully released", () => {
    const bridge = {
      running: true,
      connected: false,
      release_pending: false,
      last_disconnect_error: null,
      active_workflow_id: null,
    } as BridgeState;
    const summary = {
      workflow_id: "wf_1",
      state: "completed",
      terminal_at: "2026-01-01T00:00:00Z",
    };
    const label = bleReleaseLabel(bridge as never, summary as never);
    assert.equal(label.kind, "released");
    assert.equal(label.text, "BLE released");
  });

  it("shows finishing when release still pending or connected", () => {
    const bridge = {
      running: true,
      connected: true,
      release_pending: true,
      last_disconnect_error: null,
    } as BridgeState;
    const summary = {
      workflow_id: "wf_1",
      state: "completed",
      terminal_at: "2026-01-01T00:00:00Z",
    };
    assert.equal(bleReleaseLabel(bridge as never, summary as never).kind, "finishing");
  });

  it("shows failed when release error present", () => {
    const bridge = {
      running: true,
      connected: false,
      release_pending: false,
      last_disconnect_error: "gatt close failed",
    } as BridgeState;
    const summary = {
      workflow_id: "wf_1",
      state: "cancelled",
      terminal_at: "2026-01-01T00:00:00Z",
    };
    assert.equal(bleReleaseLabel(bridge as never, summary as never).kind, "failed");
  });

  it("returns none when not terminal", () => {
    const bridge = {
      running: true,
      connected: true,
      phase: "running",
      active_workflow_id: "wf_1",
    } as BridgeState;
    assert.equal(bleReleaseLabel(bridge as never, null).kind, "none");
  });

  it("terminal-event proof with null/unknown bridge never says released", () => {
    // Durable terminal event but no fresh bridge status.
    const noBridge = bleReleaseLabel(null, null, { terminalEventProof: true });
    assert.equal(noBridge.kind, "finishing");
    assert.notEqual(noBridge.kind, "released");

    // Bridge present but connected/release_pending undefined - not explicit.
    const unknownFields = bleReleaseLabel(
      { running: true } as never,
      null,
      { terminalEventProof: true },
    );
    assert.equal(unknownFields.kind, "finishing");

    // Explicit false/false with terminal proof is released.
    const released = bleReleaseLabel(
      {
        running: false,
        connected: false,
        release_pending: false,
        last_disconnect_error: null,
      } as never,
      null,
      { terminalEventProof: true },
    );
    assert.equal(released.kind, "released");
  });
});

describe("validControlsForPhase", () => {
  it("loaded -> cancel; running -> pause+stop; paused -> resume+stop", () => {
    assert.deepEqual(
      [...validControlsForPhase("loaded")].sort(),
      ["cancel"],
    );
    assert.deepEqual(
      [...validControlsForPhase("running")].sort(),
      ["pause", "stop"],
    );
    assert.deepEqual(
      [...validControlsForPhase("paused")].sort(),
      ["resume", "stop"],
    );
  });

  it("recovery.required surfaces reconcile (not as loading)", () => {
    const c = validControlsForPhase("running", { recoveryRequired: true });
    assert.equal(c.has("reconcile"), true);
    assert.equal(c.has("stop"), true);
  });
});
