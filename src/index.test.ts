import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPlugin, isStartup, parseStartupMode, startupCommands } from "./index.js";

// Raw register values, as the stove sends them.
const STATE = {
  off: 0,
  checking: 1,
  ignition2: 3,
  runningP3: 13,
  runningP4: 14,
  autoEco: 45,
  errorA02: 51,
} as const;
const PROFILE = { manual: 0, dynamic: 1, comfort: 3 } as const;
const COMMAND = { profile: 149, ecoMode: 41 } as const;

type Frame = { stoveState: number; profile: number; ecoMode: number };

// The MCZ cloud, faked at the Socket.IO level: each status request answers
// with the next queued frame, and every command written is recorded.
const cloud = vi.hoisted(() => ({
  frames: [] as { stoveState: number; profile: number; ecoMode: number }[],
  written: [] as [number, number][],
}));

vi.mock("socket.io-client", () => ({
  io: () => {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const infoFrame = (f: { stoveState: number; profile: number; ecoMode: number }) => {
      const registers = new Array<number>(50).fill(0);
      registers[1] = f.stoveState;
      registers[6] = 40; // 20 °C
      registers[26] = 40;
      registers[18] = f.profile;
      registers[23] = f.ecoMode;
      return ["01", ...registers.slice(1).map((r) => r.toString(16))].join("|");
    };
    const socket = {
      id: "fake",
      connected: true,
      io: { on: () => {} },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        if (event === "connect") queueMicrotask(() => handler());
        return socket;
      },
      off(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
        return socket;
      },
      onAny: () => {},
      removeAllListeners: () => {},
      disconnect: () => {},
      emit(event: string, payload: { richiesta: string }) {
        if (event !== "chiedo") return;
        if (payload.richiesta === "C|RecuperoInfo") {
          const frame = cloud.frames.shift();
          if (!frame) return; // no answer: the poll times out
          queueMicrotask(() => {
            for (const h of handlers.get("rispondo") ?? []) h({ stringaRicevuta: infoFrame(frame) });
          });
        } else if (payload.richiesta.startsWith("C|WriteParametri|")) {
          const [, , commandId, value] = payload.richiesta.split("|");
          cloud.written.push([Number(commandId), Number(value)]);
        }
      },
    };
    return socket;
  },
}));

describe("isStartup", () => {
  it("is never a start on the first poll, the stove may have run for hours", () => {
    expect(isStartup(null, "running_p4")).toBe(false);
    expect(isStartup(null, "ignition_phase_2")).toBe(false);
  });

  it("sees a start from off or from an alarm, whichever step it reached", () => {
    expect(isStartup("error_A02", "ignition_phase_2")).toBe(true);
    expect(isStartup("off", "checking")).toBe(true);
    expect(isStartup("off", "running_p3")).toBe(true);
  });

  it("does not take a relight after a pause in eco or standby for a start", () => {
    expect(isStartup("auto_eco", "checking")).toBe(false);
    expect(isStartup("auto_eco", "running_p1")).toBe(false);
    expect(isStartup("standby", "ignition_phase_1")).toBe(false);
  });

  it("is not a start while the stove goes on lighting, running or stopping", () => {
    expect(isStartup("checking", "ignition_phase_1")).toBe(false);
    expect(isStartup("running_p4", "running_p5")).toBe(false);
    expect(isStartup("running_p4", "extinguishing")).toBe(false);
    expect(isStartup("cooling", "checking")).toBe(false);
    expect(isStartup("off", "off")).toBe(false);
    expect(isStartup("error_A02", "off")).toBe(false);
  });

  it("does not take an unmapped state in the middle of a run for a stop", () => {
    expect(isStartup("unknown_47", "running_p4")).toBe(false);
  });
});

