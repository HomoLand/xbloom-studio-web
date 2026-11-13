/**
 * Import / export local recipes as JSON (and a lightweight YAML-ish dump).
 */

import type { RecipeContent } from "../api.ts";
import {
  listAllLocalRecipes,
  saveUserRecipe,
  validateLocalContent,
  type LocalRecipeEntry,
  type LocalRecipeSource,
} from "./localRecipes.ts";
import { isCoffeeContent, isTeaContent, recipeDisplayName } from "./recipeDomain.ts";

export type ExportBundle = {
  format: "xbloom-studio-web-recipes";
  version: 1;
  exported_at: string;
  recipes: Array<{
    recipe_id?: string;
    name: string;
    kind: string;
    source?: string;
    content: RecipeContent;
  }>;
};

export function exportRecipesJson(
  entries?: ExportBundle["recipes"],
): string {
  const list = entries ?? listAllLocalRecipes().filter((e) => e.source !== "official");
  const bundle: ExportBundle = {
    format: "xbloom-studio-web-recipes",
    version: 1,
    exported_at: new Date().toISOString(),
    recipes: list.map((e) => ({
      recipe_id: e.recipe_id,
      name: e.name,
      kind: e.kind,
      source: e.source,
      content: e.content,
    })),
  };
  return JSON.stringify(bundle, null, 2);
}

export function exportSingleRecipeJson(content: RecipeContent): string {
  return JSON.stringify(
    {
      format: "xbloom-studio-web-recipe",
      version: 1,
      name: recipeDisplayName(content),
      content,
    },
    null,
    2,
  );
}

/** Very small YAML dump for coffee/tea (not a full YAML engine). */
export function exportSingleRecipeYaml(content: RecipeContent): string {
  const lines: string[] = [];
  const esc = (s: string) =>
    /[:#\n"'\\]/.test(s) ? JSON.stringify(s) : s;
  if (isCoffeeContent(content)) {
    lines.push(`name: ${esc(content.name)}`);
    lines.push(`kind: ${content.kind}`);
    if (content.dripper) lines.push(`dripper: ${esc(content.dripper)}`);
    lines.push(`dose_g: ${content.dose_g}`);
    lines.push(`grind: ${content.grind}`);
    lines.push(`ratio: ${content.ratio}`);
    lines.push(`water_ml: ${content.water_ml}`);
    if (content.kind === "flash-brew") {
      if (content.hot_water_ml != null)
        lines.push(`hot_water_ml: ${content.hot_water_ml}`);
      if (content.ice_g != null) lines.push(`ice_g: ${content.ice_g}`);
    }
    if (content.note) lines.push(`note: ${esc(content.note)}`);
    lines.push("pours:");
    for (const p of content.pours) {
      lines.push(`  - label: ${esc(p.label || "")}`);
      lines.push(`    ml: ${p.ml}`);
      lines.push(`    temp_c: ${p.temp_c}`);
      lines.push(`    pattern: ${p.pattern}`);
      lines.push(`    vibration: ${p.vibration ?? "none"}`);
      lines.push(`    pause_s: ${p.pause_s}`);
      lines.push(`    rpm: ${p.rpm}`);
      lines.push(`    flow_ml_s: ${p.flow_ml_s}`);
    }
  } else if (isTeaContent(content)) {
    lines.push(`name: ${esc(content.name)}`);
    lines.push(`kind: tea`);
    lines.push(`leaf_g: ${content.leaf_g}`);
    lines.push(`output_ml_per_steep: ${content.output_ml_per_steep}`);
    lines.push("pours:");
    for (const p of content.pours) {
      lines.push(`  - label: ${esc(p.label || "")}`);
      lines.push(`    ml: ${p.ml}`);
      lines.push(`    temp_c: ${p.temp_c}`);
      lines.push(`    pattern: ${p.pattern}`);
      lines.push(`    pause_s: ${p.pause_s}`);
      lines.push(`    flow_ml_s: ${p.flow_ml_s}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function importRecipesFromJson(text: string): {
  imported: number;
  errors: string[];
  entries: LocalRecipeEntry[];
} {
  const errors: string[] = [];
  const entries: LocalRecipeEntry[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { imported: 0, errors: ["Invalid JSON"], entries: [] };
  }

  const items: unknown[] = [];
  if (Array.isArray(data)) {
    items.push(...data);
  } else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.recipes)) items.push(...o.recipes);
    else if (o.content && typeof o.content === "object") items.push(o);
    else if (o.kind || o.pours) items.push(o);
    else return { imported: 0, errors: ["No recipes found in JSON"], entries: [] };
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      errors.push("Skip non-object entry");
      continue;
    }
    const row = item as Record<string, unknown>;
    const content = (row.content ?? row) as RecipeContent;
    const check = validateLocalContent(content);
    if (!check.valid) {
      errors.push(check.message);
      continue;
    }
    const entry = saveUserRecipe(check.content, {
      recipeId:
        typeof row.recipe_id === "string" ? row.recipe_id : undefined,
      source: (row.source as LocalRecipeSource) || "user",
    });
    entries.push(entry);
  }
  return { imported: entries.length, errors, entries };
}

export function downloadText(filename: string, text: string, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
