/**
 * Golden vectors vs Python protocol builders for extras frames.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToHex } from "./framing.ts";
import {
  buildBrewerEnter,
  buildBrewerPause,
  buildBrewerQuit,
  buildBrewerResume,
  buildBrewerStart,
  buildBrewerStop,
  buildGrinderEnter,
  buildGrinderPause,
  buildGrinderQuit,
  buildGrinderResume,
  buildGrinderStart,
  buildGrinderStop,
  buildScaleEnter,
  buildScaleExit,
  buildScaleTare,
  buildBrewerSetPattern,
  buildBrewerSetTemperature,
  buildReadPourRadius,
  buildReadVibrationAmplitude,
  buildSetDisplay,
  buildSetTemperatureUnit,
  buildSetWaterSource,
  buildSetWeightUnit,
  buildWritePourRadius,
  buildWriteVibrationAmplitude,
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
    assert.equal(bytesToHex(buildGrinderPause()), "580101521f0c00000001b67a");
    assert.equal(bytesToHex(buildGrinderResume()), "580101541f0c000000017b22");
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
    assert.equal(bytesToHex(buildBrewerPause()), "580101531f0c0000000163e5");
    assert.equal(bytesToHex(buildBrewerResume()), "580101551f0c00000001aebd");
  });
  it("machine settings", () => {
    assert.equal(bytesToHex(buildSetWeightUnit("g")), "580101451f10000000010100000007ab");
    assert.equal(
      bytesToHex(buildSetTemperatureUnit("C")),
      "5801014a1f1000000001010000004bb7",
    );
    assert.equal(
      bytesToHex(buildSetWaterSource("tap")),
      "5801019c111000000001010000009ced",
    );
    assert.equal(
      bytesToHex(buildSetDisplay("high")),
      "580101a71f10000000010f000000f313",
    );
  });
  it("live FreeSolo pattern/temp", () => {
    assert.equal(
      bytesToHex(buildBrewerSetPattern("spiral")),
      "580101501f1000000001020000004bf4",
    );
    assert.equal(
      bytesToHex(buildBrewerSetTemperature(92)),
      "5801019e1110000000019803000076be",
    );
  });
  it("advanced pour radius / vibration", () => {
    assert.equal(bytesToHex(buildReadPourRadius()), "580102f22c0c0000000155de");
    assert.equal(
      bytesToHex(buildWritePourRadius(720)),
      "580102f32c1000000001d0020000bf83",
    );
    assert.equal(
      bytesToHex(buildReadVibrationAmplitude()),
      "580102f42c0c000000019886",
    );
    assert.equal(
      bytesToHex(buildWriteVibrationAmplitude(1300)),
      "580102f52c100000000114050000f8b3",
    );
  });
});
