import { useCallback, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  defaultRestoreDirectory,
  formatBackupSize,
  inspectUnifiedBackup,
  isUnifiedBackupAvailable,
  restorePlannerFromBackup,
  restoreWorkspaceFromBackup,
  restoreWritingAssetsFromBackup,
  runUnifiedExport,
  type InspectResult,
  type MergePolicy,
} from "../../../unifiedBackup";

/**
 * The one place that writes a complete archive and reads one back.
 *
 * Export copies the workspace as files, the planner domain tables, the journal
 * images and the writing artifacts. Credentials are excluded by construction —
 * the native side only reads a fixed allow-list of tables and folders.
 */

type Mode = "export" | "inspect" | "restore";

/**
 * The planner and the writing panes hold their own in-memory copies, so the
 * window has to reload once the committed data is on disk. The short delay
 * lets the success toast land first.
 */
function reloadToShowRestoredData(): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => window.location.reload(), 600);
}

const SECTIONS: Array<{ key: keyof InspectResult["sections"]; label: string }> = [
  { key: "workspace", label: "写作工作区文件" },
  { key: "planner", label: "手帐数据（任务、日历、日记、便签、专注、习惯、倒计时、时间块）" },
  { key: "journalImages", label: "日记图片" },
  { key: "writingArtifacts", label: "文章素材与自定义主题" },
];

function emptyInspection(): InspectResult | null {
  return null;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (text.includes("E_BACKUP_EXISTS")) return "目标目录已存在。请换一个新目录，备份不会覆盖已有文件夹。";
  if (text.includes("E_WRITE_PAUSED") || text.includes("E_GATE_BUSY")) return "有写入正在进行（可能另一个窗口正在备份或同步），请稍后重试。";
  if (text.includes("Source changed")) return "备份期间文件发生了变化（外部编辑器或同步写入了文件）。请关闭其他编辑器后重试。";
  if (text.includes("E_BACKUP_TOKEN")) return "备份会话已失效，请重新开始。";
  return text || "操作失败";
}

