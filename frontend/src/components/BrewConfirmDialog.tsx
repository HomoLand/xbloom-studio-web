import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  newRequestId,
  startConfirmationForKind,
  type RecipeContent,
  type RecipeRevision,
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
import { Alert, Button, Dialog } from "./ui";
import { RecipeCard } from "./RecipeCard";

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
 * Recipe preview + red confirm for load+start.
 * Closing/unmounting never cancels, stops, or disconnects the machine.
 * Bridge APIs still receive the internal safety token automatically.
 */
export function BrewConfirmDialog({ open, target, onClose, onStarted }: Props) {
  const navigate = useNavigate();
  const { t, tPhase, tStatus } = useI18n();
  const { driver, bleSession, bleSnapshot, connectBle } = useMachine();
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
  const name =
    target?.recipeName ||
    (content ? recipeDisplayName(content) : "Recipe");
  const webBle = driver === "web-bluetooth";

  const reset = () => {
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
    if (!isCoffeeContent(content) && !isTeaContent(content)) {
      setError(t("brew.unsupported"));
      return;
    }

    setError(null);
    setRecovery(null);
    setUncertain(false);
    setBlockMutation(false);

    const beverage = kind;
    let workflowId = loadedWorkflowId;
    try {
      if (
        bleSnapshot.phase === "idle" ||
        bleSnapshot.phase === "disconnected" ||
        bleSnapshot.phase === "error" ||
        bleSnapshot.phase === "terminal"
      ) {
        // Auto-reconnect with saved pair (no picker after first grant).
        setBusy("load");
        await connectBle();
      }

      if (!workflowId) {
        setBusy("load");
        workflowId = newRequestId("webble");
        if (isTeaContent(content)) {
          await bleSession.loadTea(content, {
            journal: {
              recipe_name: target.recipeName ?? recipeDisplayName(content),
              recipe_revision_id: target.recipeRevisionId,
              workflow_id: workflowId,
              kind: "tea",
            },
          });
        } else {
          await bleSession.loadCoffee(content, {
            journal: {
              recipe_name: target.recipeName ?? recipeDisplayName(content),
              recipe_revision_id: target.recipeRevisionId,
              workflow_id: workflowId,
              kind: content.kind,
            },
          });
        }
        setLoadedWorkflowId(workflowId);
        persistWorkflow(workflowId, beverage, target.recipeRevisionId);
      } else {
        bleSession.beginBrewJournal({
          recipe_name: target.recipeName ?? recipeDisplayName(content),
          recipe_revision_id: target.recipeRevisionId,
          workflow_id: workflowId,
          kind: isTeaContent(content) ? "tea" : content.kind,
        });
      }

      setBusy("start");
      if (isTeaContent(content)) {
        await bleSession.startTea();
      } else {
        await bleSession.startBrew();
      }
      persistWorkflow(workflowId, beverage, target.recipeRevisionId);
      const startedId = workflowId;
      reset();
      onStarted(startedId, beverage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRecovery(t("brew.readyCheck"));
      setBusy(null);
    }
  };

  /**
   * Browser-local synthetic ids (localStorage recipes) are not in host SQLite.
   * Bridge load only accepts durable revision ids — upsert content first.
   */
  const ensureBridgeRevisionId = async (): Promise<string> => {
    const rev = target?.recipeRevisionId?.trim() || "";
    const looksLocal =
      !rev ||
      rev.endsWith(":rev1") ||
      rev.startsWith("user:") ||
      rev.startsWith("share:") ||
      rev.startsWith("cloud:") ||
      rev.startsWith("local:") ||
      rev.startsWith("official:") ||
      rev.startsWith("starter:");
    if (!looksLocal) return rev;
    if (!content) throw new Error(t("brew.noTarget"));
    const created = await api.createRecipe({
      content,
      name: name,
      provenance: {
        source: "web-local-bridge-brew",
        local_recipe_id:
          rev.replace(/:rev1$/, "") || target?.recipeRevisionId || null,
      },
    });
    const id =
      created.revision?.revision_id ||
      created.recipe?.latest_revision?.revision_id;
    if (!id || typeof id !== "string") {
      throw new Error(
        "Bridge brew: host did not return a recipe revision_id after create.",
      );
    }
    return id;
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
    // Bridge still requires the fixed token; UI no longer asks the user to type it.
    const confirmation = startConfirmationForKind(beverage);

    if (!workflowId) {
      setBusy("load");
      // Fresh request_id for this explicit user mutation (no auto transport retry).
      const loadRequestId = newRequestId("load");
      try {
        const revisionId = await ensureBridgeRevisionId();
        const loadBody = {
          recipe_revision_id: revisionId,
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

    setBusy("start");
    // Fresh request_id for this explicit user start mutation.
    const startRequestId = newRequestId("start");
    try {
      if (beverage === "tea") {
        await api.teaStart({
          workflow_id: workflowId,
          confirmation,
          request_id: startRequestId,
        });
      } else {
        await api.coffeeStart({
          workflow_id: workflowId,
          confirmation,
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
        {webBle ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
            <span>
              {t("settings.webBle")} · {tPhase(bleSnapshot.phase)}
              {bleSnapshot.machineStateName
                ? ` · ${tStatus(bleSnapshot.machineStateName)}`
                : ""}
              {bleSnapshot.cupWeightG != null
                ? ` · ${bleSnapshot.cupWeightG} g`
                : ""}
            </span>
            {kind === "tea" ? (
              <span className="text-ink-faint">{t("brew.teaPhysHint")}</span>
            ) : null}
          </div>
        ) : null}

        <RecipeCard content={content} name={name} />

        <Alert tone="red">
          <div className="text-xs leading-relaxed">
            <span className="font-medium">{t("brew.safetyTitle")}：</span>
            {t("brew.safetyFooter")}
          </div>
        </Alert>

        {error ? <Alert tone="red">{error}</Alert> : null}
        {recovery ? (
          <Alert tone={uncertain ? "amber" : "blue"}>{recovery}</Alert>
        ) : null}

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
              variant="danger"
              className="border-transparent bg-accent-red text-paper hover:brightness-110 active:brightness-95"
              onClick={() => void brew()}
              disabled={!!busy}
            >
              {busy === "load"
                ? t("brew.loading")
                : busy === "start"
                  ? t("brew.starting")
                  : t("brew.confirmStart")}
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
