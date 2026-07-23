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
  opts: { attempts?: number } = {},
): Promise<GattHandles> {
  if (!device.gatt) {
    throw new BleGattError("Device has no GATT server.", "no_gatt");
  }
  const attempts = opts.attempts ?? 4;

  // Drop a half-open session so connect() always starts clean.
  softDisconnect(device);
  await sleep(120);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const server = await device.gatt.connect();
      // WinRT/Chrome often needs a beat before primary-service discovery.
      await sleep(180 + attempt * 120);

      if (!device.gatt.connected) {
        throw new BleGattError(
          "GATT connect finished but the link is not connected.",
          "not_connected",
        );
      }

      // Always resolve services from the live gatt server after connect.
      const service = await device.gatt.getPrimaryService(SERVICE_UUID);
      const command = await service.getCharacteristic(CHAR_COMMAND);
      const status = await service.getCharacteristic(CHAR_STATUS);

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
