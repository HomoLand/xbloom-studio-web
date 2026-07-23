/**
 * Runtime detection for the Web Bluetooth progressive path (Chrome-focused).
 */

export type WebBluetoothCapability = {
  /** Secure context (HTTPS or localhost). */
  secureContext: boolean;
  /** `navigator.bluetooth` present. */
  apiPresent: boolean;
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

  const apiPresent =
    typeof navigator !== "undefined" &&
    "bluetooth" in navigator &&
    typeof (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth
      ?.requestDevice === "function";

  if (!secureContext) {
    return {
      secureContext: false,
      apiPresent,
      usable: false,
      reason: "Web Bluetooth requires HTTPS or localhost (secure context).",
    };
  }
  if (!apiPresent) {
    return {
      secureContext: true,
      apiPresent: false,
      usable: false,
      reason:
        "This browser has no Web Bluetooth API. Use Chrome (desktop or Android).",
    };
  }
  return {
    secureContext: true,
    apiPresent: true,
    usable: true,
    reason: null,
  };
}
