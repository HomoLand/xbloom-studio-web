import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Beaker, RefreshCw, Sparkles } from "lucide-react";
import { api, type BridgeState } from "../api";
import {
  Alert,
  Button,
  IconButton,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from "../components/ui";
import { shortId } from "../lib/recipeDomain";
import { readStoredWorkflow } from "../lib/workflowStore";

export default function Dashboard() {
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const stored = readStoredWorkflow();

  const load = useCallback(async () => {
    setError(null);
    try {
      const b = await api.bridge();
      setBridge(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeWorkflow =
    (typeof bridge?.active_workflow_id === "string" &&
      bridge.active_workflow_id.trim()) ||
    stored?.workflowId ||
    null;

  const phase =
    (typeof bridge?.phase === "string" && bridge.phase) ||
    (bridge?.workflow &&
      typeof bridge.workflow === "object" &&
      typeof (bridge.workflow as { phase?: unknown }).phase === "string" &&
      (bridge.workflow as { phase: string }).phase) ||
    null;

  const connectionScope =
    (typeof bridge?.connection_scope === "string" && bridge.connection_scope) ||
    (bridge?.connected ? "connected" : bridge?.running ? "daemon" : "offline");

  const releaseState =
    (typeof bridge?.release_state === "string" && bridge.release_state) ||
    (bridge?.available === false
      ? "unavailable"
      : bridge?.running
        ? "ready"
        : "stopped");

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Bridge availability and workflow overview."
        actions={
          <IconButton label="Refresh bridge status" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
          </IconButton>
        }
      />

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Link
          to="/design"
          className="rounded-lg border border-line bg-surface p-4 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Sparkles className="h-4 w-4 text-accent-blue" aria-hidden />
            Design a recipe
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Text or bag image to candidate, then save an immutable revision.
          </p>
        </Link>
        <Link
          to="/recipes"
          className="rounded-lg border border-line bg-surface p-4 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Beaker className="h-4 w-4 text-accent-green" aria-hidden />
            Browse recipes
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Open recipes and brew a saved revision.
          </p>
        </Link>
      </div>

      <Panel title="Bridge">
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
              <StatusPill
                tone={
                  releaseState === "ready"
                    ? "green"
                    : releaseState === "unavailable"
                      ? "red"
                      : "amber"
                }
              >
                release: {releaseState}
              </StatusPill>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <FieldRow label="Machine" value={bridge.machine ?? "-"} />
              <FieldRow label="Firmware" value={bridge.firmware ?? "-"} />
              <FieldRow label="Activity" value={bridge.activity ?? "idle"} />
              <FieldRow label="Phase" value={phase ?? "-"} />
              <FieldRow
                label="Workflow"
                value={
                  activeWorkflow ? shortId(activeWorkflow, 16) : "None"
                }
              />
              <FieldRow
                label="Stored workflow"
                value={
                  stored
                    ? `${shortId(stored.workflowId, 12)} | ${stored.kind}`
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
                Bridge is not running. The host attempts to start the daemon on
                startup without connecting BLE.
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyMachineHint />
        )}
      </Panel>

      <Panel title="Workflow" className="mt-4">
        <p className="text-sm text-ink-muted">
          Exact workflow IDs from load/start are preserved here for status and
          recovery. Uncertain outcomes should not be retried blindly.
        </p>
        {activeWorkflow ? (
          <div className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink">
            {activeWorkflow}
          </div>
        ) : (
          <div className="mt-4">
            <EmptyMachineHint compact />
          </div>
        )}
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh status
          </Button>
        </div>
      </Panel>
    </div>
  );
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
      {!compact ? (
        <p className="mt-2 text-center text-xs text-ink-muted">
          No active workflow. Design or open a recipe to brew.
        </p>
      ) : null}
    </div>
  );
}
