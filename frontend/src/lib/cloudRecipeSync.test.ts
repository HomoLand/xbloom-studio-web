import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CloudSyncMeta, RecipeRecord } from "../api.ts";
import type { AccountCredentials } from "./accountPrefs.ts";
import type { LocalRecipeEntry } from "./localRecipes.ts";
import { defaultCoffeeRecipe } from "./recipeDomain.ts";
import {
  collectUnsyncedPushCandidates,
  formatTwoWaySyncSummary,
  syncCloudRecipesTwoWay,
  type TwoWaySyncTranslator,
} from "./cloudRecipeSync.ts";

function makeHostRecipe(
  id: string,
  overrides: Partial<RecipeRecord> = {},
): RecipeRecord {
  return {
    recipe_id: id,
    name: `Host ${id}`,
    kind: "coffee",
    source: "web",
    created_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-14T00:00:00Z",
    latest_revision: {
      revision_id: `rev_${id}`,
      revision_number: 1,
      content: {
        ...defaultCoffeeRecipe(),
        name: `Host ${id}`,
      },
    },
    ...overrides,
  };
}

function makeLocalEntry(
  id: string,
  overrides: Partial<LocalRecipeEntry> = {},
): LocalRecipeEntry {
  return {
    recipe_id: id,
    name: `Local ${id}`,
    kind: "coffee",
    source: "user",
    created_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-14T00:00:00Z",
    content: {
      ...defaultCoffeeRecipe(),
      name: `Local ${id}`,
    },
    ...overrides,
  };
}

describe("collectUnsyncedPushCandidates", () => {
  it("selects only unsynced web/web-design host recipes and non-cloud/non-share local user/design entries", () => {
    const hostWeb = makeHostRecipe("rcp_web");
    const hostDesign = makeHostRecipe("rcp_design", { source: "web-design" });
    const hostSynced = makeHostRecipe("rcp_synced", {
      metadata: { cloud_sync: { table_id: 99, region: "china" } },
    });
    const hostOfficial = makeHostRecipe("rcp_official", { source: "official" });
    const hostBridge = makeHostRecipe("rcp_bridge", { source: "bridge_load" });
    const hostArchived = makeHostRecipe("rcp_archived", {
      archived_at: "2026-11-14T01:00:00Z",
    });

    const localUser = makeLocalEntry("user:1");
    const localDesign = makeLocalEntry("design:1", { source: "design" });
    const localShare = makeLocalEntry("share:123", {
      recipe_id: "share:123",
      source: "user",
    });
    const localCloud = makeLocalEntry("cloud:china:55", { source: "cloud" });
    const localAlreadySynced = makeLocalEntry("user:synced", { table_id: 77 });
    const localDupOfHost = makeLocalEntry("user:dup", {
      name: hostWeb.name,
      content: { ...defaultCoffeeRecipe(), name: hostWeb.name },
    });

    const candidates = collectUnsyncedPushCandidates(
      [
        hostWeb,
        hostDesign,
        hostSynced,
        hostOfficial,
        hostBridge,
        hostArchived,
      ],
      [
        localUser,
        localDesign,
        localShare,
        localCloud,
        localAlreadySynced,
        localDupOfHost,
      ],
    );

    assert.deepEqual(
      candidates.map((c) => `${c.storage}:${c.recipe_id}`),
      ["host:rcp_web", "host:rcp_design", "local:user:1", "local:design:1"],
    );
  });
});