describe("parseStartupMode", () => {
  it("reads a profile and an eco mode", () => {
    expect(parseStartupMode("comfort", "on")).toEqual({ mode: { profile: "comfort", ecoMode: true }, invalid: [] });
    expect(parseStartupMode(" Dynamic ", "OFF")).toEqual({ mode: { profile: "dynamic", ecoMode: false }, invalid: [] });
  });

  it("leaves out what is not set", () => {
    expect(parseStartupMode(undefined, undefined)).toEqual({ mode: {}, invalid: [] });
    expect(parseStartupMode("", "on")).toEqual({ mode: { ecoMode: true }, invalid: [] });
  });

  it("reports and leaves out an unknown value, manual included (no order for it)", () => {
    expect(parseStartupMode("manual", "yes")).toEqual({
      mode: {},
      invalid: ["startup_profile=manual", "startup_eco_mode=yes"],
    });
  });
});

describe("startupCommands", () => {
  const mode = { profile: "comfort", ecoMode: true } as const;

  it("sends both after an alarm reset, which leaves the stove in manual with eco off", () => {
    expect(startupCommands({ profile: PROFILE.manual, ecoMode: 0 }, mode)).toEqual([
      { orderKey: "profile", commandId: COMMAND.profile, rawValue: PROFILE.comfort },
      { orderKey: "ecoMode", commandId: COMMAND.ecoMode, rawValue: 1 },
    ]);
  });

  it("sends nothing when the stove is already in the mode", () => {
    expect(startupCommands({ profile: PROFILE.comfort, ecoMode: 1 }, mode)).toEqual([]);
  });

  it("only touches what the mode sets", () => {
    expect(startupCommands({ profile: PROFILE.manual, ecoMode: 0 }, { ecoMode: true })).toEqual([
      { orderKey: "ecoMode", commandId: COMMAND.ecoMode, rawValue: 1 },
    ]);
  });
});

