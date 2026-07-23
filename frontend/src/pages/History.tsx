import { useEffect, useState } from "react";
import { api, type HistoryEvent, type HistoryStatus } from "../api";
import {
  Alert,
  EmptyState,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from "../components/ui";
import { shortId } from "../lib/recipeDomain";

const OUTCOME_TONE: Record<
  string,
  "green" | "amber" | "red" | "blue" | "neutral"
> = {
  completed: "green",
  loaded: "blue",
  started: "amber",
  cancelled: "neutral",
  failed: "red",
  completion_unconfirmed: "amber",
  imported: "neutral",
};

export default function History() {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.historyStatus(), api.historyList(50)])
      .then(([s, l]) => {
        setStatus(s);
        setEvents(l.events);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader
        title="History"
        description="Local brew journal."
      />

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {status ? (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <Stat label="Total" value={status.total} />
          <Stat
            label="Completed"
            value={status.by_outcome?.completed ?? 0}
          />
          <Stat label="Failed" value={status.by_outcome?.failed ?? 0} />
        </div>
      ) : null}

      <Panel>
        {loading ? (
          <Spinner label="Loading history" />
        ) : events.length === 0 ? (
          <EmptyState
            title="No brew events yet"
            description="Completed loads and starts will appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.event_id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusPill tone={OUTCOME_TONE[e.outcome] ?? "neutral"}>
                        {e.outcome}
                      </StatusPill>
                      <span className="truncate text-sm font-medium text-ink">
                        {e.recipe_name || shortId(e.event_id, 10)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-ink-faint">
                      {e.source}
                      {e.machine ? ` | ${e.machine}` : ""}
                      {e.recipe_revision_id
                        ? ` | rev ${shortId(e.recipe_revision_id, 10)}`
                        : ""}
                      {e.workflow_id
                        ? ` | wf ${shortId(e.workflow_id, 10)}`
                        : ""}
                    </div>
                    {e.note ? (
                      <p className="mt-1 text-xs text-ink-muted">{e.note}</p>
                    ) : null}
                  </div>
                  <time className="shrink-0 text-xs text-ink-faint">
                    {formatWhen(e.recorded_at)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-xl font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function formatWhen(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
