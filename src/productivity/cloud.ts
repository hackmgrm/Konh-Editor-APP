import {
  createClient,
  type SupabaseClient,
  type Session,
} from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';
import { getConfig, setConfigDurable } from '../store/appConfig';
import { getProductivity, mutateProductivity } from './store';
import {
  copyForAccount,
  mergeRecords,
  records,
  syncedKinds,
  type CloudRecord,
} from './syncModel';

async function cloudFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if ('__TAURI_INTERNALS__' in window)
    return (await import('@tauri-apps/plugin-http')).fetch(input, init);
  return fetch(input, init);
}

export interface CloudConfig {
  url: string;
  publishableKey: string;
  calendarEnabled: boolean;
  calendarTimedOnly: boolean;
  calendarKeepCompleted: boolean;
}
export function cloudConfig(): CloudConfig {
  try {
    return {
      url: '',
      publishableKey: '',
      calendarEnabled: false,
      calendarTimedOnly: false,
      calendarKeepCompleted: false,
      ...JSON.parse(getConfig('productivity.cloud') || '{}'),
    };
  } catch {
    return {
      url: '',
      publishableKey: '',
      calendarEnabled: false,
      calendarTimedOnly: false,
      calendarKeepCompleted: false,
    };
  }
}
let client: SupabaseClient | null = null;
let clientKey = '';
let session: Session | null = null;
let syncJob: Promise<void> | null = null;
let paused = false;
const sent = new Map<string, string>();
let status = '未连接账号';
const subscribers = new Set<() => void>();
function publish(text: string) {
  status = text;
  subscribers.forEach((fn) => fn());
}
export const cloudStatus = () => status;
export const subscribeCloud = (fn: () => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};
export const currentSession = () => session;
export const accountKey = (s: Session) =>
  `${cloudConfig().url.replace(/\/$/, '')}|${s.user.id}`;
