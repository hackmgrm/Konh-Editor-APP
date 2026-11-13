import { invoke } from '@tauri-apps/api/core';

/** Exclusively pauses cooperating native writers. Busy means retry later; this is
 * not a barrier for SQL plugin, filesystem plugin, or other ungated writers. */
export async function withNativeWriteBarrier<T>(work: () => Promise<T>): Promise<T> {
  const token = await invoke<number>('write_gate_acquire');
  try {
    return await work();
  } finally {
    await invoke('write_gate_release', { token });
  }
}
