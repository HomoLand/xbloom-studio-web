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
import {
  Alert,
  Button,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Panel,
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
import {
  isCoffeeContent,
  recipeDisplayName,
  shortId,
} from "../lib/recipeDomain";
import {
  CLOUD_DELETE_CONFIRM,
  CLOUD_WRITE_CONFIRM,
  CloudError,
  deleteCloudRecipe,
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
      setInfo(
        t("cloud.syncDone")
          .replace("{imported}", String(total))
          .replace("{candidates}", String(candidates))
          .replace("{region}", result.region),
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
            <select
              className="w-full rounded-md border border-line bg-paper px-2 py-1.5 text-sm text-ink"
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
            </select>
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
            <EmptyState title={t("recipes.empty")} />
          ) : (
            <ul className="divide-y divide-line">
              {recipes.map((r) => {
                const active = r.recipe_id === selectedId;
                const source = String(r.source ?? "");
                return (
                  <li key={r.recipe_id}>
                    <button
                      type="button"
                      className={`flex w-full items-center justify-between gap-2 px-2 py-2.5 text-left text-sm transition-colors ${
                        active
                          ? "bg-surface-2 font-medium text-ink"
                          : "text-ink-muted hover:bg-surface-2/70 hover:text-ink"
                      }`}
                      onClick={() => openDetail(r.recipe_id)}
                    >
                      <span className="min-w-0 truncate">
                        {r.name ||
                          recipeDisplayName(
                            r.latest_revision?.content as RecipeContent,
                          )}
                      </span>
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
                    </button>
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
            <div className="space-y-3 text-sm">
              <dl className="grid gap-1 sm:grid-cols-2 text-ink-muted">
                <div>
                  {t("recipes.kind")}{" "}
                  <span className="text-ink">{detail.kind}</span>
                </div>
                <div>
                  {t("common.id")}{" "}
                  <code className="text-ink">
                    {shortId(detail.recipe_id, 14)}
                  </code>
                </div>
                {localEntry?.table_id ? (
                  <div>
                    tableId{" "}
                    <span className="text-ink">{localEntry.table_id}</span>
                  </div>
                ) : null}
                {isCoffeeContent(content) ? (
                  <>
                    <div>
                      {t("recipes.dose")} {content.dose_g} g
                    </div>
                    <div>
                      {t("recipes.grind")} {content.grind}
                    </div>
                    <div>
                      {t("recipes.water")} {content.water_ml} ml
                    </div>
                    <div>
                      {t("recipes.pours")} {content.pours.length}
                    </div>
                  </>
                ) : (
                  <div className="sm:col-span-2">{t("recipes.teaOnly")}</div>
                )}
              </dl>
              {isCoffeeContent(content) && content.note ? (
                <p className="text-xs text-ink-muted">{content.note}</p>
              ) : null}
              {isCoffeeContent(content) ? (
                <ol className="space-y-1 text-xs">
                  {content.pours.map((p, i) => (
                    <li
                      key={i}
                      className="rounded-md border border-line bg-paper px-2 py-1.5"
                    >
                      {i + 1}. {p.label || `Pour ${i + 1}`}: {p.ml} ml @{" "}
                      {String(p.temp_c)}° · {p.pattern}
                    </li>
                  ))}
                </ol>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="success"
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
