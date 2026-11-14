/**
 * Browser-local recipe catalog for static GitHub Pages / offline use.
 *
 * - No fake "official" seeds: xBloom App/cloud recipes become 官方 after sync.
 * - User-created cloud recipes and local saves are 我的.
 * - Design candidates stay 设计.
 */

import type {
  CloudSyncMeta,
  CoffeeRecipeContent,
  RecipeContent,
  RecipeRecord,
  RecipeRevision,
} from "../api.ts";
import {
  applyCoffeeGrinderRpm,
  defaultCoffeeRecipe,
  isCoffeeContent,
  recipeDisplayName,
} from "./recipeDomain.ts";

const USER_KEY = "xbloom.userRecipes.v1";

/**
 * UI / storage provenance.
 * - official: App host catalog
 * - shared: received via App share list or H5 import
 * - user: account-created or local save
 * - design: Design page
 * - cloud: legacy (migrated on read)
 */
export type LocalRecipeSource =
  | "official"
  | "user"
  | "design"
  | "shared"
  | "cloud";

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
  /** Sync target that produced this row: coffee | tea | created | shared | … */
  origin?: string;
  /** App H5 share URL when known (shareRecipeLink). */
  share_link?: string | null;
  /** Display name of the sharer when imported from H5 / shared list. */
  share_author?: string | null;
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
): "official" | "user" | "shared" {
  const places = parseAppPlaces(raw);
  // App place bits from Android catalog (see core xbloom_catalog._origin).
  if (places.includes(5)) return "shared";
  if (places.includes(4)) return "user";
  if (places.includes(6) || places.includes(2)) return "official";

  const t = (target || "").toLowerCase();
  if (t === "shared") return "shared";
  if (t === "created") return "user";
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

  let next: LocalRecipeEntry = entry;

  if (next.source === "cloud") {
    next = {
      ...next,
      source: classifyCloudRecipeSource(next.origin || "", null),
    };
  }
  // Old mapping put shared under "user" — restore when origin is known.
  if (next.source === "user" && next.origin === "shared") {
    next = { ...next, source: "shared" };
  }
  // Share-link imports used to copy the *author's* tableId. Only clear when the
  // row is still a pure share import (share:… id) that was never uploaded to
  // this account. Do NOT strip table_id from cloud:… / created sync rows.
  if (
    next.recipe_id.startsWith("share:") &&
    next.origin === "shared" &&
    next.table_id != null
  ) {
    // If table_id was set by a later pushCloudRecipe, recipe stays share:… but
    // table_id is the user's own — keep it. We only clear when table_id equals
    // the id embedded in share:{region}:{authorTableId} (import default).
    const embedded = /^share:[^:]+:(\d+)$/.exec(next.recipe_id);
    if (embedded && Number(embedded[1]) === Number(next.table_id)) {
      next = { ...next, table_id: null };
    }
  }

  // Heal missing table_id for account-synced rows: cloud:china:12345
  if (next.table_id == null) {
    const owned = parseOwnedTableIdFromRecipeId(next.recipe_id);
    if (owned != null) next = { ...next, table_id: owned };
  }
  return next;
}

/** Account-owned cloud table id from recipe_id or explicit field. */
export function resolveOwnedTableId(
  entry: LocalRecipeEntry | null | undefined,
): number | null {
  if (!entry) return null;
  if (entry.table_id != null && Number(entry.table_id) > 0) {
    // share:{region}:{authorId} with same table_id is NOT owned
    const embedded = /^share:[^:]+:(\d+)$/.exec(entry.recipe_id);
    if (
      entry.origin === "shared" &&
      embedded &&
      Number(embedded[1]) === Number(entry.table_id)
    ) {
      return null;
    }
    return Number(entry.table_id);
  }
  return parseOwnedTableIdFromRecipeId(entry.recipe_id);
}

