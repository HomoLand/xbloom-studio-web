/**
 * Dashboard / Monitor (Phase C5-C8).
 *
 * - Tracks exact workflow via active_workflow_id, then summary, then local ID.
 * - Passive status/events polls only (no ensure daemon / BLE side effects).
 * - Controls mint a fresh request_id per click; never invent workflow_id.
 * - Closing/unmounting never stop/cancel/disconnect.
 * - No manual disconnect in workflow UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Beaker,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  XCircle,
} from "lucide-react";
import {
  api,
  newRequestId,
  type BridgeEvent,
  type BridgeState,
} from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import {
  Alert,
  Button,
  IconButton,
  MatrixReadout,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from "../components/ui";
import { classifyOperationalError } from "../lib/apiErrors";
import { useI18n } from "../i18n/I18nContext";
import { isStaticDeploy } from "../lib/deploy";
import { sampleCoffeeIfEmpty } from "../lib/localRecipes";
import { useMachine } from "../machine/MachineContext";
import {
  applyExplicitEventRearm,
  applyGapDetected,
  applyInstanceChange,
  applyResyncPageResult,
  asTrimmedString,
  bleReleaseLabel,
  buildFinalSummary,
  captureEventObservation,
  EVENTS_POLL_MS,
  findLatestTerminalEvent,
  formatEventSyncWarning,
  formatMaybeNumber,
  hasDurableTerminal,
  initialEventCursor,
  isEventObservationCurrent,
  mergeDurableEvents,
  normalizePhase,
  pickNumber,
  readRecoveryState,
  readWorkflowSummary,
  resolveControlWorkflowId,
  selectTrackedWorkflowId,
  statusPollIntervalMs,
  validControlsForPhase,
  type ControlAction,
  type EventCursorState,
} from "../lib/monitorLogic";
import { formatEpochSeconds, shortId } from "../lib/recipeDomain";
import {
  isWorkflowStorageKey,
  readStoredWorkflow,
  type StoredWorkflow,
} from "../lib/workflowStore";

type ActionBusy = ControlAction | null;
type ObserveHealth = "ok" | "stale" | "offline";

type StatusPollOpts = {
  /** Clear sticky external-busy only on explicit user refresh / successful control. */
  clearStickyBusy?: boolean;
};

type EventsPollOpts = {
  /** Explicit refresh may rearm the one-gap resync guard. */
  rearmGap?: boolean;
};

