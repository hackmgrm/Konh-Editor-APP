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
import { getConfig, setConfig } from './appConfig';

let current: WechatConfig | null = null;
const listeners = new Set<() => void>();
const ACCOUNTS_KEY = 'wechat.accounts.v1';

export interface WechatAccount extends WechatConfig { id: string; name: string }
interface AccountStore { activeId: string; accounts: WechatAccount[] }

function readAccounts(): AccountStore {
  try {
    const raw = getConfig(ACCOUNTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AccountStore;
      if (Array.isArray(parsed.accounts)) return parsed;
    }
  } catch { /* fall through to the legacy account */ }
  const legacy = loadConfig();
  const account = { ...legacy, id: 'default', name: legacy.author || '默认公众号' };
  return { activeId: account.id, accounts: [account] };
}

let accountStore: AccountStore | null = null;
function accounts(): AccountStore { return accountStore ??= readAccounts(); }
function persistAccounts() { setConfig(ACCOUNTS_KEY, JSON.stringify(accounts())); }

/** Read on first use, not at import time — appConfig has to be initialized first */
export function getWechatConfig(): WechatConfig {
  if (!current) {
    const store = accounts();
    current = store.accounts.find((item) => item.id === store.activeId) ?? store.accounts[0] ?? loadConfig();
  }
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
  const store = accounts();
  accountStore = { ...store, accounts: store.accounts.map((item) => item.id === store.activeId ? { ...item, ...next } : item) };
  persistAccounts();
  for (const l of listeners) l();
}

export function getWechatAccounts(): { activeId: string; accounts: WechatAccount[] } {
  return accounts();
}

export function addWechatAccount(name = '新公众号'): void {
  const store = accounts();
  const id = `wx-${Date.now()}`;
  accountStore = { activeId: id, accounts: [...store.accounts, { id, name, appid: '', secret: '', author: '', sourceUrl: '', openComment: true }] };
  current = null;
  persistAccounts();
  for (const l of listeners) l();
}

export function switchWechatAccount(id: string): void {
  const store = accounts();
  if (!store.accounts.some((item) => item.id === id)) return;
  accountStore = { ...store, activeId: id };
  current = null;
  clearToken();
  persistAccounts();
  for (const l of listeners) l();
}

export function renameWechatAccount(name: string): void {
  const store = accounts();
  accountStore = { ...store, accounts: store.accounts.map((item) => item.id === store.activeId ? { ...item, name } : item) };
  persistAccounts();
  for (const l of listeners) l();
}

export function deleteWechatAccount(id: string): void {
  const store = accounts();
  if (store.accounts.length <= 1) return;
  const remaining = store.accounts.filter((item) => item.id !== id);
  accountStore = { activeId: store.activeId === id ? remaining[0].id : store.activeId, accounts: remaining };
  current = null;
  clearToken();
  persistAccounts();
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWechatConfig(): WechatConfig {
  return useSyncExternalStore(subscribe, getWechatConfig);
}

export function useWechatAccounts() {
  return useSyncExternalStore(subscribe, getWechatAccounts);
}
