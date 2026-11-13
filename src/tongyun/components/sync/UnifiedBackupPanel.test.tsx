// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedBackupPanel } from "./UnifiedBackupPanel";

const invoke = vi.hoisted(() => vi.fn());
const openDialog = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

const SECTIONS = {
  workspace: true,
  planner: true,
  journalImages: true,
  writingArtifacts: true,
  secrets: false,
};

function manifest(fileCount = 12) {
  return {
    format: "konh-unified-backup",
    formatVersion: 1,
    createdAt: 1_760_000_000_000,
    appVersion: "0.4.2",
    sections: SECTIONS,
    fileCount,
    totalSize: 4096,
    files: [],
  };
}

let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invoke.mockReset();
  openDialog.mockReset();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function render() {
  const root = createRoot(host);
  await act(() => root.render(<UnifiedBackupPanel />));
  return root;
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no button matching ${label}`);
  return found as HTMLButtonElement;
}

function field(placeholder: string): HTMLInputElement {
  const found = [...host.querySelectorAll("input")].find((el) => el.placeholder === placeholder);
  if (!found) throw new Error(`no input with placeholder ${placeholder}`);
  return found as HTMLInputElement;
}

function setInput(placeholder: string, value: string) {
  const target = field(placeholder);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("unified backup panel", () => {
  it("enables the real controls instead of a disabled preview", async () => {
    const root = await render();
    // No "not available on this build" notice, and the export fields are usable.
    expect(host.textContent).not.toContain("当前不支持统一备份");
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(host.textContent).toContain("创建备份");
    expect(host.textContent).toContain("查看备份");
    expect(host.textContent).toContain("恢复");
    await act(() => root.unmount());
  });

  it("stages journal images and finishes the archive", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_begin") return "tok-1";
      if (command === "unified_backup_put_journal_images") return 1;
      if (command === "unified_backup_finish") return { path: "/tmp/konh-backup", manifest: manifest() };
      throw new Error(`unexpected ${command}`);
    });
    const root = await render();

    await act(async () => {
      setInput("工作区目录", "/tmp/workspace");
      setInput("一个尚不存在的文件夹路径", "/tmp/konh-backup");
    });
    await act(async () => {
      button("开始备份").click();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => {
        if (!invoke.mock.calls.some((call) => call[0] === "unified_backup_finish")) {
          throw new Error("archive not finished yet");
        }
      });
    });

    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).toContain("unified_backup_begin");
    expect(commands).toContain("unified_backup_put_journal_images");
    expect(commands).toContain("unified_backup_finish");
    expect(commands).not.toContain("unified_backup_abort");
    expect(host.textContent).toContain("备份已完成");
    expect(host.textContent).toContain("12 个条目");

    await act(() => root.unmount());
  });

  it("reports a refused destination and cleans the session up", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_begin") throw new Error("E_BACKUP_EXISTS");
      throw new Error(`unexpected ${command}`);
    });
    const root = await render();
    await act(async () => {
      setInput("工作区目录", "/tmp/workspace");
      setInput("一个尚不存在的文件夹路径", "/tmp/existing");
    });
    await act(async () => {
      button("开始备份").click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("目标目录已存在");
    await act(() => root.unmount());
  });

  it("shows the section list and the credential exclusion after a check", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "unified_backup_inspect") {
        return {
          path: "/tmp/konh-backup",
          ...manifest(7),
          problems: [],
          ok: true,
        };
      }
      throw new Error(`unexpected ${command}`);
    });
    const root = await render();

    await act(async () => {
      button("恢复").click();
    });
    await act(async () => {
      setInput("含 manifest.json 的文件夹", "/tmp/konh-backup");
    });
    await act(async () => {
      button("校验这个备份").click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke.mock.calls.map((call) => call[0])).toContain("unified_backup_inspect");
    expect(host.textContent).toContain("校验通过");
    expect(host.textContent).toContain("写作工作区文件");
    expect(host.textContent).toContain("手帐数据");
    expect(host.textContent).toContain("凭据（从不备份，需要重新填写）");
    expect(host.textContent).toContain("恢复手帐（原地）");

    await act(() => root.unmount());
  });
});
