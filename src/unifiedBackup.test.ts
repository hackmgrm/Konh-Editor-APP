// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const resume = vi.hoisted(() => vi.fn());
const pauseAndDrain = vi.hoisted(() => vi.fn(async () => resume));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./tongyun/utils/sync/engine", () => ({ syncEngine: { pauseAndDrain } }));

import { restorePlannerFromBackup, runUnifiedExport } from "./unifiedBackup";
import {
  assertMaintenanceIdle,
  isMaintenanceActive,
  resetMaintenanceForTesting,
  setMaintenanceForTesting,
} from "./tongyun/utils/maintenanceLock";

const SECTIONS = {
  workspace: false,
  planner: true,
  journalImages: false,
  writingArtifacts: false,
  secrets: false,
};

function inspection() {
  return {
    path: "/tmp/konh-backup",
    format: "konh-unified-backup",
    formatVersion: 1,
    createdAt: 1_760_000_000_000,
    appVersion: "0.4.2",
    sections: SECTIONS,
    fileCount: 3,
    totalSize: 512,
    problems: [],
    ok: true,
  };
}

beforeEach(() => {
  invoke.mockReset();
  resume.mockReset();
  pauseAndDrain.mockClear();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  resetMaintenanceForTesting();
});

describe("restorePlannerFromBackup", () => {
  it("keeps sync paused after a committed restore so nothing overwrites it", async () => {
    const order: string[] = [];
    invoke.mockImplementation(async (command: string) => {
      order.push(command);
      if (command === "unified_backup_inspect") return inspection();
      if (command === "write_gate_acquire") return 7;
      if (command === "write_gate_release") return null;
      if (command === "unified_backup_restore_planner") {
        return { target: "planner", files: 0, rows: 42, rollbackDir: "/tmp/rollback", conflicts: [] };
      }
      throw new Error(`unexpected ${command}`);
    });

    const summary = await restorePlannerFromBackup({ backup: "/tmp/konh-backup" });

    expect(summary.rows).toBe(42);
    expect(summary.images).toBe(0);
    // The gate is taken before the write and released after it.
    expect(order.indexOf("write_gate_acquire")).toBeLessThan(
      order.indexOf("unified_backup_restore_planner"),
    );
    expect(order).toContain("write_gate_release");
    // Sync must not restart on its own: the reload after the success toast is
    // what drops the pause, so a pull cannot clobber the restored tables.
    expect(resume).not.toHaveBeenCalled();
  });

  it("lifts the pause when the restore fails, so the app is not left read-only", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_inspect") return inspection();
      if (command === "write_gate_acquire") return 9;
      if (command === "write_gate_release") return null;
      if (command === "unified_backup_restore_planner") throw new Error("E_WRITE_PAUSED");
      throw new Error(`unexpected ${command}`);
    });

    await expect(restorePlannerFromBackup({ backup: "/tmp/konh-backup" })).rejects.toThrow(
      "E_WRITE_PAUSED",
    );
    expect(resume).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.map((call) => call[0])).toContain("write_gate_release");
  });

  it("refuses a backup that does not verify before touching any data", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_inspect") {
        return { ...inspection(), ok: false, problems: ["Checksum mismatch: planner/planner.json"] };
      }
      throw new Error(`unexpected ${command}`);
    });

    await expect(restorePlannerFromBackup({ backup: "/tmp/konh-backup" })).rejects.toThrow(
      "Checksum mismatch",
    );
    expect(pauseAndDrain).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map((call) => call[0])).not.toContain("write_gate_acquire");
  });

  it("never takes the native lease when another window is already restoring", async () => {
    // A marker from elsewhere means the front-end half of the lock is busy.
    // Taking the lease first would strand a barrier nobody owns.
    setMaintenanceForTesting({ owner: "window-b", label: "恢复", until: Date.now() + 60_000 });
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_inspect") return inspection();
      throw new Error(`unexpected ${command}`);
    });

    await expect(restorePlannerFromBackup({ backup: "/tmp/konh-backup" })).rejects.toThrow(
      /E_WRITE_PAUSED/,
    );
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain("write_gate_acquire");
    expect(commands).not.toContain("write_gate_release");
    expect(commands).not.toContain("unified_backup_restore_planner");
    // The pause it took before noticing has to be lifted again.
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe("runUnifiedExport", () => {
  it("releases the maintenance marker when the destination is already taken", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_begin") throw new Error("E_BACKUP_EXISTS");
      throw new Error(`unexpected ${command}`);
    });

    await expect(runUnifiedExport({ destination: "/tmp/existing" })).rejects.toThrow(
      "E_BACKUP_EXISTS",
    );
    // A leaked marker would keep every window read-only for its whole TTL.
    expect(isMaintenanceActive()).toBe(false);
    expect(() => assertMaintenanceIdle()).not.toThrow();
    // Nothing was staged, so there is nothing to abort either.
    expect(invoke.mock.calls.map((call) => call[0])).not.toContain("unified_backup_abort");
  });

  it("aborts the staged backup and lifts the marker when a later step fails", async () => {
    const commands: string[] = [];
    invoke.mockImplementation(async (command: string) => {
      commands.push(command);
      if (command === "unified_backup_begin") return "token-1";
      if (command === "unified_backup_put_journal_images") return 0;
      if (command === "unified_backup_abort") return null;
      if (command === "unified_backup_finish") throw new Error("Source changed during copy");
      throw new Error(`unexpected ${command}`);
    });

    await expect(runUnifiedExport({ destination: "/tmp/fresh" })).rejects.toThrow("Source changed");
    expect(commands).toContain("unified_backup_abort");
    expect(isMaintenanceActive()).toBe(false);
  });
});
