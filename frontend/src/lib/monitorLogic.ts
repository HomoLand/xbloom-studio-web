/**
 * Pure Dashboard/Monitor logic (Phase C5-C7).
 * No React, no fetch - deterministic helpers for workflow selection,
 * event merge, control validity, terminal summary, and BLE-release labels.
 */

import type {
  BridgeEvent,
  BridgeState,
  RecoveryState,
  WorkflowSummary,
} from "../api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Status poll while a non-terminal workflow is tracked. */
export const STATUS_POLL_ACTIVE_MS = 2000;
/** Status poll when idle / no tracked workflow. */
export const STATUS_POLL_IDLE_MS = 6000;
/** Event poll cadence while tracking a workflow (non-overlapping). */
export const EVENTS_POLL_MS = 2000;
/** Cap retained durable timeline rows in the UI. */
export const EVENT_TIMELINE_CAP = 200;

const TERMINAL_STATES = new Set([
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "stopped",
  "failed",
  "error",
  "aborted",
]);

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

export function readWorkflowSummary(
  bridge: BridgeState | null | undefined,
): WorkflowSummary | null {
  if (!bridge?.workflow || typeof bridge.workflow !== "object") return null;
  const w = bridge.workflow as Record<string, unknown>;
  const workflowId = asTrimmedString(w.workflow_id);
  if (!workflowId) return null;
  return {
    workflow_id: workflowId,
    kind: asTrimmedString(w.kind),
    state: asTrimmedString(w.state),
    source: asTrimmedString(w.source),
    owner: asTrimmedString(w.owner),
    snapshot_sha256: asTrimmedString(w.snapshot_sha256),
    recipe_revision_id: asTrimmedString(w.recipe_revision_id),
    machine_phase: asTrimmedString(w.machine_phase),
    recovery:
      w.recovery && typeof w.recovery === "object"
        ? (w.recovery as Record<string, unknown>)
        : null,
    created_at: asTrimmedString(w.created_at) ?? (w.created_at as string | null),
    updated_at: asTrimmedString(w.updated_at) ?? (w.updated_at as string | null),
    terminal_at: asTrimmedString(w.terminal_at) ?? (w.terminal_at as string | null),
    metadata:
      w.metadata && typeof w.metadata === "object"
        ? (w.metadata as Record<string, unknown>)
        : {},
  };
}

