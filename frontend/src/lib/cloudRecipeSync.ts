import { api, type RecipeContent, type RecipeRecord } from "../api.ts";
import type { AccountCredentials } from "./accountPrefs.ts";
import { importCloudSyncTargets } from "./cloudCatalog.ts";
import { isStaticDeploy } from "./deploy.ts";
import { importCloudBrewRecords } from "./localHistory.ts";
import {
  listAllLocalRecipes,
  promoteLocalToCloudOwned,
  recipeContentEquivalent,
  type LocalRecipeEntry,
} from "./localRecipes.ts";
import {
  applyCoffeeGrinderRpm,
  isCoffeeContent,
  recipeDisplayName,
} from "./recipeDomain.ts";
import {
  CLOUD_WRITE_CONFIRM,
  canUploadRecipeToCloud,
  fetchCloudBrewRecords,
  pushCloudRecipe,
  syncAccountCatalog,
  type CloudRegion,
} from "./xbloomCloud.ts";

export type TwoWaySyncStats = {
  region: CloudRegion;
  pushedCreated: number;
  pushedLinked: number;
  skippedUnsupported: number;
  imported: number;
  candidates: number;
  history:
    | { ok: true; imported: number; updated: number }
    | { ok: false }
    | null;
};

export type PushCandidate =
  | {
      storage: "host";
      recipe_id: string;
      content: RecipeContent;
    }
  | {
      storage: "local";
      recipe_id: string;
      content: RecipeContent;
      shareLink?: string | null;
      shareAuthor?: string | null;
    };

export type TwoWaySyncDeps = {
  listAllHostRecipes?: () => Promise<RecipeRecord[]>;
  setRecipeCloudMeta?: typeof api.setRecipeCloudMeta;
  listAllLocalRecipes?: () => LocalRecipeEntry[];
  promoteLocalToCloudOwned?: typeof promoteLocalToCloudOwned;
  pushCloudRecipe?: typeof pushCloudRecipe;
  syncAccountCatalog?: typeof syncAccountCatalog;
  importCloudSyncTargets?: typeof importCloudSyncTargets;
  fetchCloudBrewRecords?: typeof fetchCloudBrewRecords;
  importCloudBrewRecords?: typeof importCloudBrewRecords;
};

async function fetchAllActiveHostRecipes(): Promise<RecipeRecord[]> {
  const host: RecipeRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api.listRecipes({
      limit: 500,
      offset,
      include_archived: false,
    });
    host.push(...page.recipes);
    if (page.recipes.length < 500) break;
  }
  return host;
}

export function collectUnsyncedPushCandidates(
  hostRecipes: RecipeRecord[],
  localEntries: LocalRecipeEntry[],
): PushCandidate[] {
  const candidates: PushCandidate[] = [];
  const hostIds = new Set(hostRecipes.map((r) => r.recipe_id));
  const seenNames = new Set<string>();

  for (const r of hostRecipes) {
    if (r.archived_at) continue;
    if (r.source !== "web" && r.source !== "web-design") continue;
    const content = r.latest_revision?.content;
    if (!content) continue;
    if (r.metadata?.cloud_sync?.table_id != null) continue;
    candidates.push({
      storage: "host",
      recipe_id: r.recipe_id,
      content,
    });
    seenNames.add(recipeDisplayName(content).trim().toLowerCase());
  }

  for (const e of localEntries) {
    if (e.source !== "user" && e.source !== "design") continue;
    if (e.table_id != null) continue;
    if (
      e.recipe_id.startsWith("cloud:") ||
      e.recipe_id.startsWith("share:")
    ) {
      continue;
    }
    if (hostIds.has(e.recipe_id)) continue;
    const duplicateOnHost = hostRecipes.some((h) => {
      const hc = h.latest_revision?.content;
      if (!hc) return false;
      return (
        recipeDisplayName(hc).trim().toLowerCase() ===
          recipeDisplayName(e.content).trim().toLowerCase() &&
        recipeContentEquivalent(hc, e.content)
      );
    });
    if (duplicateOnHost) continue;
    const normName = recipeDisplayName(e.content).trim().toLowerCase();
    if (normName && seenNames.has(normName)) continue;
    candidates.push({
      storage: "local",
      recipe_id: e.recipe_id,
      content: e.content,
      shareLink: e.share_link,
      shareAuthor: e.share_author,
    });
    if (normName) seenNames.add(normName);
  }

  return candidates;
}

