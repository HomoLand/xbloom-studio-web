/**
 * Runtime detection for the Web Bluetooth progressive path (Chrome-focused).
 */

export type WebBluetoothCapability = {
  /** Secure context (HTTPS or localhost). */
  secureContext: boolean;
  /** `navigator.bluetooth` present. */
  apiPresent: boolean;
  /**
   * Chrome getDevices() available — required to reconnect after page reload
   * without opening the device picker again.
   */
  getDevicesAvailable: boolean;
  /** Likely usable for requestDevice (Chrome desktop/Android). */
  usable: boolean;
  /** Short human reason when not usable. */
  reason: string | null;
};

export function detectWebBluetooth(): WebBluetoothCapability {
  const secureContext =
    typeof window !== "undefined" &&
    typeof window.isSecureContext === "boolean" &&
    window.isSecureContext;

  const bt =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth
      : undefined;

  const apiPresent =
    !!bt && typeof bt.requestDevice === "function";
  const getDevicesAvailable =
    !!bt && typeof bt.getDevices === "function";

  if (!secureContext) {
    return {
      secureContext: false,
      apiPresent,
      getDevicesAvailable,
      usable: false,
      reason: "Web Bluetooth requires HTTPS or localhost (secure context).",
    };
  }
  if (!apiPresent) {
    return {
      secureContext: true,
      apiPresent: false,
      getDevicesAvailable,
      usable: false,
      reason:
        "This browser has no Web Bluetooth API. Use Chrome (desktop or Android).",
    };
  }
  return {
    secureContext: true,
    apiPresent: true,
    getDevicesAvailable,
    usable: true,
    reason: null,
  };
}
