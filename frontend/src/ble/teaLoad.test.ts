/**
 * Golden vectors vs Python tea builders.
 * Run: node --experimental-strip-types --test src/ble/teaLoad.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToHex } from "./framing.ts";
import {
  buildTeaLoadFrames,
  buildTeaStart,
  teaPauseBytes,
  teaContentToProtocol,
} from "./teaLoad.ts";

describe("tea pause rewrite", () => {
  it("matches app TeaRecipeCreate", () => {
    assert.deepEqual(teaPauseBytes(20), [0xec, 0x00]);
    assert.deepEqual(teaPauseBytes(60), [0x00, 0x20]);
    assert.deepEqual(teaPauseBytes(120), [0x00, 0x40]);
  });
});

describe("tea load frames match Python goldens", () => {
  it("single steep sample", () => {
    const recipe = teaContentToProtocol({
      name: "t",
      kind: "tea",
      leaf_g: 4,
      output_ml_per_steep: 120,
      pours: [
        {
          ml: 80,
          temp_c: 90,
          pattern: "circular",
          pause_s: 20,
          flow_ml_s: 3.5,
        },
      ],
    });
    const frames = buildTeaLoadFrames(recipe);
    assert.equal(frames.length, 2);
    assert.equal(
      bytesToHex(frames[0]!),
      "580101a81f14000000010000a04200002042e92b",
    );
    assert.equal(
      bytesToHex(frames[1]!),
      "580101a111170000000108505a0100ec00782332c85f51",
    );
    assert.equal(bytesToHex(buildTeaStart()), "580101a0110c00000001fee3");
  });
});
