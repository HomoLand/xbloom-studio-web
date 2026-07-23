/**
 * Local recipe catalog (shipped store + seed data).
 * Run: node --experimental-strip-types --test src/lib/localRecipes.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listAllLocalRecipes,
  toRecipeRecord,
  validateLocalContent,
} from "./localRecipes.ts";

describe("listAllLocalRecipes", () => {
  it("includes bundled official recipes without localStorage", () => {
    const list = listAllLocalRecipes();
    assert.ok(list.length >= 4);
    assert.ok(list.some((r) => r.recipe_id.startsWith("official:")));
    assert.ok(list.every((r) => r.content && r.name));
  });

  it("maps to RecipeRecord shape", () => {
    const rec = toRecipeRecord(listAllLocalRecipes()[0]!);
    assert.ok(rec.recipe_id);
    assert.ok(rec.latest_revision?.content);
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
