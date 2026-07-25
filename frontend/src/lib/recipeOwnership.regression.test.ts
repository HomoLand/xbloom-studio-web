/**
 * Regression: share import ownership, promote/prune twins, official labels,
 * post-delete selection, Easy payload parse.
 *
 * Run:
 *   node --experimental-strip-types --test src/lib/recipeOwnership.regression.test.ts
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

const teaContent = {
  name: "回归茶",
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

const coffeeVo = {
  tableId: 9001,
  theName: "官方样例",
  cupType: 2,
  dose: 15,
  grinderSize: 50,
  isSetGrinderSize: 1,
  grandWater: 16,
  pourList: [
    {
      theName: "Bloom",
      volume: 45,
      temperature: 92,
      pattern: 2,
      pausing: 30,
      flowRate: 3,
      isEnableVibrationBefore: 2,
      isEnableVibrationAfter: 1,
    },
    {
      theName: "Main",
      volume: 195,
      temperature: 92,
      pattern: 2,
      pausing: 10,
      flowRate: 3.2,
      isEnableVibrationBefore: 2,
      isEnableVibrationAfter: 2,
    },
  ],
};

const {
  classifyCloudRecipeSource,
  deleteUserRecipe,
  getLocalRecipe,
  isOwnedOnCloud,
  listAllLocalRecipes,
  promoteLocalToCloudOwned,
  pruneRedundantShareCopies,
  resolveOwnedTableId,
  saveUserRecipe,
} = await import("./localRecipes.ts");

const { importCloudSyncTargets, importShareLink } = await import(
  "./cloudCatalog.ts"
);
const { CloudError, parseShareLinkId } = await import("./xbloomCloud.ts");
const { parseEasyModePayload } = await import("./easyModeSlots.ts");

/** Mirrors Recipes.tsx runCloud post-op selection (no React). */
function postCloudSelection(
  selectedId: string | null,
): "refresh" | "clear" | "noop" {
  if (!selectedId) return "noop";
  return getLocalRecipe(selectedId) ? "refresh" : "clear";
}

describe("regression: official labels only from host catalog", () => {
  beforeEach(() => store.clear());

  it("coffee/tea sync → official; created → user; shared → shared", () => {
    const { entries } = importCloudSyncTargets(
      [
        { target: "coffee", endpoint: "tHostRecipe.thtml", payload: { list: [coffeeVo] } },
        {
          target: "created",
          endpoint: "tuMyTeaRecipeCreated.tuhtml",
          payload: {
            list: [{ ...coffeeVo, tableId: 42, theName: "我写的" }],
          },
        },
        {
          target: "shared",
          endpoint: "tuMyRecipeShared.tuhtml",
          payload: {
            list: [{ ...coffeeVo, tableId: 77, theName: "别人分享" }],
          },
        },
      ],
      "china",
    );
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    assert.equal(byName["官方样例"]?.source, "official");
    assert.equal(byName["官方样例"]?.origin, "coffee");
    assert.equal(isOwnedOnCloud(byName["官方样例"]!), false);

    assert.equal(byName["我写的"]?.source, "user");
    assert.equal(byName["我写的"]?.origin, "created");
    assert.equal(isOwnedOnCloud(byName["我写的"]!), true);
    assert.equal(resolveOwnedTableId(byName["我写的"]!), 42);

    assert.equal(byName["别人分享"]?.source, "shared");
    assert.equal(isOwnedOnCloud(byName["别人分享"]!), false);

    // listAllLocalRecipes must not invent fake official seeds
    assert.equal(
      listAllLocalRecipes().filter((r) => r.recipe_id.startsWith("official:"))
        .length,
      0,
    );
  });

  it("classifyCloudRecipeSource never marks random targets as official", () => {
    assert.equal(classifyCloudRecipeSource("created"), "user");
    assert.equal(classifyCloudRecipeSource("shared"), "shared");
    assert.equal(classifyCloudRecipeSource("unknown-foo"), "user");
    assert.equal(classifyCloudRecipeSource("coffee"), "official");
    assert.equal(classifyCloudRecipeSource("tea"), "official");
  });
});

