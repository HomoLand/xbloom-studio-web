/**
 * Web Bluetooth machine session (W0–W3).
 *
 * Device identity is remembered across reloads via localStorage + Chrome
 * getDevices(). GATT is connected on demand (brew / tools) and released after
 * brew terminal so the official App is not blocked.
 *
 * Also records local brew journal + telemetry samples, and exposes FreeSolo
 * scale / grinder / hot-water control builders (same frames as core protocol).
 */

import type { CoffeeRecipeContent, TeaRecipeContent } from "../api";
import {
  appendLocalHistory,
  type TelemetrySample,
} from "../lib/localHistory.ts";
import { coffeeContentToProtocol } from "./coffeeRecipe.ts";
import {
  buildRecipeStartQuit,
  buildTeaLoadFrames,
  buildTeaStart,
  teaContentToProtocol,
} from "./teaLoad.ts";
import {
  buildBrewerEnter,
  buildBrewerPause,
  buildBrewerQuit,
  buildBrewerResume,
  buildBrewerSetPattern,
  buildBrewerSetTemperature,
  buildBrewerStart,
  buildBrewerStop,
  buildGrinderEnter,
  buildGrinderPause,
  buildGrinderQuit,
  buildGrinderResume,
  buildGrinderStart,
  buildGrinderStop,
  buildReadPourRadius,
  buildReadVibrationAmplitude,
  buildScaleEnter,
  buildScaleExit,
  buildScaleTare,
  buildSetDisplay,
  buildSetTemperatureUnit,
  buildSetWaterSource,
  buildSetWeightUnit,
  buildWritePourRadius,
  buildWriteVibrationAmplitude,
  type DisplayLevel,
  type TemperatureUnit,
  type WaterSource,
  type WeightUnit,
} from "./extras.ts";
import { buildSlotBatch } from "./slots.ts";
import {
  buildCancel,
  buildCoffeePause,
  buildCoffeeResume,
  buildCommit,
  buildStart,
} from "./framing.ts";
import {
  connectGatt,
  disconnectGatt,
  isGattConnected,
  requestStudioDevice,
  resolveRememberedStudioDevice,
  startStatusNotifications,
  writeCommand,
  type GattHandles,
  BleGattError,
} from "./gatt.ts";
import {
  clearPairedDevice,
  readPairedDevice,
  writePairedDevice,
} from "./pairedDevice.ts";
import {
  buildLoadFrames,
  buildSessionStart,
  buildStatusQuery,
} from "./load.ts";
import {
  CUP_WEIGHT_COMMAND,
  isActedBrewState,
  isArmedState,
  isBrewTerminalState,
  isIgnoredMachineState,
  NotificationFrameStream,
  parseNotification,
  REPORT_NAMES,
  SCALE_WEIGHT_COMMAND,
  STATE_NAMES,
  STATUS_COMMAND,
  WATER_VOLUME_COMMAND,
  type MachineInfo,
  type StatusEvent,
} from "./telemetry.ts";

/** Tea firmware report codes that mean a brew is actually running. */
const TEA_ACTIVE_REPORTS = new Set([
  9011, // tea_restarted
  9012, // tea_soaking
  40515, // tea_paused
  40520, // bypass_started (tea siphon finish phase on firmware)
  40502, // coffee_brewer_started (also used by some tea paths)
]);

const MACHINE_SERIAL_KEY = "xbloom.machine.serial.v1";

export function readCachedMachineSerial(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const s = localStorage.getItem(MACHINE_SERIAL_KEY)?.trim() ?? "";
    return s.length >= 4 ? s : null;
  } catch {
    return null;
  }
}

export function cacheMachineSerial(sn: string): void {
  const t = sn.trim();
  if (t.length < 4 || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MACHINE_SERIAL_KEY, t);
  } catch {
    /* ignore */
  }
}

/** Throttle telemetry samples to keep localStorage small. */
const TELEMETRY_SAMPLE_MIN_MS = 400;
const TELEMETRY_MAX_SAMPLES = 600;

export type BrewJournalMeta = {
  recipe_name?: string;
  recipe_revision_id?: string;
  workflow_id?: string;
  kind?: string;
  /** Target total water (ml) for Live View progress. */
  target_water_ml?: number;
  /** Number of pour stages for progress UI. */
  pour_count?: number;
};

export type SessionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "loading"
  | "armed"
  | "starting"
  | "brewing"
  | "paused"
  | "terminal"
  | "error"
  | "disconnected";

/**
 * Whether a decoded machine state should move the session to ``terminal``.
 * Idle-at-rest while merely connected must NOT terminal (would auto-disconnect).
 * Ready/complete, or idle after an active brew path, do.
 */
export function shouldEnterTerminalPhase(
  phase: SessionPhase,
  machineState: number,
): boolean {
  const activeBrewPhase =
    phase === "loading" ||
    phase === "armed" ||
    phase === "starting" ||
    phase === "brewing" ||
    phase === "paused";
  if (!activeBrewPhase) return false;
  if (isBrewTerminalState(machineState)) return true;
  // Return to idle after brew/cancel.
  return machineState === 0x01;
}

