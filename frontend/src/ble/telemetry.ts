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
  /** Observed mid-tea steep soak / inter-steep wait on Omni Tea Brewer. */
  0x45: "tea_soaking",
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

/**
 * Heartbeat / misclassified status sentinels (low bytes of cup/water streams).
 * Do not treat as real machine phase — matches core IGNORED_STATES.
 */
export const IGNORED_STATES = new Set([0x15, 0x4b]);

/** True end-of-brew beep / complete codes (never idle-at-rest). */
export function isBrewTerminalState(state: number | null | undefined): boolean {
  return state != null && TERMINAL_STATES.has(state);
}

export function isIgnoredMachineState(
  state: number | null | undefined,
): boolean {
  return state != null && IGNORED_STATES.has(state);
}

export const WATER_VOLUME_COMMAND = 40523;
export const CUP_WEIGHT_COMMAND = 20501;
export const SCALE_WEIGHT_COMMAND = 10507;
export const STATUS_COMMAND = 8023;
/** Studio identity/settings dump (serial, firmware, units). */
export const MACHINE_INFO_COMMAND = 40521;
export const STATE_MARKER = 0xc1;

export type MachineInfo = {
  serialNumber: string;
  model: string;
  firmware: string;
  waterSource: string;
  temperatureUnit: string;
  weightUnit: string;
};

/**
 * Official report / activity names (core telemetry.REPORT_NAMES).
 * Used so FreeSolo enter/tare/exit/start ACKs are not shown as bare "unknown".
 */
export const REPORT_NAMES: Record<number, string> = {
  8009: "machine_sleeping",
  8011: "machine_awake",
  8015: "settings_changed",
  8023: "machine_activity",
  8105: "grinder_size",
  8106: "grinder_speed",
  8107: "brewer_pattern",
  8108: "brewer_temperature",
  8111: "easy_mode_begin",
  8113: "tea_soak_time_changed",
  8203: "abnormal_gear_position",
  8204: "abnormal_dose_or_water",
  9000: "grinder_state",
  9001: "brewer_state",
  9002: "machine_state",
  9003: "grinder_started",
  9004: "grinder_exited",
  9005: "brewer_started",
  9006: "brewer_exited",
  9008: "machine_state",
  9009: "grinder_paused",
  9010: "brewer_paused",
  9011: "tea_restarted",
  9012: "tea_soaking",
  10507: "scale_weight",
  20501: "cup_weight",
  40501: "xpod_detected",
  40502: "coffee_brewer_started",
  40505: "gear_position",
  40507: "grinder_stopped",
  40510: "pour_stage",
  40511: "brewer_stopped",
  40512: "brew_ready",
  40513: "brew_ready_alt",
  40515: "tea_paused",
  40517: "idle_grinding_error",
  40520: "bypass_started",
  40522: "no_water_report",
  40523: "water_volume",
  40526: "current_grinder",
  40527: "vibration_before_pour",
  11506: "pour_radius",
  11507: "pour_radius_written",
  11508: "vibration_amplitude",
  11509: "vibration_amplitude_written",
  11518: "easy_mode_state",
};

export type StatusEvent = {
  state: number | null;
  stateName: string;
  raw: Uint8Array;
  commandCode: number | null;
  dispensedWaterMl: number | null;
  cupWeightG: number | null;
  scaleG: number | null;
  isTerminal: boolean;
  /** True for heartbeat-like status bytes that should not drive UI phase. */
  isIgnoredState?: boolean;
  machineInfo?: MachineInfo | null;
};

/**
 * Decode fixed-width Studio/J15 report 40521 (MachineInfoBleModel).
 * Port of packages/core/xbloom_ble/telemetry.parse_machine_info_payload.
 */
export function parseMachineInfoPayload(
  payload: Uint8Array,
): MachineInfo | null {
  if (payload.length < 42) return null;
  const ascii = (start: number, end: number) => {
    let s = "";
    for (let i = start; i < end && i < payload.length; i++) {
      const b = payload[i]!;
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s.trim();
  };
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  // area_ap at offset 29 is present but unused here
  void view.getFloat32(29, true);
  const waterRaw = payload[36]!;
  const tempUnitRaw = payload[40]!;
  const weightUnitRaw = payload[41]!;
  return {
    serialNumber: ascii(0, 13),
    model: ascii(13, 19),
    firmware: ascii(19, 29),
    waterSource: waterRaw === 0 ? "tank" : waterRaw === 1 ? "tap" : `unknown_${waterRaw}`,
    temperatureUnit:
      tempUnitRaw === 0 ? "F" : tempUnitRaw === 1 ? "C" : `unknown_${tempUnitRaw}`,
    weightUnit:
      weightUnitRaw === 0
        ? "ml"
        : weightUnitRaw === 1
          ? "g"
          : weightUnitRaw === 2
            ? "oz"
            : `unknown_${weightUnitRaw}`,
  };
}

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

/**
 * 40521 body after fixed 9-byte header. Prefer official ``c1`` marker; fall back
 * to fixed offsets when firmware omits the marker or binary floats confuse search.
 */
export function extractMachineInfoPayload(frame: Uint8Array): Uint8Array {
  if (frame.length < MIN_NOTIFICATION_FRAME_LENGTH + 2) return new Uint8Array();
  const end = frame.length - 2;
  const marker = markerIdx(frame);
  if (marker >= 0) {
    const after = frame.subarray(marker + 1, end);
    if (after.length >= 42) return after;
  }
  // Header is always 9 bytes; payload may start with optional 0xc1.
  if (frame.length > 9 + 42 + 2) {
    if (frame[9] === STATE_MARKER) return frame.subarray(10, end);
    return frame.subarray(9, end);
  }
  if (frame[9] === STATE_MARKER) return frame.subarray(10, end);
  return frame.subarray(9, end);
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
      stateName: "water_volume",
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
      stateName: "cup_weight",
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
      stateName: "scale_weight",
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
      if (IGNORED_STATES.has(state)) {
        return {
          state,
          stateName: "heartbeat",
          raw: frame,
          commandCode,
          dispensedWaterMl: null,
          cupWeightG: null,
          scaleG: null,
          isTerminal: false,
          isIgnoredState: true,
        };
      }
      const known = STATE_NAMES[state];
      const stateName =
        known ?? `status_0x${state.toString(16).padStart(2, "0")}`;
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

  if (commandCode === MACHINE_INFO_COMMAND) {
    const info = parseMachineInfoPayload(extractMachineInfoPayload(frame));
    return {
      state: null,
      stateName: "machine_info",
      raw: frame,
      commandCode,
      dispensedWaterMl: null,
      cupWeightG: null,
      scaleG: null,
      isTerminal: false,
      machineInfo: info,
    };
  }

  // Command echo / FreeSolo activity report — name from official report table.
  const reportName =
    REPORT_NAMES[commandCode] ??
    `ack_0x${(commandCode & 0xff).toString(16).padStart(2, "0")}`;
  return {
    state: null,
    stateName: reportName,
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
  return (
    state === 0x22 ||
    state === 0x10 ||
    state === 0x23 ||
    state === 0x3b ||
    state === 0x45 || // tea soak / wait between steeps
    state === 0x0c ||
    state === 0x0f
  );
}

export function isArmedState(state: number | null): boolean {
  return state === 0x1f;
}