export function readRecoveryState(
  bridge: BridgeState | null | undefined,
): RecoveryState | null {
  if (!bridge?.recovery || typeof bridge.recovery !== "object") return null;
  const r = bridge.recovery as Record<string, unknown>;
  if (typeof r.required === "boolean") {
    return {
      required: r.required,
      detail:
        r.detail && typeof r.detail === "object"
          ? (r.detail as Record<string, unknown>)
          : null,
    };
  }
  // Some surfaces may only set a truthy flag-like object.
  if ("required" in r && r.required) {
    return { required: true, detail: r as Record<string, unknown> };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workflow selection (never invent IDs)
// ---------------------------------------------------------------------------

/**
 * Track exact workflow using:
 * 1) bridge.active_workflow_id
 * 2) bridge workflow summary id
 * 3) exact locally persisted server-returned ID
 *
 * Never creates an ID.
 */
export function selectTrackedWorkflowId(
  bridge: BridgeState | null | undefined,
  storedWorkflowId: string | null | undefined,
): string | null {
  const active = asTrimmedString(bridge?.active_workflow_id);
  if (active) return active;
  const summary = readWorkflowSummary(bridge);
  if (summary?.workflow_id) return summary.workflow_id;
  const stored = asTrimmedString(storedWorkflowId);
  return stored;
}

/**
 * When bridge has an active workflow different from the page's stored/local
 * id, the page must show the actual active workflow and must not control
 * using the stale id until the user explicitly acknowledges the switch.
 * Local stored metadata is not rewritten here; acknowledgement is UI-only
 * (no hardware mutation).
 *
 * @param acknowledgedActiveId UI-held id the user accepted for control.
 *   When active_workflow_id changes again, a new acknowledgement is required.
 */
export function resolveControlWorkflowId(
  bridge: BridgeState | null | undefined,
  pageWorkflowId: string | null | undefined,
  acknowledgedActiveId?: string | null,
): {
  controlId: string | null;
  staleMismatch: boolean;
  needsAcknowledgement: boolean;
  actualActiveId: string | null;
} {
  const actualActiveId = asTrimmedString(bridge?.active_workflow_id);
  const pageId = asTrimmedString(pageWorkflowId);
  const acked = asTrimmedString(acknowledgedActiveId);

  if (actualActiveId && pageId && actualActiveId !== pageId) {
    // Stale page vs live active: block controls until this exact active is acked.
    if (acked && acked === actualActiveId) {
      return {
        controlId: actualActiveId,
        staleMismatch: false,
        needsAcknowledgement: false,
        actualActiveId,
      };
    }
    return {
      // Do not silently control the newly active workflow on a stale-page click.
      controlId: null,
      staleMismatch: true,
      needsAcknowledgement: true,
      actualActiveId,
    };
  }
  // Prefer exact active when present; otherwise allow page/summary tracked id
  // for terminal observation (no active) without inventing.
  if (actualActiveId) {
    return {
      controlId: actualActiveId,
      staleMismatch: false,
      needsAcknowledgement: false,
      actualActiveId,
    };
  }
  return {
    controlId: pageId,
    staleMismatch: false,
    needsAcknowledgement: false,
    actualActiveId: null,
  };
}

// ---------------------------------------------------------------------------
// Phase / terminal / controls
// ---------------------------------------------------------------------------

export function normalizePhase(
  bridge: BridgeState | null | undefined,
  summary: WorkflowSummary | null,
): string | null {
  return (
    asTrimmedString(bridge?.phase) ||
    asTrimmedString(summary?.machine_phase) ||
    asTrimmedString(summary?.state) ||
    null
  );
}

export function isTerminalState(state: string | null | undefined): boolean {
  if (!state) return false;
  return TERMINAL_STATES.has(state.trim().toLowerCase());
}

export function isTerminalEventType(eventType: string | null | undefined): boolean {
  if (!eventType) return false;
  const t = eventType.trim().toLowerCase();
  return t === "terminal" || t === "workflow_terminal" || t.endsWith(".terminal");
}

/**
 * Latest durable terminal event for the given workflow only.
 * Never mixes a terminal event from another workflow.
 */
export function findLatestTerminalEvent(
  events: BridgeEvent[] | null | undefined,
  workflowId: string | null | undefined,
): BridgeEvent | null {
  const wf = asTrimmedString(workflowId);
  if (!events?.length || !wf) return null;
  let latest: BridgeEvent | null = null;
  let latestSeq = -Infinity;
  for (const ev of events) {
    const type =
      asTrimmedString(ev.event_type) || asTrimmedString(ev.state_name);
    if (!isTerminalEventType(type)) continue;
    const evWf = asTrimmedString(ev.workflow_id);
    // If the event carries a workflow_id, it must match.
    if (evWf && evWf !== wf) continue;
    const seq = Number(ev.seq);
    if (!Number.isFinite(seq)) continue;
    if (seq >= latestSeq) {
      latestSeq = seq;
      latest = ev;
    }
  }
  return latest;
}

export function hasDurableTerminal(
  bridge: BridgeState | null | undefined,
  summary: WorkflowSummary | null,
  opts?: { terminalEventProof?: boolean },
): boolean {
  // A durable terminal event is proof even before the next status poll.
  if (opts?.terminalEventProof) return true;
  if (summary?.terminal_at) return true;
  if (isTerminalState(summary?.state ?? null)) return true;
  if (isTerminalState(summary?.machine_phase ?? null)) return true;
  // last_operation with terminal-ish result while no active workflow.
  if (!asTrimmedString(bridge?.active_workflow_id) && bridge?.last_operation) {
    const result = asTrimmedString(
      (bridge.last_operation as { result?: unknown }).result,
    );
    if (isTerminalState(result)) return true;
  }
  return false;
}

export type ControlAction = "cancel" | "pause" | "resume" | "stop" | "reconcile";

/**
 * Which control buttons are valid for the current phase.
 * Bridge still enforces edge cases; UI only gates obvious cases.
 */
export function validControlsForPhase(
  phase: string | null | undefined,
  opts?: { recoveryRequired?: boolean },
): Set<ControlAction> {
  const out = new Set<ControlAction>();
  if (opts?.recoveryRequired) {
    out.add("reconcile");
    // Stop remains available as an escape where bridge allows.
    out.add("stop");
    return out;
  }
  const p = (phase || "").trim().toLowerCase();
  if (!p || isTerminalState(p)) return out;

  if (p === "loaded" || p === "loading") {
    out.add("cancel");
    return out;
  }
  if (p === "paused") {
    out.add("resume");
    out.add("stop");
    return out;
  }
  // active / running / starting / soaking / and similar in-progress phases
  if (
    p === "active" ||
    p === "running" ||
    p === "starting" ||
    p === "soaking" ||
    p === "started" ||
    p === "brewing" ||
    p === "dispensing" ||
    p === "pouring"
  ) {
    out.add("pause");
    out.add("stop");
    return out;
  }
  // Unconfirmed control phases: stop may help; cancel if still pre-start.
  if (p.includes("unconfirmed") || p === "recovery_required") {
    out.add("stop");
    out.add("reconcile");
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BLE release label (C7)
// ---------------------------------------------------------------------------

export type BleReleaseLabel =
  | { kind: "released"; text: string }
  | { kind: "finishing"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "none"; text: null };

/**
 * Say "BLE released" only when durable terminal exists AND bridge status is
 * present with connected === false, release_pending === false, and no release
 * error. Undefined/unknown optional fields must never coerce to "released".
 * If terminal durable but release pending/connected/unknown: finishing.
 * If release failed: action complete but BLE release failed.
 *
 * A durable terminal event is proof of terminal even when status.workflow has
 * not refreshed yet (finishing until release fields explicitly confirm).
 */
export function bleReleaseLabel(
  bridge: BridgeState | null | undefined,
  summary: WorkflowSummary | null,
  opts?: { terminalEventProof?: boolean },
): BleReleaseLabel {
  if (!hasDurableTerminal(bridge, summary, opts)) {
    return { kind: "none", text: null };
  }
  // Without a bridge status object, release fields are unknown - never released.
  if (!bridge || typeof bridge !== "object") {
    return {
      kind: "finishing",
      text: "Finishing BLE release",
    };
  }

  const releaseError = asTrimmedString(bridge.last_disconnect_error);
  if (releaseError) {
    return {
      kind: "failed",
      text: "Action complete, but BLE release failed",
    };
  }

  // Explicit false only - undefined/null/missing must stay finishing.
  if (bridge.connected === false && bridge.release_pending === false) {
    return { kind: "released", text: "BLE released" };
  }
  return {
    kind: "finishing",
    text: "Finishing BLE release",
  };
}

// ---------------------------------------------------------------------------
// Final summary (C7)
// ---------------------------------------------------------------------------

export type FinalWorkflowSummary = {
  result: string | null;
  activity: string | null;
  releaseReason: string | null;
  finishedAt: string | number | null;
  targetWaterMl: number | null;
  dispensedWaterMl: number | null;
  cupDeltaG: number | null;
  /** Where the primary fields came from. */
  source: "terminal_event" | "last_operation" | "none";
};

function readPayloadNumber(
  payload: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  return pickNumber(payload ?? null, keys);
}

function lastOperationMatchesWorkflow(
  lastOp: Record<string, unknown> | null | undefined,
  workflowId: string | null | undefined,
): boolean {
  if (!lastOp) return false;
  const wf = asTrimmedString(workflowId);
  if (!wf) return false;
  const opWf =
    asTrimmedString(lastOp.workflow_id) ||
    asTrimmedString(lastOp.workflowId);
  // If last_operation carries a workflow_id, require match.
  // If it does not, treat as same-workflow fallback only when caller
  // already scoped to the tracked id (caller responsibility).
  if (opWf && opWf !== wf) return false;
  return true;
}

/**
 * Build a final summary from the latest durable terminal event payload,
 * with status.last_operation as same-workflow fallback.
 * Never mixes a terminal event from another workflow.
 */
export function buildFinalSummary(
  events: BridgeEvent[] | null | undefined,
  workflowId: string | null | undefined,
  lastOperation?: Record<string, unknown> | null,
  opts?: { allowLastOpWithoutWorkflowField?: boolean },
): FinalWorkflowSummary {
  const empty: FinalWorkflowSummary = {
    result: null,
    activity: null,
    releaseReason: null,
    finishedAt: null,
    targetWaterMl: null,
    dispensedWaterMl: null,
    cupDeltaG: null,
    source: "none",
  };

  const terminal = findLatestTerminalEvent(events, workflowId);
  if (terminal) {
    const payload =
      terminal.payload && typeof terminal.payload === "object"
        ? (terminal.payload as Record<string, unknown>)
        : null;
    return {
      result:
        asTrimmedString(payload?.result) ||
        asTrimmedString(payload?.state) ||
        null,
      activity: asTrimmedString(payload?.activity),
      releaseReason:
        asTrimmedString(payload?.release_reason) ||
        asTrimmedString(payload?.disconnect_reason),
      finishedAt:
        terminal.created_at ??
        asTrimmedString(payload?.finished_at) ??
        asTrimmedString(payload?.terminal_at) ??
        null,
      targetWaterMl: readPayloadNumber(payload, [
        "target_dispensed_water_ml",
        "target_water_ml",
        "volume_ml",
      ]),
      dispensedWaterMl: readPayloadNumber(payload, [
        "dispensed_water_ml",
        "water_ml",
        "dispensed_water_peak_ml",
      ]),
      cupDeltaG: readPayloadNumber(payload, [
        "cup_delta_g",
        "cup_delta_peak_g",
        "coffee_g",
      ]),
      source: "terminal_event",
    };
  }

  const lastOp =
    lastOperation && typeof lastOperation === "object" ? lastOperation : null;
  if (!lastOp) return empty;

  const opWf =
    asTrimmedString(lastOp.workflow_id) || asTrimmedString(lastOp.workflowId);
  const wf = asTrimmedString(workflowId);
  if (opWf && wf && opWf !== wf) return empty;
  if (!opWf && !opts?.allowLastOpWithoutWorkflowField) {
    // Without an event and without an op workflow field, only allow when
    // the caller explicitly opts in (no active workflow + tracked id).
    return empty;
  }
  if (!lastOperationMatchesWorkflow(lastOp, workflowId) && opWf) return empty;

  return {
    result:
      asTrimmedString(lastOp.result) || asTrimmedString(lastOp.state) || null,
    activity: asTrimmedString(lastOp.activity),
    releaseReason:
      asTrimmedString(lastOp.release_reason) ||
      asTrimmedString(lastOp.disconnect_reason),
    finishedAt:
      (lastOp.finished_at as string | number | null | undefined) ??
      (lastOp.terminal_at as string | number | null | undefined) ??
      null,
    targetWaterMl: readPayloadNumber(lastOp, [
      "target_dispensed_water_ml",
      "target_water_ml",
      "volume_ml",
    ]),
    dispensedWaterMl: readPayloadNumber(lastOp, [
      "dispensed_water_ml",
      "water_ml",
    ]),
    cupDeltaG: readPayloadNumber(lastOp, ["cup_delta_g", "coffee_g"]),
    source: "last_operation",
  };
}

// ---------------------------------------------------------------------------
// Events: observation epoch, instance change, gap, merge/dedupe
// ---------------------------------------------------------------------------

/**
 * Observation token for rejecting stale async event responses.
 * generation increments on tracked-workflow identity changes and instance changes.
 */
export type EventObservationToken = {
  workflowId: string;
  generation: number;
};

export type EventObservationCurrent = {
  workflowId: string | null;
  generation: number;
};

/** Capture token for a page / zero-resync request. */
export function captureEventObservation(
  workflowId: string,
  generation: number,
): EventObservationToken {
  return { workflowId, generation };
}

/**
 * True only when the response still belongs to the current observation
 * (same workflow identity and generation epoch).
 */
export function isEventObservationCurrent(
  captured: EventObservationToken,
  current: EventObservationCurrent,
): boolean {
  const capturedWf = asTrimmedString(captured.workflowId);
  const currentWf = asTrimmedString(current.workflowId);
  if (!capturedWf || !currentWf) return false;
  if (capturedWf !== currentWf) return false;
  return captured.generation === current.generation;
}

export type EventCursorState = {
  since: number;
  instanceId: string | null;
  /** One-shot guard so gap resync from zero happens at most once per gap. */
  gapResyncArmed: boolean;
};

export function initialEventCursor(
  instanceId: string | null = null,
): EventCursorState {
  return { since: 0, instanceId, gapResyncArmed: true };
}

/**
 * On instance_id change: reset cursor and resync durable events from since=0
 * without reconnecting BLE. Caller should also bump observation generation.
 */
export function applyInstanceChange(
  cursor: EventCursorState,
  nextInstanceId: string | null | undefined,
): { cursor: EventCursorState; reset: boolean } {
  const next = asTrimmedString(nextInstanceId);
  const prev = asTrimmedString(cursor.instanceId);
  if (next && prev && next !== prev) {
    return {
      cursor: { since: 0, instanceId: next, gapResyncArmed: true },
      reset: true,
    };
  }
  if (next && !prev) {
    return {
      cursor: { ...cursor, instanceId: next },
      reset: false,
    };
  }
  return { cursor, reset: false };
}

/**
 * On gap_detected: clear/reset and perform one guarded resync from zero.
 * Subsequent gaps while still armed=false do not loop forever.
 */
export function applyGapDetected(
  cursor: EventCursorState,
  gapDetected: boolean,
): { cursor: EventCursorState; clearEvents: boolean; resyncFromZero: boolean } {
  if (!gapDetected) {
    return {
      cursor: { ...cursor, gapResyncArmed: true },
      clearEvents: false,
      resyncFromZero: false,
    };
  }
  if (!cursor.gapResyncArmed) {
    return { cursor, clearEvents: false, resyncFromZero: false };
  }
  return {
    cursor: {
      since: 0,
      instanceId: cursor.instanceId,
      gapResyncArmed: false,
    },
    clearEvents: true,
    resyncFromZero: true,
  };
}

/**
 * Handle the result of the one guarded since=0 resync.
 * If the resync itself reports gap_detected (e.g. unknown_workflow), do not
 * accept a misleading timeline; keep the guard disarmed and surface a warning.
 * A later workflow/instance change or explicit refresh may rearm and retry.
 */
export function applyResyncPageResult(
  cursor: EventCursorState,
  opts: {
    gapDetected: boolean;
    gapReason?: string | null;
    nextSince?: number | null;
  },
): {
  cursor: EventCursorState;
  acceptEvents: boolean;
  clearEvents: boolean;
  persistentGap: boolean;
  gapReason: string | null;
} {
  const reason = asTrimmedString(opts.gapReason);
  if (opts.gapDetected) {
    return {
      cursor: {
        since: 0,
        instanceId: cursor.instanceId,
        // Stay disarmed: avoid immediate resync loop.
        gapResyncArmed: false,
      },
      acceptEvents: false,
      clearEvents: true,
      persistentGap: true,
      gapReason: reason || "gap_detected",
    };
  }
  const next =
    typeof opts.nextSince === "number" && Number.isFinite(opts.nextSince)
      ? opts.nextSince
      : cursor.since;
  return {
    cursor: {
      ...cursor,
      since: next,
      // Clean resync: re-arm so a future gap can attempt one more resync.
      gapResyncArmed: true,
    },
    acceptEvents: true,
    clearEvents: false,
    persistentGap: false,
    gapReason: null,
  };
}

/**
 * Explicit refresh / successful control may rearm the one-gap resync and
 * reset the event cursor from zero. Bump observation generation so any
 * in-flight event response for the old epoch is rejected.
 *
 * Caller must apply this before the in-flight guard so intent survives when
 * a background poll is already running.
 */
export function applyExplicitEventRearm(
  cursor: EventCursorState,
  generation: number,
): { cursor: EventCursorState; generation: number } {
  return {
    cursor: {
      ...cursor,
      since: 0,
      gapResyncArmed: true,
    },
    generation: generation + 1,
  };
}

/** Compact operational warning for a persistent event gap (no resync mechanics). */
export function formatEventSyncWarning(gapReason: string | null | undefined): string {
  const reason = asTrimmedString(gapReason) || "gap_detected";
  if (reason === "unknown_workflow") {
    return "Timeline unavailable: unknown workflow. Refresh when the workflow is active, or open a new brew.";
  }
  return "Timeline unavailable. Refresh to retry.";
}

/**
 * Merge incoming durable events: dedupe by seq, sort ascending, cap rows.
 */
export function mergeDurableEvents(
  existing: BridgeEvent[],
  incoming: BridgeEvent[],
  cap: number = EVENT_TIMELINE_CAP,
): BridgeEvent[] {
  const bySeq = new Map<number, BridgeEvent>();
  for (const ev of existing) {
    const seq = Number(ev.seq);
    if (!Number.isFinite(seq)) continue;
    bySeq.set(seq, ev);
  }
  for (const ev of incoming) {
    const seq = Number(ev.seq);
    if (!Number.isFinite(seq)) continue;
    bySeq.set(seq, ev);
  }
  const sorted = Array.from(bySeq.values()).sort(
    (a, b) => Number(a.seq) - Number(b.seq),
  );
  if (sorted.length <= cap) return sorted;
  return sorted.slice(sorted.length - cap);
}

export function nextSinceFromEvents(
  events: BridgeEvent[],
  fallback: number,
): number {
  if (!events.length) return fallback;
  let max = fallback;
  for (const ev of events) {
    const seq = Number(ev.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

export function pickNumber(
  obj: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

export function formatMaybeNumber(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function statusPollIntervalMs(
  bridge: BridgeState | null | undefined,
  trackedId: string | null,
): number {
  const active = asTrimmedString(bridge?.active_workflow_id);
  const phase = asTrimmedString(bridge?.phase);
  if (active || (trackedId && phase && !isTerminalState(phase))) {
    return STATUS_POLL_ACTIVE_MS;
  }
  if (bridge?.release_pending) return STATUS_POLL_ACTIVE_MS;
  return STATUS_POLL_IDLE_MS;
}
