/**
 * Decode ffe2 status notifications — aligned with
 * packages/core/xbloom_ble/telemetry.py (subset sufficient for coffee brew UI).
 */

import { crc16Kermit } from "./framing.ts";

export const NOTIFICATION_PREFIX = new Uint8Array([0x58, 0x02, 0x07]);
export const NOTIFICATION_HEADER_LENGTH = 9;
export const MIN_NOTIFICATION_FRAME_LENGTH = 12;
export const MAX_NOTIFICATION_FRAME_LENGTH = 65_535;

export const STATE_NAMES: Record<number, string> = {
  0x01: "idle",
  0x0c: "no_water",
  0x0f: "no_beans",
  0x10: "brewing",
  0x1d: "loading",
  0x1f: "armed",
  0x1e: "awaiting_confirm",
  0x22: "starting",
  0x23: "brewing",
  0x24: "ready",
  0x3b: "brewing",
  0x41: "complete",
  0x43: "saving_slots",
  0x25: "slots_saved",
};

/**
 * Machine states that always end a brew without needing session context.
 * Idle (0x01) is NOT included: it is the normal at-rest state after connect.
 * Session code may treat idle as terminal only after an active brew/cancel path.
 */
export const TERMINAL_STATES = new Set([0x24, 0x41]);

/** True end-of-brew beep / complete codes (never idle-at-rest). */
export function isBrewTerminalState(state: number | null | undefined): boolean {
  return state != null && TERMINAL_STATES.has(state);
}

export const WATER_VOLUME_COMMAND = 40523;
export const CUP_WEIGHT_COMMAND = 20501;
export const SCALE_WEIGHT_COMMAND = 10507;
export const STATUS_COMMAND = 8023;
export const STATE_MARKER = 0xc1;

export type StatusEvent = {
  state: number | null;
  stateName: string;
  raw: Uint8Array;
  commandCode: number | null;
  dispensedWaterMl: number | null;
  cupWeightG: number | null;
  scaleG: number | null;
  isTerminal: boolean;
};

export type NotificationFrameStats = {
  framesEmitted: number;
  invalidCrcFrames: number;
  invalidLengthFrames: number;
  bytesDiscarded: number;
};

