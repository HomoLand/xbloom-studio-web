/**
 * Browser-side design via OpenAI-compatible Chat Completions + vision.
 * Requires a base URL that allows browser CORS (local proxy / gateway).
 */

import type { RecipeContent } from "../api";
import { isAiConfigured, readAiConfig, type AiConfig } from "./aiConfig";
import { defaultCoffeeRecipe } from "./recipeDomain";

export type LocalDesignResult = {
  content: RecipeContent;
  rationale: string;
  rawText: string;
  model: string;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

const SYSTEM = `You are an xBloom Studio pour-over recipe designer.
The user may attach multiple images (e.g. bean-bag front + brew/recipe card).
Use all images together: bag for origin/process/notes, card for official parameters when present.
Return ONLY a single JSON object (no markdown fences) with this shape:
{
  "name": string,
  "kind": "hot" | "flash-brew",
  "dripper": "Omni Dripper 2",
  "dose_g": number,
  "grind": number (1-80 or 0 for no-grind),
  "ratio": number,
  "water_ml": number,
  "hot_water_ml": number,
  "ice_g": number | null,
  "note": string,
  "pours": [
    {
      "label": string,
      "ml": number,
      "temp_c": number,
      "pattern": "spiral" | "circular" | "center" | "ring",
      "vibration": "none" | "before" | "after" | "both",
      "pause_s": number,
      "rpm": number,
      "flow_ml_s": number
    }
  ],
  "rationale": string
}
Prefer conservative first cups. Sum of pour ml should match hot_water_ml.`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return JSON");
  }
}

function toContent(obj: Record<string, unknown>): RecipeContent {
  const base = defaultCoffeeRecipe();
  const poursRaw = Array.isArray(obj.pours) ? obj.pours : base.pours;
  const pours = poursRaw.map((p: unknown, i: number) => {
    const row = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const bp = base.pours[Math.min(i, base.pours.length - 1)]!;
    return {
      label: String(row.label ?? bp.label ?? `Pour ${i + 1}`),
      ml: Number(row.ml ?? bp.ml),
      temp_c: (row.temp_c as number | "RT" | "BP") ?? bp.temp_c,
      pattern: (row.pattern as typeof bp.pattern) ?? bp.pattern,
      vibration: (row.vibration as typeof bp.vibration) ?? bp.vibration ?? "none",
      pause_s: Number(row.pause_s ?? bp.pause_s),
      rpm: Number(row.rpm ?? bp.rpm),
      flow_ml_s: Number(row.flow_ml_s ?? bp.flow_ml_s),
    };
  });
  return {
    name: String(obj.name ?? base.name),
    kind: obj.kind === "flash-brew" ? "flash-brew" : "hot",
    dripper: String(obj.dripper ?? "Omni Dripper 2"),
    dose_g: Number(obj.dose_g ?? base.dose_g),
    grind: Number(obj.grind ?? base.grind),
    ratio: Number(obj.ratio ?? base.ratio),
    water_ml: Number(obj.water_ml ?? base.water_ml),
    hot_water_ml: Number(obj.hot_water_ml ?? obj.water_ml ?? base.hot_water_ml),
    ice_g: obj.ice_g != null ? Number(obj.ice_g) : undefined,
    note: String(obj.note ?? obj.rationale ?? ""),
    pours,
  };
}

export async function designWithLocalAi(opts: {
  text: string;
  /** One or more images (bag cover, brew card, etc.). */
  images?: File[];
  /** @deprecated use images */
  image?: File | null;
  config?: AiConfig;
}): Promise<LocalDesignResult> {
  const cfg = opts.config ?? readAiConfig();
  if (!isAiConfigured(cfg)) {
    throw new Error(
      "Configure an OpenAI-compatible multimodal API in Settings first.",
    );
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const files: File[] = [];
  if (opts.images?.length) files.push(...opts.images);
  else if (opts.image) files.push(opts.image);

  const userContent: Array<Record<string, unknown>> = [];
  const prompt =
    opts.text.trim() ||
    (files.length
      ? "Design an xBloom Studio pour-over from the attached image(s) (bag and/or brew card)."
      : "Design a balanced 15g hot pour-over for xBloom Studio Omni Dripper 2.");
  userContent.push({ type: "text", text: prompt });
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    userContent.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `AI API ${res.status}: ${body.slice(0, 280) || res.statusText}. If this is a CORS error, use a proxy that allows browser origins.`,
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawText = data.choices?.[0]?.message?.content ?? "";
  if (!rawText) throw new Error("Empty model response");
  const parsed = extractJson(rawText) as Record<string, unknown>;
  const content = toContent(parsed);
  const note =
    "note" in content && content.note != null ? String(content.note) : "";
  const rationale = String(parsed.rationale ?? note);
  return { content, rationale, rawText, model: cfg.model };
}
