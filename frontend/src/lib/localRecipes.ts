/**
 * Browser-local recipe catalog for static GitHub Pages / offline use.
 * Official seeds ship in the bundle; user recipes persist in localStorage.
 */

import type { CoffeeRecipeContent, RecipeContent, RecipeRecord, RecipeRevision } from "../api.ts";
import official, { type OfficialSeed } from "../data/officialRecipes.ts";
import { defaultCoffeeRecipe, isCoffeeContent, recipeDisplayName } from "./recipeDomain.ts";

const USER_KEY = "xbloom.userRecipes.v1";

export type LocalRecipeSource = "official" | "user" | "design";

export type LocalRecipeEntry = {
  recipe_id: string;
  name: string;
  kind: string;
  source: LocalRecipeSource;
  content: RecipeContent;
  updated_at: string;
  created_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function readUserRaw(): LocalRecipeEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is LocalRecipeEntry =>
        !!x &&
        typeof x === "object" &&
        typeof (x as LocalRecipeEntry).recipe_id === "string" &&
        typeof (x as LocalRecipeEntry).content === "object",
    );
  } catch {
    return [];
  }
}

function writeUserRaw(entries: LocalRecipeEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(USER_KEY, JSON.stringify(entries));
}

function officialEntries(): LocalRecipeEntry[] {
  const seeds = official as OfficialSeed[];
  const t = nowIso();
  return seeds.map((s) => ({
    recipe_id: s.recipe_id,
    name: s.name,
    kind: s.kind,
    source: "official" as const,
    content: s.content,
    created_at: t,
    updated_at: t,
  }));
}

export function listAllLocalRecipes(): LocalRecipeEntry[] {
  const users = readUserRaw();
  const officialIds = new Set(officialEntries().map((o) => o.recipe_id));
  // User entries override official when same id (rare).
  const userById = new Map(users.map((u) => [u.recipe_id, u]));
  const merged: LocalRecipeEntry[] = [];
  for (const o of officialEntries()) {
    merged.push(userById.get(o.recipe_id) ?? o);
    userById.delete(o.recipe_id);
  }
  for (const u of userById.values()) {
    if (!officialIds.has(u.recipe_id) || u.source !== "official") {
      merged.push(u);
    }
  }
  // Sort: official first, then user by updated_at desc
  return merged.sort((a, b) => {
    if (a.source === "official" && b.source !== "official") return -1;
    if (b.source === "official" && a.source !== "official") return 1;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
}

export function getLocalRecipe(recipeId: string): LocalRecipeEntry | null {
  return listAllLocalRecipes().find((r) => r.recipe_id === recipeId) ?? null;
}

export function toRecipeRecord(entry: LocalRecipeEntry): RecipeRecord {
  const rev = toLatestRevision(entry);
  return {
    recipe_id: entry.recipe_id,
    name: entry.name,
    kind: entry.kind,
    source: entry.source,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    latest_revision: rev,
  };
}

export function toLatestRevision(entry: LocalRecipeEntry): RecipeRevision {
  return {
    revision_id: `${entry.recipe_id}:rev1`,
    recipe_id: entry.recipe_id,
    revision_number: 1,
    content: entry.content,
    name: entry.name,
    source: entry.source,
    created_at: entry.updated_at,
  };
}

function newUserId(): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Date.now().toString(16);
  return `user:${id}`;
}

/** Create or update a user recipe in localStorage. */
export function saveUserRecipe(
  content: RecipeContent,
  opts?: { recipeId?: string; source?: LocalRecipeSource },
): LocalRecipeEntry {
  const name = recipeDisplayName(content);
  const kind =
    typeof (content as { kind?: string }).kind === "string"
      ? String((content as { kind: string }).kind)
      : "hot";
  const t = nowIso();
  const users = readUserRaw();
  const recipeId = opts?.recipeId ?? newUserId();
  const existingIdx = users.findIndex((u) => u.recipe_id === recipeId);
  const entry: LocalRecipeEntry = {
    recipe_id: recipeId,
    name,
    kind,
    source: opts?.source ?? "user",
    content: JSON.parse(JSON.stringify(content)) as RecipeContent,
    created_at: existingIdx >= 0 ? users[existingIdx]!.created_at : t,
    updated_at: t,
  };
  if (existingIdx >= 0) users[existingIdx] = entry;
  else users.unshift(entry);
  writeUserRaw(users);
  return entry;
}

export function deleteUserRecipe(recipeId: string): boolean {
  if (recipeId.startsWith("official:")) return false;
  const users = readUserRaw().filter((u) => u.recipe_id !== recipeId);
  writeUserRaw(users);
  return true;
}

/** Client-side coffee shape check (no Python core). */
export function validateLocalContent(
  content: RecipeContent,
): { valid: true; content: RecipeContent } | { valid: false; message: string } {
  if (!content || typeof content !== "object") {
    return { valid: false, message: "Empty recipe" };
  }
  if (!isCoffeeContent(content)) {
    // Tea: minimal check
    const tea = content as { leaf_g?: number; pours?: unknown[] };
    if (!(Number(tea.leaf_g) > 0) || !Array.isArray(tea.pours) || tea.pours.length < 1) {
      return { valid: false, message: "Tea recipe needs leaf_g and pours" };
    }
    return { valid: true, content };
  }
  const c = content as CoffeeRecipeContent;
  if (!(Number(c.dose_g) > 0)) return { valid: false, message: "dose_g must be > 0" };
  if (Number(c.grind) < 0 || Number(c.grind) > 80) {
    return { valid: false, message: "grind must be 0–80" };
  }
  if (!Array.isArray(c.pours) || c.pours.length < 1) {
    return { valid: false, message: "at least one pour required" };
  }
  for (let i = 0; i < c.pours.length; i++) {
    const p = c.pours[i]!;
    if (!(Number(p.ml) > 0)) return { valid: false, message: `pour ${i + 1}: ml` };
  }
  return { valid: true, content };
}

export function sampleCoffeeIfEmpty(): CoffeeRecipeContent {
  const first = officialEntries().find((e) => isCoffeeContent(e.content));
  if (first && isCoffeeContent(first.content)) {
    return JSON.parse(JSON.stringify(first.content)) as CoffeeRecipeContent;
  }
  return defaultCoffeeRecipe();
}
