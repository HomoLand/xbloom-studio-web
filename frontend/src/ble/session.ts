/**
 * Web Bluetooth machine session (W0–W3).
 * Page lifetime = session lifetime (tab-close recovery out of scope).
 *
 * Also records local brew journal + telemetry samples, and exposes FreeSolo
 * scale / grinder / hot-water control builders (same frames as core protocol).
 */

import type { CoffeeRecipeContent } from "../api";
import {
  appendLocalHistory,
  type TelemetrySample,
} from "../lib/localHistory.ts";
import { coffeeContentToProtocol } from "./coffeeRecipe.ts";
import {
  buildBrewerEnter,
  buildBrewerQuit,
  buildBrewerStart,
  buildBrewerStop,
  buildGrinderEnter,
  buildGrinderQuit,
  buildGrinderStart,
  buildGrinderStop,
  buildScaleEnter,
  buildScaleExit,
  buildScaleTare,
} from "./extras.ts";
import { buildCancel, buildCommit, buildStart } from "./framing.ts";
import {
  connectGatt,
  disconnectGatt,
  isGattConnected,
  requestStudioDevice,
  startStatusNotifications,
  writeCommand,
  type GattHandles,
  BleGattError,
} from "./gatt.ts";
import { buildLoadFrames, buildStatusQuery } from "./load.ts";
import {
  isActedBrewState,
  isArmedState,
  isBrewTerminalState,
  NotificationFrameStream,
  parseNotification,
  type StatusEvent,
} from "./telemetry.ts";

/** Throttle telemetry samples to keep localStorage small. */
const TELEMETRY_SAMPLE_MIN_MS = 400;
const TELEMETRY_MAX_SAMPLES = 600;

export type BrewJournalMeta = {
  recipe_name?: string;
  recipe_revision_id?: string;
  workflow_id?: string;
  kind?: string;
};

export type SessionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "loading"
  | "armed"
  | "starting"
  | "brewing"
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
    phase === "brewing";
  if (!activeBrewPhase) return false;
  if (isBrewTerminalState(machineState)) return true;
  // Return to idle after brew/cancel.
  return machineState === 0x01;
}

