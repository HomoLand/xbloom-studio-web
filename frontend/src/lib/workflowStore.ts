/**
 * Persist exact workflow IDs returned by load/start.
 * Never invent IDs. Only store values the server provided.
 */

const WORKFLOW_ID_KEY = "xbloom.workflow_id";
const WORKFLOW_KIND_KEY = "xbloom.workflow_kind";
const WORKFLOW_REVISION_KEY = "xbloom.workflow_revision_id";

export type WorkflowKind = "coffee" | "tea";

export type StoredWorkflow = {
  workflowId: string;
  kind: WorkflowKind;
  recipeRevisionId?: string;
};

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function readStoredWorkflow(): StoredWorkflow | null {
  if (!canUseStorage()) return null;
  const workflowId = localStorage.getItem(WORKFLOW_ID_KEY)?.trim() || "";
  if (!workflowId) return null;
  const kindRaw = localStorage.getItem(WORKFLOW_KIND_KEY)?.trim() || "";
  const kind: WorkflowKind = kindRaw === "tea" ? "tea" : "coffee";
  const recipeRevisionId =
    localStorage.getItem(WORKFLOW_REVISION_KEY)?.trim() || undefined;
  return { workflowId, kind, recipeRevisionId };
}

export function persistWorkflow(
  workflowId: string,
  kind: WorkflowKind,
  recipeRevisionId?: string,
): void {
  if (!canUseStorage()) return;
  const id = workflowId.trim();
  if (!id) return;
  localStorage.setItem(WORKFLOW_ID_KEY, id);
  localStorage.setItem(WORKFLOW_KIND_KEY, kind);
  if (recipeRevisionId?.trim()) {
    localStorage.setItem(WORKFLOW_REVISION_KEY, recipeRevisionId.trim());
  } else {
    // Do not retain a stale revision key from a previous workflow.
    localStorage.removeItem(WORKFLOW_REVISION_KEY);
  }
}

export function clearStoredWorkflow(): void {
  if (!canUseStorage()) return;
  localStorage.removeItem(WORKFLOW_ID_KEY);
  localStorage.removeItem(WORKFLOW_KIND_KEY);
  localStorage.removeItem(WORKFLOW_REVISION_KEY);
}
