import { describe, expect, it, vi } from 'vitest';
import { storage } from './unifiedStorage';

describe('unified storage drain', () => {
  it('waits for an in-flight failure and retries its dirty keys on the next drain', async () => {
    const state = storage as any;
    let reject!: (error: Error) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }))
      .mockResolvedValue(undefined);
    state.db = { execute };
    state.origGetItem = () => 'value';
    state.dirtyKeys.add('key');
    const batch = state.flush();
    await Promise.resolve();
    const drain = storage.flushNow();
    const error = new Error('disk full');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reject(error);
    await expect(batch).rejects.toThrow('disk full');
    await expect(drain).rejects.toThrow('disk full');
    await expect(storage.flushNow()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    state.db = null;
    vi.restoreAllMocks();
  });
});
