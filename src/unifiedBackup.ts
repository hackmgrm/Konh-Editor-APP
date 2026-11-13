import { invoke } from "@tauri-apps/api/core";
import {
  decodeJournalImageBackup,
  exportJournalImages,
  restoreJournalImagesInPlace,
  type JournalImageBackup,
} from "./tongyun/utils/journalImages";
import { drainPendingStorage } from "./tongyun/utils/deferredStorage";
import {
  beginMaintenance,
  waitForMaintenanceWrites,
} from "./tongyun/utils/maintenanceLock";

/** One archive, one folder, one restore path for writing and planner data. */

export interface BackupSections {
  workspace: boolean;
  planner: boolean;
  journalImages: boolean;
  writingArtifacts: boolean;
  secrets: boolean;
}

export interface BackupFileEntry {
  path: string;
  kind: "file" | "directory";
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: string;
  formatVersion: number;
  createdAt: number;
  appVersion: string;
  sections: BackupSections;
  fileCount: number;
  totalSize: number;
  files: BackupFileEntry[];
}

export interface ExportResult {
  path: string;
  manifest: BackupManifest;
}

export interface InspectResult {
  path: string;
  format: string;
  formatVersion: number;
  createdAt: number;
  appVersion: string;
  sections: BackupSections;
  fileCount: number;
  totalSize: number;
  problems: string[];
  ok: boolean;
}

export interface RestoreResult {
  target: string;
  files: number;
  /** Planner rows written. Zero for file-only restores. */
  rows: number;
  rollbackDir: string | null;
  conflicts: string[];
}

export type MergePolicy = "new-only" | "keep-current";

const JOURNAL_IMAGES_PATH = "planner/journal-images.json";
const CHUNK = 3 * 1024 * 1024;

export function isUnifiedBackupAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function native(): void {
  if (!isUnifiedBackupAvailable()) throw new Error("统一备份只在桌面版可用");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Stream the journal images (IndexedDB) into the staging archive the native
 * side is building. The bytes are the UTF-8 encoded JSON the native side stores
 * verbatim as planner/journal-images.json.
 */
async function stageJournalImages(token: string): Promise<number> {
  const exported = await exportJournalImages();
  const bytes = new TextEncoder().encode(JSON.stringify(exported));
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    await invoke("unified_backup_put_journal_images", {
      token,
      chunkIndex: index,
      base64: toBase64(bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length))),
    });
    index += 1;
  }
  return exported.images.length;
}

export interface ExportOptions {
  /** Folder that will be created. Must not exist. */
  destination: string;
  /** Optional writing workspace to copy alongside the planner data. */
  workspace?: string | null;
}

export interface ExportSummary extends ExportResult {
  journalImages: number;
  workspace: string | null;
}

/** Identifies this window in the maintenance broadcast. */
const WINDOW_OWNER = `window-${Math.random().toString(36).slice(2, 10)}`;

/** Retry the localStorage→SQLite mirror after a maintenance window ends. */
async function flushStorageMirror(): Promise<void> {
  try {
    const { storage } = await import("./tongyun/utils/unifiedStorage");
    await storage.flushNow();
  } catch (error) {
    console.warn("恢复后写入本机数据库失败", error);
  }
}

/**
 * Export everything in one pass. Nothing is published until the native side has
 * hashed every staged file, so a failure never leaves a half-usable archive or
 * replaces an older backup.
 */
export async function runUnifiedExport(options: ExportOptions): Promise<ExportSummary> {
  native();
  const destination = options.destination.trim();
  if (!destination) throw new Error("请选择备份目标目录");
  await drainPendingStorage();

  // Freeze ordinary writes for the duration: the archive must describe one
  // instant, and a half-written row would land in the planner snapshot.
  const releaseMaintenance = beginMaintenance(WINDOW_OWNER, "备份");
  let token: string | null = null;
  try {
    // Inside the try on purpose: `begin` refuses an existing destination, and
    // an early throw here used to leave the marker up for its full TTL — the
    // whole app read-only because a folder name was taken.
    token = await invoke<string>("unified_backup_begin", { destination });
    const journalImages = await stageJournalImages(token);
    const result = await invoke<ExportResult>("unified_backup_finish", {
      token,
      workspace: options.workspace?.trim() || null,
    });
    return { ...result, journalImages, workspace: options.workspace?.trim() || null };
  } catch (error) {
    if (token !== null) {
      try {
        await invoke("unified_backup_abort", { token });
      } catch {
        // The staging directory is cleaned up when the process exits either way.
      }
    }
    throw error;
  } finally {
    // Writes that were refused while the marker was up come back here.
    releaseMaintenance();
    void flushStorageMirror();
  }
}

export async function inspectUnifiedBackup(backup: string): Promise<InspectResult> {
  native();
  return await invoke<InspectResult>("unified_backup_inspect", { backup });
}

/** Read a whole archived file by chunk. Only manifest-listed paths are readable. */
export async function readBackupFile(backup: string, path: string): Promise<Uint8Array> {
  native();
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const chunk = await invoke<{ base64: string; size: number; eof: boolean; nextOffset: number }>(
      "unified_backup_read_file",
      { backup, path, offset, limit: CHUNK },
    );
    parts.push(fromBase64(chunk.base64));
    if (chunk.eof) break;
    if (chunk.nextOffset <= offset) throw new Error(`读取备份文件失败：${path}`);
    offset = chunk.nextOffset;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    merged.set(part, cursor);
    cursor += part.length;
  }
  return merged;
}

