import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecipeRecord } from "../api.ts";
import { defaultCoffeeRecipe } from "./recipeDomain.ts";
import { mergeRecipeLibrary } from "./recipeLibrary.ts";

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
