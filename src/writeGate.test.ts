import { beforeEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { withNativeWriteBarrier } from './writeGate';

beforeEach(() => invoke.mockReset());

it('holds the shared lease across async work and releases it on failure', async () => {
  invoke.mockResolvedValueOnce(42).mockResolvedValueOnce(undefined);
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const result = withNativeWriteBarrier(async () => { await waiting; throw new Error('failed'); });
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  finish();
  await expect(result).rejects.toThrow('failed');
  expect(invoke).toHaveBeenLastCalledWith('write_gate_release', { token: 42 });
});

it('does not release a lease when another window owns the barrier', async () => {
  invoke.mockRejectedValueOnce('E_GATE_BUSY');
  const work = vi.fn();
  await expect(withNativeWriteBarrier(work)).rejects.toBe('E_GATE_BUSY');
  expect(work).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
});
