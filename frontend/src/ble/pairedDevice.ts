/**
 * Persist Web Bluetooth pairing metadata across page reloads.
 * The BluetoothDevice object itself cannot be stored — only id/name.
 * Recovery uses navigator.bluetooth.getDevices() for the same origin.
 */

const KEY = "xbloom.blePaired.v1";

export type PairedDeviceInfo = {
  id: string;
  name: string | null;
  updatedAt: string;
};

export function readPairedDevice(): PairedDeviceInfo | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PairedDeviceInfo>;
    if (!parsed || typeof parsed.id !== "string" || !parsed.id.trim()) {
      return null;
    }
    return {
      id: parsed.id.trim(),
      name: typeof parsed.name === "string" ? parsed.name : null,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writePairedDevice(info: {
  id: string;
  name?: string | null;
}): void {
  if (typeof localStorage === "undefined") return;
  const id = info.id.trim();
  if (!id) return;
  const payload: PairedDeviceInfo = {
    id,
    name: info.name?.trim() ? info.name.trim() : null,
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
}

export function clearPairedDevice(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
