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
 * It is not the Tauri plugin's native dialog either, which is what this used
 * to be. That one is real and works everywhere, but it is an OS alert: a
 * system-font box with system buttons, thrown over a window made of warm paper
 * — and on macOS it is a *sheet*, which slides down from the title bar of a
 * borderless window with no title bar. The question "delete this draft?" is
 * part of this app and should be asked in its own voice.
 *
 * The plugin stays as the fallback for the case where there is no host: the
 * ConfirmHost has to be mounted for this to draw anything, and a caller that
 * asks before App has rendered deserves a real dialog rather than a silent
 * `false`.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import Modal from './components/Modal';

interface Request {
  id: number;
  message: string;
  okLabel: string;
  resolve: (ok: boolean) => void;
}

let current: Request | null = null;
let nextId = 1;
let hostMounted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

function settle(ok: boolean) {
  const req = current;
  if (!req) return;
  current = null;
  emit();
  req.resolve(ok);
}

/**
 * Ask before destroying something. Returns whether the user agreed.
 *
 * The signature has not changed and neither have the eight call sites: a
 * promise of a boolean, with the affirmative button named after what it does,
 * because "确定" next to a question does not say what is about to happen.
 *
 * One at a time. A second question while one is up would stack two scrims and
 * leave the first promise hanging forever, so the one already on screen is
 * answered `false` — the safe answer — and the new one takes its place.
 */
export async function confirmDestructive(message: string, okLabel = '删除'): Promise<boolean> {
  if (!hostMounted) {
    return ask(message, { kind: 'warning', okLabel, cancelLabel: '取消' });
  }
  settle(false);
  return new Promise<boolean>((resolve) => {
    current = { id: nextId++, message, okLabel, resolve };
    emit();
  });
}

/**
 * The sheet itself, mounted once in App beside the toaster.
 *
 * Focus starts on 取消 rather than on the destructive button: the keyboard
 * should never be one stray Space away from deleting a folder. Return is
 * still the dialog's default action, the way a platform alert's is — it is
 * taken at the document, in capture, because focus is sitting on a `<button>`
 * and Return on a button means "press this button", which would answer the
 * opposite of what was asked.
 */
export function ConfirmHost() {
  const req = useSyncExternalStore(subscribe, snapshot, snapshot);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** The question stays on screen while the box animates shut — the store
   *  drops it the instant it is answered, and a sheet that empties itself on
   *  the way out is worse than one that does not animate at all */
  const shown = useRef<Request | null>(null);
  if (req) shown.current = req;
  const view = req ?? shown.current;

  useEffect(() => {
    hostMounted = true;
    return () => {
      hostMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.altKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      settle(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req]);

  return (
    <Modal
      // Keyed on the request, so a question replacing another one gets a fresh
      // box rather than inheriting the previous one's focus state. It follows
      // `view`, not `req`: keying on a request that has just been answered
      // would remount as it closes, which unmounts it instead of animating
      key={view?.id ?? 'none'}
      open={!!req}
      onClose={() => settle(false)}
      title="确认一下"
      className="confirm"
      initialFocus={cancelRef}
      foot={
        <>
          <span className="grow" />
          <button type="button" ref={cancelRef} className="btn" onClick={() => settle(false)}>
            取消
          </button>
          <button type="button" className="btn danger" onClick={() => settle(true)}>
            {view?.okLabel ?? '删除'}
          </button>
        </>
      }
    >
      <p className="confirm-text">{view?.message ?? ''}</p>
    </Modal>
  );
}
