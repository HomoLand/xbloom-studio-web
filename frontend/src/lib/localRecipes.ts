/**
 * Browser-local recipe catalog for static GitHub Pages / offline use.
 *
 * - No fake "official" seeds: xBloom App/cloud recipes become 官方 after sync.
 * - User-created cloud recipes and local saves are 我的.
 * - Design candidates stay 设计.
 */

import type {
  CoffeeRecipeContent,
  RecipeContent,
  RecipeRecord,
  RecipeRevision,
} from "../api.ts";
import { defaultCoffeeRecipe, isCoffeeContent, recipeDisplayName } from "./recipeDomain.ts";

const USER_KEY = "xbloom.userRecipes.v1";

/** UI / storage provenance. ``cloud`` is legacy; migrated to official|user on read. */
export type LocalRecipeSource = "official" | "user" | "design" | "cloud";

export type LocalRecipeEntry = {
  recipe_id: string;
  name: string;
  kind: string;
  source: LocalRecipeSource;
  content: RecipeContent;
  updated_at: string;
  created_at: string;
  /** Remote xBloom account tableId when synced from cloud. */
  table_id?: number | null;
  region?: string;
  /** Sync target that produced this row: coffee | tea | created | … */
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

/**
 * Map a cloud sync target (+ optional appPlaceList) to UI source.
 * Aligns with packages/core/xbloom_catalog._origin endpoints.
 */
export function classifyCloudRecipeSource(
  target: string,
  raw?: Record<string, unknown> | null,
): "official" | "user" {
  const places = parseAppPlaces(raw);
  // App place bits from Android catalog (see core xbloom_catalog._origin).
  if (places.includes(4) || places.includes(5)) return "user";
  if (places.includes(6) || places.includes(2)) return "official";

  const t = (target || "").toLowerCase();
  if (t === "created" || t === "shared") return "user";
  // Host coffee/tea, product, easy defaults → treat as xBloom-provided.
  if (
    t === "coffee" ||
    t === "tea" ||
    t === "product" ||
    t === "easy" ||
    t === "easy-default"
  ) {
    return "official";
  }
  return "user";
}

function parseAppPlaces(raw?: Record<string, unknown> | null): number[] {
  if (!raw) return [];
  const v =
    raw.appPlaceList ??
    raw.app_place_list ??
    raw.appPlaces ??
    raw.placeList;
  if (Array.isArray(v)) {
    return v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n));
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

/**
 * Normalize legacy rows:
 * - old bundled seeds (official:*, starter:*) removed
 * - source "cloud" remapped via origin / app places to official|user
 */
function migrateEntry(entry: LocalRecipeEntry): LocalRecipeEntry | null {
  // Drop historical Skill seeds that were never real App catalog items.
  if (
    entry.recipe_id.startsWith("official:") ||
    entry.recipe_id.startsWith("starter:")
  ) {
    return null;
  }

  if (entry.source === "cloud") {
    const next = classifyCloudRecipeSource(entry.origin || "", null);
    return { ...entry, source: next };
  }
  return entry;
}

function ensureMigratedStore(): LocalRecipeEntry[] {
  const raw = readUserRaw();
  const next = raw
    .map(migrateEntry)
    .filter((e): e is LocalRecipeEntry => e != null);
  const needsWrite = raw.some(
    (u) =>
      u.recipe_id.startsWith("official:") ||
      u.recipe_id.startsWith("starter:") ||
      u.source === "cloud",
  );
  if (needsWrite) {
    writeUserRaw(next);
  }
  return next;
}

export function listAllLocalRecipes(): LocalRecipeEntry[] {
  const entries = ensureMigratedStore();
  // Official (App) first, then user/design by recency.
  return [...entries].sort((a, b) => {
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
  const users = readUserRaw().filter(
    (u) =>
      !u.recipe_id.startsWith("official:") &&
      !u.recipe_id.startsWith("starter:"),
  );
  const recipeId = opts?.recipeId ?? newUserId();
  const existingIdx = users.findIndex((u) => u.recipe_id === recipeId);
  const prev = existingIdx >= 0 ? users[existingIdx]! : null;
  let source: LocalRecipeSource =
    opts?.source ?? prev?.source ?? "user";
  // Never persist ambiguous "cloud" — resolve at write time when origin known.
  if (source === "cloud") {
    source = classifyCloudRecipeSource(opts?.origin ?? prev?.origin ?? "", null);
  }
  const entry: LocalRecipeEntry = {
    recipe_id: recipeId,
    name,
    kind,
    source,
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

/** Fallback coffee shape when catalog is empty (no App seed bundled). */
export function sampleCoffeeIfEmpty(): CoffeeRecipeContent {
  return defaultCoffeeRecipe();
}

// --- retained helpers used by tests / dedupe tooling ---

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
  const c = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  delete c.note;
  if (typeof c.name === "string") {
    c.name = c.name.trim().toLowerCase().replace(/\s+/g, " ");
  }
  return c;
}

/** @deprecated no bundled seeds; kept for call-site compatibility */
export function pruneOfficialClonesFromUserStore(): number {
  const before = readUserRaw().length;
  const next = readUserRaw().filter(
    (u) =>
      !u.recipe_id.startsWith("official:") &&
      !u.recipe_id.startsWith("starter:"),
  );
  writeUserRaw(next);
  return before - next.length;
}