export type SessionSnapshot = {
  phase: SessionPhase;
  deviceId: string | null;
  deviceName: string | null;
  /** True when a Studio was paired before (localStorage and/or in-memory). */
  hasPairedDevice: boolean;
  /**
   * True when we hold a live BluetoothDevice object that can reconnect without
   * the Chrome chooser (same tab, or restored via getDevices after reload).
   */
  pairRestored: boolean;
  /**
   * After reload: localStorage has a pair but Chrome getDevices() did not
   * return it — next Connect must open the chooser once to re-grant.
   */
  needsChooserToRestore: boolean;
  lastError: string | null;
  notifyCount: number;
  /** Latest decoded machine phase label (e.g. armed, brewing). */
  machineStateName: string | null;
  machineState: number | null;
  /**
   * Last FreeSolo / report activity (enter, tare, brewer_started, …).
   * Separate from machineStateName so ACKs do not flash over idle/brewing.
   */
  lastActivityName: string | null;
  cupWeightG: number | null;
  /** FreeSolo electronic-scale grams (report 10507); may differ from cup scale. */
  scaleG: number | null;
  dispensedWaterMl: number | null;
  loaded: boolean;
  /** Live telemetry buffer for current brew (copy). */
  telemetrySamples: TelemetrySample[];
  brewElapsedMs: number | null;
  targetWaterMl: number | null;
  pourCount: number | null;
  recipeName: string | null;
  /** Last finished brew (survives disconnect) for Dashboard complete banner. */
  lastCompletedBrew: {
    recipeName: string | null;
    recipeRevisionId: string | null;
    kind: string | null;
    outcome: string;
    at: string;
  } | null;
  /** Latest 40521 identity dump (serial for Easy-mode cloud read). */
  machineInfo: MachineInfo | null;
};