export default function Dashboard() {
  const { t } = useI18n();
  const { driver, bleSnapshot, bleSession, connectBle, disconnectBle } =
    useMachine();
  const webBle = driver === "web-bluetooth";
  const staticDeploy = isStaticDeploy();
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [stored, setStored] = useState<StoredWorkflow | null>(() =>
    readStoredWorkflow(),
  );
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [observeHealth, setObserveHealth] = useState<ObserveHealth>("ok");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusGuidance, setStatusGuidance] = useState<string | null>(null);
  /** Sticky device_busy_external banner until explicit refresh/control clears it. */
  const [busyExternalBanner, setBusyExternalBanner] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionGuidance, setActionGuidance] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<ActionBusy>(null);
  const [staleMismatch, setStaleMismatch] = useState(false);
  const [eventSyncWarning, setEventSyncWarning] = useState<string | null>(null);
  /** Event observation failures are separate from status health/errors. */
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventGuidance, setEventGuidance] = useState<string | null>(null);
  /**
   * UI-only acknowledgement of the active workflow when page storage is stale.
   * Storage is never rewritten; no hardware mutation on acknowledgement.
   */
  const [ackedActiveId, setAckedActiveId] = useState<string | null>(null);

  const statusInFlight = useRef(false);
  const eventsInFlight = useRef(false);
  const cursorRef = useRef<EventCursorState>(initialEventCursor());
  const bridgeRef = useRef<BridgeState | null>(null);
  const trackedRef = useRef<string | null>(null);
  /** Bumps on tracked workflow identity change and daemon instance change. */
  const eventGenerationRef = useRef(0);
  const stopPollsRef = useRef(false);
  /** Auth expired: stop polls so we do not loop 401s. */
  const authStoppedRef = useRef(false);
  /**
   * Explicit clearStickyBusy intent queued across in-flight status polls.
   * Consumed only after a successful status response.
   */
  const clearStickyBusyPendingRef = useRef(false);

  const summary = useMemo(() => readWorkflowSummary(bridge), [bridge]);
  const recovery = useMemo(() => readRecoveryState(bridge), [bridge]);
  const trackedId = useMemo(
    () => selectTrackedWorkflowId(bridge, stored?.workflowId ?? null),
    [bridge, stored],
  );
  const phase = useMemo(
    () => normalizePhase(bridge, summary),
    [bridge, summary],
  );
  const recoveryRequired = Boolean(recovery?.required);

  // Stale page mismatch: storage stays old until user acknowledges active ID.
  const controlResolution = useMemo(
    () =>
      resolveControlWorkflowId(
        bridge,
        stored?.workflowId ?? trackedId ?? null,
        ackedActiveId,
      ),
    [bridge, stored, trackedId, ackedActiveId],
  );

  const terminalEvent = useMemo(
    () => findLatestTerminalEvent(events, trackedId),
    [events, trackedId],
  );
  const terminalEventProof = Boolean(terminalEvent);

  const controls = useMemo(
    () => validControlsForPhase(phase, { recoveryRequired }),
    [phase, recoveryRequired],
  );
  const durableTerminal = useMemo(
    () =>
      hasDurableTerminal(bridge, summary, {
        terminalEventProof,
      }),
    [bridge, summary, terminalEventProof],
  );

  const finalSummary = useMemo(() => {
    const lastOp =
      bridge?.last_operation && typeof bridge.last_operation === "object"
        ? (bridge.last_operation as Record<string, unknown>)
        : null;
    const opWf =
      lastOp &&
      (asTrimmedString(lastOp.workflow_id) ||
        asTrimmedString(lastOp.workflowId));
    // Allow last_operation without workflow field only when no active workflow
    // (same-workflow fallback after terminal).
    const allowLastOpWithoutWorkflowField =
      !asTrimmedString(bridge?.active_workflow_id) && !opWf;
    return buildFinalSummary(events, trackedId, lastOp, {
      allowLastOpWithoutWorkflowField,
    });
  }, [bridge, events, trackedId]);

  const release = useMemo(
    () =>
      bleReleaseLabel(bridge, summary, {
        terminalEventProof,
        // Correlate last_disconnect_* with this workflow's terminal time.
        terminalFinishedAt: finalSummary.finishedAt,
      }),
    [bridge, summary, terminalEventProof, finalSummary.finishedAt],
  );

  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  useEffect(() => {
    trackedRef.current = trackedId;
  }, [trackedId]);

  useEffect(() => {
    setStaleMismatch(controlResolution.staleMismatch);
  }, [controlResolution.staleMismatch]);

  // Cross-tab localStorage: refresh stored ID only (no hardware side effects).
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (!isWorkflowStorageKey(ev.key)) return;
      setStored(readStoredWorkflow());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Unmount: stop polls only. Never cancel/stop/disconnect.
  useEffect(() => {
    stopPollsRef.current = false;
    return () => {
      stopPollsRef.current = true;
    };
  }, []);

  const applyStatusSuccess = useCallback(
    (b: BridgeState, opts?: StatusPollOpts) => {
      setBridge(b);
      setObserveHealth(b.running === false ? "offline" : "ok");
      setStatusError(null);
      setStatusGuidance(null);
      // Status success must not clear event observation errors.
      // Passive status cannot prove another BLE owner released the link.
      if (opts?.clearStickyBusy) {
        setBusyExternalBanner(null);
      }

      const inst = asTrimmedString(b.instance_id);
      const applied = applyInstanceChange(cursorRef.current, inst);
      if (applied.reset) {
        // Instance change: bump observation generation so in-flight event
        // responses for the old instance cannot overwrite the new timeline.
        eventGenerationRef.current += 1;
        cursorRef.current = applied.cursor;
        setEvents([]);
        setEventSyncWarning(null);
      } else if (inst && !cursorRef.current.instanceId) {
        cursorRef.current = { ...cursorRef.current, instanceId: inst };
      }

      // Do not fabricate or overwrite stored workflow metadata.
      // active_workflow_id already wins selection via selectTrackedWorkflowId.
    },
    [],
  );

  const handleObserveFailure = useCallback(
    (e: unknown, surface: "status" | "events") => {
      const c = classifyOperationalError(e, {
        context: surface === "status" ? "Bridge status" : "Events",
        knownWorkflowId: trackedRef.current ?? undefined,
      });
      if (c.authExpired) {
        authStoppedRef.current = true;
        setStatusError(c.message);
        setStatusGuidance(c.action);
        setObserveHealth("offline");
        return;
      }
      if (surface === "events") {
        // Keep event failures off statusError so status success cannot clear them.
        setEventError(c.message);
        setEventGuidance(c.action);
        setObserveHealth(bridgeRef.current ? "stale" : "offline");
        return;
      }
      if (c.stickyBusy) {
        setBusyExternalBanner(c.message);
        setStatusGuidance(c.action);
      } else {
        setStatusError(c.message);
        setStatusGuidance(c.action);
      }
      // Failures show stale/offline, not endless loading.
      setObserveHealth(bridgeRef.current ? "stale" : "offline");
    },
    [],
  );

  const pollStatus = useCallback(
    async (opts?: StatusPollOpts) => {
      if (stopPollsRef.current || authStoppedRef.current) return;
      // Static Pages: no bridge HTTP — skip poll noise.
      if (isStaticDeploy()) {
        setLoading(false);
        setObserveHealth("ok");
        setBridge(null);
        return;
      }
      // Queue clear intent before the in-flight guard so it survives a busy poll.
      if (opts?.clearStickyBusy) {
        clearStickyBusyPendingRef.current = true;
      }
      if (statusInFlight.current) return;
      statusInFlight.current = true;
      try {
        const b = await api.bridge();
        if (stopPollsRef.current) return;
        // Consume queued clear only after a successful status response.
        const clearSticky = clearStickyBusyPendingRef.current;
        if (clearSticky) {
          clearStickyBusyPendingRef.current = false;
        }
        applyStatusSuccess(b, { clearStickyBusy: clearSticky });
      } catch (e) {
        if (stopPollsRef.current) return;
        // Failed response must not clear sticky busy or consume the intent.
        handleObserveFailure(e, "status");
      } finally {
        statusInFlight.current = false;
        // Do not call React setters after unmount.
        if (!stopPollsRef.current) {
          setLoading(false);
        }
      }
    },
    [applyStatusSuccess, handleObserveFailure],
  );

  const pollEvents = useCallback(
    async (opts?: EventsPollOpts) => {
      if (stopPollsRef.current || authStoppedRef.current) return;
      if (isStaticDeploy()) return;

      // Rearm/reset + generation bump before the in-flight guard so explicit
      // refresh invalidates the old response and the next poll starts from zero.
      if (opts?.rearmGap) {
        const rearmed = applyExplicitEventRearm(
          cursorRef.current,
          eventGenerationRef.current,
        );
        cursorRef.current = rearmed.cursor;
        eventGenerationRef.current = rearmed.generation;
        setEventSyncWarning(null);
      }

      if (eventsInFlight.current) return;
      const workflowId = trackedRef.current;
      if (!workflowId) return;

      // Capture observation token before the request.
      const generation = eventGenerationRef.current;
      const token = captureEventObservation(workflowId, generation);

      eventsInFlight.current = true;
      try {
        const since = cursorRef.current.since;
        const page = await api.bridgeEvents(workflowId, since);
        if (stopPollsRef.current) return;
        if (
          !isEventObservationCurrent(token, {
            workflowId: trackedRef.current,
            generation: eventGenerationRef.current,
          })
        ) {
          return;
        }

        // Guard: ignore pages for a different workflow after switch.
        if (
          page.workflow_id &&
          asTrimmedString(page.workflow_id) !== workflowId
        ) {
          return;
        }

        const gap = applyGapDetected(
          cursorRef.current,
          Boolean(page.gap_detected),
        );
        if (gap.clearEvents) {
          setEvents([]);
        }
        cursorRef.current = gap.cursor;

        if (gap.resyncFromZero) {
          // One guarded resync from zero (still observation-only).
          const full = await api.bridgeEvents(workflowId, 0);
          if (stopPollsRef.current) return;
          if (
            !isEventObservationCurrent(token, {
              workflowId: trackedRef.current,
              generation: eventGenerationRef.current,
            })
          ) {
            return;
          }
          // Verify workflow_id on the full page as well.
          if (
            full.workflow_id &&
            asTrimmedString(full.workflow_id) !== workflowId
          ) {
            return;
          }

          const resync = applyResyncPageResult(cursorRef.current, {
            gapDetected: Boolean(full.gap_detected),
            gapReason: full.gap_reason ?? page.gap_reason ?? null,
            nextSince:
              typeof full.next_since === "number" ? full.next_since : null,
          });
          cursorRef.current = resync.cursor;

          if (resync.persistentGap) {
            if (resync.clearEvents) setEvents([]);
            setEventSyncWarning(formatEventSyncWarning(resync.gapReason));
            return;
          }

          setEventSyncWarning(null);
          setEventError(null);
          setEventGuidance(null);
          if (resync.acceptEvents) {
            const merged = mergeDurableEvents([], full.events ?? []);
            setEvents(merged);
          }
          return;
        }

        // Non-gap (or disarmed gap with no resync): accept incremental page.
        if (page.gap_detected && !gap.resyncFromZero) {
          // Guard already used; surface warning once, no resync loop.
          const reason =
            asTrimmedString(page.gap_reason) || "gap_detected";
          setEventSyncWarning((prev) =>
            prev ?? formatEventSyncWarning(reason),
          );
          return;
        }

        setEventSyncWarning(null);
        setEventError(null);
        setEventGuidance(null);
        const incoming = page.events ?? [];
        setEvents((prev) => mergeDurableEvents(prev, incoming));
        if (typeof page.next_since === "number") {
          cursorRef.current = {
            ...cursorRef.current,
            since: page.next_since,
          };
        }
      } catch (e) {
        if (stopPollsRef.current) return;
        if (
          !isEventObservationCurrent(token, {
            workflowId: trackedRef.current,
            generation: eventGenerationRef.current,
          })
        ) {
          return;
        }
        // Events failures mark stale; do not wipe timeline or statusError.
        handleObserveFailure(e, "events");
      } finally {
        eventsInFlight.current = false;
      }
    },
    [handleObserveFailure],
  );

  // Status poll loop (non-overlapping, adaptive interval).
  useEffect(() => {
    void pollStatus();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const schedule = () => {
      if (cancelled || stopPollsRef.current || authStoppedRef.current) return;
      const ms = statusPollIntervalMs(bridgeRef.current, trackedRef.current);
      timer = setTimeout(async () => {
        await pollStatus();
        schedule();
      }, ms);
    };
    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollStatus]);

  // Event poll loop - only when exact tracked ID exists.
  useEffect(() => {
    if (!trackedId) return;
    // Reset cursor and bump observation generation on workflow identity change.
    eventGenerationRef.current += 1;
    cursorRef.current = {
      ...initialEventCursor(cursorRef.current.instanceId),
    };
    setEvents([]);
    setEventSyncWarning(null);
    setEventError(null);
    setEventGuidance(null);
    void pollEvents();

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const schedule = () => {
      if (cancelled || stopPollsRef.current || authStoppedRef.current) return;
      timer = setTimeout(async () => {
        await pollEvents();
        schedule();
      }, EVENTS_POLL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackedId, pollEvents]);

  const runControl = useCallback(
    async (action: ControlAction) => {
      if (actionBusy) return;
      setActionError(null);
      setActionGuidance(null);

      // Web Bluetooth path: cancel must hit the GATT session, not bridge HTTP.
      // After a successful web-ble start the dialog navigates here; cancel must
      // remain available while loaded/running without a bridge workflow.
      if (webBle && action === "cancel") {
        setActionBusy(action);
        try {
          await bleSession.cancelBrew();
          setStored(readStoredWorkflow());
        } catch (e) {
          setActionError(e instanceof Error ? e.message : String(e));
          setActionGuidance(
            "Cancel over Web Bluetooth failed. Retry or disconnect from Settings.",
          );
        } finally {
          if (!stopPollsRef.current) setActionBusy(null);
        }
        return;
      }

      if (webBle && (action === "pause" || action === "resume" || action === "stop" || action === "reconcile")) {
        setActionError(`${action} is not available on Web Bluetooth yet`);
        setActionGuidance("Use Cancel for Web Bluetooth, or switch driver to bridge.");
        return;
      }

      const resolution = resolveControlWorkflowId(
        bridgeRef.current,
        stored?.workflowId ?? trackedRef.current,
        ackedActiveId,
      );
      if (resolution.staleMismatch || resolution.needsAcknowledgement) {
        setStaleMismatch(true);
        setActionError("Page workflow is stale");
        setActionGuidance(
          resolution.actualActiveId
            ? `Active workflow is ${shortId(resolution.actualActiveId, 14)}. Use active workflow before controlling.`
            : "Acknowledge the active workflow before controlling.",
        );
        // Do not synthesize kind/revision into local storage.
        // Do not silently execute against the newly active workflow.
        void pollStatus();
        return;
      }

      const workflowId = resolution.controlId;
      if (!workflowId) {
        setActionError("No workflow to control");
        setActionGuidance("Load or start a recipe first.");
        return;
      }

      setActionBusy(action);
      try {
        if (action === "reconcile") {
          // recovery/reconcile: workflow_id + optional address/scan_timeout only.
          await api.recoveryReconcile(workflowId);
        } else {
          const requestId = newRequestId(action);
          if (action === "pause") {
            await api.pause(workflowId, requestId);
          } else if (action === "resume") {
            await api.resume(workflowId, requestId);
          } else if (action === "stop") {
            await api.stop(workflowId, requestId);
          } else if (action === "cancel") {
            await api.cancel(workflowId, requestId);
          }
        }
        // Successful corrective action: clear sticky busy and refresh
        // (same queued rearm / clearSticky intent as explicit refresh).
        await pollStatus({ clearStickyBusy: true });
        await pollEvents({ rearmGap: true });
      } catch (e) {
        const c = classifyOperationalError(e, {
          context: action,
          knownWorkflowId: workflowId,
        });
        if (c.authExpired) {
          authStoppedRef.current = true;
        }
        setActionError(c.message);
        setActionGuidance(c.action);
        if (c.stickyBusy) {
          setBusyExternalBanner(c.message);
        }
        if (c.kind === "workflow_mismatch") {
          setStaleMismatch(true);
          void pollStatus();
        }
        // Uncertain: preserve exact ID; never auto-repeat.
      } finally {
        // Do not call React setters after unmount.
        if (!stopPollsRef.current) {
          setActionBusy(null);
        }
      }
    },
    [
      ackedActiveId,
      actionBusy,
      bleSession,
      pollEvents,
      pollStatus,
      stored?.workflowId,
      webBle,
    ],
  );

  const webBleCanCancel =
    webBle &&
    (bleSnapshot.phase === "loading" ||
      bleSnapshot.phase === "armed" ||
      bleSnapshot.phase === "starting" ||
      bleSnapshot.phase === "brewing" ||
      bleSnapshot.loaded);

  // connection_scope null -> none; do not invent daemon/connected (own pills).
  const connectionScope =
    asTrimmedString(bridge?.connection_scope) || "none";

  // Workflow source from summary.source only; never invent bridge/local.
  const workflowSource = asTrimmedString(summary?.source) || "-";

  // Display kind/revision from server summary only; stored is exact load/start data.
  const displayKind =
    asTrimmedString(summary?.kind) ||
    (stored?.workflowId && stored.workflowId === trackedId
      ? stored.kind
      : null) ||
    "-";
  const displayRevision =
    asTrimmedString(summary?.recipe_revision_id) ||
    (stored?.workflowId &&
    stored.workflowId === trackedId &&
    stored.recipeRevisionId
      ? stored.recipeRevisionId
      : null);

  return (
    <div>
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.desc")}
        actions={
          !staticDeploy ? (
            <IconButton
              label="Refresh status"
              onClick={() => {
                void pollStatus({ clearStickyBusy: true });
                void pollEvents({ rearmGap: true });
              }}
              disabled={actionBusy !== null}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
            </IconButton>
          ) : null
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Link
          to="/design"
          className="rounded-2xl border border-line bg-surface p-4 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Sparkles className="h-4 w-4 text-brand" aria-hidden />
            {t("dashboard.design")}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            {t("dashboard.designHint")}
          </p>
        </Link>
        <Link
          to="/recipes"
          className="rounded-2xl border border-line bg-surface p-4 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Beaker className="h-4 w-4 text-accent-blue" aria-hidden />
            {t("dashboard.recipes")}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            {t("dashboard.recipesHint")}
          </p>
        </Link>
      </div>

      {webBle ? (
        <Panel title={t("dashboard.webBle")} className="mb-4">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <StatusPill
                tone={
                  bleSnapshot.phase === "connected" ||
                  bleSnapshot.phase === "armed" ||
                  bleSnapshot.phase === "brewing" ||
                  bleSnapshot.phase === "starting" ||
                  bleSnapshot.phase === "loading"
                    ? "green"
                    : bleSnapshot.phase === "error"
                      ? "red"
                      : "neutral"
                }
              >
                {bleSnapshot.phase}
              </StatusPill>
              {bleSnapshot.machineStateName ? (
                <StatusPill tone="blue">{bleSnapshot.machineStateName}</StatusPill>
              ) : null}
              {bleSnapshot.loaded ? (
                <StatusPill tone="amber">recipe loaded</StatusPill>
              ) : null}
            </div>

            {/* Live View–style machine hero + matrix readouts */}
            <div className="overflow-hidden rounded-2xl bg-surface-2">
              <div className="flex flex-col items-center px-4 pb-2 pt-6">
                <img
                  src={`${import.meta.env.BASE_URL}studio-machine.png`}
                  alt=""
                  className="h-36 w-auto opacity-95 drop-shadow-[0_16px_40px_rgba(0,0,0,0.55)] sm:h-44"
                  draggable={false}
                />
                <div className="mt-3 text-center">
                  <div className="text-sm font-semibold tracking-tight text-ink">
                    {bleSnapshot.deviceName || "xBloom [Studio]"}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-faint">
                    {bleSnapshot.machineStateName ?? bleSnapshot.phase}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-line px-4 py-5">
                <MatrixReadout
                  label={t("dashboard.cup")}
                  value={
                    bleSnapshot.cupWeightG != null
                      ? bleSnapshot.cupWeightG.toFixed(1)
                      : "—"
                  }
                  unit={bleSnapshot.cupWeightG != null ? "g" : undefined}
                />
                <MatrixReadout
                  label={t("dashboard.water")}
                  value={
                    bleSnapshot.dispensedWaterMl != null
                      ? String(Math.round(bleSnapshot.dispensedWaterMl))
                      : "—"
                  }
                  unit={bleSnapshot.dispensedWaterMl != null ? "ml" : undefined}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {bleSnapshot.phase === "connecting" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={actionBusy !== null}
                  onClick={() => {
                    bleSession.abortConnect();
                    setActionError(null);
                  }}
                >
                  {t("dashboard.cancelConnecting")}
                </Button>
              ) : bleSnapshot.phase === "idle" ||
                bleSnapshot.phase === "disconnected" ||
                bleSnapshot.phase === "error" ||
                bleSnapshot.phase === "terminal" ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={actionBusy !== null}
                  onClick={() => {
                    // First await inside connect must be requestDevice (gesture).
                    setActionError(null);
                    void connectBle().catch((e) =>
                      setActionError(
                        e instanceof Error ? e.message : String(e),
                      ),
                    );
                  }}
                >
                  {t("dashboard.connect")}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={actionBusy !== null}
                  onClick={() => {
                    void disconnectBle().catch((e) =>
                      setActionError(
                        e instanceof Error ? e.message : String(e),
                      ),
                    );
                  }}
                >
                  {t("dashboard.disconnect")}
                </Button>
              )}
              <Button
                variant="brand"
                size="sm"
                disabled={actionBusy !== null}
                onClick={() => {
                  const content = sampleCoffeeIfEmpty();
                  setBrewTarget({
                    recipeRevisionId: "local:sample-hot-v1",
                    content,
                    recipeName: content.name,
                  });
                }}
              >
                {t("dashboard.brewSample")}
              </Button>
              {webBleCanCancel ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={actionBusy !== null}
                  onClick={() => void runControl("cancel")}
                >
                  <XCircle className="h-3.5 w-3.5" aria-hidden />
                  {actionBusy === "cancel"
                    ? t("dashboard.cancelling")
                    : t("dashboard.cancelBrew")}
                </Button>
              ) : null}
            </div>
            {staticDeploy ? (
              <p className="text-xs text-ink-muted">{t("dashboard.staticHint")}</p>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <BrewConfirmDialog
        open={brewTarget != null}
        target={brewTarget}
        onClose={() => setBrewTarget(null)}
        onStarted={() => {
          setBrewTarget(null);
        }}
      />

      {busyExternalBanner ? (
        <Alert tone="amber" title="Device busy (external)" className="mb-4">
          {busyExternalBanner}
          <div className="mt-1 text-xs opacity-90">
            Free the link on the other device, then refresh.
          </div>
        </Alert>
      ) : null}

      {staleMismatch ? (
        <Alert tone="amber" title="Workflow switched" className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
              Showing the active bridge workflow
              {controlResolution.actualActiveId
                ? ` (${shortId(controlResolution.actualActiveId, 14)})`
                : ""}
              . Controls are disabled until you use the active workflow.
            </div>
            {controlResolution.actualActiveId ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  // UI-only acknowledgement: storage untouched, no hardware call.
                  setAckedActiveId(controlResolution.actualActiveId);
                  setStaleMismatch(false);
                  setActionError(null);
                  setActionGuidance(null);
                }}
              >
                Use active workflow
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      {eventSyncWarning ? (
        <Alert tone="amber" title="Event sync" className="mb-4">
          {eventSyncWarning}
        </Alert>
      ) : null}

      {eventError ? (
        <Alert tone="red" className="mb-4" title="Events">
          {eventError}
          {eventGuidance ? (
            <div className="mt-1 text-xs opacity-90">{eventGuidance}</div>
          ) : null}
        </Alert>
      ) : null}

      {statusError ? (
        <Alert tone="red" className="mb-4" title="Status">
          {statusError}
          {statusGuidance ? (
            <div className="mt-1 text-xs opacity-90">{statusGuidance}</div>
          ) : null}
        </Alert>
      ) : null}

      {actionError ? (
        <Alert tone="red" className="mb-4" title="Control">
          {actionError}
          {actionGuidance ? (
            <div className="mt-1 text-xs opacity-90">{actionGuidance}</div>
          ) : null}
        </Alert>
      ) : null}

      {recoveryRequired ? (
        <Alert tone="amber" title="Recovery required" className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
              Reconcile needed for workflow{" "}
              <code className="text-ink">
                {shortId(
                  controlResolution.controlId || trackedId || "",
                  16,
                )}
              </code>
              .
              {recovery?.detail ? (
                <div className="mt-1 text-xs opacity-90">
                  {formatRecoveryDetail(recovery.detail)}
                </div>
              ) : null}
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={
                actionBusy !== null ||
                !controlResolution.controlId ||
                controlResolution.staleMismatch ||
                controlResolution.needsAcknowledgement
              }
              onClick={() => void runControl("reconcile")}
            >
              {actionBusy === "reconcile" ? "Reconciling..." : "Reconcile"}
            </Button>
          </div>
        </Alert>
      ) : null}

      <Panel
        title="Bridge"
        action={
          observeHealth !== "ok" ? (
            <StatusPill tone={observeHealth === "offline" ? "red" : "amber"}>
              {observeHealth === "offline" ? "Offline" : "Stale"}
            </StatusPill>
          ) : null
        }
      >
        {loading && !bridge ? (
          <Spinner label="Loading bridge status" />
        ) : bridge ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <StatusPill tone={bridge.running ? "green" : "red"}>
                {bridge.running ? "Daemon running" : "Daemon stopped"}
              </StatusPill>
              <StatusPill tone={bridge.connected ? "green" : "neutral"}>
                {bridge.connected ? "Machine linked" : "Not linked"}
              </StatusPill>
              <StatusPill tone="blue">{connectionScope}</StatusPill>
              {recoveryRequired ? (
                <StatusPill tone="amber">recovery</StatusPill>
              ) : null}
              {bridge.release_pending ? (
                <StatusPill tone="amber">release pending</StatusPill>
              ) : null}
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <FieldRow label="Machine" value={bridge.machine ?? "-"} />
              <FieldRow
                label="Firmware"
                value={asTrimmedString(bridge.firmware) ?? "-"}
              />
              <FieldRow label="Connection scope" value={connectionScope} />
              <FieldRow label="Workflow source" value={workflowSource} />
              <FieldRow
                label="Recovery"
                value={
                  recoveryRequired ? "required" : recovery ? "clear" : "-"
                }
              />
              <FieldRow
                label="Last BLE release"
                value={formatDisconnect(bridge)}
              />
              {bridge.last_disconnect_error ? (
                <FieldRow
                  label="Release error"
                  value={String(bridge.last_disconnect_error)}
                />
              ) : null}
              <FieldRow
                label="Activity"
                value={asTrimmedString(bridge.activity) ?? "idle"}
              />
              <FieldRow label="Phase" value={phase ?? "-"} />
              <FieldRow
                label="Instance"
                value={
                  asTrimmedString(bridge.instance_id)
                    ? shortId(String(bridge.instance_id), 12)
                    : "-"
                }
              />
            </dl>
            {bridge.last_error ? (
              <Alert tone="amber" title="Last error">
                {String(bridge.last_error)}
              </Alert>
            ) : null}
            {!bridge.running ? (
              <p className="text-xs leading-relaxed text-ink-muted">
                Bridge is not running. Restart the host if needed.
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyMachineHint />
        )}
      </Panel>

      <Panel title="Workflow" className="mt-4">
        {!trackedId ? (
          <div>
            <p className="text-sm text-ink-muted">
              No active workflow. Design or open a recipe to brew.
            </p>
            <div className="mt-4">
              <EmptyMachineHint compact />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <FieldRow label="Workflow" value={shortId(trackedId, 18)} />
              <FieldRow label="Kind" value={displayKind} />
              <FieldRow
                label="State"
                value={
                  asTrimmedString(summary?.state) ??
                  finalSummary.result ??
                  phase ??
                  "-"
                }
              />
              <FieldRow
                label="Revision"
                value={
                  displayRevision ? shortId(String(displayRevision), 12) : "-"
                }
              />
            </dl>
            <div className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] break-all text-ink">
              {trackedId}
            </div>

            {/* Controls hidden until stale active-workflow is acknowledged. */}
            {!staleMismatch &&
            controlResolution.controlId &&
            (!durableTerminal || recoveryRequired) ? (
              <div className="flex flex-wrap gap-2">
                {controls.has("cancel") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={actionBusy !== null}
                    onClick={() => void runControl("cancel")}
                  >
                    <XCircle className="h-3.5 w-3.5" aria-hidden />
                    {actionBusy === "cancel" ? "Cancelling..." : "Cancel"}
                  </Button>
                ) : null}
                {controls.has("pause") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={actionBusy !== null}
                    onClick={() => void runControl("pause")}
                  >
                    <Pause className="h-3.5 w-3.5" aria-hidden />
                    {actionBusy === "pause" ? "Pausing..." : "Pause"}
                  </Button>
                ) : null}
                {controls.has("resume") ? (
                  <Button
                    variant="success"
                    size="sm"
                    disabled={actionBusy !== null}
                    onClick={() => void runControl("resume")}
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden />
                    {actionBusy === "resume" ? "Resuming..." : "Resume"}
                  </Button>
                ) : null}
                {controls.has("stop") ? (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={actionBusy !== null}
                    onClick={() => void runControl("stop")}
                  >
                    <Square className="h-3.5 w-3.5" aria-hidden />
                    {actionBusy === "stop" ? "Stopping..." : "Stop"}
                  </Button>
                ) : null}
                {controls.has("reconcile") && !recoveryRequired ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={actionBusy !== null}
                    onClick={() => void runControl("reconcile")}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {actionBusy === "reconcile"
                      ? "Reconciling..."
                      : "Reconcile"}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <TelemetryBlock bridge={bridge} />

            {durableTerminal ? (
              <FinalSummaryPanel
                summary={finalSummary}
                release={release}
                workflowId={trackedId}
              />
            ) : null}

            <EventTimeline events={events} />
          </div>
        )}
      </Panel>
    </div>
  );
}

function FinalSummaryPanel({
  summary,
  release,
  workflowId,
}: {
  summary: ReturnType<typeof buildFinalSummary>;
  release: ReturnType<typeof bleReleaseLabel>;
  workflowId: string;
}) {
  const result = summary.result || "terminal";
  const tone =
    result === "completed" || result === "complete"
      ? "green"
      : result === "failed" || result === "error"
        ? "red"
        : "neutral";

  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill tone={tone}>{result}</StatusPill>
        {release.kind === "released" ? (
          <StatusPill tone="green">{release.text}</StatusPill>
        ) : null}
        {release.kind === "finishing" ? (
          <StatusPill tone="amber">{release.text}</StatusPill>
        ) : null}
        {release.kind === "failed" ? (
          <StatusPill tone="red">{release.text}</StatusPill>
        ) : null}
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <FieldRow label="Result" value={summary.result ?? "-"} />
        <FieldRow label="Activity" value={summary.activity ?? "-"} />
        <FieldRow
          label="Release reason"
          value={summary.releaseReason ?? "-"}
        />
        <FieldRow
          label="Finished"
          value={formatFinishedAt(summary.finishedAt)}
        />
        <FieldRow
          label="Water"
          value={formatWaterLine(
            summary.dispensedWaterMl,
            summary.targetWaterMl,
          )}
        />
        <FieldRow
          label="Cup delta"
          value={
            summary.cupDeltaG != null
              ? `${formatMaybeNumber(summary.cupDeltaG)} g`
              : "-"
          }
        />
        <FieldRow label="Workflow" value={shortId(workflowId, 14)} />
      </dl>
      <div className="mt-3">
        <Link
          to="/history"
          className="text-sm font-medium text-accent-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50"
        >
          Open history
        </Link>
      </div>
    </div>
  );
}

function formatFinishedAt(value: string | number | null | undefined): string {
  if (value == null || value === "") return "-";
  if (typeof value === "number") return formatEpochSeconds(value);
  const t = Date.parse(value);
  if (Number.isFinite(t)) {
    try {
      return new Date(t).toLocaleString();
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatWaterLine(
  dispensed: number | null,
  target: number | null,
): string {
  if (dispensed == null && target == null) return "-";
  if (dispensed != null && target != null) {
    return `${formatMaybeNumber(dispensed)} / ${formatMaybeNumber(target)} ml`;
  }
  if (dispensed != null) return `${formatMaybeNumber(dispensed)} ml`;
  return `target ${formatMaybeNumber(target)} ml`;
}

function TelemetryBlock({ bridge }: { bridge: BridgeState | null }) {
  if (!bridge) return null;
  const tel =
    bridge.telemetry && typeof bridge.telemetry === "object"
      ? (bridge.telemetry as Record<string, unknown>)
      : null;
  const targets =
    bridge.targets && typeof bridge.targets === "object"
      ? (bridge.targets as Record<string, unknown>)
      : null;
  const progress =
    bridge.liquid_progress && typeof bridge.liquid_progress === "object"
      ? (bridge.liquid_progress as Record<string, unknown>)
      : null;

  const water =
    pickNumber(progress, ["dispensed_water_ml", "water_ml"]) ??
    pickNumber(tel, [
      "water_peak_ml",
      "water_ml",
      "dispensed_water_peak_ml",
      "dispensed_water_ml",
    ]);
  const target =
    pickNumber(progress, ["target_dispensed_water_ml"]) ??
    pickNumber(targets, ["target_dispensed_water_ml", "volume_ml"]);
  const remaining = pickNumber(progress, ["remaining_ml"]);
  const cup =
    pickNumber(progress, ["cup_delta_g"]) ??
    pickNumber(tel, ["cup_delta_peak_g", "coffee_g", "cup_weight_g"]);
  const machineState = asTrimmedString(bridge.machine_state);

  if (
    water == null &&
    target == null &&
    cup == null &&
    !machineState &&
    !bridge.phase
  ) {
    return null;
  }

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-ink-muted">Live telemetry</h3>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <FieldRow label="Machine state" value={machineState ?? "-"} />
        <FieldRow
          label="Water"
          value={
            water != null
              ? `${formatMaybeNumber(water)} ml${
                  target != null ? ` / ${formatMaybeNumber(target)} ml` : ""
                }`
              : target != null
                ? `target ${formatMaybeNumber(target)} ml`
                : "-"
          }
        />
        <FieldRow
          label="Remaining"
          value={
            remaining != null ? `${formatMaybeNumber(remaining)} ml` : "-"
          }
        />
        <FieldRow
          label="Cup"
          value={cup != null ? `${formatMaybeNumber(cup)} g` : "-"}
        />
      </dl>
    </div>
  );
}

function EventTimeline({ events }: { events: BridgeEvent[] }) {
  if (!events.length) {
    return (
      <div>
        <h3 className="mb-2 text-xs font-medium text-ink-muted">
          Durable events
        </h3>
        <p className="text-xs text-ink-faint">
          No durable events yet for this workflow.
        </p>
      </div>
    );
  }
  // Show newest last; cap already applied in merge.
  const rows = events.slice(-40);
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-ink-muted">
        Durable events
        <span className="ml-1 font-normal text-ink-faint">
          ({events.length})
        </span>
      </h3>
      <ol className="max-h-64 space-y-1 overflow-auto rounded-lg border border-line bg-paper p-2 text-xs">
        {rows.map((ev) => {
          const seq = Number(ev.seq);
          const type =
            asTrimmedString(ev.event_type) ||
            asTrimmedString(ev.state_name) ||
            "event";
          const when =
            ev.created_at != null ? formatEventTime(ev.created_at) : "";
          const key = ev.id != null ? String(ev.id) : `${seq}-${type}`;
          return (
            <li
              key={key}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/70 py-1.5 last:border-0"
            >
              <span className="font-mono text-ink-faint">#{seq}</span>
              <span className="font-medium text-ink">{type}</span>
              {when ? (
                <span className="text-ink-faint">{when}</span>
              ) : null}
              {ev.payload && typeof ev.payload === "object" ? (
                <span className="basis-full truncate text-ink-muted">
                  {summarizePayload(ev.payload as Record<string, unknown>)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function summarizePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of [
    "result",
    "activity",
    "release_reason",
    "state",
    "phase",
    "dispensed_water_ml",
    "cup_delta_g",
  ] as const) {
    if (payload[key] != null && payload[key] !== "") {
      parts.push(`${key}=${String(payload[key])}`);
    }
  }
  if (!parts.length) {
    const keys = Object.keys(payload).slice(0, 3);
    return keys.map((k) => `${k}=${String(payload[k])}`).join(" ");
  }
  return parts.join(" ");
}

function formatEventTime(value: string | number): string {
  if (typeof value === "number") return formatEpochSeconds(value);
  const t = Date.parse(value);
  if (Number.isFinite(t)) {
    try {
      return new Date(t).toLocaleString();
    } catch {
      return value;
    }
  }
  return value;
}

function formatDisconnect(bridge: BridgeState): string {
  const reason = asTrimmedString(bridge.last_disconnect_reason);
  const time = bridge.last_disconnect_time;
  if (!reason && time == null) return "-";
  const when =
    time != null
      ? typeof time === "number"
        ? formatEpochSeconds(time)
        : String(time)
      : "";
  if (reason && when) return `${reason} @ ${when}`;
  return reason || when || "-";
}

function formatRecoveryDetail(detail: Record<string, unknown>): string {
  const reason = asTrimmedString(detail.reason);
  const phase = asTrimmedString(detail.phase);
  const msg = asTrimmedString(detail.message) || asTrimmedString(detail.error);
  return [reason, phase, msg].filter(Boolean).join(" | ") || "See bridge status";
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink">{value}</dd>
    </div>
  );
}

function EmptyMachineHint({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "" : "py-2"}>
      <img
        src="/studio-machine.png"
        alt=""
        className={`mx-auto opacity-75 ${compact ? "h-16" : "h-24"} w-auto`}
        draggable={false}
      />
    </div>
  );
}
