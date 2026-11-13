/**
 * Local brew history + per-session telemetry samples (browser localStorage).
 * Also imports account brew records from the official cloud API.
 */

const KEY = "xbloom.brewHistory.v1";
const MAX_EVENTS = 500;

export type TelemetrySample = {
  t: number; // ms since session start or epoch
  state?: number | null;
  stateName?: string | null;
  cupWeightG?: number | null;
  dispensedWaterMl?: number | null;
};

export type LocalHistoryEvent = {
  event_id: string;
  outcome: string;
  source: string;
  recipe_name?: string;
  recipe_revision_id?: string;
  workflow_id?: string;
  recorded_at: string;
  note?: string;
  kind?: string;
  telemetry?: TelemetrySample[];
  machine?: string;
  /** Official account brew-record tableId when source=app-cloud */
  remote_table_id?: number | null;
  brew_time_s?: number | null;
  dose_g?: number | null;
  serving_kind?: string;
  group_name?: string;
  region?: string;
};

export type CloudBrewRecord = {
  remote_table_id?: number | null;
  recipe_name?: string | null;
  serving_kind?: string | null;
  dose_g?: number | null;
  brew_time_s?: number | null;
  recorded_at?: string | null;
  create_time_stamp?: number | null;
  group_name?: string | null;
  has_line_chart?: boolean;
  line_chart_raw?: string | null;
  device_id?: string | null;
  mac?: string | null;
  machine_id?: number | null;
  is_pod?: boolean | null;
};

function readAll(): LocalHistoryEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as LocalHistoryEvent[]) : [];
  } catch {
    return [];
  }
}

