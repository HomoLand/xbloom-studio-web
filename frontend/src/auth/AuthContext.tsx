import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  resetAuthExpiredGuard,
  setAuthExpiredHandler,
  type AuthConfig,
  type AuthSessionResponse,
  type SessionInfo,
} from "../api";
import { isStaticDeploy } from "../lib/deploy";

export type AuthStatus =
  | "loading"
  | "ready" // loopback, or LAN authenticated, or static Pages
  | "needs_pairing" // LAN, no session
  | "error";

type AuthContextValue = {
  status: AuthStatus;
  config: AuthConfig | null;
  session: SessionInfo | null;
  mode: "loopback" | "lan" | "static" | null;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  markAuthenticated: (session: SessionInfo) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [mode, setMode] = useState<"loopback" | "lan" | "static" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Prevent overlapping refresh storms from concurrent 401s. */
  const refreshingRef = useRef(false);

  const applySession = useCallback(
    (cfg: AuthConfig, sess: AuthSessionResponse) => {
      setMode(cfg.mode);
      if (cfg.mode === "loopback" || !cfg.pairing_required) {
        // Loopback enters the app immediately; session may still be present.
        if (sess.authenticated) {
          setSession(sess.session);
        } else {
          setSession(null);
        }
        setStatus("ready");
        return;
      }

      // LAN: gate protected UI on a real session.
      if (sess.authenticated) {
        setSession(sess.session);
        setStatus("ready");
      } else {
        setSession(null);
        setStatus("needs_pairing");
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setError(null);
    try {
      // GitHub Pages / static SPA: no FastAPI host — enter app for Web Bluetooth.
      if (isStaticDeploy()) {
        setConfig(null);
        setSession(null);
        setMode("static");
        setStatus("ready");
        resetAuthExpiredGuard();
        return;
      }

      const cfg = await api.authConfig();
      setConfig(cfg);

      let sess: AuthSessionResponse;
      try {
        sess = await api.authSession();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          sess = { authenticated: false, mode: cfg.mode };
        } else {
          throw e;
        }
      }
      applySession(cfg, sess);
      // Successful auth probe: allow a future 401 to notify again.
      resetAuthExpiredGuard();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshingRef.current = false;
    }
  }, [applySession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // On API 401, refresh once so LAN returns to pairing gate. No request loops.
  useEffect(() => {
    setAuthExpiredHandler(() => {
      void refresh();
    });
    return () => setAuthExpiredHandler(null);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSession(null);
      if (config?.mode === "lan" && config.pairing_required) {
        setStatus("needs_pairing");
      } else {
        setStatus("ready");
      }
      await refresh();
    }
  }, [config, refresh]);

  const markAuthenticated = useCallback((s: SessionInfo) => {
    setSession(s);
    setStatus("ready");
    resetAuthExpiredGuard();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      config,
      session,
      mode,
      error,
      refresh,
      logout,
      markAuthenticated,
    }),
    [status, config, session, mode, error, refresh, logout, markAuthenticated],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
