/**
 * Design page — local multimodal API (Settings) for static / offline use.
 */

import { useRef, useState } from "react";
import { Camera, ImagePlus, Save, Trash2, X } from "lucide-react";
import type { RecipeContent } from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import { CoffeeEditor } from "../components/RecipeEditors";
import {
  Alert,
  Button,
  Field,
  IconButton,
  PageHeader,
  Panel,
  TextArea,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { isAiConfigured, readAiConfig } from "../lib/aiConfig";
import { designWithLocalAi } from "../lib/localDesign";
import { saveUserRecipe, validateLocalContent } from "../lib/localRecipes";
import { isCoffeeContent, recipeDisplayName } from "../lib/recipeDomain";
import { useMachine } from "../machine/MachineContext";

const ACCEPT_IMAGES = "image/jpeg,image/png,image/webp";

export default function Design() {
  const { t } = useI18n();
  const { driver } = useMachine();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [designing, setDesigning] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<RecipeContent | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

  const aiOk = isAiConfigured(readAiConfig());

  const setImage = (file: File | null) => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(file ? URL.createObjectURL(file) : null);
  };

  const runDesign = async () => {
    setDesignError(null);
    setSaveMsg(null);
    setRationale(null);
    if (!aiOk) {
      setDesignError(t("design.needAi"));
      return;
    }
    setDesigning(true);
    try {
      const result = await designWithLocalAi({
        text,
        image: imageFile,
      });
      setCandidate(result.content);
      setRationale(result.rationale);
      const v = validateLocalContent(result.content);
      setValidateMsg(v.valid ? null : v.message);
    } catch (e) {
      setDesignError(e instanceof Error ? e.message : String(e));
    } finally {
      setDesigning(false);
    }
  };

  const saveLocal = () => {
    if (!candidate) return;
    setSaveBusy(true);
    setSaveMsg(null);
    try {
      const v = validateLocalContent(candidate);
      if (!v.valid) {
        setValidateMsg(v.message);
        return;
      }
      const entry = saveUserRecipe(candidate, { source: "design" });
      setSaveMsg(`${t("design.saved")}: ${entry.name}`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("design.title")} description={t("design.desc")} />

      {!aiOk ? (
        <Alert tone="amber" className="mb-4">
          {t("design.needAi")}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t("design.title")}>
          <div className="space-y-3">
            <Field label={t("design.placeholder")} htmlFor="design-text">
              <TextArea
                id="design-text"
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("design.placeholder")}
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                Image
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => cameraRef.current?.click()}
              >
                <Camera className="h-3.5 w-3.5" aria-hidden />
                Camera
              </Button>
              {imageFile ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setImage(null)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Clear image
                </Button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT_IMAGES}
              className="hidden"
              onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            />
            <input
              ref={cameraRef}
              type="file"
              accept={ACCEPT_IMAGES}
              capture="environment"
              className="hidden"
              onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            />
            {imagePreview ? (
              <img
                src={imagePreview}
                alt=""
                className="max-h-48 rounded-md border border-line object-contain"
              />
            ) : null}

            {designError ? <Alert tone="red">{designError}</Alert> : null}

            <Button
              variant="primary"
              disabled={designing || !aiOk}
              onClick={() => void runDesign()}
            >
              {designing ? t("common.loading") : t("design.run")}
            </Button>
          </div>
        </Panel>

        <Panel title={candidate ? recipeDisplayName(candidate) : "—"}>
          {!candidate ? (
            <p className="text-sm text-ink-muted">{t("design.desc")}</p>
          ) : (
            <div className="space-y-3">
              {rationale ? (
                <p className="text-xs text-ink-muted">{rationale}</p>
              ) : null}
              {validateMsg ? <Alert tone="amber">{validateMsg}</Alert> : null}
              {isCoffeeContent(candidate) ? (
                <CoffeeEditor
                  value={candidate}
                  onChange={(c) => {
                    setCandidate(c);
                    setValidateMsg(null);
                  }}
                />
              ) : (
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(candidate, null, 2)}
                </pre>
              )}
              {saveMsg ? <Alert tone="green">{saveMsg}</Alert> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={saveBusy}
                  onClick={saveLocal}
                >
                  <Save className="h-3.5 w-3.5" aria-hidden />
                  {t("design.save")}
                </Button>
                {isCoffeeContent(candidate) && driver === "web-bluetooth" ? (
                  <Button
                    size="sm"
                    variant="success"
                    onClick={() =>
                      setBrewTarget({
                        recipeRevisionId: `design:${Date.now().toString(16)}`,
                        content: candidate,
                        recipeName: recipeDisplayName(candidate),
                      })
                    }
                  >
                    {t("recipes.brew")}
                  </Button>
                ) : null}
                <IconButton
                  label={t("common.close")}
                  onClick={() => {
                    setCandidate(null);
                    setRationale(null);
                  }}
                >
                  <X className="h-4 w-4" aria-hidden />
                </IconButton>
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
