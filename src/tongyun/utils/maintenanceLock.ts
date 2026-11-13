/**
 * Front-end half of the maintenance lock.
 *
 * The native gate in `src-tauri/src/write_gate.rs` stops every write that
 * passes through Rust, but the SQLite plugin writes straight from the web view
 * — those statements never reach the gate. This module closes that hole:
 *
 *   - `beginMaintenance` marks the current window as "a unified backup or
 *     restore is running" and broadcasts that over the Tauri event bus, so
 *     every other window refuses ordinary writes too;
 *   - `withMaintenanceWriteLock` wraps one write, refuses to start while the
 *     marker is live, and keeps the write counted so a restore can wait for
 *     it to land;
 *   - the marker expires on its own, so a crashed window cannot leave the app
 *     permanently read-only.
 *
 * Broadcast rather than localStorage on purpose: `unifiedStorage.ts` takes
 * over `localStorage.setItem` and mirrors every key into SQLite, so a marker
 * written there would itself become a guarded SQLite write.
 */

export const MAINTENANCE_EVENT = "konh:maintenance";

/** Long enough for a multi-gigabyte backup, short enough to survive a crash. */
const DEFAULT_TTL_MS = 30 * 60_000;

type Marker = { owner: string; label: string; until: number };

let marker: Marker | null = null;
let bridgeReady = false;
let idleWaiters: Array<() => void> = [];
let inFlight = 0;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Subscribe once so a marker raised in another window is honoured here.
 * Called at module load, not from `beginMaintenance`: a window that never
 * starts a backup still has to refuse writes when another one does.
 */
export function initMaintenanceBridge(): void {
  if (bridgeReady || !isTauri()) return;
  bridgeReady = true;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<{ active: boolean; owner: string; label: string; until: number }>(
        MAINTENANCE_EVENT,
        (event) => {
          const payload = event.payload;
          if (payload.owner === currentOwner) return;
          marker = payload.active ? { owner: payload.owner, label: payload.label, until: payload.until } : null;
        },
      );
    } catch (error) {
      console.warn("维护锁广播不可用", error);
    }
  })();
}

let currentOwner: string | null = null;

function broadcast(payload: { active: boolean; owner: string; label: string; until: number }): void {
  if (!isTauri()) return;
  void (async () => {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(MAINTENANCE_EVENT, payload);
    } catch (error) {
      console.warn("维护锁广播失败", error);
    }
  })();
}

function liveMarker(): Marker | null {
  if (marker && marker.until <= Date.now()) marker = null;
  return marker;
}

export function maintenanceError(live: Marker): Error {
  const error = new Error(`E_WRITE_PAUSED: ${live.label}正在进行，请等待完成后再操作`);
  error.name = "MaintenanceWritePaused";
  return error;
}

/**
 * Publish the marker. Returns a release function; calling it twice is safe,
 * and closing the window releases it automatically.
 */
export function beginMaintenance(owner: string, label: string, ttlMs = DEFAULT_TTL_MS): () => void {
  initMaintenanceBridge();
  const existing = liveMarker();
  if (existing && existing.owner !== owner) throw maintenanceError(existing);

  const until = Date.now() + ttlMs;
  marker = { owner, label, until };
  currentOwner = owner;
  broadcast({ active: true, owner, label, until });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (marker?.owner === owner) {
      marker = null;
      currentOwner = null;
      broadcast({ active: false, owner, label, until: 0 });
    }
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", release, { once: true });
  return release;
}

export function isMaintenanceActive(): boolean {
  return liveMarker() !== null;
}

export function activeMaintenance(): Marker | null {
  return liveMarker();
}

/** Reject a write when anything (including this window) holds the marker. */
export function assertMaintenanceIdle(): void {
  const live = liveMarker();
  if (live) throw maintenanceError(live);
}

/**
 * Run one write under the lock: refuse to start during maintenance, and keep
 * the write counted so a restore can wait for it to land.
 */
export async function withMaintenanceWriteLock<T>(_label: string, work: () => Promise<T> | T): Promise<T> {
  assertMaintenanceIdle();
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
    if (inFlight === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

/** Resolve once no guarded write is still running. Call before a restore. */
export function waitForMaintenanceWrites(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

export function maintenanceInFlight(): number {
  return inFlight;
}

/** Test seam: forget the marker and the pending-write counter. */
export function resetMaintenanceForTesting(): void {
  marker = null;
  currentOwner = null;
  inFlight = 0;
  idleWaiters = [];
}

/** Test seam: raise a marker as if another window had broadcast it. */
export function setMaintenanceForTesting(next: Marker | null): void {
  marker = next;
}

type SqlExecutor = { execute: (...args: never[]) => Promise<unknown> };

/**
 * Wrap a SQLite handle so every `execute` — including the ones buried inside
 * `queueDomainWrite` callbacks and the localStorage mirror — passes through
 * `withMaintenanceWriteLock`. Reads are left alone: a restore swaps tables in a
 * single transaction, so a `select` sees either the old or the new data.
 */
export function guardDatabaseWrites<T extends SqlExecutor>(db: T): T {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "execute") return (value as (...args: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) =>
        withMaintenanceWriteLock("sqlite", () =>
          (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args),
        );
    },
  }) as T;
}

/** True for the rejection raised when a write lands during maintenance. */
export function isMaintenanceError(error: unknown): boolean {
  return error instanceof Error && error.name === "MaintenanceWritePaused";
}

// Every window has to listen from the moment the app starts, otherwise the
// first backup started elsewhere would go unnoticed here.
if (typeof window !== "undefined") {
  initMaintenanceBridge();
}