function u16le(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function u32le(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

export function notificationFrameIsValid(frame: Uint8Array): boolean {
  if (frame.length < MIN_NOTIFICATION_FRAME_LENGTH) return false;
  if (
    frame[0] !== 0x58 ||
    frame[1] !== 0x02 ||
    frame[2] !== 0x07
  ) {
    return false;
  }
  const declared = u32le(frame, 5);
  if (declared !== frame.length || declared > MAX_NOTIFICATION_FRAME_LENGTH) {
    return false;
  }
  const expected = u16le(frame, frame.length - 2);
  return crc16Kermit(frame.subarray(0, frame.length - 2)) === expected;
}

function markerIdx(data: Uint8Array): number {
  if (data.length > 9 && data[9] === STATE_MARKER) return 9;
  for (let i = 5; i < data.length; i++) {
    if (data[i] === STATE_MARKER) return i;
  }
  return -1;
}

function decodeFloatMeasurement(
  data: Uint8Array,
  scale: number,
  allowNegative: boolean,
): number | null {
  const marker = markerIdx(data);
  if (marker < 0 || marker + 5 > data.length) return null;
  const view = new DataView(
    data.buffer,
    data.byteOffset + marker + 1,
    4,
  );
  const raw = view.getFloat32(0, true);
  const value = raw * scale;
  const minimum = allowNegative ? -2000 : 0;
  if (Number.isNaN(value) || value < minimum || value > 2000) return null;
  return Math.round(value * 100) / 100;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode one complete ffe2 notification frame into a StatusEvent.
 * Returns null when the buffer is not a recognisable / valid frame.
 */
export function parseNotification(
  data: Uint8Array | string,
  opts: { validateCrc?: boolean } = {},
): StatusEvent | null {
  const validateCrc = opts.validateCrc !== false;
  const frame = typeof data === "string" ? hexToBytes(data) : data;
  if (frame.length < MIN_NOTIFICATION_FRAME_LENGTH) return null;
  if (frame[0] !== 0x58 || frame[1] !== 0x02 || frame[2] !== 0x07) return null;
  const declared = u32le(frame, 5);
  if (declared !== frame.length || declared > MAX_NOTIFICATION_FRAME_LENGTH) {
    return null;
  }
  if (validateCrc && !notificationFrameIsValid(frame)) return null;

  const commandCode = u16le(frame, 3);

  if (commandCode === WATER_VOLUME_COMMAND) {
    const ml = decodeFloatMeasurement(frame, 0.001, false);
    return {
      state: null,
      stateName: "scale",
      raw: frame,
      commandCode,
      dispensedWaterMl: ml,
      cupWeightG: null,
      scaleG: null,
      isTerminal: false,
    };
  }
  if (commandCode === CUP_WEIGHT_COMMAND) {
    const g = decodeFloatMeasurement(frame, 1.0, true);
    return {
      state: null,
      stateName: "scale",
      raw: frame,
      commandCode,
      dispensedWaterMl: null,
      cupWeightG: g,
      scaleG: g,
      isTerminal: false,
    };
  }
  if (commandCode === SCALE_WEIGHT_COMMAND) {
    const g = decodeFloatMeasurement(frame, 1.0, true);
    return {
      state: null,
      stateName: "scale",
      raw: frame,
      commandCode,
      dispensedWaterMl: null,
      cupWeightG: null,
      scaleG: g,
      isTerminal: false,
    };
  }

  if (commandCode === STATUS_COMMAND) {
    const marker = markerIdx(frame);
    const payload =
      marker >= 0 ? frame.subarray(marker + 1, frame.length - 2) : new Uint8Array();
    if (payload.length > 0) {
      const state = payload[0]!;
      const stateName = STATE_NAMES[state] ?? `unknown_0x${state.toString(16).padStart(2, "0")}`;
      return {
        state,
        stateName,
        raw: frame,
        commandCode,
        dispensedWaterMl: null,
        cupWeightG: null,
        scaleG: null,
        isTerminal: TERMINAL_STATES.has(state),
      };
    }
  }

  // Unknown but valid frame shape — ignore for brew UI.
  return {
    state: null,
    stateName: "unknown",
    raw: frame,
    commandCode,
    dispensedWaterMl: null,
    cupWeightG: null,
    scaleG: null,
    isTerminal: false,
  };
}

/**
 * Reassemble split GATT notifications into CRC-valid frames (Android-style buffer).
 */
export class NotificationFrameStream {
  private buffer = new Uint8Array(0);
  readonly stats: NotificationFrameStats = {
    framesEmitted: 0,
    invalidCrcFrames: 0,
    invalidLengthFrames: 0,
    bytesDiscarded: 0,
  };

  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length) {
      const next = new Uint8Array(this.buffer.length + chunk.length);
      next.set(this.buffer, 0);
      next.set(chunk, this.buffer.length);
      this.buffer = next;
    }
    const frames: Uint8Array[] = [];
    while (this.buffer.length) {
      const start = indexOfPrefix(this.buffer, NOTIFICATION_PREFIX);
      if (start < 0) {
        this.discardWithoutPrefix();
        break;
      }
      if (start > 0) {
        this.stats.bytesDiscarded += start;
        this.buffer = this.buffer.subarray(start);
      }
      if (this.buffer.length < NOTIFICATION_HEADER_LENGTH) break;
      const declared = u32le(this.buffer, 5);
      if (
        declared < MIN_NOTIFICATION_FRAME_LENGTH ||
        declared > MAX_NOTIFICATION_FRAME_LENGTH
      ) {
        this.buffer = this.buffer.subarray(1);
        this.stats.bytesDiscarded += 1;
        this.stats.invalidLengthFrames += 1;
        continue;
      }
      if (this.buffer.length < declared) break;
      const frame = this.buffer.subarray(0, declared);
      if (!notificationFrameIsValid(frame)) {
        this.buffer = this.buffer.subarray(1);
        this.stats.bytesDiscarded += 1;
        this.stats.invalidCrcFrames += 1;
        continue;
      }
      this.buffer = this.buffer.subarray(declared);
      frames.push(frame.slice());
      this.stats.framesEmitted += 1;
    }
    return frames;
  }

  private discardWithoutPrefix(): void {
    let keep = 0;
    for (let size = 1; size < NOTIFICATION_PREFIX.length && size <= this.buffer.length; size++) {
      let match = true;
      for (let i = 0; i < size; i++) {
        if (this.buffer[this.buffer.length - size + i] !== NOTIFICATION_PREFIX[i]) {
          match = false;
          break;
        }
      }
      if (match) keep = size;
    }
    const discard = this.buffer.length - keep;
    if (discard > 0) {
      this.stats.bytesDiscarded += discard;
      this.buffer = this.buffer.subarray(discard);
    }
  }
}

function indexOfPrefix(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function isActedBrewState(state: number | null): boolean {
  return state === 0x22 || state === 0x10 || state === 0x23 || state === 0x3b ||
    state === 0x0c || state === 0x0f;
}

export function isArmedState(state: number | null): boolean {
  return state === 0x1f;
}
