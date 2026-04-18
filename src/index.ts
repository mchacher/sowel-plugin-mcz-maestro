/**
 * Sowel Plugin: MCZ Maestro
 *
 * Integrates MCZ pellet stoves via the Maestro cloud (Socket.IO on app.mcz.it:9000).
 * Polls stove status, executes commands (power, temperature, profile, eco mode, reset alarm).
 */

import { io, type Socket } from "socket.io-client";

// ============================================================
// Local type definitions (no imports from Sowel source)
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  trace(obj: Record<string, unknown>, msg: string): void;
  trace(msg: string): void;
}

interface EventBus { emit(event: unknown): void; }
interface SettingsManager { get(key: string): string | undefined; set(key: string, value: string): void; }

interface DiscoveredDevice {
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  rawExpose?: Record<string, unknown>;
  data: { key: string; type: string; category: string; unit?: string }[];
  orders: { key: string; type: string; category?: string; dispatchConfig?: Record<string, unknown>; min?: number; max?: number; enumValues?: string[]; unit?: string }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(integrationId: string, sourceDeviceId: string, payload: Record<string, unknown>): void;
  migrateIntegrationId(oldIntegrationId: string, newIntegrationId: string, models?: string[]): number;
}

interface Device { id: string; integrationId: string; sourceDeviceId: string; name: string; }
interface PluginDeps { logger: Logger; eventBus: EventBus; settingsManager: SettingsManager; deviceManager: DeviceManager; pluginDir: string; }

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";
interface IntegrationSettingDef { key: string; label: string; type: "text" | "password" | "number" | "boolean"; required: boolean; placeholder?: string; defaultValue?: string; }

