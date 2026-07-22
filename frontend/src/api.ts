const BASE = "/api";

/** One request_id per user click/action. Never reuse across retries. */
export function newRequestId(prefix = "web"): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}

function formatErrorDetail(detail: unknown, fallback: string): string {
  if (detail == null) return fallback;
  if (typeof detail === "string") return detail;
  if (typeof detail === "object") {
    const d = detail as { category?: unknown; message?: unknown; error?: unknown };
    const category = typeof d.category === "string" ? d.category : "";
    const message =
      typeof d.message === "string"
        ? d.message
        : typeof d.error === "string"
          ? d.error
          : "";
    if (category && message) return `${category}: ${message}`;
    if (message) return message;
    if (category) return category;
    try {
      return JSON.stringify(detail);
    } catch {
      return fallback;
    }
  }
  return String(detail);
}

async function parseError(res: Response): Promise<Error> {
  let detail: unknown = res.statusText;
  try {
    const body = await res.json();
    detail = body.detail ?? body.error ?? body;
  } catch {
    /* keep statusText */
  }
  return new Error(`${res.status}: ${formatErrorDetail(detail, res.statusText)}`);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

export type Machine = { name: string; address: string };

export type ScanResult = {
  command: string;
  count: number;
  machines: Machine[];
};

export type ProbeResult = {
  command: string;
  machine?: string;
  address?: string;
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
  active_workflow_id?: string | null;
  workflow?: Record<string, unknown> | null;
};

export type BridgeEvent = {
  seq: number;
  state_name?: string;
  command_code?: number;
  [key: string]: unknown;
};

export type BridgeEventsResult = {
  running?: boolean;
  events: BridgeEvent[];
  next_since: number;
};

export type WorkflowResult = {
  workflow_id?: string;
  [key: string]: unknown;
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
  bridgeEvents: (since: number, workflowId: string) =>
    get<BridgeEventsResult>(
      `/device/events?since=${since}&workflow_id=${encodeURIComponent(workflowId)}`,
    ),
  coffeeLoad: (recipe: string, requestId: string) =>
    post<WorkflowResult>("/device/coffee/load", { recipe, request_id: requestId }),
  coffeeStart: (workflowId: string, confirmation: string, requestId: string) =>
    post<WorkflowResult>("/device/coffee/start", {
      workflow_id: workflowId,
      confirmation,
      request_id: requestId,
    }),
  teaLoad: (recipe: string, requestId: string) =>
    post<WorkflowResult>("/device/tea/load", { recipe, request_id: requestId }),
  teaStart: (workflowId: string, confirmation: string, requestId: string) =>
    post<WorkflowResult>("/device/tea/start", {
      workflow_id: workflowId,
      confirmation,
      request_id: requestId,
    }),
  pause: (workflowId: string, requestId: string) =>
    post<WorkflowResult>("/device/pause", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  resume: (workflowId: string, requestId: string) =>
    post<WorkflowResult>("/device/resume", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  stop: (workflowId: string, requestId: string) =>
    post<WorkflowResult>("/device/stop", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  cancel: (workflowId: string, requestId: string) =>
    post<WorkflowResult>("/device/cancel", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
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
    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<CatalogImportResult>;
  },
  historyStatus: () => get<HistoryStatus>("/history/status"),
  historyList: (limit = 20) => get<HistoryListResult>(`/history/list?limit=${limit}`),
};
