import { beforeEach, describe, expect, it } from "vitest";
import {
  activeMaintenance,
  assertMaintenanceIdle,
  beginMaintenance,
  guardDatabaseWrites,
  initMaintenanceBridge,
  isMaintenanceActive,
  isMaintenanceError,
  maintenanceInFlight,
  resetMaintenanceForTesting,
  setMaintenanceForTesting,
  waitForMaintenanceWrites,
  withMaintenanceWriteLock,
} from "./maintenanceLock";

describe("maintenance lock", () => {
  beforeEach(() => {
    resetMaintenanceForTesting();
  });

  it("is idle until a marker is raised", () => {
    expect(isMaintenanceActive()).toBe(false);
    expect(() => assertMaintenanceIdle()).not.toThrow();
  });

  it("refuses ordinary writes while a backup or restore is running", () => {
    const release = beginMaintenance("window-a", "备份");
    expect(isMaintenanceActive()).toBe(true);
    expect(() => assertMaintenanceIdle()).toThrow(/E_WRITE_PAUSED: 备份正在进行/);

    release();
    expect(isMaintenanceActive()).toBe(false);
    expect(() => assertMaintenanceIdle()).not.toThrow();
  });

  it("keeps the marker when another window already owns it", () => {
    setMaintenanceForTesting({ owner: "window-b", label: "恢复", until: Date.now() + 60_000 });
    expect(() => beginMaintenance("window-a", "备份")).toThrow(/恢复正在进行/);
    expect(activeMaintenance()?.owner).toBe("window-b");
  });

  it("lets a crashed window expire instead of locking the app forever", () => {
    setMaintenanceForTesting({ owner: "window-c", label: "备份", until: Date.now() - 1 });
    expect(isMaintenanceActive()).toBe(false);
    expect(() => assertMaintenanceIdle()).not.toThrow();
  });

  it("counts guarded writes so a restore can wait for them", async () => {
    let release!: () => void;
    const running = withMaintenanceWriteLock("sqlite", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    expect(maintenanceInFlight()).toBe(1);

    let drained = false;
    const drainedPromise = waitForMaintenanceWrites().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await running;
    await drainedPromise;
    expect(drained).toBe(true);
    expect(maintenanceInFlight()).toBe(0);
  });

  it("rejects a guarded write that starts during maintenance", async () => {
    const release = beginMaintenance("window-a", "恢复");
    await expect(withMaintenanceWriteLock("sqlite", () => Promise.resolve(1))).rejects.toThrow(
      /E_WRITE_PAUSED/,
    );
    release();
    await expect(withMaintenanceWriteLock("sqlite", () => Promise.resolve(2))).resolves.toBe(2);
  });

  it("guards every execute on a SQLite handle but leaves reads alone", async () => {
    const calls: string[] = [];
    const db = {
      execute: async (sql: string) => { calls.push(sql); return { rowsAffected: 1 }; },
      select: async (sql: string) => { calls.push(sql); return [{ ok: 1 }]; },
    };
    const guarded = guardDatabaseWrites(db);

    await expect(guarded.select("SELECT 1")).resolves.toEqual([{ ok: 1 }]);
    await expect(guarded.execute("INSERT INTO tasks VALUES (1)")).resolves.toEqual({ rowsAffected: 1 });

    const release = beginMaintenance("window-a", "备份");
    await expect(guarded.execute("INSERT INTO tasks VALUES (2)")).rejects.toThrow(/E_WRITE_PAUSED/);
    await expect(guarded.select("SELECT 2")).resolves.toEqual([{ ok: 1 }]);
    release();

    await guarded.execute("INSERT INTO tasks VALUES (3)");
    expect(calls).toEqual([
      "SELECT 1",
      "INSERT INTO tasks VALUES (1)",
      "SELECT 2",
      "INSERT INTO tasks VALUES (3)",
    ]);
  });
});

describe("bridge wiring", () => {
  beforeEach(() => {
    resetMaintenanceForTesting();
  });

  it("initialises idempotently so every window listens from startup", () => {
    expect(() => initMaintenanceBridge()).not.toThrow();
    expect(() => initMaintenanceBridge()).not.toThrow();
  });

  it("recognises its own rejection and nothing else", () => {
    const release = beginMaintenance("window-a", "备份");
    try {
      assertMaintenanceIdle();
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isMaintenanceError(error)).toBe(true);
    } finally {
      release();
    }
    expect(isMaintenanceError(new Error("boom"))).toBe(false);
    expect(isMaintenanceError("boom")).toBe(false);
  });
});