const volatile = new Map<string, string>();
const secure = {
  async getItem(key: string): Promise<string | null> {
    return '__TAURI_INTERNALS__' in window
      ? invoke('productivity_secret_read', { key: `konh-productivity-${key}` })
      : (volatile.get(key) ?? null);
  },
  async setItem(key: string, value: string) {
    if ('__TAURI_INTERNALS__' in window)
      await invoke('productivity_secret_write', {
        key: `konh-productivity-${key}`,
        value,
      });
    else volatile.set(key, value);
  },
  async removeItem(key: string) {
    if ('__TAURI_INTERNALS__' in window)
      await invoke('productivity_secret_write', {
        key: `konh-productivity-${key}`,
        value: null,
      });
    else volatile.delete(key);
  },
};
export async function saveCloudConfig(config: CloudConfig) {
  const url = new URL(config.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('请输入 HTTPS 账号服务地址');
  if (!config.publishableKey.trim()) throw new Error('请填写公开连接密钥');
  if (config.publishableKey.startsWith('sb_secret_'))
    throw new Error('这里只能使用公开密钥，不能填写服务端密钥');
  if (session && config.url !== cloudConfig().url)
    throw new Error('切换服务器前请先退出账号');
  await syncJob?.catch(() => {});
  await setConfigDurable(
    'productivity.cloud',
    JSON.stringify({
      ...config,
      url: config.url.replace(/\/$/, ''),
      publishableKey: config.publishableKey.trim(),
    }),
  );
  sent.clear();
}
export function cloudClient(): SupabaseClient {
  const config = cloudConfig();
  if (!config.url || !config.publishableKey)
    throw new Error('请先配置账号同步服务');
  const key = `${config.url}|${config.publishableKey}`;
  if (client && key === clientKey) return client;
  client?.auth.stopAutoRefresh();
  clientKey = key;
  client = createClient(config.url, config.publishableKey, {
    global: { fetch: cloudFetch },
    auth: {
      storage: secure,
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  client.auth.onAuthStateChange((_event, next) => {
    session = next;
    if (!next) publish('未连接账号');
    else if (getProductivity().syncOwner !== accountKey(next))
      publish('请选择这个账号的数据使用方式');
    else publish(`已登录 ${next.user.email ?? ''}`);
  });
  return client;
}
export async function restoreCloud() {
  if (!cloudConfig().url) return;
  try {
    const result = await cloudClient().auth.getSession();
    if (result.error) throw result.error;
    session = result.data.session;
    if (session)
      publish(
        getProductivity().syncOwner === accountKey(session)
          ? '已登录，等待同步'
          : '请选择这个账号的数据使用方式',
      );
  } catch (e) {
    publish(`账号连接失败：${String(e)}`);
  }
}
export async function passwordLogin(
  email: string,
  password: string,
  signup = false,
) {
  paused = true;
  await syncJob?.catch(() => {});
  try {
    const result = signup
      ? await cloudClient().auth.signUp({ email, password })
      : await cloudClient().auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    session = result.data.session;
    sent.clear();
    publish(
      session
        ? '登录成功，请选择数据使用方式'
        : '注册成功，请查收验证邮件后登录',
    );
  } finally {
    paused = false;
  }
}
export async function googleLogin(calendar = false) {
  if (!('__TAURI_INTERNALS__' in window))
    throw new Error('Google 登录请使用桌面安装版');
  paused = true;
  await syncJob?.catch(() => {});
  try {
    const result = await cloudClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'http://127.0.0.1:42819/callback',
        skipBrowserRedirect: true,
        scopes: calendar
          ? 'https://www.googleapis.com/auth/calendar.app.created'
          : undefined,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    if (result.error) throw result.error;
    const code = await invoke<string>('productivity_oauth', {
      url: result.data.url,
    });
    const exchange = await cloudClient().auth.exchangeCodeForSession(code);
    if (exchange.error) throw exchange.error;
    session = exchange.data.session;
    sent.clear();
    if (session?.provider_token)
      await secure.setItem(
        `google-${session.user.id}`,
        JSON.stringify({
          access: session.provider_token,
          refresh: session.provider_refresh_token,
          expires: Date.now() + 3500_000,
        }),
      );
    publish('Google 登录成功');
  } finally {
    paused = false;
  }
}
async function pull(): Promise<CloudRecord[]> {
  const result: CloudRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    const response = await cloudClient()
      .from('konh_records')
      .select('kind,record_id,data')
      .order('kind')
      .order('record_id')
      .range(offset, offset + 499);
    if (response.error) throw response.error;
    result.push(...(response.data as CloudRecord[]));
    if (response.data.length < 500) return result;
  }
}
export async function chooseAccount(mode: 'cloud' | 'copy') {
  if (!session) throw new Error('请先登录');
  paused = true;
  await syncJob?.catch(() => {});
  const owner = accountKey(session);
  try {
    const remote = await pull();
    await mutateProductivity((d) => {
      if (mode === 'cloud') {
        for (const kind of syncedKinds) d[kind] = [];
        d.timer = null;
      } else copyForAccount(d);
      mergeRecords(d, remote);
      d.syncOwner = owner;
    });
    sent.clear();
    publish('已选择数据，准备同步');
  } finally {
    paused = false;
  }
  await syncNow();
}
export async function signOut() {
  paused = true;
  try {
    await syncJob?.catch(() => {});
    const result = await cloudClient().auth.signOut({ scope: 'local' });
    if (result.error) throw result.error;
    session = null;
    sent.clear();
    publish('已退出，数据保留在本机');
  } finally {
    paused = false;
  }
}
export async function syncNow() {
  if (syncJob) return syncJob;
  if (!session || paused) return;
  const owner = accountKey(session);
  if (getProductivity().syncOwner !== owner) {
    publish('请选择这个账号的数据使用方式');
    return;
  }
  syncJob = (async () => {
    publish('正在同步…');
    const pending = records(getProductivity()).filter(
      (r) => sent.get(`${r.kind}:${r.record_id}`) !== JSON.stringify(r.data),
    );
    for (let i = 0; i < pending.length; i += 100) {
      const response = await cloudClient().rpc('konh_merge_records', {
        incoming: pending.slice(i, i + 100),
      });
      if (response.error) throw response.error;
    }
    const incoming = await pull();
    if (!session || accountKey(session) !== owner)
      throw new Error('账号已改变，同步已停止');
    await mutateProductivity((d) => {
      if (d.syncOwner !== owner) throw new Error('本机数据归属已改变');
      mergeRecords(d, incoming);
    });
    // Remember what was actually sent; edits made during a request remain dirty for the next sync.
    pending.forEach((r) =>
      sent.set(`${r.kind}:${r.record_id}`, JSON.stringify(r.data)),
    );
    if (cloudConfig().calendarEnabled) await syncCalendar();
    publish(`同步完成 · ${new Date().toLocaleTimeString()}`);
  })()
    .catch((e) => {
      publish(`同步失败，数据仍保留在本机：${String(e)}`);
      throw e;
    })
    .finally(() => {
      syncJob = null;
    });
  return syncJob;
}
export async function deleteAccount(wipeLocal: boolean) {
  paused = true;
  try {
    await syncJob?.catch(() => {});
    if (!session) throw new Error('请先登录');
    const user = session.user.id;
    const response = await cloudClient().functions.invoke(
      'konh-delete-account',
      { body: {} },
    );
    if (response.error) throw response.error;
    await secure.removeItem(`google-${user}`);
    await cloudClient().auth.signOut({ scope: 'local' });
    session = null;
    await mutateProductivity((d) => {
      delete d.syncOwner;
      if (wipeLocal) {
        for (const kind of syncedKinds) d[kind] = [];
        d.events = [];
        d.timer = null;
        d.focusRound = 0;
      }
    });
    sent.clear();
    publish('账号已注销');
  } finally {
    paused = false;
  }
}
async function googleToken(): Promise<string> {
  if (!session) throw new Error('请先登录账号');
  const raw = await secure.getItem(`google-${session.user.id}`);
  if (!raw) throw new Error('请点击「授权 Google 日历」');
  const token = JSON.parse(raw) as {
    access: string;
    refresh?: string;
    expires: number;
  };
  if (token.expires > Date.now()) return token.access;
  if (!token.refresh) throw new Error('Google 授权已过期，请重新授权日历');
  const response = await cloudClient().functions.invoke('konh-google-token', {
    body: { refresh_token: token.refresh },
  });
  if (response.error || !response.data?.access_token)
    throw response.error ?? new Error('Google 令牌刷新失败');
  token.access = response.data.access_token;
  token.expires = Date.now() + (response.data.expires_in - 60) * 1000;
  await secure.setItem(`google-${session.user.id}`, JSON.stringify(token));
  return token.access;
}
async function syncCalendar() {
  const { readGoogleResponse, pushGoogleTasks } =
    await import('./googleCalendar');
  const token = await googleToken();
  const user = session!.user.id;
  const config = cloudConfig();
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await cloudFetch(
      `https://www.googleapis.com/calendar/v3/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return readGoogleResponse(response, method);
  };
  const key = `productivity.google-calendar.${user}`;
  let calendarId = getConfig(key);
  if (calendarId) {
    const existing = await request(
      `calendars/${encodeURIComponent(calendarId)}`,
    );
    if (!existing || existing.status === 'cancelled') calendarId = null;
  }
  if (!calendarId) {
    const result = await request('calendars', 'POST', {
      summary: '空核 · 任务',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (!result?.id) throw new Error('Google 未返回新建日历的 ID');
    calendarId = result.id;
    await setConfigDurable(key, calendarId);
  }
  await pushGoogleTasks(request, calendarId!, getProductivity().tasks, config);
}
