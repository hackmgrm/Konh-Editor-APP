/**
 * The WeChat account configuration, shared by everything that touches it.
 *
 * It used to live inside PublishDialog's own state, which was fine while that
 * dialog was the only place it could be edited. It is not any more: credentials
 * are configured in the account dialog, the stats panel reads them, and the
 * push dialog still writes the publishing defaults. Three copies of the same
 * `useState(loadConfig)` would mean the last one to save wins — enter the
 * AppID in one dialog, press push in another, and the push writes back the
 * empty credentials it read at startup.
 *
 * So there is one copy, in a module, and components subscribe to it. Writes go
 * to disk immediately (the config file is the source of truth across restarts)
 * and notify every subscriber.
 */

import { useSyncExternalStore } from 'react';
import { clearToken, loadConfig, saveConfig, type WechatConfig } from '../wechat';

let current: WechatConfig | null = null;
const listeners = new Set<() => void>();

/** Read on first use, not at import time — appConfig has to be initialized first */
export function getWechatConfig(): WechatConfig {
  if (!current) current = loadConfig();
  return current;
}

/**
 * Patch the configuration and persist it.
 *
 * Changing the credentials also throws away the cached access_token: it was
 * minted for the old AppID and is worthless now, and keeping it would make the
 * next call fail with a confusing 40001 instead of simply fetching a new one.
 */
export function patchWechatConfig(patch: Partial<WechatConfig>): void {
  const before = getWechatConfig();
  const next = { ...before, ...patch };
  if (next.appid !== before.appid || next.secret !== before.secret) clearToken();
  current = next;
  saveConfig(next);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWechatConfig(): WechatConfig {
  return useSyncExternalStore(subscribe, getWechatConfig);
}
