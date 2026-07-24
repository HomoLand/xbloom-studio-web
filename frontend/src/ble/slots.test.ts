/**
 * Run: node --experimental-strip-types --test src/ble/slots.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToHex } from "./framing.ts";
import { buildCoffeeResume } from "./framing.ts";
import { buildSaveSlot, buildSetMode, CMD_SAVE_SLOT } from "./slots.ts";

describe("slots frames", () => {
  it("set mode matches Python goldens", () => {
    assert.equal(bytesToHex(buildSetMode(true)), "580102f72c1000000001000000002a90");
    assert.equal(
      bytesToHex(buildSetMode(false)),
      "580102f72c100000000191327856ff58",
    );
  });

  it("save slot builds for A/B/C without commit opcodes", () => {
    const recipe = {
      dose: 15,
      grind: 50,
      pours: [
        { ml: 45, temp: 92, pattern: "spiral", vibration: "after", pause: 30, rpm: 90, flow: 3 },
        { ml: 195, temp: 92, pattern: "spiral", vibration: "none", pause: 10, rpm: 0, flow: 3.2 },
      ],
    };
    for (const slot of [0, 1, 2] as const) {
      const frame = buildSaveSlot(recipe, slot);
      const hex = bytesToHex(frame);
      assert.ok(hex.startsWith("580102"));
      // little-endian 0x2CF6 at bytes 3-4
      assert.equal(frame[3], CMD_SAVE_SLOT & 0xff);
      assert.equal(frame[4], (CMD_SAVE_SLOT >> 8) & 0xff);
      assert.equal(frame[10], slot); // slot index after 01
    }
  });

  it("resume golden still holds", () => {
    assert.equal(bytesToHex(buildCoffeeResume()), "5801014c9e0c00000001d748");
  });
});
