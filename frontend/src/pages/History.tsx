/**
 * Local-first brew journal + account cloud brew-history sync
 * (credentials live in Settings).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Download, Play, Trash2 } from "lucide-react";
import { api } from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  Segmented,
  Select,
  StatusPill,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { getAccountCredentials } from "../lib/accountPrefs";
import { isStaticDeploy } from "../lib/deploy";
import {
  clearLocalHistory,
  exportHistoryCsv,
  exportHistoryJson,
  filterLocalHistory,
  getLocalHistoryEvent,
  importCloudBrewRecords,
  listLocalHistory,
  mergeHostAndLocalHistory,
  type LocalHistoryEvent,
  type TelemetrySample,
} from "../lib/localHistory";
import {
  findLocalRecipeForRebrew,
  toLatestRevision,
} from "../lib/localRecipes";
import { downloadText } from "../lib/recipeIo";
import { cloudErrorMessage, fetchCloudBrewRecords } from "../lib/xbloomCloud";
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
  const navigate = useNavigate();
  const staticDeploy = isStaticDeploy();
  const [events, setEvents] = useState<LocalHistoryEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "coffee" | "tea">("all");
  const [outcomeFilter, setOutcomeFilter] = useState<
    "all" | "completed" | "failed"
  >("all");
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "host" | "web-bluetooth" | "app-cloud"
  >("all");
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);

  const reload = useCallback(async () => {
    const local = listLocalHistory(200);
    setEvents(local);
    if (staticDeploy) return;
    try {
      const host = await api.historyList(100);
      setEvents(mergeHostAndLocalHistory(host.events ?? [], local));
    } catch {
      /* keep local list when offline or unauthenticated */
    }
  }, [staticDeploy]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const status = useMemo(() => {
    const by_outcome: Record<string, number> = {};
    const by_source: Record<string, number> = {};
    for (const e of events) {
      by_outcome[e.outcome] = (by_outcome[e.outcome] ?? 0) + 1;
      by_source[e.source] = (by_source[e.source] ?? 0) + 1;
    }
    return { total: events.length, by_outcome, by_source };
  }, [events]);

  const filtered = useMemo(
    () =>
      filterLocalHistory(events, {
        query,
        kind: kindFilter,
        outcome: outcomeFilter,
        source: sourceFilter,
      }),
    [events, query, kindFilter, outcomeFilter, sourceFilter],
  );
  const selected = selectedId
    ? getLocalHistoryEvent(selectedId) ??
      filtered.find((e) => e.event_id === selectedId) ??
      null
    : null;

  const onSyncCloud = async () => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const creds = await getAccountCredentials();
      if (!creds) throw new Error(t("cloud.needSettings"));
      const result = await fetchCloudBrewRecords({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        languageType: creds.languageType,
      });
      const merged = importCloudBrewRecords(result.records, result.region);
      setInfo(
        t("history.syncDone")
          .replace("{count}", String(result.count))
          .replace("{imported}", String(merged.imported))
          .replace("{updated}", String(merged.updated))
          .replace("{region}", result.region),
      );
      reload();
    } catch (e) {
      setError(cloudErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const openRebrew = (event: LocalHistoryEvent) => {
    setError(null);
    const entry = findLocalRecipeForRebrew({
      recipe_revision_id: event.recipe_revision_id,
      recipe_name: event.recipe_name,
    });
    if (!entry) {
      setError(t("history.rebrewMissing"));
      return;
    }
    const rev = toLatestRevision(entry);
    setBrewTarget({
      recipeRevisionId: rev.revision_id,
      content: entry.content,
      revision: rev,
      recipeName: entry.name,
    });
  };

  const onExport = (fmt: "json" | "csv") => {
    const payload =
      fmt === "json"
        ? exportHistoryJson(filtered)
        : exportHistoryCsv(filtered);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(
      `xbloom-history-${stamp}.${fmt}`,
      payload,
      fmt === "json" ? "application/json" : "text/csv",
    );
    setInfo(t("history.exportDone").replace("{n}", String(filtered.length)));
  };

  return (
    <div>
      <PageHeader
        title={t("history.title")}
        description={t("history.desc")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void onSyncCloud()}
            >
              <Cloud className="h-3.5 w-3.5" aria-hidden />
              {busy ? t("common.loading") : t("history.sync")}
            </Button>
            {filtered.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onExport("json")}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  JSON
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onExport("csv")}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  CSV
                </Button>
              </>
            ) : null}
            {events.length > 0 ? (
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
            ) : null}
          </div>
        }
      />

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
          {/session|设置|Settings|password/i.test(error) ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigate("/settings")}
              >
                {t("cloud.openSettings")}
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}
      {info ? (
        <Alert tone="green" className="mb-4">
          {info}
        </Alert>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
        <Stat
          label={t("history.fromCloud")}
          value={status.by_source?.["app-cloud"] ?? 0}
        />
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("history.searchPlaceholder")}
          className="sm:max-w-xs"
        />
        <Segmented
          ariaLabel={t("history.filterKind")}
          value={kindFilter}
          onChange={setKindFilter}
          options={[
            { value: "all", label: t("history.filterAll") },
            { value: "coffee", label: t("history.filterCoffee") },
            { value: "tea", label: t("history.filterTea") },
          ]}
        />
        <Segmented
          ariaLabel={t("history.filterOutcome")}
          value={outcomeFilter}
          onChange={setOutcomeFilter}
          options={[
            { value: "all", label: t("history.filterOutcomeAll") },
            { value: "completed", label: t("history.completed") },
            { value: "failed", label: t("history.failed") },
          ]}
        />
        <Select
          aria-label={t("history.filterSource")}
          className="sm:w-36"
          value={sourceFilter}
          onChange={(e) =>
            setSourceFilter(
              e.target.value as "all" | "host" | "web-bluetooth" | "app-cloud",
            )
          }
        >
          <option value="all">{t("history.sourceAll")}</option>
          {!staticDeploy ? (
            <option value="host">{t("history.sourceHost")}</option>
          ) : null}
          <option value="web-bluetooth">{t("history.sourceBle")}</option>
          <option value="app-cloud">{t("history.sourceCloud")}</option>
        </Select>
        <span className="text-xs text-ink-faint">
          {t("history.showing")
            .replace("{n}", String(filtered.length))
            .replace("{total}", String(events.length))}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel title={t("history.list")}>
          {filtered.length === 0 ? (
            <EmptyState
              title={t("history.empty")}
              description={
                events.length
                  ? t("history.emptyFilter")
                  : t("history.emptyHint")
              }
            />
          ) : (
            <ul className="space-y-1">
              {filtered.map((e) => {
                const active = e.event_id === selectedId;
                return (
                  <li key={e.event_id}>
                    <button
                      type="button"
                      className={`flex w-full flex-col gap-1 rounded-2xl px-3 py-3 text-left transition-colors ${
                        active
                          ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]"
                          : "hover:bg-surface-2/70"
                      }`}
                      onClick={() => setSelectedId(e.event_id)}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill
                          tone={OUTCOME_TONE[e.outcome] ?? "neutral"}
                        >
                          {outcomeLabel(t, e.outcome)}
                        </StatusPill>
                        {e.source === "app-cloud" ? (
                          <StatusPill tone="amber">
                            {t("history.cloudBadge")}
                          </StatusPill>
                        ) : e.source === "web-bluetooth" ? (
                          <StatusPill tone="green">
                            {t("history.sourceBle")}
                          </StatusPill>
                        ) : (
                          <StatusPill tone="blue">
                            {t("history.sourceHost")}
                          </StatusPill>
                        )}
                        <span className="truncate text-sm font-medium text-ink">
                          {e.recipe_name || shortId(e.event_id, 10)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
                        <span>
                          {e.kind || "—"}
                          {e.dose_g != null ? ` · ${e.dose_g}g` : ""}
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
            <HistoryDetail event={selected} onRebrew={openRebrew} />
          )}
        </Panel>
      </div>

      <BrewConfirmDialog
        open={!!brewTarget}
        target={brewTarget}
        onClose={() => setBrewTarget(null)}
        onStarted={() => {
          setBrewTarget(null);
          navigate("/");
        }}
      />
    </div>
  );
}

function outcomeLabel(
  t: (k: string, f?: string) => string,
  outcome: string,
): string {
  const key = `history.outcome.${outcome}`;
  const labeled = t(key);
  return labeled === key ? outcome : labeled;
}

function HistoryDetail({
  event,
  onRebrew,
}: {
  event: LocalHistoryEvent;
  onRebrew: (e: LocalHistoryEvent) => void;
}) {
  const { t, tStatus } = useI18n();
  const samples = event.telemetry ?? [];
  const canRebrew = Boolean(
    event.recipe_revision_id || event.recipe_name,
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill tone={OUTCOME_TONE[event.outcome] ?? "neutral"}>
          {outcomeLabel(t, event.outcome)}
        </StatusPill>
        {event.kind ? (
          <StatusPill tone="neutral">{event.kind}</StatusPill>
        ) : null}
        {event.source === "app-cloud" ? (
          <StatusPill tone="amber">{t("history.cloudBadge")}</StatusPill>
        ) : null}
      </div>
      {canRebrew ? (
        <Button
          size="sm"
          variant="brand"
          onClick={() => onRebrew(event)}
        >
          <Play className="h-3.5 w-3.5" aria-hidden />
          {t("history.brewAgain")}
        </Button>
      ) : null}
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
        {event.dose_g != null ? (
          <div>
            {t("recipes.dose")}{" "}
            <span className="text-ink">{event.dose_g} g</span>
          </div>
        ) : null}
        {event.brew_time_s != null ? (
          <div>
            {t("history.brewTime")}{" "}
            <span className="text-ink">{event.brew_time_s} s</span>
          </div>
        ) : null}
        {event.remote_table_id != null ? (
          <div>
            tableId <span className="text-ink">{event.remote_table_id}</span>
          </div>
        ) : null}
        {event.group_name ? (
          <div>
            {t("history.group")}{" "}
            <span className="text-ink">{event.group_name}</span>
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
            <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-line">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-surface-2 text-ink-muted">
                  <tr>
                    <th className="px-2 py-1 font-medium">t (s)</th>
                    <th className="px-2 py-1 font-medium">
                      {t("dashboard.phase")}
                    </th>
                    <th className="px-2 py-1 font-medium">
                      {t("dashboard.cup")}
                    </th>
                    <th className="px-2 py-1 font-medium">
                      {t("dashboard.water")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {samples.map((s, i) => (
                    <tr key={i} className="text-ink-muted">
                      <td className="px-2 py-0.5 tabular-nums">
                        {(s.t / 1000).toFixed(1)}
                      </td>
                      <td className="px-2 py-0.5">
                        {s.stateName
                          ? tStatus(s.stateName)
                          : s.state != null
                            ? String(s.state)
                            : "—"}
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
      className="h-20 w-full rounded-xl bg-surface-2"
      role="img"
      aria-label="telemetry"
    >
      <path
        d={pathFor(water, wMax)}
        fill="none"
        stroke="var(--color-chart-water)"
        strokeWidth="1.5"
      />
      <path
        d={pathFor(cup, cMax)}
        fill="none"
        stroke="var(--color-chart-coffee)"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3 py-3">
      <div className="text-[11px] text-ink-faint">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
