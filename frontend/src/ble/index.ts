export {
  CHAR_AUX,
  CHAR_COMMAND,
  CHAR_STATUS,
  SERVICE_UUID,
  CANCEL_OPCODE,
  COMMIT_OPCODE,
  START_OPCODE,
} from "./constants";
export { detectWebBluetooth, type WebBluetoothCapability } from "./capabilities";
export { coffeeContentToProtocol, resolveTemperatureC } from "./coffeeRecipe";
export {
  buildCancel,
  buildCommit,
  buildStart,
  bytesToHex,
  crc16Kermit,
  j15Frame,
  xbloomFrame,
} from "./framing";
export {
  BleGattError,
  connectGatt,
  disconnectGatt,
  isGattConnected,
  requestStudioDevice,
  writeCommand,
  type GattHandles,
} from "./gatt";
export {
  buildLoadFrames,
  buildStatusQuery,
  framesToHex,
  type ProtocolRecipe,
} from "./load";
export {
  WebBleSession,
  getWebBleSession,
  shouldEnterTerminalPhase,
  type SessionPhase,
  type SessionSnapshot,
  type BrewJournalMeta,
} from "./session";
export {
  buildScaleEnter,
  buildScaleExit,
  buildScaleTare,
  buildGrinderEnter,
  buildGrinderStart,
  buildGrinderStop,
  buildGrinderQuit,
  buildBrewerEnter,
  buildBrewerStart,
  buildBrewerStop,
  buildBrewerQuit,
} from "./extras";
export {
  parseNotification,
  notificationFrameIsValid,
  NotificationFrameStream,
  isBrewTerminalState,
  type StatusEvent,
} from "./telemetry";
