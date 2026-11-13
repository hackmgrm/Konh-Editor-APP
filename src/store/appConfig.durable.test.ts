import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { getConfig, initAppConfig, setConfig, setConfigDurable, drainAppConfigWrites } from './appConfig';

describe('durable app configuration', () => {
  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce({ 'planner.ai.useWriting': 'false' });
    await initAppConfig();
  });
  it('does not let a completed durable write overwrite a newer synchronous value', async () => {
    let resolve!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const pending = setConfigDurable('key', 'old');
    await Promise.resolve();
    setConfig('key', 'new');
    resolve();
    await pending;
    expect(getConfig('key')).toBe('new');
    await Promise.resolve();
  });
  it('reports background failures until a newer write succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error('disk full'));
    setConfig('background', 'value');
    await expect(drainAppConfigWrites()).rejects.toThrow('disk full');
    invoke.mockResolvedValueOnce(undefined);
    setConfig('background', 'retry');
    await expect(drainAppConfigWrites()).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
  it('keeps the previous value on failure and permits a later retry', async () => {
    invoke.mockRejectedValueOnce(new Error('disk full'));
    await expect(setConfigDurable('planner.ai.useWriting', 'true')).rejects.toThrow('disk full');
    expect(getConfig('planner.ai.useWriting')).toBe('false');
    invoke.mockResolvedValueOnce(undefined);
    await setConfigDurable('planner.ai.useWriting', 'true');
    expect(getConfig('planner.ai.useWriting')).toBe('true');
  });
});
