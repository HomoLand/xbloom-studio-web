/**
 * Omni Tea Brewer load frames — port of packages/core/xbloom_ble/protocol.py
 * build_tea_recipe_code / build_tea_load_frames / build_tea_start.
 */

import type { TeaRecipeContent } from "../api.ts";
import { j15Frame } from "./framing.ts";
import { MACHINE_PATTERN_CODES } from "./load.ts";

export const CMD_TEA_RECIPE_MAKE = 4512;
export const CMD_TEA_RECIPE_CODE = 4513;
export const CMD_RECIPE_START_QUIT = 8017;
export const CMD_SET_CUP = 8104;

function floatBits(value: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return new DataView(buf).getUint32(0, true);
}

function machinePattern(pattern: string): number {
  let name = String(pattern).trim().toLowerCase();
  if (name === "ring") name = "circular";
  const code = MACHINE_PATTERN_CODES[name];
  if (code === undefined) throw new Error(`unknown tea pattern ${pattern}`);
  return code;
}

/** App TeaRecipeCreate pause rewrite: 20s→ec 00, 60s→00 20, 120s→00 40. */
export function teaPauseBytes(seconds: number): [number, number] {
  const s = Math.trunc(seconds);
  if (s < 0 || s > 120) throw new Error(`tea pause must be 0-120; got ${s}`);
  const minutes = Math.floor(s / 60);
  const remainder = s % 60;
  return [(-remainder) & 0xff, (minutes * 32) & 0xff];
}

export type TeaProtocolPour = {
  ml: number;
  temp: number;
  pattern?: string;
  pause?: number;
  flow?: number;
  vibration?: number;
};

export type TeaProtocolRecipe = {
  pours: TeaProtocolPour[];
  cup_min_mm?: number;
  cup_max_mm?: number;
  grinder_size?: number;
  grand_water?: number;
  rpm?: number;
};

export function buildTeaRecipeCode(
  pours: TeaProtocolPour[],
  opts: { grinder_size?: number; grand_water?: number; rpm?: number } = {},
): Uint8Array {
  const grinderSize = opts.grinder_size ?? 50;
  const grandWater = opts.grand_water ?? 45;
  const rpm = opts.rpm ?? 120;
  const stages: number[] = [];
  pours.forEach((pour, index) => {
    const ml = Math.trunc(pour.ml);
    const temp = Math.trunc(pour.temp) & 0xff;
    const pattern = machinePattern(String(pour.pattern ?? "circular"));
    const vibration = Math.trunc(pour.vibration ?? 0) & 0xff;
    const [pauseLo, pauseHi] = teaPauseBytes(
      Math.trunc(pour.pause ?? 0),
    );
    const flow10 = Math.round(Number(pour.flow ?? 3.5) * 10) & 0xff;
    let remaining = ml;
    while (remaining > 127) {
      stages.push(127, temp, pattern, vibration);
      remaining -= 127;
    }
    if (remaining) {
      stages.push(remaining & 0xff, temp, pattern, vibration);
    }
    stages.push(
      pauseLo,
      pauseHi,
      index === 0 ? rpm & 0xff : 0,
      flow10,
    );
  });
  const body = new Uint8Array(stages);
  if (!body.length || body.length > 0xff) {
    throw new Error("tea recipe body must contain 1-255 bytes");
  }
  const out = new Uint8Array(1 + body.length + 2);
  out[0] = body.length & 0xff;
  out.set(body, 1);
  out[1 + body.length] = grinderSize & 0xff;
  out[1 + body.length + 1] = Math.trunc(grandWater * 10) & 0xff;
  return out;
}

export function buildTeaSetCup(maxMm = 80, minMm = 40): Uint8Array {
  return j15Frame(CMD_SET_CUP, {
    data: [floatBits(maxMm), floatBits(minMm)],
  });
}

export function buildTeaCodeUpload(code: Uint8Array): Uint8Array {
  return j15Frame(CMD_TEA_RECIPE_CODE, { raw: code });
}

export function buildTeaLoadFrames(recipe: TeaProtocolRecipe): Uint8Array[] {
  const code = buildTeaRecipeCode(recipe.pours, {
    grinder_size: recipe.grinder_size,
    grand_water: recipe.grand_water,
    rpm: recipe.rpm,
  });
  const frames = [
    buildTeaSetCup(recipe.cup_max_mm ?? 80, recipe.cup_min_mm ?? 40),
    buildTeaCodeUpload(code),
  ];
  return frames;
}

export function buildTeaStart(): Uint8Array {
  return j15Frame(CMD_TEA_RECIPE_MAKE);
}

export function buildRecipeStartQuit(): Uint8Array {
  return j15Frame(CMD_RECIPE_START_QUIT);
}

export function teaContentToProtocol(content: TeaRecipeContent): TeaProtocolRecipe {
  const leaf = Number(content.leaf_g) || 4;
  const pours = (content.pours || []).map((p) => ({
    ml: Number(p.ml),
    temp: Number(p.temp_c),
    pattern: p.pattern || "circular",
    pause: Number(p.pause_s ?? 20),
    flow: Number(p.flow_ml_s ?? 3.5),
    vibration: 0,
  }));
  const total = pours.reduce((s, p) => s + p.ml, 0);
  return {
    pours,
    cup_min_mm: 40,
    cup_max_mm: 80,
    grinder_size: 50,
    grand_water: leaf > 0 ? total / leaf : 45,
    rpm: 120,
  };
}
