/**
 * Local recipe create / edit — coffee + tea, flash-brew metadata.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Save } from "lucide-react";
import type { RecipeContent } from "../api";
import {
  CoffeeEditor,
  TeaEditor,
} from "../components/RecipeEditors";
import {
  Alert,
  Button,
  PageHeader,
  Panel,
  Segmented,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import {
  getLocalRecipe,
  saveUserRecipe,
  validateLocalContent,
} from "../lib/localRecipes";
import {
  cloneContent,
  defaultCoffeeRecipe,
  defaultTeaRecipe,
  isCoffeeContent,
  isTeaContent,
  recipeDisplayName,
} from "../lib/recipeDomain";
import {
  downloadText,
  exportSingleRecipeJson,
  exportSingleRecipeYaml,
} from "../lib/recipeIo";

export default function RecipeEdit() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const recipeId = params.get("id");
  const [mode, setMode] = useState<"coffee" | "tea">("coffee");
  const [content, setContent] = useState<RecipeContent>(() =>
    defaultCoffeeRecipe(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!recipeId) return;
    const entry = getLocalRecipe(recipeId);
    if (!entry) {
      setError(t("editor.notFound"));
      return;
    }
    setContent(cloneContent(entry.content));
    setMode(isTeaContent(entry.content) ? "tea" : "coffee");
  }, [recipeId, t]);

  const title = useMemo(
    () =>
      recipeId
        ? t("editor.editTitle").replace("{name}", recipeDisplayName(content))
        : t("editor.newTitle"),
    [recipeId, content, t],
  );

  const switchMode = (next: "coffee" | "tea") => {
    setMode(next);
    setContent(next === "tea" ? defaultTeaRecipe() : defaultCoffeeRecipe());
    setSaved(false);
  };

  const onSave = () => {
    setError(null);
    setSaved(false);
    const check = validateLocalContent(content);
    if (!check.valid) {
      setError(check.message);
      return;
    }
    const entry = saveUserRecipe(check.content, {
      recipeId: recipeId && !recipeId.startsWith("official:") ? recipeId : undefined,
      source: "user",
    });
    setSaved(true);
    navigate(`/recipes?selected=${encodeURIComponent(entry.recipe_id)}`, {
      replace: true,
    });
  };

  return (
    <div>
      <PageHeader
        title={title}
        description={t("editor.pageDesc")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              to="/recipes"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-xs font-medium text-ink hover:bg-surface-3"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t("common.cancel")}
            </Link>
            <Button variant="primary" size="sm" onClick={onSave}>
              <Save className="h-3.5 w-3.5" aria-hidden />
              {t("common.save")}
            </Button>
          </div>
        }
      />

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="green" className="mb-4">
          {t("editor.saved")}
        </Alert>
      ) : null}

      {!recipeId ? (
        <div className="mb-4">
          <Segmented
            ariaLabel="Recipe kind"
            value={mode}
            onChange={switchMode}
            options={[
              { value: "coffee", label: t("editor.hot") + " / " + t("editor.flash") },
              { value: "tea", label: t("editor.teaKind") },
            ]}
          />
        </div>
      ) : null}

      <Panel>
        {isCoffeeContent(content) ? (
          <CoffeeEditor value={content} onChange={setContent} />
        ) : isTeaContent(content) ? (
          <TeaEditor value={content} onChange={setContent} />
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              downloadText(
                `${recipeDisplayName(content).replace(/\s+/g, "-")}.json`,
                exportSingleRecipeJson(content),
              )
            }
          >
            {t("editor.exportJson")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              downloadText(
                `${recipeDisplayName(content).replace(/\s+/g, "-")}.yaml`,
                exportSingleRecipeYaml(content),
                "text/yaml",
              )
            }
          >
            {t("editor.exportYaml")}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
