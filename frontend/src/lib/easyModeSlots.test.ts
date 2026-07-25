/**
 * Run: node --experimental-strip-types --test src/lib/easyModeSlots.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseEasyModePayload,
  snapshotFromLocalWrite,
} from "./easyModeSlots.ts";
import type { CoffeeRecipeContent } from "../api.ts";

function coffee(name: string, dose = 15): Record<string, unknown> {
  return {
    tableId: 101,
    theName: name,
    dose,
    grinderSize: 50,
    isSetGrinderSize: 1,
    grandWater: 16,
    pourList: [
      {
        water: 45,
        temperature: 92,
        setting_pattern_array: "1",
        vibration: 1,
        pause: 30,
        rpm: 90,
        flow: 3,
      },
      {
        water: 195,
        temperature: 92,
        setting_pattern_array: "1",
        vibration: 0,
        pause: 10,
        rpm: 0,
        flow: 3.2,
      },
    ],
  };
}

describe("parseEasyModePayload", () => {
  it("maps A/B/C recipeSnapshotVo list", () => {
    const slots = parseEasyModePayload({
      easyModeDetailVoList: [
        { position: "A", scale: 1, recipeSnapshotVo: coffee("Alpha") },
        { position: "B", scale: 2, recipeSnapshotVo: coffee("Bravo") },
        { position: "C", scale: 1, recipeSnapshotVo: coffee("Charlie") },
      ],
    });
    assert.equal(slots.length, 3);
    assert.equal(slots[0]!.position, "A");
    assert.equal(slots[0]!.name, "Alpha");
    assert.ok(slots[0]!.content);
    assert.equal(slots[0]!.scale, true);
    assert.equal(slots[1]!.name, "Bravo");
    assert.equal(slots[1]!.scale, false);
    assert.equal(slots[2]!.name, "Charlie");
    assert.equal(slots[0]!.content!.dose_g, 15);
    assert.ok(slots[0]!.content!.pours.length >= 1);
  });

  it("fills empty positions when list is partial", () => {
    const slots = parseEasyModePayload({
      easyModeDetailVoList: [
        { position: "B", scale: 1, recipeSnapshotVo: coffee("Only B") },
      ],
    });
    assert.equal(slots[0]!.name, "—");
    assert.equal(slots[0]!.content, null);
    assert.equal(slots[1]!.name, "Only B");
    assert.ok(slots[1]!.content);
    assert.equal(slots[2]!.content, null);
  });

  it("accepts numeric slot indices 0/1/2", () => {
    const slots = parseEasyModePayload({
      list: [{ position: 0, recipeSnapshotVo: coffee("Zero") }],
    });
    assert.equal(slots[0]!.name, "Zero");
  });
});

describe("snapshotFromLocalWrite", () => {
  it("tags source and warning code for i18n", () => {
    const c = {
      name: "X",
      kind: "hot",
      dripper: "Omni",
      dose_g: 15,
      grind: 50,
      ratio: 16,
      water_ml: 240,
      hot_water_ml: 240,
      note: "",
      pours: [],
    } as CoffeeRecipeContent;
    const snap = snapshotFromLocalWrite(
      ["A1", "B1", "C1"],
      [c, c, c],
      "SN123",
    );
    assert.equal(snap.source, "local-write");
    assert.equal(snap.sn, "SN123");
    assert.equal(snap.warning, "local-write");
    assert.equal(snap.slots[0]!.name, "A1");
  });
});