async function readJournalImageBackup(backup: string): Promise<JournalImageBackup | null> {
  const bytes = await readBackupFile(backup, JOURNAL_IMAGES_PATH);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const value = parsed as JournalImageBackup;
  if (!value || value.version !== 1 || !Array.isArray(value.images)) {
    throw new Error("备份中的日记图片数据无效");
  }
  // Decoding validates sizes, MIME types and base64 padding before anything is written.
  decodeJournalImageBackup(value);
  return value;
}

export interface RestorePlannerOptions {
  backup: string;
  /** Called after the tables and images are written, before sync resumes. */
  onCommitted?: () => void | Promise<void>;
}

export interface PlannerRestoreSummary {
  images: number;
  rows: number;
  rollbackDir: string | null;
}

/**
 * Restore the planner in place: journal images first (single IndexedDB
 * transaction), then the domain tables (single SQLite transaction) with a
 * rollback point taken beforehand. Automatic sync stays paused until the caller
 * resumes it, so a restore is never immediately overwritten by a pull.
 */
export async function restorePlannerFromBackup(
  options: RestorePlannerOptions,
): Promise<PlannerRestoreSummary> {
  native();
  const { syncEngine } = await import("./tongyun/utils/sync/engine");
  const inspection = await inspectUnifiedBackup(options.backup);
  if (!inspection.ok) {
    throw new Error(`备份校验失败：${inspection.problems.slice(0, 5).join("；")}`);
  }
  if (!inspection.sections.planner) throw new Error("这个备份不含手帐数据");

  // Validate everything before the first write.
  const images = inspection.sections.journalImages ? await readJournalImageBackup(options.backup) : null;

  const resumeSync = await syncEngine.pauseAndDrain();
  let releaseMaintenance: (() => void) | null = null;
  let gateToken: number | null = null;
  let committed = false;
  try {
    // Deferred storage has to be flushed *before* the marker goes up: the
    // flush writes through SQLite, which the marker itself would refuse, so
    // draining afterwards turned a routine restore into a hard failure.
    await drainPendingStorage();
    // Raise the marker first: it can refuse (another window is mid-backup), and
    // taking the native lease before that would leave a barrier with no owner
    // to release it.
    releaseMaintenance = beginMaintenance(WINDOW_OWNER, "恢复");
    gateToken = await invoke<number>("write_gate_acquire");
    await waitForMaintenanceWrites();
    let imageCount = 0;
    if (images) imageCount = await restoreJournalImagesInPlace(images);
    const result = await invoke<RestoreResult>("unified_backup_restore_planner", {
      backup: options.backup,
    });
    await options.onCommitted?.();
    committed = true;
    return { images: imageCount, rows: result.rows, rollbackDir: result.rollbackDir };
  } finally {
    try {
      if (gateToken !== null) {
        await invoke("write_gate_release", { token: gateToken }).catch((error) => {
          console.warn("释放维护锁失败", error);
        });
      }
    } finally {
      releaseMaintenance?.();
      // A committed restore keeps sync paused on purpose: the window reloads,
      // which drops the pause count, so nothing is pushed or pulled until the
      // user has seen the restored data. A failed restore has to lift the pause
      // itself, or the app would stay read-only until the next restart.
      if (!committed) resumeSync();
    }
  }
}

export interface RestoreWorkspaceOptions {
  backup: string;
  destination: string;
  policy?: MergePolicy;
}

export async function restoreWorkspaceFromBackup(
  options: RestoreWorkspaceOptions,
): Promise<RestoreResult> {
  native();
  const destination = options.destination.trim();
  if (!destination) throw new Error("请选择恢复目录");
  const inspection = await inspectUnifiedBackup(options.backup);
  if (!inspection.ok) {
    throw new Error(`备份校验失败：${inspection.problems.slice(0, 5).join("；")}`);
  }
  if (!inspection.sections.workspace) throw new Error("这个备份不含写作工作区");
  return await invoke<RestoreResult>("unified_backup_restore_workspace", {
    backup: options.backup,
    destination,
    policy: options.policy ?? "new-only",
  });
}

export async function restoreWritingAssetsFromBackup(backup: string): Promise<RestoreResult> {
  native();
  const inspection = await inspectUnifiedBackup(backup);
  if (!inspection.ok) throw new Error(`备份校验失败：${inspection.problems.slice(0, 5).join("；")}`);
  const releaseMaintenance = beginMaintenance(WINDOW_OWNER, "恢复");
  try {
    return await invoke<RestoreResult>("unified_backup_restore_writing", { backup });
  } finally {
    releaseMaintenance();
  }
}

/** Timestamped default folder for a writing restore, e.g. Konh恢复-20261113-1130. */
export function defaultRestoreDirectory(parent: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const separator = parent.endsWith("/") || parent.endsWith("\\") ? "" : "/";
  return `${parent}${separator}Konh恢复-${stamp}`;
}

export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