type Listener = (snap: SessionSnapshot) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WebBleSession {
  private handles: GattHandles | null = null;
  /** Last chosen device — allows reconnect without another picker when permitted. */
  private device: BluetoothDevice | null = null;
  private stopNotify: (() => void) | null = null;
  private phase: SessionPhase = "idle";
  private lastError: string | null = null;
  private notifyCount = 0;
  private machineStateName: string | null = null;
  private machineState: number | null = null;
  private lastActivityName: string | null = null;
  private cupWeightG: number | null = null;
  private scaleG: number | null = null;
  private dispensedWaterMl: number | null = null;
  private loaded = false;
  /** True while connect() is still wiring services/notify — ignore spur ious disconnects. */
  private setupInProgress = false;
  /** Bumped by abortConnect / new connect so in-flight connect work is abandoned. */
  private connectGeneration = 0;
  private readonly stream = new NotificationFrameStream();
  private readonly listeners = new Set<Listener>();
  private terminalWatch: ReturnType<typeof setInterval> | null = null;
  private onDisconnected: (() => void) | null = null;

  /** Active brew journal context (set from UI before load/start). */
  private brewMeta: BrewJournalMeta | null = null;
  private brewStartedAtMs: number | null = null;
  private telemetrySamples: TelemetrySample[] = [];
  private lastSampleAtMs = 0;
  private historyFlushed = false;
  /**
   * True after we observe real brew activity. Idle (0x01) must not terminal
   * until this is set — otherwise tea start is aborted while machine still idle.
   */
  private brewActed = false;
  private lastCompletedBrew: SessionSnapshot["lastCompletedBrew"] = null;
  private machineInfo: MachineInfo | null = null;
  private machineInfoWaiters: Array<(info: MachineInfo | null) => void> = [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): SessionSnapshot {
    const stored = readPairedDevice();
    const deviceId =
      this.handles?.device.id ?? this.device?.id ?? stored?.id ?? null;
    const deviceName =
      this.handles?.device.name ??
      this.device?.name ??
      stored?.name ??
      null;
    const hasPairedDevice = Boolean(this.device || stored);
    const pairRestored = Boolean(this.device);
    return {
      phase: this.phase,
      deviceId,
      deviceName,
      hasPairedDevice,
      pairRestored,
      // Stored id/name exists but no BluetoothDevice yet → reload lost JS object
      // and getDevices did not restore (or not yet hydrated).
      needsChooserToRestore: Boolean(stored && !this.device),
      lastError: this.lastError,
      notifyCount: this.notifyCount,
      machineStateName: this.machineStateName,
      machineState: this.machineState,
      lastActivityName: this.lastActivityName,
      cupWeightG: this.cupWeightG,
      scaleG: this.scaleG,
      dispensedWaterMl: this.dispensedWaterMl,
      loaded: this.loaded,
      telemetrySamples: this.telemetrySamples.slice(),
      brewElapsedMs:
        this.brewStartedAtMs != null ? Date.now() - this.brewStartedAtMs : null,
      targetWaterMl: this.brewMeta?.target_water_ml ?? null,
      pourCount: this.brewMeta?.pour_count ?? null,
      recipeName: this.brewMeta?.recipe_name ?? null,
      lastCompletedBrew: this.lastCompletedBrew
        ? { ...this.lastCompletedBrew }
        : null,
      machineInfo: this.machineInfo ? { ...this.machineInfo } : null,
    };
  }

  /** Dismiss the post-brew complete banner. */
  clearLastCompletedBrew(): void {
    this.lastCompletedBrew = null;
    this.emit();
  }

  private rememberDevice(device: BluetoothDevice): void {
    this.device = device;
    writePairedDevice({ id: device.id, name: device.name ?? null });
  }

  /**
   * Restore BluetoothDevice from Chrome permission grant (no picker).
   * Safe to call on page load without a user gesture.
   * @returns true when a BluetoothDevice is available for silent reconnect.
   */
  async hydratePairedDevice(): Promise<boolean> {
    if (this.device) {
      this.emit();
      return true;
    }
    const stored = readPairedDevice();
    // Prefer stored id/name; resolver also matches name prefix / single grant.
    const restored = await resolveRememberedStudioDevice(
      stored?.id ?? null,
      stored?.name ?? null,
    );
    if (!restored) {
      this.emit();
      return false;
    }
    this.rememberDevice(restored);
    this.emit();
    return true;
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private setPhase(phase: SessionPhase, error?: string | null): void {
    this.phase = phase;
    if (phase === "error") {
      this.lastError = error ?? this.lastError ?? "Unknown BLE error";
    } else if (phase === "connected" || phase === "idle") {
      this.lastError = null;
    } else if (error != null) {
      this.lastError = error;
    }
    this.emit();
  }

  /**
   * Attach recipe metadata for the next brew so terminal/cancel can journal it.
   * Call before loadCoffee / startBrew from the UI.
   */
  beginBrewJournal(meta: BrewJournalMeta): void {
    this.brewMeta = { ...meta };
    this.brewStartedAtMs = Date.now();
    this.telemetrySamples = [];
    this.lastSampleAtMs = 0;
    this.historyFlushed = false;
    this.brewActed = false;
  }

  private maybeSampleTelemetry(): void {
    const active =
      this.phase === "loading" ||
      this.phase === "armed" ||
      this.phase === "starting" ||
      this.phase === "brewing" ||
      this.phase === "paused" ||
      this.phase === "terminal";
    if (!active || this.brewStartedAtMs == null) return;
    const now = Date.now();
    if (
      this.telemetrySamples.length > 0 &&
      now - this.lastSampleAtMs < TELEMETRY_SAMPLE_MIN_MS
    ) {
      return;
    }
    if (this.telemetrySamples.length >= TELEMETRY_MAX_SAMPLES) return;
    this.lastSampleAtMs = now;
    this.telemetrySamples.push({
      t: now - this.brewStartedAtMs,
      state: this.machineState,
      stateName: this.machineStateName,
      cupWeightG: this.cupWeightG,
      dispensedWaterMl: this.dispensedWaterMl,
    });
  }

  private flushBrewHistory(outcome: string, note?: string): void {
    if (this.historyFlushed) return;
    // Only journal when we had an active brew path (meta or samples).
    if (!this.brewMeta && this.telemetrySamples.length === 0) return;
    this.historyFlushed = true;
    // Final sample at terminal.
    this.maybeSampleTelemetry();
    const meta = this.brewMeta;
    this.lastCompletedBrew = {
      recipeName: meta?.recipe_name ?? null,
      recipeRevisionId: meta?.recipe_revision_id ?? null,
      kind: meta?.kind ?? null,
      outcome,
      at: new Date().toISOString(),
    };
    try {
      appendLocalHistory({
        outcome,
        source: "web-bluetooth",
        recipe_name: meta?.recipe_name,
        recipe_revision_id: meta?.recipe_revision_id,
        workflow_id: meta?.workflow_id,
        kind: meta?.kind ?? "coffee",
        note,
        machine: this.device?.name ?? this.handles?.device.name ?? undefined,
        telemetry: this.telemetrySamples.slice(),
      });
    } catch {
      /* localStorage full / private mode — never break brew path */
    }
    this.brewMeta = null;
    this.brewStartedAtMs = null;
    this.telemetrySamples = [];
  }

  private outcomeFromMachineState(): string {
    const s = this.machineState;
    if (s === 0x24 || s === 0x41) return "completed";
    if (s === 0x1f) return "failed";
    if (s === 0x01) return "completed"; // idle after brew path
    return "completion_unconfirmed";
  }

  private applyEvent(ev: StatusEvent): void {
    this.notifyCount += 1;

    const inBrewPath =
      this.phase === "loading" ||
      this.phase === "armed" ||
      this.phase === "starting" ||
      this.phase === "brewing" ||
      this.phase === "paused";

    // Named FreeSolo / report activity (tare ACK, brewer_started, …).
    // Do not overwrite machineStateName — that flash looked like "unknown".
    if (
      ev.state == null &&
      ev.stateName &&
      ev.stateName !== "cup_weight" &&
      ev.stateName !== "scale_weight" &&
      ev.stateName !== "water_volume"
    ) {
      this.lastActivityName = ev.stateName;
    } else if (
      ev.commandCode != null &&
      REPORT_NAMES[ev.commandCode] &&
      ev.commandCode !== STATUS_COMMAND &&
      ev.commandCode !== CUP_WEIGHT_COMMAND &&
      ev.commandCode !== SCALE_WEIGHT_COMMAND &&
      ev.commandCode !== WATER_VOLUME_COMMAND
    ) {
      this.lastActivityName = REPORT_NAMES[ev.commandCode]!;
    }

    // Tea/coffee activity reports — only during an actual brew path
    // (FreeSolo hot water also emits 40502 etc.; must not hijack Tools).
    if (
      inBrewPath &&
      ev.commandCode != null &&
      TEA_ACTIVE_REPORTS.has(ev.commandCode)
    ) {
      this.brewActed = true;
      if (
        this.phase === "starting" ||
        this.phase === "armed" ||
        this.phase === "loading"
      ) {
        this.phase = "brewing";
      }
      if (ev.commandCode === 40515) {
        this.phase = "paused";
      }
    }
    if (ev.dispensedWaterMl != null && ev.dispensedWaterMl > 0) {
      if (
        this.phase === "starting" ||
        this.phase === "brewing" ||
        this.phase === "armed"
      ) {
        this.brewActed = true;
      }
    }
    if (ev.state != null && !ev.isIgnoredState && !isIgnoredMachineState(ev.state)) {
      this.machineState = ev.state;
      // Always prefer STATE_NAMES for known bytes (0x45 → tea_soaking, never status_0x45).
      const canonical = STATE_NAMES[ev.state] ?? null;
      if (canonical) {
        this.machineStateName = canonical;
      } else if (
        !ev.stateName.startsWith("status_0x") &&
        !ev.stateName.startsWith("unknown")
      ) {
        this.machineStateName = ev.stateName;
      } else {
        // Unknown wire byte: keep last friendly name; stash raw for debug activity only.
        this.lastActivityName = ev.stateName;
      }
      if (isArmedState(ev.state)) {
        this.loaded = true;
        if (this.phase === "loading" || this.phase === "connected") {
          this.phase = "armed";
        }
      }
      if (inBrewPath && isActedBrewState(ev.state)) {
        this.brewActed = true;
        if (
          this.phase === "starting" ||
          this.phase === "armed" ||
          this.phase === "loading" ||
          this.phase === "paused"
        ) {
          // 0x45 tea_soaking is still an active brew wait, not paused UI.
          this.phase = "brewing";
        }
      }
      // Terminal ready/complete always ends brew.
      if (isBrewTerminalState(ev.state) && shouldEnterTerminalPhase(this.phase, ev.state)) {
        this.phase = "terminal";
        this.maybeSampleTelemetry();
        this.flushBrewHistory(this.outcomeFromMachineState());
      } else if (
        // Idle only terminals after we actually saw brew activity (tea-safe).
        ev.state === 0x01 &&
        this.brewActed &&
        shouldEnterTerminalPhase(this.phase, ev.state)
      ) {
        this.phase = "terminal";
        this.maybeSampleTelemetry();
        this.flushBrewHistory(this.outcomeFromMachineState());
      }
    }
    if (ev.cupWeightG != null) this.cupWeightG = ev.cupWeightG;
    if (ev.scaleG != null) this.scaleG = ev.scaleG;
    if (ev.dispensedWaterMl != null) this.dispensedWaterMl = ev.dispensedWaterMl;
    if (ev.machineInfo) {
      this.machineInfo = ev.machineInfo;
      if (ev.machineInfo.serialNumber?.trim()) {
        cacheMachineSerial(ev.machineInfo.serialNumber);
      }
      const waiters = this.machineInfoWaiters.splice(0);
      for (const w of waiters) w(ev.machineInfo);
    } else if (ev.commandCode === 40521) {
      // Seen 40521 but decode failed — keep activity for UI diagnostics.
      this.lastActivityName = "machine_info_undecoded";
    }
    this.maybeSampleTelemetry();
    this.emit();
  }

  private onNotifyChunk(data: DataView): void {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const frame of this.stream.feed(bytes)) {
      const ev = parseNotification(frame);
      if (ev) this.applyEvent(ev);
    }
  }

  /**
   * Connect or reconnect.
   *
   * Resolution order (no chooser when possible):
   * 1. In-memory device from this tab session
   * 2. Chrome getDevices() + saved id (after first pair / page reload)
   * 3. requestDevice() picker — needs a user gesture (first pair or forcePicker)
   *
   * After brew ends we soft-disconnect GATT but keep the pair so the next
   * Confirm brew can reconnect automatically.
   *
   * Localhost vs GitHub Pages are different origins: each needs its own first
   * picker grant. Windows GATT connect can hang — connectGatt uses timeouts.
   */
  async connect(opts: { forcePicker?: boolean } = {}): Promise<void> {
    this.stopTerminalWatch();
    // Invalidate any previous in-flight connect.
    this.connectGeneration += 1;
    const gen = this.connectGeneration;

    // 1) Resolve device. Prefer remembered grants so brew/tools skip the picker.
    // Do NOT set phase "connecting" before a chooser — cancelled pickers looked stuck.
    let device: BluetoothDevice | null = null;
    try {
      if (opts.forcePicker) {
        // User explicitly wants the chooser (change machine).
        device = await requestStudioDevice();
        if (gen !== this.connectGeneration) return;
        this.rememberDevice(device);
      } else {
        device = this.device;
        if (!device) {
          const stored = readPairedDevice();
          // Only call getDevices when we already paired once (or any prior
          // grant may exist). Skipping it on cold first pair keeps
          // requestDevice as the first await (user gesture).
          if (stored) {
            device = await resolveRememberedStudioDevice(
              stored.id,
              stored.name,
            );
            if (gen !== this.connectGeneration) return;
            if (device) this.rememberDevice(device);
          }
        }
        if (!device) {
          // First pair, or Chrome did not persist BLE grant across reload.
          // Chooser is required once; same-tab reconnect stays silent after.
          device = await requestStudioDevice();
          if (gen !== this.connectGeneration) return;
          this.rememberDevice(device);
        }
      }
    } catch (err) {
      this.setupInProgress = false;
      const message =
        err instanceof BleGattError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      if (/NotFoundError|not_found|No device selected|cancelled|abort/i.test(message)) {
        this.setPhase("idle");
        return;
      }
      this.setPhase("error", message);
      throw err;
    }

    // 2) GATT work (no picker from here).
    this.setupInProgress = true;
    this.setPhase("connecting");
    if (this.stopNotify) {
      this.stopNotify();
      this.stopNotify = null;
    }
    disconnectGatt(this.handles);
    this.handles = null;

    try {
      await sleep(80);
      if (gen !== this.connectGeneration) return;
      this.bindDisconnectListener(device);
      this.handles = await connectGatt(device);
      if (gen !== this.connectGeneration) {
        this.cleanupHandles(true);
        return;
      }
      this.notifyCount = 0;
      this.stream.reset();
      this.machineState = null;
      this.machineStateName = null;
      this.lastActivityName = null;
      this.cupWeightG = null;
      this.scaleG = null;
      this.dispensedWaterMl = null;
      this.loaded = false;
      this.stopNotify = await startStatusNotifications(this.handles, (dv) =>
        this.onNotifyChunk(dv),
      );
      if (gen !== this.connectGeneration) {
        this.cleanupHandles(true);
        return;
      }
      await sleep(100);
      if (!isGattConnected(this.handles)) {
        this.handles = await connectGatt(device);
        if (gen !== this.connectGeneration) {
          this.cleanupHandles(true);
          return;
        }
        this.stopNotify = await startStatusNotifications(this.handles, (dv) =>
          this.onNotifyChunk(dv),
        );
        await sleep(100);
      }
      if (gen !== this.connectGeneration) {
        this.cleanupHandles(true);
        return;
      }
      // App/Python parity: a4 session-start then 0x56 status. 40521 (serial)
      // usually arrives only after this handshake — not from status alone.
      try {
        await writeCommand(this.handles, buildSessionStart());
        await sleep(300);
      } catch {
        /* status query still attempted */
      }
      if (gen !== this.connectGeneration) {
        this.cleanupHandles(true);
        return;
      }
      await writeCommand(this.handles, buildStatusQuery());
      if (gen !== this.connectGeneration) {
        this.cleanupHandles(true);
        return;
      }
      // Confirm pair after a live link (name may appear only after connect).
      this.rememberDevice(device);
      this.setupInProgress = false;
      this.setPhase("connected");
      // Non-blocking warm-cache of serial (40521). Failure is fine — explicit
      // Easy-mode read will retry with full handshake / manual SN.
      void (async () => {
        try {
          await sleep(200);
          if (!this.handles) return;
          await writeCommand(this.handles, buildStatusQuery());
        } catch {
          /* ignore */
        }
      })();
    } catch (err) {
      if (gen !== this.connectGeneration) {
        // Aborted — leave phase as idle (abortConnect already set it).
        return;
      }
      this.setupInProgress = false;
      this.cleanupHandles(true);
      const message =
        err instanceof BleGattError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Transient GATT failure: keep localStorage pair so next brew retries
      // without a picker. Only drop the in-memory object on hard hangs so
      // abort/retry can re-resolve via getDevices.
      if (/timeout|connect_failed/i.test(message)) {
        this.unbindDisconnectListener();
        this.device = null;
      }
      this.setPhase("error", message);
      throw err;
    }
  }

  /** Cancel a stuck ``connecting`` phase (chooser hang / GATT hang). */
  abortConnect(): void {
    this.connectGeneration += 1;
    this.setupInProgress = false;
    // Drop half-open GATT so the next connect is clean.
    if (this.device) {
      try {
        this.device.gatt?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.cleanupHandles(true);
    // Clear in-memory only — localStorage pair stays so hydrate/getDevices works.
    this.unbindDisconnectListener();
    this.device = null;
    this.setPhase("idle");
  }

  /** Soft disconnect: drop GATT, keep paired device for auto-reconnect on brew. */
  async disconnect(): Promise<void> {
    this.stopTerminalWatch();
    this.setupInProgress = false;
    this.cleanupHandles(true);
    this.loaded = false;
    // Intentionally keep this.device + localStorage for the next brew connect.
    this.setPhase("idle");
  }

  /** Forget paired device (next Connect shows the picker again). */
  async forgetDevice(): Promise<void> {
    await this.disconnect();
    this.unbindDisconnectListener();
    this.device = null;
    clearPairedDevice();
    this.emit();
  }

  /**
   * Ensure a live GATT link before a write. Reuses the last paired device
   * (no second picker) when Chrome still remembers the permission.
   */
  private async ensureLinked(): Promise<void> {
    if (isGattConnected(this.handles)) return;
    if (!this.device) {
      const stored = readPairedDevice();
      const restored =
        (await resolveRememberedStudioDevice(
          stored?.id ?? null,
          stored?.name ?? null,
        )) ?? (await resolveRememberedStudioDevice(null, null));
      if (restored) {
        this.rememberDevice(restored);
      }
    }
    if (!this.device) {
      throw new BleGattError(
        "Not connected. Pair Studio once (Connect), then brew will auto-reconnect.",
        "not_connected",
      );
    }
    this.setupInProgress = true;
    try {
      if (this.stopNotify) {
        this.stopNotify();
        this.stopNotify = null;
      }
      this.bindDisconnectListener(this.device);
      this.handles = await connectGatt(this.device);
      this.stopNotify = await startStatusNotifications(this.handles, (dv) =>
        this.onNotifyChunk(dv),
      );
      await sleep(80);
      if (
        this.phase === "idle" ||
        this.phase === "disconnected" ||
        this.phase === "error" ||
        this.phase === "terminal"
      ) {
        this.setPhase("connected");
      }
    } finally {
      this.setupInProgress = false;
    }
  }

  private unbindDisconnectListener(): void {
    if (this.device && this.onDisconnected) {
      this.device.removeEventListener(
        "gattserverdisconnected",
        this.onDisconnected,
      );
    }
    this.onDisconnected = null;
  }

  private bindDisconnectListener(device: BluetoothDevice): void {
    this.unbindDisconnectListener();
    this.onDisconnected = () => {
      if (this.setupInProgress) return;
      if (this.handles?.device === device || this.device === device) {
        this.cleanupHandles(false);
        if (this.phase !== "idle" && this.phase !== "terminal") {
          this.setPhase("disconnected");
        }
      }
    };
    device.addEventListener("gattserverdisconnected", this.onDisconnected);
  }

  /**
   * Write four LOAD frames. Does not commit/start.
   * Waits until decoded state is armed (or timeout).
   */
  async loadCoffee(
    content: CoffeeRecipeContent,
    opts: { timeoutMs?: number; journal?: BrewJournalMeta } = {},
  ): Promise<void> {
    if (!this.handles || (this.phase !== "connected" && this.phase !== "armed" && this.phase !== "terminal")) {
      if (!this.handles || this.phase === "idle" || this.phase === "disconnected" || this.phase === "error") {
        throw new BleGattError("Connect to the machine before loading.", "not_connected");
      }
    }
    const targetWater =
      Number(content.water_ml) ||
      content.pours.reduce((s, p) => s + Number(p.ml || 0), 0);
    if (opts.journal) {
      this.beginBrewJournal({
        ...opts.journal,
        recipe_name: opts.journal.recipe_name ?? content.name,
        kind: opts.journal.kind ?? content.kind,
        target_water_ml: opts.journal.target_water_ml ?? targetWater,
        pour_count: opts.journal.pour_count ?? content.pours.length,
      });
    } else if (!this.brewMeta) {
      this.beginBrewJournal({
        recipe_name: content.name,
        kind: content.kind,
        target_water_ml: targetWater,
        pour_count: content.pours.length,
      });
    }
    const frames = buildLoadFrames(coffeeContentToProtocol(content));
    this.loaded = false;
    this.setPhase("loading");
    for (const frame of frames) {
      await this.requireWrite(frame);
      await sleep(80);
    }
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isArmedState(this.machineState)) {
        this.loaded = true;
        this.setPhase("armed");
        return;
      }
      await sleep(100);
    }
    // Some firmwares arm without a fresh 0x57 if already observed loading — still
    // mark loaded if we never saw an error; prefer fail-open to armed only when state known.
    if (this.machineStateName === "loading") {
      // keep waiting a bit more was done; fail with clear error
    }
    throw new BleGattError(
      `Load did not reach armed state (last=${this.machineStateName ?? "none"}).`,
      "load_timeout",
    );
  }

  /**
   * Upload tea recipe (set cup + code). Does not execute.
   *
   * Matches Python ``load_tea_recipe``: session a4 + status settle, then
   * 8104 set-cup and 4513 recipe-code. Separately call startTea after confirm.
   */
  async loadTea(
    content: TeaRecipeContent,
    opts: { journal?: BrewJournalMeta; settleMs?: number } = {},
  ): Promise<void> {
    if (
      !this.handles ||
      this.phase === "idle" ||
      this.phase === "disconnected" ||
      this.phase === "error" ||
      this.phase === "connecting"
    ) {
      throw new BleGattError(
        "Connect to the machine before loading tea.",
        "not_connected",
      );
    }
    const programmed = (content.pours || []).reduce(
      (s, p) => s + Number(p.ml || 0),
      0,
    );
    if (opts.journal) {
      this.beginBrewJournal({
        ...opts.journal,
        recipe_name: opts.journal.recipe_name ?? content.name,
        kind: "tea",
        target_water_ml: opts.journal.target_water_ml ?? programmed,
        pour_count: opts.journal.pour_count ?? content.pours.length,
      });
    } else {
      this.beginBrewJournal({
        recipe_name: content.name,
        kind: "tea",
        target_water_ml: programmed,
        pour_count: content.pours.length,
      });
    }
    this.loaded = false;
    this.brewActed = false;
    this.setPhase("loading");

    // Fresh CLI/app session handshake (required — without it tea frames are ignored).
    await this.requireWrite(buildSessionStart());
    await sleep(500);
    await this.requireWrite(buildStatusQuery());
    await sleep(opts.settleMs ?? 2000);

    const frames = buildTeaLoadFrames(teaContentToProtocol(content));
    for (const frame of frames) {
      await this.requireWrite(frame);
      // Pace like the Python client (machine needs spacing + notify ACKs).
      await sleep(400);
    }
    // Tea pre-start is not coffee armed 0x1f; mark loaded for startTea.
    this.loaded = true;
    this.setPhase("armed");
  }

  /** Execute previously uploaded tea recipe (CMD 4512). */
  async startTea(): Promise<void> {
    if (!this.handles) {
      throw new BleGattError("Not connected.", "not_connected");
    }
    if (!this.loaded && this.phase !== "armed") {
      throw new BleGattError("Load a tea recipe before starting.", "not_armed");
    }
    this.brewActed = false;
    this.setPhase("starting");
    await this.requireWrite(buildTeaStart());
    // Do not force brewing+release immediately: wait for tea_soaking / water.
    // Forcing brewing while still idle used to auto-terminal and disconnect.
    this.setPhase("brewing");
    this.watchTerminalAndRelease();
  }

  /** Exit tea pre-start without brewing. */
  async unloadTea(): Promise<void> {
    await this.requireWrite(buildRecipeStartQuit());
    this.loaded = false;
    if (this.phase === "armed" || this.phase === "loading") {
      this.setPhase("connected");
    }
  }

  /**
   * Start armed brew: commit, observe, optional 40518 if still awaiting_confirm.
   * UI gates start with an explicit red confirm (no typed phrase).
   */
  async startBrew(opts: { settleMs?: number } = {}): Promise<void> {
    if (!this.handles) {
      throw new BleGattError("Not connected.", "not_connected");
    }
    if (!this.loaded && !isArmedState(this.machineState)) {
      throw new BleGattError("Load a recipe before starting.", "not_armed");
    }
    this.setPhase("starting");
    await this.requireWrite(buildCommit());
    const settleMs = opts.settleMs ?? 8000;
    const deadline = Date.now() + settleMs;
    let sawAwaiting = false;
    while (Date.now() < deadline) {
      if (isActedBrewState(this.machineState)) {
        this.setPhase("brewing");
        this.watchTerminalAndRelease();
        return;
      }
      if (this.machineState === 0x1e) sawAwaiting = true;
      await sleep(100);
    }
    if (!sawAwaiting && !isActedBrewState(this.machineState)) {
      throw new BleGattError(
        "Commit outcome unconfirmed; refusing state-sensitive start control.",
        "start_unconfirmed",
      );
    }
    // Fresh recheck via status query
    await this.requireWrite(buildStatusQuery());
    await sleep(400);
    if (isActedBrewState(this.machineState)) {
      this.setPhase("brewing");
      this.watchTerminalAndRelease();
      return;
    }
    if (this.machineState !== 0x1e) {
      throw new BleGattError(
        `Cannot send start control from state ${this.machineStateName ?? "unknown"}.`,
        "start_state",
      );
    }
    await this.requireWrite(buildStart());
    const after = Date.now() + 5000;
    while (Date.now() < after) {
      if (isActedBrewState(this.machineState)) {
        this.setPhase("brewing");
        this.watchTerminalAndRelease();
        return;
      }
      if (isArmedState(this.machineState)) {
        throw new BleGattError(
          "Start control returned machine to armed; possible start/pause race.",
          "start_race",
        );
      }
      await sleep(100);
    }
    // If still running toward brew without explicit acted state, keep monitoring.
    this.setPhase("brewing");
    this.watchTerminalAndRelease();
  }

  async cancelBrew(): Promise<void> {
    await this.requireWrite(buildCancel());
    // Wait briefly for idle/terminal then disconnect.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (
        this.machineState === 0x01 ||
        this.machineState === 0x24 ||
        this.machineState === 0x41 ||
        this.machineState === 0x1f
      ) {
        break;
      }
      await sleep(100);
    }
    this.phase = "terminal";
    this.maybeSampleTelemetry();
    this.flushBrewHistory("cancelled");
    this.emit();
    await this.disconnect();
  }

  /**
   * Pause a running brew (state-sensitive 40518).
   * Works for coffee; tea firmware may also accept it during pour/soak.
   */
  async pauseBrew(): Promise<void> {
    if (this.phase !== "brewing" && this.phase !== "starting") {
      throw new BleGattError(
        "Pause requires an active brew (starting/brewing).",
        "not_brewing",
      );
    }
    await this.requireWrite(buildCoffeePause());
    this.phase = "paused";
    this.maybeSampleTelemetry();
    this.emit();
  }

  /** Resume a paused brew (40524; tea may also emit 40515 paused). */
  async resumeBrew(): Promise<void> {
    if (this.phase !== "paused") {
      throw new BleGattError(
        "Resume requires a paused brew session.",
        "not_paused",
      );
    }
    await this.requireWrite(buildCoffeeResume());
    this.phase = "brewing";
    this.maybeSampleTelemetry();
    this.watchTerminalAndRelease();
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // FreeSolo extras: scale / grinder / hot water (parity with core protocol)
  // ---------------------------------------------------------------------------

  async scaleEnter(): Promise<void> {
    await this.requireWrite(buildScaleEnter());
  }
  async scaleTare(): Promise<void> {
    await this.requireWrite(buildScaleTare());
  }
  async scaleExit(): Promise<void> {
    await this.requireWrite(buildScaleExit());
  }

  async grinderEnter(grind: number, rpm: number): Promise<void> {
    await this.requireWrite(buildGrinderEnter(grind, rpm));
  }
  async grinderStart(grind: number, rpm: number): Promise<void> {
    await this.requireWrite(buildGrinderStart(grind, rpm));
  }
  async grinderStop(): Promise<void> {
    await this.requireWrite(buildGrinderStop());
  }
  async grinderPause(): Promise<void> {
    await this.requireWrite(buildGrinderPause());
  }
  async grinderResume(): Promise<void> {
    await this.requireWrite(buildGrinderResume());
  }
  async grinderQuit(): Promise<void> {
    await this.requireWrite(buildGrinderQuit());
  }

  async waterEnter(tempC: number, pattern = "center"): Promise<void> {
    await this.requireWrite(buildBrewerEnter(tempC, pattern));
  }
  async waterStart(
    volumeMl: number,
    tempC: number,
    flowMlS = 3.5,
    pattern = "center",
    waterFeed: 0 | 1 = 0,
  ): Promise<void> {
    await this.requireWrite(
      buildBrewerStart(volumeMl, tempC, flowMlS, pattern, waterFeed),
    );
  }
  async waterStop(): Promise<void> {
    await this.requireWrite(buildBrewerStop());
  }
  async waterPause(): Promise<void> {
    await this.requireWrite(buildBrewerPause());
  }
  async waterResume(): Promise<void> {
    await this.requireWrite(buildBrewerResume());
  }
  async waterQuit(): Promise<void> {
    await this.requireWrite(buildBrewerQuit());
  }
  async waterSetPattern(pattern: string): Promise<void> {
    await this.requireWrite(buildBrewerSetPattern(pattern));
  }
  async waterSetTemperature(tempC: number): Promise<void> {
    await this.requireWrite(buildBrewerSetTemperature(tempC));
  }

  async readPourRadius(): Promise<void> {
    await this.requireWrite(buildReadPourRadius());
  }
  async writePourRadius(value: number): Promise<void> {
    await this.requireWrite(buildWritePourRadius(value));
  }
  async readVibrationAmplitude(): Promise<void> {
    await this.requireWrite(buildReadVibrationAmplitude());
  }
  async writeVibrationAmplitude(value: number): Promise<void> {
    await this.requireWrite(buildWriteVibrationAmplitude(value));
  }

  /**
   * Persist Studio display settings then refresh 40521 identity dump.
   * Matches core set_machine_settings + read_machine_info.
   */
  async writeMachineSettings(opts: {
    weightUnit?: WeightUnit;
    temperatureUnit?: TemperatureUnit;
    waterSource?: WaterSource;
    display?: DisplayLevel;
  }): Promise<MachineInfo> {
    const frames: Uint8Array[] = [];
    if (opts.weightUnit) frames.push(buildSetWeightUnit(opts.weightUnit));
    if (opts.temperatureUnit)
      frames.push(buildSetTemperatureUnit(opts.temperatureUnit));
    if (opts.waterSource) frames.push(buildSetWaterSource(opts.waterSource));
    if (opts.display) frames.push(buildSetDisplay(opts.display));
    if (!frames.length) {
      throw new BleGattError(
        "At least one machine setting is required.",
        "no_settings",
      );
    }
    for (const frame of frames) {
      await this.requireWrite(frame);
      await sleep(120);
    }
    // Force a fresh 40521 (clear cache so readback is live).
    this.machineInfo = null;
    return this.readMachineInfo(8_000);
  }

  /**
   * Request machine-info report 40521 (serial / firmware). Used for Easy-mode cloud read.
   *
   * Hardware needs app-style session handshake (a4) before status query reliably
   * emits 40521 — matching packages/core open_session + request_status.
   */
  async readMachineInfo(timeoutMs = 8_000): Promise<MachineInfo> {
    if (!this.handles) {
      throw new BleGattError("Not connected.", "not_connected");
    }
    if (
      this.machineInfo?.serialNumber &&
      this.machineInfo.serialNumber.length >= 4
    ) {
      cacheMachineSerial(this.machineInfo.serialNumber);
      return this.machineInfo;
    }
    const waitOnce = (ms: number) =>
      new Promise<MachineInfo | null>((resolve) => {
        if (
          this.machineInfo?.serialNumber &&
          this.machineInfo.serialNumber.length >= 4
        ) {
          resolve(this.machineInfo);
          return;
        }
        const timer = setTimeout(() => {
          this.machineInfoWaiters = this.machineInfoWaiters.filter(
            (w) => w !== onInfo,
          );
          resolve(this.machineInfo);
        }, ms);
        const onInfo = (info: MachineInfo | null) => {
          clearTimeout(timer);
          resolve(info);
        };
        this.machineInfoWaiters.push(onInfo);
      });

    const probe = async (ms: number): Promise<MachineInfo | null> => {
      const waiter = waitOnce(ms);
      try {
        // a4 then 0x56 — same order as Python load / open_session + request_status.
        await this.requireWrite(buildSessionStart());
        await sleep(350);
        await this.requireWrite(buildStatusQuery());
      } catch {
        /* waiter timeout handles failure */
      }
      return waiter;
    };

    // First probe with full handshake; second is status-only after session open.
    let info = await probe(Math.min(timeoutMs, 5_000));
    if (!info?.serialNumber) {
      await sleep(200);
      const waiter = waitOnce(timeoutMs);
      try {
        await this.requireWrite(buildStatusQuery());
        await sleep(150);
        await this.requireWrite(buildStatusQuery());
      } catch {
        /* ignore */
      }
      info = await waiter;
    }

    if (info?.serialNumber && info.serialNumber.length >= 4) {
      cacheMachineSerial(info.serialNumber);
      return info;
    }
    throw new BleGattError(
      "Machine did not return serial (40521). Keep Studio awake, close the official App, reconnect, then retry. Or enter SN manually below.",
      "no_machine_info",
    );
  }

  /**
   * Program Easy-Mode slots A/B/C (batch of three). Does not brew.
   * Missing B/C reuse recipe A. Requires coffee content without bypass.
   */
  async saveSlots(
    recipes: [
      CoffeeRecipeContent,
      CoffeeRecipeContent?,
      CoffeeRecipeContent?,
    ],
  ): Promise<void> {
    const frames = buildSlotBatch(recipes);
    for (const frame of frames) {
      await this.requireWrite(frame);
      await sleep(120);
    }
  }

  private watchTerminalAndRelease(): void {
    this.stopTerminalWatch();
    this.terminalWatch = setInterval(() => {
      if (this.phase === "terminal") {
        this.stopTerminalWatch();
        // Ensure history is flushed even if terminal came only via phase flag.
        this.flushBrewHistory(this.outcomeFromMachineState());
        void this.disconnect();
      }
    }, 250);
  }

  private stopTerminalWatch(): void {
    if (this.terminalWatch) {
      clearInterval(this.terminalWatch);
      this.terminalWatch = null;
    }
  }

  async writeCommit(): Promise<void> {
    await this.requireWrite(buildCommit());
  }

  async writeStart(): Promise<void> {
    await this.requireWrite(buildStart());
  }

  async writeCancel(): Promise<void> {
    await this.requireWrite(buildCancel());
  }

  private async requireWrite(frame: Uint8Array): Promise<void> {
    if (this.phase === "idle" || this.phase === "connecting") {
      throw new BleGattError("Not connected to a machine.", "not_connected");
    }
    await this.ensureLinked();
    if (!this.handles) {
      throw new BleGattError("Not connected to a machine.", "not_connected");
    }
    try {
      await writeCommand(this.handles, frame);
    } catch (err) {
      // One reconnect + retry for transient Windows disconnects mid-load.
      if (
        err instanceof BleGattError &&
        (err.code === "disconnected" || /disconnected/i.test(err.message))
      ) {
        await this.ensureLinked();
        if (!this.handles) throw err;
        await writeCommand(this.handles, frame);
        return;
      }
      throw err;
    }
  }

  private cleanupHandles(disconnect: boolean): void {
    if (this.stopNotify) {
      this.stopNotify();
      this.stopNotify = null;
    }
    if (disconnect) disconnectGatt(this.handles);
    this.handles = null;
  }
}

let sharedSession: WebBleSession | null = null;

export function getWebBleSession(): WebBleSession {
  if (!sharedSession) sharedSession = new WebBleSession();
  return sharedSession;
}

/** Test helper: reset singleton between unit tests. */
export function resetWebBleSessionForTests(): void {
  sharedSession = null;
}
