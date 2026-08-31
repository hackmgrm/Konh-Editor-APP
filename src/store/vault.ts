/**
 * Front-end façade over the vault — wraps the Rust commands as domain actions.
 *
 * This layer holds no state, does no debouncing and decides no conflicts. Its
 * only job is to make the calls read like sentences: callers see loadVault /
 * writeDraft rather than invoke('draft_write', {...}).
 * Parameter names must match the Rust signatures (Tauri passes them by name),
 * so changing one side means changing the other.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

/**
 * A draft = one .md / .markdown / .txt file anywhere in the workspace.
 *
 * The id is the **workspace-relative path** (e.g. "series/part-one.md"); the
 * name is the file name without its extension.
 * Early versions only recognized a single flat level under drafts/ and used the
 * bare file name as the id — a convention that also locked the file tree into
 * two hard-coded groups. That is gone: the directory layout is the user's.
 */
export interface Draft {
  /** Workspace-relative path including the extension, e.g. "series/part-one.md" */
  id: string;
  /** Display name = file name minus extension */
  name: string;
  content: string;
  /** Disk mtime in milliseconds. Used as the baseline on write-back to detect
   *  outside changes */
  updatedAt: number;
}

/** A node in the directory tree. Only directories have children (expanded recursively) */
export interface Entry {
  name: string;
  /** Workspace-relative path, always `/`-separated */
  path: string;
  isDir: boolean;
  size: number;
  updatedAt: number;
  children: Entry[] | null;
}

/**
 * Theme, typographic density, which draft is open.
 *
 * Stored in the app config directory (indexed by workspace path), never in
 * browser storage and never inside the workspace itself — these are "how I
 * look at this on this machine", not part of the draft.
 */
export interface Prefs {
  /** Default for old drafts and drafts that have not chosen their own theme yet */
  themeId: string;
  /** Draft path → theme id. Keeps theme selection local to each article. */
  themeByDraft: Record<string, string>;
  densityId: string;
  linkFootnotes: boolean;
  activeId: string | null;
}

export interface VaultData {
  drafts: Draft[];
  /** Image relative path → data URI */
  images: Record<string, string>;
  /** null when a fresh vault has no prefs file yet */
  prefs: Prefs | null;
  /** The full directory tree */
  tree: Entry[];
}

/** Extensions the editor can open (keep in sync with TEXT_EXTS on the Rust side) */
export const TEXT_EXTS = ['md', 'markdown', 'txt'];
/** Image extensions we recognize (keep in sync with mime_of on the Rust side) */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'];

/** Lowercase extension, or empty string */
export function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export const isTextPath = (path: string) => TEXT_EXTS.includes(extOf(path));
export const isImagePath = (path: string) => IMAGE_EXTS.includes(extOf(path));

/** Flatten the tree into a file list (directories excluded). Used to reconcile
 *  against the drafts and images held in memory */
export function flattenFiles(entries: Entry[], out: Entry[] = []): Entry[] {
  for (const e of entries) {
    if (e.children) flattenFiles(e.children, out);
    else out.push(e);
  }
  return out;
}

/** Parent directory of a relative path (empty string at the root) */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Result of a write-back.
 *
 * `conflict` means someone changed this while we were holding it — most often
 * an agent working in the same vault. No automatic merge happens here: the
 * disk version is handed back so the user can decide.
 */
export type WriteResult =
  | { status: 'ok'; updatedAt: number }
  | { status: 'conflict'; diskContent: string; diskUpdatedAt: number };

/* ---------- Workspace ---------- */

/** The last workspace opened; null if there is none, or it has been deleted */
export function recallVault(): Promise<string | null> {
  return invoke<string | null>('vault_recall');
}

export function rememberVault(dir: string): Promise<void> {
  return invoke('vault_remember', { dir });
}

/** Open the native directory picker. null if the user cancels. An empty
 *  directory is fine — the structure gets built when the vault opens */
