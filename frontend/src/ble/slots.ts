/**
 * Easy-Mode A/B/C slot write frames — port of protocol.build_save_slot / set_mode.
 * Slot save is batch-of-three; never starts a brew.
 */

import { coffeeContentToProtocol } from "./coffeeRecipe.ts";
import { crc16Kermit, j15Frame } from "./framing.ts";
import { build41, type ProtocolRecipe } from "./load.ts";
import type { CoffeeRecipeContent } from "../api.ts";

export const CMD_SAVE_SLOT = 0x2cf6; // 11510
export const CMD_SET_MODE = 0x2cf7; // 11511
export const SLOT_FLAG_SCALE_ON = 0x12;
export const SLOT_FLAG_SCALE_OFF = 0x02;
export const MODE_PRO_PAYLOAD = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
export const MODE_AUTO_PAYLOAD = new Uint8Array([0x91, 0x32, 0x78, 0x56]);

function u16le(n: number): [number, number] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32le(n: number): [number, number, number, number] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function ratioByte(recipe: ProtocolRecipe): number {
  if (recipe.tail != null) return Math.trunc(recipe.tail) & 0xff;
  const total = recipe.pours.reduce((s, p) => s + Math.trunc(p.ml), 0);
  const dose = Math.trunc(recipe.dose);
  return dose ? Math.round((total / dose) * 10) & 0xff : 0xa0;
}

/** Build frame writing recipe to slot 0=A, 1=B, 2=C. */
export function buildSaveSlot(
  recipe: ProtocolRecipe,
  slot: number,
  scale = true,
): Uint8Array {
  if (slot !== 0 && slot !== 1 && slot !== 2) {
    throw new Error(`slot must be 0/1/2; got ${slot}`);
  }
  if (Number(recipe.bypass_ml || 0) > 0) {
    throw new Error(
      "Easy-Mode slot has no bypass field; refuse recipes with bypass_ml",
    );
  }
  const tail = ratioByte(recipe);
  const blob = build41(recipe.pours, recipe.grind, tail);
  const flags = scale ? SLOT_FLAG_SCALE_ON : SLOT_FLAG_SCALE_OFF;
  // payload = 01 | slot | flags | blob without leading 0x01
  const payload = new Uint8Array(3 + blob.length - 1);
  payload[0] = 0x01;
  payload[1] = slot & 0xff;
  payload[2] = flags;
  payload.set(blob.subarray(1), 3);

  const body = new Uint8Array(3 + 2 + 4 + payload.length);
  body[0] = 0x58;
  body[1] = 0x01;
  body[2] = 0x02;
  const [c0, c1] = u16le(CMD_SAVE_SLOT);
  body[3] = c0;
  body[4] = c1;
  body.set(payload, 9);
  const total = body.length + 2;
  const [l0, l1, l2, l3] = u32le(total);
  body[5] = l0;
  body[6] = l1;
  body[7] = l2;
  body[8] = l3;
  const crc = crc16Kermit(body);
  const frame = new Uint8Array(body.length + 2);
  frame.set(body, 0);
  frame[body.length] = crc & 0xff;
  frame[body.length + 1] = (crc >> 8) & 0xff;
  return frame;
}

export function buildSetMode(pro = true): Uint8Array {
  // j15Frame always prefixes 0x01; raw is only the 4-byte mode payload.
  return j15Frame(CMD_SET_MODE, {
    raw: pro ? MODE_PRO_PAYLOAD : MODE_AUTO_PAYLOAD,
    frameType: 0x02,
  });
}

export function coffeeToSlotRecipe(content: CoffeeRecipeContent): ProtocolRecipe {
  return coffeeContentToProtocol(content);
}

/** Three recipes for A/B/C; missing slots reuse first. */
export function buildSlotBatch(
  recipes: [CoffeeRecipeContent, CoffeeRecipeContent?, CoffeeRecipeContent?],
  scale = true,
): Uint8Array[] {
  const a = coffeeToSlotRecipe(recipes[0]!);
  const b = coffeeToSlotRecipe(recipes[1] ?? recipes[0]!);
  const c = coffeeToSlotRecipe(recipes[2] ?? recipes[0]!);
  return [
    buildSetMode(true),
    buildSaveSlot(a, 0, scale),
    buildSaveSlot(b, 1, scale),
    buildSaveSlot(c, 2, scale),
  ];
}
