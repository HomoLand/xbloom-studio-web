/**
 * Local-first brew journal + account cloud brew-history sync.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, Trash2 } from "lucide-react";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Panel,
  Select,
  StatusPill,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { readAccountPrefs, writeAccountPrefs } from "../lib/accountPrefs";
import {
  clearLocalHistory,
  getLocalHistoryEvent,
  historyStatus,
  importCloudBrewRecords,
  listLocalHistory,
  type LocalHistoryEvent,
  type TelemetrySample,
} from "../lib/localHistory";
import {
  CloudError,
  fetchCloudBrewRecords,
} from "../lib/xbloomCloud";
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
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const prefs = readAccountPrefs();
  const [email, setEmail] = useState(prefs.email);
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<"china" | "international">(prefs.region);

  const reload = useCallback(() => {
    setEvents(listLocalHistory(200));
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

  const onSyncCloud = async () => {
    setError(null);
    setInfo(null);
    if (!email.trim() || !password) {
      setError(t("cloud.needCreds"));
      return;
    }
    setBusy(true);
    try {
      writeAccountPrefs({ email, region });
      const result = await fetchCloudBrewRecords({
        email,
        password,
        region,
        languageType: readAccountPrefs().languageType,
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
      setError(
        e instanceof CloudError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

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

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {info ? (
        <Alert tone="green" className="mb-4">
          {info}
        </Alert>
      ) : null}

      <Panel title={t("history.cloudSync")} className="mb-4">
        <p className="mb-3 text-xs text-ink-muted">{t("history.cloudHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("cloud.email")}>
            <TextInput
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label={t("cloud.password")}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("cloud.passwordHint")}
            />
          </Field>
          <Field label={t("cloud.region")}>
            <Select
              value={region}
              onChange={(e) =>
                setRegion(
                  e.target.value === "international"
                    ? "international"
                    : "china",
                )
              }
            >
              <option value="china">{t("cloud.regionCn")}</option>
              <option value="international">{t("cloud.regionIntl")}</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void onSyncCloud()}
            >
              <Cloud className="h-3.5 w-3.5" aria-hidden />
              {busy ? t("common.loading") : t("history.sync")}
            </Button>
          </div>
        </div>
      </Panel>

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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel title={t("history.list")}>
          {events.length === 0 ? (
            <EmptyState
              title={t("history.empty")}
              description={t("history.emptyHint")}
            />
          ) : (
            <ul className="space-y-1">
              {events.map((e) => {
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
                          {e.outcome}
                        </StatusPill>
                        {e.source === "app-cloud" ? (
                          <StatusPill tone="amber">
                            {t("history.cloudBadge")}
                          </StatusPill>
                        ) : e.source === "web-bluetooth" ? (
                          <StatusPill tone="green">web-ble</StatusPill>
                        ) : null}
                        <span className="truncate text-sm font-medium text-ink">
                          {e.recipe_name || shortId(e.event_id, 10)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
                        <span>
                          {e.source}
                          {e.dose_g != null ? ` · ${e.dose_g}g` : ""}
                          {e.brew_time_s != null ? ` · ${e.brew_time_s}s` : ""}
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
        {event.source === "app-cloud" ? (
          <StatusPill tone="amber">{t("history.cloudBadge")}</StatusPill>
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
            tableId{" "}
            <span className="text-ink">{event.remote_table_id}</span>
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
      className="w-full rounded-xl border border-line bg-surface-2"
      role="img"
      aria-label="Telemetry chart"
    >
      <path
        d={pathFor(water, wMax)}
        fill="none"
        stroke="var(--color-chart-water)"
        strokeWidth="1.75"
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
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="font-matrix text-2xl text-ink">{value}</div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
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
