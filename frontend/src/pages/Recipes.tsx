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
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import type { RecipeContent, RecipeRecord, RecipeRevision } from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import { RecipeListItem } from "../components/RecipeListItem";
import { SlotProgrammer } from "../components/SlotProgrammer";
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  RecipeThumb,
  Segmented,
  Spinner,
  StatusPill,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { getAccountCredentials } from "../lib/accountPrefs";
import {
  importCloudSyncTargets,
  importShareLink,
} from "../lib/cloudCatalog";
import {
  deleteUserRecipe,
  getLocalRecipe,
  isOwnedOnCloud,
  listAllLocalRecipes,
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
  const [searchParams] = useSearchParams();
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeRecord | null>(null);
  const [latest, setLatest] = useState<RecipeRevision | null>(null);
  const [localEntry, setLocalEntry] = useState<LocalRecipeEntry | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<"all" | "coffee" | "tea">("all");
  const [query, setQuery] = useState("");
  const [shareInput, setShareInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(() => {
    setError(null);
    setLoading(true);
    try {
      const list = listAllLocalRecipes().map(toRecipeRecord);
      setRecipes(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetail = useCallback((recipeId: string) => {
    setSelectedId(recipeId);
    const entry = getLocalRecipe(recipeId);
    if (!entry) {
      setDetail(null);
      setLatest(null);
      setLocalEntry(null);
      setError("Recipe not found");
      return;
    }
    setDetail(toRecipeRecord(entry));
    setLatest(toLatestRevision(entry));
    setLocalEntry(entry);
    setError(null);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    const sel = searchParams.get("selected");
    if (sel) openDetail(sel);
  }, [searchParams, openDetail]);

  const content: RecipeContent | null = latest?.content ?? null;
  const canBrewWebBle =
    driver === "web-bluetooth" &&
    content != null &&
    (isCoffeeContent(content) || isTeaContent(content));

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

  const requireCreds = () => {
    const creds = getAccountCredentials();
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
      if (selectedId) openDetail(selectedId);
    } catch (e) {
      setError(
        e instanceof CloudError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setCloudBusy(null);
    }
  };

  const onSync = () =>
    void runCloud("sync", async () => {
      const creds = requireCreds();
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
      const creds = requireCreds();
      if (!content) throw new CloudError(t("cloud.noRecipe"));
      const result = await pushCloudRecipe({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        content,
        confirmWrite: CLOUD_WRITE_CONFIRM,
      });
      if (result.status === "already-present") {
        setInfo(
          t("cloud.alreadyPresent").replace(
            "{id}",
            String(result.remote_table_id ?? "—"),
          ),
        );
        if (localEntry && result.remote_table_id) {
          saveUserRecipe(content, {
            recipeId: localEntry.recipe_id,
            source: localEntry.source,
            tableId: result.remote_table_id,
            region: creds.region,
          });
        }
      } else {
        setInfo(
          t("cloud.created").replace("{id}", String(result.remote_table_id)),
        );
        if (localEntry) {
          saveUserRecipe(content, {
            recipeId: localEntry.recipe_id,
            source: localEntry.source === "official" ? "user" : localEntry.source,
            tableId: result.remote_table_id,
            region: creds.region,
          });
        }
      }
    });

  const onDeleteCloud = () =>
    void runCloud("delete", async () => {
      const creds = requireCreds();
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
      const creds = requireCreds();
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
      const creds = requireCreds();
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
    setSelectedId(null);
    setDetail(null);
    setLatest(null);
    setLocalEntry(null);
    loadList();
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

      <Alert tone="blue" className="mb-4">
        {t("recipes.localMode")}{" "}
        <Link to="/settings" className="text-brand hover:underline">
          {t("cloud.openSettings")}
        </Link>
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
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
              exportRecipesJson(),
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
        <span className="text-xs text-ink-faint">{t("cloud.actionsUseSettings")}</span>
      </div>

      <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-3 sm:flex-row sm:items-center">
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
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
            <ul className="space-y-1">
              {filteredRecipes.map((r, idx) => {
                const active = r.recipe_id === selectedId;
                const source = String(r.source ?? "");
                const c = (r.latest_revision?.content ??
                  getLocalRecipe(r.recipe_id)?.content) as RecipeContent | null;
                return (
                  <li key={r.recipe_id}>
                    <RecipeListItem
                      name={r.name}
                      content={c}
                      index={idx}
                      active={active}
                      onClick={() => openDetail(r.recipe_id)}
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
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title={detail?.name ?? "—"}>
          {!detail || !latest || !content ? (
            <p className="text-sm text-ink-muted">
              {selectedId ? t("common.loading") : t("recipes.selectHint")}
            </p>
          ) : (
            <div className="space-y-4 text-sm">
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
              <div className="flex items-start gap-3">
                <RecipeThumb
                  label={
                    isCoffeeContent(content)
                      ? /xpod/i.test(String(content.dripper || ""))
                        ? "xPod"
                        : "Omni"
                      : "Tea"
                  }
                  pours={
                    isCoffeeContent(content)
                      ? content.pours.length
                      : (content as { pours?: unknown[] }).pours?.length
                  }
                  index={Math.abs(
                    detail.recipe_id.split("").reduce((a, c) => a + c.charCodeAt(0), 0),
                  )}
                  className="h-16 w-16"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-semibold tracking-tight text-ink">
                    {detail.name}
                  </div>
                  <div className="mt-1 text-xs text-ink-faint">
                    {detail.kind}
                    {isOwnedOnCloud(localEntry)
                      ? ` · ${t("recipes.onAccount")}`
                      : localEntry?.source === "shared"
                        ? ` · ${t("recipes.localOnly")}`
                        : ""}
                  </div>
                </div>
              </div>
              <dl className="grid gap-2 rounded-2xl bg-surface-2 p-3 sm:grid-cols-3 text-ink-muted">
                {isCoffeeContent(content) ? (
                  <>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-ink-faint">
                        {t("recipes.dose")}
                      </div>
                      <div className="mt-0.5 text-base font-medium text-ink">
                        {content.dose_g} g
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-ink-faint">
                        {t("recipes.grind")}
                      </div>
                      <div className="mt-0.5 text-base font-medium text-ink">
                        {content.grind}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-ink-faint">
                        {t("recipes.water")}
                      </div>
                      <div className="mt-0.5 text-base font-medium text-ink">
                        {content.water_ml} ml
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="sm:col-span-3">{t("recipes.teaOnly")}</div>
                )}
              </dl>
              {isCoffeeContent(content) && content.note ? (
                <p className="text-xs text-ink-muted">{content.note}</p>
              ) : null}
              {isCoffeeContent(content) ? (
                <div>
                  <div className="mb-2 text-xs font-medium text-ink-muted">
                    {t("recipes.pours")}
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {content.pours.map((p, i) => (
                      <div
                        key={i}
                        className="flex flex-col items-center rounded-xl bg-surface-2 px-1 py-2 text-center"
                      >
                        <span className="text-sm font-semibold text-ink">
                          {p.ml}ml
                        </span>
                        <span className="mt-1 text-[10px] text-ink-faint">
                          {String(p.temp_c)}°
                        </span>
                        <span className="mt-0.5 truncate text-[10px] text-ink-muted">
                          {p.label || `P${i + 1}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canBrewWebBle}
                  onClick={() =>
                    setBrewTarget({
                      recipeRevisionId: latest.revision_id,
                      content,
                      recipeName: detail.name,
                    })
                  }
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {t("recipes.brew")}
                </Button>
                <Link
                  to={`/recipes/edit?id=${encodeURIComponent(detail.recipe_id)}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-xs font-medium text-ink hover:bg-surface-3"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  {t("recipes.edit")}
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    downloadText(
                      `${detail.name.replace(/\s+/g, "-")}.json`,
                      exportSingleRecipeJson(content),
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  JSON
                </Button>
                {localEntry?.share_link ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void onCopyShare()}
                  >
                    <Share2 className="h-3.5 w-3.5" aria-hidden />
                    {t("share.copyLink")}
                  </Button>
                ) : null}
                {resolveOwnedTableId(localEntry) != null ||
                localEntry?.share_link ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      cloudBusy != null ||
                      (resolveOwnedTableId(localEntry) == null &&
                        !localEntry?.share_link)
                    }
                    onClick={onCreateShare}
                    title={
                      resolveOwnedTableId(localEntry) == null
                        ? t("share.needTableId")
                        : t("share.createHint")
                    }
                  >
                    <Share2 className="h-3.5 w-3.5" aria-hidden />
                    {cloudBusy === "share-create"
                      ? t("common.loading")
                      : t("share.create")}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cloudBusy != null || !content}
                  onClick={onPush}
                >
                  <CloudUpload className="h-3.5 w-3.5" aria-hidden />
                  {cloudBusy === "push" ? t("common.loading") : t("cloud.push")}
                </Button>
                {isOwnedOnCloud(localEntry) ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={cloudBusy != null}
                      onClick={onUpdateCloud}
                    >
                      {cloudBusy === "update"
                        ? t("common.loading")
                        : t("cloud.update")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={cloudBusy != null}
                      onClick={onDeleteCloud}
                    >
                      {cloudBusy === "delete"
                        ? t("common.loading")
                        : t("cloud.delete")}
                    </Button>
                  </>
                ) : null}
                {localEntry && localEntry.source !== "official" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onDeleteLocal}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("recipes.deleteLocal")}
                  </Button>
                ) : null}
                {!canBrewWebBle && driver !== "web-bluetooth" ? (
                  <span className="text-xs text-ink-muted">
                    {t("recipes.needWebBle")}
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
            </div>
          )}
        </Panel>
      </div>

      <SlotProgrammer />

      <BrewConfirmDialog
        open={brewTarget != null}
        target={brewTarget}
        onClose={() => setBrewTarget(null)}
        onStarted={() => setBrewTarget(null)}
      />
    </div>
  );
}
