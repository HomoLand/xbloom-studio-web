import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  detectWebBluetooth,
  type WebBluetoothCapability,
} from "../ble/capabilities";
import {
  getWebBleSession,
  type SessionSnapshot,
  type WebBleSession,
} from "../ble/session";
import {
  readMachineDriver,
  writeMachineDriver,
  type MachineDriver,
} from "./driver";
import { isStaticDeploy } from "../lib/deploy";

type MachineContextValue = {
  driver: MachineDriver;
  setDriver: (next: MachineDriver) => void;
  webBluetooth: WebBluetoothCapability;
  bleSession: WebBleSession;
  bleSnapshot: SessionSnapshot;
  connectBle: (opts?: { forcePicker?: boolean }) => Promise<void>;
  disconnectBle: () => Promise<void>;
  forgetBleDevice: () => Promise<void>;
};

const MachineContext = createContext<MachineContextValue | null>(null);

export function MachineProvider({ children }: { children: ReactNode }) {
  const [webBluetooth, setWebBluetooth] = useState<WebBluetoothCapability>(() =>
    detectWebBluetooth(),
  );
  const [driver, setDriverState] = useState<MachineDriver>(() =>
    readMachineDriver(isStaticDeploy() ? detectWebBluetooth() : { usable: false }),
  );
  const bleSession = useMemo(() => getWebBleSession(), []);
  const [bleSnapshot, setBleSnapshot] = useState<SessionSnapshot>(() =>
    bleSession.snapshot(),
  );

  useEffect(() => {
    const cap = detectWebBluetooth();
    setWebBluetooth(cap);
    // Only re-default when no explicit preference is stored.
    try {
      const raw = localStorage.getItem("xbloom.machineDriver");
      if (raw == null) {
        setDriverState(readMachineDriver(isStaticDeploy() ? cap : { usable: false }));
      }
    } catch {
      setDriverState(readMachineDriver(isStaticDeploy() ? cap : { usable: false }));
    }
  }, []);

  useEffect(() => bleSession.subscribe(setBleSnapshot), [bleSession]);

  // Restore Chrome-permitted Studio after reload (no picker, no GATT yet).
  useEffect(() => {
    void bleSession.hydratePairedDevice();
  }, [bleSession]);

  const setDriver = useCallback(
    (next: MachineDriver) => {
      if (next !== "web-bluetooth" && bleSession.snapshot().phase !== "idle") {
        void bleSession.disconnect();
      }
      writeMachineDriver(next);
      setDriverState(next);
    },
    [bleSession],
  );

  const connectBle = useCallback(
    async (opts?: { forcePicker?: boolean }) => {
      if (driver !== "web-bluetooth") {
        throw new Error("Switch machine driver to Web Bluetooth first.");
      }
      // Reuses saved pair when possible; forcePicker opens the chooser again.
      await bleSession.connect(opts);
    },
    [bleSession, driver],
  );

  const disconnectBle = useCallback(async () => {
    await bleSession.disconnect();
  }, [bleSession]);

  const forgetBleDevice = useCallback(async () => {
    await bleSession.forgetDevice();
  }, [bleSession]);

  const value = useMemo<MachineContextValue>(
    () => ({
      driver,
      setDriver,
      webBluetooth,
      bleSession,
      bleSnapshot,
      connectBle,
      disconnectBle,
      forgetBleDevice,
    }),
    [
      driver,
      setDriver,
      webBluetooth,
      bleSession,
      bleSnapshot,
      connectBle,
      disconnectBle,
      forgetBleDevice,
    ],
  );

  return (
    <MachineContext.Provider value={value}>{children}</MachineContext.Provider>
  );
}

export function useMachine(): MachineContextValue {
  const ctx = useContext(MachineContext);
  if (!ctx) {
    throw new Error("useMachine must be used within MachineProvider");
  }
  return ctx;
}

export function useMachineOptional(): MachineContextValue | null {
  return useContext(MachineContext);
}
