/**
 * Recipe browser — local-first on static Pages; API with local fallback otherwise.
 */

import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import type { RecipeContent, RecipeRecord, RecipeRevision } from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
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
import { useI18n } from "../i18n/I18nContext";
import { isStaticDeploy } from "../lib/deploy";
import {
  getLocalRecipe,
  listAllLocalRecipes,
  toLatestRevision,
  toRecipeRecord,
} from "../lib/localRecipes";
import {
  isCoffeeContent,
  recipeDisplayName,
  shortId,
} from "../lib/recipeDomain";
import { useMachine } from "../machine/MachineContext";

export default function Recipes() {
  const { t } = useI18n();
  const { driver } = useMachine();
  const staticMode = isStaticDeploy();
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeRecord | null>(null);
  const [latest, setLatest] = useState<RecipeRevision | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  const [localMode, setLocalMode] = useState(staticMode);

  const loadList = useCallback(() => {
    setError(null);
    setLoading(true);
    try {
      // Static Pages: always local. Hosted backend mode: local catalog still works
      // as the offline-capable source of truth for this SPA path.
      const list = listAllLocalRecipes().map(toRecipeRecord);
      setRecipes(list);
      setLocalMode(true);
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
      setError("Recipe not found");
      return;
    }
    setDetail(toRecipeRecord(entry));
    setLatest(toLatestRevision(entry));
    setError(null);
  };

  const content: RecipeContent | null = latest?.content ?? null;
  const canBrewWebBle =
    driver === "web-bluetooth" && content != null && isCoffeeContent(content);

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

      {localMode ? (
        <Alert tone="blue" className="mb-4">
          {t("recipes.localMode")}
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

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
                        {r.name || recipeDisplayName(r.latest_revision?.content as RecipeContent)}
                      </span>
                      <StatusPill
                        tone={
                          source === "official"
                            ? "blue"
                            : source === "design"
                              ? "green"
                              : "neutral"
                        }
                      >
                        {source === "official"
                          ? t("recipes.official")
                          : source === "design"
                            ? t("recipes.design")
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
              {selectedId ? t("common.loading") : t("recipes.empty")}
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <dl className="grid gap-1 sm:grid-cols-2 text-ink-muted">
                <div>
                  Kind <span className="text-ink">{detail.kind}</span>
                </div>
                <div>
                  ID{" "}
                  <code className="text-ink">{shortId(detail.recipe_id, 14)}</code>
                </div>
                {isCoffeeContent(content) ? (
                  <>
                    <div>Dose {content.dose_g} g</div>
                    <div>Grind {content.grind}</div>
                    <div>Water {content.water_ml} ml</div>
                    <div>Pours {content.pours.length}</div>
                  </>
                ) : (
                  <div className="sm:col-span-2">
                    Tea / non-coffee — brew via Web Bluetooth coffee path only for
                    now.
                  </div>
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
                {!canBrewWebBle && driver !== "web-bluetooth" ? (
                  <span className="text-xs text-ink-muted">
                    Switch driver to Web Bluetooth to brew from this page.
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
