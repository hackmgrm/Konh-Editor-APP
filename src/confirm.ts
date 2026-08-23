/**
 * Asking before something irreversible.
 *
 * Not `window.confirm`. That one looks like the obvious answer and behaves
 * differently on all three platforms, in the worst possible direction:
 *
 * * **macOS** — WKWebView has no built-in dialog at all; it asks its
 *   `WKUIDelegate`, and if nobody implements `runJavaScriptConfirmPanel` the
 *   documented behaviour is "as if the user pressed Cancel". wry implements the
 *   file-open panel and the media-permission prompt and stops there, so
 *   `window.confirm()` returns **false immediately, with no dialog**: nothing
 *   appears, nothing happens, and the button looks broken.
 * * **Windows** — WebView2 ships default script dialogs, so it works.
 * * **Linux** — WebKitGTK's default `script-dialog` handler shows a GTK dialog,
 *   so it works too.
 *
 * Which is to say the one platform this is developed on is the one where the
 * delete button quietly does nothing. The plugin goes through Rust and puts up
 * a real native dialog on all three.
 */

import { ask } from '@tauri-apps/plugin-dialog';

/**
 * Ask before destroying something. Returns whether the user agreed.
 *
 * `kind: 'warning'` is what gives it the alert icon; the labels are named
 * rather than left as OK/Cancel because "确定" next to a question does not say
 * what is about to happen.
 */
export async function confirmDestructive(message: string, okLabel = '删除'): Promise<boolean> {
  return ask(message, { kind: 'warning', okLabel, cancelLabel: '取消' });
}
