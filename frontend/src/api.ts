const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? body.error ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as T;
}

export type Machine = { name: string; address: string };

export type ScanResult = {
  command: string;
  count: number;
  machines: Machine[];
};

export type ProbeResult = {
  command: string;
  machine: string;
  address: string;
  firmware?: string;
  model?: string;
  weight_unit?: string;
  temperature_unit?: string;
  water_source?: string;
  [key: string]: unknown;
};

export type BridgeState = {
  running: boolean;
  available: boolean;
  hint?: string;
  connected?: boolean;
  machine?: string | null;
  activity?: string | null;
  phase?: string;
  machine_state?: string | null;
  firmware?: string | null;
  targets?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  liquid_progress?: Record<string, unknown> | null;
  last_operation?: Record<string, unknown> | null;
  last_error?: string | null;
  recovery_records?: string[];
};

export type BridgeEvent = {
  seq: number;
  state_name?: string;
  command_code?: number;
  [key: string]: unknown;
};

export type BridgeEventsResult = {
  running: boolean;
  events: BridgeEvent[];
  next_since: number;
};

export type Template = {
  file: string;
  path: string;
  name: string;
  kind: string;
  dose_g: number | null;
  leaf_g: number | null;
  water_ml: number | null;
  pours: number;
  tea: boolean;
};

export type TemplatesResult = { templates: Template[]; assets_dir: string };

export type ValidateResult = {
  valid: boolean;
  error?: string;
  type?: string;
  summary?: Record<string, unknown>;
};

export type CatalogStatus = {
  path: string;
  total: number;
  coffee: number;
  tea: number;
  executable: number;
  slot_compatible: number;
  updated_at?: string;
};

export type CatalogEntry = {
  id?: string;
  table_id?: string | number;
  name?: string;
  kind?: string;
  machine_program?: string;
  origin?: string;
  author?: string;
  cup_type?: string;
  executable?: boolean;
  slot_compatible?: boolean;
  [key: string]: unknown;
};

export type CatalogListResult = {
  path: string;
  count: number;
  entries: CatalogEntry[];
};

export type Pour = {
  ml: number;
  temp_c: number;
  pattern: string;
  pause_s: number;
  flow_ml_s: number;
  label?: string;
  vibration?: string;
  rpm?: number;
};

export type RecipeDetail = {
  name?: string;
  kind?: string;
  dose_g?: number;
  grind?: number;
  dripper?: string;
  water_ml?: number;
  leaf_g?: number;
  output_ml_per_steep?: number;
  ratio?: number;
  bypass_ml?: number;
  bypass_temp_c?: number;
  pours?: Pour[];
  [key: string]: unknown;
};

export type CatalogEntryDetail = CatalogEntry & {
  recipe?: RecipeDetail;
  slot_incompatibility?: string;
  warnings?: string[];
  validation_errors?: string[];
  manual_preparation?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  first_seen_at?: string;
  last_seen_at?: string;
  share_link?: string;
};

export type CatalogShowResult = { entry: CatalogEntryDetail };

export type CatalogImportResult = {
  path: string;
  candidates: number;
  added: number;
  updated: number;
  rejected: number;
  rejections: Array<{ index: number; name: string; error: string }>;
  total: number;
};

export type HistoryStatus = {
  path: string;
  exists: boolean;
  total: number;
  by_outcome: Record<string, number>;
  by_source: Record<string, number>;
  latest_recorded_at?: string;
};

export type HistoryEvent = {
  event_id: string;
  outcome: string;
  source: string;
  recipe_name?: string;
  machine?: string;
  recorded_at?: string;
  note?: string;
  [key: string]: unknown;
};

export type HistoryListResult = { count: number; events: HistoryEvent[] };

export const api = {
  health: () => get<{ status: string }>("/health"),
  scan: (timeout = 8) => get<ScanResult>(`/device/scan?timeout=${timeout}`),
  probe: (address?: string) =>
    get<ProbeResult>(`/device/probe${address ? `?address=${encodeURIComponent(address)}` : ""}`),
  bridge: () => get<BridgeState>("/device/bridge"),
  bridgeEvents: (since = 0) =>
    get<BridgeEventsResult>(`/device/events?since=${since}`),
  bridgeCall: async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const res = await fetch(`${BASE}/device/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status}: ${data.detail ?? res.statusText}`);
    return data as Record<string, unknown>;
  },
  templates: () => get<TemplatesResult>("/recipes/templates"),
  validate: (path: string) => post<ValidateResult>("/recipes/validate", { path }),
  catalogStatus: () => get<CatalogStatus>("/catalog/status"),
  catalogList: (kind?: string) =>
    get<CatalogListResult>(`/catalog/list${kind ? `?kind=${kind}` : ""}`),
  catalogShow: (id: string) =>
    get<CatalogShowResult>(`/catalog/show?id=${encodeURIComponent(id)}`),
  catalogImport: async (file: File): Promise<CatalogImportResult> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/catalog/import`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status}: ${data.detail ?? res.statusText}`);
    return data as CatalogImportResult;
  },
  historyStatus: () => get<HistoryStatus>("/history/status"),
  historyList: (limit = 20) => get<HistoryListResult>(`/history/list?limit=${limit}`),
};
