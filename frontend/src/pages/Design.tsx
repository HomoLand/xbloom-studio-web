/**
 * Design page — hosted design API, with local AI for static deployments.
 * Multi-image upload + single-image clipboard paste, with previews and live stream log.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { api, type DesignPublicConfig, type DesignResult, type DesignSource, type RecipeContent } from "../api";
import {
  BrewConfirmDialog,
  type BrewTarget,
} from "../components/BrewConfirmDialog";
import { DesignRecipeCard } from "../components/DesignRecipeCard";
import {
  Alert,
  Button,
  Dialog,
  Field,
  PageHeader,
  Panel,
  TextArea,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { isAiConfigured, readAiConfig } from "../lib/aiConfig";
import { designWithLocalAi, type DesignProgressEvent } from "../lib/localDesign";
import { designImage, readDesignStream, type DesignEvent } from "../lib/designStream";
import { isStaticDeploy } from "../lib/deploy";
import { saveUserRecipe, validateLocalContent } from "../lib/localRecipes";
import { recipeDisplayName } from "../lib/recipeDomain";

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
  const { t, locale } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
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
  const [serverConfig, setServerConfig] = useState<DesignPublicConfig | null>(null);
  const [sources, setSources] = useState<DesignSource[]>([]);
  const [result, setResult] = useState<DesignResult | null>(null);
  const [savedRevision, setSavedRevision] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const staticMode = isStaticDeploy();
  /** null = probing, true = can open camera, false = no device / no API */
  const [cameraAvailable, setCameraAvailable] = useState<boolean | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const aiOk = staticMode ? isAiConfigured(readAiConfig()) : serverConfig != null;

  useEffect(() => {
    if (staticMode) return;
    let active = true;
    api.designConfig().then(config => { if (active) setServerConfig(config); })
      .catch(e => { if (active) setDesignError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [staticMode]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!designing) return;
    const start = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [designing]);

  // Probe whether any video input exists (no permission prompt when possible).
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        if (!cancelled) setCameraAvailable(false);
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideo = devices.some((d) => d.kind === "videoinput");
        // Before permission, some browsers hide devices; keep button enabled
        // if API exists and we did not get an explicit empty video list after perm.
        if (!cancelled) {
          if (devices.length === 0) setCameraAvailable(true);
          else setCameraAvailable(hasVideo);
        }
      } catch {
        if (!cancelled) setCameraAvailable(true);
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const stopCameraStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    mediaStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const closeCamera = useCallback(() => {
    stopCameraStream();
    setCameraOpen(false);
    setCameraBusy(false);
    setCameraError(null);
  }, [stopCameraStream]);

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, [stopCameraStream]);

  const openCamera = useCallback(async () => {
    if (cameraAvailable === false) return;
    setCameraError(null);
    setCameraBusy(true);
    setCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      mediaStreamRef.current = stream;
      // Mark available after successful open.
      setCameraAvailable(true);
      // Attach after dialog paints.
      requestAnimationFrame(() => {
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        void video.play().catch(() => {
          /* autoplay policies rare for user-gesture open */
        });
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCameraAvailable(false);
        setCameraError(t("design.cameraNoDevice"));
      } else {
        setCameraError(t("design.cameraDenied"));
      }
      stopCameraStream();
      setCameraOpen(false);
    } finally {
      setCameraBusy(false);
    }
  }, [cameraAvailable, stopCameraStream, t]);

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

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File(
          [blob],
          `camera-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
          { type: "image/jpeg" },
        );
        addOneFile(file);
        closeCamera();
      },
      "image/jpeg",
      0.92,
    );
  }, [addOneFile, closeCamera]);

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
    } else if (ev.kind === "delta") {
      setStreamText((prev) => prev + ev.text);
    }
  }, []);

  const runDesign = async () => {
    setDesignError(null);
    setSaveMsg(null);
    setRationale(null);
    setStreamText("");
    setStages([]);
    setCandidate(null);
    setResult(null);
    setSources([]);
    setSavedRevision(null);
    setValidateMsg(null);
    setElapsed(0);
    if (!aiOk) {
      setDesignError(t("design.needAi"));
      return;
    }
    setDesigning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (!staticMode) {
        const form = new FormData();
        form.set("text", `${locale.startsWith("zh") ? "请用简体中文设计配方。" : "Please write the recipe in English."}\n${text}`);
        const image = await designImage(images.map(item => item.file));
        if (controller.signal.aborted) return;
        if (image) form.set("image", image);
        const response = await api.designStream(form, controller.signal);
        const generated = await readDesignStream(response, (event: DesignEvent) => {
          if (event.kind === "stage") {
            setStages(previous => [...previous, t(`design.stage.${event.stage}`) + (event.query ? ` · ${event.query}` : "")]);
            if (event.stage === "repairing") setStreamText("");
          } else if (event.kind === "draft") setStreamText(event.rationale || event.name || "");
          else setSources(event.sources);
        });
        setResult(generated);
        setCandidate(generated.recipe_candidate);
        setRationale(generated.design_rationale);
        setSources(generated.web_sources || []);
        setStages(previous => [...previous, t("design.stage.complete")]);
        return;
      }
      const result = await designWithLocalAi({
        text,
        images: images.map((i) => i.file),
        locale,
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
      if (!controller.signal.aborted) setDesignError(e instanceof Error ? e.message : String(e));
      else setStages(previous => [...previous, t("design.cancelled")]);
    } finally {
      setDesigning(false);
      abortRef.current = null;
    }
  };

  const saveLocal = async () => {
    if (!candidate) return;
    setSaveBusy(true);
    setSaveMsg(null);
    try {
      const v = validateLocalContent(candidate);
      if (!v.valid) {
        setValidateMsg(v.message);
        return;
      }
      let recipeId: string | undefined;
      if (!staticMode) {
        const saved = await api.createRecipe({ content: candidate, provenance: {
          source: "design", model: result?.provenance.model, design_rationale: rationale,
          web_sources: sources, design_provenance: result?.provenance,
        }});
        recipeId = saved.recipe.recipe_id;
        setSavedRevision(saved.revision.revision_id);
        setSaveMsg(`${t("design.saved")}: ${saved.recipe.name}`);
        return;
      }
      const entry = saveUserRecipe(candidate, { source: "design", recipeId });
      setSaveMsg(`${t("design.saved")}: ${entry.name}`);
    } catch (e) {
      setDesignError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("design.title")} description={t("design.desc")} />

      {!aiOk && staticMode ? (
        <Alert tone="amber" className="mb-4">
          {t("design.needAi")}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t("design.title")}>
          <div className="space-y-3">
            {serverConfig ? <p className="text-xs text-ink-muted">{serverConfig.model} · {serverConfig.reasoning_effort?.toUpperCase()} · {serverConfig.web_search ? t("design.searchOn") : t("design.searchOff")}</p> : null}
            <Field label={t("design.promptLabel")} htmlFor="design-text">
              <TextArea
                id="design-text"
                rows={4}
                maxLength={7600}
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
                  disabled={
                    cameraAvailable === false ||
                    images.length >= MAX_IMAGES ||
                    cameraBusy
                  }
                  title={
                    cameraAvailable === false
                      ? t("design.cameraNoDevice")
                      : undefined
                  }
                  onClick={() => void openCamera()}
                >
                  <Camera className="h-3.5 w-3.5" aria-hidden />
                  {t("design.camera")}
                </Button>
                {images.length > 0 ? (
                  <Button size="sm" variant="secondary" onClick={clearImages}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("design.clearImages")}
                  </Button>
                ) : null}
              </div>
              {cameraError ? (
                <Alert tone="amber" className="mt-2">
                  {cameraError}
                </Alert>
              ) : null}
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

              {images.length > 0 ? (
                <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {images.map((img, idx) => (
                    <li
                      key={img.id}
                      className="relative overflow-hidden rounded-xl border border-line bg-surface-2"
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
              {designing ? `${t("design.generating")} · ${elapsed}s` : t("design.run")}
            </Button>
            {designing && !staticMode ? <Button variant="secondary" onClick={() => abortRef.current?.abort()}>{t("design.cancel")}</Button> : null}

            {(designing || stages.length > 0 || streamText) && (
              <div className="rounded-2xl border border-line bg-surface-2">
                <div className="border-b border-line px-3 py-1.5 text-xs font-medium text-ink-muted">
                  {t("design.thinking")} · {elapsed}s
                </div>
                <div className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                  {stages.map((s, i) => (
                    <div key={i} className="text-accent-blue">
                      ▸ {s}
                    </div>
                  ))}
                  {streamText ? (
                    <p className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-ink-muted">
                      {streamText}
                    </p>
                  ) : designing ? (
                    <div className="text-ink-faint">…</div>
                  ) : null}
                  <div ref={streamEndRef} />
                </div>
              </div>
            )}
          </div>
        </Panel>

        <div>
          {!candidate ? (
            <Panel title={t("design.result")}><p className="py-12 text-center text-sm text-ink-muted">{designing ? t("design.resultPending") : t("design.desc")}</p></Panel>
          ) : (
            <div className="space-y-3">
              <DesignRecipeCard content={candidate} rationale={rationale} sources={sources}
                validated={!!savedRevision || candidate === result?.recipe_candidate}
                model={serverConfig?.model || readAiConfig().model} busy={saveBusy || designing}
                saved={!!savedRevision || (!!saveMsg && !validateMsg)} error={validateMsg}
                onChange={changed => {
                  setCandidate(changed); setSaveMsg(null); setSavedRevision(null);
                  const validation = validateLocalContent(changed);
                  setValidateMsg(validation.valid ? null : validation.message);
                }}
                onSave={() => void saveLocal()}
                onUse={() => setBrewTarget({ recipeRevisionId: savedRevision || `local:design:${Date.now()}`, content: candidate, recipeName: recipeDisplayName(candidate) })}
              />
              {saveMsg ? <Alert tone="green">{saveMsg}</Alert> : null}
            </div>
          )}
        </div>
      </div>

      <BrewConfirmDialog
        open={brewTarget != null}
        target={brewTarget}
        onClose={() => setBrewTarget(null)}
        onStarted={() => setBrewTarget(null)}
      />

      <Dialog
        open={cameraOpen}
        title={t("design.camera")}
        onClose={closeCamera}
        busy={cameraBusy}
        size="lg"
      >
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">{t("design.cameraHint")}</p>
          <div className="overflow-hidden rounded-md border border-line bg-ink">
            <video
              ref={videoRef}
              className="mx-auto max-h-[60vh] w-full object-contain"
              playsInline
              muted
              autoPlay
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={closeCamera}>
              {t("design.cameraClose")}
            </Button>
            <Button
              variant="primary"
              disabled={cameraBusy}
              onClick={capturePhoto}
            >
              <Camera className="h-3.5 w-3.5" aria-hidden />
              {t("design.cameraCapture")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
