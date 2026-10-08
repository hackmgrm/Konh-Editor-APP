import { useEffect, useSyncExternalStore } from 'react';
import { EXIT_MODAL, usePresence } from './usePresence';

/** A button inside the toast — "撤销", "去看看". Pressing it dismisses the toast */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** How long it stays. One with an action gets longer: there is something to do */
  ms?: number;
}

interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
  ms: number;
  /** Its time is up (or it was pushed out by newer ones): play the exit */
  closing: boolean;
}

/** Three is the point where a stack stops being readable and starts being a wall */
const MAX = 3;
const DEFAULT_MS = 2600;
const ACTION_MS = 5200;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return items;
}

/** Start the exit. The row removes itself once the animation is over.
 *  Items are replaced rather than mutated — the store is read through
 *  useSyncExternalStore, which compares by reference */
function close(id: number) {
  if (!items.some((t) => t.id === id && !t.closing)) return;
  items = items.map((t) => (t.id === id ? { ...t, closing: true } : t));
  emit();
}

/** Gone for good */
function drop(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/**
 * Say something, briefly.
 *
 * The old version was a single `.status` span: a second message during the
 * first one simply overwrote it, so an import that reports 正在存图 3/12 and
 * then fails told you only about the failure. Here they queue — up to three,
 * newest at the bottom, each with its own life — and a fourth pushes the
 * oldest out rather than piling up off the top of the window.
 */
export function toast(message: string, options: ToastOptions = {}): void {
  const item: ToastItem = {
    id: nextId++,
    message,
    action: options.action,
    ms: options.ms ?? (options.action ? ACTION_MS : DEFAULT_MS),
    closing: false,
  };
  // Over capacity: the oldest ones still on screen leave, animating out the
  // same way they would have anyway
  const next = [...items, item];
  const live = next.filter((t) => !t.closing);
  const pushedOut = new Set(live.slice(0, Math.max(0, live.length - MAX)).map((t) => t.id));
  items = pushedOut.size ? next.map((t) => (pushedOut.has(t.id) ? { ...t, closing: true } : t)) : next;
  emit();
}

function ToastRow({ item }: { item: ToastItem }) {
  const { mounted, state } = usePresence(!item.closing, EXIT_MODAL);

  // Its own clock. Paused for nothing — hovering a toast to read it is not a
  // gesture anyone makes, and one that will not go away is worse than one that
  // went away early
  useEffect(() => {
    if (item.closing) return;
    const timer = window.setTimeout(() => close(item.id), item.ms);
    return () => window.clearTimeout(timer);
  }, [item.id, item.ms, item.closing]);

  useEffect(() => {
    if (!mounted) drop(item.id);
  }, [mounted, item.id]);

  if (!mounted) return null;

  return (
    <div className="toast" data-state={state} role="status">
      <span className="toast-text">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action?.onClick();
            close(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The stack itself, mounted once in App.
 *
 * `pointer-events: none` on the column and `auto` on each pill: a toast sitting
 * over the article must not swallow a click meant for the text behind it, but
 * its own action button has to be pressable.
 */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!list.length) return null;
  return (
    <div className="toaster" aria-live="polite">
      {list.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  );
}
