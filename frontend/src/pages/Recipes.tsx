/**
 * Recipe browser — local-first; optional official account cloud sync.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Cloud,
  CloudUpload,
  Download,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { api, type RecipeContent, type RecipeRecord, type RecipeRevision } from "../api";
import { isStaticDeploy } from "../lib/deploy";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import { RecipeCard } from "../components/RecipeCard";
import { SlotProgrammer } from "../components/SlotProgrammer";
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  Dialog,
  Segmented,
  Spinner,
  StatusPill,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { getAccountCredentials } from "../lib/accountPrefs";
import { mergeRecipeLibrary } from "../lib/recipeLibrary";
import {
  importCloudSyncTargets,
  importShareLink,
} from "../lib/cloudCatalog";
import {
  deleteUserRecipe,
  getLocalRecipe,
  isOwnedOnCloud,
  listAllLocalRecipes,
  promoteLocalToCloudOwned,
  resolveOwnedTableId,
  saveUserRecipe,
  toLatestRevision,
  toRecipeRecord,
  type LocalRecipeEntry,
} from "../lib/localRecipes";
import {
  isCoffeeContent,
  isTeaContent,
  recipeDisplayName,
} from "../lib/recipeDomain";
import {
  downloadText,
  exportRecipesJson,
  exportSingleRecipeJson,
  importRecipesFromJson,
} from "../lib/recipeIo";
import { importCloudBrewRecords } from "../lib/localHistory";
import {
  CLOUD_DELETE_CONFIRM,
  CLOUD_WRITE_CONFIRM,
  CloudError,
  createCloudShareLink,
  deleteCloudRecipe,
  fetchCloudBrewRecords,
  pushCloudRecipe,
  syncAccountCatalog,
  updateCloudRecipe,
} from "../lib/xbloomCloud";
import { useMachine } from "../machine/MachineContext";

export default function Recipes() {
  const { t } = useI18n();
  const { driver } = useMachine();
  const [searchParams, setSearchParams] = useSearchParams();
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeRecord | null>(null);
  const [latest, setLatest] = useState<RecipeRevision | null>(null);
  const [localEntry, setLocalEntry] = useState<LocalRecipeEntry | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<"all" | "coffee" | "tea">("all");
  const [query, setQuery] = useState("");
  const [shareInput, setShareInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const hostRecipes = useRef(new Map<string, RecipeRecord>());

  const loadList = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const list = listAllLocalRecipes().map(toRecipeRecord);
      const remote: RecipeRecord[] = [];
      if (!isStaticDeploy()) {
        for (let offset = 0; ; offset += 500) {
          const page = await api.listRecipes({ limit: 500, offset, include_archived: true });
          remote.push(...page.recipes);
          if (page.recipes.length < 500) break;
        }
      }
      hostRecipes.current = new Map(remote.filter(recipe => !recipe.archived_at).map(recipe => [recipe.recipe_id, recipe]));
      setRecipes(mergeRecipeLibrary(remote, list));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetail = useCallback(
    (recipeId: string, opts?: { quietMissing?: boolean }) => {
      setSelectedId(recipeId);
      const remote = hostRecipes.current.get(recipeId);
      if (remote) {
        setDetail(remote);
        setLatest(remote.latest_revision ?? null);
        setLocalEntry(null);
        setError(null);
        return;
      }
      const entry = getLocalRecipe(recipeId);
      if (!entry) {
        setSelectedId(null);
        setDetail(null);
        setLatest(null);
        setLocalEntry(null);
        // After delete, runCloud may refresh a gone id — stay silent.
        if (!opts?.quietMissing) {
          setError(t("recipes.notFound"));
        }
        return;
      }
      setDetail(toRecipeRecord(entry));
      setLatest(toLatestRevision(entry));
      setLocalEntry(entry);
      setError(null);
    },
    [t],
  );

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    const sel = searchParams.get("selected");
    if (sel && !loading) openDetail(sel);
  }, [searchParams, openDetail, loading]);

  const content: RecipeContent | null = latest?.content ?? null;
  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setLatest(null);
    setLocalEntry(null);
    setDetailMenuOpen(false);
    if (searchParams.has("selected")) setSearchParams({}, { replace: true });
  };
  const canBrewContent =
    content != null &&
    (isCoffeeContent(content) || isTeaContent(content));
  /** Web Bluetooth near-field or Bridge daemon (load via host SQLite revision). */
  const canBrew =
    canBrewContent &&
    (driver === "web-bluetooth" || driver === "bridge");

  const filteredRecipes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recipes.filter((r) => {
      const c =
        (r.latest_revision?.content as RecipeContent | undefined) ??
        getLocalRecipe(r.recipe_id)?.content;
      if (kindFilter === "tea") {
        if (!c || !isTeaContent(c)) return false;
      } else if (kindFilter === "coffee") {
        if (!c || !isCoffeeContent(c)) return false;
      }
      if (!q) return true;
      const name = (r.name || (c ? recipeDisplayName(c) : "")).toLowerCase();
      const id = r.recipe_id.toLowerCase();
      const kind = String(r.kind || "").toLowerCase();
      const note =
        c && isCoffeeContent(c) && c.note
          ? String(c.note).toLowerCase()
          : "";
      return (
        name.includes(q) || id.includes(q) || kind.includes(q) || note.includes(q)
      );
    });
  }, [recipes, kindFilter, query]);

  const requireCreds = async () => {
    const creds = await getAccountCredentials();
    if (!creds) throw new CloudError(t("cloud.needSettings"));
    return creds;
  };

  const runCloud = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setInfo(null);
    setCloudBusy(label);
    try {
      await fn();
      loadList();
      // Only re-open detail if the recipe still exists (e.g. not after delete).
      if (selectedId && getLocalRecipe(selectedId)) {
        openDetail(selectedId, { quietMissing: true });
      } else if (selectedId && !getLocalRecipe(selectedId)) {
        setSelectedId(null);
        setDetail(null);
        setLatest(null);
        setLocalEntry(null);
      }
    } catch (e) {
      if (e instanceof CloudError && e.code === "not_on_account") {
        setError(t("cloud.notOnAccount"));
      } else {
        setError(
          e instanceof CloudError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e),
        );
      }
    } finally {
      setCloudBusy(null);
    }
  };

  const onSync = () =>
    void runCloud("sync", async () => {
      const creds = await requireCreds();
      const result = await syncAccountCatalog({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        languageType: creds.languageType,
      });
      const imported = importCloudSyncTargets(result.targets, result.region);
      const total = imported.stats.reduce((s, x) => s + x.imported, 0);
      const candidates = imported.stats.reduce((s, x) => s + x.candidates, 0);
      let historyNote = "";
      try {
        const hist = await fetchCloudBrewRecords({
          email: creds.email,
          password: creds.password,
          region: creds.region,
          languageType: creds.languageType,
        });
        const merged = importCloudBrewRecords(hist.records, hist.region);
        historyNote = t("cloud.syncHistoryNote")
          .replace("{imported}", String(merged.imported))
          .replace("{updated}", String(merged.updated));
      } catch {
        historyNote = t("cloud.syncHistoryFailed");
      }
      setInfo(
        t("cloud.syncDone")
          .replace("{imported}", String(total))
          .replace("{candidates}", String(candidates))
          .replace("{region}", result.region) +
          (historyNote ? ` · ${historyNote}` : ""),
      );
    });

  const onPush = () =>
    void runCloud("push", async () => {
      const creds = await requireCreds();
      if (!content) throw new CloudError(t("cloud.noRecipe"));
      const result = await pushCloudRecipe({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        content,
        confirmWrite: CLOUD_WRITE_CONFIRM,
      });
      if (result.status === "already-present") {
        setInfo(t("cloud.alreadyPresentSimple"));
        if (localEntry && result.remote_table_id) {
          const promoted = promoteLocalToCloudOwned(localEntry.recipe_id, {
            content,
            tableId: result.remote_table_id,
            region: creds.region,
            shareLink: localEntry.share_link,
            shareAuthor: localEntry.share_author,
          });
          openDetail(promoted.recipe_id);
        }
      } else {
        setInfo(t("cloud.createdSimple"));
        if (localEntry && result.remote_table_id) {
          const promoted = promoteLocalToCloudOwned(localEntry.recipe_id, {
            content,
            tableId: result.remote_table_id,
            region: creds.region,
            shareLink: localEntry.share_link,
            shareAuthor: localEntry.share_author,
          });
          openDetail(promoted.recipe_id);
        }
      }
    });

  const onDeleteCloud = () =>
    void runCloud("delete", async () => {
      const creds = await requireCreds();
      const tableId = resolveOwnedTableId(localEntry);
      if (tableId == null || !isOwnedOnCloud(localEntry)) {
        throw new CloudError(t("cloud.needTableId"));
      }
      if (
        typeof window !== "undefined" &&
        !window.confirm(t("cloud.deleteConfirm"))
      ) {
        return;
      }
      await deleteCloudRecipe({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        tableId,
        confirmDelete: CLOUD_DELETE_CONFIRM,
        expectedName: localEntry?.name,
      });
      setInfo(t("cloud.deleted"));
      // Remove local row after successful cloud delete of owned recipe.
      if (localEntry) {
        deleteUserRecipe(localEntry.recipe_id);
        setSelectedId(null);
        setDetail(null);
        setLatest(null);
        setLocalEntry(null);
        loadList();
      }
    });

  const onImportShare = () =>
    void runCloud("share-import", async () => {
      const entry = await importShareLink(shareInput.trim());
      setShareInput("");
      setInfo(
        t("share.importDone").replace("{name}", entry.name) +
          (entry.share_author
            ? ` · ${t("share.fromAuthor").replace("{author}", entry.share_author)}`
            : ""),
      );
      loadList();
      openDetail(entry.recipe_id);
    });

  const onCreateShare = () =>
    void runCloud("share-create", async () => {
      const creds = await requireCreds();
      const tableId = resolveOwnedTableId(localEntry);
      if (tableId == null) throw new CloudError(t("share.needTableId"));
      const result = await createCloudShareLink({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        tableId,
        existingShareLink: localEntry?.share_link,
      });
      if (localEntry) {
        saveUserRecipe(localEntry.content, {
          recipeId: localEntry.recipe_id,
          source: localEntry.source,
          tableId,
          region: localEntry.region ?? creds.region,
          origin: localEntry.origin,
          shareLink: result.share_link,
          shareAuthor: localEntry.share_author,
        });
        openDetail(localEntry.recipe_id);
      }
      try {
        await navigator.clipboard.writeText(result.share_link);
        setInfo(
          t("share.createDoneCopied").replace("{link}", result.share_link),
        );
      } catch {
        setInfo(t("share.createDone").replace("{link}", result.share_link));
      }
    });

  const onCopyShare = async () => {
    const link = localEntry?.share_link;
    if (!link) {
      setError(t("share.noLinkYet"));
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setInfo(t("share.copied"));
    } catch {
      setInfo(link);
    }
  };

  const onUpdateCloud = () =>
    void runCloud("update", async () => {
      const creds = await requireCreds();
      if (!content) throw new CloudError(t("cloud.noRecipe"));
      const tableId = resolveOwnedTableId(localEntry);
      if (tableId == null || !isOwnedOnCloud(localEntry)) {
        throw new CloudError(t("cloud.needTableId"));
      }
      if (
        typeof window !== "undefined" &&
        !window.confirm(t("cloud.updateConfirm"))
      ) {
        return;
      }
      const result = await updateCloudRecipe({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        tableId,
        content,
        expectedName: localEntry?.name,
      });
      setInfo(t("cloud.updated"));
      if (localEntry) {
        saveUserRecipe(content, {
          recipeId: localEntry.recipe_id,
          source: localEntry.source === "official" ? "user" : localEntry.source,
          tableId: result.remote_table_id,
          region: creds.region,
          origin: "created",
        });
      }
    });

  const onDeleteLocal = () => {
    if (!localEntry || localEntry.source === "official") return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("recipes.deleteLocalConfirm"))
    ) {
      return;
    }
    deleteUserRecipe(localEntry.recipe_id);
    setError(null);
    setInfo(t("recipes.deletedLocal"));
    setSelectedId(null);
    setDetail(null);
    setLatest(null);
    setLocalEntry(null);
    loadList();
  };

  const onArchiveHost = async () => {
    if (!detail || !latest) return;
    try {
      await api.archiveRecipe(detail.recipe_id, latest.revision_id);
      // Remove the former browser mirror, if this recipe predates hosted saves.
      deleteUserRecipe(detail.recipe_id);
      if (searchParams.get("selected") === detail.recipe_id) setSearchParams({}, { replace: true });
      setSelectedId(null); setDetail(null); setLatest(null); setLocalEntry(null);
      await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const onImportFile = async (file: File) => {
    setError(null);
    setInfo(null);
    try {
      const text = await file.text();
      const result = importRecipesFromJson(text);
      if (result.errors.length) {
        setError(result.errors.slice(0, 3).join("; "));
      }
      setInfo(
        t("recipes.importDone").replace("{n}", String(result.imported)),
      );
      loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("recipes.title")}
        description={t("recipes.desc")}
        actions={
          <div className="flex flex-wrap items-center gap-1">
            <Link
              to="/recipes/edit"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-xs font-medium text-paper hover:bg-white/90"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("recipes.new")}
            </Link>
            <IconButton label={t("recipes.refresh")} onClick={() => loadList()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
            </IconButton>
          </div>
        }
      />

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

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={cloudBusy != null}
            onClick={onSync}
          >
            <Cloud className="h-3.5 w-3.5" aria-hidden />
            {cloudBusy === "sync" ? t("common.loading") : t("cloud.sync")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              downloadText(
                `xbloom-recipes-${new Date().toISOString().slice(0, 10)}.json`,
                exportRecipesJson(recipes.filter(recipe => recipe.source !== "official" && recipe.latest_revision).map(recipe => ({
                  recipe_id: recipe.recipe_id, name: recipe.name, kind: recipe.kind,
                  source: recipe.source, content: recipe.latest_revision!.content,
                }))),
              )
            }
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {t("recipes.exportAll")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden />
            {t("recipes.import")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = "";
            }}
          />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-md">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Link2 className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            <TextInput
              className="min-w-0 flex-1"
              value={shareInput}
              onChange={(e) => setShareInput(e.target.value)}
              placeholder={t("share.importPlaceholder")}
              aria-label={t("share.importPlaceholder")}
            />
          </div>
          <Button
            size="sm"
            variant="brand"
            disabled={cloudBusy != null || !shareInput.trim()}
            onClick={onImportShare}
          >
            {cloudBusy === "share-import"
              ? t("common.loading")
              : t("share.import")}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          ariaLabel={t("recipes.filterKind")}
          value={kindFilter}
          onChange={setKindFilter}
          options={[
            { value: "all", label: t("recipes.filterAll") },
            { value: "coffee", label: t("recipes.filterCoffee") },
            { value: "tea", label: t("recipes.filterTea") },
          ]}
        />
        <TextInput
          className="sm:max-w-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("recipes.searchPlaceholder")}
          aria-label={t("recipes.searchPlaceholder")}
        />
      </div>

      <div className="space-y-4">
        <Panel
          title={`${t("recipes.title")}${
            filteredRecipes.length !== recipes.length
              ? ` (${filteredRecipes.length}/${recipes.length})`
              : ""
          }`}
        >
          {loading ? (
            <Spinner label={t("common.loading")} />
          ) : recipes.length === 0 ? (
            <EmptyState title={t("recipes.empty")} showMachine={false} />
          ) : filteredRecipes.length === 0 ? (
            <EmptyState
              title={t("recipes.filterEmpty")}
              description={t("recipes.filterEmptyHint")}
              showMachine={false}
            />
          ) : (
            <ul className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="recipe-grid">
              {filteredRecipes.map((r) => {
                const source = r.source === "web-design" || r.latest_revision?.provenance?.source === "design" ? "design" : String(r.source ?? "");
                const c = (r.latest_revision?.content ??
                  getLocalRecipe(r.recipe_id)?.content) as RecipeContent | null;
                return (
                  <li key={r.recipe_id} className="min-w-0">
                    {c ? <RecipeCard
                      name={r.name}
                      content={c}
                      compact
                      badge={
                        <StatusPill
                          tone={
                            source === "official"
                              ? "blue"
                              : source === "shared"
                                ? "amber"
                                : source === "design"
                                  ? "green"
                                  : "neutral"
                          }
                        >
                          {source === "official"
                            ? t("recipes.official")
                            : source === "shared"
                              ? t("recipes.shared")
                              : source === "design"
                                ? t("recipes.design")
                                : t("recipes.user")}
                        </StatusPill>
                      }
                    >
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" size="sm" disabled={!r.latest_revision} onClick={() => setBrewTarget({ recipeRevisionId: r.latest_revision!.revision_id, content: c, recipeName: r.name })}><Play size={14} aria-hidden />{t("design.use")}</Button>
                        <Button size="sm" onClick={() => openDetail(r.recipe_id)}>{t("recipeCard.details")}</Button>
                      </div>
                    </RecipeCard> : <Panel title={r.name}><Button size="sm" onClick={() => openDetail(r.recipe_id)}>{t("recipeCard.details")}</Button></Panel>}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Dialog open={selectedId != null} title={t("recipeCard.details")} onClose={closeDetail} busy={cloudBusy != null} size="lg">
          {!detail || !latest || !content ? (
            <p className="text-sm text-ink-muted">
              {selectedId ? t("common.loading") : t("recipes.selectHint")}
            </p>
          ) : (
            <RecipeCard content={content} name={detail.name}>
              {localEntry?.share_author || localEntry?.share_link ? (
                <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
                  {localEntry.share_author ? (
                    <div>
                      {t("share.fromAuthor").replace(
                        "{author}",
                        localEntry.share_author,
                      )}
                    </div>
                  ) : null}
                  {localEntry.share_link ? (
                    <div className="mt-0.5 break-all">
                      <a
                        href={localEntry.share_link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand hover:underline"
                      >
                        {localEntry.share_link}
                      </a>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="relative flex flex-wrap items-center gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canBrew}
                  onClick={() => {
                    setBrewTarget({
                      recipeRevisionId: latest.revision_id,
                      content,
                      recipeName: detail.name,
                    });
                    closeDetail();
                  }}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {t("recipes.brew")}
                </Button>
                <Link
                  to={`/recipes/edit?id=${encodeURIComponent(detail.recipe_id)}${hostRecipes.current.has(detail.recipe_id) ? "&host=1" : ""}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-xs font-medium text-ink hover:bg-surface-3"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  {t("recipes.edit")}
                </Link>
                {localEntry?.share_link ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void onCopyShare()}
                  >
                    <Share2 className="h-3.5 w-3.5" aria-hidden />
                    {t("recipes.copyShareLink")}
                  </Button>
                ) : resolveOwnedTableId(localEntry) != null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={cloudBusy != null}
                    onClick={onCreateShare}
                  >
                    <Share2 className="h-3.5 w-3.5" aria-hidden />
                    {cloudBusy === "share-create"
                      ? t("common.loading")
                      : t("share.create")}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={cloudBusy != null || !content}
                    onClick={onPush}
                  >
                    <CloudUpload className="h-3.5 w-3.5" aria-hidden />
                    {cloudBusy === "push"
                      ? t("common.loading")
                      : t("recipes.syncToCloud")}
                  </Button>
                )}

                <div className="relative ml-auto">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t("recipes.moreActions")}
                    aria-expanded={detailMenuOpen}
                    onClick={() => setDetailMenuOpen((open) => !open)}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  {detailMenuOpen ? (
                    <div className="absolute bottom-full right-0 z-20 mb-2 min-w-48 max-w-[calc(100vw-3rem)] rounded-2xl border border-line bg-surface p-1.5 shadow-xl">
                      {(localEntry?.share_link ||
                        resolveOwnedTableId(localEntry) != null) &&
                      content ? (
                        <button
                          type="button"
                          disabled={cloudBusy != null}
                          onClick={() => {
                            setDetailMenuOpen(false);
                            onPush();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink hover:bg-surface-2 disabled:opacity-50"
                        >
                          <CloudUpload className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                          {t("recipes.syncToCloud")}
                        </button>
                      ) : null}
                      {localEntry?.share_link &&
                      resolveOwnedTableId(localEntry) != null ? (
                        <button
                          type="button"
                          disabled={cloudBusy != null}
                          onClick={() => {
                            setDetailMenuOpen(false);
                            onCreateShare();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Share2 className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                          {t("share.create")}
                        </button>
                      ) : null}
                      {isOwnedOnCloud(localEntry) ? (
                        <button
                          type="button"
                          disabled={cloudBusy != null}
                          onClick={() => {
                            setDetailMenuOpen(false);
                            onUpdateCloud();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Cloud className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                          {t("recipes.updateCloud")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setDetailMenuOpen(false);
                          downloadText(
                            `${detail.name.replace(/\s+/g, "-")}.json`,
                            exportSingleRecipeJson(content),
                          );
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink hover:bg-surface-2"
                      >
                        <Download className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                        {t("recipes.exportJson")}
                      </button>
                      {hostRecipes.current.has(detail.recipe_id) ? (
                        <button
                          type="button"
                          onClick={() => {
                            setDetailMenuOpen(false);
                            void onArchiveHost();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink hover:bg-surface-2"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                          {t("recipes.archive")}
                        </button>
                      ) : null}
                      {localEntry && localEntry.source !== "official" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setDetailMenuOpen(false);
                            onDeleteLocal();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink hover:bg-surface-2"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                          {t("recipes.deleteLocal")}
                        </button>
                      ) : null}
                      {isOwnedOnCloud(localEntry) ? (
                        <button
                          type="button"
                          disabled={cloudBusy != null}
                          onClick={() => {
                            setDetailMenuOpen(false);
                            onDeleteCloud();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-accent-red hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          {cloudBusy === "delete"
                            ? t("recipes.deleting")
                            : t("recipes.deleteCloud")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {!canBrew && !canBrewContent ? (
                  <span className="text-xs text-ink-muted">
                    {t("recipes.needBrewable")}
                  </span>
                ) : null}
                {isCoffeeContent(content) && content.kind === "flash-brew" ? (
                  <p className="w-full text-xs text-ink-faint">
                    {t("recipes.flashHint")
                      .replace("{ice}", String(content.ice_g ?? "—"))
                      .replace("{hot}", String(content.hot_water_ml ?? content.water_ml))}
                  </p>
                ) : null}
              </div>
            </RecipeCard>
          )}
        </Dialog>
      </div>

      <SlotProgrammer recipes={recipes} />

      <BrewConfirmDialog
        open={brewTarget != null}
        target={brewTarget}
        onClose={() => setBrewTarget(null)}
        onStarted={() => setBrewTarget(null)}
      />
    </div>
  );
}
