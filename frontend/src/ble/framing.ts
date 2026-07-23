/**
 * Byte-exact xBloom Studio command frames (pure, no BLE).
 *
 * Port of packages/core/xbloom_ble/protocol.py:
 *   crc16_kermit, xbloom_frame, j15_frame, build_commit/start/cancel.
 *
 * Golden vectors must stay aligned with Python; see framing.test.ts.
 */

import {
  BREW_SEQ,
  CANCEL_OPCODE,
  COMMIT_OPCODE,
  LOAD_SEQ,
  START_OPCODE,
} from "./constants.ts";

/** CRC-16/KERMIT: poly 0x1021, init 0, reflected in/out, no final XOR. */
export function crc16Kermit(data: Uint8Array | number[]): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    let byte = data[i]! & 0xff;
    // Reflect input byte
    byte = reverseBits8(byte);
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  // Reflect 16-bit output
  return reverseBits16(crc);
}

function reverseBits8(value: number): number {
  let v = value & 0xff;
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out = (out << 1) | (v & 1);
    v >>= 1;
  }
  return out;
}

function reverseBits16(value: number): number {
  let v = value & 0xffff;
  let out = 0;
  for (let i = 0; i < 16; i++) {
    out = (out << 1) | (v & 1);
    v >>= 1;
  }
  return out;
}

function u16le(n: number): [number, number] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function u32le(n: number): [number, number, number, number] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

/**
 * Legacy / capture-aligned frame used by load control opcodes in core:
 * ``58 01 01 | cmd | seq | len_u16le | 00 00 | payload | crc16le``.
 */
export function xbloomFrame(cmd: number, seq: number, payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(5 + 2 + 2 + payload.length);
  body[0] = 0x58;
  body[1] = 0x01;
  body[2] = 0x01;
  body[3] = cmd & 0xff;
  body[4] = seq & 0xff;
  // len placeholder at 5..6; reserved 00 00 at 7..8
  body[7] = 0x00;
  body[8] = 0x00;
  body.set(payload, 9);
  const total = body.length + 2;
  const [lo, hi] = u16le(total);
  body[5] = lo;
  body[6] = hi;
  const crc = crc16Kermit(body);
  const frame = new Uint8Array(body.length + 2);
  frame.set(body, 0);
  frame[body.length] = crc & 0xff;
  frame[body.length + 1] = (crc >> 8) & 0xff;
  return frame;
}

/**
 * Official app generic J15 command frame (VerifyCodeUtils.buildCommandString).
 *
 * ``58 01 TYPE | COMMAND(u16le) | LENGTH(u32le) | 01 | DATA | CRC16``.
 */
export function j15Frame(
  command: number,
  opts: {
    data?: number[];
    raw?: Uint8Array;
    frameType?: number;
  } = {},
): Uint8Array {
  const cmd = command | 0;
  if (cmd < 1 || cmd > 0xffff) {
    throw new Error(`command must be 1-65535; got ${command}`);
  }
  const frameType = opts.frameType ?? 0x01;
  if (frameType < 0 || frameType > 0xff) {
    throw new Error("frame_type must fit one byte");
  }
  const values = opts.data ?? [];
  if (opts.raw && values.length > 0) {
    throw new Error("data and raw are mutually exclusive");
  }
  let payload: Uint8Array;
  if (opts.raw) {
    payload = opts.raw;
  } else {
    payload = new Uint8Array(values.length * 4);
    for (let i = 0; i < values.length; i++) {
      const [a, b, c, d] = u32le(values[i]! >>> 0);
      const o = i * 4;
      payload[o] = a;
      payload[o + 1] = b;
      payload[o + 2] = c;
      payload[o + 3] = d;
    }
  }
  const body = new Uint8Array(3 + 2 + 4 + 1 + payload.length);
  body[0] = 0x58;
  body[1] = 0x01;
  body[2] = frameType & 0xff;
  const [c0, c1] = u16le(cmd);
  body[3] = c0;
  body[4] = c1;
  // length u32 at 5..8
  body[9] = 0x01;
  body.set(payload, 10);
  const total = body.length + 2;
  const [l0, l1, l2, l3] = u32le(total >>> 0);
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

/** Commit: arm → awaiting-confirm. Byte-exact ``580101421f0c000000017fcf``. */
export function buildCommit(): Uint8Array {
  return xbloomFrame(COMMIT_OPCODE, LOAD_SEQ, new Uint8Array([0x01]));
}

/** State-sensitive 40518 start/pause. Byte-exact ``580101469e0c0000000180a1``. */
export function buildStart(): Uint8Array {
  return xbloomFrame(START_OPCODE, BREW_SEQ, new Uint8Array([0x01]));
}

/** Cancel. Byte-exact ``580101479e0c00000001553e``. */
export function buildCancel(): Uint8Array {
  return xbloomFrame(CANCEL_OPCODE, BREW_SEQ, new Uint8Array([0x01]));
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