export type SessionSnapshot = {
  phase: SessionPhase;
  deviceId: string | null;
  deviceName: string | null;
  lastError: string | null;
  notifyCount: number;
  /** Latest decoded machine phase label (e.g. armed, brewing). */
  machineStateName: string | null;
  machineState: number | null;
  cupWeightG: number | null;
  dispensedWaterMl: number | null;
  loaded: boolean;
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
  private cupWeightG: number | null = null;
  private dispensedWaterMl: number | null = null;
  private loaded = false;
  /** True while connect() is still wiring services/notify — ignore spur ious disconnects. */
  private setupInProgress = false;
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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): SessionSnapshot {
    return {
      phase: this.phase,
      deviceId: this.handles?.device.id ?? null,
      deviceName: this.handles?.device.name ?? null,
      lastError: this.lastError,
      notifyCount: this.notifyCount,
      machineStateName: this.machineStateName,
      machineState: this.machineState,
      cupWeightG: this.cupWeightG,
      dispensedWaterMl: this.dispensedWaterMl,
      loaded: this.loaded,
    };
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
  }

  private maybeSampleTelemetry(): void {
    const active =
      this.phase === "loading" ||
      this.phase === "armed" ||
      this.phase === "starting" ||
      this.phase === "brewing" ||
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
    try {
      appendLocalHistory({
        outcome,
        source: "web-bluetooth",
        recipe_name: this.brewMeta?.recipe_name,
        recipe_revision_id: this.brewMeta?.recipe_revision_id,
        workflow_id: this.brewMeta?.workflow_id,
        kind: this.brewMeta?.kind ?? "coffee",
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
    if (ev.state != null) {
      this.machineState = ev.state;
      this.machineStateName = ev.stateName;
      if (isArmedState(ev.state)) {
        this.loaded = true;
        if (this.phase === "loading" || this.phase === "connected") {
          this.phase = "armed";
        }
      }
      if (isActedBrewState(ev.state) && (this.phase === "starting" || this.phase === "armed")) {
        this.phase = "brewing";
      }
      if (shouldEnterTerminalPhase(this.phase, ev.state)) {
        this.phase = "terminal";
        this.maybeSampleTelemetry();
        this.flushBrewHistory(this.outcomeFromMachineState());
      }
    }
    if (ev.cupWeightG != null) this.cupWeightG = ev.cupWeightG;
    if (ev.dispensedWaterMl != null) this.dispensedWaterMl = ev.dispensedWaterMl;
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
   * Chrome requires ``requestDevice()`` to run in the same user-gesture turn
   * (or as the *first* await from the click). Any prior ``await sleep(...)``
   * drops the gesture → chooser never appears → phase stuck on ``connecting``.
   * That was the Settings-page hang (Dashboard felt fine after a cached device).
   */
  async connect(opts: { forcePicker?: boolean } = {}): Promise<void> {
    this.stopTerminalWatch();

    // 1) Resolve device BEFORE any other await so the click gesture is still valid.
    let device = this.device;
    if (!device || opts.forcePicker) {
      device = await requestStudioDevice();
      this.device = device;
    }

    // 2) Now safe to do async teardown / GATT work.
    this.setupInProgress = true;
    this.setPhase("connecting");
    if (this.stopNotify) {
      this.stopNotify();
      this.stopNotify = null;
    }
    disconnectGatt(this.handles);
    this.handles = null;

    try {
      // Brief settle only after device is already chosen.
      await sleep(80);
      this.bindDisconnectListener(device);
      this.handles = await connectGatt(device);
      this.notifyCount = 0;
      this.stream.reset();
      this.machineState = null;
      this.machineStateName = null;
      this.cupWeightG = null;
      this.dispensedWaterMl = null;
      this.loaded = false;
      this.stopNotify = await startStatusNotifications(this.handles, (dv) =>
        this.onNotifyChunk(dv),
      );
      await sleep(100);
      if (!isGattConnected(this.handles)) {
        this.handles = await connectGatt(device);
        this.stopNotify = await startStatusNotifications(this.handles, (dv) =>
          this.onNotifyChunk(dv),
        );
        await sleep(100);
      }
      await writeCommand(this.handles, buildStatusQuery());
      this.setupInProgress = false;
      this.setPhase("connected");
    } catch (err) {
      this.setupInProgress = false;
      this.cleanupHandles(true);
      const message =
        err instanceof BleGattError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Dead permission / gone device → clear cache so next click opens picker first.
      if (
        /not found|no longer|permission|failed|disconnected|timeout/i.test(
          message,
        )
      ) {
        this.unbindDisconnectListener();
        this.device = null;
      }
      this.setPhase("error", message);
      throw err;
    }
  }

  /** Cancel a stuck ``connecting`` phase (e.g. chooser dismissed / hang). */
  abortConnect(): void {
    this.setupInProgress = false;
    this.cleanupHandles(true);
    this.setPhase("idle");
  }

  /** Soft disconnect: drop GATT, keep paired device for one-tap reconnect. */
  async disconnect(): Promise<void> {
    this.stopTerminalWatch();
    this.setupInProgress = false;
    this.cleanupHandles(true);
    this.loaded = false;
    // Intentionally keep this.device + disconnect listener owner for reconnect.
    this.setPhase("idle");
  }

  /** Forget paired device (next Connect shows the picker again). */
  async forgetDevice(): Promise<void> {
    await this.disconnect();
    this.unbindDisconnectListener();
    this.device = null;
  }

  /**
   * Ensure a live GATT link before a write. Reuses the last paired device
   * (no second picker) when Chrome still remembers the permission.
   */
  private async ensureLinked(): Promise<void> {
    if (isGattConnected(this.handles)) return;
    if (!this.device) {
      throw new BleGattError(
        "Not connected. Tap Connect Studio first (user gesture required).",
        "not_connected",
      );
    }
    this.setupInProgress = true;
    try {
      if (this.stopNotify) {
        this.stopNotify();
        this.stopNotify = null;
      }
      this.handles = await connectGatt(this.device);
      this.stopNotify = await startStatusNotifications(this.handles, (dv) =>
        this.onNotifyChunk(dv),
      );
      await sleep(80);
      if (
        this.phase === "idle" ||
        this.phase === "disconnected" ||
        this.phase === "error"
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
    if (opts.journal) {
      this.beginBrewJournal({
        ...opts.journal,
        recipe_name: opts.journal.recipe_name ?? content.name,
        kind: opts.journal.kind ?? content.kind,
      });
    } else if (!this.brewMeta) {
      this.beginBrewJournal({
        recipe_name: content.name,
        kind: content.kind,
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
   * Start armed brew: commit, observe, optional 40518 if still awaiting_confirm.
   * Requires caller already verified ready phrase at UI layer.
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
  async waterQuit(): Promise<void> {
    await this.requireWrite(buildBrewerQuit());
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
    if (
      this.phase === "idle" ||
      this.phase === "connecting"
    ) {
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