function parseOwnedTableIdFromRecipeId(recipeId: string): number | null {
  const m = /^cloud:(?:china|international):(\d+)$/i.exec(recipeId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * True when this browser row has a cloud table id on *this* account
 * (can call created-list delete). Independent of UI label:
 * - 分享 import only local → false
 * - 分享 import then 上传 → true (label stays 分享 via source=shared)
 * - 我的 / created → true
 * - 官方 / product / pure inbound shared-list → false
 */
export function isOwnedOnCloud(
  entry: LocalRecipeEntry | null | undefined,
): boolean {
  if (!entry) return false;
  if (entry.source === "official") return false;
  if (
    entry.origin === "coffee" ||
    entry.origin === "tea" ||
    entry.origin === "product"
  ) {
    return false;
  }
  const tid = resolveOwnedTableId(entry);
  if (tid == null) return false;

  // Pure share-list sync (never uploaded by us): origin stays "shared" and id
  // is cloud:… from App shared endpoint — not on created-list for delete.
  if (entry.origin === "shared" && entry.source === "shared") {
    // Local share:… row that already has *our* table_id (post-upload, pre-rekey)
    return entry.recipe_id.startsWith("share:");
  }

  // Uploaded share keeps source=shared but origin becomes "created".
  // User-created and design-promoted rows use source=user / origin=created.
  return (
    entry.source === "user" ||
    entry.origin === "created" ||
    entry.source === "shared"
  );
}

function ensureMigratedStore(): LocalRecipeEntry[] {
  const raw = readUserRaw();
  const next = raw
    .map(migrateEntry)
    .filter((e): e is LocalRecipeEntry => e != null);
  const needsWrite =
    raw.length !== next.length ||
    raw.some((u) => {
      const n = next.find((x) => x.recipe_id === u.recipe_id);
      if (!n) return true;
      return n.source !== u.source || n.table_id !== u.table_id;
    });
  if (needsWrite) {
    writeUserRaw(next);
  }
  return next;
}

export function listAllLocalRecipes(): LocalRecipeEntry[] {
  // Migrate + drop share clones when a cloud-owned twin exists.
  pruneRedundantShareCopies();
  const entries = ensureMigratedStore();
  // Official (App) first, then user/design by recency; shared last among peers.
  return [...entries].sort((a, b) => {
    if (a.source === "official" && b.source !== "official") return -1;
    if (b.source === "official" && a.source !== "official") return 1;
    if (a.source === "shared" && b.source !== "shared") return 1;
    if (b.source === "shared" && a.source !== "shared") return -1;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
}

/**
 * After share-import → upload → account sync, the same brew may exist as
 * share:… (local import) and cloud:… (this account's copy). Keep the cloud row.
 */
export function pruneRedundantShareCopies(): number {
  const raw = readUserRaw();
  const keep = dedupeShareVsCloudCopies(raw);
  const removed = raw.length - keep.length;
  if (removed > 0) writeUserRaw(keep);
  return removed;
}

/**
 * After a successful upload, re-key to cloud:{region}:{tableId} so delete works.
 *
 * Provenance: if the recipe was a share import (or still carries share meta),
 * keep UI source **分享** (`shared`). Ownership for 删除云端 is `table_id` +
 * origin `created` (this account's created list), not the label.
 */
export function promoteLocalToCloudOwned(
  oldRecipeId: string,
  opts: {
    content: RecipeContent;
    tableId: number;
    region: string;
    shareLink?: string | null;
    shareAuthor?: string | null;
  },
): LocalRecipeEntry {
  const prev =
    readUserRaw().find((e) => e.recipe_id === oldRecipeId) ?? null;
  const fromShare =
    oldRecipeId.startsWith("share:") ||
    prev?.source === "shared" ||
    prev?.origin === "shared" ||
    Boolean(opts.shareLink || opts.shareAuthor || prev?.share_link);

  const newId = `cloud:${opts.region}:${opts.tableId}`;
  if (oldRecipeId !== newId) {
    deleteUserRecipe(oldRecipeId);
  }
  return saveUserRecipe(opts.content, {
    recipeId: newId,
    // Label stays 分享 when provenance is share; otherwise 我的.
    source: fromShare ? "shared" : "user",
    tableId: opts.tableId,
    region: opts.region,
    // Created-list membership (delete / update), not UI badge.
    origin: "created",
    shareLink: opts.shareLink ?? prev?.share_link,
    shareAuthor: opts.shareAuthor ?? prev?.share_author,
  });
}

function dedupeShareVsCloudCopies(
  entries: LocalRecipeEntry[],
): LocalRecipeEntry[] {
  const owned = entries.filter(
    (e) =>
      e.recipe_id.startsWith("cloud:") ||
      (e.source === "user" && e.table_id != null) ||
      (e.origin === "created" && e.table_id != null),
  );
  if (owned.length === 0) return entries;

  return entries.filter((e) => {
    // Never drop account cloud rows — including uploaded shares that keep
    // source=shared (UI 分享) with recipe_id cloud:region:tableId.
    if (e.recipe_id.startsWith("cloud:")) return true;
    // Only prune local share-import clones (share:… / legacy local shared).
    if (!e.recipe_id.startsWith("share:") && e.source !== "shared") return true;
    const twin = owned.find((o) => {
      if (o.recipe_id === e.recipe_id) return false;
      if (e.table_id != null && o.table_id != null && e.table_id === o.table_id) {
        return true;
      }
      if (normalizeRecipeName(o.name) !== normalizeRecipeName(e.name)) {
        return false;
      }
      if (recipeContentEquivalent(o.content, e.content)) return true;
      return o.recipe_id.startsWith("cloud:");
    });
    return !twin;
  });
}

function normalizeRecipeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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
  const ownedTid = isOwnedOnCloud(entry) ? resolveOwnedTableId(entry) : null;
  const region: "china" | "international" | null =
    entry.region === "china" || entry.region === "international"
      ? entry.region
      : null;
  const cloudSync: CloudSyncMeta | undefined =
    ownedTid != null && region
      ? {
          table_id: ownedTid,
          region,
          ...(entry.share_link ? { share_link: entry.share_link } : {}),
        }
      : undefined;
  return {
    recipe_id: entry.recipe_id,
    name: entry.name,
    kind: entry.kind,
    source: entry.source,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    ...(cloudSync ? { metadata: { cloud_sync: cloudSync } } : {}),
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
    shareLink?: string | null;
    shareAuthor?: string | null;
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
    share_link:
      opts?.shareLink !== undefined
        ? opts.shareLink
        : (prev?.share_link ?? null),
    share_author:
      opts?.shareAuthor !== undefined
        ? opts.shareAuthor
        : (prev?.share_author ?? null),
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
  return { valid: true, content: applyCoffeeGrinderRpm(c) };
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