export function UnifiedBackupPanel({ triggerToast }: { triggerToast?: (message: string, type: "success" | "error") => void } = {}) {
  const native = isUnifiedBackupAvailable();
  const [mode, setMode] = useState<Mode>("export");
  const [workspace, setWorkspace] = useState("");
  const [includeWorkspace, setIncludeWorkspace] = useState(true);
  const [destination, setDestination] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [inspection, setInspection] = useState<InspectResult | null>(emptyInspection());
  const [restoreParent, setRestoreParent] = useState("");
  const [policy, setPolicy] = useState<MergePolicy>("new-only");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");

  const say = useCallback(
    (text: string, type: "success" | "error" = "success") => {
      setMessage(text);
      triggerToast?.(text, type);
    },
    [triggerToast],
  );

  const reset = useCallback(() => {
    setMessage("");
    setFailure("");
  }, []);

  async function pickWorkspace() {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择写作工作区" });
      if (typeof picked === "string") setWorkspace(picked);
    } catch (error) {
      setFailure(describeError(error));
    }
  }

  async function pickDestination() {
    try {
      const parent = await openDialog({ directory: true, multiple: false, title: "选择备份存放位置（将新建一个子文件夹）" });
      if (typeof parent !== "string") return;
      const stamp = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      const name = `Konh备份-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
      setDestination(`${parent}/${name}`);
    } catch (error) {
      setFailure(describeError(error));
    }
  }

  async function pickBackup() {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择备份文件夹（含 manifest.json）" });
      if (typeof picked !== "string") return;
      setBackupPath(picked);
      setInspection(null);
      setRestoreParent(picked.replace(/[\\/][^\\/]+$/, ""));
    } catch (error) {
      setFailure(describeError(error));
    }
  }

  async function pickRestoreParent() {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择恢复位置（将新建 Konh恢复-… 子文件夹）" });
      if (typeof picked === "string") setRestoreParent(picked);
    } catch (error) {
      setFailure(describeError(error));
    }
  }

  async function doExport() {
    if (busy) return;
    reset();
    if (!destination.trim()) {
      setFailure("请先选择备份存放位置");
      return;
    }
    if (includeWorkspace && !workspace.trim()) {
      setFailure("请先选择写作工作区，或取消勾选“包含写作工作区”");
      return;
    }
    setBusy(true);
    try {
      const result = await runUnifiedExport({
        destination: destination.trim(),
        workspace: includeWorkspace ? workspace.trim() : null,
      });
      const summary = [
        `${result.manifest.fileCount} 个条目`,
        formatBackupSize(result.manifest.totalSize),
        `${result.journalImages} 张日记图片`,
      ].join(" · ");
      say(`备份已完成：${result.path}（${summary}）`);
      setBackupPath(result.path);
      setInspection(null);
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function doInspect() {
    if (busy) return;
    reset();
    if (!backupPath.trim()) {
      setFailure("请先选择备份文件夹");
      return;
    }
    setBusy(true);
    try {
      const result = await inspectUnifiedBackup(backupPath.trim());
      setInspection(result);
      if (!result.ok) setFailure(`校验未通过：${result.problems.slice(0, 3).join("；")}`);
    } catch (error) {
      setInspection(null);
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function doRestorePlanner() {
    if (busy || !inspection?.ok) return;
    reset();
    setBusy(true);
    try {
      const result = await restorePlannerFromBackup({ backup: backupPath.trim() });
      say(
        `手帐已恢复：${result.rows} 行数据、${result.images} 张图片。回滚点：${result.rollbackDir ?? "（无）"}。WebDAV 自动同步保持暂停，请检查数据后手动开启。`,
      );
      reloadToShowRestoredData();
    } catch (error) {
      setFailure(`${describeError(error)}（当前数据未被覆盖）`);
    } finally {
      setBusy(false);
    }
  }

  async function doRestoreWorkspace() {
    if (busy || !inspection?.ok) return;
    reset();
    const target =
      policy === "new-only"
        ? defaultRestoreDirectory(restoreParent.trim() || defaultParent(backupPath))
        : restoreParent.trim();
    if (!target) {
      setFailure("请先选择恢复目录");
      return;
    }
    setBusy(true);
    try {
      const result = await restoreWorkspaceFromBackup({
        backup: backupPath.trim(),
        destination: target,
        policy,
      });
      const extra = result.conflicts.length
        ? `有 ${result.conflicts.length} 个同名文件已另存为“（备份 n）”，原文件保留。`
        : "";
      say(`写作文件已恢复到 ${result.target}（${result.files} 个文件）。${extra}`);
    } catch (error) {
      setFailure(`${describeError(error)}（已存在的文件没有被覆盖）`);
    } finally {
      setBusy(false);
    }
  }

  async function doRestoreWriting() {
    if (busy || !inspection?.ok) return;
    reset();
    setBusy(true);
    try {
      const result = await restoreWritingAssetsFromBackup(backupPath.trim());
      say(`文章素材与主题已恢复（${result.files} 个文件）。回滚点：${result.rollbackDir ?? "（无）"}`);
      reloadToShowRestoredData();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="统一备份与恢复"
      className="mb-5 rounded-xl border border-slate-200 p-4 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200"
    >
      <h2 className="font-bold">统一备份与恢复</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        一份备份同时包含写作文件和手帐数据。凭据（微信、AI、Cloudinary、Jina、WebDAV、SMTP、OAuth）不会写进备份，恢复后需要重新填写。
        这与下面的 WebDAV 同步是两件事：同步负责两台设备保持一致，备份负责留下一个可回滚的完整副本。
      </p>
      {!native && <p className="mt-2 text-xs">统一备份只在桌面版可用。</p>}

      <div role="tablist" className="mt-3 flex gap-2">
        {(
          [
            ["export", "创建备份"],
            ["inspect", "查看备份"],
            ["restore", "恢复"],
          ] as Array<[Mode, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              mode === value
                ? "bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            }`}
            onClick={() => {
              setMode(value);
              reset();
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <fieldset disabled={busy || !native} className="mt-3 space-y-3">
        {mode === "export" && (
          <>
            <label className="block">
              <span className="text-xs font-medium">写作工作区</span>
              <span className="mt-1 flex gap-2">
                <input
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                  placeholder="工作区目录"
                  spellCheck={false}
                  className="flex-1 rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 text-xs dark:border-slate-600"
                />
                <button type="button" className="rounded-lg bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800" onClick={() => void pickWorkspace()}>
                  选择
                </button>
              </span>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={includeWorkspace} onChange={(event) => setIncludeWorkspace(event.target.checked)} />
              包含写作工作区（不勾选则只备份手帐与写作素材）
            </label>
            <label className="block">
              <span className="text-xs font-medium">备份位置（将新建的文件夹）</span>
              <span className="mt-1 flex gap-2">
                <input
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="一个尚不存在的文件夹路径"
                  spellCheck={false}
                  className="flex-1 rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 text-xs dark:border-slate-600"
                />
                <button type="button" className="rounded-lg bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800" onClick={() => void pickDestination()}>
                  选择
                </button>
              </span>
            </label>
            <button
              type="button"
              className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white dark:bg-slate-200 dark:text-slate-900"
              disabled={busy || !destination.trim()}
              onClick={() => void doExport()}
            >
              {busy ? "正在备份…" : "开始备份"}
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              备份期间会暂停本窗口的写入并等同步排空。若工作区文件在这期间被外部程序改动，本次备份会失败并且不会留下半成品。
            </p>
          </>
        )}

        {mode !== "export" && (
          <label className="block">
            <span className="text-xs font-medium">备份文件夹</span>
            <span className="mt-1 flex gap-2">
              <input
                value={backupPath}
                onChange={(event) => {
                  setBackupPath(event.target.value);
                  setInspection(null);
                }}
                placeholder="含 manifest.json 的文件夹"
                spellCheck={false}
                className="flex-1 rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 text-xs dark:border-slate-600"
              />
              <button type="button" className="rounded-lg bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800" onClick={() => void pickBackup()}>
                选择
              </button>
            </span>
          </label>
        )}

        {mode !== "export" && (
          <button
            type="button"
            className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold dark:bg-slate-800"
            disabled={busy || !backupPath.trim()}
            onClick={() => void doInspect()}
          >
            {busy ? "校验中…" : "校验这个备份"}
          </button>
        )}

        {inspection && (
          <div className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
            <p className="font-semibold">
              {inspection.ok ? "校验通过" : "校验未通过"} · {inspection.fileCount} 个条目 · {formatBackupSize(inspection.totalSize)}
            </p>
            <p className="mt-1 text-slate-500 dark:text-slate-400">
              备份版本 {inspection.formatVersion} · 应用 {inspection.appVersion} ·{" "}
              {new Date(inspection.createdAt).toLocaleString()}
            </p>
            <ul className="mt-2 list-disc pl-5">
              {SECTIONS.map(({ key, label }) => (
                <li key={key} className={inspection.sections[key] ? "" : "text-slate-400 line-through"}>
                  {label}
                </li>
              ))}
              <li className="text-slate-400 line-through">凭据（从不备份，需要重新填写）</li>
            </ul>
            {inspection.problems.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-red-600 dark:text-red-400">
                {inspection.problems.slice(0, 10).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "restore" && inspection?.ok && (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="font-semibold">手帐</p>
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                写到 staging 并逐表校验后提交。恢复前会自动导出一份当前数据作为回滚点，失败时当前数据保持不变。恢复后 WebDAV 自动同步保持暂停。
              </p>
              <button type="button" className="mt-2 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-slate-200 dark:text-slate-900" disabled={busy} onClick={() => void doRestorePlanner()}>
                恢复手帐（原地）
              </button>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="font-semibold">写作工作区</p>
              <label className="mt-2 block">
                <span className="text-slate-500 dark:text-slate-400">恢复位置</span>
                <span className="mt-1 flex gap-2">
                  <input
                    value={restoreParent}
                    onChange={(event) => setRestoreParent(event.target.value)}
                    placeholder="父目录"
                    spellCheck={false}
                    className="flex-1 rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 text-xs dark:border-slate-600"
                  />
                  <button type="button" className="rounded-lg bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800" onClick={() => void pickRestoreParent()}>
                    选择
                  </button>
                </span>
              </label>
              <label className="mt-2 block text-slate-500 dark:text-slate-400">
                冲突处理
                <select
                  value={policy}
                  onChange={(event) => setPolicy(event.target.value as MergePolicy)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 text-xs dark:border-slate-600"
                >
                  <option value="new-only">恢复到新的 Konh恢复-… 文件夹（推荐）</option>
                  <option value="keep-current">合并到现有文件夹，保留同名原文件</option>
                </select>
              </label>
              <button type="button" className="mt-2 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-slate-200 dark:text-slate-900" disabled={busy} onClick={() => void doRestoreWorkspace()}>
                恢复写作文件
              </button>
            </div>
            {inspection.sections.writingArtifacts && (
              <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <p className="font-semibold">文章素材与自定义主题</p>
                <button type="button" className="mt-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold dark:bg-slate-800" disabled={busy} onClick={() => void doRestoreWriting()}>
                  恢复素材与主题
                </button>
              </div>
            )}
          </div>
        )}
      </fieldset>

      {message && (
        <p role="status" className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
          {message}
        </p>
      )}
      {failure && (
        <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
          {failure}
        </p>
      )}
    </section>
  );
}

function defaultParent(backup: string): string {
  const trimmed = backup.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : "";
}

export default UnifiedBackupPanel;
