/**
 * Easy-Mode A/B/C slot programmer — user picks three coffee recipes.
 */

import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import type { CoffeeRecipeContent, RecipeContent } from "../api";
import { useI18n } from "../i18n/I18nContext";
import {
  listAllLocalRecipes,
  type LocalRecipeEntry,
} from "../lib/localRecipes";
import { isCoffeeContent, recipeDisplayName } from "../lib/recipeDomain";
import { useMachine } from "../machine/MachineContext";
import { Alert, Button, Field, Panel, Select, StatusPill } from "./ui";

type Phase =
  | "idle"
  | "connect"
  | "pro"
  | "write"
  | "done"
  | "error";

function coffeeEntries(): LocalRecipeEntry[] {
  return listAllLocalRecipes().filter((e) => isCoffeeContent(e.content));
}

function asCoffee(c: RecipeContent | undefined): CoffeeRecipeContent | null {
  return c && isCoffeeContent(c) ? c : null;
}

export function SlotProgrammer() {
  const { t, tPhase, tStatus } = useI18n();
  const { driver, bleSession, bleSnapshot, connectBle } = useMachine();
  const options = useMemo(() => coffeeEntries(), []);
  const firstId = options[0]?.recipe_id ?? "";
  const [slotA, setSlotA] = useState(firstId);
  const [slotB, setSlotB] = useState(firstId);
  const [slotC, setSlotC] = useState(firstId);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const pick = (id: string): CoffeeRecipeContent | null => {
    const entry = options.find((e) => e.recipe_id === id);
    return asCoffee(entry?.content);
  };

  const phaseLabel = (p: Phase): string => {
    switch (p) {
      case "connect":
        return t("slots.phaseConnect");
      case "pro":
        return t("slots.phasePro");
      case "write":
        return t("slots.phaseWrite");
      case "done":
        return t("slots.phaseDone");
      case "error":
        return t("slots.phaseError");
      default:
        return t("slots.phaseIdle");
    }
  };

  const write = async () => {
    setError(null);
    setInfo(null);
    setPhase("idle");
    const a = pick(slotA);
    const b = pick(slotB);
    const c = pick(slotC);
    if (!a || !b || !c) {
      setError(t("slots.needThree"));
      setPhase("error");
      return;
    }
    if (
      Number((a as { bypass_ml?: number }).bypass_ml || 0) > 0 ||
      Number((b as { bypass_ml?: number }).bypass_ml || 0) > 0 ||
      Number((c as { bypass_ml?: number }).bypass_ml || 0) > 0
    ) {
      setError(t("slots.noBypass"));
      setPhase("error");
      return;
    }
    if (driver !== "web-bluetooth") {
      setError(t("recipes.needWebBle"));
      setPhase("error");
      return;
    }
    setBusy(true);
    try {
      if (
        bleSnapshot.phase === "idle" ||
        bleSnapshot.phase === "disconnected" ||
        bleSnapshot.phase === "error"
      ) {
        setPhase("connect");
        await connectBle();
      }
      setPhase("pro");
      // saveSlots sends PRO mode then A/B/C frames
      setPhase("write");
      await bleSession.saveSlots([a, b, c]);
      setPhase("done");
      setInfo(
        t("slots.saved")
          .replace("{a}", recipeDisplayName(a))
          .replace("{b}", recipeDisplayName(b))
          .replace("{c}", recipeDisplayName(c)),
      );
    } catch (e) {
      setPhase("error");
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /retry|0x43|hang|timeout|not connected|disconnect/i.test(msg)
          ? `${msg} — ${t("slots.failHint")}`
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!options.length) {
    return (
      <Panel title={t("slots.title")}>
        <p className="text-sm text-ink-muted">{t("slots.empty")}</p>
      </Panel>
    );
  }

  const selectOpts = options.map((e) => (
    <option key={e.recipe_id} value={e.recipe_id}>
      {e.name || recipeDisplayName(e.content)}
      {e.source === "official" ? " ★" : ""}
    </option>
  ));

  return (
    <Panel title={t("slots.title")} className="mt-4">
      <p className="mb-3 text-xs text-ink-muted">{t("slots.hint")}</p>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <StatusPill
          tone={
            phase === "done"
              ? "green"
              : phase === "error"
                ? "red"
                : phase === "idle"
                  ? "neutral"
                  : "amber"
          }
        >
          {phaseLabel(phase)}
        </StatusPill>
        {driver !== "web-bluetooth" ? (
          <StatusPill tone="amber">{t("recipes.needWebBle")}</StatusPill>
        ) : null}
        {bleSnapshot.phase !== "idle" && bleSnapshot.phase !== "disconnected" ? (
          <StatusPill tone="blue">
            {tPhase(bleSnapshot.phase)}
            {bleSnapshot.machineStateName
              ? ` · ${tStatus(bleSnapshot.machineStateName)}`
              : ""}
          </StatusPill>
        ) : null}
      </div>
      {error ? (
        <Alert tone="red" className="mb-3">
          {error}
        </Alert>
      ) : null}
      {info ? (
        <Alert tone="green" className="mb-3">
          {info}
        </Alert>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="A">
          <Select value={slotA} onChange={(e) => setSlotA(e.target.value)}>
            {selectOpts}
          </Select>
        </Field>
        <Field label="B">
          <Select value={slotB} onChange={(e) => setSlotB(e.target.value)}>
            {selectOpts}
          </Select>
        </Field>
        <Field label="C">
          <Select value={slotC} onChange={(e) => setSlotC(e.target.value)}>
            {selectOpts}
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || driver !== "web-bluetooth"}
          onClick={() => void write()}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {busy ? t("slots.writing") : t("slots.write")}
        </Button>
        <span className="text-[11px] text-ink-faint">{t("slots.proNote")}</span>
      </div>
    </Panel>
  );
}
