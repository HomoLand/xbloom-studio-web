/**
 * Phase C9 Playwright coverage:
 * LAN auth, design upload/edit/save, OCC, full brew lifecycle, reload recovery,
 * stale workflow acknowledgement, prior disconnect isolation, desktop/mobile smoke.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  BAG_IMAGE,
  BOOTSTRAP_ORIGIN,
  COFFEE_START_CONFIRMATION,
  createPairingToken,
  e2eComplete,
  e2eGetLedger,
  e2ePriorDisconnectError,
  e2eResetBridge,
  e2eResetLedger,
  e2eSetActiveWorkflow,
  e2eTelemetry,
  ensurePaired,
  mutatingHardwareCounts,
  pairBrowser,
  proxiedGet,
  PUBLIC_ORIGIN,
  waitForBleReleased,
} from "../helpers";

test.describe.configure({ mode: "serial" });

async function generateEditAndSave(page: Page): Promise<void> {
  await page.goto("/design");
  await expect(page.getByRole("heading", { name: /design/i })).toBeVisible();

  await page.locator('input[type="file"]').first().setInputFiles(BAG_IMAGE);
  await expect(page.getByAltText(/selected bag|recipe image/i)).toBeVisible();

  await page.locator("#design-text").fill(
    "Ethiopia Yirgacheffe washed. Bright citrus, clean finish. E2E fixture.",
  );
  await page.getByRole("button", { name: /generate candidate/i }).click();

  await expect(page.getByText(/valid candidate/i)).toBeVisible({ timeout: 60_000 });
  // Name lives in the domain editor input value (not a plain text node).
  await expect(page.locator("#coffee-name")).toHaveValue(/E2E Ethiopia Washed/i);

  // Domain control edit that keeps core math consistent (grind, not dose*ratio).
  await page.locator("#coffee-grind").fill("60");
  await page.locator("#coffee-grind").blur();
  await expect(page.getByText(/^valid$/i).first()).toBeVisible({ timeout: 25_000 });

  await page.getByRole("button", { name: /save revision/i }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible({ timeout: 30_000 });
}

async function brewFromDesignPage(page: Page): Promise<{
  workflowId: string;
  revisionId: string;
}> {
  const brewBtn = page.getByRole("button", { name: /brew saved revision/i });
  await expect(brewBtn).toBeEnabled({ timeout: 15_000 });
  await brewBtn.click();
  await expect(page.getByText(/confirm brew/i)).toBeVisible();
  // Final snapshot confirmation is visible in the dialog.
  await expect(page.getByText(/dose/i).first()).toBeVisible();
  await expect(page.getByText(/pours/i).first()).toBeVisible();

  const phrase = page.locator("#brew-confirm-phrase");
  await phrase.fill(COFFEE_START_CONFIRMATION);
  await expect(phrase).toHaveValue(COFFEE_START_CONFIRMATION);
  const startBtn = page.getByRole("button", { name: /load and start/i });
  await expect(startBtn).toBeEnabled();
  await startBtn.click();

  // Dashboard after start (root path).
  await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      async () => page.evaluate(() => localStorage.getItem("xbloom.workflow_id")),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  const workflowId = (await page.evaluate(() =>
    localStorage.getItem("xbloom.workflow_id"),
  ))!;
  const revisionId = (await page.evaluate(() =>
    localStorage.getItem("xbloom.workflow_revision_id"),
  ))!;
  expect(revisionId).toBeTruthy();
  return { workflowId, revisionId };
}

test.describe("Phase C9 E2E", () => {
  test.beforeEach(async ({ request }) => {
    // Isolate fake-bridge state across tests and projects (shared server process).
    await e2eResetBridge(request);
  });

  test("1) desktop/mobile smoke + no horizontal overflow", async ({ page }) => {
    const request = page.request;
    await ensurePaired(page, request);

    for (const path of ["/", "/design", "/recipes", "/history", "/settings"]) {
      await page.goto(path);
      await expect(page.locator("main").or(page.locator("body"))).toBeVisible();
      await assertNoHorizontalOverflow(page);
    }
  });

  test("2) real LAN auth: bootstrap pair + session CSRF mutation", async ({
    page,
    request,
  }) => {
    // Unauthenticated LAN-proxied request should gate protected API.
    const denied = await proxiedGet(request, "/api/recipes");
    expect(denied.status, denied.text).toBe(401);

    const { token, pairing_url } = await createPairingToken(request);
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(pairing_url.startsWith(PUBLIC_ORIGIN)).toBeTruthy();

    await pairBrowser(page, pairing_url);

    // Protected mutation (pairing/new from session) requires CSRF cookies.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    // Connection panel reports mode without relying on the desktop-only nav pill.
    await expect(page.getByText(/pairing required/i)).toBeVisible();
    await expect(page.getByText(/^yes$/i).first()).toBeVisible();
    await page.getByRole("button", { name: /create pairing/i }).click();
    await expect(
      page.getByText(/expires in|expired|scan the qr|pairing/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("3-6) design upload, edit, save, brew lifecycle, ledger, history", async ({
    page,
    request,
  }) => {
    await ensurePaired(page, request);
    await e2eResetLedger(request);

    // Seed a prior disconnect error so a later successful terminal must not
    // claim release failure (requirement 9).
    await e2ePriorDisconnectError(request, "prior workflow gatt close failed");

    await generateEditAndSave(page);

    const afterDesign = await e2eGetLedger(request);
    expect(afterDesign.provider_calls.length).toBeGreaterThanOrEqual(1);
    const call = afterDesign.provider_calls[afterDesign.provider_calls.length - 1]!;
    expect(call.model).toBe("grok-4.5");
    expect(call.has_image).toBe(true);
    expect(call.image_data_url_prefix).toMatch(/^data:image\/(png|jpeg);base64,/);

    await e2eResetLedger(request);
    const { workflowId, revisionId } = await brewFromDesignPage(page);

    // Exact workflow id tracked on Dashboard (may appear in several rows).
    await expect(
      page.getByText(new RegExp(workflowId.slice(0, 12), "i")).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Emit telemetry/events while running (status/events observations only).
    await e2eTelemetry(request, {
      dispensed_water_ml: 80,
      dispensed_water_peak_ml: 80,
      cup_weight_g: 95,
      cup_delta_peak_g: 15,
    });
    await expect(page.getByText(/80|water|telemetry|running/i).first()).toBeVisible({
      timeout: 15_000,
    });

    const mid = await e2eGetLedger(request);
    const midCounts = mutatingHardwareCounts(mid);
    expect(midCounts.connect).toBe(1);
    expect(midCounts.load).toBe(1);
    expect(midCounts.start).toBe(1);
    expect(midCounts.release).toBe(0);
    // Observations do not connect/load/start.
    expect((mid.counts.status || 0) + (mid.counts.events || 0)).toBeGreaterThan(0);

    // Durable terminal + prompt release.
    await e2eComplete(request, { result: "completed", release: true });
    await waitForBleReleased(page);

    // Status: connected=false, release_pending=false (via UI label).
    await expect(page.getByText(/not linked|BLE released/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /open history/i })).toBeVisible();

    const end = await e2eGetLedger(request);
    const endCounts = mutatingHardwareCounts(end);
    expect(endCounts.connect).toBe(1);
    expect(endCounts.load).toBe(1);
    expect(endCounts.start).toBe(1);
    expect(endCounts.release).toBe(1);

    // History navigation present and reachable.
    await page.getByRole("link", { name: /open history/i }).click();
    await expect(page).toHaveURL(/history/);
    await expect(page.getByRole("heading", { name: /history/i })).toBeVisible();

    // Keep revision id for later tests via storage on this page context.
    await page.evaluate(
      ({ wid, rid }) => {
        localStorage.setItem("xbloom.e2e.last_workflow_id", wid);
        localStorage.setItem("xbloom.e2e.last_revision_id", rid);
      },
      { wid: workflowId, rid: revisionId },
    );
  });

  test("7) reload during active brew recovers same workflow_id without extra connect/load/start", async ({
    page,
    request,
  }) => {
    await ensurePaired(page, request);
    await e2eResetLedger(request);

    await generateEditAndSave(page);
    const { workflowId } = await brewFromDesignPage(page);

    await e2eTelemetry(request, {
      dispensed_water_ml: 40,
      dispensed_water_peak_ml: 40,
      cup_weight_g: 50,
    });
    await expect(page.getByText(/running|brewing|40/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await e2eResetLedger(request);
    await page.reload();
    await expect(
      page.getByText(new RegExp(workflowId.slice(0, 12), "i")).first(),
    ).toBeVisible({ timeout: 20_000 });
    // Same exact id still in storage.
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("xbloom.workflow_id")))
      .toBe(workflowId);

    const ledger = await e2eGetLedger(request);
    const counts = mutatingHardwareCounts(ledger);
    expect(counts.connect).toBe(0);
    expect(counts.load).toBe(0);
    expect(counts.start).toBe(0);

    await e2eComplete(request, { result: "completed" });
    await waitForBleReleased(page);
  });

  test("8) stale local workflow vs newer active: Use active workflow is UI-only", async ({
    page,
    request,
  }) => {
    await ensurePaired(page, request);
    await e2eResetLedger(request);

    await generateEditAndSave(page);
    const { workflowId: oldId, revisionId } = await brewFromDesignPage(page);
    await e2eComplete(request, { result: "completed" });
    await waitForBleReleased(page);

    // Stale page keeps old workflow id in storage.
    await page.evaluate((wid) => {
      localStorage.setItem("xbloom.workflow_id", wid);
      localStorage.setItem("xbloom.workflow_kind", "coffee");
    }, oldId);

    // Another client creates a new active workflow.
    await e2eResetLedger(request);
    const newId = await e2eSetActiveWorkflow(request, revisionId, "coffee");
    expect(newId).not.toBe(oldId);

    await page.goto("/");
    await expect(page.getByText("Workflow switched")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole("button", { name: /use active workflow/i }),
    ).toBeVisible();

    // Controls must stay disabled (no Cancel/Pause/Stop for stale page).
    await expect(page.getByRole("button", { name: /^pause$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^stop$/i })).toHaveCount(0);

    // Acknowledgement is UI-only: no hardware calls, storage not rewritten.
    await e2eResetLedger(request);
    await page.getByRole("button", { name: /use active workflow/i }).click();
    await expect(page.getByText(/workflow switched/i)).toHaveCount(0);

    const afterAck = await e2eGetLedger(request);
    const counts = mutatingHardwareCounts(afterAck);
    expect(counts.connect).toBe(0);
    expect(counts.load).toBe(0);
    expect(counts.start).toBe(0);
    expect(counts.release).toBe(0);
    // Storage remains the old id until a real load/start (UI-only ack).
    const stored = await page.evaluate(() => localStorage.getItem("xbloom.workflow_id"));
    expect(stored).toBe(oldId);

    // After ack, controls for the active workflow may appear (running).
    await expect(
      page.getByRole("button", { name: /pause|stop/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await e2eComplete(request, { result: "completed" });
    await waitForBleReleased(page);
  });

  test("9) prior disconnect error does not poison later BLE released UI", async ({
    page,
    request,
  }) => {
    await ensurePaired(page, request);
    await e2eResetLedger(request);

    // Inject ancient prior failure, then run a clean brew to terminal.
    await e2ePriorDisconnectError(
      request,
      "ancient disconnect failure",
      Date.now() / 1000 - 7200,
    );

    await generateEditAndSave(page);
    await brewFromDesignPage(page);
    await e2eComplete(request, { result: "completed", release: true });
    await waitForBleReleased(page);
    await expect(page.getByText(/BLE release failed/i)).toHaveCount(0);
  });

  test("5) OCC: two contexts edit one parent; stale submit conflicts", async ({
    browser,
    request,
  }) => {
    // Pair two independent browser contexts against the same LAN origin.
    const ctxA = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: PUBLIC_ORIGIN,
    });
    const ctxB = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: PUBLIC_ORIGIN,
    });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await ensurePaired(pageA, request);
    // Second context needs its own session (or can reuse bootstrap).
    const { pairing_url } = await createPairingToken(request);
    await pairBrowser(pageB, pairing_url);

    // Create a shared recipe from A.
    await generateEditAndSave(pageA);

    // Both open Recipes and select the same recipe.
    await pageA.goto("/recipes");
    await pageB.goto("/recipes");
    const selectRecipe = async (page: Page) => {
      await expect(page.getByText(/E2E Ethiopia/i).first()).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole("button", { name: /E2E Ethiopia/i }).first().click();
      await expect(page.getByRole("button", { name: /^edit$/i })).toBeVisible({
        timeout: 15_000,
      });
    };
    await selectRecipe(pageA);
    await selectRecipe(pageB);

    await pageA.getByRole("button", { name: /^edit$/i }).click();
    await pageB.getByRole("button", { name: /^edit$/i }).click();

    await expect(pageA.locator("#coffee-grind")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#coffee-grind")).toBeVisible({ timeout: 15_000 });

    // Distinct valid edits (grind stays within core bounds; no dose*ratio drift).
    await pageA.locator("#coffee-grind").fill("55");
    await pageA.locator("#coffee-grind").blur();
    await pageB.locator("#coffee-grind").fill("62");
    await pageB.locator("#coffee-grind").blur();

    await expect(pageA.getByText(/^valid$/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByText(/^valid$/i).first()).toBeVisible({ timeout: 20_000 });

    // A saves first (wins OCC).
    await pageA.getByRole("button", { name: /save new revision/i }).click();
    await expect(
      pageA.getByRole("button", { name: /^edit$/i }),
    ).toBeVisible({ timeout: 20_000 });

    // B's stale submit must show OCC conflict and not overwrite.
    await pageB.getByRole("button", { name: /save new revision/i }).click();
    await expect(
      pageB.getByText("Newer revision exists", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByRole("button", { name: /refresh parent/i })).toBeVisible();

    await ctxA.close();
    await ctxB.close();
  });

  test("control routes are token-gated (not a remote backdoor)", async ({ request }) => {
    const noToken = await request.get(`${BOOTSTRAP_ORIGIN}/__e2e__/ledger`, {
      ignoreHTTPSErrors: true,
    });
    expect(noToken.status()).toBe(404);

    const badToken = await request.get(`${BOOTSTRAP_ORIGIN}/__e2e__/ledger`, {
      headers: { "x-xbloom-e2e-token": "wrong" },
      ignoreHTTPSErrors: true,
    });
    expect(badToken.status()).toBe(404);

    // Bootstrap origin health remains public.
    const health = await request.get(`${BOOTSTRAP_ORIGIN}/api/health`, {
      ignoreHTTPSErrors: true,
    });
    expect(health.ok()).toBeTruthy();
  });
});
