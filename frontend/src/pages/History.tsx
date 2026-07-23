/**
 * Local-first brew journal + per-session telemetry (no backend required).
 * On hosted backend, still prefers browser localStorage so static Pages works.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Alert,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  StatusPill,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import {
  clearLocalHistory,
  getLocalHistoryEvent,
  historyStatus,
  listLocalHistory,
  type LocalHistoryEvent,
  type TelemetrySample,
} from "../lib/localHistory";
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
  const { t } = useI18n();
  const [events, setEvents] = useState<LocalHistoryEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    setEvents(listLocalHistory(100));
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const status = useMemo(() => historyStatus(), [tick, events]);
  const selected = selectedId
    ? getLocalHistoryEvent(selectedId) ??
      events.find((e) => e.event_id === selectedId) ??
      null
    : null;

  return (
    <div>
      <PageHeader
        title={t("history.title")}
        description={t("history.desc")}
        actions={
          events.length > 0 ? (
            <IconButton
              label={t("history.clear")}
              onClick={() => {
                if (
                  typeof window !== "undefined" &&
                  window.confirm(t("history.clearConfirm"))
                ) {
                  clearLocalHistory();
                  setSelectedId(null);
                  reload();
                }
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </IconButton>
          ) : null
        }
      />

      <Alert tone="blue" className="mb-4">
        {t("history.localMode")}
      </Alert>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label={t("history.total")} value={status.total} />
        <Stat
          label={t("history.completed")}
          value={status.by_outcome?.completed ?? 0}
        />
        <Stat
          label={t("history.failed")}
          value={
            (status.by_outcome?.failed ?? 0) +
            (status.by_outcome?.cancelled ?? 0)
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel title={t("history.list")}>
          {events.length === 0 ? (
            <EmptyState
              title={t("history.empty")}
              description={t("history.emptyHint")}
            />
          ) : (
            <ul className="divide-y divide-line">
              {events.map((e) => {
                const active = e.event_id === selectedId;
                return (
                  <li key={e.event_id}>
                    <button
                      type="button"
                      className={`flex w-full flex-col gap-1 px-2 py-2.5 text-left transition-colors ${
                        active
                          ? "bg-surface-2"
                          : "hover:bg-surface-2/70"
                      }`}
                      onClick={() => setSelectedId(e.event_id)}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill
                          tone={OUTCOME_TONE[e.outcome] ?? "neutral"}
                        >
                          {e.outcome}
                        </StatusPill>
                        <span className="truncate text-sm font-medium text-ink">
                          {e.recipe_name || shortId(e.event_id, 10)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
                        <span>
                          {e.source}
                          {e.telemetry?.length
                            ? ` · ${e.telemetry.length} pts`
                            : ""}
                        </span>
                        <time>{formatWhen(e.recorded_at)}</time>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title={selected?.recipe_name ?? t("history.detail")}>
          {!selected ? (
            <p className="text-sm text-ink-muted">{t("history.selectHint")}</p>
          ) : (
            <HistoryDetail event={selected} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function HistoryDetail({ event }: { event: LocalHistoryEvent }) {
  const { t } = useI18n();
  const samples = event.telemetry ?? [];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill tone={OUTCOME_TONE[event.outcome] ?? "neutral"}>
          {event.outcome}
        </StatusPill>
        {event.kind ? (
          <StatusPill tone="neutral">{event.kind}</StatusPill>
        ) : null}
      </div>
      <dl className="grid gap-1.5 sm:grid-cols-2 text-ink-muted">
        <div>
          {t("history.when")}{" "}
          <span className="text-ink">{formatWhen(event.recorded_at)}</span>
        </div>
        <div>
          {t("history.source")}{" "}
          <span className="text-ink">{event.source}</span>
        </div>
        {event.machine ? (
          <div>
            {t("history.machine")}{" "}
            <span className="text-ink">{event.machine}</span>
          </div>
        ) : null}
        {event.workflow_id ? (
          <div>
            {t("history.workflow")}{" "}
            <code className="text-ink">{shortId(event.workflow_id, 14)}</code>
          </div>
        ) : null}
        {event.recipe_revision_id ? (
          <div className="sm:col-span-2">
            {t("history.revision")}{" "}
            <code className="text-ink">
              {shortId(event.recipe_revision_id, 18)}
            </code>
          </div>
        ) : null}
      </dl>
      {event.note ? (
        <p className="text-xs text-ink-muted">{event.note}</p>
      ) : null}

      <div>
        <h3 className="mb-2 text-xs font-medium text-ink-muted">
          {t("history.telemetry")}
          {samples.length ? ` (${samples.length})` : ""}
        </h3>
        {samples.length === 0 ? (
          <p className="text-xs text-ink-faint">{t("history.noTelemetry")}</p>
        ) : (
          <>
            <TelemetrySpark samples={samples} />
            <div className="mt-2 max-h-56 overflow-auto rounded-md border border-line">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-surface-2 text-ink-muted">
                  <tr>
                    <th className="px-2 py-1 font-medium">t (s)</th>
                    <th className="px-2 py-1 font-medium">state</th>
                    <th className="px-2 py-1 font-medium">cup g</th>
                    <th className="px-2 py-1 font-medium">H₂O ml</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {samples.map((s, i) => (
                    <tr key={i} className="text-ink-muted">
                      <td className="px-2 py-0.5 tabular-nums">
                        {(s.t / 1000).toFixed(1)}
                      </td>
                      <td className="px-2 py-0.5">
                        {s.stateName ?? s.state ?? "—"}
                      </td>
                      <td className="px-2 py-0.5 tabular-nums">
                        {s.cupWeightG != null ? s.cupWeightG.toFixed(1) : "—"}
                      </td>
                      <td className="px-2 py-0.5 tabular-nums">
                        {s.dispensedWaterMl != null
                          ? s.dispensedWaterMl.toFixed(0)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Lightweight SVG sparkline for cup weight + water over time. */
function TelemetrySpark({ samples }: { samples: TelemetrySample[] }) {
  const w = 320;
  const h = 72;
  const pad = 4;
  if (samples.length < 2) return null;

  const xs = samples.map((s) => s.t);
  const water = samples.map((s) => s.dispensedWaterMl ?? 0);
  const cup = samples.map((s) => s.cupWeightG ?? 0);
  const tMin = Math.min(...xs);
  const tMax = Math.max(...xs) || 1;
  const wMax = Math.max(...water, 1);
  const cMax = Math.max(...cup, 1);

  const pathFor = (vals: number[], vmax: number) =>
    vals
      .map((v, i) => {
        const x =
          pad + ((xs[i]! - tMin) / (tMax - tMin || 1)) * (w - pad * 2);
        const y = h - pad - (v / vmax) * (h - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full rounded-md border border-line bg-paper"
      role="img"
      aria-label="Telemetry chart"
    >
      <path
        d={pathFor(water, wMax)}
        fill="none"
        stroke="currentColor"
        className="text-accent-blue"
        strokeWidth="1.5"
      />
      <path
        d={pathFor(cup, cMax)}
        fill="none"
        stroke="currentColor"
        className="text-accent-green opacity-80"
        strokeWidth="1.25"
        strokeDasharray="3 2"
      />
    </svg>
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
