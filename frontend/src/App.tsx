import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { AppShell } from "./components/AppShell";
import { Alert, Button, Spinner } from "./components/ui";
import Dashboard from "./pages/Dashboard";
import Design from "./pages/Design";
import History from "./pages/History";
import Pair from "./pages/Pair";
import Recipes from "./pages/Recipes";
import Settings from "./pages/Settings";
import Tools from "./pages/Tools";

export default function App() {
  const { status, error, mode, refresh } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Starting xBloom Studio" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col justify-center px-4">
        <div className="mb-4 text-center">
          <div className="text-sm font-semibold text-ink">xBloom Studio</div>
          <p className="mt-1 text-xs text-ink-muted">Could not reach the host</p>
        </div>
        <Alert tone="red">{error ?? "Unknown auth bootstrap error"}</Alert>
        <div className="mt-4">
          <Button variant="primary" className="w-full" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Unauthenticated LAN: focused pairing screen only (no app shell).
  if (status === "needs_pairing") {
    return (
      <div className="min-h-full bg-paper">
        <Routes>
          <Route path="/pair" element={<Pair />} />
          <Route path="*" element={<UnauthenticatedGate mode={mode} />} />
        </Routes>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/pair" element={<Pair />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/design" element={<Design />} />
        <Route path="/recipes" element={<Recipes />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/history" element={<History />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/catalog" element={<Navigate to="/recipes" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function UnauthenticatedGate({
  mode,
}: {
  mode: "loopback" | "lan" | "static" | null;
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-10">
      <img
        src={`${import.meta.env.BASE_URL}studio-machine.png`}
        alt=""
        className="mx-auto mb-5 h-24 w-auto opacity-85"
        draggable={false}
      />
      <h1 className="text-center text-lg font-semibold text-ink">xBloom Studio</h1>
      <p className="mt-1 text-center text-sm text-ink-muted">
        {mode === "lan"
          ? "This host requires pairing. Open a one-time pairing link from a trusted device."
          : "Authentication required."}
      </p>
      <div className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-ink-muted">
        <p>
          Create a pairing link from Settings on a trusted machine, then open it
          on this device.
        </p>
      </div>
    </div>
  );
}