describe("the plugin at each start", () => {
  let logged: { level: string; msg: string }[];

  /** A started plugin: its first poll has read the first frame queued. */
  async function started(settings: Record<string, string>, ...frames: Frame[]) {
    cloud.frames.push(...frames);
    const log = (level: string) => (a: unknown, b?: string) =>
      logged.push({ level, msg: typeof a === "string" ? a : (b ?? "") });
    const logger = {
      child: () => logger,
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      debug: log("debug"),
      trace: log("trace"),
    };
    const plugin = createPlugin({
      logger,
      eventBus: { emit: () => {} },
      settingsManager: { get: (key) => settings[key.replace("integration.mcz_maestro.", "")], set: () => {} },
      deviceManager: { upsertFromDiscovery: () => {}, updateDeviceData: () => {}, migrateIntegrationId: () => 0 },
      pluginDir: "",
    });
    await plugin.start();
    expect(plugin.getStatus()).toBe("connected");
    return plugin;
  }

  const warnings = () => logged.filter((l) => l.level === "warn").map((l) => l.msg);

  beforeEach(() => {
    vi.useFakeTimers();
    cloud.frames.length = 0;
    cloud.written.length = 0;
    logged = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const comfortEco = { serial_number: "s", mac_address: "m", startup_profile: "comfort", startup_eco_mode: "on" };

  it("puts the stove back in comfort with eco on after an alarm reset, then leaves it", async () => {
    const plugin = await started(
      comfortEco,
      { stoveState: STATE.errorA02, profile: PROFILE.comfort, ecoMode: 1 },
      { stoveState: STATE.ignition2, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.ignition2, profile: PROFILE.comfort, ecoMode: 1 },
      // Switched to dynamic by hand while it runs: not a start, left alone.
      { stoveState: STATE.runningP4, profile: PROFILE.dynamic, ecoMode: 1 },
    );
    expect(cloud.written).toEqual([]);

    await plugin.refresh!();
    expect(cloud.written).toEqual([
      [COMMAND.profile, PROFILE.comfort],
      [COMMAND.ecoMode, 1],
    ]);
    await plugin.refresh!();
    await plugin.refresh!();

    expect(cloud.written).toHaveLength(2);
    expect(logged.map((l) => l.msg)).toContain("MCZ start-up mode in place");
    await plugin.stop();
  });

  it("keeps a profile chosen by hand through a pause in eco", async () => {
    const plugin = await started(
      comfortEco,
      { stoveState: STATE.runningP4, profile: PROFILE.dynamic, ecoMode: 1 },
      { stoveState: STATE.autoEco, profile: PROFILE.dynamic, ecoMode: 1 },
      { stoveState: STATE.ignition2, profile: PROFILE.dynamic, ecoMode: 1 },
    );

    await plugin.refresh!();
    await plugin.refresh!();

    expect(cloud.written).toEqual([]);
    await plugin.stop();
  });

  it("does nothing on the first poll after Sowel starts, even in manual", async () => {
    const plugin = await started(comfortEco, { stoveState: STATE.runningP4, profile: PROFILE.manual, ecoMode: 0 });

    expect(cloud.written).toEqual([]);
    await plugin.stop();
  });

  it("does nothing without the settings, as before", async () => {
    const plugin = await started(
      { serial_number: "s", mac_address: "m" },
      { stoveState: STATE.errorA02, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.ignition2, profile: PROFILE.manual, ecoMode: 0 },
    );

    await plugin.refresh!();

    expect(cloud.written).toEqual([]);
    await plugin.stop();
  });

  it("tries three times when the stove does not take it, then gives up until the next start", async () => {
    const plugin = await started(comfortEco, { stoveState: STATE.off, profile: PROFILE.manual, ecoMode: 0 });
    for (let i = 0; i < 5; i++) cloud.frames.push({ stoveState: STATE.ignition2, profile: PROFILE.manual, ecoMode: 0 });

    for (let i = 0; i < 5; i++) await plugin.refresh!();

    expect(cloud.written).toHaveLength(6); // three attempts, two orders each
    expect(warnings()).toEqual(["MCZ start-up mode not taken by the stove, giving up until the next start"]);
    await plugin.stop();
  });

  it("leaves the stove alone once the start is past, when a check was missed", async () => {
    // The check after the first send fails (a cloud blip), the user picks a
    // profile meanwhile: the regular poll, minutes later, must not undo it.
    const plugin = await started(
      comfortEco,
      { stoveState: STATE.off, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.ignition2, profile: PROFILE.manual, ecoMode: 0 },
    );
    await plugin.refresh!();
    expect(cloud.written).toHaveLength(2);

    vi.setSystemTime(Date.now() + 300_000);
    cloud.frames.push({ stoveState: STATE.runningP3, profile: PROFILE.dynamic, ecoMode: 1 });
    await plugin.refresh!();

    expect(cloud.written).toHaveLength(2);
    expect(warnings()).toEqual(["MCZ start-up mode not confirmed in time, left as it is until the next start"]);
    await plugin.stop();
  });

  it("drops a pending start when the stove stops again", async () => {
    const plugin = await started(
      comfortEco,
      { stoveState: STATE.off, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.ignition2, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.errorA02, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.errorA02, profile: PROFILE.manual, ecoMode: 0 },
    );

    for (let i = 0; i < 3; i++) await plugin.refresh!();

    expect(cloud.written).toHaveLength(2); // the one attempt made while it was lighting
    await plugin.stop();
  });

  it("reads the start-up settings again when it restarts", async () => {
    const settings: Record<string, string> = { serial_number: "s", mac_address: "m" };
    const plugin = await started(settings, { stoveState: STATE.off, profile: PROFILE.manual, ecoMode: 0 });
    settings.startup_eco_mode = "on";
    cloud.frames.push(
      { stoveState: STATE.off, profile: PROFILE.manual, ecoMode: 0 },
      { stoveState: STATE.ignition2, profile: PROFILE.manual, ecoMode: 0 },
    );

    await plugin.start(); // what saving the settings does
    await plugin.refresh!();

    expect(cloud.written).toEqual([[COMMAND.ecoMode, 1]]);
    await plugin.stop();
  });
});
