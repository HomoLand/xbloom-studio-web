/**
 * Design page — local multimodal API (Settings).
 * Multi-image upload + single-image clipboard paste, with previews and live stream log.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { designWithLocalAi, type DesignProgressEvent } from "../lib/localDesign";
import { saveUserRecipe, validateLocalContent } from "../lib/localRecipes";
import { isCoffeeContent, recipeDisplayName } from "../lib/recipeDomain";
import { useMachine } from "../machine/MachineContext";

const ACCEPT_IMAGES = "image/jpeg,image/png,image/webp,image/gif";
const MAX_IMAGES = 8;

type ImageItem = {
  id: string;
  file: File;
  previewUrl: string;
};

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name);
}

/**
 * One paste action → at most one image (the last image entry on the clipboard).
 * Avoids Chrome exposing the same image via both items[] and files[] (×3 dupes).
 */
function latestClipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) fromItems.push(f);
    }
  }
  if (fromItems.length) return fromItems[fromItems.length - 1]!;
  const fromFiles = Array.from(data.files ?? []).filter(isImageFile);
  if (fromFiles.length) return fromFiles[fromFiles.length - 1]!;
  return null;
}

export default function Design() {
  const { t } = useI18n();
  const { driver } = useMachine();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [designing, setDesigning] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [stages, setStages] = useState<string[]>([]);
  const [designError, setDesignError] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<RecipeContent | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

  const aiOk = isAiConfigured(readAiConfig());

  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [streamText, stages]);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter(isImageFile);
    if (!list.length) return;
    setImages((prev) => {
      const room = Math.max(0, MAX_IMAGES - prev.length);
      const slice = list.slice(0, room);
      const next = slice.map((file) => ({
        id: newId(),
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      return [...prev, ...next];
    });
  }, []);

  const addOneFile = useCallback((file: File) => {
    setImages((prev) => {
      if (prev.length >= MAX_IMAGES) return prev;
      return [
        ...prev,
        {
          id: newId(),
          file,
          previewUrl: URL.createObjectURL(file),
        },
      ];
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const clearImages = useCallback(() => {
    setImages((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  }, []);

  // Single global paste handler — only the latest clipboard image.
  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-design-no-image-paste]")) return;
      const file = latestClipboardImage(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      addOneFile(file);
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [addOneFile]);

  const onProgress = useCallback((ev: DesignProgressEvent) => {
    if (ev.kind === "stage") {
      setStages((s) => [...s, ev.message]);
    } else {
      setStreamText((prev) => prev + ev.text);
    }
  }, []);

  const runDesign = async () => {
    setDesignError(null);
    setSaveMsg(null);
    setRationale(null);
    setStreamText("");
    setStages([]);
    if (!aiOk) {
      setDesignError(t("design.needAi"));
      return;
    }
    setDesigning(true);
    try {
      const result = await designWithLocalAi({
        text,
        images: images.map((i) => i.file),
        onProgress,
      });
      setCandidate(result.content);
      setRationale(result.rationale);
      if (result.streamLog && !streamText) {
        setStreamText(result.streamLog);
      }
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

            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-muted">
                {t("design.images")}
                {images.length > 0 ? ` (${images.length})` : ""}
              </div>
              <p className="mb-2 text-[11px] text-ink-faint">
                {t("design.pasteHint")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                  {t("design.addImages")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => cameraRef.current?.click()}
                >
                  <Camera className="h-3.5 w-3.5" aria-hidden />
                  Camera
                </Button>
                {images.length > 0 ? (
                  <Button size="sm" variant="secondary" onClick={clearImages}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("design.clearImages")}
                  </Button>
                ) : null}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT_IMAGES}
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={cameraRef}
                type="file"
                accept={ACCEPT_IMAGES}
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />

              {images.length > 0 ? (
                <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {images.map((img, idx) => (
                    <li
                      key={img.id}
                      className="relative overflow-hidden rounded-md border border-line bg-paper"
                    >
                      <img
                        src={img.previewUrl}
                        alt={img.file.name || `image ${idx + 1}`}
                        className="h-32 w-full object-contain"
                      />
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-ink/70 px-1.5 py-1 text-[10px] text-white">
                        <span className="truncate">
                          {idx + 1}. {img.file.name || "paste"}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded px-1 hover:bg-white/20"
                          onClick={() => removeImage(img.id)}
                        >
                          {t("design.removeImage")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-3 rounded-md border border-dashed border-line bg-surface-2/40 px-3 py-6 text-center text-xs text-ink-muted">
                  {t("design.pasteHint")}
                </div>
              )}
            </div>

            {designError ? <Alert tone="red">{designError}</Alert> : null}

            <Button
              variant="primary"
              disabled={designing || !aiOk}
              onClick={() => void runDesign()}
            >
              {designing ? t("common.loading") : t("design.run")}
            </Button>

            {(designing || stages.length > 0 || streamText) && (
              <div className="rounded-md border border-line bg-paper">
                <div className="border-b border-line px-3 py-1.5 text-xs font-medium text-ink-muted">
                  {t("design.thinking")}
                </div>
                <div className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                  {stages.map((s, i) => (
                    <div key={i} className="text-accent-blue">
                      ▸ {s}
                    </div>
                  ))}
                  {streamText ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words text-ink-muted">
                      {streamText}
                    </pre>
                  ) : designing ? (
                    <div className="text-ink-faint">…</div>
                  ) : null}
                  <div ref={streamEndRef} />
                </div>
              </div>
            )}
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
