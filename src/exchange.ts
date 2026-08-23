/**
 * Writing a file out of the app.
 *
 * There is exactly one export here, and that is deliberate. A workspace is
 * already an ordinary folder — the drafts *are* `.md` files and the images
 * *are* image files — so "export this draft" would copy a file that is already
 * sitting on disk, and "back up everything" would zip a directory the user can
 * zip in Finder.
 *
 * What is left is the one export that produces something the workspace does not
 * already contain: the rendered long image (see longimage.ts).
 */

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

/**
 * Save a file: open the native "Save to…" dialog and write the bytes to
 * wherever the user picked.
 *
 * An `<a download>` barely works inside WKWebView, and a desktop app should
 * not be dropping things into a Downloads folder anyway — let the user choose
 * the place.
 *
 * Returns false when the user cancels the dialog, so the caller can decide
 * whether to say anything about it.
 */
export async function saveBlob(filename: string, blob: Blob): Promise<boolean> {
  const path = await save({ defaultPath: filename });
  if (!path) return false;
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await invoke('file_save', { path, bytes });
  return true;
}

/** DOS device names, which Windows reserves with or without an extension */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Make a file name safe enough for the strictest platform, not the current one.
 *
 * This is the default the native "Save to…" dialog opens with, and a name
 * Windows will not accept comes back as an error from the dialog rather than
 * anything we can explain. So it applies Windows' rules everywhere: its illegal
 * characters, no trailing dots or spaces, and none of the DOS device names.
 *
 * Kept deliberately in step with `sanitize_title` in src-tauri/src/vault.rs,
 * which does the same job for names that land in the workspace.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops trailing dots and spaces, turning two distinct
    // names into one
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!cleaned) return '未命名';
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}
