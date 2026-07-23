import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth/AuthContext";
import { Alert, Button, Field, TextInput } from "../components/ui";

export default function Pair() {
  const navigate = useNavigate();
  const { refresh, markAuthenticated, status } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const t = params.get("token")?.trim() || "";
    // Clear fragment immediately so the secret does not linger in the address bar.
    if (window.location.hash) {
      const clean = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, "", clean);
    }
    if (!t) {
      setMissing(true);
      setToken(null);
      return;
    }
    setToken(t);
    setMissing(false);
  }, []);

  useEffect(() => {
    // Already-ready authenticated user: leave /pair (loopback and LAN).
    if (status === "ready") {
      navigate("/", { replace: true });
    }
  }, [status, navigate]);

  const canSubmit = useMemo(
    () => !!token && token.length >= 16 && !busy,
    [token, busy],
  );

  const submit = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.pair(token, label);
      markAuthenticated({
        session_id: result.session_id,
        expires_at: result.expires_at,
        client_label: result.client_label,
        current: true,
      });
      await refresh();
      navigate("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "pairing_rate_limited") {
          setError("Too many invalid attempts. Wait and try a fresh pairing link.");
        } else if (e.code === "pairing_invalid") {
          setError("Pairing token is invalid or already used. Create a new one on a trusted device.");
        } else {
          setError(e.message);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-1">
      <div className="mb-6 text-center">
        <img
          src="/studio-machine.png"
          alt=""
          className="mx-auto mb-4 h-24 w-auto opacity-85"
          draggable={false}
        />
        <h1 className="text-lg font-semibold text-ink">Pair this device</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Exchange a one-time pairing link for a session on this host.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface p-4 space-y-4">
        {missing ? (
          <Alert tone="amber" title="No pairing token">
            Open a pairing link from Settings on a trusted machine, or paste a
            fresh link into this browser.
          </Alert>
        ) : (
          <Alert tone="blue" title="Token ready">
            Label this browser, then pair.
          </Alert>
        )}

        {error ? <Alert tone="red">{error}</Alert> : null}

        <Field label="Device label" htmlFor="pair-label" hint="Shown in the sessions list">
          <TextInput
            id="pair-label"
            value={label}
            maxLength={128}
            placeholder="Kitchen tablet"
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
        </Field>

        <Button
          variant="primary"
          className="w-full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? "Pairing..." : "Pair device"}
        </Button>
      </div>
    </div>
  );
}
