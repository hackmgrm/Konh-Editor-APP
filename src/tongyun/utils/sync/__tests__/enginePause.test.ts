import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("drains admitted sync and blocks new sync and conflict work until all leases release", async () => {
  const { SyncEngine } = await import("../engine");
  const engine = new SyncEngine();
  const first = deferred();
  const sync = vi.spyOn(engine as any, "doSync").mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
  const conflict = vi.spyOn(engine as any, "doResolveConflicts").mockResolvedValue(undefined);
  const running = engine.sync();
  await Promise.resolve();
  let drained = false;
  const pause = engine.pauseAndDrain().then((release) => { drained = true; return release; });
  const secondPause = engine.pauseAndDrain();
  const queued = engine.sync();
  const resolution = engine.resolveConflicts("remote");
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(conflict).not.toHaveBeenCalled();
  first.resolve();
  await running;
  const release = await pause;
  const release2 = await secondPause;
  release();
  release();
  await Promise.resolve();
  expect(sync).toHaveBeenCalledTimes(1);
  release2();
  await Promise.all([queued, resolution]);
  expect(sync).toHaveBeenCalledTimes(2);
  expect(conflict).toHaveBeenCalledOnce();
});

it("does not admit a waiter if another pause wins the release race", async () => {
  const { SyncEngine } = await import("../engine");
  const engine = new SyncEngine();
  const sync = vi.spyOn(engine as any, "doSync").mockResolvedValue(undefined);
  const release = await engine.pauseAndDrain();
  const queued = engine.sync();
  release();
  const releaseAgain = await engine.pauseAndDrain();
  await Promise.resolve();
  expect(sync).not.toHaveBeenCalled();
  releaseAgain();
  await queued;
  expect(sync).toHaveBeenCalledOnce();
});

it("drains ongoing conflict work even when it rejects", async () => {
  const { SyncEngine } = await import("../engine");
  const engine = new SyncEngine();
  const pending = deferred();
  vi.spyOn(engine as any, "doResolveConflicts").mockImplementation(async () => {
    await pending.promise;
    throw new Error("failed");
  });
  const resolution = engine.resolveConflicts("local");
  const rejected = expect(resolution).rejects.toThrow("failed");
  let drained = false;
  const pause = engine.pauseAndDrain().then((release) => { drained = true; return release; });
  await Promise.resolve();
  expect(drained).toBe(false);
  pending.resolve();
  await rejected;
  (await pause)();
});