export async function syncCloudRecipesTwoWay(
  opts: {
    creds: AccountCredentials;
    includeHistory?: boolean;
    staticMode?: boolean;
  },
  deps: TwoWaySyncDeps = {},
): Promise<TwoWaySyncStats> {
  const staticMode = opts.staticMode ?? isStaticDeploy();
  const listHost = deps.listAllHostRecipes ?? fetchAllActiveHostRecipes;
  const setHostCloudMeta =
    deps.setRecipeCloudMeta ?? api.setRecipeCloudMeta;
  const listLocal = deps.listAllLocalRecipes ?? listAllLocalRecipes;
  const promoteLocal =
    deps.promoteLocalToCloudOwned ?? promoteLocalToCloudOwned;
  const pushFn = deps.pushCloudRecipe ?? pushCloudRecipe;
  const pullCatalog = deps.syncAccountCatalog ?? syncAccountCatalog;
  const importTargets = deps.importCloudSyncTargets ?? importCloudSyncTargets;
  const fetchHistory = deps.fetchCloudBrewRecords ?? fetchCloudBrewRecords;
  const importHistory = deps.importCloudBrewRecords ?? importCloudBrewRecords;

  const hostRecipes = staticMode ? [] : await listHost();
  const localEntries = listLocal();
  const pushQueue = collectUnsyncedPushCandidates(hostRecipes, localEntries);

  let pushedCreated = 0;
  let pushedLinked = 0;
  let skippedUnsupported = 0;

  for (const item of pushQueue) {
    const normalizedContent = isCoffeeContent(item.content)
      ? applyCoffeeGrinderRpm(item.content)
      : item.content;
    const check = canUploadRecipeToCloud(normalizedContent);
    if (!check.ok) {
      skippedUnsupported += 1;
      continue;
    }
    const res = await pushFn({
      email: opts.creds.email,
      password: opts.creds.password,
      region: opts.creds.region,
      content: normalizedContent,
      confirmWrite: CLOUD_WRITE_CONFIRM,
      languageType: opts.creds.languageType,
    });
    if (res.status === "created") pushedCreated += 1;
    else pushedLinked += 1;

    if (res.remote_table_id != null && res.remote_table_id > 0) {
      if (item.storage === "host") {
        await setHostCloudMeta(item.recipe_id, {
          table_id: res.remote_table_id,
          region: opts.creds.region,
        });
      } else {
        promoteLocal(item.recipe_id, {
          content: normalizedContent,
          tableId: res.remote_table_id,
          region: opts.creds.region,
          shareLink: item.shareLink,
          shareAuthor: item.shareAuthor,
        });
      }
    }
  }

  const pulled = await pullCatalog({
    email: opts.creds.email,
    password: opts.creds.password,
    region: opts.creds.region,
    languageType: opts.creds.languageType,
  });
  const importedRes = importTargets(pulled.targets, pulled.region);
  const imported = importedRes.stats.reduce((s, x) => s + x.imported, 0);
  const candidates = importedRes.stats.reduce((s, x) => s + x.candidates, 0);

  let history: TwoWaySyncStats["history"] = null;
  if (opts.includeHistory) {
    try {
      const hist = await fetchHistory({
        email: opts.creds.email,
        password: opts.creds.password,
        region: opts.creds.region,
        languageType: opts.creds.languageType,
      });
      const merged = importHistory(hist.records, hist.region);
      history = {
        ok: true,
        imported: merged.imported,
        updated: merged.updated,
      };
    } catch {
      history = { ok: false };
    }
  }

  return {
    region: pulled.region,
    pushedCreated,
    pushedLinked,
    skippedUnsupported,
    imported,
    candidates,
    history,
  };
}

export type TwoWaySyncTranslator = (
  key:
    | "cloud.syncDone"
    | "cloud.syncPushedNote"
    | "cloud.syncLinkedNote"
    | "cloud.syncSkippedNote"
    | "cloud.syncHistoryNote"
    | "cloud.syncHistoryFailed",
) => string;

export function formatTwoWaySyncSummary(
  stats: TwoWaySyncStats,
  t: TwoWaySyncTranslator,
): string {
  const parts: string[] = [];
  if (stats.pushedCreated > 0) {
    parts.push(
      t("cloud.syncPushedNote").replace(
        "{pushed}",
        String(stats.pushedCreated),
      ),
    );
  }
  if (stats.pushedLinked > 0) {
    parts.push(
      t("cloud.syncLinkedNote").replace(
        "{linked}",
        String(stats.pushedLinked),
      ),
    );
  }
  parts.push(
    t("cloud.syncDone")
      .replace("{imported}", String(stats.imported))
      .replace("{candidates}", String(stats.candidates))
      .replace("{region}", stats.region),
  );
  if (stats.skippedUnsupported > 0) {
    parts.push(
      t("cloud.syncSkippedNote").replace(
        "{skipped}",
        String(stats.skippedUnsupported),
      ),
    );
  }
  if (stats.history) {
    if (stats.history.ok) {
      parts.push(
        t("cloud.syncHistoryNote")
          .replace("{imported}", String(stats.history.imported))
          .replace("{updated}", String(stats.history.updated)),
      );
    } else {
      parts.push(t("cloud.syncHistoryFailed"));
    }
  }
  return parts.join(" · ");
}
