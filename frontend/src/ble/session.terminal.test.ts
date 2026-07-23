/**
 * Drives shipped shouldEnterTerminalPhase + parseNotification (real entry points).
 * Run: node --experimental-strip-types --test src/ble/session.terminal.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldEnterTerminalPhase } from "./session.ts";
import { parseNotification } from "./telemetry.ts";

const IDLE = "580207571f0d000000c101d848";
const READY = "580207571f0d000000c124773e";
const COMPLETE = "580207571f0d000000c141dc0a";
const ARMED = "580207571f0d000000c11f27b1";

describe("shouldEnterTerminalPhase (shipped session rule)", () => {
  it("does not terminal on idle while only connected", () => {
    const state = parseNotification(IDLE)!.state!;
    assert.equal(shouldEnterTerminalPhase("connected", state), false);
    assert.equal(shouldEnterTerminalPhase("idle", state), false);
    assert.equal(shouldEnterTerminalPhase("connecting", state), false);
  });

  it("terminals on idle after active brew phases", () => {
    const state = parseNotification(IDLE)!.state!;
    assert.equal(shouldEnterTerminalPhase("loading", state), true);
    assert.equal(shouldEnterTerminalPhase("armed", state), true);
    assert.equal(shouldEnterTerminalPhase("starting", state), true);
    assert.equal(shouldEnterTerminalPhase("brewing", state), true);
  });

  it("terminals on ready/complete only during active brew phases", () => {
    const ready = parseNotification(READY)!.state!;
    const complete = parseNotification(COMPLETE)!.state!;
    assert.equal(shouldEnterTerminalPhase("brewing", ready), true);
    assert.equal(shouldEnterTerminalPhase("starting", complete), true);
    assert.equal(shouldEnterTerminalPhase("connected", ready), false);
    assert.equal(shouldEnterTerminalPhase("connected", complete), false);
  });

  it("armed state itself is not terminal", () => {
    const state = parseNotification(ARMED)!.state!;
    assert.equal(shouldEnterTerminalPhase("loading", state), false);
    assert.equal(shouldEnterTerminalPhase("connected", state), false);
  });
});
