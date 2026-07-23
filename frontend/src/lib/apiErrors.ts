/**
 * Reusable API / bridge error classification (Phase C8).
 * Concrete UX copy for provider timeout, invalid candidate, auth expiration,
 * wrong workflow, protocol/bridge incompatible, device_busy_external,
 * recovery_required - without inventing workflow or request IDs.
 *
 * Uses duck-typed error fields so pure unit tests need no browser fetch module.
 */

function shortId(id: string, keep = 8): string {
  if (!id) return "-";
  if (id.length <= keep + 4) return id;
  return `${id.slice(0, keep)}...`;
}

export type OperationalErrorKind =
  | "auth_expired"
  | "provider_timeout"
  | "provider"
  | "invalid_candidate"
  | "validation"
  | "workflow_mismatch"
  | "protocol_incompatible"
  | "device_busy_external"
  | "recovery_required"
  | "daemon_unavailable"
  | "timeout"
  | "network"
  | "uncertain"
  | "unknown";

export type ClassifiedOperationalError = {
  kind: OperationalErrorKind;
  message: string;
  /** Short guidance for the user. */
  action: string | null;
  /** Tone for banners. */
  tone: "red" | "amber" | "blue";
  /**
   * When true, do not auto-retry the same mutation; preserve workflow context.
   */
  uncertain: boolean;
  /** Hide retry / mutation until user navigates or corrects. */
  blockMutation: boolean;
  /** When true, stop polling and refresh AuthContext (pairing gate). */
  authExpired: boolean;
  /** Device busy: keep banner until a later successful refresh corrects. */
  stickyBusy: boolean;
  /** Preferred actual workflow id (server details first). */
  workflowId?: string;
  /** Caller-known id when different from server-provided actual. */
  knownWorkflowId?: string;
  code?: string;
  category?: string;
  status?: number;
};

/** Minimal shape shared with ApiError (duck-typed). */
export type ErrorFields = {
  message: string;
  status: number;
  code: string;
  category: string;
  details: Record<string, unknown> | null;
};

export function readErrorFields(e: unknown): ErrorFields | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (typeof o.message !== "string") return null;
  if (typeof o.status !== "number") return null;
  return {
    message: o.message,
    status: o.status,
    code: typeof o.code === "string" ? o.code : "unknown",
    category: typeof o.category === "string" ? o.category : "unknown",
    details:
      o.details && typeof o.details === "object" && !Array.isArray(o.details)
        ? (o.details as Record<string, unknown>)
        : null,
  };
}

function detailsWorkflowId(
  details: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!details) return undefined;
  const w = details.workflow_id;
  return typeof w === "string" && w.trim() ? w.trim() : undefined;
}

/**
 * Prefer server-provided details.workflow_id as the actual workflow.
 * Preserve known id separately when it differs.
 */
function resolveWorkflowIds(
  details: Record<string, unknown> | null | undefined,
  knownWorkflowId?: string,
): { workflowId?: string; knownWorkflowId?: string } {
  const actual = detailsWorkflowId(details);
  const known =
    typeof knownWorkflowId === "string" && knownWorkflowId.trim()
      ? knownWorkflowId.trim()
      : undefined;
  if (actual) {
    return {
      workflowId: actual,
      knownWorkflowId: known && known !== actual ? known : undefined,
    };
  }
  return { workflowId: known, knownWorkflowId: undefined };
}

export function isAuthExpiredError(e: unknown): boolean {
  const f = readErrorFields(e);
  if (!f) return false;
  if (f.status === 401) return true;
  const code = (f.code || "").toLowerCase();
  return (
    f.category === "authentication" ||
    code === "auth_required" ||
    code === "session_expired" ||
    code === "unauthenticated"
  );
}

/**
 * True only when the failure is clearly a design/vision provider timeout -
 * not a generic hardware/control/status timeout.
 */
export function isProviderTimeoutError(
  f: ErrorFields,
  opts?: { context?: string },
): boolean {
  const code = (f.code || "").toLowerCase();
  const cat = (f.category || "").toLowerCase();
  const ctx = (opts?.context || "").toLowerCase();

  if (code === "provider_timeout" || code.includes("provider_timeout")) {
    return true;
  }
  if (code.includes("provider") && (cat === "timeout" || code.includes("timeout"))) {
    return true;
  }
  if (cat === "provider" && (code.includes("timeout") || f.status === 504)) {
    return true;
  }
  // Caller context: Design / provider surfaces only.
  if (
    (ctx.includes("design") || ctx.includes("provider")) &&
    (cat === "timeout" || code === "timeout" || f.status === 504)
  ) {
    return true;
  }
  return false;
}

/**
 * Classify an API/bridge/provider failure for Dashboard and shared surfaces.
 * Does not invent workflow_id; only surfaces server-provided IDs.
 */
