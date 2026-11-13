// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const resume = vi.hoisted(() => vi.fn());
const pauseAndDrain = vi.hoisted(() => vi.fn(async () => resume));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./tongyun/utils/sync/engine", () => ({ syncEngine: { pauseAndDrain } }));

import { restorePlannerFromBackup } from "./unifiedBackup";

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
});
