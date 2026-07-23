/**
 * Import xBloom cloud recipe payloads into the local browser recipe store.
 * Lightweight port of xbloom_catalog normalise for coffee/tea display + brew.
 */

import type {
  CoffeePour,
  CoffeeRecipeContent,
  PourPattern,
  RecipeContent,
  TeaPour,
  TeaRecipeContent,
  Vibration,
} from "../api.ts";
import {
  collectRecipeRecords,
  type CloudRegion,
  type CloudSyncTargetResult,
} from "./xbloomCloud.ts";
import {
  saveUserRecipe,
  type LocalRecipeEntry,
  type LocalRecipeSource,
} from "./localRecipes.ts";

const APP_PATTERN_LABELS: Record<number, PourPattern> = {
  1: "center",
  2: "spiral",
  3: "circular",
};
const CODE_PATTERN_LABELS: Record<number, PourPattern> = {
  0: "center",
  1: "circular",
  2: "spiral",
};

export type CloudImportStats = {
  target: string;
  candidates: number;
  imported: number;
  skipped: number;
  errors: string[];
};

function first(
  raw: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") {
      return raw[k];
    }
  }
  return undefined;
}

function asNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonish(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function normalisePattern(stage: Record<string, unknown>): PourPattern {
  const raw = first(stage, "pattern", "pourPattern");
  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    if (s === "ring") return "circular";
    if (s === "center" || s === "spiral" || s === "circular") return s;
  }
  const n = asNumber(raw);
  if (n != null) {
    return APP_PATTERN_LABELS[n] ?? CODE_PATTERN_LABELS[n] ?? "center";
  }
  return "center";
}

function normaliseVibration(stage: Record<string, unknown>): Vibration {
  const before =
    asNumber(first(stage, "isEnableVibrationBefore")) === 1 ||
    stage.isEnableVibrationBefore === true;
  const after =
    asNumber(first(stage, "isEnableVibrationAfter")) === 1 ||
    stage.isEnableVibrationAfter === true;
  if (before && after) return "both";
  if (before) return "before";
  if (after) return "after";
  return "none";
}

function normalisePours(
  rawPours: unknown,
  opts: { tea: boolean; topRpm: number | null },
): Array<CoffeePour | TeaPour> {
  const list = parseJsonish(rawPours);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("recipe has no pour list");
  }
  return list.map((item) => {
    const obj =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {};
    let stage = obj;
    const sub = parseJsonish(obj.subStep);
    if (Array.isArray(sub) && sub[0] && typeof sub[0] === "object") {
      stage = { ...obj, ...(sub[0] as Record<string, unknown>) };
    }
    const pattern = normalisePattern(stage);
    let volume = first(stage, "volume", "ml");
    if (volume == null && "setting_pour_over_array" in stage) {
      volume = stage.setting_pour_over_array;
    }
    let pause = first(obj, "pausing", "pause_s", "pause");
    if (pause == null) pause = opts.tea ? 20 : 5;
    const temperature = first(
      obj,
      "temperature",
      "temp_c",
      "temp",
      "setting_bloom_temp",
    );
    let flow =
      asNumber(first(obj, "flowRate", "flow_ml_s", "flow")) ??
      (opts.tea ? 3.5 : 3.0);
    if (flow > 10) flow /= 10;
    const label = first(obj, "theName", "label");
    if (opts.tea) {
      const pour: TeaPour = {
        ml: Math.round(Number(volume) || 0),
        temp_c: Math.round(Number(temperature) || 90),
        pattern,
        pause_s: Math.round(Number(pause) || 20),
        flow_ml_s: flow,
      };
      if (label) pour.label = String(label);
      return pour;
    }
    const pour: CoffeePour = {
      ml: Math.round(Number(volume) || 0),
      temp_c: Math.round(Number(temperature) || 92),
      pattern,
      vibration: normaliseVibration(stage),
      pause_s: Math.round(Number(pause) || 5),
      flow_ml_s: flow,
      rpm:
        pattern === "center"
          ? 0
          : asNumber(first(obj, "rpm")) ?? opts.topRpm ?? 120,
    };
    if (label) pour.label = String(label);
    return pour;
  });
}

