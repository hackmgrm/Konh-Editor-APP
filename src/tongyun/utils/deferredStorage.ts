type PendingValue = unknown;

const pending = new Map<string, PendingValue>();
const persistenceFlushers = new Set<() => void>();

export function registerPersistenceFlusher(flush: () => void): () => void {
  persistenceFlushers.add(flush);
  return () => { persistenceFlushers.delete(flush); };
}
let timer: number | null = null;
let listenersInstalled = false;

function flushPendingStorageInternal(strict: boolean): void {
  const errors: unknown[] = [];
  for (const flush of persistenceFlushers) {
    try { flush(); } catch (error) { errors.push(error); }
  }
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  for (const [key, value] of pending) {
    try {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      if (pending.get(key) === value) pending.delete(key);
    } catch (error) {
      errors.push(error);
      console.error(`Deferred storage write failed for "${key}"`, error);
    }
  }
  if (strict && errors.length) throw errors[0];
  if (!strict && errors.length) console.error("Persistence flush failed", errors[0]);
}

/** Best-effort lifecycle flush; failed writes remain pending for a later retry. */
function flushPendingStorage(): void { flushPendingStorageInternal(false); }

/** Flush pending synchronous writes, throwing if any persistence operation fails. */
export function drainPendingStorage(): void { flushPendingStorageInternal(true); }

function installFlushListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener("pagehide", flushPendingStorage);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingStorage();
  });
}

export function scheduleStorageWrite(key: string, value: PendingValue, delay = 150): void {
  pending.set(key, value);
  installFlushListeners();
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(flushPendingStorage, delay);
}

export { flushPendingStorage };
