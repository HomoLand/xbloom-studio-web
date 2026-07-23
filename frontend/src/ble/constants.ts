/**
 * GATT identities aligned with packages/core/xbloom_ble/client.py.
 * Do not invent UUIDs; change only when core changes after hardware proof.
 */

/** Vendor service on xBloom Studio. */
export const SERVICE_UUID = "0000e0ff-3c17-d293-8e48-14fe2e4da212";

/** ffe1 — command write (Write Command / without response). */
export const CHAR_COMMAND = "0000ffe1-0000-1000-8000-00805f9b34fb";

/** ffe2 — status / telemetry notify. */
export const CHAR_STATUS = "0000ffe2-0000-1000-8000-00805f9b34fb";

/** Optional auxiliary characteristic (core may use later). */
export const CHAR_AUX = "0000ffe3-0000-1000-8000-00805f9b34fb";

/** Optional name substring filter for requestDevice (best-effort). */
export const DEVICE_NAME_PREFIXES = ["xBloom", "xbloom", "XBloom"] as const;

export const LOAD_SEQ = 0x1f;
export const BREW_SEQ = 0x9e;

export const COMMIT_OPCODE = 0x42;
export const START_OPCODE = 0x46;
export const CANCEL_OPCODE = 0x47;