interface IntegrationPlugin {
  readonly id: string; readonly name: string; readonly description: string; readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus; isConfigured(): boolean; getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>; stop(): Promise<void>;
  executeOrder(device: Device, orderKeyOrDispatchConfig: string | Record<string, unknown>, value: unknown): Promise<void>;
  refresh?(): Promise<void>; getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

// ============================================================
// MCZ Protocol types & constants
// ============================================================

interface MczStatusFrame {
  stoveState: number;
  ambientTemperature: number;
  targetTemperature: number;
  profile: number;
  ecoMode: number;
  pelletSensor: number;
  ignitionCount: number;
  sparkPlug: number;
}

const REGISTER_INDEX = {
  STOVE_STATE: 1, AMBIENT_TEMPERATURE: 6, TARGET_TEMPERATURE: 26,
  PROFILE: 18, ECO_MODE: 23, PELLET_SENSOR: 47,
  IGNITION_COUNT: 45, SPARK_PLUG: 10,
} as const;

const COMMAND_ID = {
  POWER: 34, POWER_LEVEL: 36, FAN_AMBIENT: 37, REGULATION_MODE: 40,
  ECO_MODE: 41, TARGET_TEMPERATURE: 42, SILENCE_MODE: 45, PROFILE: 149, RESET_ALARM: 1,
} as const;

const ORDER_KEY_TO_COMMAND: Record<string, number> = {
  power: COMMAND_ID.POWER,
  targetTemperature: COMMAND_ID.TARGET_TEMPERATURE,
  profile: COMMAND_ID.PROFILE,
  ecoMode: COMMAND_ID.ECO_MODE,
  resetAlarm: COMMAND_ID.RESET_ALARM,
};

const POWER_ON_VALUE = 1;
const POWER_OFF_VALUE = 40;
const RESET_ALARM_VALUE = 255;
const FRAME_TYPE_INFO = "01";
const MCZ_CLOUD_URL = "http://app.mcz.it:9000";
const REQUEST_TIMEOUT_MS = 15_000;

const PROFILE_VALUES = ["manual", "dynamic", "overnight", "comfort"] as const;
const ORDER_PROFILE_VALUES = ["dynamic", "overnight", "comfort"];
const PELLET_SENSOR_VALUES = ["inactive", "sufficient", "almost_empty"];
const SPARK_PLUG_VALUES = ["ok", "worn"];

function stoveStateToString(raw: number): string {
  if (raw === 0) return "off";
  if (raw === 1) return "checking";
  if (raw >= 2 && raw <= 9) return `ignition_phase_${raw - 1}`;
  if (raw === 10) return "stabilizing";
  if (raw >= 11 && raw <= 15) return `running_p${raw - 10}`;
  if (raw === 30) return "diagnostic";
  if (raw === 31) return "running";
  if (raw === 40) return "extinguishing";
  if (raw === 41) return "cooling";
  if (raw === 42) return "cleaning_low";
  if (raw === 43) return "cleaning_high";
  if (raw === 44) return "unlocking_screw";
  if (raw === 45) return "auto_eco";
  if (raw === 46) return "standby";
  if (raw === 48) return "diagnostic_2";
  if (raw === 49) return "loading_auger";
  if (raw >= 50 && raw <= 69) return `error_A${String(raw - 49).padStart(2, "0")}`;
  return `unknown_${raw}`;
}

function isStoveActive(stoveState: string): boolean {
  const offStates = ["off", "diagnostic", "diagnostic_2", "unlocking_screw", "auto_eco", "standby", "loading_auger"];
  if (offStates.includes(stoveState)) return false;
  if (stoveState.startsWith("error_") || stoveState.startsWith("unknown_")) return false;
  return true;
}

function profileToString(raw: number): string { return PROFILE_VALUES[raw] ?? `unknown_${raw}`; }
function profileToRaw(profile: string): number { const idx = (PROFILE_VALUES as readonly string[]).indexOf(profile); return idx >= 0 ? idx : 0; }
function pelletSensorToString(raw: number): string { if (raw === 0) return "inactive"; if (raw === 10) return "sufficient"; if (raw === 11) return "almost_empty"; return `unknown_${raw}`; }
function sparkPlugToString(raw: number): string { return raw === 0 ? "ok" : "worn"; }

function parseInfoFrame(raw: string): number[] | null {
  const parts = raw.split("|");
  if (parts.length < 2 || parts[0] !== FRAME_TYPE_INFO) return null;
  return parts.map((hex) => parseInt(hex, 16));
}

function extractStatusFrame(registers: number[]): MczStatusFrame {
  return {
    stoveState: registers[REGISTER_INDEX.STOVE_STATE] ?? 0,
    ambientTemperature: (registers[REGISTER_INDEX.AMBIENT_TEMPERATURE] ?? 0) / 2,
    targetTemperature: (registers[REGISTER_INDEX.TARGET_TEMPERATURE] ?? 0) / 2,
    profile: registers[REGISTER_INDEX.PROFILE] ?? 0,
    ecoMode: registers[REGISTER_INDEX.ECO_MODE] ?? 0,
    pelletSensor: registers[REGISTER_INDEX.PELLET_SENSOR] ?? 0,
    ignitionCount: registers[REGISTER_INDEX.IGNITION_COUNT] ?? 0,
    sparkPlug: registers[REGISTER_INDEX.SPARK_PLUG] ?? 0,
  };
}

// ============================================================
// MCZ Bridge (Socket.IO client)
// ============================================================

class MczBridge {
  private socket: Socket | null = null;
  private logger: Logger;
  private serialNumber = "";
  private macAddress = "";
  private connected = false;
  private initialConnectDone = false;
  onReconnect: (() => void) | null = null;

  constructor(logger: Logger) { this.logger = logger; }

