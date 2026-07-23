/**
 * Shared Phase C9 E2E helpers: control ledger, pairing, and UI waits.
 * Talks to real FastAPI routes + test-only /__e2e__ (token-gated).
 */

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const E2E_PORT = Number(process.env.XBLOOM_E2E_PORT || "18901");
export const E2E_TOKEN = process.env.XBLOOM_E2E_TOKEN || "e2e-local-token-phase-c9";
export const E2E_PUBLIC_HOST = process.env.XBLOOM_E2E_PUBLIC_HOST || "studio.e2e.local";
export const PUBLIC_ORIGIN =
  process.env.XBLOOM_E2E_PUBLIC_ORIGIN || `https://${E2E_PUBLIC_HOST}:${E2E_PORT}`;
export const BOOTSTRAP_ORIGIN =
  process.env.XBLOOM_E2E_BOOTSTRAP_ORIGIN || `https://127.0.0.1:${E2E_PORT}`;

export const BAG_IMAGE = path.join(__dirname, "fixtures", "bag.png");
export const COFFEE_START_CONFIRMATION = "cup-filter-water-beans";

const E2E_TOKEN_HEADERS = {
  "x-xbloom-e2e-token": E2E_TOKEN,
};

/**
 * Node-side APIRequestContext cannot use Chromium host-resolver-rules.
 * Hit 127.0.0.1 with Host=public so the E2E proxy middleware applies LAN
 * reverse-proxy semantics without relying on OS DNS for studio.e2e.local.
 */
function proxiedUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${BOOTSTRAP_ORIGIN}${p}`;
}

function publicHostHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Host: `${E2E_PUBLIC_HOST}:${E2E_PORT}`,
    Origin: PUBLIC_ORIGIN,
    Accept: "application/json",
    ...extra,
  };
}

function jsonHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return publicHostHeaders({
    "Content-Type": "application/json",
    ...extra,
  });
}

export type LedgerSnapshot = {
  ledger: Array<{ op: string; at: number; kwargs: Record<string, unknown> }>;
  counts: Record<string, number>;
  provider_calls: Array<{
    model: string;
    has_image: boolean;
    image_mime: string | null;
    image_data_url_prefix: string | null;
  }>;
};

/** Direct loopback bootstrap (no trusted-proxy headers / Host is 127.0.0.1). */
export async function createPairingToken(
  request: APIRequestContext,
): Promise<{ token: string; pairing_url: string }> {
  const res = await request.post(`${BOOTSTRAP_ORIGIN}/api/auth/pairing/new`, {
    data: { client_label: "playwright-e2e" },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  expect(body.token).toBeTruthy();
  expect(String(body.pairing_url)).toContain(PUBLIC_ORIGIN);
  return { token: body.token as string, pairing_url: body.pairing_url as string };
}

/** Unauthenticated LAN-proxied request (expects 401 on protected routes). */
export async function proxiedGet(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; text: string }> {
  const res = await request.get(proxiedUrl(path), {
    headers: publicHostHeaders(),
    ignoreHTTPSErrors: true,
  });
  return { status: res.status(), text: await res.text() };
}

/** Open pairing URL in browser and complete exchange (session + CSRF cookies). */
export async function pairBrowser(page: Page, pairingUrl: string): Promise<void> {
  await page.goto(pairingUrl);
  await expect(page.getByRole("heading", { name: /pair this device/i })).toBeVisible();
  await page.getByRole("button", { name: /pair device/i }).click();
  // After pair, app shell loads Dashboard.
  await expect(
    page.getByRole("heading", { name: /dashboard|monitor/i }).or(
      page.getByText(/daemon running|bridge/i),
    ).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function ensurePaired(page: Page, request: APIRequestContext): Promise<void> {
  const { pairing_url } = await createPairingToken(request);
  await pairBrowser(page, pairing_url);
}

const E2E_PREFIX = "/__e2e__";

export async function e2eGetLedger(request: APIRequestContext): Promise<LedgerSnapshot> {
  const res = await request.get(proxiedUrl(`${E2E_PREFIX}/ledger`), {
    headers: publicHostHeaders(E2E_TOKEN_HEADERS),
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as LedgerSnapshot;
}

export async function e2eResetLedger(request: APIRequestContext): Promise<void> {
  const res = await request.post(proxiedUrl(`${E2E_PREFIX}/ledger/reset`), {
    headers: jsonHeaders(E2E_TOKEN_HEADERS),
    data: {},
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Clear workflows/connection/ledger so tests do not share hardware state. */
export async function e2eResetBridge(request: APIRequestContext): Promise<void> {
  const res = await request.post(proxiedUrl(`${E2E_PREFIX}/bridge/reset`), {
    headers: jsonHeaders(E2E_TOKEN_HEADERS),
    data: {},
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

export async function e2eComplete(
  request: APIRequestContext,
  body: {
    result?: string;
    release?: boolean;
    release_error?: string | null;
    disconnect_reason?: string;
  } = {},
): Promise<void> {
  const res = await request.post(proxiedUrl(`${E2E_PREFIX}/bridge/complete`), {
    headers: jsonHeaders(E2E_TOKEN_HEADERS),
    data: body,
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

export async function e2eTelemetry(
  request: APIRequestContext,
  telemetry: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(proxiedUrl(`${E2E_PREFIX}/bridge/telemetry`), {
    headers: jsonHeaders(E2E_TOKEN_HEADERS),
    data: { telemetry },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

export async function e2ePriorDisconnectError(
  request: APIRequestContext,
  error: string,
  disconnectTime?: number,
): Promise<void> {
  const res = await request.post(
    proxiedUrl(`${E2E_PREFIX}/bridge/prior-disconnect-error`),
    {
      headers: jsonHeaders(E2E_TOKEN_HEADERS),
      data: {
        error,
        disconnect_time: disconnectTime ?? Date.now() / 1000 - 3600,
      },
      ignoreHTTPSErrors: true,
    },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
}

export async function e2eSetActiveWorkflow(
  request: APIRequestContext,
  recipeRevisionId: string,
  kind = "coffee",
): Promise<string> {
  const res = await request.post(
    proxiedUrl(`${E2E_PREFIX}/bridge/set-active-workflow`),
    {
      headers: jsonHeaders(E2E_TOKEN_HEADERS),
      data: { recipe_revision_id: recipeRevisionId, kind },
      ignoreHTTPSErrors: true,
    },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return String(body.workflow_id);
}

/** Assert no horizontal document overflow (useful mobile smoke). */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });
  expect(
    overflow.scrollWidth,
    `horizontal overflow: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

export function mutatingHardwareCounts(ledger: LedgerSnapshot): {
  connect: number;
  load: number;
  start: number;
  release: number;
} {
  return {
    connect: ledger.counts.connect || 0,
    load: ledger.counts.load || 0,
    start: ledger.counts.start || 0,
    release: ledger.counts.release || 0,
  };
}

export async function waitForBleReleased(page: Page): Promise<void> {
  await expect(page.getByText(/BLE released/i)).toBeVisible({ timeout: 30_000 });
}
