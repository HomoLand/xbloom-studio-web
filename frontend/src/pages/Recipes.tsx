import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Play, RefreshCw, Save, X } from "lucide-react";
import {
  api,
  ApiError,
  type RecipeContent,
  type RecipeRecord,
  type RecipeRevision,
  type RecipeValidateResult,
} from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import { CoffeeEditor, TeaEditor } from "../components/RecipeEditors";
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from "../components/ui";
import {
  cloneContent,
  contentIdentity,
  isCoffeeContent,
  isTeaContent,
  recipeDisplayName,
  shortId,
  storageKindOf,
} from "../lib/recipeDomain";

const VALIDATE_DEBOUNCE_MS = 400;

export default function Recipes() {
  const navigate = useNavigate();
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailRecipe, setDetailRecipe] = useState<RecipeRecord | null>(null);
  const [latest, setLatest] = useState<RecipeRevision | null>(null);
  const [revisions, setRevisions] = useState<RecipeRevision[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);

  // Edit mode for latest revision (creates a new immutable revision on save).
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState<RecipeContent | null>(null);
  const [editContentId, setEditContentId] = useState<string | null>(null);
  const [editParentId, setEditParentId] = useState<string | null>(null);
  const [validateState, setValidateState] = useState<RecipeValidateResult | null>(
    null,
  );
  const [validatedForId, setValidatedForId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [staleParent, setStaleParent] = useState(false);
  /** After stale-parent refresh, ask user to review buffer before save. */
  const [reviewBeforeSave, setReviewBeforeSave] = useState(false);

  const detailSeq = useRef(0);
  const validateSeq = useRef(0);
  const lastAppliedCanonical = useRef<string | null>(null);

  const abandonEditValidation = () => {
    // Abort in-flight validation so an old response cannot write into a new selection.
    validateSeq.current += 1;
    setValidating(false);
    setValidateState(null);
    setValidatedForId(null);
    lastAppliedCanonical.current = null;
  };

  const loadList = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.listRecipes({ limit: 100 });
      setRecipes(res.recipes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = async (recipeId: string) => {
    // Do not switch recipes while a save / stale-parent refresh is in flight.
    if (saveBusy) return;
    const seq = ++detailSeq.current;
    setSelectedId(recipeId);
    setDetailLoading(true);
    setError(null);
    // Never show previous recipe detail under the new selection while loading.
    setDetailRecipe(null);
    setLatest(null);
    setRevisions([]);
    // Abandon any edit/validation for the prior selection.
    abandonEditValidation();
    setEditing(false);
    setEditContent(null);
    setEditContentId(null);
    setEditParentId(null);
    setSaveError(null);
    setStaleParent(false);
    setReviewBeforeSave(false);
    try {
      const [got, revs] = await Promise.all([
        api.getRecipe(recipeId),
        api.listRevisions(recipeId),
      ]);
      // Guard async races when the user selects A then B quickly.
      if (seq !== detailSeq.current) return;
      setDetailRecipe(got.recipe);
      setLatest(got.latest_revision);
      setRevisions(revs.revisions);
    } catch (e) {
      if (seq !== detailSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setDetailRecipe(null);
      setLatest(null);
      setRevisions([]);
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  };

  /**
   * Normal refresh (post-save / explicit library refresh of detail):
   * exits edit mode and reloads newest recipe/revisions/list.
   */
  const refreshDetail = async (recipeId: string) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setStaleParent(false);
    setSaveError(null);
    setReviewBeforeSave(false);
    abandonEditValidation();
    setEditing(false);
    setEditContent(null);
    setEditContentId(null);
    setEditParentId(null);
    try {
      const [got, revs, list] = await Promise.all([
        api.getRecipe(recipeId),
        api.listRevisions(recipeId),
        api.listRecipes({ limit: 100 }),
      ]);
      if (seq !== detailSeq.current) return;
      setDetailRecipe(got.recipe);
      setLatest(got.latest_revision);
      setRevisions(revs.revisions);
      setRecipes(list.recipes);
    } catch (e) {
      if (seq !== detailSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  };

  /**
   * Stale-parent refresh after 409: fetch newest metadata while preserving the
   * exact edit buffer. Never silently overwrites user edits.
   */
  const refreshStaleParent = async (recipeId: string) => {
    // Capture buffer identities now; do not clear them during fetch.
    const preservedContent = editContent;
    const preservedId = editContentId;
    const seq = ++detailSeq.current;
    setSaveBusy(true);
    setError(null);
    try {
      const [got, revs, list] = await Promise.all([
        api.getRecipe(recipeId),
        api.listRevisions(recipeId),
        api.listRecipes({ limit: 100 }),
      ]);
      if (seq !== detailSeq.current) return;
      setDetailRecipe(got.recipe);
      setLatest(got.latest_revision);
      setRevisions(revs.revisions);
      setRecipes(list.recipes);
      const newestParent = got.latest_revision?.revision_id ?? null;
      if (newestParent) {
        setEditParentId(newestParent);
      }
      // Keep editing=true and the exact edit buffer; re-validate same content.
      setEditing(true);
      setStaleParent(false);
      setSaveError(null);
      setReviewBeforeSave(true);
      if (preservedContent && preservedId) {
        // Invalidate any in-flight validate, then re-run for preserved buffer.
        abandonEditValidation();
        void runValidate(preservedContent, preservedId);
      }
    } catch (e) {
      if (seq !== detailSeq.current) return;
      // Keep edit buffer and stale warning on failure.
      setSaveError(
        e instanceof Error
          ? `Could not refresh parent: ${e.message}. Your edits are still here.`
          : "Could not refresh parent. Your edits are still here.",
      );
      setStaleParent(true);
    } finally {
      // Always clear saveBusy when this op finishes so a later legitimate
      // selection change cannot leave the busy flag stuck. Library selection
      // is disabled while saveBusy is true, so races are prevented at the UI.
      setSaveBusy(false);
    }
  };

  const startEdit = () => {
    if (!latest?.content || !latest.revision_id) return;
    const content = cloneContent(latest.content);
    const id = contentIdentity(content);
    abandonEditValidation();
    setEditing(true);
    setEditContent(content);
    setEditContentId(id);
    setEditParentId(latest.revision_id);
    setSaveError(null);
    setStaleParent(false);
    setReviewBeforeSave(false);
  };

  const cancelEdit = () => {
    abandonEditValidation();
    setEditing(false);
    setEditContent(null);
    setEditContentId(null);
    setEditParentId(null);
    setSaveError(null);
    setStaleParent(false);
    setReviewBeforeSave(false);
  };

  const onEditChange = (next: RecipeContent) => {
    validateSeq.current += 1;
    setValidating(false);
    setValidateState(null);
    setValidatedForId(null);
    lastAppliedCanonical.current = null;
    setSaveError(null);
    setReviewBeforeSave(false);
    setEditContent(cloneContent(next));
    setEditContentId(contentIdentity(next));
  };

  const runValidate = useCallback(
    async (content: RecipeContent, forId: string) => {
      const seq = ++validateSeq.current;
      setValidating(true);
      try {
        const res = await api.validateRecipe(content);
        if (seq !== validateSeq.current) return;
        if (forId !== contentIdentity(content)) return;
        setValidateState(res);
        setValidatedForId(forId);
        if (res.valid) {
          const serverId = contentIdentity(res.content);
          if (serverId !== forId && serverId !== lastAppliedCanonical.current) {
            lastAppliedCanonical.current = serverId;
            setEditContent(cloneContent(res.content));
            const appliedId = contentIdentity(res.content);
            setEditContentId(appliedId);
            setValidatedForId(appliedId);
            setValidateState(res);
          }
        }
      } catch (e) {
        if (seq !== validateSeq.current) return;
        setValidateState({
          valid: false,
          error: {
            category: "validation",
            message: e instanceof Error ? e.message : String(e),
          },
        });
        setValidatedForId(forId);
      } finally {
        if (seq === validateSeq.current) setValidating(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!editing || !editContent || !editContentId) return;
    const handle = window.setTimeout(() => {
      void runValidate(editContent, editContentId);
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [editing, editContent, editContentId, runValidate]);

  const saveRevision = async () => {
    if (!detailRecipe || !editContent || !editContentId || !editParentId) return;
    if (
      !validateState ||
      !validateState.valid ||
      validatedForId !== editContentId ||
      validating
    ) {
      setSaveError("Cannot save until the current content is validated.");
      return;
    }
    const content = validateState.content;
    // Fail closed: validated payload, editContentId, and visible buffer must match.
    const validatedId = contentIdentity(content);
    const visibleId = contentIdentity(editContent);
    if (
      validatedId !== editContentId ||
      visibleId !== editContentId ||
      validatedForId !== editContentId
    ) {
      setSaveError("Cannot save: content changed since validation.");
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    setStaleParent(false);
    try {
      const saved = await api.createRevision(detailRecipe.recipe_id, {
        content,
        expected_parent_revision_id: editParentId,
        name: typeof content.name === "string" ? content.name : undefined,
      });
      // Post-save refresh may exit edit mode.
      setEditing(false);
      setEditContent(null);
      setEditContentId(null);
      setEditParentId(null);
      setValidateState(null);
      setValidatedForId(null);
      setReviewBeforeSave(false);
      setDetailRecipe(saved.recipe);
      setLatest(saved.revision);
      await refreshDetail(detailRecipe.recipe_id);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.category === "conflict")) {
        // Keep edits; offer stale-parent refresh that preserves the buffer.
        setStaleParent(true);
        setSaveError(
          "A newer revision exists. Your edits are kept. Refresh parent, review, then save.",
        );
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaveBusy(false);
    }
  };

  const startBrew = (revision: RecipeRevision, recipeName?: string) => {
    if (!revision.revision_id || !revision.content) return;
    setBrewTarget({
      recipeRevisionId: revision.revision_id,
      content: revision.content,
      revision,
      recipeName: recipeName || recipeDisplayName(revision.content),
    });
  };

  const validationMatchesCurrent =
    !!editContent &&
    !!editContentId &&
    !!validateState &&
    validateState.valid &&
    validatedForId === editContentId &&
    !validating;

  const canSave =
    editing &&
    validationMatchesCurrent &&
    !saveBusy &&
    !!editParentId &&
    !staleParent;

  // Never render recipe A's detail under selection B while B is loading.
  const showDetailLoading =
    detailLoading ||
    (!!selectedId &&
      !!detailRecipe &&
      detailRecipe.recipe_id !== selectedId);

  return (
    <div>
      <PageHeader
        title="Recipes"
        description="Browse recipes, edit the latest, or brew a revision."
        actions={
          <IconButton
            label="Refresh recipes"
            disabled={saveBusy}
            onClick={() => void loadList()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </IconButton>
        }
      />

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel title={`Library (${recipes.length})`}>
          {loading ? (
            <Spinner label="Loading recipes" />
          ) : recipes.length === 0 ? (
            <EmptyState
              title="No recipes yet"
              description="Design a candidate and save it to get started."
              action={
                <Button variant="primary" size="sm" onClick={() => navigate("/design")}>
                  Open Design
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {recipes.map((r) => {
                const active = r.recipe_id === selectedId;
                const rev = r.latest_revision;
                const content = rev?.content;
                return (
                  <li key={r.recipe_id}>
                    <button
                      type="button"
                      disabled={saveBusy}
                      onClick={() => void openDetail(r.recipe_id)}
                      className={`flex w-full flex-col gap-1 px-1 py-3 text-left transition-colors first:pt-0 disabled:pointer-events-none disabled:opacity-50 ${
                        active ? "bg-surface-2/60" : "hover:bg-surface-2/40"
                      } rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {r.name || "Untitled"}
                        </span>
                        <StatusPill
                          tone={r.kind === "tea" ? "blue" : "green"}
                        >
                          {r.kind}
                        </StatusPill>
                      </div>
                      <div className="text-xs text-ink-faint">
                        {shortId(r.recipe_id, 10)}
                        {rev
                          ? ` | rev #${rev.revision_number} | ${shortId(rev.revision_id, 8)}`
                          : ""}
                        {content && isCoffeeContent(content)
                          ? ` | ${content.dose_g ?? "?"}g`
                          : ""}
                        {content && isTeaContent(content)
                          ? ` | ${content.leaf_g}g leaf`
                          : ""}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Detail">
          {!selectedId ? (
            <p className="text-sm text-ink-muted">
              Select a recipe to inspect revisions, edit the latest, or brew.
            </p>
          ) : showDetailLoading ? (
            <Spinner label="Loading detail" />
          ) : detailRecipe ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold text-ink">
                  {detailRecipe.name}
                </h3>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-ink-faint">
                  <StatusPill tone="neutral">{detailRecipe.kind}</StatusPill>
                  <span>id {shortId(detailRecipe.recipe_id, 12)}</span>
                  {detailRecipe.source ? (
                    <span>source {detailRecipe.source}</span>
                  ) : null}
                </div>
              </div>

              {editing && editContent ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium text-ink">
                      Edit latest (new revision)
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {validating ? (
                        <span className="text-xs text-ink-faint">Validating...</span>
                      ) : validationMatchesCurrent ? (
                        <StatusPill tone="green">Valid</StatusPill>
                      ) : validateState &&
                        !validateState.valid &&
                        validatedForId === editContentId ? (
                        <StatusPill tone="red">Invalid</StatusPill>
                      ) : (
                        <StatusPill tone="amber">Pending</StatusPill>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-ink-faint">
                    Parent {shortId(editParentId || "", 14)}
                  </p>
                  {reviewBeforeSave ? (
                    <Alert tone="blue" title="Review before save">
                      Parent updated to the newest revision. Review your edits,
                      then save.
                    </Alert>
                  ) : null}
                  {isTeaContent(editContent) ? (
                    <TeaEditor
                      value={editContent}
                      onChange={onEditChange}
                      disabled={saveBusy}
                    />
                  ) : isCoffeeContent(editContent) ? (
                    <CoffeeEditor
                      value={editContent}
                      onChange={onEditChange}
                      disabled={saveBusy}
                    />
                  ) : (
                    <Alert tone="amber">Unsupported recipe shape for editing.</Alert>
                  )}
                  {validateState &&
                  !validateState.valid &&
                  validatedForId === editContentId ? (
                    <Alert tone="red" title="Validation">
                      {validateState.error.message}
                    </Alert>
                  ) : null}
                  {saveError ? (
                    <Alert
                      tone={staleParent ? "amber" : "red"}
                      title={staleParent ? "Newer revision exists" : "Save failed"}
                    >
                      {saveError}
                    </Alert>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={!canSave}
                      onClick={() => void saveRevision()}
                    >
                      <Save className="h-3.5 w-3.5" aria-hidden />
                      {saveBusy ? "Saving..." : "Save new revision"}
                    </Button>
                    {staleParent ? (
                      <Button
                        variant="secondary"
                        disabled={saveBusy}
                        onClick={() =>
                          void refreshStaleParent(detailRecipe.recipe_id)
                        }
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        Refresh parent
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={saveBusy}
                      onClick={cancelEdit}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : latest ? (
                <div className="rounded-lg border border-line bg-paper p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-ink">
                        Latest revision #{latest.revision_number}
                      </div>
                      <div className="text-xs text-ink-faint">
                        {shortId(latest.revision_id, 16)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={startEdit}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="success"
                        onClick={() => startBrew(latest, detailRecipe.name)}
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden />
                        Brew latest
                      </Button>
                    </div>
                  </div>
                  <RecipeSummary content={latest.content} />
                </div>
              ) : (
                <Alert tone="amber">No latest revision on this recipe.</Alert>
              )}

              {!editing ? (
                <div>
                  <h4 className="mb-2 text-sm font-medium text-ink">
                    Revision timeline
                  </h4>
                  {revisions.length === 0 ? (
                    <p className="text-sm text-ink-muted">No revisions.</p>
                  ) : (
                    <ol className="space-y-2">
                      {[...revisions].reverse().map((rev) => (
                        <li
                          key={rev.revision_id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                        >
                          <div className="min-w-0 text-sm">
                            <span className="font-medium text-ink">
                              #{rev.revision_number}
                            </span>{" "}
                            <span className="text-ink-muted">
                              {shortId(rev.revision_id, 12)}
                            </span>
                            {rev.created_at ? (
                              <span className="block text-xs text-ink-faint">
                                {new Date(rev.created_at).toLocaleString()}
                              </span>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              startBrew(rev, detailRecipe.name)
                            }
                          >
                            Brew
                          </Button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Recipe not found.</p>
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

function RecipeSummary({ content }: { content: RecipeContent }) {
  const kind = storageKindOf(content);
  if (isTeaContent(content)) {
    return (
      <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-ink-muted">
        <span>Leaf {content.leaf_g} g</span>
        <span>Output {content.output_ml_per_steep} ml</span>
        <span>Steeps {content.pours?.length ?? 0}</span>
        <span>{kind}</span>
      </div>
    );
  }
  if (!isCoffeeContent(content)) {
    return <div className="mt-2 text-xs text-ink-muted">{kind}</div>;
  }
  return (
    <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-ink-muted">
      <span>
        {content.dose_g ?? "-"} g | grind {content.grind ?? "-"}
      </span>
      <span>{content.water_ml ?? "-"} ml water</span>
      <span>{Array.isArray(content.pours) ? content.pours.length : 0} pours</span>
      <span>{content.kind ?? kind}</span>
    </div>
  );
}
