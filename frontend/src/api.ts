/**
 * Typed browser API client for xBloom Studio Web.
 *
 * Credentials always include cookies. State-changing requests send the
 * configured CSRF header when a non-empty CSRF cookie is present, except
 * the initial POST /api/auth/pair exchange.
 *
 * Browser device load uses recipe_revision_id only - never local paths.
 */

const BASE = "/api";

// ---------------------------------------------------------------------------
// Request identity
// ---------------------------------------------------------------------------

/**
 * One request_id per explicit user mutation click.
 * There is no automatic transport retry in this UI: each confirmed user action
 * mints a fresh ID. If a future in-call transport retry is added, that retry
 * must reuse the same body and request_id.
 */
export function newRequestId(prefix = "web"): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}

// ---------------------------------------------------------------------------
// Auth cookie / CSRF configuration (set after GET /auth/config)
// ---------------------------------------------------------------------------

export type AuthClientConfig = {
  csrfCookie: string;
  csrfHeader: string;
  sessionCookie: string;
};

let authClientConfig: AuthClientConfig = {
  csrfCookie: "xbloom_csrf",
  csrfHeader: "X-CSRF-Token",
  sessionCookie: "xbloom_session",
};

export function configureAuthClient(cfg: Partial<AuthClientConfig>): void {
  authClientConfig = {
    csrfCookie: cfg.csrfCookie?.trim() || authClientConfig.csrfCookie,
    csrfHeader: cfg.csrfHeader?.trim() || authClientConfig.csrfHeader,
    sessionCookie: cfg.sessionCookie?.trim() || authClientConfig.sessionCookie,
  };
}

export function getAuthClientConfig(): AuthClientConfig {
  return { ...authClientConfig };
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined" || !name) return null;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCategory =
  | "network"
  | "authentication"
  | "authorization"
  | "csrf"
  | "rate_limit"
  | "validation"
  | "not_found"
  | "conflict"
  | "provider"
  | "timeout"
  | "configuration"
  | "bridge"
  | "unknown";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly category: ApiErrorCategory;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    opts: {
      status: number;
      code?: string;
      category?: string;
      details?: Record<string, unknown> | null;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code ?? "unknown";
    this.category = normalizeCategory(opts.category, opts.status, opts.code);
    this.details = opts.details ?? null;
  }
}

function normalizeCategory(
  raw: string | undefined,
  status: number,
  code: string | undefined,
): ApiErrorCategory {
  const c = (raw || code || "").toLowerCase();
  if (
    c === "network" ||
    c === "authentication" ||
    c === "authorization" ||
    c === "csrf" ||
    c === "rate_limit" ||
    c === "validation" ||
    c === "not_found" ||
    c === "conflict" ||
    c === "provider" ||
    c === "timeout" ||
    c === "configuration" ||
    c === "bridge"
  ) {
    return c;
  }
  // Stable device categories surface as category=code strings from the bridge.
  if (
    c === "device_busy_external" ||
    c === "protocol_incompatible" ||
    c === "workflow_mismatch" ||
    c === "workflow_conflict" ||
    c === "daemon_not_running" ||
    c === "daemon_not_client_ready" ||
    c === "bridge_error" ||
    c === "busy" ||
    c === "idempotency_conflict" ||
    c === "durable_state_unreadable" ||
    c === "recovery_required"
  ) {
    return "bridge";
  }
  if (c.includes("timeout") || status === 504) return "timeout";
  if (c.includes("auth") || status === 401) return "authentication";
  if (c.includes("csrf")) return "csrf";
  if (c.includes("rate")) return "rate_limit";
  if (c.includes("provider") || status === 502) return "provider";
  // configuration_error (and similar) -> configuration; bare HTTP 503 is bridge.
  if (c === "configuration_error" || c.includes("config")) return "configuration";
  if (status === 503) return "bridge";
  if (c.includes("valid") || status === 400 || status === 422) return "validation";
  if (c.includes("not_found") || status === 404) return "not_found";
  if (c.includes("conflict") || status === 409) return "conflict";
  if (c.includes("forbid") || status === 403) return "authorization";
  return "unknown";
}

function asDetailsObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function parseApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }

  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;

    // Security / design style: { error: { code, category?, message, details? } }
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      const message =
        typeof err.message === "string" && err.message
          ? err.message
          : res.statusText || `HTTP ${res.status}`;
      const category =
        typeof err.category === "string" ? err.category : undefined;
      const code =
        typeof err.code === "string"
          ? err.code
          : category
            ? category
            : undefined;
      return new ApiError(message, {
        status: res.status,
        code,
        category,
        details: asDetailsObject(err.details),
      });
    }

    // FastAPI device/recipe style: { detail: { category, message } | string | [...] }
    // SafeValidationRoute: { detail: { category, message, errors: [...] } }
    if ("detail" in obj) {
      const detail = obj.detail;
      if (typeof detail === "string") {
        return new ApiError(detail, { status: res.status });
      }
      if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        const d = detail as Record<string, unknown>;
        const message =
          typeof d.message === "string" && d.message
            ? d.message
            : res.statusText || `HTTP ${res.status}`;
        const category =
          typeof d.category === "string" ? d.category : undefined;
        // When category is present without a separate code (device bridge errors),
        // retain the stable category as ApiError.code for UI branching.
        const code =
          typeof d.code === "string"
            ? d.code
            : category
              ? category
              : undefined;

        let details: Record<string, unknown> | null = asDetailsObject(d.details);
        // SafeValidationRoute puts errors on detail.errors (not nested details).
        if (Array.isArray(d.errors)) {
          details = { ...(details ?? {}), errors: d.errors };
        } else if (d.errors && typeof d.errors === "object") {
          details = { ...(details ?? {}), errors: d.errors };
        }
        // Preserve any other structured fields under details for recovery UI.
        for (const key of ["workflow_id", "phase", "recovery", "issues"] as const) {
          if (key in d && details?.[key] === undefined) {
            details = { ...(details ?? {}), [key]: d[key] };
          }
        }

        return new ApiError(message, {
          status: res.status,
          code,
          category,
          details,
        });
      }
      if (Array.isArray(detail)) {
        const first = detail[0] as Record<string, unknown> | undefined;
        const msg =
          first && typeof first.msg === "string"
            ? first.msg
            : first && typeof first.message === "string"
              ? first.message
              : `Request validation failed (${detail.length} issue(s))`;
        return new ApiError(msg, {
          status: res.status,
          code: "validation_error",
          category: "validation",
          details: { issues: detail, errors: detail },
        });
      }
    }

    if (typeof obj.message === "string") {
      const category =
        typeof obj.category === "string" ? obj.category : undefined;
      const code =
        typeof obj.code === "string"
          ? obj.code
          : category
            ? category
            : undefined;
      return new ApiError(obj.message, {
        status: res.status,
        code,
        category,
        details: asDetailsObject(obj.details),
      });
    }
  }

  return new ApiError(res.statusText || `HTTP ${res.status}`, {
    status: res.status,
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type MutatingMethod = "POST" | "PUT" | "PATCH" | "DELETE";

function isMutating(method: string): method is MutatingMethod {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isPairExchange(path: string, method: string): boolean {
  return method === "POST" && (path === "/auth/pair" || path === "auth/pair");
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts?: { json?: boolean; csrfExempt?: boolean },
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (opts?.json !== false && init.body && !headers.has("Content-Type")) {
    if (!(init.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
  }

  // Double-submit CSRF for authenticated mutations (never empty header; never on pair).
  if (
    isMutating(method) &&
    !opts?.csrfExempt &&
    !isPairExchange(path, method)
  ) {
    const csrf = readCookie(authClientConfig.csrfCookie);
    if (csrf) {
      headers.set(authClientConfig.csrfHeader, csrf);
    }
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path.startsWith("/") ? path : `/${path}`}`, {
      ...init,
      method,
      headers,
      credentials: "include",
    });
  } catch (e) {
    // Do not swallow existing ApiError (e.g. if a caller wrapped fetch).
    if (e instanceof ApiError) throw e;
    const message =
      e instanceof Error && e.message
        ? e.message
        : "Network request failed";
    throw new ApiError(message, {
      status: 0,
      code: "network",
      category: "network",
    });
  }

  if (!res.ok) {
    throw await parseApiError(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

function postJson<T>(path: string, body: unknown, opts?: { csrfExempt?: boolean }): Promise<T> {
  return request<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    { csrfExempt: opts?.csrfExempt },
  );
}

function postForm<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: "POST", body: form }, { json: false });
}

// ---------------------------------------------------------------------------
// Domain types - auth
// ---------------------------------------------------------------------------

export type AuthMode = "loopback" | "lan";

export type AuthConfig = {
  mode: AuthMode;
  pairing_required: boolean;
  public_origin: string | null;
  session_ttl_s: number;
  pairing_ttl_s: number;
  csrf_header: string;
  session_cookie: string;
  csrf_cookie: string;
};

/** Auth timestamps are Unix epoch seconds (number), not ISO strings. */
export type SessionInfo = {
  session_id: string;
  expires_at: number;
  client_label: string | null;
  client_ip?: string | null;
  current?: boolean;
  created_at?: number;
  last_seen_at?: number;
};

export type AuthSessionResponse =
  | { authenticated: false; mode: AuthMode }
  | { authenticated: true; mode: AuthMode; session: SessionInfo };

export type PairResult = {
  session_id: string;
  expires_at: number;
  client_label: string | null;
};

export type PairingNewResult = {
  pairing_id: string;
  token: string;
  expires_at: number;
  pairing_url: string;
};

export type SessionsListResult = {
  sessions: SessionInfo[];
};

// ---------------------------------------------------------------------------
// Domain types - design
// ---------------------------------------------------------------------------

export type DesignMode = "vision" | "text";
export type BeverageHint = "coffee" | "tea";

export type DesignImageDataFate = {
  original_image_stored: boolean;
  when_image_attached: {
    image_bytes_leave_machine: boolean;
    ocr_text_leave_machine: boolean;
  };
  summary: string;
};

export type DesignPublicConfig = {
  provider: string;
  model: string;
  design_mode: DesignMode;
  image_data_fate: DesignImageDataFate;
};

export type DesignEvidenceItem = {
  source: string;
  claim: string;
  value?: string | null;
};

export type DesignValidationErrorItem = {
  code?: string;
  message?: string;
  path?: string;
  [key: string]: unknown;
};

export type DesignValidation = {
  valid: boolean;
  errors: DesignValidationErrorItem[];
  beverage?: string | null;
  repaired?: boolean;
};

export type DesignProvenance = {
  provider: string;
  model: string;
  knowledge_version: string;
  knowledge_content_hash: string;
  knowledge_source: "bundle" | "dev_root" | string;
  prompt_template_version: string;
  schema_version: string;
  candidate_hash: string;
  design_mode?: string | null;
  repaired?: boolean | null;
  used_image: boolean;
  used_ocr?: boolean | null;
};

export type DesignResult = {
  recipe_candidate: RecipeContent;
  design_rationale: string;
  evidence: DesignEvidenceItem[];
  validation: DesignValidation;
  provenance: DesignProvenance;
};

export type DesignJsonRequest = {
  text: string;
  beverage?: BeverageHint | null;
};

// ---------------------------------------------------------------------------
// Domain types - recipes
// ---------------------------------------------------------------------------

export type CoffeeKind = "hot" | "flash-brew";
export type TeaKind = "tea";
export type PourPattern = "spiral" | "circular" | "center" | "ring";
export type Vibration = "none" | "before" | "after" | "both";
export type TempValue = number | "RT" | "BP";

export type CoffeePour = {
  label?: string;
  ml: number;
  temp_c: TempValue;
  pattern: PourPattern;
  vibration?: Vibration;
  pause_s: number;
  rpm: number;
  flow_ml_s: number;
};

export type TeaPour = {
  label?: string;
  ml: number;
  temp_c: number;
  pattern: PourPattern;
  pause_s: number;
  flow_ml_s: number;
};

export type CoffeeRecipeContent = {
  name: string;
  kind: CoffeeKind;
  dripper?: string;
  dose_g: number;
  grind: number;
  ratio: number;
  water_ml: number;
  hot_water_ml?: number;
  bypass_ml?: number;
  bypass_temp_c?: TempValue;
  ice_g?: number;
  time?: string;
  note?: string;
  pours: CoffeePour[];
};

export type TeaRecipeContent = {
  name: string;
  kind: TeaKind;
  leaf_g: number;
  output_ml_per_steep: number;
  pours: TeaPour[];
};

/** Coffee or tea recipe content only - not an open Record that collapses safety. */
export type RecipeContent = CoffeeRecipeContent | TeaRecipeContent;

export type RecipeValidateResult =
  | {
      valid: true;
      kind: string;
      storage_kind: string;
      content: RecipeContent;
    }
  | {
      valid: false;
      error: {
        category: string;
        message: string;
        type?: string;
      };
    };

export type RecipeRecord = {
  recipe_id: string;
  name: string;
  kind: string;
  source?: string;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
  metadata?: { tags?: string[]; [key: string]: unknown } | null;
  latest_revision?: RecipeRevision | null;
  [key: string]: unknown;
};

export type RecipeRevision = {
  revision_id: string;
  recipe_id?: string;
  revision_number: number;
  parent_revision_id?: string | null;
  content: RecipeContent;
  name?: string | null;
  source?: string;
  provenance?: Record<string, unknown> | null;
  created_at?: string;
  content_sha256?: string;
  [key: string]: unknown;
};

export type RecipeListResult = {
  count: number;
  recipes: RecipeRecord[];
};

export type RecipeGetResult = {
  recipe: RecipeRecord;
  latest_revision: RecipeRevision | null;
};

export type RecipeRevisionsResult = {
  recipe_id: string;
  count: number;
  revisions: RecipeRevision[];
};

export type RecipeCreateResult = {
  recipe: RecipeRecord;
  revision: RecipeRevision;
};

export type FromDesignBody = {
  recipe_candidate: RecipeContent;
  design_rationale: string;
  evidence: DesignEvidenceItem[];
  provenance: {
    provider: string;
    model: string;
    knowledge_version: string;
    knowledge_content_hash: string;
    knowledge_source: "bundle" | "dev_root";
    prompt_template_version: string;
    schema_version: string;
    candidate_hash: string;
    design_mode?: string | null;
    repaired?: boolean | null;
    used_image: boolean;
    used_ocr?: boolean | null;
  };
  name?: string | null;
  tags?: string[] | null;
};

export type RecipeTemplate = {
  template_id: string;
  name: string;
  kind: string;
  dose_g?: number | null;
  leaf_g?: number | null;
  water_ml?: number | null;
  output_ml_per_steep?: number | null;
  grind?: number | null;
  pours?: number;
  content: RecipeContent;
};

export type TemplatesResult = {
  templates: RecipeTemplate[];
};

// ---------------------------------------------------------------------------
// Domain types - device / bridge
// ---------------------------------------------------------------------------

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
  available?: boolean;
  hint?: string;
  connected?: boolean;
  machine?: string | null;
  activity?: string | null;
  phase?: string | null;
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
  connection_scope?: string | null;
  release_state?: string | null;
  [key: string]: unknown;
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
  phase?: string;
  [key: string]: unknown;
};

export type LoadBody = {
  recipe_revision_id: string;
  request_id?: string;
  address?: string;
  scan_timeout?: number;
};

export type StartBody = {
  workflow_id: string;
  confirmation: string;
  request_id?: string;
};

export type RecoveryReconcileOpts = {
  address?: string;
  scan_timeout?: number;
};

// ---------------------------------------------------------------------------
// Domain types - history (browser-safe; no path fields)
// ---------------------------------------------------------------------------

export type HistoryStatus = {
  total: number;
  by_outcome?: Record<string, number>;
  by_source?: Record<string, number>;
  latest_recorded_at?: string;
  exists?: boolean;
  [key: string]: unknown;
};

export type HistoryEvent = {
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

export type HistoryListResult = {
  count: number;
  events: HistoryEvent[];
};

// ---------------------------------------------------------------------------
// Safety phrases (exact; never invent)
// ---------------------------------------------------------------------------

export const COFFEE_START_CONFIRMATION = "cup-filter-water-beans";
export const TEA_START_CONFIRMATION = "tea-brewer-water-cup-clear";

export function startConfirmationForKind(kind: "coffee" | "tea"): string {
  return kind === "tea" ? TEA_START_CONFIRMATION : COFFEE_START_CONFIRMATION;
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const api = {
  // Health
  health: () => get<{ status: string }>("/health"),

  // Auth
  authConfig: async (): Promise<AuthConfig> => {
    const cfg = await get<AuthConfig>("/auth/config");
    configureAuthClient({
      csrfCookie: cfg.csrf_cookie,
      csrfHeader: cfg.csrf_header,
      sessionCookie: cfg.session_cookie,
    });
    return cfg;
  },
  authSession: () => get<AuthSessionResponse>("/auth/session"),
  authSessions: () => get<SessionsListResult>("/auth/sessions"),
  pair: (token: string, clientLabel?: string | null) =>
    postJson<PairResult>(
      "/auth/pair",
      {
        token,
        client_label: clientLabel?.trim() ? clientLabel.trim() : null,
      },
      { csrfExempt: true },
    ),
  pairingNew: (clientLabel?: string | null) =>
    postJson<PairingNewResult>("/auth/pairing/new", {
      client_label: clientLabel?.trim() ? clientLabel.trim() : null,
    }),
  revokeSession: (sessionId: string) =>
    postJson<{ revoked: boolean; session_id: string }>(
      `/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
      {},
    ),
  logout: () => postJson<{ logged_out: boolean }>("/auth/logout", {}),

  // Design
  designConfig: () => get<DesignPublicConfig>("/design/config"),
  designJson: (body: DesignJsonRequest) => postJson<DesignResult>("/design", body),
  designMultipart: (form: FormData) => postForm<DesignResult>("/design", form),

  // Recipes (content / revision ids only - no paths)
  listRecipes: (params?: {
    kind?: "coffee" | "tea";
    query?: string;
    limit?: number;
    offset?: number;
    include_archived?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params?.kind) q.set("kind", params.kind);
    if (params?.query) q.set("query", params.query);
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    if (params?.include_archived) q.set("include_archived", "true");
    const qs = q.toString();
    return get<RecipeListResult>(`/recipes${qs ? `?${qs}` : ""}`);
  },
  getRecipe: (recipeId: string) =>
    get<RecipeGetResult>(`/recipes/${encodeURIComponent(recipeId)}`),
  listRevisions: (recipeId: string) =>
    get<RecipeRevisionsResult>(`/recipes/${encodeURIComponent(recipeId)}/revisions`),
  validateRecipe: (content: RecipeContent) =>
    postJson<RecipeValidateResult>("/recipes/validate", { content }),
  createRecipe: (body: {
    content: RecipeContent;
    name?: string | null;
    tags?: string[] | null;
    provenance?: Record<string, unknown> | null;
  }) => postJson<RecipeCreateResult>("/recipes", body),
  createRevision: (
    recipeId: string,
    body: {
      content: RecipeContent;
      expected_parent_revision_id: string;
      name?: string | null;
      tags?: string[] | null;
      provenance?: Record<string, unknown> | null;
    },
  ) =>
    postJson<RecipeCreateResult>(
      `/recipes/${encodeURIComponent(recipeId)}/revisions`,
      body,
    ),
  fromDesign: (body: FromDesignBody) =>
    postJson<RecipeCreateResult>("/recipes/from-design", body),
  archiveRecipe: (recipeId: string, expectedLatestRevisionId: string) =>
    postJson<{ recipe: RecipeRecord }>(
      `/recipes/${encodeURIComponent(recipeId)}/archive`,
      { expected_latest_revision_id: expectedLatestRevisionId },
    ),
  restoreRecipe: (recipeId: string, expectedLatestRevisionId: string) =>
    postJson<{ recipe: RecipeRecord }>(
      `/recipes/${encodeURIComponent(recipeId)}/restore`,
      { expected_latest_revision_id: expectedLatestRevisionId },
    ),
  templates: () => get<TemplatesResult>("/recipes/templates"),

  // Device - load by revision id only
  coffeeLoad: (body: LoadBody) =>
    postJson<WorkflowResult>("/device/coffee/load", {
      recipe_revision_id: body.recipe_revision_id,
      request_id: body.request_id,
      address: body.address,
      scan_timeout: body.scan_timeout,
    }),
  coffeeStart: (body: StartBody) =>
    postJson<WorkflowResult>("/device/coffee/start", {
      workflow_id: body.workflow_id,
      confirmation: body.confirmation,
      request_id: body.request_id,
    }),
  teaLoad: (body: LoadBody) =>
    postJson<WorkflowResult>("/device/tea/load", {
      recipe_revision_id: body.recipe_revision_id,
      request_id: body.request_id,
      address: body.address,
      scan_timeout: body.scan_timeout,
    }),
  teaStart: (body: StartBody) =>
    postJson<WorkflowResult>("/device/tea/start", {
      workflow_id: body.workflow_id,
      confirmation: body.confirmation,
      request_id: body.request_id,
    }),
  pause: (workflowId: string, requestId: string) =>
    postJson<WorkflowResult>("/device/pause", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  resume: (workflowId: string, requestId: string) =>
    postJson<WorkflowResult>("/device/resume", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  stop: (workflowId: string, requestId: string) =>
    postJson<WorkflowResult>("/device/stop", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  cancel: (workflowId: string, requestId: string) =>
    postJson<WorkflowResult>("/device/cancel", {
      workflow_id: workflowId,
      request_id: requestId,
    }),
  /**
   * Reconcile a known workflow_id. Accepts optional address / scan_timeout only.
   * Does not send request_id (backend RecoveryBody has no request_id field).
   */
  recoveryReconcile: (workflowId: string, opts?: RecoveryReconcileOpts) =>
    postJson<WorkflowResult>("/device/recovery/reconcile", {
      workflow_id: workflowId,
      ...(opts?.address != null ? { address: opts.address } : {}),
      ...(opts?.scan_timeout != null ? { scan_timeout: opts.scan_timeout } : {}),
    }),

  // Observation
  bridge: () => get<BridgeState>("/device/bridge"),
  bridgeEvents: (workflowId: string, since = 0) =>
    get<BridgeEventsResult>(
      `/device/events?workflow_id=${encodeURIComponent(workflowId)}&since=${since}`,
    ),
  scan: (timeout = 8) => get<ScanResult>(`/device/scan?timeout=${timeout}`),
  probe: (address?: string) =>
    get<ProbeResult>(
      `/device/probe${address ? `?address=${encodeURIComponent(address)}` : ""}`,
    ),
  connect: (body?: { address?: string; scan_timeout?: number }) =>
    postJson<WorkflowResult>("/device/connect", body ?? {}),
  disconnect: () => postJson<WorkflowResult>("/device/disconnect", {}),

  // History
  historyStatus: () => get<HistoryStatus>("/history/status"),
  historyList: (limit = 50) =>
    get<HistoryListResult>(`/history/list?limit=${limit}`),
};
