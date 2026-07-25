/**
 * FreeSolo scale / grinder / water frames — golden-aligned with
 * packages/core/xbloom_ble/protocol.py builders.
 */

import { j15Frame } from "./framing.ts";
import { MACHINE_PATTERN_CODES } from "./load.ts";

export const CMD_SCALE_ENTER = 8003;
export const CMD_SCALE_EXIT = 8014;
export const CMD_SCALE_TARE = 8500;
export const CMD_GRINDER_ENTER = 8006;
export const CMD_GRINDER_START = 3500;
export const CMD_GRINDER_STOP = 3505;
export const CMD_GRINDER_QUIT = 8012;
export const CMD_GRINDER_PAUSE = 8018;
export const CMD_GRINDER_RESUME = 8020;
export const CMD_BREWER_ENTER = 8007;
export const CMD_BREWER_START = 4506;
export const CMD_BREWER_STOP = 4507;
export const CMD_BREWER_QUIT = 8013;
export const CMD_BREWER_PAUSE = 8019;
export const CMD_BREWER_RESUME = 8021;
export const CMD_SET_WEIGHT_UNIT = 8005;
export const CMD_SET_TEMPERATURE_UNIT = 8010;
export const CMD_SET_WATER_SOURCE = 4508;
export const CMD_SET_DISPLAY = 8103;

function floatBits(value: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return new DataView(buf).getUint32(0, true);
}

function machinePattern(pattern: string): number {
  let name = String(pattern).trim().toLowerCase();
  if (name === "ring") name = "circular";
  const code = MACHINE_PATTERN_CODES[name];
  if (code === undefined) throw new Error(`unknown pattern ${pattern}`);
  return code;
}

export function buildScaleEnter(): Uint8Array {
  return j15Frame(CMD_SCALE_ENTER);
}
export function buildScaleExit(): Uint8Array {
  return j15Frame(CMD_SCALE_EXIT);
}
export function buildScaleTare(): Uint8Array {
  return j15Frame(CMD_SCALE_TARE);
}

export function buildGrinderEnter(grind: number, rpm: number): Uint8Array {
  return j15Frame(CMD_GRINDER_ENTER, { data: [Math.trunc(grind), Math.trunc(rpm)] });
}
export function buildGrinderStart(grind: number, rpm: number): Uint8Array {
  return j15Frame(CMD_GRINDER_START, {
    data: [1000, Math.trunc(grind), Math.trunc(rpm)],
  });
}
export function buildGrinderStop(): Uint8Array {
  return j15Frame(CMD_GRINDER_STOP);
}
export function buildGrinderQuit(): Uint8Array {
  return j15Frame(CMD_GRINDER_QUIT);
}
export function buildGrinderPause(): Uint8Array {
  return j15Frame(CMD_GRINDER_PAUSE);
}
export function buildGrinderResume(): Uint8Array {
  return j15Frame(CMD_GRINDER_RESUME);
}

export function buildBrewerEnter(tempC: number, pattern = "center"): Uint8Array {
  return j15Frame(CMD_BREWER_ENTER, {
    data: [machinePattern(pattern), floatBits(Math.trunc(tempC) * 10.0)],
  });
}

export function buildBrewerStart(
  volumeMl: number,
  tempC: number,
  flowMlS = 3.5,
  pattern = "center",
  waterFeed = 0,
): Uint8Array {
  if (waterFeed !== 0 && waterFeed !== 1) {
    throw new Error("water_feed must be 0 (tank) or 1 (tap)");
  }
  return j15Frame(CMD_BREWER_START, {
    data: [
      floatBits(Number(flowMlS) * 10.0),
      floatBits(Number(volumeMl) * 10.0),
      floatBits(Math.trunc(tempC) * 10.0),
      Math.trunc(waterFeed),
      machinePattern(pattern),
    ],
  });
}

export function buildBrewerStop(): Uint8Array {
  return j15Frame(CMD_BREWER_STOP);
}
export function buildBrewerQuit(): Uint8Array {
  return j15Frame(CMD_BREWER_QUIT);
}
export function buildBrewerPause(): Uint8Array {
  return j15Frame(CMD_BREWER_PAUSE);
}
export function buildBrewerResume(): Uint8Array {
  return j15Frame(CMD_BREWER_RESUME);
}

export type WeightUnit = "ml" | "g" | "oz";
export type TemperatureUnit = "C" | "F";
export type WaterSource = "tank" | "tap";
export type DisplayLevel = "low" | "medium" | "high";

export function buildSetWeightUnit(unit: WeightUnit): Uint8Array {
  const values: Record<WeightUnit, number> = { ml: 0, g: 1, oz: 2 };
  return j15Frame(CMD_SET_WEIGHT_UNIT, { data: [values[unit]] });
}

export function buildSetTemperatureUnit(unit: TemperatureUnit): Uint8Array {
  const values: Record<TemperatureUnit, number> = { F: 0, C: 1 };
  return j15Frame(CMD_SET_TEMPERATURE_UNIT, { data: [values[unit]] });
}

export function buildSetWaterSource(source: WaterSource): Uint8Array {
  const values: Record<WaterSource, number> = { tank: 0, tap: 1 };
  return j15Frame(CMD_SET_WATER_SOURCE, { data: [values[source]] });
}

export function buildSetDisplay(level: DisplayLevel): Uint8Array {
  const values: Record<DisplayLevel, number> = { low: 1, medium: 8, high: 15 };
  return j15Frame(CMD_SET_DISPLAY, { data: [values[level]] });
}