export async function pickVault(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: '选择工作区文件夹' });
  return typeof picked === 'string' ? picked : null;
}

/** Open the vault: draft bodies, images, prefs and the directory tree in one read */
export function loadVault(dir: string): Promise<VaultData> {
  return invoke<VaultData>('vault_load', { dir });
}

/** Directory tree only. Used to refresh after an outside change, without
 *  re-reading any bodies */
export function readTree(dir: string): Promise<Entry[]> {
  return invoke<Entry[]>('vault_tree', { dir });
}

/**
 * Watch the workspace and call back on outside changes (the argument is a
 * list of vault-relative paths).
 *
 * The Rust side neither deduplicates nor debounces, and neither does this one:
 * both merging and "filter out the write we just made ourselves" depend on the
 * mtimes held in memory, which only the layer above knows. So that is
 * useVault's job.
 */
export async function watchVault(
  dir: string,
  onChange: (paths: string[]) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<string[]>('vault:change', (e) => onChange(e.payload));
  try {
    await invoke('vault_watch', { dir });
  } catch (e) {
    // The listener was registered before the watcher existed; if the watcher
    // never came up it has nothing to hear and would sit there for the life of
    // the window. Take it down before handing the failure on.
    unlisten();
    throw e;
  }
  return unlisten;
}

/* ---------- Drafts ---------- */

export function readDraft(dir: string, id: string): Promise<Draft> {
  return invoke<Draft>('draft_read', { dir, id });
}

/** Write one back. Pass the mtime of the copy we hold as baseUpdatedAt; a
 *  mismatch comes back as a conflict */
export function writeDraft(
  dir: string,
  id: string,
  content: string,
  baseUpdatedAt: number,
): Promise<WriteResult> {
  return invoke<WriteResult>('draft_write', { dir, id, content, baseUpdatedAt });
}

/** Create one under `parent` (empty string = root). Name collisions get a
 *  numeric suffix automatically */
export function createDraft(dir: string, parent: string, name: string, content = ''): Promise<Draft> {
  return invoke<Draft>('draft_create', { dir, parent, name, content });
}

/* ---------- Files and folders ---------- */

/** Create a folder, returning its relative path */
export function createDir(dir: string, parent: string, name: string): Promise<string> {
  return invoke<string>('dir_create', { dir, parent, name });
}

/** Rename (files and folders alike), returning the new relative path. Throws
 *  if the target already exists */
export function renameEntry(dir: string, path: string, name: string): Promise<string> {
  return invoke<string>('entry_rename', { dir, path, name });
}

/** Move into another directory (toParent empty = root), returning the new path */
export function moveEntry(dir: string, path: string, toParent: string): Promise<string> {
  return invoke<string>('entry_move', { dir, path, toParent });
}

/** Delete a file or folder (folders take their contents). Whether to confirm
 *  is up to the caller */
export function deleteEntry(dir: string, path: string): Promise<void> {
  return invoke('entry_delete', { dir, path });
}

/** Reveal it in the system file manager — the way out for files we cannot
 *  open (pdf, psd…) */
export function revealEntry(dir: string, path: string): Promise<void> {
  return invoke('entry_reveal', { dir, path });
}

/* ---------- Images ---------- */

export function readImage(dir: string, path: string): Promise<string> {
  return invoke<string>('image_read', { dir, path });
}

/** Store an image. Takes a data URI; Rust decodes it to binary under images/
 *  and returns the relative path */
export function writeImage(dir: string, name: string, dataUrl: string): Promise<string> {
  return invoke<string>('image_write', { dir, name, dataUrl });
}

export function deleteImage(dir: string, path: string): Promise<void> {
  return invoke('image_delete', { dir, path });
}

/* ---------- Prefs ---------- */

export function writePrefs(dir: string, prefs: Prefs): Promise<void> {
  return invoke('prefs_write', { dir, prefs });
}
