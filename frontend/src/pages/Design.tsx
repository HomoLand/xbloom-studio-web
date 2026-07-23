import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, ImagePlus, Save, Trash2, X } from "lucide-react";
import {
  api,
  ApiError,
  type BeverageHint,
  type DesignPublicConfig,
  type DesignResult,
  type RecipeContent,
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
  Field,
  IconButton,
  PageHeader,
  Panel,
  Segmented,
  Spinner,
  StatusPill,
  TextArea,
} from "../components/ui";
import { designErrorRecovery } from "../lib/apiErrors";
import {
  cloneContent,
  contentIdentity,
  isCoffeeContent,
  isTeaContent,
  shortId,
  storageKindOf,
} from "../lib/recipeDomain";

const ACCEPT_IMAGES = "image/jpeg,image/png,image/webp";
const VALIDATE_DEBOUNCE_MS = 400;

export default function Design() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const [config, setConfig] = useState<DesignPublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [beverage, setBeverage] = useState<BeverageHint | "auto">("auto");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [designing, setDesigning] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [designErrorRecovery, setDesignErrorRecovery] = useState<string | null>(
    null,
  );
  const [result, setResult] = useState<DesignResult | null>(null);
  const [candidate, setCandidate] = useState<RecipeContent | null>(null);
  /** Identity of the candidate currently shown in the editor. */
  const [candidateId, setCandidateId] = useState<string | null>(null);
  /**
   * Validation is only considered matching when it is for candidateId and
   * the response content identity equals that candidate (or the server-canonical
   * form we have applied for that exact request).
   */
  const [validateState, setValidateState] = useState<RecipeValidateResult | null>(
    null,
  );
  /** Content identity that the current validateState was produced for. */
  const [validatedForId, setValidatedForId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{
    recipeId: string;
    revisionId: string;
  } | null>(null);
  const [brewTarget, setBrewTarget] = useState<BrewTarget | null>(null);
  /** After user edits, hide original design-service validation errors. */
  const [showOriginalValidation, setShowOriginalValidation] = useState(true);

  const validateSeq = useRef(0);
  /** Last content identity we applied from a successful validate (avoid loops). */
  const lastAppliedCanonical = useRef<string | null>(null);

  useEffect(() => {
    api
      .designConfig()
      .then(setConfig)
      .catch((e) =>
        setConfigError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  const setImage = (file: File | null) => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    if (!file) {
      setImageFile(null);
      setImagePreview(null);
      return;
    }
    if (!ACCEPT_IMAGES.split(",").includes(file.type)) {
      setDesignError("Image must be JPEG, PNG, or WebP.");
      setDesignErrorRecovery("Choose a supported image MIME type.");
      return;
    }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const applyCandidate = useCallback((content: RecipeContent) => {
    const id = contentIdentity(content);
    setCandidate(cloneContent(content));
    setCandidateId(id);
    return id;
  }, []);

  /**
   * On every candidate edit: invalidate prior validation immediately so Save
   * cannot target an older validate response while newer content is visible.
   */
  const onCandidateEdit = useCallback(
    (next: RecipeContent) => {
      // Bump sequence so any in-flight validate is rejected.
      validateSeq.current += 1;
      setValidating(false);
      setValidateState(null);
      setValidatedForId(null);
      lastAppliedCanonical.current = null;
      setShowOriginalValidation(false);
      setSaved(null);
      setSaveError(null);
      applyCandidate(next);
    },
    [applyCandidate],
  );

  const runValidate = useCallback(
    async (content: RecipeContent, forId: string) => {
      const seq = ++validateSeq.current;
      setValidating(true);
      try {
        const res = await api.validateRecipe(content);
        // Reject out-of-order by sequence AND by content identity of the request.
        if (seq !== validateSeq.current) return;
        if (forId !== contentIdentity(content)) return;
        // Candidate may have changed while the request was in flight.
        // Compare against the identity we validated for.
        setValidateState(res);
        setValidatedForId(forId);
        if (res.valid) {
          const serverId = contentIdentity(res.content);
          // Only apply server-canonical form when it is for this exact edit
          // and differs from what is shown (avoid loops via lastApplied).
          if (
            serverId !== forId &&
            serverId !== lastAppliedCanonical.current
          ) {
            lastAppliedCanonical.current = serverId;
            // Applying server canonical is still the same logical validation:
            // re-tag candidate + validatedFor so Save stays enabled for this result.
            const appliedId = applyCandidate(res.content);
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
    [applyCandidate],
  );

  useEffect(() => {
    if (!candidate || !candidateId) return;
    // Debounced validate of the exact current candidate identity.
    const handle = window.setTimeout(() => {
      void runValidate(candidate, candidateId);
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [candidate, candidateId, runValidate]);

  const submitDesign = async () => {
    setDesigning(true);
    setDesignError(null);
    setDesignErrorRecovery(null);
    setSaved(null);
    setSaveError(null);
    setShowOriginalValidation(true);
    try {
      let res: DesignResult;
      if (imageFile) {
        const form = new FormData();
        if (text.trim()) form.append("text", text.trim());
        if (beverage !== "auto") form.append("beverage", beverage);
        form.append("image", imageFile, imageFile.name || "capture.jpg");
        res = await api.designMultipart(form);
      } else {
        if (!text.trim()) {
          setDesignError("Enter design notes or attach an image.");
          setDesignErrorRecovery("Text-only design requires non-empty notes.");
          setDesigning(false);
          return;
        }
        res = await api.designJson({
          text: text.trim(),
          beverage: beverage === "auto" ? null : beverage,
        });
      }
      setResult(res);
      lastAppliedCanonical.current = null;
      validateSeq.current += 1;
      const id = applyCandidate(res.recipe_candidate);
      // Seed validation from design response; debounced re-validate will refine.
      if (res.validation.valid) {
        setValidateState({
          valid: true,
          kind: storageKindOf(res.recipe_candidate),
          storage_kind: storageKindOf(res.recipe_candidate),
          content: res.recipe_candidate,
        });
        setValidatedForId(id);
      } else {
        setValidateState({
          valid: false,
          error: {
            category: "validation",
            message:
              res.validation.errors
                .map((e) => e.message || e.code || "invalid")
                .join("; ") || "Candidate failed validation",
          },
        });
        setValidatedForId(id);
      }
    } catch (e) {
      applyDesignError(e, setDesignError, setDesignErrorRecovery);
    } finally {
      setDesigning(false);
    }
  };

  const saveRecipe = async () => {
    if (!result || !candidate || !candidateId) return;
    // Only save when validation matches the exact content on screen.
    if (
      !validateState ||
      !validateState.valid ||
      validatedForId !== candidateId ||
      validating
    ) {
      setSaveError("Cannot save until the current content is validated.");
      return;
    }
    const content = validateState.content;
    // Fail closed: validated payload, candidateId, and visible candidate must match.
    const validatedId = contentIdentity(content);
    const visibleId = contentIdentity(candidate);
    if (
      validatedId !== candidateId ||
      visibleId !== candidateId ||
      validatedForId !== candidateId
    ) {
      setSaveError("Cannot save: content changed since validation.");
      return;
    }
    const prov = result.provenance;
    if (
      prov.knowledge_source !== "bundle" &&
      prov.knowledge_source !== "dev_root"
    ) {
      setSaveError("Provenance knowledge_source is not saveable.");
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      // Backend stores provider candidate_hash and records saved_candidate_hash
      // separately when the user edited the candidate.
      const savedRes = await api.fromDesign({
        recipe_candidate: content,
        design_rationale: result.design_rationale,
        evidence: result.evidence,
        provenance: {
          provider: prov.provider,
          model: prov.model,
          knowledge_version: prov.knowledge_version,
          knowledge_content_hash: prov.knowledge_content_hash,
          knowledge_source: prov.knowledge_source,
          prompt_template_version: prov.prompt_template_version,
          schema_version: prov.schema_version,
          candidate_hash: prov.candidate_hash,
          design_mode: prov.design_mode,
          repaired: prov.repaired,
          used_image: prov.used_image,
          used_ocr: prov.used_ocr,
        },
        name:
          typeof content.name === "string" ? content.name : undefined,
      });
      setSaved({
        recipeId: savedRes.recipe.recipe_id,
        revisionId: savedRes.revision.revision_id,
      });
      if (savedRes.revision.content) {
        lastAppliedCanonical.current = contentIdentity(savedRes.revision.content);
        const id = applyCandidate(savedRes.revision.content);
        setValidateState({
          valid: true,
          kind: storageKindOf(savedRes.revision.content),
          storage_kind: storageKindOf(savedRes.revision.content),
          content: savedRes.revision.content,
        });
        setValidatedForId(id);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  };

  const validationMatchesCurrent =
    !!candidate &&
    !!candidateId &&
    !!validateState &&
    validateState.valid &&
    validatedForId === candidateId &&
    !validating;

  const canSave =
    !!result && validationMatchesCurrent && !saveBusy;

  return (
    <div>
      <PageHeader
        title="Design"
        description="Generate a recipe candidate, edit, validate, then save an immutable revision."
      />

      <div className="space-y-4">
        <Panel title="Input">
          {!imagePreview ? (
            <div className="mb-4 flex justify-center rounded-lg border border-dashed border-line bg-paper py-6">
              <img
                src="/studio-machine.png"
                alt=""
                className="h-24 w-auto opacity-80 sm:h-28"
                draggable={false}
              />
            </div>
          ) : (
            <div className="relative mb-4 inline-block">
              <img
                src={imagePreview}
                alt="Selected bag or recipe image preview"
                className="max-h-48 rounded-lg border border-line object-contain"
              />
              <IconButton
                label="Remove image"
                className="absolute right-1 top-1 bg-surface/90"
                onClick={() => setImage(null)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </IconButton>
            </div>
          )}

          <div className="mb-3 flex flex-wrap gap-2">
            <input
              ref={cameraRef}
              type="file"
              accept={ACCEPT_IMAGES}
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setImage(f);
                e.target.value = "";
              }}
            />
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT_IMAGES}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setImage(f);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => cameraRef.current?.click()}
            >
              <Camera className="h-3.5 w-3.5" aria-hidden />
              Camera
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="h-3.5 w-3.5" aria-hidden />
              Choose image
            </Button>
            {imageFile ? (
              <Button size="sm" variant="ghost" onClick={() => setImage(null)}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Clear image
              </Button>
            ) : null}
          </div>

          <Field label="Design notes" htmlFor="design-text">
            <TextArea
              id="design-text"
              value={text}
              maxLength={8000}
              placeholder="Origin, process, target cup, grind preference..."
              onChange={(e) => setText(e.target.value)}
              disabled={designing}
            />
          </Field>

          <div className="mt-3">
            <Field label="Beverage hint">
              <Segmented
                ariaLabel="Beverage hint"
                value={beverage}
                onChange={setBeverage}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "coffee", label: "Coffee" },
                  { value: "tea", label: "Tea" },
                ]}
              />
            </Field>
          </div>

          <div className="mt-4 rounded-lg border border-line bg-paper p-3 text-xs leading-relaxed text-ink-muted">
            {configError ? (
              <span className="text-accent-red">
                Could not load design config: {configError}
              </span>
            ) : config ? (
              <>
                <div className="mb-1 flex flex-wrap gap-1.5">
                  <StatusPill tone="blue">{config.provider}</StatusPill>
                  <StatusPill tone="neutral">{config.model}</StatusPill>
                  <StatusPill tone="amber">{config.design_mode}</StatusPill>
                </div>
                <p>
                  Mode <strong className="text-ink">{config.design_mode}</strong>
                  {" / "}
                  {config.provider} / {config.model}.{" "}
                  {config.image_data_fate.summary}
                </p>
              </>
            ) : (
              <Spinner label="Loading design config" />
            )}
          </div>

          {designError ? (
            <Alert tone="red" title="Design failed" className="mt-3">
              <p>{designError}</p>
              {designErrorRecovery ? (
                <p className="mt-1 opacity-90">{designErrorRecovery}</p>
              ) : null}
            </Alert>
          ) : null}

          <div className="mt-4">
            <Button
              variant="primary"
              disabled={designing || (!text.trim() && !imageFile)}
              onClick={() => void submitDesign()}
            >
              {designing ? "Designing..." : "Generate candidate"}
            </Button>
          </div>
        </Panel>

        {result && candidate ? (
          <>
            <Panel title="Result">
              <div className="mb-3 flex flex-wrap gap-1.5">
                <StatusPill
                  tone={result.validation.valid ? "green" : "red"}
                >
                  {result.validation.valid ? "Valid candidate" : "Invalid"}
                </StatusPill>
                {result.validation.repaired || result.provenance.repaired ? (
                  <StatusPill tone="amber">Repaired</StatusPill>
                ) : null}
                {result.provenance.used_image ? (
                  <StatusPill tone="blue">Used image</StatusPill>
                ) : null}
                {result.provenance.used_ocr ? (
                  <StatusPill tone="blue">Used OCR</StatusPill>
                ) : null}
              </div>
              <p className="text-sm leading-relaxed text-ink">
                {result.design_rationale}
              </p>
              {result.evidence?.length ? (
                <ul className="mt-3 space-y-1.5">
                  {result.evidence.map((ev, i) => (
                    <li
                      key={i}
                      className="rounded-md border border-line bg-paper px-2.5 py-1.5 text-xs text-ink-muted"
                    >
                      <span className="font-medium text-ink">{ev.source}</span>
                      {": "}
                      {ev.claim}
                      {ev.value ? (
                        <span className="text-ink-faint"> ({ev.value})</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <dl className="mt-3 grid gap-1 text-xs text-ink-faint sm:grid-cols-2">
                <div>
                  Provider {result.provenance.provider} / {result.provenance.model}
                </div>
                <div>Mode {result.provenance.design_mode ?? "-"}</div>
                <div>
                  Knowledge {result.provenance.knowledge_version} (
                  {result.provenance.knowledge_source})
                </div>
                <div>
                  Candidate {shortId(result.provenance.candidate_hash, 12)}
                </div>
              </dl>
            </Panel>

            <Panel
              title="Editor"
              action={
                validating ? (
                  <span className="text-xs text-ink-faint">Validating...</span>
                ) : validationMatchesCurrent ? (
                  <StatusPill tone="green">Valid</StatusPill>
                ) : validateState && !validateState.valid && validatedForId === candidateId ? (
                  <StatusPill tone="red">Invalid</StatusPill>
                ) : (
                  <StatusPill tone="amber">Pending</StatusPill>
                )
              }
            >
              {isTeaContent(candidate) ? (
                <TeaEditor
                  value={candidate}
                  onChange={onCandidateEdit}
                  disabled={saveBusy}
                />
              ) : isCoffeeContent(candidate) ? (
                <CoffeeEditor
                  value={candidate}
                  onChange={onCandidateEdit}
                  disabled={saveBusy}
                />
              ) : (
                <Alert tone="amber">
                  Candidate is not a recognized coffee or tea shape.
                </Alert>
              )}

              {validateState &&
              !validateState.valid &&
              validatedForId === candidateId ? (
                <Alert tone="red" className="mt-3" title="Validation">
                  {validateState.error.message}
                </Alert>
              ) : null}
              {showOriginalValidation &&
              result.validation.errors?.length &&
              !result.validation.valid ? (
                <ul className="mt-2 space-y-1 text-xs text-accent-red">
                  {result.validation.errors.map((err, i) => (
                    <li key={i}>
                      {err.path ? `${err.path}: ` : ""}
                      {err.message || err.code || "error"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <Panel title="Save and brew">
              {saveError ? (
                <Alert tone="red" className="mb-3">
                  {saveError}
                </Alert>
              ) : null}
              {saved ? (
                <Alert tone="green" className="mb-3" title="Saved">
                  Recipe {shortId(saved.recipeId, 12)} | revision{" "}
                  {shortId(saved.revisionId, 14)}
                </Alert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!canSave}
                  onClick={() => void saveRecipe()}
                >
                  <Save className="h-3.5 w-3.5" aria-hidden />
                  {saveBusy ? "Saving..." : "Save revision"}
                </Button>
                <Button
                  variant="success"
                  disabled={!saved || !candidate}
                  onClick={() => {
                    if (!saved || !candidate) return;
                    setBrewTarget({
                      recipeRevisionId: saved.revisionId,
                      content: candidate,
                      recipeName:
                        typeof candidate.name === "string"
                          ? candidate.name
                          : undefined,
                    });
                  }}
                >
                  Brew saved revision
                </Button>
                {saved ? (
                  <Button
                    variant="secondary"
                    onClick={() => navigate(`/recipes`)}
                  >
                    Open recipes
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                Brew uses a saved revision only.
              </p>
            </Panel>
          </>
        ) : !designing ? (
          <Panel>
            <EmptyState
              title="No candidate yet"
              description="Provide notes and/or a bag image, then generate."
              showMachine={false}
            />
          </Panel>
        ) : (
          <Panel>
            <Spinner label="Designing recipe" />
          </Panel>
        )}
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

function applyDesignError(
  e: unknown,
  setError: (s: string) => void,
  setRecovery: (s: string | null) => void,
): void {
  // Shared C8 mapping; keep Design-specific configuration/image copy.
  if (e instanceof ApiError) {
    setError(e.message);
    if (
      e.code === "configuration_error" ||
      e.category === "configuration"
    ) {
      setRecovery(
        "Design is misconfigured (provider/knowledge/mode). Fix host env and restart the backend.",
      );
      return;
    }
    if (
      e.code === "invalid_request" ||
      e.code === "invalid_image" ||
      e.category === "validation"
    ) {
      setRecovery(
        "Adjust input: supported image MIME, size limits, and coffee/tea beverage only.",
      );
      return;
    }
    setRecovery(designErrorRecovery(e));
    return;
  }
  setError(e instanceof Error ? e.message : String(e));
  setRecovery(null);
}
