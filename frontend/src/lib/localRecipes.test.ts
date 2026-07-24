/**
 * Local recipe catalog (shipped store + seed data).
 * Run: node --experimental-strip-types --test src/lib/localRecipes.test.ts
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
};

const {
  listAllLocalRecipes,
  pruneOfficialClonesFromUserStore,
  recipeContentEquivalent,
  toRecipeRecord,
  validateLocalContent,
} = await import("./localRecipes.ts");

describe("listAllLocalRecipes", () => {
  beforeEach(() => {
    store.clear();
  });

  it("includes bundled official recipes without localStorage", () => {
    const list = listAllLocalRecipes();
    assert.ok(list.length >= 4);
    assert.ok(
      list.some(
        (r) =>
          r.recipe_id.startsWith("official:") ||
          r.recipe_id.startsWith("starter:"),
      ),
    );
    assert.ok(list.every((r) => r.content && r.name));
  });

  it("maps to RecipeRecord shape", () => {
    const rec = toRecipeRecord(listAllLocalRecipes()[0]!);
    assert.ok(rec.recipe_id);
    assert.ok(rec.latest_revision?.content);
  });

  it("dedupes imported user clone against a bundled official tea", () => {
    const official = listAllLocalRecipes().find(
      (r) => r.source === "official" && r.kind === "tea",
    );
    assert.ok(official, "bundled official tea missing");
    store.set(
      "xbloom.userRecipes.v1",
      JSON.stringify([
        {
          recipe_id: "user:clone-tea",
          name: official!.name,
          kind: "tea",
          source: "user",
          content: JSON.parse(JSON.stringify(official!.content)),
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    pruneOfficialClonesFromUserStore();
    const list = listAllLocalRecipes().filter(
      (r) => r.name === official!.name,
    );
    assert.equal(
      list.length,
      1,
      `expected 1 entry, got ${list.map((r) => r.source + ":" + r.recipe_id).join(",")}`,
    );
    assert.equal(list[0]!.source, "official");
  });

  it("recipeContentEquivalent ignores note", () => {
    const a = {
      name: "X",
      kind: "tea" as const,
      leaf_g: 4,
      output_ml_per_steep: 120,
      pours: [{ label: "1", ml: 90, temp_c: 90, pattern: "center", pause_s: 30, flow_ml_s: 3 }],
      note: "a",
    };
    const b = { ...a, note: "b" };
    assert.equal(recipeContentEquivalent(a, b), true);
  });
});

describe("validateLocalContent", () => {
  it("accepts official coffee content", () => {
    const coffee = listAllLocalRecipes().find((r) => r.kind === "hot");
    assert.ok(coffee);
    const v = validateLocalContent(coffee!.content);
    assert.equal(v.valid, true);
  });
});
