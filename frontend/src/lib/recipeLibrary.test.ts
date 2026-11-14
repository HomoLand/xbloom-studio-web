import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecipeRecord } from "../api.ts";
import { defaultCoffeeRecipe } from "./recipeDomain.ts";
import { getRecipeCloudState, mergeRecipeLibrary } from "./recipeLibrary.ts";

function recipe(id: string, overrides: Partial<RecipeRecord> = {}): RecipeRecord {
  return {
    recipe_id: id, name: "GRID 冰冲", kind: "coffee", source: "web",
    latest_revision: { revision_id: `rev_${id}`, revision_number: 1, content: defaultCoffeeRecipe() },
    ...overrides,
  };
}

test("host cloud identity suppresses old browser copies, including archived recipes", () => {
  const host = recipe("legacy_xbloom:123", {
    metadata: { catalog_envelope: { table_id: 123, sources: [{ region: "china" }] } },
  });
  const local = recipe("cloud:china:123", { name: "Older cloud name" });
  assert.deepEqual(mergeRecipeLibrary([host], [local]), [host]);
  assert.deepEqual(mergeRecipeLibrary([{ ...host, archived_at: "2026-11-02" }], [local]), []);
  const otherRegion = recipe("cloud:international:123", { name: "Different bean" });
  assert.deepEqual(mergeRecipeLibrary([host], [otherRegion]), [host, otherRegion]);
});

test("identical brew copies prefer explicit saves and normalize Omni spelling", () => {
  const bridge = recipe("bridge", { source: "bridge_load" });
  const saved = recipe("saved");
  saved.latest_revision!.content = { ...defaultCoffeeRecipe(), dripper: "Omni", note: "Sweet and juicy" };
  assert.deepEqual(mergeRecipeLibrary([bridge, saved], []), [saved]);
  assert.deepEqual(mergeRecipeLibrary([saved, bridge], []), [saved]);
});

test("same names with different brew settings and different named beans stay separate", () => {
  const original = recipe("original");
  const variation = recipe("variation");
  variation.latest_revision!.content = { ...defaultCoffeeRecipe(), grind: 65 };
  const otherBean = recipe("other", { name: "Other bean" });
  assert.equal(mergeRecipeLibrary([original, variation, otherBean], []).length, 3);
});

test("missing details and archived IDs are excluded without mutating the input", () => {
  const empty = recipe("empty");
  empty.latest_revision!.content.pours = [];
  const missing = recipe("missing", { latest_revision: null });
  const archived = recipe("archived", { archived_at: "2026-11-02" });
  assert.deepEqual(mergeRecipeLibrary([empty, missing, archived], [recipe("archived")]), []);
  assert.equal(archived.archived_at, "2026-11-02");
});

test("host cloud_sync metadata deduplicates pulled cloud twin, preserves fidelity, and surfaces cloud state", () => {
  const base = defaultCoffeeRecipe();
  const pours150 = [
    { ...base.pours[0], ml: 45, rpm: 110 },
    { ...base.pours[1], ml: 55, pattern: "center" as const, rpm: 0 },
    { ...base.pours[2], ml: 50, rpm: 110 },
  ];
  const host = recipe("rcp_host_777", {
    source: "web",
    metadata: {
      cloud_sync: {
        table_id: 777,
        region: "china",
        share_link: "https://share.example.invalid/s/777",
      },
    },
    latest_revision: {
      revision_id: "rev_host_777",
      revision_number: 2,
      content: {
        ...base,
        name: "Ice Flash Brew",
        kind: "flash-brew",
        water_ml: 150,
        hot_water_ml: 150,
        ice_g: 100,
        pours: pours150,
      },
    },
  });
  const pulledTwin = recipe("cloud:china:777", {
    source: "cloud",
    name: "Ice Flash Brew",
    latest_revision: {
      revision_id: "rev_cloud_777",
      revision_number: 1,
      content: {
        ...base,
        name: "Ice Flash Brew",
        kind: "hot",
        water_ml: 150,
        pours: pours150.map((p) => ({ ...p, rpm: 110 })),
      },
    },
  });

  const merged = mergeRecipeLibrary([host], [pulledTwin]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.recipe_id, "rcp_host_777");
  assert.equal(merged[0]?.latest_revision?.content.kind, "flash-brew");
  if (merged[0]?.latest_revision?.content.kind === "flash-brew") {
    assert.equal(merged[0].latest_revision.content.ice_g, 100);
    assert.equal(merged[0].latest_revision.content.hot_water_ml, 150);
  }
  assert.deepEqual(
    getRecipeCloudState(host),
    {
      ownedTableId: 777,
      region: "china",
      isOwned: true,
      shareLink: "https://share.example.invalid/s/777",
      shareAuthor: null,
    },
  );

  // Archived host recipe acts as a tombstone suppressing pulled twin.
  assert.deepEqual(
    mergeRecipeLibrary([{ ...host, archived_at: "2026-11-14" }], [pulledTwin]),
    [],
  );
});
