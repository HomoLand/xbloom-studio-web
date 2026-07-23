import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const backendDir = path.join(repoRoot, "backend");

const E2E_PORT = Number(process.env.XBLOOM_E2E_PORT || "18901");
const E2E_PUBLIC_HOST = process.env.XBLOOM_E2E_PUBLIC_HOST || "studio.e2e.local";
const E2E_TOKEN = process.env.XBLOOM_E2E_TOKEN || "e2e-local-token-phase-c9";
// Independent per-invocation state root so auth/recipe SQLite never leaks across runs.
// Explicit XBLOOM_E2E_STATE_DIR still wins (e.g. debugging a fixed path).
const E2E_STATE_DIR =
  process.env.XBLOOM_E2E_STATE_DIR ||
  path.join(
    os.tmpdir(),
    `xbloom-studio-web-e2e-${process.pid}-${Date.now()}`,
  );

const baseURL = `https://${E2E_PUBLIC_HOST}:${E2E_PORT}`;

// Expose harness env for fixtures (webServer inherits process.env).
process.env.XBLOOM_E2E_PORT = String(E2E_PORT);
process.env.XBLOOM_E2E_TOKEN = E2E_TOKEN;
process.env.XBLOOM_E2E_PUBLIC_HOST = E2E_PUBLIC_HOST;
process.env.XBLOOM_E2E_STATE_DIR = E2E_STATE_DIR;
process.env.XBLOOM_E2E_PUBLIC_ORIGIN = baseURL;
process.env.XBLOOM_E2E_BOOTSTRAP_ORIGIN = `https://127.0.0.1:${E2E_PORT}`;

const python =
  process.env.XBLOOM_E2E_PYTHON ||
  path.join(backendDir, ".venv", "Scripts", "python.exe");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Map public E2E host to loopback without editing system hosts.
    launchOptions: {
      args: [`--host-resolver-rules=MAP ${E2E_PUBLIC_HOST} 127.0.0.1`],
    },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
      },
    },
  ],
  webServer: {
    command: `"${python}" -m e2e.launcher --port ${E2E_PORT} --token ${E2E_TOKEN} --public-host ${E2E_PUBLIC_HOST} --state-dir "${E2E_STATE_DIR}"`,
    cwd: backendDir,
    url: `https://127.0.0.1:${E2E_PORT}/api/health`,
    // Always start a fresh E2E launcher; never attach to a stale service.
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    timeout: 180_000,
    env: {
      ...process.env,
      XBLOOM_E2E_PORT: String(E2E_PORT),
      XBLOOM_E2E_TOKEN: E2E_TOKEN,
      XBLOOM_E2E_PUBLIC_HOST: E2E_PUBLIC_HOST,
      XBLOOM_E2E_STATE_DIR: E2E_STATE_DIR,
      XBLOOM_FRONTEND_DIR: path.join(repoRoot, "frontend", "dist"),
    },
  },
});