describe("syncCloudRecipesTwoWay & formatTwoWaySyncSummary", () => {
  it("pushes eligible recipes, normalizes legacy grinder RPM, persists host & local ownership, skips xPod, pulls catalog & history", async () => {
    const base = defaultCoffeeRecipe();
    const hostWeb = makeHostRecipe("rcp_web_1");
    const hostDesign = makeHostRecipe("rcp_design_1", {
      source: "web-design",
      latest_revision: {
        revision_id: "rev_design_1",
        revision_number: 1,
        content: {
          ...base,
          name: "Legacy Dirty Host Design",
          pours: [
            { ...base.pours[0], pattern: "spiral", rpm: 110 },
            { ...base.pours[1], pattern: "center", rpm: 0 },
            { ...base.pours[2], pattern: "circular", rpm: 80 },
          ],
        },
      },
    });
    const hostXpod = makeHostRecipe("rcp_xpod", {
      source: "web",
      latest_revision: {
        revision_id: "rev_xpod",
        revision_number: 1,
        content: { ...base, name: "Xpod Recipe", dripper: "xPod" },
      },
    });
    const localUser = makeLocalEntry("user:local_1", {
      share_link: "https://share.example.invalid/abc",
      share_author: "Sajo",
      content: {
        ...base,
        name: "Local Legacy Dirty",
        pours: [
          { ...base.pours[0], pattern: "spiral", rpm: 100 },
          { ...base.pours[1], pattern: "center", rpm: 0 },
          { ...base.pours[2], pattern: "circular", rpm: 70 },
        ],
      },
    });

    const persistedHostMeta: Array<{ id: string; meta: CloudSyncMeta }> = [];
    const promotedLocal: Array<{
      id: string;
      tableId: number;
      region: string;
      poursRpm: number[];
    }> = [];
    const pushedPoursRpm: Record<string, number[]> = {};

    const creds = {
      email: "user@example.com",
      password: "secret",
      region: "china",
      languageType: 1,
    } as AccountCredentials;

    const stats = await syncCloudRecipesTwoWay(
      { creds, includeHistory: true, staticMode: false },
      {
        listAllHostRecipes: async () => [hostWeb, hostDesign, hostXpod],
        listAllLocalRecipes: () => [localUser],
        pushCloudRecipe: async (req) => {
          if ("pours" in req.content && "dose_g" in req.content) {
            pushedPoursRpm[req.content.name] = req.content.pours.map(
              (p) => p.rpm,
            );
          }
          if (req.content.name === "Host rcp_web_1") {
            return {
              remote_table_id: 1001,
              status: "created",
              write_performed: true,
              name: req.content.name,
            };
          }
          if (req.content.name === "Legacy Dirty Host Design") {
            return {
              remote_table_id: 1002,
              status: "created",
              write_performed: true,
              name: req.content.name,
            };
          }
          return {
            remote_table_id: 1003,
            status: "already-present",
            write_performed: false,
            name: req.content.name,
          };
        },
        setRecipeCloudMeta: async (recipeId, meta) => {
          persistedHostMeta.push({ id: recipeId, meta });
          return hostWeb;
        },
        promoteLocalToCloudOwned: (recipeId, meta) => {
          promotedLocal.push({
            id: recipeId,
            tableId: meta.tableId,
            region: meta.region,
            poursRpm:
              "dose_g" in meta.content ? meta.content.pours.map((p) => p.rpm) : [],
          });
          return localUser;
        },
        syncAccountCatalog: async () => ({
          region: "china",
          targets: [],
          total_raw_records: 5,
          skipped: 0,
        }),
        importCloudSyncTargets: () => ({
          stats: [{ kind: "coffee", imported: 2, candidates: 5 }],
          total: 5,
        }),
        fetchCloudBrewRecords: async () => ({
          region: "china",
          records: [],
          pages: 1,
          total_raw: 3,
        }),
        importCloudBrewRecords: () => ({
          imported: 1,
          updated: 2,
          skipped: 0,
          total: 3,
        }),
      },
    );

    assert.deepEqual(stats, {
      region: "china",
      pushedCreated: 2,
      pushedLinked: 1,
      skippedUnsupported: 1,
      imported: 2,
      candidates: 5,
      history: { ok: true, imported: 1, updated: 2 },
    });
    assert.deepEqual(pushedPoursRpm["Legacy Dirty Host Design"], [110, 0, 110]);
    assert.deepEqual(pushedPoursRpm["Local Legacy Dirty"], [100, 0, 100]);
    assert.deepEqual(persistedHostMeta, [
      { id: "rcp_web_1", meta: { table_id: 1001, region: "china" } },
      { id: "rcp_design_1", meta: { table_id: 1002, region: "china" } },
    ]);
    assert.deepEqual(promotedLocal, [
      {
        id: "user:local_1",
        tableId: 1003,
        region: "china",
        poursRpm: [100, 0, 100],
      },
    ]);

    const t: TwoWaySyncTranslator = (key) => {
      const map: Record<Parameters<TwoWaySyncTranslator>[0], string> = {
        "cloud.syncDone": "pulled {imported}/{candidates} ({region})",
        "cloud.syncPushedNote": "pushed {pushed}",
        "cloud.syncLinkedNote": "linked {linked}",
        "cloud.syncSkippedNote": "skipped {skipped}",
        "cloud.syncHistoryNote": "hist +{imported}/~{updated}",
        "cloud.syncHistoryFailed": "hist failed",
      };
      return map[key];
    };
    assert.equal(
      formatTwoWaySyncSummary(stats, t),
      "pushed 2 · linked 1 · pulled 2/5 (china) · skipped 1 · hist +1/~2",
    );
  });

  it("skips host recipe fetch in staticMode", async () => {
    let hostCalled = false;
    const creds = {
      email: "user@example.com",
      password: "secret",
      region: "international",
      languageType: 0,
    } as AccountCredentials;

    const stats = await syncCloudRecipesTwoWay(
      { creds, includeHistory: false, staticMode: true },
      {
        listAllHostRecipes: async () => {
          hostCalled = true;
          return [];
        },
        listAllLocalRecipes: () => [],
        syncAccountCatalog: async () => ({
          region: "international",
          targets: [],
          total_raw_records: 0,
          skipped: 0,
        }),
        importCloudSyncTargets: () => ({ stats: [], total: 0 }),
      },
    );

    assert.equal(hostCalled, false);
    assert.equal(stats.history, null);
    assert.equal(stats.region, "international");
  });
});
