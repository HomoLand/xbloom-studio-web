/**
 * Golden notify fixtures from packages/core/xbloom_ble (Python-built CRC frames).
 * Run: node --experimental-strip-types --test src/ble/telemetry.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  notificationFrameIsValid,
  NotificationFrameStream,
  parseNotification,
} from "./telemetry.ts";

/** Built with Python crc16_kermit + STATUS_COMMAND 8023. */
const FIXTURES: Record<string, string> = {
  idle: "580207571f0d000000c101d848",
  armed: "580207571f0d000000c11f27b1",
  awaiting: "580207571f0d000000c11eaea0",
  starting: "580207571f0d000000c122415b",
  brewing: "580207571f0d000000c110d049",
  ready: "580207571f0d000000c124773e",
  complete: "580207571f0d000000c141dc0a",
  cup: "580207155010000000c166e6f642def1",
  water: "5802074b9e10000000c100504347abeb",
};

describe("parseNotification status states", () => {
  it("decodes idle/armed/brewing/terminal labels", () => {
    assert.equal(parseNotification(FIXTURES.idle)!.stateName, "idle");
    // Idle-at-rest is not a brew terminal; session decides after active brew.
    assert.equal(parseNotification(FIXTURES.idle)!.isTerminal, false);
    assert.equal(parseNotification(FIXTURES.armed)!.stateName, "armed");
    assert.equal(parseNotification(FIXTURES.armed)!.state, 0x1f);
    assert.equal(parseNotification(FIXTURES.armed)!.isTerminal, false);
    assert.equal(
      parseNotification(FIXTURES.awaiting)!.stateName,
      "awaiting_confirm",
    );
    assert.equal(parseNotification(FIXTURES.starting)!.stateName, "starting");
    assert.equal(parseNotification(FIXTURES.brewing)!.stateName, "brewing");
    assert.equal(parseNotification(FIXTURES.ready)!.stateName, "ready");
    assert.equal(parseNotification(FIXTURES.ready)!.isTerminal, true);
    assert.equal(parseNotification(FIXTURES.complete)!.stateName, "complete");
    assert.equal(parseNotification(FIXTURES.complete)!.isTerminal, true);
  });

  it("rejects invalid CRC", () => {
    const bad = FIXTURES.armed.slice(0, -2) + "0000";
    assert.equal(parseNotification(bad), null);
    assert.equal(notificationFrameIsValid(hex(bad)), false);
  });

  it("maps 0x45 tea soak as active brew (not unknown)", async () => {
    const { STATE_NAMES, isActedBrewState } = await import("./telemetry.ts");
    assert.equal(STATE_NAMES[0x45], "tea_soaking");
    assert.equal(isActedBrewState(0x45), true);
    assert.equal(isActedBrewState(0x10), true);
    assert.equal(isActedBrewState(0x01), false);
  });
});

describe("parseNotification scale/water", () => {
  it("decodes cup weight grams", () => {
    const ev = parseNotification(FIXTURES.cup)!;
    assert.equal(ev.stateName, "cup_weight");
    assert.equal(ev.cupWeightG, 123.45);
  });

  it("decodes dispensed water ml", () => {
    const ev = parseNotification(FIXTURES.water)!;
    assert.equal(ev.stateName, "water_volume");
    assert.equal(ev.dispensedWaterMl, 50);
  });

  it("names FreeSolo-style report ACKs instead of bare unknown", async () => {
    const { REPORT_NAMES } = await import("./telemetry.ts");
    assert.equal(REPORT_NAMES[9005], "brewer_started");
    assert.equal(REPORT_NAMES[9006], "brewer_exited");
    assert.equal(REPORT_NAMES[10507], "scale_weight");
  });
});

describe("NotificationFrameStream", () => {
  it("reassembles split frames and emits complete notify", () => {
    const full = hex(FIXTURES.armed);
    const stream = new NotificationFrameStream();
    const a = full.subarray(0, 5);
    const b = full.subarray(5);
    assert.deepEqual(stream.feed(a), []);
    const out = stream.feed(b);
    assert.equal(out.length, 1);
    assert.equal(parseNotification(out[0]!)!.stateName, "armed");
  });
});

function hex(h: string): Uint8Array {
  const clean = h.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
