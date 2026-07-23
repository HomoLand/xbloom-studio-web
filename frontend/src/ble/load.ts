/**
 * Coffee LOAD frame builders — port of packages/core/xbloom_ble/protocol.py
 * build_load_frames / pour segments. Never includes commit/start/cancel.
 */

import {
  CANCEL_OPCODE,
  COMMIT_OPCODE,
  LOAD_SEQ,
  START_OPCODE,
} from "./constants.ts";
import { xbloomFrame } from "./framing.ts";

export const NO_GRIND = 0;
export const NO_GRIND_WIRE = 0xfe;
export const POURS_CMD_GRIND = 0x41;
export const POURS_CMD_NO_GRIND = 0x44;
export const COFFEE_CUP_GEOMETRY_COMPAT: [number, number] = [110.0, 90.0];

export const VIBRATION_CODES: Record<string, number> = {
  none: 0,
  before: 1,
  after: 2,
  both: 3,
};

export const MACHINE_PATTERN_CODES: Record<string, number> = {
  center: 0,
  ring: 1,
  circular: 1,
  spiral: 2,
};

export type ProtocolPour = {
  ml: number;
  temp: number;
  pattern?: string;
  vibration?: string;
  agitation?: boolean;
  pause?: number;
  rpm?: number;
  flow?: number;
};

export type ProtocolRecipe = {
  dose: number;
  grind: number;
  bypass_ml?: number;
  bypass_temp_c?: number;
  pours: ProtocolPour[];
  cup_geometry_compat?: [number, number];
  tail?: number;
  seq?: number;
};

function floatBits(value: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return new DataView(buf).getUint32(0, true);
}

function packU32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  const v = n >>> 0;
  out[0] = v & 0xff;
  out[1] = (v >> 8) & 0xff;
  out[2] = (v >> 16) & 0xff;
  out[3] = (v >> 24) & 0xff;
  return out;
}

function packF32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, n, true);
  return out;
}

export function recipePattern(pattern: string): [string, number] {
  let name = String(pattern).trim().toLowerCase();
  if (name === "ring") name = "circular";
  const wire = MACHINE_PATTERN_CODES[name];
  if (wire === undefined) {
    throw new Error(`pattern must be one of ${Object.keys(MACHINE_PATTERN_CODES)}; got ${pattern}`);
  }
  return [name, wire];
}

function pourPatternVibration(pour: ProtocolPour): [number, number] {
  const [, pattern] = recipePattern(String(pour.pattern ?? "spiral"));
  const hasVibration = pour.vibration != null;
  const hasLegacy = pour.agitation != null;
  if (hasVibration && hasLegacy) {
    throw new Error("pour cannot set both vibration and legacy agitation");
  }
  if (hasVibration) {
    const timing = String(pour.vibration).trim().toLowerCase();
    const code = VIBRATION_CODES[timing];
    if (code === undefined) {
      throw new Error(`vibration must be one of ${Object.keys(VIBRATION_CODES)}`);
    }
    return [pattern, code];
  }
  if (hasLegacy) {
    // Minimal legacy path: spiral+agitation maps like PATTERN_CODES.
    let legacy = String(pour.pattern ?? "spiral").trim().toLowerCase();
    if (legacy === "circular") legacy = "ring";
    const key = `${legacy}:${Boolean(pour.agitation)}`;
    const map: Record<string, [number, number]> = {
      "spiral:true": [0x02, 0x02],
      "spiral:false": [0x02, 0x00],
      "ring:false": [0x01, 0x00],
      "center:false": [0x00, 0x01],
    };
    const hit = map[key];
    if (!hit) throw new Error(`unsupported legacy pattern/agitation pair: ${key}`);
    return hit;
  }
  return [pattern, VIBRATION_CODES.none!];
}

export function buildA4(): Uint8Array {
  return hexToBytes("01b900000001000000");
}

export function buildA6(
  doseG: number,
  bypassMl = 0,
  bypassTempC = 0,
): Uint8Array {
  const out = new Uint8Array(1 + 4 + 4 + 4);
  out[0] = 0x01;
  out.set(packU32(floatBits(bypassMl)), 1);
  out.set(packU32(floatBits(bypassTempC * 10.0)), 5);
  out.set(packU32(Math.trunc(doseG)), 9);
  return out;
}

