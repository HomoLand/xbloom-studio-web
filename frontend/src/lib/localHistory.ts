/**
 * Local brew history + per-session telemetry samples (browser localStorage).
 */

const KEY = "xbloom.brewHistory.v1";
const MAX_EVENTS = 200;

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
  localStorage.setItem(KEY, JSON.stringify(events.slice(0, MAX_EVENTS)));
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
  latest_recorded_at?: string;
} {
  const all = readAll();
  const by_outcome: Record<string, number> = {};
  for (const e of all) {
    by_outcome[e.outcome] = (by_outcome[e.outcome] ?? 0) + 1;
  }
  return {
    total: all.length,
    by_outcome,
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
  };
  const all = readAll();
  all.unshift(event);
  writeAll(all);
  return event;
}

export function getLocalHistoryEvent(eventId: string): LocalHistoryEvent | null {
  return readAll().find((e) => e.event_id === eventId) ?? null;
}

export function clearLocalHistory(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}
