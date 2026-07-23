import type {
  CoffeePour,
  CoffeeRecipeContent,
  PourPattern,
  RecipeContent,
  TeaPour,
  TeaRecipeContent,
  Vibration,
} from "../api";

export function isTeaContent(content: RecipeContent): content is TeaRecipeContent {
  if (!content || typeof content !== "object") return false;
  const kind = (content as { kind?: unknown }).kind;
  return kind === "tea";
}

export function isCoffeeContent(content: RecipeContent): content is CoffeeRecipeContent {
  if (!content || typeof content !== "object") return false;
  const kind = (content as { kind?: unknown }).kind;
  return kind === "hot" || kind === "flash-brew";
}

export function storageKindOf(content: RecipeContent): "coffee" | "tea" {
  return isTeaContent(content) ? "tea" : "coffee";
}

/** Stable canonical identity for stale-response rejection (sequence + content). */
export function contentIdentity(content: RecipeContent): string {
  return JSON.stringify(content);
}

export function defaultCoffeePour(index: number): CoffeePour {
  return {
    label: index === 0 ? "Bloom" : `Pour ${index + 1}`,
    ml: index === 0 ? 45 : 90,
    temp_c: 92,
    pattern: "spiral",
    vibration: index === 0 ? "after" : "none",
    pause_s: index === 0 ? 30 : 10,
    rpm: 90,
    flow_ml_s: 3.2,
  };
}

export function defaultTeaPour(index: number): TeaPour {
  return {
    label: `Steep ${index + 1}`,
    ml: 80,
    temp_c: 90,
    pattern: "center",
    pause_s: 20,
    flow_ml_s: 3.2,
  };
}

export function defaultCoffeeRecipe(): CoffeeRecipeContent {
  return {
    name: "Untitled coffee",
    kind: "hot",
    dripper: "Omni Dripper 2",
    dose_g: 15,
    grind: 55,
    ratio: 16,
    water_ml: 240,
    hot_water_ml: 240,
    note: "",
    pours: [defaultCoffeePour(0), defaultCoffeePour(1)],
  };
}

export function defaultTeaRecipe(): TeaRecipeContent {
  return {
    name: "Untitled tea",
    kind: "tea",
    leaf_g: 4,
    output_ml_per_steep: 120,
    pours: [defaultTeaPour(0)],
  };
}

export function cloneContent<T extends RecipeContent>(content: T): T {
  return JSON.parse(JSON.stringify(content)) as T;
}

export const POUR_PATTERNS: PourPattern[] = ["spiral", "circular", "center", "ring"];
export const VIBRATIONS: Vibration[] = ["none", "before", "after", "both"];

export function recipeDisplayName(content: RecipeContent): string {
  const name = (content as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : "Untitled recipe";
}

export function shortId(id: string, keep = 8): string {
  if (!id) return "-";
  if (id.length <= keep + 4) return id;
  return `${id.slice(0, keep)}...`;
}

/** Format Unix epoch seconds (or ms if already large) for display. */
export function formatEpochSeconds(epoch: number | string | null | undefined): string {
  if (epoch == null || epoch === "") return "-";
  const n = typeof epoch === "number" ? epoch : Number(epoch);
  if (!Number.isFinite(n)) return String(epoch);
  // Heuristic: values under year ~2001 in ms are almost certainly seconds.
  const ms = n < 1e12 ? n * 1000 : n;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(epoch);
  }
}

/** Remaining time label from epoch-seconds expiry. */
export function formatRemainingFromEpoch(
  expiresAtEpochSeconds: number,
  nowMs: number = Date.now(),
): string {
  const ms = expiresAtEpochSeconds * 1000 - nowMs;
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${r}s`;
}

export function isEpochExpired(
  expiresAtEpochSeconds: number,
  nowMs: number = Date.now(),
): boolean {
  return expiresAtEpochSeconds * 1000 <= nowMs;
}
