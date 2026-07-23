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
  const { t } = useI18n();
  const { driver, bleSession, bleSnapshot, connectBle } = useMachine();
  const webBle = driver === "web-bluetooth";
  const linked =
    bleSnapshot.phase !== "idle" &&
    bleSnapshot.phase !== "disconnected" &&
    bleSnapshot.phase !== "error" &&
    bleSnapshot.phase !== "connecting";

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Grinder
  const [grind, setGrind] = useState(50);
  const [rpm, setRpm] = useState(90);

  // Water
  const [volumeMl, setVolumeMl] = useState(100);
  const [tempC, setTempC] = useState(90);
  const [flowMlS, setFlowMlS] = useState(3.5);
  const [pattern, setPattern] = useState("center");

  const run = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      if (!webBle) {
        throw new Error(t("tools.needWebBle"));
      }
      if (!linked) {
        await connectBle();
      }
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title={t("tools.title")} description={t("tools.desc")} />

      {!webBle ? (
        <Alert tone="amber" className="mb-4">
          {t("tools.needWebBle")}
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <div className="mb-3 text-xs text-ink-muted">
        {t("dashboard.phase")}:{" "}
        <span className="text-ink">{bleSnapshot.phase}</span>
        {bleSnapshot.machineStateName
          ? ` · ${bleSnapshot.machineStateName}`
          : ""}
        {bleSnapshot.cupWeightG != null
          ? ` · ${t("dashboard.cup")} ${bleSnapshot.cupWeightG}g`
          : ""}
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
              {t("tools.enter")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() => void run("scale-tare", () => bleSession.scaleTare())}
            >
              {t("tools.tare")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() => void run("scale-exit", () => bleSession.scaleExit())}
            >
              {t("tools.exit")}
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
              {t("tools.enter")}
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
              {t("tools.start")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy != null}
              onClick={() =>
                void run("grind-stop", () => bleSession.grinderStop())
              }
            >
              {t("tools.stop")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("grind-quit", () => bleSession.grinderQuit())
              }
            >
              {t("tools.quit")}
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
              {t("tools.enter")}
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
              {t("tools.start")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy != null}
              onClick={() =>
                void run("water-stop", () => bleSession.waterStop())
              }
            >
              {t("tools.stop")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy != null}
              onClick={() =>
                void run("water-quit", () => bleSession.waterQuit())
              }
            >
              {t("tools.quit")}
            </Button>
          </div>
        </Panel>
      </div>

      {busy ? (
        <p className="mt-3 text-xs text-ink-muted">
          {t("common.loading")} ({busy})
        </p>
      ) : null}
    </div>
  );
}
