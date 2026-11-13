import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  Bluetooth,
  Cloud,
  History as HistoryIcon,
  LogOut,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, type PairingNewResult, type SessionInfo } from "../api";
import { useAuth } from "../auth/AuthContext";
import {
  Alert,
  Button,
  Field,
  IconButton,
  PageHeader,
  Panel,
  Select,
  Spinner,
  StatusPill,
  TextInput,
} from "../components/ui";
import { useI18n } from "../i18n/I18nContext";
import type { Locale } from "../i18n/messages";
import {
  clearSessionPassword,
  getAccountCredentials,
  hasAccountCredentials,
  readAccountPrefs,
  readSessionPassword,
  saveAccountSession,
  writeAccountPrefs,
} from "../lib/accountPrefs";
import {
  clearAiConfig,
  isAiConfigured,
  readAiConfig,
  writeAiConfig,
  type AiConfig,
} from "../lib/aiConfig";
import { importCloudSyncTargets } from "../lib/cloudCatalog";
import { importCloudBrewRecords } from "../lib/localHistory";
import {
  formatEpochSeconds,
  formatRemainingFromEpoch,
  isEpochExpired,
  shortId,
} from "../lib/recipeDomain";
import {
  cloudErrorMessage,
  fetchCloudBrewRecords,
  syncAccountCatalog,
} from "../lib/xbloomCloud";
import { useMachine } from "../machine/MachineContext";
import type { MachineDriver } from "../machine/driver";

