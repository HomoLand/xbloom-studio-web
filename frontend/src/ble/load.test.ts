/**
 * Load/control builders vs Python goldens from packages/core/xbloom_ble.
 * Run: node --experimental-strip-types --test src/ble/load.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCancel, buildCommit, buildStart, bytesToHex } from "./framing.ts";
import {
  buildLoadFrames,
  framesToHex,
  POURS_CMD_GRIND,
  type ProtocolRecipe,
} from "./load.ts";
import { coffeeContentToProtocol } from "./coffeeRecipe.ts";

/** Same recipe used to generate Python goldens. */
const SAMPLE: ProtocolRecipe = {
  dose: 15,
  grind: 50,
  bypass_ml: 0,
  bypass_temp_c: 0,
  pours: [
    {
      ml: 50,
      temp: 92,
      pattern: "spiral",
      vibration: "both",
      pause: 0,
      rpm: 0,
      flow: 3.5,
    },
    {
      ml: 100,
      temp: 92,
      pattern: "spiral",
      vibration: "none",
      pause: 0,
      rpm: 0,
      flow: 3.5,
    },
    {
      ml: 90,
      temp: 90,
      pattern: "ring",
      vibration: "after",
      pause: 0,
      rpm: 0,
      flow: 4.0,
    },
  ],
};

const PYTHON_LOAD = [
  "580101a41f1400000001b900000001000000bdd1",
  "580101a61f180000000100000000000000000f00000050fd",
  "580101a81f14000000010000dc420000b44221a1",
  "580101411f270000000118325c020300000023645c0200000000235a5a01020000002832a059c5",
];

describe("buildLoadFrames golden", () => {
  it("matches Python build_load_frames hex for sample recipe", () => {
    const frames = buildLoadFrames(SAMPLE);
    assert.deepEqual(framesToHex(frames), PYTHON_LOAD);
    assert.equal(frames[3]![3], POURS_CMD_GRIND);
  });

  it("never emits commit/start/cancel opcodes in load sequence", () => {
    const frames = buildLoadFrames(SAMPLE);
    const banned = new Set([0x42, 0x46, 0x47]);
    for (const fr of frames) {
      assert.equal(banned.has(fr[3]!), false);
    }
  });
});

describe("control frames remain golden", () => {
  it("commit/start/cancel", () => {
    assert.equal(bytesToHex(buildCommit()), "580101421f0c000000017fcf");
    assert.equal(bytesToHex(buildStart()), "580101469e0c0000000180a1");
    assert.equal(bytesToHex(buildCancel()), "580101479e0c00000001553e");
  });
});

describe("coffeeContentToProtocol → load", () => {
  it("builds frames from web content shape", () => {
    const protocol = coffeeContentToProtocol({
      name: "Test",
      kind: "hot",
      dose_g: 15,
      grind: 50,
      ratio: 16,
      water_ml: 240,
      pours: [
        {
          ml: 50,
          temp_c: 92,
          pattern: "spiral",
          vibration: "both",
          pause_s: 0,
          rpm: 0,
          flow_ml_s: 3.5,
        },
        {
          ml: 100,
          temp_c: 92,
          pattern: "spiral",
          vibration: "none",
          pause_s: 0,
          rpm: 0,
          flow_ml_s: 3.5,
        },
        {
          ml: 90,
          temp_c: 90,
          pattern: "ring",
          vibration: "after",
          pause_s: 0,
          rpm: 0,
          flow_ml_s: 4.0,
        },
      ],
    });
    assert.deepEqual(framesToHex(buildLoadFrames(protocol)), PYTHON_LOAD);
  });
});