export function buildCoffeeCupGeometryCompat(
  first = COFFEE_CUP_GEOMETRY_COMPAT[0],
  second = COFFEE_CUP_GEOMETRY_COMPAT[1],
): Uint8Array {
  const out = new Uint8Array(1 + 4 + 4);
  out[0] = 0x01;
  out.set(packF32(first), 1);
  out.set(packF32(second), 5);
  return out;
}

function pourSegments(p: ProtocolPour): Uint8Array[] {
  const [pat, vibration] = pourPatternVibration(p);
  let remaining = Math.trunc(p.ml);
  const temp = Math.trunc(p.temp) & 0xff;
  const pause = Math.trunc(p.pause ?? 0);
  const rpm = Math.trunc(p.rpm ?? 0) & 0xff;
  const flow10 = Math.round(Number(p.flow ?? 3.0) * 10) & 0xff;
  const negpause = (256 - pause) & 0xff;
  const segs: Uint8Array[] = [];
  while (remaining > 127) {
    segs.push(new Uint8Array([127, temp, pat, vibration]));
    remaining -= 127;
  }
  segs.push(
    new Uint8Array([
      remaining & 0xff,
      temp,
      pat,
      vibration,
      negpause,
      0x00,
      rpm,
      flow10,
    ]),
  );
  return segs;
}

function grindByte(grind: number): number {
  return Math.trunc(grind) === NO_GRIND ? NO_GRIND_WIRE : Math.trunc(grind) & 0xff;
}

export function build41(
  pours: ProtocolPour[],
  grind: number,
  tail = 0xa0,
): Uint8Array {
  const segs: Uint8Array[] = [];
  pours.forEach((p, i) => {
    const pour = i === 0 ? p : { ...p, rpm: 0 };
    segs.push(...pourSegments(pour));
  });
  let bodyLen = 0;
  for (const s of segs) bodyLen += s.length;
  const body = new Uint8Array(bodyLen);
  let off = 0;
  for (const s of segs) {
    body.set(s, off);
    off += s.length;
  }
  const out = new Uint8Array(2 + body.length + 2);
  out[0] = 0x01;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  out[2 + body.length] = grindByte(grind);
  out[2 + body.length + 1] = tail & 0xff;
  return out;
}

function ratioByte(recipe: ProtocolRecipe): number {
  if (recipe.tail != null) return Math.trunc(recipe.tail) & 0xff;
  const total = recipe.pours.reduce((s, p) => s + Math.trunc(p.ml), 0);
  const dose = Math.trunc(recipe.dose);
  return dose ? Math.round((total / dose) * 10) & 0xff : 0xa0;
}

/**
 * Ordered LOAD frames [a4, a6, a8, pours]. Never commit/start/cancel.
 */
export function buildLoadFrames(recipe: ProtocolRecipe): Uint8Array[] {
  const seq = recipe.seq ?? LOAD_SEQ;
  const cup = recipe.cup_geometry_compat ?? COFFEE_CUP_GEOMETRY_COMPAT;
  if (!Array.isArray(cup) || cup.length !== 2) {
    throw new Error("cup_geometry_compat must contain exactly two values");
  }
  const tail = ratioByte(recipe);
  const poursCmd =
    Math.trunc(recipe.grind) === NO_GRIND ? POURS_CMD_NO_GRIND : POURS_CMD_GRIND;
  const frames = [
    xbloomFrame(0xa4, seq, buildA4()),
    xbloomFrame(
      0xa6,
      seq,
      buildA6(
        recipe.dose,
        recipe.bypass_ml ?? 0,
        recipe.bypass_temp_c ?? 0,
      ),
    ),
    xbloomFrame(0xa8, seq, buildCoffeeCupGeometryCompat(cup[0], cup[1])),
    xbloomFrame(poursCmd, seq, build41(recipe.pours, recipe.grind, tail)),
  ];
  for (const fr of frames) {
    if (
      fr[3] === COMMIT_OPCODE ||
      fr[3] === START_OPCODE ||
      fr[3] === CANCEL_OPCODE
    ) {
      throw new Error("load frames must never contain a brew-start/cancel opcode");
    }
  }
  return frames;
}

export function buildStatusQuery(): Uint8Array {
  return xbloomFrame(0x56, LOAD_SEQ, new Uint8Array([0x01]));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function framesToHex(frames: Uint8Array[]): string[] {
  return frames.map((f) =>
    Array.from(f, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}
