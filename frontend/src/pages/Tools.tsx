/**
 * FreeSolo basics: electronic scale, grinder, free hot water.
 * Frames match packages/core/xbloom_ble/protocol.py (extras.ts goldens).
 */

import { useState } from "react";
import {
  Alert,
  Button,
  Field,
  PageHeader,
  Panel,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import { useMachine } from "../machine/MachineContext";

export default function Tools() {
  const { t, tPhase, tStatus } = useI18n();
  const { driver, bleSession, bleSnapshot, connectBle } = useMachine();
  const webBle = driver === "web-bluetooth";
  const linked =
    bleSnapshot.phase !== "idle" &&
    bleSnapshot.phase !== "disconnected" &&
    bleSnapshot.phase !== "error" &&
    bleSnapshot.phase !== "connecting" &&
    bleSnapshot.phase !== "terminal";

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flashOk, setFlashOk] = useState<string | null>(null);

  // Grinder
  const [grind, setGrind] = useState(50);
  const [rpm, setRpm] = useState(90);

  // Water
  const [volumeMl, setVolumeMl] = useState(100);
  const [tempC, setTempC] = useState(90);
  const [flowMlS, setFlowMlS] = useState(3.5);
  const [pattern, setPattern] = useState("center");
  // Advanced mechanical (D/T; physical effect not guaranteed)
  const [pourRadius, setPourRadius] = useState(720);
  const [vibration, setVibration] = useState(1300);

  const weightG =
    bleSnapshot.scaleG != null
      ? bleSnapshot.scaleG
      : bleSnapshot.cupWeightG;

  const run = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setFlashOk(null);
    setBusy(label);
    try {
      if (!webBle) {
        throw new Error(t("tools.needWebBle"));
      }
      if (!linked) {
        await connectBle();
      }
      await fn();
      setFlashOk(label);
      // Brief "ok" without a full-page loading banner that flickers.
      window.setTimeout(() => {
        setFlashOk((cur) => (cur === label ? null : cur));
      }, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const btnLabel = (id: string, idle: string) =>
    busy === id ? "…" : flashOk === id ? "✓" : idle;

  return (
    <div>
      <PageHeader title={t("tools.title")} description={t("tools.desc")} />

      {!webBle ? (
        <Alert tone="amber" className="mb-4">
          {driver === "bridge" ? t("tools.bridgeModeHint") : t("tools.needWebBle")}
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <div className="mb-4 overflow-hidden rounded-2xl border border-line bg-surface-2 px-4 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">
              {t("tools.liveWeight")}
            </div>
            <div className="mt-1 font-semibold tabular-nums text-ink">
              <span className="text-3xl sm:text-4xl">
                {weightG != null ? weightG.toFixed(1) : "—"}
              </span>
              <span className="ml-1 text-sm text-ink-muted">g</span>
            </div>
          </div>
          <div className="text-right text-xs text-ink-muted">
            <div>
              {t("dashboard.phase")}:{" "}
              <span className="text-ink">{tPhase(bleSnapshot.phase)}</span>
              {bleSnapshot.machineStateName
                ? ` · ${tStatus(bleSnapshot.machineStateName)}`
                : ""}
            </div>
            {bleSnapshot.dispensedWaterMl != null ? (
              <div className="mt-0.5">
                {t("dashboard.water")}:{" "}
                <span className="tabular-nums text-ink">
                  {Math.round(bleSnapshot.dispensedWaterMl)} ml
                </span>
              </div>
            ) : null}
            {bleSnapshot.lastActivityName ? (
              <div className="mt-0.5 text-ink-faint">
                {t("tools.lastAction")}: {tStatus(bleSnapshot.lastActivityName)}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={t("tools.scale")}>
          <p className="mb-3 text-xs text-ink-muted">{t("tools.scaleHint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy != null}
              onClick={() => void run("scale-enter", () => bleSession.scaleEnter())}
            >
              {btnLabel("scale-enter", t("tools.enter"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() => void run("scale-tare", () => bleSession.scaleTare())}
            >
              {btnLabel("scale-tare", t("tools.tare"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() => void run("scale-exit", () => bleSession.scaleExit())}
            >
              {btnLabel("scale-exit", t("tools.exit"))}
            </Button>
          </div>
        </Panel>

        <Panel title={t("tools.grinder")}>
          <p className="mb-3 text-xs text-ink-muted">{t("tools.grinderHint")}</p>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Field label={t("recipes.grind")}>
              <TextInput
                type="number"
                value={String(grind)}
                onChange={(e) => setGrind(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label="RPM">
              <TextInput
                type="number"
                value={String(rpm)}
                onChange={(e) => setRpm(Number(e.target.value) || 0)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("grind-enter", () =>
                  bleSession.grinderEnter(grind, rpm),
                )
              }
            >
              {btnLabel("grind-enter", t("tools.enter"))}
            </Button>
            <Button
              size="sm"
              variant="success"
              disabled={busy != null}
              onClick={() =>
                void run("grind-start", () =>
                  bleSession.grinderStart(grind, rpm),
                )
              }
            >
              {btnLabel("grind-start", t("tools.start"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("grind-pause", () => bleSession.grinderPause())
              }
            >
              {btnLabel("grind-pause", t("tools.pause"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("grind-resume", () => bleSession.grinderResume())
              }
            >
              {btnLabel("grind-resume", t("tools.resume"))}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy != null}
              onClick={() =>
                void run("grind-stop", () => bleSession.grinderStop())
              }
            >
              {btnLabel("grind-stop", t("tools.stop"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("grind-quit", () => bleSession.grinderQuit())
              }
            >
              {btnLabel("grind-quit", t("tools.quit"))}
            </Button>
          </div>
        </Panel>

        <Panel title={t("tools.water")}>
          <p className="mb-3 text-xs text-ink-muted">{t("tools.waterHint")}</p>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Field label="ml">
              <TextInput
                type="number"
                value={String(volumeMl)}
                onChange={(e) => setVolumeMl(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label="°C">
              <TextInput
                type="number"
                value={String(tempC)}
                onChange={(e) => setTempC(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label="ml/s">
              <TextInput
                type="number"
                step="0.1"
                value={String(flowMlS)}
                onChange={(e) => setFlowMlS(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label={t("editor.pattern")}>
              <TextInput
                value={pattern}
                onChange={(e) => setPattern(e.target.value || "center")}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-enter", () =>
                  bleSession.waterEnter(tempC, pattern),
                )
              }
            >
              {btnLabel("water-enter", t("tools.enter"))}
            </Button>
            <Button
              size="sm"
              variant="success"
              disabled={busy != null}
              onClick={() =>
                void run("water-start", () =>
                  bleSession.waterStart(volumeMl, tempC, flowMlS, pattern),
                )
              }
            >
              {btnLabel("water-start", t("tools.start"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-pause", () => bleSession.waterPause())
              }
            >
              {btnLabel("water-pause", t("tools.pause"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-resume", () => bleSession.waterResume())
              }
            >
              {btnLabel("water-resume", t("tools.resume"))}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy != null}
              onClick={() =>
                void run("water-stop", () => bleSession.waterStop())
              }
            >
              {btnLabel("water-stop", t("tools.stop"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-quit", () => bleSession.waterQuit())
              }
            >
              {btnLabel("water-quit", t("tools.quit"))}
            </Button>
          </div>
          <p className="mb-2 mt-3 text-xs text-ink-faint">
            {t("tools.liveHint")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-pattern", () =>
                  bleSession.waterSetPattern(pattern),
                )
              }
            >
              {btnLabel("water-pattern", t("tools.applyPattern"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-temp", () =>
                  bleSession.waterSetTemperature(tempC),
                )
              }
            >
              {btnLabel("water-temp", t("tools.applyTemp"))}
            </Button>
          </div>
        </Panel>
      </div>

      <Panel title={t("tools.advanced")} className="mt-4">
        <p className="mb-3 text-xs text-ink-muted">{t("tools.advancedHint")}</p>
        <div className="mb-3 grid grid-cols-2 gap-2 sm:max-w-md">
          <Field label={t("tools.pourRadius")}>
            <TextInput
              type="number"
              value={String(pourRadius)}
              onChange={(e) => setPourRadius(Number(e.target.value) || 0)}
            />
          </Field>
          <Field label={t("tools.vibration")}>
            <TextInput
              type="number"
              step={100}
              value={String(vibration)}
              onChange={(e) => setVibration(Number(e.target.value) || 0)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy != null}
            onClick={() =>
              void run("radius-read", () => bleSession.readPourRadius())
            }
          >
            {btnLabel("radius-read", t("tools.readRadius"))}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy != null}
            onClick={() =>
              void run("radius-write", () =>
                bleSession.writePourRadius(pourRadius),
              )
            }
          >
            {btnLabel("radius-write", t("tools.writeRadius"))}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy != null}
            onClick={() =>
              void run("vib-read", () => bleSession.readVibrationAmplitude())
            }
          >
            {btnLabel("vib-read", t("tools.readVibration"))}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy != null}
            onClick={() =>
              void run("vib-write", () =>
                bleSession.writeVibrationAmplitude(vibration),
              )
            }
          >
            {btnLabel("vib-write", t("tools.writeVibration"))}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