describe("regression: share import is local-only (not owned cloud)", () => {
  beforeEach(() => {
    store.clear();
    // Mock public RecipeDetail.html
    (globalThis as { fetch?: typeof fetch }).fetch = async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      assert.match(url, /RecipeDetail\.html/);
      const body = {
        result: "success",
        shareMemberName: "AuthorX",
        recipeVo: {
          ...coffeeVo,
          tableId: 287965,
          theName: "over ice shared",
          shareRecipeLink:
            "https://share-h5.xbloom.com/?id=Fq7YtestToken%3D%3D",
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  it("importShareLink stores share: id without owned table_id", async () => {
    const entry = await importShareLink(
      "https://share-h5.xbloom.com/?id=Fq7YtestToken%3D%3D",
    );
    assert.equal(entry.source, "shared");
    assert.equal(entry.origin, "shared");
    assert.match(entry.recipe_id, /^share:international:287965$/);
    // Critical: author tableId must not enable 删除云端
    assert.equal(entry.table_id, null);
    assert.equal(resolveOwnedTableId(entry), null);
    assert.equal(isOwnedOnCloud(entry), false);
    assert.ok(entry.share_link?.includes("share-h5"));
    assert.equal(entry.share_author, "AuthorX");
  });

  it("legacy share row with embedded author table_id is healed", () => {
    store.set(
      "xbloom.userRecipes.v1",
      JSON.stringify([
        {
          recipe_id: "share:international:287965",
          name: "over ice shared",
          kind: "hot",
          source: "shared",
          origin: "shared",
          table_id: 287965,
          content: { ...teaContent, name: "over ice shared", kind: "tea" },
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    const e = listAllLocalRecipes()[0]!;
    assert.equal(e.table_id, null);
    assert.equal(isOwnedOnCloud(e), false);
  });
});

describe("regression: import → upload → still 分享, can cloud-delete, no twin", () => {
  beforeEach(() => store.clear());

  it("promote keeps 分享 label, enables cloud delete, prunes share: twin", () => {
    saveUserRecipe(
      { ...teaContent, name: "over ice" },
      {
        recipeId: "share:international:1",
        source: "shared",
        origin: "shared",
        shareLink: "https://share-h5.xbloom.com/?id=x",
        shareAuthor: "Someone",
      },
    );
    // Local-only share: delete cloud must be off
    assert.equal(isOwnedOnCloud(getLocalRecipe("share:international:1")), false);

    const promoted = promoteLocalToCloudOwned("share:international:1", {
      content: { ...teaContent, name: "over ice" },
      tableId: 555,
      region: "china",
      shareLink: "https://share-h5.xbloom.com/?id=x",
      shareAuthor: "Someone",
    });
    assert.equal(promoted.recipe_id, "cloud:china:555");
    // User requirement: still 分享 (from others), but owned on this account
    assert.equal(promoted.source, "shared");
    assert.equal(promoted.origin, "created");
    assert.equal(promoted.table_id, 555);
    assert.equal(isOwnedOnCloud(promoted), true);
    assert.equal(resolveOwnedTableId(promoted), 555);

    // Simulate a stale share twin reappearing (bypass listAllLocalRecipes prune)
    const key = "xbloom.userRecipes.v1";
    const raw = JSON.parse(store.get(key) || "[]") as Array<Record<string, unknown>>;
    raw.push({
      recipe_id: "share:international:1",
      name: "over ice",
      kind: "tea",
      source: "shared",
      origin: "shared",
      content: { ...teaContent, name: "over ice" },
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    });
    store.set(key, JSON.stringify(raw));
    assert.equal(
      (JSON.parse(store.get(key)!) as unknown[]).filter(
        (r) => (r as { name?: string }).name === "over ice",
      ).length,
      2,
    );
    assert.ok(pruneRedundantShareCopies() >= 1);
    const left = listAllLocalRecipes().filter((r) => r.name === "over ice");
    assert.equal(left.length, 1);
    assert.equal(left[0]!.recipe_id, "cloud:china:555");
    assert.equal(left[0]!.source, "shared");
    assert.equal(isOwnedOnCloud(left[0]!), true);
  });

  it("importCloudSyncTargets prunes share twin after created list returns same brew", () => {
    saveUserRecipe(
      { ...teaContent, name: "sync twin" },
      {
        recipeId: "share:china:9",
        source: "shared",
        origin: "shared",
      },
    );
    importCloudSyncTargets(
      [
        {
          target: "created",
          endpoint: "tuMyTeaRecipeCreated.tuhtml",
          payload: {
            list: [
              {
                tableId: 88,
                theName: "sync twin",
                cupType: 4,
                dose: 4,
                pourList: [
                  {
                    volume: 90,
                    temperature: 90,
                    pattern: 1,
                    pausing: 20,
                    flowRate: 3.5,
                  },
                ],
              },
            ],
          },
        },
      ],
      "china",
    );
    const rows = listAllLocalRecipes().filter((r) => r.name === "sync twin");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.recipe_id, /^cloud:china:88$/);
    assert.equal(isOwnedOnCloud(rows[0]!), true);
  });
});

describe("regression: cloud delete does not reopen missing recipe", () => {
  beforeEach(() => store.clear());

  it("after deleteUserRecipe, getLocalRecipe is null → clear selection", () => {
    const e = saveUserRecipe(teaContent, {
      recipeId: "cloud:china:4242",
      source: "user",
      origin: "created",
      tableId: 4242,
      region: "china",
    });
    assert.equal(isOwnedOnCloud(e), true);
    const selectedId = e.recipe_id;
    assert.equal(postCloudSelection(selectedId), "refresh");

    assert.equal(deleteUserRecipe(selectedId), true);
    assert.equal(getLocalRecipe(selectedId), null);
    // Recipes.tsx runCloud uses this existence check — must clear, not openDetail
    assert.equal(postCloudSelection(selectedId), "clear");
  });

  it("CloudError not_on_account is distinguishable for UI mapping", () => {
    const err = new CloudError(
      "Recipe is not on this account created list",
      "not_on_account",
    );
    assert.equal(err.code, "not_on_account");
    assert.notEqual(err.code, null);
  });
});

describe("regression: Easy mode A/B/C parse still wired", () => {
  it("parses easyModeDetailVoList like App Auto Mode list", () => {
    const slots = parseEasyModePayload({
      easyModeDetailVoList: [
        { position: "A", scale: 1, recipeSnapshotVo: coffeeVo },
        {
          position: "B",
          scale: 2,
          recipeSnapshotVo: { ...coffeeVo, theName: "Slot B", tableId: 2 },
        },
        {
          position: "C",
          scale: 1,
          recipeSnapshotVo: { ...coffeeVo, theName: "Slot C", tableId: 3 },
        },
      ],
    });
    assert.equal(slots[0]!.name, "官方样例");
    assert.equal(slots[0]!.scale, true);
    assert.equal(slots[1]!.name, "Slot B");
    assert.equal(slots[1]!.scale, false);
    assert.ok(slots[0]!.content);
    assert.ok(slots[2]!.content);
  });
});

describe("regression: share link parser still accepts App H5", () => {
  it("round-trips common share URL shape", () => {
    const id = parseShareLinkId(
      "https://share-h5.xbloom.com/?id=Fq7YtestToken%3D%3D",
    );
    assert.equal(id, "Fq7YtestToken==");
  });
});