export function classifyOperationalError(
  e: unknown,
  opts?: {
    context?: string;
    knownWorkflowId?: string;
  },
): ClassifiedOperationalError {
  const ctx = opts?.context?.trim() ? `${opts.context}: ` : "";
  const f = readErrorFields(e);

  if (!f) {
    return {
      kind: "uncertain",
      message: `${ctx}${e instanceof Error ? e.message : String(e)}`,
      action:
        "Outcome may be uncertain. Check Dashboard status before repeating a hardware action.",
      tone: "amber",
      uncertain: true,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId: opts?.knownWorkflowId,
    };
  }

  const code = (f.code || "").toLowerCase();
  const cat = f.category;
  const { workflowId, knownWorkflowId } = resolveWorkflowIds(
    f.details,
    opts?.knownWorkflowId,
  );
  const wfHint = workflowId
    ? ` Workflow ${shortId(workflowId, 12)} is preserved.`
    : "";
  const message = `${ctx}${f.message}`;

  // Auth expiration: stop loops; AuthContext refresh returns to pairing gate.
  if (isAuthExpiredError(e)) {
    return {
      kind: "auth_expired",
      message,
      action: "Session expired. Re-pair this device from a trusted host.",
      tone: "amber",
      uncertain: false,
      blockMutation: true,
      authExpired: true,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (
    cat === "timeout" ||
    code === "timeout" ||
    code === "provider_timeout" ||
    code.includes("timeout") ||
    f.status === 504
  ) {
    const isProvider = isProviderTimeoutError(f, { context: opts?.context });
    return {
      kind: isProvider ? "provider_timeout" : "timeout",
      message,
      action: isProvider
        ? "Provider timed out. Retry with a smaller image or shorter notes, or increase the host timeout."
        : "Request timed out. Refresh status; do not blindly repeat an uncertain hardware action.",
      tone: "amber",
      uncertain: true,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (cat === "provider" || code === "provider_error" || f.status === 502) {
    return {
      kind: "provider",
      message,
      action:
        "Upstream provider failed. Check API base URL and key on the host, then retry once.",
      tone: "red",
      uncertain: false,
      blockMutation: false,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (
    code === "invalid_candidate" ||
    code === "schema_error" ||
    code === "invalid_recipe"
  ) {
    return {
      kind: "invalid_candidate",
      message,
      action:
        "Candidate failed validation. Edit the recipe fields and re-validate before saving or brewing.",
      tone: "amber",
      uncertain: false,
      blockMutation: false,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (
    cat === "validation" ||
    code === "invalid_request" ||
    code === "validation_error" ||
    f.status === 400 ||
    f.status === 422
  ) {
    return {
      kind: "validation",
      message,
      action: "Correct the highlighted issue, then try again.",
      tone: "amber",
      uncertain: false,
      blockMutation: false,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (code === "device_busy_external") {
    return {
      kind: "device_busy_external",
      message,
      action:
        "Another device or app owns the BLE link. Release it there; this UI will not background-reconnect or preempt. Refresh when free.",
      tone: "amber",
      uncertain: false,
      blockMutation: false,
      authExpired: false,
      stickyBusy: true,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (
    code === "protocol_incompatible" ||
    code === "daemon_not_client_ready"
  ) {
    return {
      kind: "protocol_incompatible",
      message,
      action:
        "Bridge protocol is incompatible with this client. Upgrade or restart bridge when idle, then refresh.",
      tone: "red",
      uncertain: false,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (code === "daemon_not_running") {
    return {
      kind: "daemon_unavailable",
      message,
      action:
        "Bridge daemon is not running. Restart the host backend or start xbloom-bridge, then refresh.",
      tone: "red",
      uncertain: false,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (code === "workflow_mismatch" || code === "workflow_conflict") {
    return {
      kind: "workflow_mismatch",
      message,
      action: `Wrong or stale workflow.${wfHint} Switch to the active workflow on Dashboard; do not control with a stale ID.`,
      tone: "amber",
      uncertain: false,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (code === "recovery_required") {
    return {
      kind: "recovery_required",
      message,
      action: `Recovery required.${wfHint} Use Reconcile with the exact workflow ID.`,
      tone: "amber",
      uncertain: true,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  if (
    cat === "network" ||
    code === "network" ||
    f.status === 0 ||
    f.status === 503 ||
    f.status === 502 ||
    cat === "bridge" ||
    code === "bridge_error"
  ) {
    return {
      kind: f.status === 0 || cat === "network" ? "network" : "uncertain",
      message,
      action: `Status may be stale or the outcome uncertain.${wfHint} Refresh; do not blindly repeat a hardware mutation.`,
      tone: "amber",
      uncertain: true,
      blockMutation: true,
      authExpired: false,
      stickyBusy: false,
      workflowId,
      knownWorkflowId,
      code: f.code,
      category: cat,
      status: f.status,
    };
  }

  return {
    kind: "unknown",
    message,
    action: workflowId
      ? `Open Dashboard for workflow ${shortId(workflowId, 12)} before another attempt.`
      : null,
    tone: "red",
    uncertain: Boolean(workflowId),
    blockMutation: Boolean(workflowId),
    authExpired: false,
    stickyBusy: false,
    workflowId,
    knownWorkflowId,
    code: f.code,
    category: cat,
    status: f.status,
  };
}

/**
 * Design-page oriented recovery string (compatible with existing Design UX).
 */
export function designErrorRecovery(e: unknown): string | null {
  const c = classifyOperationalError(e, { context: "Design" });
  if (c.kind === "auth_expired") {
    return "Session expired. Re-pair this device from Settings.";
  }
  if (c.kind === "provider_timeout") {
    return "Provider timed out. Retry with a smaller image or shorter notes, or increase design timeout on the host.";
  }
  if (c.kind === "provider") {
    return "Upstream provider failed. Check API base URL/key on the host and retry once.";
  }
  if (c.kind === "validation" || c.kind === "invalid_candidate") {
    return "Adjust input: supported image MIME, size limits, and coffee/tea beverage only.";
  }
  if (c.kind === "daemon_unavailable" || c.kind === "protocol_incompatible") {
    return c.action;
  }
  return c.action;
}
