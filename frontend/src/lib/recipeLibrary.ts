import type { RecipeContent, RecipeRecord } from "../api.ts";
import {
  isOwnedOnCloud,
  resolveOwnedTableId,
  type LocalRecipeEntry,
} from "./localRecipes.ts";
import { isCoffeeContent } from "./recipeDomain.ts";

/** A cloud row has different IDs in the host catalog and old browser caches. */
function cloudIdentity(recipe: RecipeRecord): string | null {
  const direct = /^cloud:(china|international):(.+)$/.exec(recipe.recipe_id);
  if (direct) return `${direct[1]}:${direct[2]}`;
  const cs = recipe.metadata?.cloud_sync;
  if (
    cs &&
    cs.table_id != null &&
    Number(cs.table_id) > 0 &&
    (cs.region === "china" || cs.region === "international")
  ) {
    return `${cs.region}:${Number(cs.table_id)}`;
  }
  const envelope = recipe.metadata?.catalog_envelope as {
    table_id?: number;
    sources?: Array<{ region?: string }>;
  } | undefined;
  const region = envelope?.sources?.find(source => source.region)?.region;
  return envelope?.table_id != null && region ? `${region}:${envelope.table_id}` : null;
}

export type RecipeCloudState = {
  ownedTableId: number | null;
  region: "china" | "international" | null;
  isOwned: boolean;
  shareLink: string | null;
  shareAuthor: string | null;
};

export function getRecipeCloudState(
  recipe: RecipeRecord | null | undefined,
  localEntry?: LocalRecipeEntry | null,
): RecipeCloudState {
  if (recipe?.source === "official" || localEntry?.source === "official") {
    return {
      ownedTableId: null,
      region: null,
      isOwned: false,
      shareLink: localEntry?.share_link ?? null,
      shareAuthor: localEntry?.share_author ?? null,
    };
  }
  const cs = recipe?.metadata?.cloud_sync;
  if (
    cs &&
    cs.table_id != null &&
    Number(cs.table_id) > 0 &&
    (cs.region === "china" || cs.region === "international")
  ) {
    return {
      ownedTableId: Number(cs.table_id),
      region: cs.region,
      isOwned: true,
      shareLink: cs.share_link ?? localEntry?.share_link ?? null,
      shareAuthor: localEntry?.share_author ?? null,
    };
  }
  const localRegion =
    localEntry?.region === "china" || localEntry?.region === "international"
      ? localEntry.region
      : null;
  return {
    ownedTableId: resolveOwnedTableId(localEntry),
    region: localRegion,
    isOwned: isOwnedOnCloud(localEntry),
    shareLink: localEntry?.share_link ?? null,
    shareAuthor: localEntry?.share_author ?? null,
  };
}

function complete(content: RecipeContent | undefined): content is RecipeContent {
  return Boolean(content && Array.isArray(content.pours) && content.pours.length &&
    content.pours.every(pour => Number(pour.ml) > 0 && pour.temp_c != null));
}

/** Compare brew parameters, keeping different named beans and real variants separate. */
function signature(recipe: RecipeRecord): string {
  const content = recipe.latest_revision!.content;
  const coffee = isCoffeeContent(content);
  return JSON.stringify([
    recipe.name?.trim(), content.kind,
    coffee ? [content.dripper?.toLowerCase().startsWith("omni") ? "omni" : content.dripper,
      content.dose_g, content.grind, content.water_ml,
      content.hot_water_ml ?? (content.kind === "hot" ? content.water_ml : null),
      content.ice_g ?? 0, content.bypass_ml ?? 0,
      content.bypass_ml ? content.bypass_temp_c : null]
      : [content.leaf_g, content.output_ml_per_steep],
    content.pours.map(pour => [pour.ml, pour.temp_c, pour.pattern, pour.pause_s,
      pour.flow_ml_s, "rpm" in pour ? pour.rpm : null,
      "vibration" in pour ? pour.vibration ?? "none" : "none"]),
  ]);
}

export function mergeRecipeLibrary(host: RecipeRecord[], local: RecipeRecord[]): RecipeRecord[] {
  // Include archived host identities so a browser sync cannot resurrect them.
  const hostIds = new Set(host.map(recipe => recipe.recipe_id));
  const cloudIds = new Set(host.map(cloudIdentity).filter(Boolean));
  const candidates = [
    ...host.filter(recipe => !recipe.archived_at),
    ...local.filter(recipe => !hostIds.has(recipe.recipe_id) && !cloudIds.has(cloudIdentity(recipe))),
  ];
  const unique = new Map<string, RecipeRecord>();
  for (const recipe of candidates) {
    if (!complete(recipe.latest_revision?.content)) continue;
    const key = signature(recipe);
    const previous = unique.get(key);
    // Prefer an explicitly saved recipe over a transient bridge-load snapshot.
    if (!previous || (previous.source === "bridge_load" && recipe.source === "web")) {
      unique.set(key, recipe);
    }
  }
  return [...unique.values()];
}
