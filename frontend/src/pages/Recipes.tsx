/**
 * Recipe browser — local-first; optional official account cloud sync.
 */

import { useCallback, useEffect, useState } from "react";
import { Cloud, CloudUpload, Play, RefreshCw, Trash2 } from "lucide-react";
import type { RecipeContent, RecipeRecord, RecipeRevision } from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import { RecipeListItem } from "../components/RecipeListItem";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Panel,
  RecipeThumb,
  Select,
  Spinner,
  StatusPill,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { readAccountPrefs, writeAccountPrefs } from "../lib/accountPrefs";
import { importCloudSyncTargets } from "../lib/cloudCatalog";
import {
  deleteUserRecipe,
  getLocalRecipe,
  listAllLocalRecipes,
  saveUserRecipe,
  toLatestRevision,
  toRecipeRecord,
  type LocalRecipeEntry,
} from "../lib/localRecipes";
import { isCoffeeContent } from "../lib/recipeDomain";
import { importCloudBrewRecords } from "../lib/localHistory";
import {
  CLOUD_DELETE_CONFIRM,
  CLOUD_WRITE_CONFIRM,
  CloudError,
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
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeRecord | null>(null);
  const [latest, setLatest] = useState<RecipeRevision | null>(null);
  const [localEntry, setLocalEntry] = useState<LocalRecipeEntry | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);

  // Cloud account (password session-only)
  const prefs = readAccountPrefs();
  const [email, setEmail] = useState(prefs.email);
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<"china" | "international">(prefs.region);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);

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

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openDetail = (recipeId: string) => {
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
  };

  const content: RecipeContent | null = latest?.content ?? null;
  const canBrewWebBle =
    driver === "web-bluetooth" && content != null && isCoffeeContent(content);

  const persistPrefs = () => {
    writeAccountPrefs({ email, region });
  };

  const runCloud = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setInfo(null);
    setCloudBusy(label);
    try {
      persistPrefs();
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
      if (!email.trim() || !password) {
        throw new CloudError(t("cloud.needCreds"));
      }
      const result = await syncAccountCatalog({
        email,
        password,
        region,
        languageType: readAccountPrefs().languageType,
      });
      const imported = importCloudSyncTargets(result.targets, result.region);
      const total = imported.stats.reduce((s, x) => s + x.imported, 0);
      const candidates = imported.stats.reduce((s, x) => s + x.candidates, 0);
      // Also pull account brew journal into local history (best-effort).
      let historyNote = "";
      try {
        const hist = await fetchCloudBrewRecords({
          email,
          password,
          region,
          languageType: readAccountPrefs().languageType,
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
      if (!email.trim() || !password) throw new CloudError(t("cloud.needCreds"));
      if (!content) throw new CloudError(t("cloud.noRecipe"));
      const result = await pushCloudRecipe({
        email,
        password,
        region,
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
            region,
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
            region,
          });
        }
      }
    });

  const onDeleteCloud = () =>
    void runCloud("delete", async () => {
      if (!email.trim() || !password) throw new CloudError(t("cloud.needCreds"));
      const tableId = localEntry?.table_id;
      if (!tableId) throw new CloudError(t("cloud.needTableId"));
      if (
        typeof window !== "undefined" &&
        !window.confirm(t("cloud.deleteConfirm"))
      ) {
        return;
      }
      await deleteCloudRecipe({
        email,
        password,
        region,
        tableId,
        confirmDelete: CLOUD_DELETE_CONFIRM,
        expectedName: localEntry?.name,
      });
      setInfo(t("cloud.deleted").replace("{id}", String(tableId)));
      if (localEntry) {
        saveUserRecipe(localEntry.content, {
          recipeId: localEntry.recipe_id,
          source: localEntry.source,
          tableId: null,
          region,
        });
      }
    });

  const onUpdateCloud = () =>
    void runCloud("update", async () => {
      if (!email.trim() || !password) throw new CloudError(t("cloud.needCreds"));
      if (!content) throw new CloudError(t("cloud.noRecipe"));
      const tableId = localEntry?.table_id;
      if (!tableId) throw new CloudError(t("cloud.needTableId"));
      if (
        typeof window !== "undefined" &&
        !window.confirm(t("cloud.updateConfirm"))
      ) {
        return;
      }
      const result = await updateCloudRecipe({
        email,
        password,
        region,
        tableId,
        content,
        expectedName: localEntry?.name,
      });
      setInfo(
        t("cloud.updated")
          .replace("{old}", String(result.deleted_table_id))
          .replace("{new}", String(result.remote_table_id ?? "—")),
      );
      if (localEntry) {
        saveUserRecipe(content, {
          recipeId: localEntry.recipe_id,
          source: localEntry.source === "official" ? "user" : localEntry.source,
          tableId: result.remote_table_id,
          region,
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

  return (
    <div>
      <PageHeader
        title={t("recipes.title")}
        description={t("recipes.desc")}
        actions={
          <IconButton label={t("recipes.refresh")} onClick={() => loadList()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
          </IconButton>
        }
      />

      <Alert tone="blue" className="mb-4">
        {t("recipes.localMode")}
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

      <Panel title={t("cloud.title")} className="mb-4">
        <p className="mb-3 text-xs text-ink-muted">{t("cloud.hint")}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("cloud.email")}>
            <TextInput
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label={t("cloud.password")}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("cloud.passwordHint")}
            />
          </Field>
          <Field label={t("cloud.region")}>
            <Select
              value={region}
              onChange={(e) =>
                setRegion(
                  e.target.value === "international"
                    ? "international"
                    : "china",
                )
              }
            >
              <option value="china">{t("cloud.regionCn")}</option>
              <option value="international">{t("cloud.regionIntl")}</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              size="sm"
              variant="primary"
              disabled={cloudBusy != null}
              onClick={onSync}
            >
              <Cloud className="h-3.5 w-3.5" aria-hidden />
              {cloudBusy === "sync" ? t("common.loading") : t("cloud.sync")}
            </Button>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel title={t("recipes.title")}>
          {loading ? (
            <Spinner label={t("common.loading")} />
          ) : recipes.length === 0 ? (
            <EmptyState title={t("recipes.empty")} showMachine={false} />
          ) : (
            <ul className="space-y-1">
              {recipes.map((r, idx) => {
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
                              : source === "design"
                                ? "green"
                                : source === "cloud"
                                  ? "amber"
                                  : "neutral"
                          }
                        >
                          {source === "official"
                            ? t("recipes.official")
                            : source === "design"
                              ? t("recipes.design")
                              : source === "cloud"
                                ? t("recipes.cloud")
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
                    {localEntry?.table_id
                      ? ` · tableId ${localEntry.table_id}`
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
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cloudBusy != null || !content}
                  onClick={onPush}
                >
                  <CloudUpload className="h-3.5 w-3.5" aria-hidden />
                  {cloudBusy === "push" ? t("common.loading") : t("cloud.push")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cloudBusy != null || !localEntry?.table_id}
                  onClick={onUpdateCloud}
                >
                  {cloudBusy === "update"
                    ? t("common.loading")
                    : t("cloud.update")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={cloudBusy != null || !localEntry?.table_id}
                  onClick={onDeleteCloud}
                >
                  {cloudBusy === "delete"
                    ? t("common.loading")
                    : t("cloud.delete")}
                </Button>
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
              </div>
            </div>
          )}
        </Panel>
      </div>

      <BrewConfirmDialog
        open={brewTarget != null}
        target={brewTarget}
        onClose={() => setBrewTarget(null)}
        onStarted={() => setBrewTarget(null)}
      />
    </div>
  );
}