  async connect(serialNumber: string, macAddress: string): Promise<void> {
    this.serialNumber = serialNumber;
    this.macAddress = macAddress;
    this.initialConnectDone = false;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error("MCZ cloud connection timeout")); }, REQUEST_TIMEOUT_MS);

      this.socket = io(MCZ_CLOUD_URL, {
        reconnection: true, reconnectionDelay: 5_000, reconnectionDelayMax: 30_000, reconnectionAttempts: Infinity,
      });

      this.socket.on("connect", () => {
        if (!this.initialConnectDone) {
          this.logger.info({ socketId: this.socket?.id }, "Connected to MCZ cloud");
          this.emitJoin();
          this.connected = true;
          this.initialConnectDone = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      this.socket.on("connect_error", (err) => {
        this.logger.error({ err: err.message } as Record<string, unknown>, "MCZ connection error");
        this.connected = false;
        if (!this.initialConnectDone) { clearTimeout(timeout); reject(new Error(`MCZ connection failed: ${err.message}`)); }
      });

      this.socket.on("disconnect", (reason) => {
        this.logger.warn({ reason } as Record<string, unknown>, "Disconnected from MCZ cloud");
        this.connected = false;
      });

      this.socket.io.on("reconnect", () => {
        this.logger.info("Reconnected to MCZ cloud");
        this.emitJoin();
        this.connected = true;
        if (this.onReconnect) this.onReconnect();
      });

      this.socket.onAny((event: string, ...args: unknown[]) => {
        const preview = args.length > 0 && typeof args[0] === "string" ? args[0].substring(0, 120)
          : args.length > 0 ? JSON.stringify(args[0]).substring(0, 120) : "(no args)";
        this.logger.debug({ event, preview }, "MCZ event received");
      });
    });
  }

  disconnect(): void {
    if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); this.socket = null; }
    this.connected = false; this.onReconnect = null;
  }

  async getStatus(): Promise<MczStatusFrame> {
    if (!this.socket || !this.connected || !this.socket.connected) throw new Error("MCZ bridge not connected");

    return new Promise<MczStatusFrame>((resolve, reject) => {
      const timeout = setTimeout(() => { this.socket?.off("rispondo", handler); reject(new Error("MCZ getStatus timeout")); }, REQUEST_TIMEOUT_MS);

      const handler = (data: unknown) => {
        try {
          let raw: string;
          if (typeof data === "object" && data !== null && "stringaRicevuta" in data) {
            raw = (data as { stringaRicevuta: string }).stringaRicevuta;
          } else if (typeof data === "string") { raw = data; }
          else { return; }

          const registers = parseInfoFrame(raw);
          if (registers) { clearTimeout(timeout); this.socket?.off("rispondo", handler); resolve(extractStatusFrame(registers)); }
        } catch (err) { clearTimeout(timeout); this.socket?.off("rispondo", handler); reject(err); }
      };

      this.socket!.on("rispondo", handler);
      this.emitChiedo("C|RecuperoInfo", 1);
    });
  }

  async sendCommand(commandId: number, value: number): Promise<void> {
    if (!this.socket || !this.connected || !this.socket.connected) throw new Error("MCZ bridge not connected");
    const message = commandId === COMMAND_ID.RESET_ALARM
      ? `C|WriteParametri|${commandId}|${RESET_ALARM_VALUE}`
      : `C|WriteParametri|${commandId}|${value}`;
    this.emitChiedo(message, 1);
  }

  private emitJoin(): void {
    if (!this.socket) return;
    this.socket.emit("join", { serialNumber: this.serialNumber, macAddress: this.macAddress, type: "Android-App" });
    this.emitChiedo("RecuperoParametri", 0);
  }

  private emitChiedo(richiesta: string, tipoChiamata: number): void {
    if (!this.socket) return;
    this.socket.emit("chiedo", { serialNumber: this.serialNumber, macAddress: this.macAddress, tipoChiamata, richiesta });
  }
}

// ============================================================
// Plugin constants
// ============================================================

const INTEGRATION_ID = "mcz_maestro";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const ON_DEMAND_DELAY_MS = 5_000;

// ============================================================
// Plugin implementation
// ============================================================

class MczMaestroPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "MCZ Maestro";
  readonly description = "MCZ pellet stoves via Maestro cloud";
  readonly icon = "Flame";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private bridge: MczBridge | null = null;
  private status: IntegrationStatus = "disconnected";
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private lastPollAt: string | null = null;
  private polling = false;
  private pollFailed = false;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private serialNumber = "";
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private migrationDone = false;

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.pollFailed) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("serial_number") !== undefined && this.getSetting("mac_address") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      { key: "serial_number", label: "Serial number", type: "text", required: true, placeholder: "e.g. 1234567890" },
      { key: "mac_address", label: "MAC address", type: "text", required: true, placeholder: "e.g. AA:BB:CC:DD:EE:FF" },
      { key: "polling_interval", label: "Polling interval (seconds)", type: "number", required: false, defaultValue: "300", placeholder: "Min 60, default 300" },
    ];
  }

  async start(options?: { pollOffset?: number }): Promise<void> {
    this.stopPolling();
    if (this.bridge) { this.bridge.disconnect(); this.bridge = null; }
    if (!this.isConfigured()) { this.status = "not_configured"; return; }

    if (!this.migrationDone) { this.migrateFromLegacy(); this.migrationDone = true; }

    this.serialNumber = this.getSetting("serial_number")!;
    const macAddress = this.getSetting("mac_address")!;
    const pollingIntervalSec = parseInt(this.getSetting("polling_interval") ?? "300", 10);
    this.pollIntervalMs = (isNaN(pollingIntervalSec) ? 300 : Math.max(pollingIntervalSec, 60)) * 1000;

    try {
      this.bridge = new MczBridge(this.logger);
      await this.bridge.connect(this.serialNumber, macAddress);

      this.bridge.onReconnect = () => {
        this.logger.info("MCZ reconnected, scheduling recovery poll");
        this.scheduleOnDemandPoll(2_000);
      };

      await this.poll();

      const offset = options?.pollOffset ?? 0;
      const startInterval = () => { this.pollInterval = setInterval(() => this.safePoll(), this.pollIntervalMs); };
      if (offset > 0) { setTimeout(startInterval, offset); } else { startInterval(); }

      this.status = "connected";
      this.retryCount = 0;
      this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      this.logger.info({ pollIntervalMs: this.pollIntervalMs }, "MCZ Maestro started");
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start MCZ Maestro");
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.cancelRetry();
    this.stopPolling();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    if (this.bridge) { this.bridge.disconnect(); this.bridge = null; }
    this.status = "disconnected";
    this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
    this.logger.info("MCZ Maestro stopped");
  }

  async executeOrder(_device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.bridge || this.status !== "connected") throw new Error("MCZ Maestro not connected");

    const commandId = ORDER_KEY_TO_COMMAND[orderKey];
    if (commandId === undefined) throw new Error(`Unknown order key: ${orderKey}`);

    let rawValue: number;
    switch (commandId) {
      case COMMAND_ID.POWER: rawValue = value === true ? POWER_ON_VALUE : POWER_OFF_VALUE; break;
      case COMMAND_ID.TARGET_TEMPERATURE: rawValue = Math.round((value as number) * 2); break;
      case COMMAND_ID.PROFILE: rawValue = profileToRaw(value as string); break;
      case COMMAND_ID.ECO_MODE: rawValue = value === true ? 1 : 0; break;
      case COMMAND_ID.RESET_ALARM: rawValue = RESET_ALARM_VALUE; break;
      default: rawValue = value as number;
    }

    await this.bridge.sendCommand(commandId, rawValue);
    this.logger.info({ orderKey, commandId, value, rawValue }, "MCZ order executed");
    this.scheduleOnDemandPoll();
  }

  async refresh(): Promise<void> {
    if (!this.bridge || this.status !== "connected") throw new Error("Not connected");
    await this.poll();
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (!this.lastPollAt) return null;
    return { lastPollAt: this.lastPollAt, intervalMs: this.pollIntervalMs };
  }

  // ============================================================
  // Polling
  // ============================================================

  private async poll(): Promise<void> {
    if (this.polling || !this.bridge) return;
    this.polling = true;
    try {
      this.lastPollAt = new Date().toISOString();
      const frame = await this.bridge.getStatus();

      this.deviceManager.upsertFromDiscovery(INTEGRATION_ID, INTEGRATION_ID, mapFrameToDiscovered(this.serialNumber, frame));

      const stoveState = stoveStateToString(frame.stoveState);
      this.deviceManager.updateDeviceData(INTEGRATION_ID, this.serialNumber, {
        power: isStoveActive(stoveState),
        stoveState,
        insideTemperature: frame.ambientTemperature,
        targetTemperature: frame.targetTemperature,
        profile: profileToString(frame.profile),
        ecoMode: frame.ecoMode === 1,
        pelletSensor: pelletSensorToString(frame.pelletSensor),
        ignitionCount: frame.ignitionCount,
        sparkPlug: sparkPlugToString(frame.sparkPlug),
      });

      if (this.pollFailed) {
        this.pollFailed = false;
        this.eventBus.emit({ type: "system.alarm.resolved", alarmId: `poll-fail:${INTEGRATION_ID}`, source: "MCZ Maestro", message: "Communication rétablie" });
      }
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "MCZ poll failed");
      if (!this.pollFailed) {
        this.pollFailed = true;
        this.eventBus.emit({ type: "system.alarm.raised", alarmId: `poll-fail:${INTEGRATION_ID}`, level: "error", source: "MCZ Maestro", message: `Poll en échec : ${err instanceof Error ? err.message : String(err)}` });
      }
    } finally { this.polling = false; }
  }

  private safePoll(): void { this.poll().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Poll failed")); }

  private scheduleOnDemandPoll(delayMs?: number): void {
    const delay = delayMs ?? ON_DEMAND_DELAY_MS;
    const timer = setTimeout(() => { this.pendingTimers.delete(timer); this.safePoll(); }, delay);
    this.pendingTimers.add(timer);
  }

  // ============================================================
  // Migration + retry + helpers
  // ============================================================

  private migrateFromLegacy(): void {
    try {
      const migrated = this.deviceManager.migrateIntegrationId(INTEGRATION_ID, INTEGRATION_ID, ["Maestro"]);
      if (migrated > 0) this.logger.info({ migrated }, "Migrated MCZ devices");
    } catch (err) { this.logger.warn({ err } as Record<string, unknown>, "Migration failed (non-fatal)"); }
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    this.retryCount++;
    const delaySec = Math.min(30 * Math.pow(2, this.retryCount - 1), 600);
    this.logger.warn({ retryCount: this.retryCount, delaySec }, "Scheduling retry");
    this.retryTimeout = setTimeout(() => { this.retryTimeout = null; this.start().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Retry failed")); }, delaySec * 1000);
  }

  private cancelRetry(): void { if (this.retryTimeout) { clearTimeout(this.retryTimeout); this.retryTimeout = null; } }
  private stopPolling(): void { if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; } }
  private getSetting(key: string): string | undefined { return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`); }
}

// ============================================================
// Device mapping
// ============================================================

function mapFrameToDiscovered(serial: string, _frame: MczStatusFrame): DiscoveredDevice {
  return {
    friendlyName: serial,
    manufacturer: "MCZ",
    model: "Maestro",
    data: [
      { key: "power", type: "boolean", category: "power" },
      { key: "stoveState", type: "enum", category: "generic" },
      { key: "insideTemperature", type: "number", category: "temperature", unit: "°C" },
      { key: "targetTemperature", type: "number", category: "setpoint", unit: "°C" },
      { key: "profile", type: "enum", category: "generic" },
      { key: "ecoMode", type: "boolean", category: "generic" },
      { key: "pelletSensor", type: "enum", category: "generic" },
      { key: "ignitionCount", type: "number", category: "generic" },
      { key: "sparkPlug", type: "enum", category: "generic" },
    ],
    orders: [
      { key: "power", type: "boolean", category: "toggle_power" },
      { key: "targetTemperature", type: "number", category: "set_setpoint", min: 5, max: 40, unit: "°C" },
      { key: "profile", type: "enum", enumValues: [...ORDER_PROFILE_VALUES] },
      { key: "ecoMode", type: "boolean" },
      { key: "resetAlarm", type: "boolean" },
    ],
    rawExpose: {
      stoveStates: ["off", "checking", "stabilizing", "running", "running_p1", "running_p2", "running_p3", "running_p4", "running_p5", "diagnostic", "extinguishing", "cooling", "standby", "auto_eco"],
      pelletSensorValues: [...PELLET_SENSOR_VALUES],
      sparkPlugValues: [...SPARK_PLUG_VALUES],
    },
  };
}

// ============================================================
// Plugin entry point
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new MczMaestroPlugin(deps);
}