function writeAll(events: LocalHistoryEvent[]): void {
  if (typeof localStorage === "undefined") return;
  // Newest first
  const sorted = [...events].sort((a, b) =>
    (b.recorded_at || "").localeCompare(a.recorded_at || ""),
  );
  localStorage.setItem(KEY, JSON.stringify(sorted.slice(0, MAX_EVENTS)));
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `hist_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    : `hist_${Date.now().toString(16)}`;
}

export function listLocalHistory(limit = 50): LocalHistoryEvent[] {
  return readAll().slice(0, Math.max(1, Math.min(limit, MAX_EVENTS)));
}

export function historyStatus(): {
  total: number;
  by_outcome: Record<string, number>;
  by_source: Record<string, number>;
  latest_recorded_at?: string;
} {
  const all = readAll();
  const by_outcome: Record<string, number> = {};
  const by_source: Record<string, number> = {};
  for (const e of all) {
    by_outcome[e.outcome] = (by_outcome[e.outcome] ?? 0) + 1;
    by_source[e.source] = (by_source[e.source] ?? 0) + 1;
  }
  return {
    total: all.length,
    by_outcome,
    by_source,
    latest_recorded_at: all[0]?.recorded_at,
  };
}

export function appendLocalHistory(
  partial: Omit<LocalHistoryEvent, "event_id" | "recorded_at"> & {
    event_id?: string;
    recorded_at?: string;
  },
): LocalHistoryEvent {
  const event: LocalHistoryEvent = {
    event_id: partial.event_id ?? newId(),
    recorded_at: partial.recorded_at ?? new Date().toISOString(),
    outcome: partial.outcome,
    source: partial.source,
    recipe_name: partial.recipe_name,
    recipe_revision_id: partial.recipe_revision_id,
    workflow_id: partial.workflow_id,
    note: partial.note,
    kind: partial.kind,
    telemetry: partial.telemetry,
    machine: partial.machine,
    remote_table_id: partial.remote_table_id,
    brew_time_s: partial.brew_time_s,
    dose_g: partial.dose_g,
    serving_kind: partial.serving_kind,
    group_name: partial.group_name,
    region: partial.region,
  };
  const all = readAll();
  // Replace if same event_id or same remote cloud id
  const filtered = all.filter((e) => {
    if (e.event_id === event.event_id) return false;
    if (
      event.remote_table_id != null &&
      e.remote_table_id != null &&
      e.remote_table_id === event.remote_table_id &&
      (e.source === "app-cloud" || event.source === "app-cloud")
    ) {
      return false;
    }
    return true;
  });
  filtered.unshift(event);
  writeAll(filtered);
  return event;
}

export function getLocalHistoryEvent(eventId: string): LocalHistoryEvent | null {
  return readAll().find((e) => e.event_id === eventId) ?? null;
}

export function clearLocalHistory(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}

/** Filter helpers for History UI. */
export function filterLocalHistory(
  events: LocalHistoryEvent[],
  opts: {
    query?: string;
    kind?: "all" | "coffee" | "tea" | string;
    outcome?: "all" | "completed" | "failed" | string;
    source?: "all" | "web-bluetooth" | "app-cloud" | "host" | string;
  },
): LocalHistoryEvent[] {
  const q = (opts.query || "").trim().toLowerCase();
  const kind = opts.kind || "all";
  const outcome = opts.outcome || "all";
  const source = opts.source || "all";
  return events.filter((e) => {
    if (kind === "tea") {
      if ((e.kind || "").toLowerCase() !== "tea") return false;
    } else if (kind === "coffee") {
      const k = (e.kind || "").toLowerCase();
      if (k === "tea") return false;
    } else if (kind !== "all" && kind) {
      if ((e.kind || "").toLowerCase() !== kind.toLowerCase()) return false;
    }
    if (outcome === "failed") {
      if (e.outcome !== "failed" && e.outcome !== "cancelled") return false;
    } else if (outcome !== "all" && outcome) {
      if (e.outcome !== outcome) return false;
    }
    if (source === "host") {
      if (e.source === "web-bluetooth" || e.source === "app-cloud") return false;
    } else if (source !== "all" && source) {
      if (e.source !== source) return false;
    }
    if (q) {
      const hay = [
        e.recipe_name,
        e.kind,
        e.outcome,
        e.source,
        e.note,
        e.machine,
        e.workflow_id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function exportHistoryJson(events: LocalHistoryEvent[]): string {
  return JSON.stringify(
    {
      format: "xbloom-studio-web-history",
      version: 1,
      exported_at: new Date().toISOString(),
      count: events.length,
      events,
    },
    null,
    2,
  );
}

export function exportHistoryCsv(events: LocalHistoryEvent[]): string {
  const cols = [
    "recorded_at",
    "outcome",
    "source",
    "recipe_name",
    "kind",
    "dose_g",
    "brew_time_s",
    "machine",
    "workflow_id",
    "recipe_revision_id",
    "telemetry_points",
  ];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(",")];
  for (const e of events) {
    lines.push(
      [
        e.recorded_at,
        e.outcome,
        e.source,
        e.recipe_name,
        e.kind,
        e.dose_g,
        e.brew_time_s,
        e.machine,
        e.workflow_id,
        e.recipe_revision_id,
        e.telemetry?.length ?? 0,
      ]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Parse App lineChartData into coarse telemetry when possible. */
export function parseLineChartTelemetry(
  raw: string | null | undefined,
): TelemetrySample[] | undefined {
  if (!raw || !String(raw).trim()) return undefined;
  const text = String(raw).trim();
  // JSON array of numbers or {t,w} / {time,weight}
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === "number") {
        return (parsed as number[]).map((v, i) => ({
          t: i * 1000,
          dispensedWaterMl: v,
        }));
      }
      if (typeof parsed[0] === "object" && parsed[0] != null) {
        return (parsed as Record<string, unknown>[]).map((row, i) => {
          const t =
            Number(row.t ?? row.time ?? row.timeMs ?? row.x ?? i * 1000) ||
            i * 1000;
          const water = Number(
            row.water ?? row.dispensedWaterMl ?? row.w ?? row.y ?? row.value,
          );
          const cup = Number(row.cup ?? row.cupWeightG ?? row.weight);
          return {
            t: t > 10_000 ? t : t, // keep as-is; App may use seconds or ms
            dispensedWaterMl: Number.isFinite(water) ? water : null,
            cupWeightG: Number.isFinite(cup) ? cup : null,
          };
        });
      }
    }
  } catch {
    /* fall through to CSV */
  }
  // CSV / comma-separated numbers
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (nums.length >= 2) {
    return nums.map((v, i) => ({ t: i * 1000, dispensedWaterMl: v }));
  }
  return undefined;
}

export function cloudBrewRecordToEvent(
  record: CloudBrewRecord,
  region?: string,
): LocalHistoryEvent {
  const tableId = record.remote_table_id;
  const eventId =
    tableId != null && tableId > 0
      ? `cloud:${region ?? "x"}:${tableId}`
      : newId();
  const kind =
    record.serving_kind === "tea"
      ? "tea"
      : record.serving_kind === "xpod"
        ? "xpod"
        : "coffee";
  const noteParts: string[] = [];
  if (record.dose_g != null) noteParts.push(`${record.dose_g}g`);
  if (record.brew_time_s != null) noteParts.push(`${record.brew_time_s}s`);
  if (record.group_name) noteParts.push(String(record.group_name));
  const telemetry = parseLineChartTelemetry(record.line_chart_raw ?? undefined);
  return {
    event_id: eventId,
    outcome: "completed",
    source: "app-cloud",
    recipe_name: record.recipe_name ?? undefined,
    recorded_at:
      record.recorded_at ??
      (record.create_time_stamp
        ? new Date(
            record.create_time_stamp > 10_000_000_000
              ? record.create_time_stamp
              : record.create_time_stamp * 1000,
          ).toISOString()
        : new Date().toISOString()),
    kind,
    note: noteParts.length ? noteParts.join(" · ") : undefined,
    machine:
      record.mac ||
      (record.device_id ? String(record.device_id) : undefined) ||
      (record.machine_id != null ? `machine:${record.machine_id}` : undefined),
    remote_table_id: tableId ?? null,
    brew_time_s: record.brew_time_s ?? null,
    dose_g: record.dose_g ?? null,
    serving_kind: record.serving_kind ?? undefined,
    group_name: record.group_name ?? undefined,
    region,
    telemetry,
  };
}

/**
 * Merge cloud brew records into local journal (idempotent by remote_table_id).
 */
export function importCloudBrewRecords(
  records: CloudBrewRecord[],
  region?: string,
): { imported: number; updated: number; skipped: number; total: number } {
  const existing = readAll();
  const byRemote = new Map<number, number>(); // tableId -> index
  existing.forEach((e, i) => {
    if (e.remote_table_id != null && e.remote_table_id > 0) {
      byRemote.set(e.remote_table_id, i);
    }
  });
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const next = [...existing];

  for (const rec of records) {
    if (!rec.remote_table_id && !rec.recipe_name && !rec.recorded_at) {
      skipped += 1;
      continue;
    }
    const event = cloudBrewRecordToEvent(rec, region);
    const tid = event.remote_table_id;
    if (tid != null && byRemote.has(tid)) {
      const idx = byRemote.get(tid)!;
      // Preserve local-only telemetry if cloud has none
      const prev = next[idx]!;
      if ((!event.telemetry || event.telemetry.length === 0) && prev.telemetry?.length) {
        event.telemetry = prev.telemetry;
      }
      next[idx] = event;
      updated += 1;
    } else {
      next.push(event);
      if (tid != null) byRemote.set(tid, next.length - 1);
      imported += 1;
    }
  }
  writeAll(next);
  return { imported, updated, skipped, total: readAll().length };
}


export type HostHistoryEventLike = {
  event_id: string;
  outcome: string;
  source: string;
  recipe_name?: string;
  machine?: string;
  recorded_at?: string;
  note?: string;
  recipe_revision_id?: string;
  workflow_id?: string;
  [key: string]: unknown;
};

export function hostHistoryEventToLocal(
  event: HostHistoryEventLike,
): LocalHistoryEvent {
  return {
    event_id:
      event.event_id ||
      (event.workflow_id ? `host:${event.workflow_id}` : newId()),
    outcome: event.outcome || "completed",
    source: event.source || "host",
    recipe_name:
      event.recipe_name ??
      (typeof event.name === "string" ? event.name : undefined),
    recipe_revision_id: event.recipe_revision_id,
    workflow_id: event.workflow_id,
    recorded_at: event.recorded_at || new Date(0).toISOString(),
    note: event.note,
    kind: typeof event.kind === "string" ? event.kind : undefined,
    machine: event.machine,
    brew_time_s:
      typeof event.brew_time_s === "number" ? event.brew_time_s : null,
    dose_g: typeof event.dose_g === "number" ? event.dose_g : null,
    serving_kind:
      typeof event.serving_kind === "string" ? event.serving_kind : undefined,
  };
}

/**
 * Merge host SQLite history records with browser-local/cloud history records.
 * Deduplicates by event_id or workflow_id while preserving local telemetry.
 */
export function mergeHostAndLocalHistory(
  hostEvents: HostHistoryEventLike[],
  localEvents: LocalHistoryEvent[],
): LocalHistoryEvent[] {
  const merged = localEvents.map((e) => ({ ...e }));
  const byEventId = new Map<string, number>();
  const byWorkflowId = new Map<string, number>();
  merged.forEach((item, idx) => {
    if (item.event_id) byEventId.set(item.event_id, idx);
    if (item.workflow_id) byWorkflowId.set(item.workflow_id, idx);
  });

  for (const rawHost of hostEvents) {
    const hostEv = hostHistoryEventToLocal(rawHost);
    const existingIdx =
      byEventId.get(hostEv.event_id) ??
      (hostEv.workflow_id ? byWorkflowId.get(hostEv.workflow_id) : undefined);

    if (existingIdx !== undefined) {
      const current = merged[existingIdx];
      merged[existingIdx] = {
        ...hostEv,
        ...current,
        recipe_name: current.recipe_name ?? hostEv.recipe_name,
        recipe_revision_id:
          current.recipe_revision_id ?? hostEv.recipe_revision_id,
        machine: current.machine ?? hostEv.machine,
        note: current.note ?? hostEv.note,
        kind: current.kind ?? hostEv.kind,
        brew_time_s: current.brew_time_s ?? hostEv.brew_time_s,
        dose_g: current.dose_g ?? hostEv.dose_g,
      };
      continue;
    }

    const nextIdx = merged.length;
    merged.push(hostEv);
    if (hostEv.event_id) byEventId.set(hostEv.event_id, nextIdx);
    if (hostEv.workflow_id) byWorkflowId.set(hostEv.workflow_id, nextIdx);
  }

  return merged.sort((a, b) => {
    const ta = Date.parse(a.recorded_at || "");
    const tb = Date.parse(b.recorded_at || "");
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    return nb - na;
  });
}