export function normaliseCloudRecipe(
  raw: Record<string, unknown>,
  kindHint: "auto" | "tea" | "coffee" = "auto",
): {
  content: RecipeContent;
  table_id: number | null;
  name: string;
  kind: string;
} {
  const cupType = asNumber(first(raw, "cupType", "cup_type"));
  const isTea =
    kindHint === "tea" ||
    String(raw.kind || "").toLowerCase() === "tea" ||
    cupType === 4;

  if (isTea) {
    const leaf = asNumber(first(raw, "dose", "leaf_g")) ?? 4;
    const pours = normalisePours(
      first(raw, "pourList", "pours", "pourDataJSONStr"),
      { tea: true, topRpm: null },
    ) as TeaPour[];
    const content: TeaRecipeContent = {
      name: String(first(raw, "theName", "name") ?? "Unnamed tea"),
      kind: "tea",
      leaf_g: leaf,
      output_ml_per_steep:
        asNumber(first(raw, "outputMlPerSteep", "output_ml_per_steep")) ?? 120,
      pours,
    };
    return {
      content,
      table_id: asNumber(first(raw, "tableId", "table_id", "recipeId")),
      name: content.name,
      kind: "tea",
    };
  }

  const dose = asNumber(first(raw, "dose", "dose_g"));
  if (dose == null) throw new Error("missing coffee dose");
  const setGrinder = asNumber(first(raw, "isSetGrinderSize")) ?? 1;
  const grind =
    setGrinder !== 1
      ? 0
      : (asNumber(first(raw, "grinderSize", "grind")) ?? 0);
  const topRpm = asNumber(first(raw, "rpm"));
  const pours = normalisePours(
    first(raw, "pourList", "pours", "pourDataJSONStr"),
    { tea: false, topRpm },
  ) as CoffeePour[];
  const ratio = asNumber(first(raw, "grandWater", "ratio"));
  const waterMl =
    pours.reduce((s, p) => s + Number(p.ml), 0) +
    (asNumber(first(raw, "bypassVolume", "bypass_ml")) &&
    asNumber(raw.isEnableBypassWater) === 1
      ? asNumber(first(raw, "bypassVolume", "bypass_ml"))!
      : 0);
  const content: CoffeeRecipeContent = {
    name: String(first(raw, "theName", "name") ?? "Unnamed coffee"),
    kind: "hot",
    dripper: cupType === 1 ? "xPod" : "Omni",
    dose_g: dose,
    grind,
    ratio: ratio ?? (dose > 0 ? waterMl / dose : 16),
    water_ml: waterMl,
    hot_water_ml: waterMl,
    note: "",
    pours,
  };
  return {
    content,
    table_id: asNumber(first(raw, "tableId", "table_id", "recipeId")),
    name: content.name,
    kind: "hot",
  };
}

export function importCloudSyncTargets(
  targets: CloudSyncTargetResult[],
  region: CloudRegion,
): { stats: CloudImportStats[]; entries: LocalRecipeEntry[] } {
  const stats: CloudImportStats[] = [];
  const entries: LocalRecipeEntry[] = [];
  for (const t of targets) {
    const records = collectRecipeRecords(t.payload);
    const st: CloudImportStats = {
      target: t.target,
      candidates: records.length,
      imported: 0,
      skipped: 0,
      errors: [],
    };
    const kindHint = t.target === "tea" ? "tea" : "auto";
    for (const raw of records) {
      try {
        const norm = normaliseCloudRecipe(raw, kindHint);
        const recipeId =
          norm.table_id != null
            ? `cloud:${region}:${norm.table_id}`
            : `cloud:${region}:${hashName(norm.name)}`;
        const entry = saveUserRecipe(norm.content, {
          recipeId,
          source: "cloud" as LocalRecipeSource,
          tableId: norm.table_id ?? undefined,
          region,
          origin: t.target,
        });
        entries.push(entry);
        st.imported += 1;
      } catch (e) {
        st.skipped += 1;
        st.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    stats.push(st);
  }
  return { stats, entries };
}

function hashName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return `n${(h >>> 0).toString(16)}`;
}
