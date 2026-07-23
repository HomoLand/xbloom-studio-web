/**
 * Golden vectors from packages/core/xbloom_ble/protocol.py (Python source of truth).
 * Run: node --experimental-strip-types --test src/ble/framing.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCancel,
  buildCommit,
  buildStart,
  bytesToHex,
  crc16Kermit,
  j15Frame,
  xbloomFrame,
} from "./framing.ts";

describe("crc16Kermit", () => {
  it("matches Python empty and short vectors", () => {
    assert.equal(crc16Kermit(new Uint8Array()), 0x0);
    assert.equal(crc16Kermit(new Uint8Array([0x58, 0x01, 0x01])), 0x4d70);
  });
});

describe("xbloomFrame control builders", () => {
  it("buildCommit matches capture 580101421f0c000000017fcf", () => {
    assert.equal(bytesToHex(buildCommit()), "580101421f0c000000017fcf");
  });

  it("buildStart matches capture 580101469e0c0000000180a1", () => {
    assert.equal(bytesToHex(buildStart()), "580101469e0c0000000180a1");
  });

  it("buildCancel matches capture 580101479e0c00000001553e", () => {
    assert.equal(bytesToHex(buildCancel()), "580101479e0c00000001553e");
  });

  it("xbloomFrame is consistent with buildCommit", () => {
    const manual = xbloomFrame(0x42, 0x1f, new Uint8Array([0x01]));
    assert.equal(bytesToHex(manual), bytesToHex(buildCommit()));
  });
});

describe("j15Frame", () => {
  it("matches Python j15_frame(8002, raw=01)", () => {
    const frame = j15Frame(8002, { raw: new Uint8Array([0x01]) });
    assert.equal(bytesToHex(frame), "580101421f0d00000001011d9e");
  });

  it("matches Python j15_frame(40518, raw=01)", () => {
    const frame = j15Frame(40518, { raw: new Uint8Array([0x01]) });
    assert.equal(bytesToHex(frame), "580101469e0d00000001010b91");
  });

  it("matches Python j15_frame(40519, raw=01)", () => {
    const frame = j15Frame(40519, { raw: new Uint8Array([0x01]) });
    assert.equal(bytesToHex(frame), "580101479e0d0000000101b410");
  });
});
