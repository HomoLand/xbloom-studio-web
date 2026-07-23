/**
 * Golden vectors vs Python protocol builders for extras frames.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToHex } from "./framing.ts";
import {
  buildBrewerEnter,
  buildBrewerQuit,
  buildBrewerStart,
  buildBrewerStop,
  buildGrinderEnter,
  buildGrinderQuit,
  buildGrinderStart,
  buildGrinderStop,
  buildScaleEnter,
  buildScaleExit,
  buildScaleTare,
} from "./extras.ts";

describe("extras frames match core protocol goldens", () => {
  it("scale", () => {
    assert.equal(bytesToHex(buildScaleEnter()), "580101431f0c00000001aa50");
    assert.equal(bytesToHex(buildScaleTare()), "58010134210c000000018c78");
    assert.equal(bytesToHex(buildScaleExit()), "5801014e1f0c00000001e57e");
  });
  it("grinder", () => {
    assert.equal(
      bytesToHex(buildGrinderEnter(50, 90)),
      "580101461f1400000001320000005a0000007ad1",
    );
    assert.equal(
      bytesToHex(buildGrinderStart(50, 90)),
      "580101ac0d1800000001e8030000320000005a000000661d",
    );
    assert.equal(bytesToHex(buildGrinderStop()), "580101b10d0c00000001a6ba");
    assert.equal(bytesToHex(buildGrinderQuit()), "5801014c1f0c000000015e49");
  });
  it("water / brewer", () => {
    assert.equal(
      bytesToHex(buildBrewerEnter(90, "center")),
      "580101471f14000000010000000000006144a20e",
    );
    assert.equal(
      bytesToHex(buildBrewerStart(100, 90, 3.5, "center")),
      "5801019a11200000000100000c4200007a44000061440000000000000000a38f",
    );
    assert.equal(bytesToHex(buildBrewerStop()), "5801019b110c000000013643");
    assert.equal(bytesToHex(buildBrewerQuit()), "5801014d1f0c000000018bd6");
  });
});
