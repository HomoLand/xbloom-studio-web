import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Bluetooth, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { api, type PairingNewResult, type SessionInfo } from "../api";
import { useAuth } from "../auth/AuthContext";
import {
  Alert,
  Button,
  Field,
  IconButton,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
  TextInput,
} from "../components/ui";
import {
  formatEpochSeconds,
  formatRemainingFromEpoch,
  isEpochExpired,
  shortId,
} from "../lib/recipeDomain";
import { useMachine } from "../machine/MachineContext";
import type { MachineDriver } from "../machine/driver";

export default function Settings() {
  const { config, session, mode, logout, refresh } = useAuth();
  const {
    driver,
    setDriver,
    webBluetooth,
    bleSnapshot,
    connectBle,
    disconnectBle,
  } = useMachine();
  const [bleBusy, setBleBusy] = useState(false);
  const [bleActionError, setBleActionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingNewResult | null>(null);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadSessions = useCallback(async () => {
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
  }, []);

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

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Machine driver, sessions, pairing, and host mode."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void doLogout()}>
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            Log out
          </Button>
        }
      />

      <div className="space-y-4">
        <Panel title="Machine driver">
          <p className="mb-3 text-sm text-ink-muted">
            Progressive path (ADR-WEB-BLUETOOTH): local Python bridge (legacy) or
            Chrome Web Bluetooth near-field control. When Web Bluetooth is
            available, it is the default for new browsers; bridge remains
            selectable. Coffee load/start/cancel use Web Bluetooth when that
            driver is active (tea still uses bridge).
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                {
                  id: "bridge" as MachineDriver,
                  label: "Bridge (local daemon)",
                },
                {
                  id: "web-bluetooth" as MachineDriver,
                  label: "Web Bluetooth (Chrome)",
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
            <Row label="Active driver" value={driver} />
            <Row
              label="Web Bluetooth"
              value={
                webBluetooth.usable
                  ? "Available"
                  : webBluetooth.reason ?? "Unavailable"
              }
            />
            <Row label="BLE session" value={bleSnapshot.phase} />
            <Row
              label="Device"
              value={
                bleSnapshot.deviceName ||
                bleSnapshot.deviceId ||
                (driver === "web-bluetooth" ? "Not connected" : "—")
              }
            />
            <Row label="Notify frames" value={String(bleSnapshot.notifyCount)} />
            <Row
              label="Machine phase"
              value={bleSnapshot.machineStateName ?? "—"}
            />
            <Row
              label="Cup weight"
              value={
                bleSnapshot.cupWeightG != null
                  ? `${bleSnapshot.cupWeightG} g`
                  : "—"
              }
            />
            <Row
              label="Dispensed water"
              value={
                bleSnapshot.dispensedWaterMl != null
                  ? `${bleSnapshot.dispensedWaterMl} ml`
                  : "—"
              }
            />
          </dl>
          {driver === "web-bluetooth" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={bleBusy || bleSnapshot.phase === "connecting"}
                onClick={() => {
                  setBleBusy(true);
                  setBleActionError(null);
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
                  ? "Reconnect"
                  : "Connect Studio"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  bleBusy ||
                  bleSnapshot.phase === "idle" ||
                  bleSnapshot.phase === "disconnected"
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
                Disconnect
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
        </Panel>

        <Panel title="Host connection">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row label="Mode" value={mode ?? "-"} />
            <Row
              label="Pairing required"
              value={config?.pairing_required ? "Yes" : "No"}
            />
            <Row
              label="Public origin"
              value={config?.public_origin ?? "-"}
            />
            <Row
              label="Session TTL"
              value={
                config ? `${Math.round(config.session_ttl_s / 3600)} h` : "-"
              }
            />
            <Row
              label="This session"
              value={
                session
                  ? `${session.client_label || "unnamed"} | ${shortId(session.session_id, 10)}`
                  : mode === "loopback"
                    ? "Loopback (no session gate)"
                    : "-"
              }
            />
            {session?.expires_at != null ? (
              <Row
                label="Session expires"
                value={formatEpochSeconds(session.expires_at)}
              />
            ) : null}
          </dl>
        </Panel>

        <Panel
          title="One-time pairing"
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={pairingBusy}
              onClick={() => void createPairing()}
            >
              {pairingBusy ? "Creating..." : "Create pairing"}
            </Button>
          }
        >
          <p className="mb-3 text-sm text-ink-muted">
            Generate a short-lived link for another browser. Scan the QR or open
            the URL on the new device.
          </p>
          <Field label="Optional label for the new device" htmlFor="pair-new-label">
            <TextInput
              id="pair-new-label"
              value={pairingLabel}
              maxLength={128}
              placeholder="Living room phone"
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
              <div className="rounded-lg border border-line bg-paper p-3">
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
                    {expired ? "Expired" : `Expires in ${expiryLabel}`}
                  </StatusPill>
                  <StatusPill tone="neutral">
                    TTL ~{config?.pairing_ttl_s ?? 300}s
                  </StatusPill>
                </div>
                <div className="break-all rounded-md border border-line bg-paper px-2.5 py-2 font-mono text-xs text-ink">
                  {pairing.pairing_url}
                </div>
                <p className="text-xs text-ink-faint">
                  Pairing id {shortId(pairing.pairing_id, 12)}. Single-use.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPairing(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel
          title="Sessions"
          action={
            <IconButton label="Refresh sessions" onClick={() => void loadSessions()}>
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
            <Spinner label="Loading sessions" />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-ink-muted">No active sessions listed.</p>
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
                        {s.client_label || "Unnamed device"}
                      </span>
                      {s.current ? <StatusPill tone="green">Current</StatusPill> : null}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-faint">
                      {shortId(s.session_id, 12)}
                      {s.client_ip ? ` | ${s.client_ip}` : ""}
                      {s.expires_at != null
                        ? ` | expires ${formatEpochSeconds(s.expires_at)}`
                        : ""}
                      {s.last_seen_at != null
                        ? ` | last seen ${formatEpochSeconds(s.last_seen_at)}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void revoke(s.session_id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Revoke
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
            Refresh auth state
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
