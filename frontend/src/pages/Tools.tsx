/**
 * FreeSolo basics: electronic scale, grinder, free hot water.
 * Frames match packages/core/xbloom_ble/protocol.py (extras.ts goldens).
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  api,
  newRequestId,
  ROOM_TEMPERATURE_C,
  WATER_START_CONFIRMATION,
} from "../api";
import {
  Alert,
  Button,
  Field,
  PageHeader,
  Panel,
  Select,
  TextInput,
} from "../components/ui";
import { isStaticDeploy } from "../lib/deploy";
import { POUR_PATTERNS } from "../lib/recipeDomain";
import { useI18n } from "../i18n/I18nContext";
import { useMachine } from "../machine/MachineContext";

export default function Tools() {
  const { t, tPhase, tStatus } = useI18n();
  const {
    driver,
    setDriver,
    webBluetooth,
    bleSession,
    bleSnapshot,
    connectBle,
  } = useMachine();
  const staticDeploy = isStaticDeploy();
  const webBle = driver === "web-bluetooth";
  const bridgeMode = driver === "bridge" && !staticDeploy;
  const linked =
    bleSnapshot.phase !== "idle" &&
    bleSnapshot.phase !== "disconnected" &&
    bleSnapshot.phase !== "error" &&
    bleSnapshot.phase !== "connecting" &&
    bleSnapshot.phase !== "terminal";

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flashOk, setFlashOk] = useState<string | null>(null);
  const [scaleActive, setScaleActive] = useState(false);

  // Grinder
  const [grind, setGrind] = useState(50);
  const [rpm, setRpm] = useState(90);

  // Water
  const [volumeMl, setVolumeMl] = useState(100);
  const [tempC, setTempC] = useState(90);
  const [roomTemp, setRoomTemp] = useState(false);
  const [flowMlS, setFlowMlS] = useState(3.5);
  const [pattern, setPattern] = useState("center");
  const [waterSource, setWaterSource] = useState<"auto" | "tank" | "tap">("auto");
  const [bridgeWaterWfId, setBridgeWaterWfId] = useState<string | null>(null);
  // Advanced mechanical (D/T; physical effect not guaranteed)
  const [pourRadius, setPourRadius] = useState(720);
  const [vibration, setVibration] = useState(1300);

  const weightG =
    bleSnapshot.scaleG != null
      ? bleSnapshot.scaleG
      : bleSnapshot.cupWeightG;

  const flashSuccess = (label: string) => {
    setFlashOk(label);
    // Brief "ok" without a full-page loading banner that flickers.
    window.setTimeout(() => {
      setFlashOk((cur) => (cur === label ? null : cur));
    }, 900);
  };

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
      flashSuccess(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runBridge = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setFlashOk(null);
    setBusy(label);
    try {
      await fn();
      flashSuccess(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleInlineBleConnect = () => {
    setError(null);
    setDriver("web-bluetooth");
    void bleSession.connect().catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const btnLabel = (id: string, idle: string) =>
    busy === id ? "…" : flashOk === id ? "✓" : idle;
  const effectiveTempC = roomTemp ? ROOM_TEMPERATURE_C : tempC;

  return (
    <div>
      <PageHeader title={t("tools.title")} description={t("tools.desc")} />

      {!webBle ? (
        <Alert tone="blue" className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {bridgeMode ? t("tools.bridgeWaterHint") : t("tools.needWebBle")}
            </span>
            {webBluetooth.usable ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy != null}
                onClick={handleInlineBleConnect}
              >
                {t("tools.connectBleDirect")}
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {webBle ? (
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
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={t("tools.water")}>
          <p className="mb-3 text-xs text-ink-muted">{t("tools.waterHint")}</p>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Field label={t("editor.ml")}>
              <TextInput
                type="number"
                min={20}
                max={360}
                value={String(volumeMl)}
                onChange={(e) => setVolumeMl(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label={t("editor.tempCustom")}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setRoomTemp((v) => !v)}
                  className={`h-9 rounded-xl px-2 text-xs font-medium transition-colors ${
                    roomTemp
                      ? "bg-brand text-paper"
                      : "border border-line bg-surface text-ink-muted hover:text-ink"
                  }`}
                >
                  {t("editor.tempRoom")}
                </button>
                <TextInput
                  type="number"
                  min={40}
                  max={98}
                  disabled={roomTemp}
                  value={roomTemp ? "" : String(tempC)}
                  placeholder={roomTemp ? t("editor.tempRoom") : "90"}
                  onChange={(e) => setTempC(Number(e.target.value) || 0)}
                />
              </div>
            </Field>
            <Field label={t("tools.waterFlow")}>
              <TextInput
                type="number"
                min={3.0}
                max={3.5}
                step="0.1"
                value={String(flowMlS)}
                onChange={(e) => setFlowMlS(Number(e.target.value) || 3.5)}
              />
            </Field>
            <Field label={t("editor.pattern")}>
              <Select
                value={pattern}
                onChange={(e) => setPattern(e.target.value || "center")}
              >
                {POUR_PATTERNS.map((p) => (
                  <option key={p} value={p}>
                    {t(`pattern.${p}` as Parameters<typeof t>[0])}
                  </option>
                ))}
              </Select>
            </Field>
            {bridgeMode ? (
              <Field label={t("tools.waterSource")} className="col-span-2">
                <Select
                  value={waterSource}
                  onChange={(e) =>
                    setWaterSource(
                      e.target.value as "auto" | "tank" | "tap",
                    )
                  }
                >
                  <option value="auto">{t("tools.waterSourceAuto")}</option>
                  <option value="tank">{t("tools.waterSourceTank")}</option>
                  <option value="tap">{t("tools.waterSourceTap")}</option>
                </Select>
              </Field>
            ) : null}
          </div>
          {bridgeMode ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="success"
                disabled={busy != null}
                onClick={() =>
                  void runBridge("water-start", async () => {
                    const res = await api.waterStart({
                      volume_ml: Math.round(volumeMl),
                      temp_c: Math.round(effectiveTempC),
                      confirmation: WATER_START_CONFIRMATION,
                      request_id: newRequestId(),
                      flow_ml_s: Number(flowMlS.toFixed(1)),
                      pattern: pattern as "center" | "spiral" | "circular" | "ring",
                      water_source: waterSource,
                    });
                    setBridgeWaterWfId(
                      typeof res.workflow_id === "string"
                        ? res.workflow_id
                        : null,
                    );
                  })
                }
              >
                {btnLabel("water-start", t("tools.start"))}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy != null || !bridgeWaterWfId}
                onClick={() =>
                  void runBridge("water-stop", async () => {
                    if (!bridgeWaterWfId) return;
                    await api.stop(bridgeWaterWfId, newRequestId());
                    setBridgeWaterWfId(null);
                  })
                }
              >
                {btnLabel("water-stop", t("tools.stop"))}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="success"
                  disabled={busy != null || !webBle}
                  onClick={() =>
                    void run("water-start", () =>
                      bleSession.waterStart(
                        volumeMl,
                        effectiveTempC,
                        flowMlS,
                        pattern,
                      ),
                    )
                  }
                >
                  {btnLabel("water-start", t("tools.start"))}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy != null || !webBle}
                  onClick={() =>
                    void run("water-pause", () => bleSession.waterPause())
                  }
                >
                  {btnLabel("water-pause", t("tools.pause"))}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy != null || !webBle}
                  onClick={() =>
                    void run("water-resume", () => bleSession.waterResume())
                  }
                >
                  {btnLabel("water-resume", t("tools.resume"))}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy != null || !webBle}
                  onClick={() =>
                    void run("water-stop", () => bleSession.waterStop())
                  }
                >
                  {btnLabel("water-stop", t("tools.stop"))}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy != null || !webBle}
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
                  disabled={busy != null || !webBle}
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
                  disabled={busy != null || !webBle}
                  onClick={() =>
                    void run("water-temp", () =>
                      bleSession.waterSetTemperature(effectiveTempC),
                    )
                  }
                >
                  {btnLabel("water-temp", t("tools.applyTemp"))}
                </Button>
              </div>
            </>
          )}
        </Panel>

        <Panel title={t("tools.scale")}>
          <p className="mb-3 text-xs text-ink-muted">{t("tools.scaleHint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy != null || !webBle}
              onClick={() =>
                void run("scale-tare", async () => {
                  if (!scaleActive) {
                    await bleSession.scaleEnter();
                    setScaleActive(true);
                  }
                  await bleSession.scaleTare();
                })
              }
            >
              {btnLabel("scale-tare", t("tools.tare"))}
            </Button>
            {scaleActive ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy != null || !webBle}
                onClick={() =>
                  void run("scale-exit", async () => {
                    await bleSession.scaleExit();
                    setScaleActive(false);
                  })
                }
              >
                {btnLabel("scale-exit", t("tools.exit"))}
              </Button>
            ) : null}
          </div>
          {!webBle && webBluetooth.usable ? (
            <button
              type="button"
              onClick={handleInlineBleConnect}
              className="mt-3 text-xs text-brand hover:underline"
            >
              {t("tools.connectBleDirect")}
            </button>
          ) : null}
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
              variant="success"
              disabled={busy != null || !webBle}
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
              disabled={busy != null || !webBle}
              onClick={() =>
                void run("grind-pause", () => bleSession.grinderPause())
              }
            >
              {btnLabel("grind-pause", t("tools.pause"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null || !webBle}
              onClick={() =>
                void run("grind-resume", () => bleSession.grinderResume())
              }
            >
              {btnLabel("grind-resume", t("tools.resume"))}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy != null || !webBle}
              onClick={() =>
                void run("grind-stop", () => bleSession.grinderStop())
              }
            >
              {btnLabel("grind-stop", t("tools.stop"))}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null || !webBle}
              onClick={() =>
                void run("grind-quit", () => bleSession.grinderQuit())
              }
            >
              {btnLabel("grind-quit", t("tools.quit"))}
            </Button>
          </div>
          {!webBle && webBluetooth.usable ? (
            <button
              type="button"
              onClick={handleInlineBleConnect}
              className="mt-3 text-xs text-brand hover:underline"
            >
              {t("tools.connectBleDirect")}
            </button>
          ) : null}
        </Panel>
      </div>

      {webBle ? (
        <details className="group mt-4 rounded-2xl border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-medium text-ink-muted hover:text-ink">
            <span>{t("tools.advanced")}</span>
            <ChevronDown
              className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="border-t border-line px-4 pb-4 pt-3">
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
          </div>
        </details>
      ) : null}
    </div>
  );
}
