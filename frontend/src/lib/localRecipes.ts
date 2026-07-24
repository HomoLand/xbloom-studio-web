/**
 * Browser-local recipe catalog for static GitHub Pages / offline use.
 * Official seeds ship in the bundle; user recipes persist in localStorage.
 */

import type { CoffeeRecipeContent, RecipeContent, RecipeRecord, RecipeRevision } from "../api.ts";
import official, { type OfficialSeed } from "../data/officialRecipes.ts";
import { defaultCoffeeRecipe, isCoffeeContent, recipeDisplayName } from "./recipeDomain.ts";

const USER_KEY = "xbloom.userRecipes.v1";

export type LocalRecipeSource = "official" | "user" | "design" | "cloud";

export type LocalRecipeEntry = {
  recipe_id: string;
  name: string;
  kind: string;
  source: LocalRecipeSource;
  content: RecipeContent;
  updated_at: string;
  created_at: string;
  /** Remote xBloom account tableId when source=cloud or after push. */
  table_id?: number | null;
  region?: string;
  origin?: string;
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

function normalizeRecipeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable-ish content compare so imported JSON clones match bundled starters. */
export function recipeContentEquivalent(
  a: RecipeContent,
  b: RecipeContent,
): boolean {
  try {
    return (
      JSON.stringify(normalizeContentForCompare(a)) ===
      JSON.stringify(normalizeContentForCompare(b))
    );
  } catch {
    return false;
  }
}

function normalizeContentForCompare(content: RecipeContent): unknown {
  // Drop volatile fields; compare the brew-relevant shape.
  const c = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  delete c.note;
  if (typeof c.name === "string") {
    c.name = normalizeRecipeName(c.name);
  }
  if (Array.isArray(c.pours)) {
    c.pours = (c.pours as Array<Record<string, unknown>>).map((p) => {
      const q = { ...p };
      if (typeof q.label === "string") q.label = q.label.trim();
      return q;
    });
  }
  return c;
}

/**
 * Drop localStorage user clones that only duplicate a bundled official starter
 * (same display name + same content). Common after importing
 * public/recipes/tea-baihao-yinzhen.json while the starter is also shipped.
 */
export function pruneOfficialClonesFromUserStore(): number {
  const offs = officialEntries();
  const users = readUserRaw();
  const next = users.filter((u) => {
    // Never prune cloud rows with a table id — those are account catalog.
    if (u.source === "cloud" || u.table_id != null) return true;
    const twin = offs.find(
      (o) =>
        normalizeRecipeName(o.name) === normalizeRecipeName(u.name) &&
        recipeContentEquivalent(o.content, u.content),
    );
    return !twin;
  });
  const removed = users.length - next.length;
  if (removed > 0) writeUserRaw(next);
  return removed;
}

let prunedThisSession = false;

export function listAllLocalRecipes(): LocalRecipeEntry[] {
  // One soft cleanup per tab session so “我的 + 官方” clones disappear.
  if (!prunedThisSession && typeof localStorage !== "undefined") {
    prunedThisSession = true;
    try {
      pruneOfficialClonesFromUserStore();
    } catch {
      /* ignore */
    }
  }

  const offs = officialEntries();
  const users = readUserRaw();
  const officialIds = new Set(offs.map((o) => o.recipe_id));
  const userById = new Map(users.map((u) => [u.recipe_id, u]));

  // User clone of an official (same name + same content) → hide user, keep official.
  // User edit of same name (different content) → show user, hide that official.
  const suppressOfficialIds = new Set<string>();
  const suppressUserIds = new Set<string>();

  for (const u of users) {
    if (u.source === "cloud" || u.table_id != null) continue;
    const twin = offs.find(
      (o) => normalizeRecipeName(o.name) === normalizeRecipeName(u.name),
    );
    if (!twin) continue;
    if (recipeContentEquivalent(u.content, twin.content)) {
      suppressUserIds.add(u.recipe_id);
    } else {
      // Customized fork with the same title — prefer the user's version.
      suppressOfficialIds.add(twin.recipe_id);
    }
  }

  const merged: LocalRecipeEntry[] = [];
  for (const o of offs) {
    if (suppressOfficialIds.has(o.recipe_id)) {
      const override =
        users.find(
          (u) =>
            !suppressUserIds.has(u.recipe_id) &&
            normalizeRecipeName(u.name) === normalizeRecipeName(o.name),
        ) ?? null;
      if (override) {
        merged.push(override);
        suppressUserIds.add(override.recipe_id);
      }
      continue;
    }
    const byId = userById.get(o.recipe_id);
    if (byId) {
      merged.push(byId);
      suppressUserIds.add(byId.recipe_id);
    } else {
      merged.push(o);
    }
  }

  for (const u of users) {
    if (suppressUserIds.has(u.recipe_id)) continue;
    if (officialIds.has(u.recipe_id) && u.source === "official") continue;
    merged.push(u);
  }

  return merged.sort((a, b) => {
    if (a.source === "official" && b.source !== "official") return -1;
    if (b.source === "official" && a.source !== "official") return 1;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
}

export function getLocalRecipe(recipeId: string): LocalRecipeEntry | null {
  return listAllLocalRecipes().find((r) => r.recipe_id === recipeId) ?? null;
}

/** Resolve ``recipe_id:rev1`` or bare recipe_id to a local entry. */
export function getLocalRecipeByRevisionId(
  revisionId: string | null | undefined,
): LocalRecipeEntry | null {
  if (!revisionId) return null;
  const id = revisionId.trim();
  if (!id) return null;
  if (id.endsWith(":rev1")) {
    return getLocalRecipe(id.slice(0, -":rev1".length));
  }
  const direct = getLocalRecipe(id);
  if (direct) return direct;
  return (
    listAllLocalRecipes().find(
      (r) => `${r.recipe_id}:rev1` === id || r.recipe_id === id,
    ) ?? null
  );
}

/** Find a recipe for “brew again” from history metadata. */
export function findLocalRecipeForRebrew(opts: {
  recipe_revision_id?: string | null;
  recipe_name?: string | null;
}): LocalRecipeEntry | null {
  const byRev = getLocalRecipeByRevisionId(opts.recipe_revision_id ?? null);
  if (byRev) return byRev;
  const name = (opts.recipe_name || "").trim();
  if (!name) return null;
  const all = listAllLocalRecipes();
  return (
    all.find((r) => r.name === name) ??
    all.find((r) => recipeDisplayName(r.content) === name) ??
    all.find((r) => r.name.includes(name) || name.includes(r.name)) ??
    null
  );
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

/** Create or update a user/cloud recipe in localStorage. */
export function saveUserRecipe(
  content: RecipeContent,
  opts?: {
    recipeId?: string;
    source?: LocalRecipeSource;
    tableId?: number | null;
    region?: string;
    origin?: string;
  },
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
  const prev = existingIdx >= 0 ? users[existingIdx]! : null;
  const entry: LocalRecipeEntry = {
    recipe_id: recipeId,
    name,
    kind,
    source: opts?.source ?? prev?.source ?? "user",
    content: JSON.parse(JSON.stringify(content)) as RecipeContent,
    created_at: prev?.created_at ?? t,
    updated_at: t,
    table_id:
      opts?.tableId !== undefined ? opts.tableId : (prev?.table_id ?? null),
    region: opts?.region ?? prev?.region,
    origin: opts?.origin ?? prev?.origin,
  };
  if (existingIdx >= 0) users[existingIdx] = entry;
  else users.unshift(entry);
  writeUserRaw(users);
  return entry;
}

export function deleteUserRecipe(recipeId: string): boolean {
  // Only removes rows from the user store. Bundled official/starter ids that
  // were never saved to localStorage cannot be deleted.
  const users = readUserRaw();
  if (!users.some((u) => u.recipe_id === recipeId)) return false;
  writeUserRaw(users.filter((u) => u.recipe_id !== recipeId));
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
