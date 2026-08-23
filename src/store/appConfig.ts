/**
 * Synchronous façade over the app-level config.
 *
 * These things (WeChat credentials, cached tokens, the image-upload dedupe
 * table) must not travel with the workspace — a workspace is a directory meant
 * to be committed to git, and an AppSecret in there is an AppSecret leaked. So
 * they live in the app config directory, read and written by the Rust config_*
 * commands.
 *
 * Disk is asynchronous, but the code that consumes this was all written
 * against localStorage's synchronous semantics. Rather than making every
 * function in wechat.ts async (and every caller all the way up), read it into
 * memory once at startup: reads come from memory, writes update memory
 * immediately and hit the disk fire-and-forget.
 * That is the same order of reliability localStorage actually offers, and the
 * shape of the interface survives unchanged.
 */

import { invoke } from '@tauri-apps/api/core';

let cache: Record<string, string> = {};
let loaded = false;

/** Call once at startup, before rendering — every read afterwards assumes it
 *  is already in memory */
export async function initAppConfig(): Promise<void> {
  try {
    cache = await invoke<Record<string, string>>('config_load');
  } catch {
    cache = {};
  }
  loaded = true;
}

export function getConfig(key: string): string | null {
  if (!loaded) console.warn('appConfig 还没初始化就被读了', key);
  return cache[key] ?? null;
}

export function setConfig(key: string, value: string): void {
  cache[key] = value;
  void invoke('config_write', { key, value }).catch((e) => console.warn('设置写盘失败', key, e));
}

export function removeConfig(key: string): void {
  delete cache[key];
  void invoke('config_remove', { key }).catch((e) => console.warn('设置删除失败', key, e));
}
