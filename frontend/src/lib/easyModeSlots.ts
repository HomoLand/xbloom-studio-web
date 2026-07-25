/**
 * Easy / Auto Mode A/B/C slot helpers.
 *
 * App shows current slots via "Auto Mode Recipe" after BLE connect.
 * Public BLE only fully exposes write (11510). Read path used by the App is
 * primarily the account Easy-mode cloud list keyed by machine SN
 * (tuEasyModeList.tuhtml) — same as core catalog easy targets.
 *
 * We also remember the last batch WE wrote from this browser as a local cache
 * (not a substitute for live machine readback).
 */

import type { CoffeeRecipeContent, RecipeContent } from "../api.ts";
import { normaliseCloudRecipe } from "./cloudCatalog.ts";
import {
  isCoffeeContent,
  recipeDisplayName,
} from "./recipeDomain.ts";
import {
  BASE_URLS,
  ENDPOINTS,
  loginEphemeral,
  cloudRequest,
  type CloudRegion,
} from "./xbloomCloud.ts";

const LAST_WRITE_KEY = "xbloom.easyMode.lastWrite.v1";

export type EasySlotPosition = "A" | "B" | "C";

export type EasySlotView = {
  position: EasySlotPosition;
  name: string;
  content: CoffeeRecipeContent | null;
  scale: boolean;
  note?: string;
};

export type EasyModeSnapshot = {
  source: "cloud" | "local-write";
  sn?: string;
  region?: CloudRegion;
  slots: EasySlotView[];
  fetchedAt: string;
  warning?: string;
};

export type LastEasyWrite = {
  sn?: string | null;
  names: [string, string, string];
  recipeIds: [string, string, string];
  writtenAt: string;
};

export function readLastEasyWrite(): LastEasyWrite | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_WRITE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LastEasyWrite;
  } catch {
    return null;
  }
}

export function writeLastEasyWrite(entry: LastEasyWrite): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAST_WRITE_KEY, JSON.stringify(entry));
  } catch {
    /* ignore */
  }
}

/**
 * Fetch Easy-mode slot snapshot from the account API (App parity path).
 * Requires login + machine serial number (from BLE 40521).
 */
export async function fetchEasyModeSlotsFromCloud(opts: {
  email: string;
  password: string;
  region: string;
  sn: string;
  /** Member country id when known; 0 is accepted by many tenants. */
  countryId?: number;
  languageType?: number;
  timeoutMs?: number;
}): Promise<EasyModeSnapshot> {
  const sn = opts.sn.trim();
  if (!sn) throw new Error("Machine serial number is required for Easy-mode read");
  const { region, session } = await loginEphemeral(opts);
  const countryId =
    opts.countryId ??
    Number((session as { countryId?: number }).countryId ?? 0);

  const form: Record<string, unknown> = {
    ...session,
    sn,
    countryId: Number.isFinite(countryId) ? countryId : 0,
    tableId: 0,
  };

  let payload: unknown;
  let used: "easy" | "easy-default" = "easy";
  try {
    payload = await cloudRequest(
      BASE_URLS[region],
      ENDPOINTS.easy,
      form,
      opts.timeoutMs,
    );
  } catch (e) {
    // Fallback: factory default Easy list (may still show A/B/C structure).
    used = "easy-default";
    payload = await cloudRequest(
      BASE_URLS[region],
      ENDPOINTS["easy-default"],
      form,
      opts.timeoutMs,
    );
    if (!payload) throw e;
  }

  const slots = parseEasyModePayload(payload);
  if (slots.every((s) => !s.content)) {
    throw new Error(
      "Easy-mode cloud list returned no A/B/C recipes for this serial. " +
        "Open Auto Mode Recipe once in the official App, then retry. " +
        `(endpoint=${used})`,
    );
  }

  return {
    source: "cloud",
    sn,
    region,
    slots,
    fetchedAt: new Date().toISOString(),
    /** UI maps this code via i18n (`slots.easyDefaultWarn`). */
    warning: used === "easy-default" ? "easy-default" : undefined,
  };
}

