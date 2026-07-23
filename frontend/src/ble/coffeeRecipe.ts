/**
 * Map web CoffeeRecipeContent → protocol load dict (core Recipe.to_protocol_dict shape).
 */

import type { CoffeePour, CoffeeRecipeContent, TempValue } from "../api";
import type { ProtocolPour, ProtocolRecipe } from "./load.ts";

const ROOM_TEMPERATURE_C = 20;
const BOILING_POINT_C = 98;

export function resolveTemperatureC(value: TempValue | null | undefined): number {
  if (value == null) return 92;
  if (value === "RT") return ROOM_TEMPERATURE_C;
  if (value === "BP") return BOILING_POINT_C;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`temp_c must be RT, BP, or a number; got ${String(value)}`);
  }
  return Math.trunc(n);
}

function pourToProtocol(p: CoffeePour): ProtocolPour {
  return {
    ml: Math.trunc(Number(p.ml)),
    temp: resolveTemperatureC(p.temp_c),
    pattern: p.pattern ?? "spiral",
    vibration: p.vibration ?? "none",
    pause: Math.trunc(Number(p.pause_s ?? 0)),
    rpm: Math.trunc(Number(p.rpm ?? 0)),
    flow: Number(p.flow_ml_s ?? 3.0),
  };
}

/** Build the protocol mapping consumed by buildLoadFrames. */
export function coffeeContentToProtocol(content: CoffeeRecipeContent): ProtocolRecipe {
  if (!content.pours?.length) {
    throw new Error("coffee recipe requires at least one pour");
  }
  const dose = Math.trunc(Number(content.dose_g));
  if (!(dose > 0)) throw new Error("dose_g must be a positive integer");
  const grind = Math.trunc(Number(content.grind));
  if (grind < 0 || grind > 80) {
    // 0 = no-grind sentinel; 1-80 normal
    if (grind !== 0) throw new Error("grind must be 0 (no-grind) or 1-80");
  }
  return {
    dose,
    grind,
    bypass_ml: Number(content.bypass_ml ?? 0),
    bypass_temp_c:
      content.bypass_ml != null && Number(content.bypass_ml) > 0
        ? resolveTemperatureC(content.bypass_temp_c ?? "RT")
        : 0,
    pours: content.pours.map(pourToProtocol),
  };
}