export default function Settings() {
  const { t, tPhase, tStatus, locale, setLocale, locales, localeLabels } =
    useI18n();
  const { config, session, mode, logout, refresh } = useAuth();
  const {
    driver,
    setDriver,
    webBluetooth,
    bleSnapshot,
    bleSession,
    connectBle,
    disconnectBle,
  } = useMachine();
  const [bleBusy, setBleBusy] = useState(false);
  const [bleActionError, setBleActionError] = useState<string | null>(null);
  const [aiForm, setAiForm] = useState<AiConfig>(() => readAiConfig());
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [weightUnit, setWeightUnit] = useState<"ml" | "g" | "oz">("g");
  const [tempUnit, setTempUnit] = useState<"C" | "F">("C");
  const [waterSource, setWaterSource] = useState<"tank" | "tap">("tank");
  const [displayLevel, setDisplayLevel] = useState<"low" | "medium" | "high">(
    "medium",
  );
  const [machineBusy, setMachineBusy] = useState(false);
  const [machineMsg, setMachineMsg] = useState<string | null>(null);
  const [bridgeSnap, setBridgeSnap] = useState<{
    reachable: boolean | null;
    detail: string;
  } | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);

  const refreshBridge = useCallback(async () => {
    setBridgeBusy(true);
    try {
      const st = await api.bridge();
      const phase =
        st && typeof st === "object"
          ? String(
              (st as { phase?: string; connected?: boolean }).phase ??
                ((st as { connected?: boolean }).connected
                  ? "connected"
                  : "unknown"),
            )
          : "unknown";
      setBridgeSnap({
        reachable: true,
        detail: phase,
      });
    } catch (e) {
      setBridgeSnap({
        reachable: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBridgeBusy(false);
    }
  }, []);

  useEffect(() => {
    if (driver === "bridge") void refreshBridge();
  }, [driver, refreshBridge]);

  useEffect(() => {
    const info = bleSnapshot.machineInfo;
    if (!info) return;
    if (info.weightUnit === "ml" || info.weightUnit === "g" || info.weightUnit === "oz") {
      setWeightUnit(info.weightUnit);
    }
    if (info.temperatureUnit === "C" || info.temperatureUnit === "F") {
      setTempUnit(info.temperatureUnit);
    }
    if (info.waterSource === "tank" || info.waterSource === "tap") {
      setWaterSource(info.waterSource);
    }
  }, [bleSnapshot.machineInfo]);

  const applyMachineSettings = async () => {
    setMachineMsg(null);
    if (driver !== "web-bluetooth") {
      setMachineMsg(t("settings.machineNeedBle"));
      return;
    }
    setMachineBusy(true);
    try {
      if (
        bleSnapshot.phase === "idle" ||
        bleSnapshot.phase === "disconnected" ||
        bleSnapshot.phase === "error"
      ) {
        await connectBle();
      }
      const info = await bleSession.writeMachineSettings({
        weightUnit,
        temperatureUnit: tempUnit,
        waterSource,
        display: displayLevel,
      });
      setMachineMsg(
        t("settings.machineApplied")
          .replace("{sn}", info.serialNumber || "—")
          .replace("{fw}", info.firmware || "—"),
      );
    } catch (e) {
      setMachineMsg(
        "!" + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setMachineBusy(false);
    }
  };

  // xBloom account (password session-only)
  const initialPrefs = readAccountPrefs();
  const [accEmail, setAccEmail] = useState(initialPrefs.email);
  const [accPassword, setAccPassword] = useState(() => readSessionPassword());
  const [accRegion, setAccRegion] = useState<"china" | "international">(
    initialPrefs.region,
  );
  const [accMsg, setAccMsg] = useState<string | null>(null);
  const [accError, setAccError] = useState<string | null>(null);
  const [accBusy, setAccBusy] = useState<string | null>(null);
  const [accReady, setAccReady] = useState(() => hasAccountCredentials());
  useEffect(() => {
    if (mode === "static") return;
    let cancelled = false;
    void getAccountCredentials().then((creds) => {
      if (cancelled) return;
      setAccReady(Boolean(creds));
      if (creds) {
        setAccEmail(creds.email);
        setAccRegion(creds.region);
        setAccPassword("");
        clearSessionPassword();
      }
    }).catch((e) => {
      if (!cancelled) setAccError(cloudErrorMessage(e, t));
    });
    return () => { cancelled = true; };
  }, [mode, t]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingNewResult | null>(null);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadSessions = useCallback(async () => {
    if (mode === "static") {
      setLoadingSessions(false);
      setSessions([]);
      return;
    }
    setSessionsError(null);
    setLoadingSessions(true);
    try {
      const res = await api.authSessions();
      setSessions(res.sessions);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [mode]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!pairing) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [pairing]);

  // expires_at is Unix epoch seconds from the backend.
  const expiryLabel = pairing
    ? formatRemainingFromEpoch(pairing.expires_at, now)
    : null;
  const expired = pairing != null && isEpochExpired(pairing.expires_at, now);

  const createPairing = async () => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const result = await api.pairingNew(pairingLabel || null);
      setPairing(result);
      setNow(Date.now());
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairingBusy(false);
    }
  };

  const revoke = async (sessionId: string) => {
    try {
      await api.revokeSession(sessionId);
      if (session?.session_id === sessionId) {
        await logout();
        return;
      }
      await loadSessions();
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    }
  };

  const doLogout = async () => {
    try {
      await logout();
    } catch {
      /* refresh handles state */
    }
  };

  const saveAccount = async () => {
    setAccError(null);
    setAccMsg(null);
    if (!accEmail.trim() || !accPassword) {
      setAccError(t("cloud.needCreds"));
      return;
    }
    setAccBusy("login");
    try {
      await saveAccountSession({ email: accEmail, password: accPassword, region: accRegion });
      if (mode !== "static") setAccPassword("");
      setAccReady(true);
      setAccMsg(t(mode === "static" ? "settings.accountSaved" : "settings.accountHostSaved"));
    } catch (e) {
      setAccError(cloudErrorMessage(e, t));
    } finally {
      setAccBusy(null);
    }
  };

  const clearAccount = async () => {
    setAccError(null);
    setAccMsg(null);
    setAccBusy("logout");
    try {
      if (mode !== "static") await api.accountLogout();
      clearSessionPassword();
      writeAccountPrefs({ email: accEmail, region: accRegion });
      setAccPassword("");
      setAccReady(false);
      setAccMsg(t(mode === "static" ? "settings.accountCleared" : "settings.accountHostCleared"));
    } catch (e) {
      setAccError(cloudErrorMessage(e, t));
    } finally {
      setAccBusy(null);
    }
  };

  const runAccountAction = async (
    label: string,
    fn: (creds: NonNullable<Awaited<ReturnType<typeof getAccountCredentials>>>) => Promise<string>,
  ) => {
    setAccError(null);
    setAccMsg(null);
    setAccBusy(label);
    try {
      if (accEmail.trim() && accPassword) {
        await saveAccountSession({ email: accEmail, password: accPassword, region: accRegion });
        if (mode !== "static") setAccPassword("");
      }
      const creds = await getAccountCredentials();
      setAccReady(Boolean(creds));
      if (!creds) throw new Error(t("cloud.needSettings"));
      const msg = await fn(creds);
      setAccMsg(msg);
    } catch (e) {
      setAccError(cloudErrorMessage(e, t));
    } finally {
      setAccBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("settings.title")}
        description={t("settings.desc")}
        actions={
          mode !== "static" ? (
            <Button variant="secondary" size="sm" onClick={() => void doLogout()}>
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              {t("settings.logout")}
            </Button>
          ) : null
        }
      />

      <div className="space-y-4">
        <Panel title={t("settings.account")}>
          <p className="mb-3 text-sm text-ink-muted">{t(mode === "static" ? "settings.accountHint" : "settings.accountHostHint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("cloud.email")} htmlFor="acc-email">
              <TextInput
                id="acc-email"
                type="email"
                autoComplete="username"
                value={accEmail}
                onChange={(e) => setAccEmail(e.target.value)}
              />
            </Field>
            <Field label={t("cloud.password")} htmlFor="acc-pass">
              <TextInput
                id="acc-pass"
                type="password"
                autoComplete="current-password"
                value={accPassword}
                onChange={(e) => setAccPassword(e.target.value)}
                placeholder={t(mode === "static" ? "cloud.passwordHint" : "settings.accountHostPassword")}
              />
            </Field>
            <Field label={t("cloud.region")} htmlFor="acc-region">
              <Select
                id="acc-region"
                value={accRegion}
                onChange={(e) =>
                  setAccRegion(
                    e.target.value === "international"
                      ? "international"
                      : "china",
                  )
                }
              >
                <option value="china">{t("cloud.regionCn")}</option>
                <option value="international">{t("cloud.regionIntl")}</option>
              </Select>
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <StatusPill tone={accReady ? "green" : "neutral"}>
                {accReady
                  ? t(mode === "static" ? "settings.accountSessionOn" : "settings.accountHostOn")
                  : t(mode === "static" ? "settings.accountSessionOff" : "settings.accountHostOff")}
              </StatusPill>
            </div>
          </div>
          {accError ? (
            <Alert tone="red" className="mt-3">
              {accError}
            </Alert>
          ) : null}
          {accMsg ? (
            <Alert tone="green" className="mt-3">
              {accMsg}
            </Alert>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={accBusy != null} onClick={() => void saveAccount()}>
              {accBusy === "login" ? t("common.loading") : t(mode === "static" ? "settings.accountSave" : "settings.accountHostSave")}
            </Button>
            <Button size="sm" variant="secondary" disabled={accBusy != null} onClick={() => void clearAccount()}>
              {t(mode === "static" ? "settings.accountClear" : "settings.accountHostClear")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={accBusy != null}
              onClick={() =>
                void runAccountAction("recipes", async (creds) => {
                  const result = await syncAccountCatalog({
                    email: creds.email,
                    password: creds.password,
                    region: creds.region,
                    languageType: creds.languageType,
                  });
                  const imported = importCloudSyncTargets(
                    result.targets,
                    result.region,
                  );
                  const total = imported.stats.reduce(
                    (s, x) => s + x.imported,
                    0,
                  );
                  const candidates = imported.stats.reduce(
                    (s, x) => s + x.candidates,
                    0,
                  );
                  return t("cloud.syncDone")
                    .replace("{imported}", String(total))
                    .replace("{candidates}", String(candidates))
                    .replace("{region}", result.region);
                })
              }
            >
              <Cloud className="h-3.5 w-3.5" aria-hidden />
              {accBusy === "recipes"
                ? t("common.loading")
                : t("settings.syncRecipes")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={accBusy != null}
              onClick={() =>
                void runAccountAction("history", async (creds) => {
                  const result = await fetchCloudBrewRecords({
                    email: creds.email,
                    password: creds.password,
                    region: creds.region,
                    languageType: creds.languageType,
                  });
                  const merged = importCloudBrewRecords(
                    result.records,
                    result.region,
                  );
                  return t("history.syncDone")
                    .replace("{count}", String(result.count))
                    .replace("{imported}", String(merged.imported))
                    .replace("{updated}", String(merged.updated))
                    .replace("{region}", result.region);
                })
              }
            >
              <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
              {accBusy === "history"
                ? t("common.loading")
                : t("settings.syncHistory")}
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            {t("settings.accountActionsHint")}{" "}
            <Link to="/recipes" className="text-brand hover:underline">
              {t("nav.recipes")}
            </Link>
            {" · "}
            <Link to="/history" className="text-brand hover:underline">
              {t("nav.history")}
            </Link>
          </p>
        </Panel>

        <Panel title={t("settings.language")}>
          <div className="flex flex-wrap gap-2">
            {locales.map((code) => (
              <Button
                key={code}
                size="sm"
                variant={locale === code ? "primary" : "secondary"}
                onClick={() => setLocale(code as Locale)}
              >
                {localeLabels[code]}
              </Button>
            ))}
          </div>
        </Panel>

        <Panel title={t("settings.ai")}>
          <p className="mb-3 text-sm text-ink-muted">{t("settings.aiHint")}</p>
          <div className="space-y-3">
            <Field label={t("settings.baseUrl")} htmlFor="ai-base">
              <TextInput
                id="ai-base"
                value={aiForm.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(e) =>
                  setAiForm((s) => ({ ...s, baseUrl: e.target.value }))
                }
                autoComplete="off"
              />
            </Field>
            <Field label={t("settings.apiKey")} htmlFor="ai-key">
              <TextInput
                id="ai-key"
                type="password"
                value={aiForm.apiKey}
                placeholder="sk-..."
                onChange={(e) =>
                  setAiForm((s) => ({ ...s, apiKey: e.target.value }))
                }
                autoComplete="off"
              />
            </Field>
            <Field label={t("settings.model")} htmlFor="ai-model">
              <TextInput
                id="ai-model"
                value={aiForm.model}
                placeholder="gpt-4o-mini"
                onChange={(e) =>
                  setAiForm((s) => ({ ...s, model: e.target.value }))
                }
                autoComplete="off"
              />
            </Field>
            {aiMsg ? <Alert tone="green">{aiMsg}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  writeAiConfig(aiForm);
                  setAiForm(readAiConfig());
                  setAiMsg(t("settings.aiSaved"));
                }}
              >
                {t("settings.saveAi")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  clearAiConfig();
                  setAiForm(readAiConfig());
                  setAiMsg(null);
                }}
              >
                {t("settings.clearAi")}
              </Button>
              <StatusPill tone={isAiConfigured(aiForm) ? "green" : "neutral"}>
                {isAiConfigured(aiForm)
                  ? t("settings.configured")
                  : t("settings.notSet")}
              </StatusPill>
            </div>
          </div>
        </Panel>

        <Panel title={t("settings.driver")}>
          <p className="mb-3 text-sm text-ink-muted">{t("settings.driverHint")}</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                {
                  id: "bridge" as MachineDriver,
                  label: t("settings.bridge"),
                },
                {
                  id: "web-bluetooth" as MachineDriver,
                  label: t("settings.webBle"),
                },
              ] as const
            ).map((opt) => {
              const active = driver === opt.id;
              return (
                <Button
                  key={opt.id}
                  size="sm"
                  variant={active ? "primary" : "secondary"}
                  onClick={() => setDriver(opt.id)}
                >
                  {opt.label}
                </Button>
              );
            })}
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <Row label={t("settings.activeDriver")} value={driver} />
            <Row
              label={t("settings.webBleAvail")}
              value={
                webBluetooth.usable
                  ? t("settings.available")
                  : webBluetooth.reason ?? t("settings.unavailable")
              }
            />
            <Row
              label={t("settings.bleSession")}
              value={tPhase(bleSnapshot.phase)}
            />
            <Row
              label={t("dashboard.device")}
              value={
                bleSnapshot.deviceName ||
                bleSnapshot.deviceId ||
                (driver === "web-bluetooth"
                  ? t("dashboard.notConnected")
                  : "—")
              }
            />
            <Row
              label={t("dashboard.phase")}
              value={
                bleSnapshot.machineStateName
                  ? tStatus(bleSnapshot.machineStateName)
                  : "—"
              }
            />
            <Row
              label={t("dashboard.cup")}
              value={
                bleSnapshot.cupWeightG != null
                  ? `${bleSnapshot.cupWeightG} g`
                  : "—"
              }
            />
            <Row
              label={t("dashboard.water")}
              value={
                bleSnapshot.dispensedWaterMl != null
                  ? `${bleSnapshot.dispensedWaterMl} ml`
                  : "—"
              }
            />
          </dl>
          {driver === "web-bluetooth" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {bleSnapshot.phase === "connecting" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bleBusy}
                  onClick={() => {
                    bleSession.abortConnect();
                    setBleBusy(false);
                    setBleActionError(null);
                  }}
                >
                  {t("settings.cancelConnecting")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={bleBusy}
                  onClick={() => {
                    // Saved pair reconnects without picker; first pair needs chooser.
                    setBleActionError(null);
                    setBleBusy(true);
                    void connectBle()
                      .catch((e) =>
                        setBleActionError(
                          e instanceof Error ? e.message : String(e),
                        ),
                      )
                      .finally(() => setBleBusy(false));
                  }}
                >
                  <Bluetooth className="h-3.5 w-3.5" aria-hidden />
                  {bleSnapshot.phase === "connected"
                    ? t("settings.reconnect")
                    : bleSnapshot.hasPairedDevice
                      ? t("dashboard.connectRemembered")
                      : t("settings.connect")}
                </Button>
              )}
              {bleSnapshot.hasPairedDevice &&
              bleSnapshot.phase !== "connecting" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bleBusy}
                  onClick={() => {
                    setBleActionError(null);
                    setBleBusy(true);
                    void connectBle({ forcePicker: true })
                      .catch((e) =>
                        setBleActionError(
                          e instanceof Error ? e.message : String(e),
                        ),
                      )
                      .finally(() => setBleBusy(false));
                  }}
                >
                  {t("dashboard.pickOtherDevice")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  bleBusy ||
                  bleSnapshot.phase === "idle" ||
                  bleSnapshot.phase === "disconnected" ||
                  bleSnapshot.phase === "connecting"
                }
                onClick={() => {
                  setBleBusy(true);
                  setBleActionError(null);
                  void disconnectBle()
                    .catch((e) =>
                      setBleActionError(
                        e instanceof Error ? e.message : String(e),
                      ),
                    )
                    .finally(() => setBleBusy(false));
                }}
              >
                {t("settings.disconnect")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={bleBusy || bleSnapshot.phase === "connecting"}
                onClick={() => {
                  setBleBusy(true);
                  setBleActionError(null);
                  void bleSession
                    .forgetDevice()
                    .catch((e) =>
                      setBleActionError(
                        e instanceof Error ? e.message : String(e),
                      ),
                    )
                    .finally(() => setBleBusy(false));
                }}
              >
                {t("settings.forgetDevice")}
              </Button>
            </div>
          ) : null}
          {bleSnapshot.lastError || bleActionError ? (
            <Alert tone="red" className="mt-3">
              {bleActionError ?? bleSnapshot.lastError}
            </Alert>
          ) : null}
          {driver === "web-bluetooth" && !webBluetooth.usable ? (
            <Alert tone="amber" className="mt-3">
              {webBluetooth.reason}
            </Alert>
          ) : null}
          {bleSnapshot.machineInfo?.serialNumber ? (
            <p className="mt-3 text-xs text-ink-muted">
              SN {bleSnapshot.machineInfo.serialNumber}
              {bleSnapshot.machineInfo.firmware
                ? ` · ${bleSnapshot.machineInfo.firmware}`
                : ""}
              {bleSnapshot.machineInfo.weightUnit
                ? ` · ${bleSnapshot.machineInfo.weightUnit}`
                : ""}
              {bleSnapshot.machineInfo.temperatureUnit
                ? ` / ${bleSnapshot.machineInfo.temperatureUnit}`
                : ""}
              {bleSnapshot.machineInfo.waterSource
                ? ` · ${bleSnapshot.machineInfo.waterSource}`
                : ""}
            </p>
          ) : null}
        </Panel>

        {driver === "web-bluetooth" ? (
          <Panel title={t("settings.machine")}>
            <p className="mb-3 text-sm text-ink-muted">
              {t("settings.machineHint")}
            </p>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <Field label={t("settings.weightUnit")}>
                <Select
                  value={weightUnit}
                  onChange={(e) =>
                    setWeightUnit(e.target.value as "ml" | "g" | "oz")
                  }
                  disabled={machineBusy}
                >
                  <option value="g">g</option>
                  <option value="ml">ml</option>
                  <option value="oz">oz</option>
                </Select>
              </Field>
              <Field label={t("settings.tempUnit")}>
                <Select
                  value={tempUnit}
                  onChange={(e) =>
                    setTempUnit(e.target.value as "C" | "F")
                  }
                  disabled={machineBusy}
                >
                  <option value="C">°C</option>
                  <option value="F">°F</option>
                </Select>
              </Field>
              <Field label={t("settings.waterSource")}>
                <Select
                  value={waterSource}
                  onChange={(e) =>
                    setWaterSource(e.target.value as "tank" | "tap")
                  }
                  disabled={machineBusy}
                >
                  <option value="tank">{t("settings.waterTank")}</option>
                  <option value="tap">{t("settings.waterTap")}</option>
                </Select>
              </Field>
              <Field label={t("settings.display")}>
                <Select
                  value={displayLevel}
                  onChange={(e) =>
                    setDisplayLevel(
                      e.target.value as "low" | "medium" | "high",
                    )
                  }
                  disabled={machineBusy}
                >
                  <option value="low">{t("settings.displayLow")}</option>
                  <option value="medium">{t("settings.displayMedium")}</option>
                  <option value="high">{t("settings.displayHigh")}</option>
                </Select>
              </Field>
            </div>
            <Button
              size="sm"
              variant="primary"
              disabled={machineBusy}
              onClick={() => void applyMachineSettings()}
            >
              {machineBusy ? "…" : t("settings.applyMachine")}
            </Button>
            {machineMsg ? (
              <Alert
                tone={machineMsg.startsWith("!") ? "red" : "green"}
                className="mt-3"
              >
                {machineMsg.startsWith("!")
                  ? machineMsg.slice(1)
                  : machineMsg}
              </Alert>
            ) : null}
          </Panel>
        ) : null}

        {driver === "bridge" ? (
          <Panel title={t("settings.bridgeStatus")}>
            <p className="mb-3 text-sm text-ink-muted">
              {t("settings.bridgeHint")}
            </p>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusPill
                tone={
                  bridgeSnap?.reachable === true
                    ? "green"
                    : bridgeSnap?.reachable === false
                      ? "red"
                      : "neutral"
                }
              >
                {bridgeSnap?.reachable === true
                  ? t("settings.bridgeOnline")
                  : bridgeSnap?.reachable === false
                    ? t("settings.bridgeOffline")
                    : "—"}
              </StatusPill>
              <Button
                size="sm"
                variant="secondary"
                disabled={bridgeBusy}
                onClick={() => void refreshBridge()}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                {t("settings.bridgeRefresh")}
              </Button>
            </div>
            {bridgeSnap?.detail ? (
              <p className="text-xs text-ink-faint">{bridgeSnap.detail}</p>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">
              <Link to="/" className="text-brand hover:underline">
                {t("nav.dashboard")}
              </Link>
            </p>
          </Panel>
        ) : null}

        <Panel title={t("settings.host")}>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row label={t("settings.hostMode")} value={mode ?? "-"} />
            <Row
              label={t("settings.pairingRequired")}
              value={config?.pairing_required ? t("settings.yes") : t("settings.no")}
            />
            <Row
              label={t("settings.publicOrigin")}
              value={config?.public_origin ?? "-"}
            />
            <Row
              label={t("settings.sessionTtl")}
              value={
                config ? `${Math.round(config.session_ttl_s / 3600)} h` : "-"
              }
            />
            <Row
              label={t("settings.thisSession")}
              value={
                session
                  ? `${session.client_label || t("settings.unnamedDevice")} | ${shortId(session.session_id, 10)}`
                  : mode === "loopback"
                    ? t("settings.loopbackNoGate")
                    : "-"
              }
            />
            {session?.expires_at != null ? (
              <Row
                label={t("settings.sessionExpires")}
                value={formatEpochSeconds(session.expires_at)}
              />
            ) : null}
          </dl>
        </Panel>

        <Panel
          title={t("settings.pairingTitle")}
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={pairingBusy}
              onClick={() => void createPairing()}
            >
              {pairingBusy ? t("settings.pairingCreating") : t("settings.pairingCreate")}
            </Button>
          }
        >
          <p className="mb-3 text-sm text-ink-muted">
            {t("settings.pairingHint")}
          </p>
          <Field label={t("settings.pairingLabelField")} htmlFor="pair-new-label">
            <TextInput
              id="pair-new-label"
              value={pairingLabel}
              maxLength={128}
              placeholder={t("settings.pairingLabelPlaceholder")}
              onChange={(e) => setPairingLabel(e.target.value)}
              disabled={pairingBusy}
            />
          </Field>
          {pairingError ? (
            <Alert tone="red" className="mt-3">
              {pairingError}
            </Alert>
          ) : null}
          {pairing ? (
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="rounded-2xl border border-line bg-surface-2 p-3">
                <QRCodeSVG
                  value={pairing.pairing_url}
                  size={148}
                  level="M"
                  includeMargin={false}
                  aria-label="Pairing QR code"
                />
              </div>
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={expired ? "red" : "amber"}>
                    {expired
                      ? t("settings.pairingExpired")
                      : t("settings.pairingExpiresIn").replace("{time}", expiryLabel ?? "")}
                  </StatusPill>
                  <StatusPill tone="neutral">
                    TTL ~{config?.pairing_ttl_s ?? 300}s
                  </StatusPill>
                </div>
                <div className="break-all rounded-xl border border-line bg-surface-2 px-2.5 py-2 font-mono text-xs text-ink">
                  {pairing.pairing_url}
                </div>
                <p className="text-xs text-ink-faint">
                  {t("settings.pairingSingleUse").replace(
                    "{id}",
                    shortId(pairing.pairing_id, 12),
                  )}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPairing(null)}
                >
                  {t("settings.dismiss")}
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel
          title={t("settings.sessionsTitle")}
          action={
            <IconButton label={t("settings.sessionsRefresh")} onClick={() => void loadSessions()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
            </IconButton>
          }
        >
          {sessionsError ? (
            <Alert tone="red" className="mb-3">
              {sessionsError}
            </Alert>
          ) : null}
          {loadingSessions ? (
            <Spinner label={t("common.loading")} />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("settings.sessionsEmpty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {sessions.map((s) => (
                <li
                  key={s.session_id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                      <span className="font-medium">
                        {s.client_label || t("settings.unnamedDevice")}
                      </span>
                      {s.current ? (
                        <StatusPill tone="green">{t("settings.currentSession")}</StatusPill>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-faint">
                      {shortId(s.session_id, 12)}
                      {s.client_ip ? ` | ${s.client_ip}` : ""}
                      {s.expires_at != null
                        ? ` | ${formatEpochSeconds(s.expires_at)}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void revoke(s.session_id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("settings.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="text-xs text-ink-faint">
          <button
            type="button"
            className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50"
            onClick={() => void refresh()}
          >
            {t("settings.refreshAuth")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink">{value}</dd>
    </div>
  );
}
