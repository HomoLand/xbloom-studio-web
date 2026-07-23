import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  newRequestId,
  startConfirmationForKind,
  type CoffeeRecipeContent,
  type RecipeContent,
  type RecipeRevision,
  type TeaRecipeContent,
} from "../api";
import {
  isCoffeeContent,
  isTeaContent,
  recipeDisplayName,
  shortId,
  storageKindOf,
} from "../lib/recipeDomain";
import { persistWorkflow } from "../lib/workflowStore";
import { useI18n } from "../i18n/I18nContext";
import { useMachine } from "../machine/MachineContext";
import { Alert, Button, Dialog, Field, TextInput } from "./ui";

export type BrewTarget = {
  recipeRevisionId: string;
  content: RecipeContent;
  revision?: RecipeRevision | null;
  recipeName?: string;
};

type Props = {
  open: boolean;
  target: BrewTarget | null;
  onClose: () => void;
  onStarted: (workflowId: string, kind: "coffee" | "tea") => void;
};

/**
 * Confirmation dialog for load+start.
 * Closing/unmounting never cancels, stops, or disconnects the machine.
 */
export function BrewConfirmDialog({ open, target, onClose, onStarted }: Props) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { driver, bleSession, bleSnapshot, connectBle } = useMachine();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"load" | "start" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  /** Uncertain machine outcome: no further mutation; go to Dashboard. */
  const [uncertain, setUncertain] = useState(false);
  /**
   * When true, hide the retry mutation button (Dashboard only).
   * Covers uncertain outcomes and deterministic workflow conflicts.
   */
  const [blockMutation, setBlockMutation] = useState(false);
  const [loadedWorkflowId, setLoadedWorkflowId] = useState<string | null>(null);

  const content = target?.content ?? null;
  const kind = content ? storageKindOf(content) : "coffee";
  const phrase = startConfirmationForKind(kind);
  const name =
    target?.recipeName ||
    (content ? recipeDisplayName(content) : "Recipe");
  const webBle = driver === "web-bluetooth";

  const reset = () => {
    setConfirm("");
    setBusy(null);
    setError(null);
    setRecovery(null);
    setUncertain(false);
    setBlockMutation(false);
    setLoadedWorkflowId(null);
  };

  const handleClose = () => {
    // Never cancel/stop/disconnect on close. Only clear local dialog state.
    if (busy) return;
    reset();
    onClose();
  };

  const brewWebBluetooth = async () => {
    if (!target || !content) return;
    if (kind === "tea" || !isCoffeeContent(content)) {
      setError(t("brew.coffeeOnly"));
      return;
    }
    if (confirm.trim() !== phrase) {
      setError(`Confirmation phrase must match exactly: ${phrase}`);
      return;
    }

    setError(null);
    setRecovery(null);
    setUncertain(false);
    setBlockMutation(false);

    let workflowId = loadedWorkflowId;
    try {
      if (
        bleSnapshot.phase === "idle" ||
        bleSnapshot.phase === "disconnected" ||
        bleSnapshot.phase === "error"
      ) {
        setBusy("load");
        await connectBle();
      }

      if (!workflowId) {
        setBusy("load");
        workflowId = newRequestId("webble");
        await bleSession.loadCoffee(content, {
          journal: {
            recipe_name: target.recipeName ?? recipeDisplayName(content),
            recipe_revision_id: target.recipeRevisionId,
            workflow_id: workflowId,
            kind: content.kind,
          },
        });
        setLoadedWorkflowId(workflowId);
        persistWorkflow(workflowId, "coffee", target.recipeRevisionId);
      } else {
        bleSession.beginBrewJournal({
          recipe_name: target.recipeName ?? recipeDisplayName(content),
          recipe_revision_id: target.recipeRevisionId,
          workflow_id: workflowId,
          kind: isCoffeeContent(content) ? content.kind : "coffee",
        });
      }

      setBusy("start");
      await bleSession.startBrew();
      persistWorkflow(workflowId, "coffee", target.recipeRevisionId);
      const startedId = workflowId;
      reset();
      onStarted(startedId, "coffee");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRecovery(t("brew.readyCheck"));
      setBusy(null);
    }
  };

  const brew = async () => {
    if (!target) return;
    if (webBle) {
      await brewWebBluetooth();
      return;
    }

    setError(null);
    setRecovery(null);
    setUncertain(false);
    setBlockMutation(false);

    let workflowId = loadedWorkflowId;
    const beverage = kind;

    if (!workflowId) {
      setBusy("load");
      // Fresh request_id for this explicit user mutation (no auto transport retry).
      const loadRequestId = newRequestId("load");
      try {
        const loadBody = {
          recipe_revision_id: target.recipeRevisionId,
          request_id: loadRequestId,
        };
        const result =
          beverage === "tea"
            ? await api.teaLoad(loadBody)
            : await api.coffeeLoad(loadBody);
        const wid =
          typeof result.workflow_id === "string" ? result.workflow_id.trim() : "";
        if (!wid) {
          setError(
            "Load returned no workflow ID. Check bridge status on the Dashboard.",
          );
          setRecovery(
            "Outcome is uncertain. Do not retry. Open Dashboard for status and recovery.",
          );
          setUncertain(true);
          setBlockMutation(true);
          setBusy(null);
          return;
        }
        workflowId = wid;
        setLoadedWorkflowId(wid);
        persistWorkflow(wid, beverage, target.recipeRevisionId);
      } catch (e) {
        const classified = classifyBrewFailure(e, "load");
        setError(classified.message);
        setRecovery(classified.recovery);
        setUncertain(classified.uncertain);
        setBlockMutation(classified.blockMutation);
        if (classified.workflowId) {
          setLoadedWorkflowId(classified.workflowId);
          persistWorkflow(classified.workflowId, beverage, target.recipeRevisionId);
        }
        setBusy(null);
        return;
      }
    }

    if (confirm.trim() !== phrase) {
      setError(`Confirmation phrase must match exactly: ${phrase}`);
      setBusy(null);
      return;
    }

    setBusy("start");
    // Fresh request_id for this explicit user start mutation.
    const startRequestId = newRequestId("start");
    try {
      if (beverage === "tea") {
        await api.teaStart({
          workflow_id: workflowId,
          confirmation: confirm.trim(),
          request_id: startRequestId,
        });
      } else {
        await api.coffeeStart({
          workflow_id: workflowId,
          confirmation: confirm.trim(),
          request_id: startRequestId,
        });
      }
      persistWorkflow(workflowId, beverage, target.recipeRevisionId);
      const startedId = workflowId;
      reset();
      onStarted(startedId, beverage);
    } catch (e) {
      // Preserve workflow ID; never auto re-load.
      setLoadedWorkflowId(workflowId);
      persistWorkflow(workflowId, beverage, target.recipeRevisionId);
      const classified = classifyBrewFailure(e, "start", workflowId);
      setError(classified.message);
      setRecovery(classified.recovery);
      setUncertain(classified.uncertain);
      setBlockMutation(classified.blockMutation);
      setBusy(null);
    }
  };

  const cancelWebBle = async () => {
    setBusy("cancel");
    setError(null);
    try {
      await bleSession.cancelBrew();
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  if (!target || !content) {
    return (
      <Dialog open={open} title={t("brew.confirmTitle")} onClose={handleClose} busy={!!busy}>
        <p className="text-sm text-ink-muted">{t("brew.noTarget")}</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      title={t("brew.confirmTitle")}
      onClose={handleClose}
      busy={!!busy}
      size="lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {webBle ? t("brew.webBleHint") : t("brew.bridgeHint")}
        </p>

        {webBle ? (
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
            {t("settings.webBle")} · {bleSnapshot.phase}
            {bleSnapshot.machineStateName
              ? ` · ${bleSnapshot.machineStateName}`
              : ""}
            {bleSnapshot.cupWeightG != null
              ? ` · ${bleSnapshot.cupWeightG} g`
              : ""}
          </div>
        ) : null}

        <div className="text-sm">
          <div className="font-medium text-ink">{name}</div>
          <div className="mt-1 text-xs text-ink-muted">
            {t("brew.revision")}{" "}
            <code className="text-ink">{shortId(target.recipeRevisionId, 14)}</code>
            {" · "}
            {t("brew.kind")} <span className="text-ink">{kind}</span>
          </div>
          <RecipeSnapshot content={content} />
        </div>

        {error ? <Alert tone="red">{error}</Alert> : null}
        {recovery ? (
          <Alert tone={uncertain ? "amber" : "blue"}>{recovery}</Alert>
        ) : null}

        <Field
          label={`${t("brew.phrase")} (${phrase})`}
          htmlFor="brew-confirm-phrase"
          hint={t("brew.phraseHint")}
        >
          <TextInput
            id="brew-confirm-phrase"
            value={confirm}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={phrase}
            disabled={!!busy || blockMutation}
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={!!busy}>
            {t("common.close")}
          </Button>
          {webBle &&
          (bleSnapshot.loaded ||
            bleSnapshot.phase === "armed" ||
            bleSnapshot.phase === "brewing" ||
            bleSnapshot.phase === "starting") ? (
            <Button
              variant="secondary"
              onClick={() => void cancelWebBle()}
              disabled={!!busy}
            >
              {busy === "cancel" ? t("brew.cancelling") : t("brew.cancelBrew")}
            </Button>
          ) : null}
          {!blockMutation ? (
            <Button
              variant="success"
              onClick={() => void brew()}
              disabled={!!busy || confirm.trim() !== phrase}
            >
              {busy === "load"
                ? t("brew.loading")
                : busy === "start"
                  ? t("brew.starting")
                  : t("brew.loadStart")}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                // Preserve workflow in storage; never cancel/stop on leave.
                reset();
                onClose();
                navigate("/");
              }}
            >
              {t("brew.goDashboard")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function RecipeSnapshot({ content }: { content: RecipeContent }) {
  if (isTeaContent(content)) {
    return <TeaSnapshot content={content} />;
  }
  return <CoffeeSnapshot content={content as CoffeeRecipeContent} />;
}

function CoffeeSnapshot({ content }: { content: CoffeeRecipeContent }) {
  return (
    <div className="mt-2 space-y-2 text-xs text-ink-muted">
      <div className="grid gap-1 sm:grid-cols-2">
        <div>Style {content.kind}</div>
        {content.dripper ? <div>Dripper {content.dripper}</div> : null}
        <div>Dose {content.dose_g} g</div>
        <div>Grind {content.grind}</div>
        <div>Ratio {content.ratio}</div>
        <div>Water {content.water_ml} ml</div>
        {content.hot_water_ml != null ? (
          <div>Hot water {content.hot_water_ml} ml</div>
        ) : null}
        {content.bypass_ml != null ? <div>Bypass {content.bypass_ml} ml</div> : null}
        {content.bypass_temp_c != null ? (
          <div>Bypass temp {String(content.bypass_temp_c)}</div>
        ) : null}
        {content.ice_g != null ? <div>Ice {content.ice_g} g</div> : null}
        {content.time ? <div>Time {content.time}</div> : null}
        {content.note ? <div className="sm:col-span-2">Note {content.note}</div> : null}
      </div>
      <div>
        <div className="mb-1 font-medium text-ink">Pours ({content.pours.length})</div>
        <ol className="space-y-1">
          {content.pours.map((p, i) => (
            <li
              key={i}
              className="rounded-md border border-line bg-surface px-2 py-1.5 text-ink"
            >
              <span className="text-ink-faint">{i + 1}.</span>{" "}
              {p.label || `Pour ${i + 1}`}: {p.ml} ml, temp {String(p.temp_c)},{" "}
              {p.pattern}, pause {p.pause_s}s, {p.rpm} rpm, {p.flow_ml_s} ml/s
              {p.vibration && p.vibration !== "none"
                ? `, vibration ${p.vibration}`
                : ""}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function TeaSnapshot({ content }: { content: TeaRecipeContent }) {
  return (
    <div className="mt-2 space-y-2 text-xs text-ink-muted">
      <div className="grid gap-1 sm:grid-cols-2">
        <div>Leaf {content.leaf_g} g</div>
        <div>Output {content.output_ml_per_steep} ml / steep</div>
      </div>
      <div>
        <div className="mb-1 font-medium text-ink">Steeps ({content.pours.length})</div>
        <ol className="space-y-1">
          {content.pours.map((p, i) => (
            <li
              key={i}
              className="rounded-md border border-line bg-surface px-2 py-1.5 text-ink"
            >
              <span className="text-ink-faint">{i + 1}.</span>{" "}
              {p.label || `Steep ${i + 1}`}: {p.ml} ml, {p.temp_c} C, {p.pattern},
              pause {p.pause_s}s, {p.flow_ml_s} ml/s
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

type ClassifiedFailure = {
  message: string;
  recovery: string | null;
  uncertain: boolean;
  /** When true, hide retry and route to Dashboard. */
  blockMutation: boolean;
  workflowId?: string;
};

function classifyBrewFailure(
  e: unknown,
  phase: "load" | "start",
  knownWorkflowId?: string,
): ClassifiedFailure {
  if (e instanceof ApiError) {
    const msg = `${phase} failed: ${e.message}`;
    const code = (e.code || "").toLowerCase();
    const cat = e.category;
    const detailsWf =
      e.details && typeof e.details.workflow_id === "string"
        ? e.details.workflow_id
        : undefined;
    const workflowId = knownWorkflowId || detailsWf;
    const wfHint = workflowId
      ? ` Workflow ${shortId(workflowId, 12)} is preserved.`
      : "";

    // Deterministic pre-write validation: user may correct and try again
    // (next explicit click mints a new request_id).
    if (
      cat === "validation" ||
      code === "invalid_request" ||
      code === "validation_error" ||
      e.status === 400 ||
      e.status === 422
    ) {
      return {
        message: msg,
        recovery: "Correct the issue above, then try again.",
        uncertain: false,
        blockMutation: false,
        workflowId,
      };
    }

    // External BLE ownership: no background retry/preemption; explicit later retry OK.
    if (code === "device_busy_external") {
      return {
        message: msg,
        recovery:
          "Another device or app may own the BLE connection. Release it, then try again.",
        uncertain: false,
        blockMutation: false,
        workflowId,
      };
    }

    // Deterministic availability / upgrade issues (not uncertain machine writes).
    if (
      code === "protocol_incompatible" ||
      code === "daemon_not_running" ||
      code === "daemon_not_client_ready"
    ) {
      return {
        message: msg,
        recovery:
          "Machine or bridge is not available in a compatible state. Fix availability or upgrade, then try again.",
        uncertain: false,
        blockMutation: false,
        workflowId,
      };
    }

    // Deterministic workflow conflict: preserve actual workflow, Dashboard only.
    if (code === "workflow_mismatch" || code === "workflow_conflict") {
      return {
        message: msg,
        recovery: `Workflow conflict.${wfHint} Open Dashboard to continue with the actual workflow. Do not start another brew from here.`,
        uncertain: false,
        blockMutation: true,
        workflowId,
      };
    }

    // Fail-closed uncertain mutation outcomes: no retry.
    if (
      cat === "network" ||
      cat === "timeout" ||
      cat === "bridge" ||
      code === "network" ||
      code === "timeout" ||
      code === "bridge_error" ||
      code === "recovery_required" ||
      e.status === 0 ||
      e.status === 503 ||
      e.status === 504 ||
      e.status === 502
    ) {
      return {
        message: msg,
        recovery: `Outcome is uncertain.${wfHint} Do not retry. Open Dashboard for status and recovery.`,
        uncertain: true,
        blockMutation: true,
        workflowId,
      };
    }

    if (workflowId) {
      return {
        message: msg,
        recovery: `Outcome is uncertain.${wfHint} Open Dashboard for status before another attempt.`,
        uncertain: true,
        blockMutation: true,
        workflowId,
      };
    }

    return {
      message: msg,
      recovery: null,
      uncertain: false,
      blockMutation: false,
    };
  }
  return {
    message: `${phase} failed: ${e instanceof Error ? e.message : String(e)}`,
    recovery:
      "Outcome is uncertain. Open Dashboard for status rather than retrying.",
    uncertain: true,
    blockMutation: true,
    workflowId: knownWorkflowId,
  };
}
