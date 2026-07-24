/**
 * Human-readable labels for BLE session phase, machine state, and FreeSolo
 * activity names. Technical codes stay in telemetry/session; UI never shows
 * raw hex like "状态 45" to ordinary users.
 */

export type TranslateFn = (key: string, fallback?: string) => string;

/** Session-layer phases (WebBleSession.phase). */
const PHASE_KEYS: Record<string, string> = {
  idle: "phase.idle",
  connecting: "phase.connecting",
  connected: "phase.connected",
  loading: "phase.loading",
  armed: "phase.armed",
  starting: "phase.starting",
  brewing: "phase.brewing",
  paused: "phase.paused",
  terminal: "phase.terminal",
  error: "phase.error",
  disconnected: "phase.disconnected",
};

/**
 * Wire status byte → canonical state key (same as telemetry STATE_NAMES).
 * Used when older paths still emit status_0xNN / unknown_0xNN.
 */
const STATE_BYTE_KEYS: Record<number, string> = {
  0x01: "idle",
  0x0c: "no_water",
  0x0f: "no_beans",
  0x10: "brewing",
  0x1d: "loading",
  0x1e: "awaiting_confirm",
  0x1f: "armed",
  0x22: "starting",
  0x23: "brewing",
  0x24: "ready",
  0x25: "slots_saved",
  0x3b: "brewing",
  0x41: "complete",
  0x43: "saving_slots",
  /** Tea inter-steep soak — never show as "状态 45". */
  0x45: "tea_soaking",
};

/** Machine status state names (telemetry STATE_NAMES + aliases). */
const STATE_KEYS: Record<string, string> = {
  idle: "status.idle",
  no_water: "status.no_water",
  no_beans: "status.no_beans",
  brewing: "status.brewing",
  loading: "status.loading",
  armed: "status.armed",
  awaiting_confirm: "status.awaiting_confirm",
  starting: "status.starting",
  ready: "status.ready",
  tea_soaking: "status.tea_soaking",
  complete: "status.complete",
  saving_slots: "status.saving_slots",
  slots_saved: "status.slots_saved",
  heartbeat: "status.heartbeat",
  scale: "status.scale",
  cup_weight: "status.cup_weight",
  scale_weight: "status.scale_weight",
  water_volume: "status.water_volume",
};

/** FreeSolo / report activity names (telemetry REPORT_NAMES). */
const ACTIVITY_KEYS: Record<string, string> = {
  machine_sleeping: "activity.machine_sleeping",
  machine_awake: "activity.machine_awake",
  settings_changed: "activity.settings_changed",
  machine_activity: "activity.machine_activity",
  grinder_size: "activity.grinder_size",
  grinder_speed: "activity.grinder_speed",
  brewer_pattern: "activity.brewer_pattern",
  brewer_temperature: "activity.brewer_temperature",
  easy_mode_begin: "activity.easy_mode_begin",
  tea_soak_time_changed: "activity.tea_soak_time_changed",
  abnormal_gear_position: "activity.abnormal_gear_position",
  abnormal_dose_or_water: "activity.abnormal_dose_or_water",
  grinder_state: "activity.grinder_state",
  brewer_state: "activity.brewer_state",
  machine_state: "activity.machine_state",
  grinder_started: "activity.grinder_started",
  grinder_exited: "activity.grinder_exited",
  brewer_started: "activity.brewer_started",
  brewer_exited: "activity.brewer_exited",
  grinder_paused: "activity.grinder_paused",
  brewer_paused: "activity.brewer_paused",
  tea_restarted: "activity.tea_restarted",
  tea_soaking: "activity.tea_soaking",
  scale_weight: "activity.scale_weight",
  cup_weight: "activity.cup_weight",
  xpod_detected: "activity.xpod_detected",
  coffee_brewer_started: "activity.coffee_brewer_started",
  gear_position: "activity.gear_position",
  grinder_stopped: "activity.grinder_stopped",
  pour_stage: "activity.pour_stage",
  brewer_stopped: "activity.brewer_stopped",
  brew_ready: "activity.brew_ready",
  brew_ready_alt: "activity.brew_ready",
  tea_paused: "activity.tea_paused",
  idle_grinding_error: "activity.idle_grinding_error",
  bypass_started: "activity.bypass_started",
  no_water_report: "activity.no_water_report",
  water_volume: "activity.water_volume",
  current_grinder: "activity.current_grinder",
  vibration_before_pour: "activity.vibration_before_pour",
  pour_radius: "activity.pour_radius",
  pour_radius_written: "activity.pour_radius_written",
  vibration_amplitude: "activity.vibration_amplitude",
  vibration_amplitude_written: "activity.vibration_amplitude_written",
  easy_mode_state: "activity.easy_mode_state",
  machine_info: "activity.machine_info",
};

function lookup(
  t: TranslateFn,
  table: Record<string, string>,
  raw: string,
): string | null {
  const key = table[raw];
  if (!key) return null;
  const labeled = t(key);
  // If missing translation, messages fall back to the key itself — treat as miss.
  if (!labeled || labeled === key) return null;
  return labeled;
}

/** Session phase for ordinary users (连接中 / 冲煮中 …). */
export function labelPhase(
  t: TranslateFn,
  phase: string | null | undefined,
): string {
  if (!phase) return t("status.unknown", "—");
  return lookup(t, PHASE_KEYS, phase) ?? phase;
}

/**
 * Machine status or activity string for ordinary users.
 * Known wire bytes (e.g. 0x45) resolve to plain language — never "状态 45".
 */
export function labelMachineName(
  t: TranslateFn,
  raw: string | null | undefined,
): string {
  if (!raw) return t("status.unknown", "—");

  // status_0x45 / unknown_0x45 / bare 0x45 → tea_soaking → 浸泡中
  const hexMatch = /^(?:status_|unknown_)?0x([0-9a-f]+)$/i.exec(raw);
  if (hexMatch) {
    const byte = Number.parseInt(hexMatch[1]!, 16);
    if (Number.isFinite(byte)) {
      const canonical = STATE_BYTE_KEYS[byte];
      if (canonical) {
        const named = lookup(t, STATE_KEYS, canonical);
        if (named) return named;
      }
      // Truly unknown byte: still no hex for ordinary users.
      return t("status.busy", "运行中");
    }
  }

  const fromState = lookup(t, STATE_KEYS, raw);
  if (fromState) return fromState;
  const fromActivity = lookup(t, ACTIVITY_KEYS, raw);
  if (fromActivity) return fromActivity;

  if (/^ack_0x/i.test(raw)) {
    return t("activity.ack_generic", "指令已确认");
  }
  // Last resort: still avoid dumping technical ids.
  if (/[_0-9]/.test(raw) && !lookup(t, STATE_KEYS, raw)) {
    return t("status.busy", "运行中");
  }
  return raw;
}

/** Prefer human machine state; fall back to phase. */
export function labelMachineOrPhase(
  t: TranslateFn,
  machineStateName: string | null | undefined,
  phase: string | null | undefined,
): string {
  if (
    machineStateName &&
    !machineStateName.startsWith("status_0x") &&
    !machineStateName.startsWith("unknown")
  ) {
    return labelMachineName(t, machineStateName);
  }
  if (machineStateName) {
    return labelMachineName(t, machineStateName);
  }
  return labelPhase(t, phase);
}