/** Parse Easy-mode list / MMKV-style envelopes into A/B/C views (exported for tests). */
export function parseEasyModePayload(payload: unknown): EasySlotView[] {
  const byPos: Partial<Record<EasySlotPosition, EasySlotView>> = {};
  walkEasy(payload, {}, byPos);
  return (["A", "B", "C"] as EasySlotPosition[]).map((position) => {
    return (
      byPos[position] ?? {
        position,
        name: "—",
        content: null,
        scale: true,
        note: "empty",
      }
    );
  });
}

function walkEasy(
  node: unknown,
  ctx: { position?: EasySlotPosition; scale?: boolean },
  out: Partial<Record<EasySlotPosition, EasySlotView>>,
  depth = 0,
): void {
  if (depth > 10 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkEasy(item, ctx, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  const posRaw = obj.position ?? obj.slot;
  let position = ctx.position;
  if (typeof posRaw === "string") {
    const p = posRaw.trim().toUpperCase();
    if (p === "A" || p === "B" || p === "C") position = p;
  } else if (typeof posRaw === "number" && posRaw >= 0 && posRaw <= 2) {
    position = (["A", "B", "C"] as const)[posRaw];
  }

  let scale = ctx.scale ?? true;
  if (obj.scale != null) {
    const sv = Number(obj.scale);
    if (sv === 2) scale = false;
    else if (sv === 1 || sv === 0) scale = true;
  }

  const snapshot = obj.recipeSnapshotVo ?? obj.recipeSnapshot;
  if (snapshot && typeof snapshot === "object" && position) {
    try {
      const norm = normaliseCloudRecipe(
        snapshot as Record<string, unknown>,
        "auto",
      );
      if (isCoffeeContent(norm.content)) {
        out[position] = {
          position,
          name: norm.name || recipeDisplayName(norm.content),
          content: norm.content,
          scale,
        };
      } else {
        out[position] = {
          position,
          name: norm.name || "—",
          content: null,
          scale,
          note: "not coffee / not slot-compatible",
        };
      }
    } catch (e) {
      out[position] = {
        position,
        name: "—",
        content: null,
        scale,
        note: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Named recipe without nested snapshot (flat)
  if (
    position &&
    !out[position] &&
    (obj.theName != null || obj.name != null) &&
    (obj.pourList != null || obj.pourDataJSONStr != null || obj.dose != null)
  ) {
    try {
      const norm = normaliseCloudRecipe(obj, "auto");
      if (isCoffeeContent(norm.content)) {
        out[position] = {
          position,
          name: norm.name,
          content: norm.content,
          scale,
        };
      }
    } catch {
      /* ignore */
    }
  }

  const nextCtx = { position, scale };
  for (const key of [
    "easyModeDetailVoList",
    "DiskEasyModeDeviceList",
    "list",
    "data",
    "payload",
    "result",
  ]) {
    if (obj[key] != null) walkEasy(obj[key], nextCtx, out, depth + 1);
  }
  // Generic deep walk for device-id keyed maps
  for (const [k, v] of Object.entries(obj)) {
    if (
      k === "recipeSnapshotVo" ||
      k === "recipeSnapshot" ||
      [
        "easyModeDetailVoList",
        "DiskEasyModeDeviceList",
        "list",
        "data",
        "payload",
        "result",
      ].includes(k)
    ) {
      continue;
    }
    if (v && typeof v === "object") walkEasy(v, nextCtx, out, depth + 1);
  }
}

export function snapshotFromLocalWrite(
  names: [string, string, string],
  contents: [
    CoffeeRecipeContent,
    CoffeeRecipeContent,
    CoffeeRecipeContent,
  ],
  sn?: string | null,
): EasyModeSnapshot {
  return {
    source: "local-write",
    sn: sn ?? undefined,
    slots: (["A", "B", "C"] as EasySlotPosition[]).map((position, i) => ({
      position,
      name: names[i]!,
      content: contents[i]!,
      scale: true,
    })),
    fetchedAt: new Date().toISOString(),
    /** UI maps this code via i18n (`slots.lastWriteHint`). */
    warning: "local-write",
  };
}

export function contentLabel(c: RecipeContent | null | undefined): string {
  if (!c) return "—";
  return recipeDisplayName(c);
}
