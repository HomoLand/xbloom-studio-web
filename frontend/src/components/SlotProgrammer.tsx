/**
 * Easy-Mode A/B/C slot programmer — write batch + read via App cloud Easy list.
 */

import { useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import type { CoffeeRecipeContent, RecipeContent } from "../api";
import { useI18n } from "../i18n/I18nContext";
import { getAccountCredentials } from "../lib/accountPrefs";
import {
  fetchEasyModeSlotsFromCloud,
  readLastEasyWrite,
  snapshotFromLocalWrite,
  writeLastEasyWrite,
  type EasyModeSnapshot,
  type EasySlotView,
} from "../lib/easyModeSlots";
import {
  listAllLocalRecipes,
  type LocalRecipeEntry,
} from "../lib/localRecipes";
import { isCoffeeContent, recipeDisplayName } from "../lib/recipeDomain";
import {
  cacheMachineSerial,
  readCachedMachineSerial,
} from "../ble/session";
import { useMachine } from "../machine/MachineContext";
import {
  Alert,
  Button,
  Field,
  Panel,
  Select,
  StatusPill,
  TextInput,
} from "./ui";

type Phase =
  | "idle"
  | "connect"
  | "pro"
  | "write"
  | "read"
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
  const [manualSn, setManualSn] = useState(
    () => readCachedMachineSerial() ?? readLastEasyWrite()?.sn ?? "",
  );
  const [snapshot, setSnapshot] = useState<EasyModeSnapshot | null>(() => {
    const last = readLastEasyWrite();
    if (!last) return null;
    return {
      source: "local-write",
      sn: last.sn ?? undefined,
      slots: (["A", "B", "C"] as const).map((position, i) => ({
        position,
        name: last.names[i]!,
        content: null,
        scale: true,
      })),
      fetchedAt: last.writtenAt,
      warning: "local-write",
    };
  });

  const snapshotWarning = (snap: EasyModeSnapshot): string | null => {
    if (snap.warning === "local-write" || snap.source === "local-write") {
      return t("slots.lastWriteHint");
    }
    if (snap.warning === "easy-default") return t("slots.easyDefaultWarn");
    return snap.warning ?? null;
  };

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
      case "read":
        return t("slots.phaseRead");
      case "done":
        return t("slots.phaseDone");
      case "error":
        return t("slots.phaseError");
      default:
        return t("slots.phaseIdle");
    }
  };

  const ensureConnected = async () => {
    if (
      bleSnapshot.phase === "idle" ||
      bleSnapshot.phase === "disconnected" ||
      bleSnapshot.phase === "error" ||
      bleSnapshot.phase === "terminal"
    ) {
      setPhase("connect");
      await connectBle();
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
      await ensureConnected();
      setPhase("pro");
      setPhase("write");
      await bleSession.saveSlots([a, b, c]);
      let sn: string | undefined;
      try {
        const infoM = await bleSession.readMachineInfo();
        sn = infoM.serialNumber;
      } catch {
        /* optional */
      }
      const names: [string, string, string] = [
        recipeDisplayName(a),
        recipeDisplayName(b),
        recipeDisplayName(c),
      ];
      writeLastEasyWrite({
        sn,
        names,
        recipeIds: [slotA, slotB, slotC],
        writtenAt: new Date().toISOString(),
      });
      setSnapshot(snapshotFromLocalWrite(names, [a, b, c], sn));
      setPhase("done");
      setInfo(
        t("slots.saved")
          .replace("{a}", names[0])
          .replace("{b}", names[1])
          .replace("{c}", names[2]),
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

  /**
   * App parity: read Easy A/B/C via account Easy-mode list + machine SN.
   * Not pure BLE recipe dump (protocol only exposes mode reports).
   */
  const readSlots = async () => {
    setError(null);
    setInfo(null);
    if (driver !== "web-bluetooth") {
      setError(t("recipes.needWebBle"));
      setPhase("error");
      return;
    }
    const creds = getAccountCredentials();
    if (!creds) {
      setError(t("slots.needAccount"));
      setPhase("error");
      return;
    }
    setBusy(true);
    setPhase("read");
    try {
      await ensureConnected();
      let sn = "";
      let snSource: "live" | "manual" | "cache" = "live";
      try {
        const infoM = await bleSession.readMachineInfo();
        sn = infoM.serialNumber?.trim() ?? "";
        if (sn) {
          setManualSn(sn);
          cacheMachineSerial(sn);
        }
      } catch {
        /* fall through to manual / cache */
      }
      if (!sn) {
        const typed = manualSn.trim();
        const cached =
          readCachedMachineSerial() ?? readLastEasyWrite()?.sn ?? "";
        if (typed.length >= 4) {
          sn = typed;
          snSource = "manual";
          cacheMachineSerial(sn);
        } else if (cached && cached.length >= 4) {
          sn = cached;
          snSource = "cache";
          setManualSn(cached);
        }
      }
      if (!sn) throw new Error(t("slots.noSerial"));
      const snap = await fetchEasyModeSlotsFromCloud({
        email: creds.email,
        password: creds.password,
        region: creds.region,
        sn,
        languageType: creds.languageType,
      });
      setSnapshot(snap);
      setPhase("done");
      const n = String(snap.slots.filter((s) => s.content).length);
      const base = t("slots.readDone").replace("{n}", n);
      setInfo(
        snSource === "live"
          ? base
          : `${base} · ${t("slots.snFallback").replace("{sn}", sn)}`,
      );
      // Pre-select matching local recipes when names match
      for (const s of snap.slots) {
        if (!s.content) continue;
        const match = options.find(
          (o) =>
            recipeDisplayName(o.content) === s.name || o.name === s.name,
        );
        if (!match) continue;
        if (s.position === "A") setSlotA(match.recipe_id);
        if (s.position === "B") setSlotB(match.recipe_id);
        if (s.position === "C") setSlotC(match.recipe_id);
      }
    } catch (e) {
      setPhase("error");
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /40521|serial|no_machine_info/i.test(msg)
          ? t("slots.noSerial")
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t("slots.title")} className="mt-4">
      <p className="mb-3 text-xs text-ink-muted">{t("slots.hint")}</p>
      <p className="mb-3 text-xs text-ink-faint">{t("slots.readHint")}</p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <StatusPill tone="neutral">{phaseLabel(phase)}</StatusPill>
        {bleSnapshot.phase !== "idle" && bleSnapshot.phase !== "disconnected" ? (
          <StatusPill tone="blue">
            {tPhase(bleSnapshot.phase)}
            {bleSnapshot.machineStateName
              ? ` · ${tStatus(bleSnapshot.machineStateName)}`
              : ""}
          </StatusPill>
        ) : null}
        {bleSnapshot.machineInfo?.serialNumber ? (
          <StatusPill tone="amber">
            SN {bleSnapshot.machineInfo.serialNumber}
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

      {snapshot ? (
        <div className="mb-4 overflow-hidden rounded-2xl border border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
            <span className="font-medium text-ink">{t("slots.currentTitle")}</span>
            <span>
              {snapshot.source === "cloud"
                ? t("slots.sourceCloud")
                : t("slots.sourceLocalWrite")}
              {snapshot.sn ? ` · SN ${snapshot.sn}` : ""}
            </span>
          </div>
          {snapshotWarning(snapshot) ? (
            <div className="border-b border-line px-3 py-1.5 text-[11px] text-ink-faint">
              {snapshotWarning(snapshot)}
            </div>
          ) : null}
          <div className="grid gap-0 sm:grid-cols-3">
            {snapshot.slots.map((s) => (
              <SlotCard key={s.position} slot={s} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mb-3">
        <Field label={t("slots.snLabel")}>
          <TextInput
            value={manualSn}
            onChange={(e) => setManualSn(e.target.value)}
            placeholder={t("slots.snPlaceholder")}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <p className="mt-1 text-[11px] text-ink-faint">{t("slots.snHint")}</p>
      </div>

      {options.length === 0 ? (
        <p className="mb-3 text-sm text-ink-muted">{t("slots.empty")}</p>
      ) : (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <Field label="A">
            <Select
              value={slotA}
              onChange={(e) => setSlotA(e.target.value)}
              disabled={busy}
            >
              {options.map((o) => (
                <option key={o.recipe_id} value={o.recipe_id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="B">
            <Select
              value={slotB}
              onChange={(e) => setSlotB(e.target.value)}
              disabled={busy}
            >
              {options.map((o) => (
                <option key={o.recipe_id} value={o.recipe_id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="C">
            <Select
              value={slotC}
              onChange={(e) => setSlotC(e.target.value)}
              disabled={busy}
            >
              {options.map((o) => (
                <option key={o.recipe_id} value={o.recipe_id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void readSlots()}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {busy && phase === "read" ? t("slots.reading") : t("slots.read")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || options.length === 0}
          onClick={() => void write()}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {busy && phase === "write" ? t("slots.writing") : t("slots.write")}
        </Button>
      </div>
    </Panel>
  );
}

function SlotCard({ slot }: { slot: EasySlotView }) {
  const { t } = useI18n();
  const c = slot.content;
  return (
    <div className="border-b border-line p-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <StatusPill tone="blue">{slot.position}</StatusPill>
        <span className="text-[10px] text-ink-faint">
          {slot.scale ? t("slots.scaleOn") : t("slots.scaleOff")}
        </span>
      </div>
      <div className="truncate text-sm font-medium text-ink">{slot.name}</div>
      {c ? (
        <div className="mt-1 text-[11px] text-ink-muted">
          {c.dose_g}g · {t("recipes.grind")} {c.grind} · {c.water_ml}ml ·{" "}
          {c.pours.length} {t("recipes.pours")}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-ink-faint">
          {slot.note || "—"}
        </div>
      )}
    </div>
  );
}
