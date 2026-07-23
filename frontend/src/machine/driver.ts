/**
 * Progressive machine driver preference.
 * See brew docs/ADR-WEB-BLUETOOTH.md.
 */

export type MachineDriver = "bridge" | "web-bluetooth";

export const MACHINE_DRIVER_STORAGE_KEY = "xbloom.machineDriver";

export type DriverCapability = {
  usable: boolean;
};

/**
 * Default driver when the user has no stored preference.
 * W4: web-bluetooth when capability is usable; otherwise bridge.
 */
export function defaultMachineDriver(
  capability: DriverCapability,
): MachineDriver {
  return capability.usable ? "web-bluetooth" : "bridge";
}

/** @deprecated use defaultMachineDriver(detectWebBluetooth()) */
export const DEFAULT_MACHINE_DRIVER: MachineDriver = "bridge";

export function isMachineDriver(value: unknown): value is MachineDriver {
  return value === "bridge" || value === "web-bluetooth";
}

export function readMachineDriver(
  capability?: DriverCapability,
): MachineDriver {
  const cap = capability ?? { usable: false };
  if (typeof localStorage === "undefined") {
    return defaultMachineDriver(cap);
  }
  try {
    const raw = localStorage.getItem(MACHINE_DRIVER_STORAGE_KEY);
    if (isMachineDriver(raw)) return raw;
  } catch {
    /* private mode */
  }
  return defaultMachineDriver(cap);
}

export function writeMachineDriver(driver: MachineDriver): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MACHINE_DRIVER_STORAGE_KEY, driver);
  } catch {
    /* ignore quota */
  }
}
