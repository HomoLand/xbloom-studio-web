/**
 * Thin Web Bluetooth GATT helpers (Chrome).
 * No brew logic here — only device selection, connect, write, notify.
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

/**
 * Prompt the user to pick a Studio (or any device advertising the vendor service).
 * Must be called from a user gesture.
 */
export async function requestStudioDevice(): Promise<BluetoothDevice> {
  const bt = bluetooth();
  try {
    return await bt.requestDevice({
      filters: [
        { services: [SERVICE_UUID] },
        ...DEVICE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
      ],
      optionalServices: [SERVICE_UUID],
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotFoundError") {
      throw new BleGattError("No device selected or none found.", "not_found");
    }
    if (name === "SecurityError") {
      throw new BleGattError(
        "Web Bluetooth blocked (permissions or insecure context).",
        "security",
      );
    }
    throw new BleGattError(
      err instanceof Error ? err.message : String(err),
      "request_failed",
    );
  }
}

export async function connectGatt(device: BluetoothDevice): Promise<GattHandles> {
  if (!device.gatt) {
    throw new BleGattError("Device has no GATT server.", "no_gatt");
  }
  const server = device.gatt.connected
    ? device.gatt
    : await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const command = await service.getCharacteristic(CHAR_COMMAND);
  const status = await service.getCharacteristic(CHAR_STATUS);
  return { device, server, command, status };
}

/** Write command without response (matches core Write Command on ffe1). */
export async function writeCommand(
  handles: GattHandles,
  frame: Uint8Array,
): Promise<void> {
  // BufferSource: copy to a plain ArrayBuffer slice for Web Bluetooth typings.
  const buffer = frame.buffer.slice(
    frame.byteOffset,
    frame.byteOffset + frame.byteLength,
  );
  await handles.command.writeValueWithoutResponse(buffer as ArrayBuffer);
}

export async function startStatusNotifications(
  handles: GattHandles,
  onValue: (data: DataView) => void,
): Promise<() => void> {
  const listener = (ev: Event) => {
    const target = ev.target as BluetoothRemoteGATTCharacteristic;
    if (target.value) onValue(target.value);
  };
  handles.status.addEventListener("characteristicvaluechanged", listener);
  await handles.status.startNotifications();
  return () => {
    handles.status.removeEventListener("characteristicvaluechanged", listener);
    void handles.status.stopNotifications().catch(() => {
      /* page teardown */
    });
  };
}

export function disconnectGatt(handles: GattHandles | null): void {
  if (!handles?.device.gatt?.connected) return;
  try {
    handles.device.gatt.disconnect();
  } catch {
    /* ignore */
  }
}
