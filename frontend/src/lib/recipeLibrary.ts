import type { RecipeContent, RecipeRecord } from "../api.ts";
import { isCoffeeContent } from "./recipeDomain.ts";

/** A cloud row has different IDs in the host catalog and old browser caches. */
function cloudIdentity(recipe: RecipeRecord): string | null {
  const direct = /^cloud:(china|international):(.+)$/.exec(recipe.recipe_id);
  if (direct) return `${direct[1]}:${direct[2]}`;
  const envelope = recipe.metadata?.catalog_envelope as {
    table_id?: number;
    sources?: Array<{ region?: string }>;
  } | undefined;
  const region = envelope?.sources?.find(source => source.region)?.region;
  return envelope?.table_id != null && region ? `${region}:${envelope.table_id}` : null;
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
