import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { I18nProvider } from "./i18n/I18nContext";
import { isStaticDeploy } from "./lib/deploy";
import { MachineProvider } from "./machine/MachineContext";
import "./index.css";

// HashRouter on static GitHub Pages so deep links work without SPA rewrite rules.
const Router = isStaticDeploy() ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <I18nProvider>
        <AuthProvider>
          <MachineProvider>
            <App />
          </MachineProvider>
        </AuthProvider>
      </I18nProvider>
    </Router>
  </StrictMode>,
);

