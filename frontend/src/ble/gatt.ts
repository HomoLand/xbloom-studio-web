/**
 * Thin Web Bluetooth GATT helpers (Chrome).
 * No brew logic here — only device selection, connect, write, notify.
 *
 * Windows/Chrome frequently reports "GATT Server is disconnected" if we
 * resolve services before the link has settled, or if discovery filtered only
 * by service UUID (Studio often omits that UUID from advertisements).
 */

import {
  CHAR_COMMAND,
  CHAR_STATUS,
  DEVICE_NAME_PREFIXES,
  SERVICE_UUID,
} from "./constants.ts";

export type GattHandles = {
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer;
  command: BluetoothRemoteGATTCharacteristic;
  status: BluetoothRemoteGATTCharacteristic;
};

export class BleGattError extends Error {
  readonly code: string;

  constructor(message: string, code = "ble_gatt") {
    super(message);
    this.name = "BleGattError";
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reject a hanging Chrome GATT promise (Windows often never settles). */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new BleGattError(
          `${label} timed out after ${Math.round(ms / 1000)}s. Close the official App, keep Studio awake, then retry Connect (or Cancel connecting).`,
          "timeout",
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function bluetooth(): Bluetooth {
  const bt = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
  if (!bt?.requestDevice) {
    throw new BleGattError(
      "Web Bluetooth is not available in this browser.",
      "not_supported",
    );
  }
  return bt;
}

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type PermittedDevicesResult = {
  devices: BluetoothDevice[];
  /** True when navigator.bluetooth.getDevices exists. */
  apiAvailable: boolean;
  /** Set when getDevices threw (permission backend / browser quirk). */
  error: string | null;
};

/**
 * Devices this origin may use without opening the chooser (Chrome getDevices).
 * Empty when never paired, permission revoked, or API unavailable.
 *
 * Note: after a full page reload, only getDevices can restore a BluetoothDevice.
 * Same-tab disconnect/reconnect uses the in-memory object and does not need this.
 */
export async function getPermittedDevices(): Promise<PermittedDevicesResult> {
  const bt = bluetooth();
  if (typeof bt.getDevices !== "function") {
    return { devices: [], apiAvailable: false, error: null };
  }
  try {
    const devices = await bt.getDevices();
    return {
      devices: Array.isArray(devices) ? devices : [],
      apiAvailable: true,
      error: null,
    };
  } catch (err) {
    return {
      devices: [],
      apiAvailable: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a previously granted Studio without the device picker.
 * Prefers ``preferredId`` (localStorage), then stored/advertised name, then
 * single permitted device.
 */
export async function resolveRememberedStudioDevice(
  preferredId?: string | null,
  preferredName?: string | null,
): Promise<BluetoothDevice | null> {
  const { devices } = await getPermittedDevices();
  if (devices.length === 0) return null;

  if (preferredId) {
    const byId = devices.find((d) => d.id === preferredId);
    if (byId) return byId;
  }

  if (preferredName) {
    const byExact = devices.find((d) => d.name === preferredName);
    if (byExact) return byExact;
  }

  const byPrefix = devices.find((d) => {
    const name = d.name ?? "";
    return DEVICE_NAME_PREFIXES.some((p) => name.startsWith(p));
  });
  if (byPrefix) return byPrefix;

  // Single permitted device is almost always the Studio after our first pair.
  if (devices.length === 1) return devices[0] ?? null;
  return null;
}

/**
 * Prompt the user to pick a Studio.
 * Prefer name prefixes (matches core scan); service UUID is optionalServices only.
 * Must be called from a user gesture.
 */
export async function requestStudioDevice(): Promise<BluetoothDevice> {
  const bt = bluetooth();
  const nameFilters = DEVICE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix }));
  try {
    // Primary: name-based discovery (Studio may not advertise 0xE0FF in AD).
    return await bt.requestDevice({
      filters: [...nameFilters],
      optionalServices: [SERVICE_UUID],
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    // User cancelled — do not fall through to acceptAllDevices.
    if (name === "NotFoundError") {
      // Try service filter + accept-all as last resort (picker shows more devices).
      try {
        return await bt.requestDevice({
          filters: [{ services: [SERVICE_UUID] }, ...nameFilters],
          optionalServices: [SERVICE_UUID],
        });
      } catch (err2) {
        const n2 = err2 instanceof Error ? err2.name : "";
        if (n2 === "NotFoundError") {
          // Final fallback: any device, user must pick the Studio.
          try {
            return await bt.requestDevice({
              acceptAllDevices: true,
              optionalServices: [SERVICE_UUID],
            });
          } catch (err3) {
            if (err3 instanceof Error && err3.name === "NotFoundError") {
              throw new BleGattError(
                "No device selected or none found. Power on the Studio and retry.",
                "not_found",
              );
            }
            throw wrapRequestError(err3);
          }
        }
        throw wrapRequestError(err2);
      }
    }
    throw wrapRequestError(err);
  }
}

function wrapRequestError(err: unknown): BleGattError {
  const name = err instanceof Error ? err.name : "";
  if (name === "SecurityError") {
    return new BleGattError(
      "Web Bluetooth blocked (permissions or insecure context).",
      "security",
    );
  }
  return new BleGattError(asErrorMessage(err), "request_failed");
}

function softDisconnect(device: BluetoothDevice): void {
  try {
    if (device.gatt?.connected) device.gatt.disconnect();
  } catch {
    /* ignore */
  }
}

/**
 * Connect GATT and resolve command/status characteristics.
 * Retries after settle delays — primary fix for the Windows disconnect race.
 */
export async function connectGatt(
  device: BluetoothDevice,
  opts: { attempts?: number; perAttemptMs?: number } = {},
): Promise<GattHandles> {
  if (!device.gatt) {
    throw new BleGattError("Device has no GATT server.", "no_gatt");
  }
  // Fewer attempts + hard per-step timeouts so UI cannot hang forever on Windows.
  const attempts = opts.attempts ?? 3;
  const perAttemptMs = opts.perAttemptMs ?? 8_000;

  // Drop a half-open session so connect() always starts clean.
  softDisconnect(device);
  await sleep(120);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // gatt.connect() can hang indefinitely on Win+Chrome without a timeout.
      const server = await withTimeout(
        device.gatt.connect(),
        perAttemptMs,
        `GATT connect (try ${attempt + 1}/${attempts})`,
      );
      // WinRT/Chrome often needs a beat before primary-service discovery.
      await sleep(180 + attempt * 120);

      if (!device.gatt.connected) {
        throw new BleGattError(
          "GATT connect finished but the link is not connected.",
          "not_connected",
        );
      }

      // Always resolve services from the live gatt server after connect.
      const service = await withTimeout(
        device.gatt.getPrimaryService(SERVICE_UUID),
        perAttemptMs,
        `GATT getPrimaryService (try ${attempt + 1}/${attempts})`,
      );
      const command = await withTimeout(
        service.getCharacteristic(CHAR_COMMAND),
        5_000,
        "GATT getCharacteristic(command)",
      );
      const status = await withTimeout(
        service.getCharacteristic(CHAR_STATUS),
        5_000,
        "GATT getCharacteristic(status)",
      );

      if (!device.gatt.connected) {
        throw new BleGattError(
          "GATT dropped while resolving characteristics.",
          "disconnected",
        );
      }

      return { device, server: device.gatt ?? server, command, status };
    } catch (err) {
      lastError = err;
      softDisconnect(device);
      await sleep(200 + attempt * 150);
    }
  }

  const msg = asErrorMessage(lastError);
  const hint =
    /disconnected|GATT Server is disconnected/i.test(msg)
      ? " Connection dropped while reading services — keep the Studio awake, close the official App, and retry Connect."
      : /timeout/i.test(msg)
        ? " Try Cancel connecting, power-cycle Studio, close the official App, then Connect again."
        : "";
  throw new BleGattError(
    `Could not open Studio GATT after ${attempts} tries: ${msg}.${hint}`,
    "connect_failed",
  );
}

/** True when the device still has a live GATT link. */
export function isGattConnected(handles: GattHandles | null): boolean {
  return Boolean(handles?.device.gatt?.connected);
}

/**
 * Write command without response (matches core Write Command on ffe1).
 * Falls back to writeValue if without-response is rejected.
 */
export async function writeCommand(
  handles: GattHandles,
  frame: Uint8Array,
): Promise<void> {
  if (!handles.device.gatt?.connected) {
    throw new BleGattError(
      "GATT Server is disconnected. Reconnect first (Connect Studio).",
      "disconnected",
    );
  }
  // Fresh copy — some stacks reject sliced ArrayBuffer views after reconnect.
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  try {
    await handles.command.writeValueWithoutResponse(copy);
  } catch (err) {
    if (!handles.device.gatt?.connected) {
      throw new BleGattError(
        "GATT Server is disconnected during write. Reconnect and retry.",
        "disconnected",
      );
    }
    // Characteristic may only allow write-with-response on some stacks.
    try {
      await handles.command.writeValue(copy);
    } catch (err2) {
      throw new BleGattError(
        `BLE write failed: ${asErrorMessage(err2)}`,
        "write_failed",
      );
    }
  }
}

export async function startStatusNotifications(
  handles: GattHandles,
  onValue: (data: DataView) => void,
): Promise<() => void> {
  if (!handles.device.gatt?.connected) {
    throw new BleGattError(
      "GATT Server is disconnected before enabling notifications.",
      "disconnected",
    );
  }
  const listener = (ev: Event) => {
    const target = ev.target as BluetoothRemoteGATTCharacteristic;
    if (target.value) onValue(target.value);
  };
  handles.status.addEventListener("characteristicvaluechanged", listener);
  try {
    await handles.status.startNotifications();
  } catch (err) {
    handles.status.removeEventListener("characteristicvaluechanged", listener);
    throw new BleGattError(
      `Could not enable status notifications: ${asErrorMessage(err)}`,
      "notify_failed",
    );
  }
  return () => {
    handles.status.removeEventListener("characteristicvaluechanged", listener);
    void handles.status.stopNotifications().catch(() => {
      /* page teardown */
    });
  };
}

export function disconnectGatt(handles: GattHandles | null): void {
  if (!handles) return;
  softDisconnect(handles.device);
}
