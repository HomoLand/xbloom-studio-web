/**
 * Local recipe catalog (browser store only — no fake official seeds).
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
  classifyCloudRecipeSource,
  listAllLocalRecipes,
  pruneOfficialClonesFromUserStore,
  saveUserRecipe,
  validateLocalContent,
} = await import("./localRecipes.ts");

const teaContent = {
  name: "Test tea",
  kind: "tea" as const,
  leaf_g: 4,
  output_ml_per_steep: 120,
  pours: [
    {
      label: "1",
      ml: 90,
      temp_c: 90,
      pattern: "center" as const,
      pause_s: 30,
      flow_ml_s: 3,
    },
  ],
};

describe("listAllLocalRecipes", () => {
  beforeEach(() => {
    store.clear();
  });

  it("starts empty without bundled Skill seeds", () => {
    const list = listAllLocalRecipes();
    assert.equal(list.length, 0);
  });

  it("drops legacy official:* and starter:* rows from storage", () => {
    store.set(
      "xbloom.userRecipes.v1",
      JSON.stringify([
        {
          recipe_id: "official:hot-balanced",
          name: "假官方",
          kind: "hot",
          source: "official",
          content: teaContent,
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
        {
          recipe_id: "cloud:china:1",
          name: "App 绿茶",
          kind: "tea",
          source: "cloud",
          origin: "tea",
          content: teaContent,
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    const list = listAllLocalRecipes();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.recipe_id, "cloud:china:1");
    assert.equal(list[0]!.source, "official");
  });

  it("maps cloud created origin to user", () => {
    store.set(
      "xbloom.userRecipes.v1",
      JSON.stringify([
        {
          recipe_id: "cloud:china:9",
          name: "我的茶",
          kind: "tea",
          source: "cloud",
          origin: "created",
          content: { ...teaContent, name: "我的茶" },
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    const list = listAllLocalRecipes();
    assert.equal(list[0]!.source, "user");
  });
});

describe("classifyCloudRecipeSource", () => {
  it("classifies sync targets", () => {
    assert.equal(classifyCloudRecipeSource("coffee"), "official");
    assert.equal(classifyCloudRecipeSource("tea"), "official");
    assert.equal(classifyCloudRecipeSource("created"), "user");
    assert.equal(classifyCloudRecipeSource("shared"), "user");
  });

  it("respects appPlaceList user bit", () => {
    assert.equal(
      classifyCloudRecipeSource("coffee", { appPlaceList: [4] }),
      "user",
    );
    assert.equal(
      classifyCloudRecipeSource("created", { appPlaceList: [6] }),
      "official",
    );
  });
});

describe("saveUserRecipe", () => {
  beforeEach(() => store.clear());

  it("stores user recipes", () => {
    const e = saveUserRecipe(teaContent, { source: "user" });
    assert.equal(e.source, "user");
    assert.equal(listAllLocalRecipes().length, 1);
  });
});

describe("validateLocalContent", () => {
  it("accepts tea content", () => {
    const v = validateLocalContent(teaContent);
    assert.equal(v.valid, true);
  });
});

describe("pruneOfficialClonesFromUserStore", () => {
  beforeEach(() => store.clear());
  it("removes leftover seed ids", () => {
    store.set(
      "xbloom.userRecipes.v1",
      JSON.stringify([
        {
          recipe_id: "starter:tea-baihao-yinzhen",
          name: "x",
          kind: "tea",
          source: "official",
          content: teaContent,
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    assert.equal(pruneOfficialClonesFromUserStore(), 1);
  });
});
