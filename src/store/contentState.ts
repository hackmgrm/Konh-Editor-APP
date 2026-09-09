import { getConfig, setConfig } from './appConfig.ts';

const KEY = 'content-state.v1';
const MAX_VERSIONS = 30;
const MAX_PUBLISH_RECORDS = 100;

export type ContentStatus = 'idea' | 'writing' | 'review' | 'scheduled' | 'published';

export interface ArticleVersion {
  id: string;
  createdAt: number;
  content: string;
  label: string;
}

export interface DraftBinding {
  accountId: string;
  mediaId: string;
  articleIndex: number;
  title: string;
  updatedAt: number;
}

export interface PublishRecord {
  id: string;
  articleKey: string;
  accountId: string;
  mediaId: string;
  articleIndex: number;
  title: string;
  action: 'created' | 'updated';
  createdAt: number;
}

export interface ContentState {
  publishedLinks: Record<string, Array<{ accountId: string; url: string; savedAt: number }>>;
  statuses: Record<string, ContentStatus>;
  versions: Record<string, ArticleVersion[]>;
  bindings: Record<string, Record<string, DraftBinding>>;
  publishRecords: PublishRecord[];
}

export const EMPTY_CONTENT_STATE: ContentState = {
  publishedLinks: {},
  statuses: {},
  versions: {},
  bindings: {},
  publishRecords: [],
};

export function articleKey(workspace: string, draftId: string): string {
  return `${workspace.replace(/\/$/, '')}::${draftId}`;
}

export function parseContentState(raw: string | null): ContentState {
  if (!raw) return structuredClone(EMPTY_CONTENT_STATE);
  try {
    const value = JSON.parse(raw) as Partial<ContentState>;
    const bindings: ContentState['bindings'] = {};
    const keep = (key: string, binding: DraftBinding) => {
      const accounts = bindings[key] ??= {};
      if (!accounts[binding.accountId] || accounts[binding.accountId].updatedAt < binding.updatedAt) accounts[binding.accountId] = binding;
    };
    for (const [key, entry] of Object.entries(value.bindings ?? {})) {
      // v1 stored only the last account used for each article.
      if (typeof entry.accountId === 'string') keep(key, entry as unknown as DraftBinding);
      else for (const binding of Object.values(entry)) keep(key, binding);
    }
    for (const record of value.publishRecords ?? []) {
      keep(record.articleKey, { accountId: record.accountId, mediaId: record.mediaId, articleIndex: record.articleIndex, title: record.title, updatedAt: record.createdAt });
    }
    return {
      publishedLinks: value.publishedLinks ?? {},
      statuses: value.statuses ?? {},
      versions: value.versions ?? {},
      bindings,
      publishRecords: value.publishRecords ?? [],
    };
  } catch {
    return structuredClone(EMPTY_CONTENT_STATE);
  }
}

export function loadContentState(): ContentState {
  return parseContentState(getConfig(KEY));
}

export function saveContentState(state: ContentState): void {
  setConfig(KEY, JSON.stringify(state));
}

export function addVersion(
  state: ContentState,
  key: string,
  content: string,
  label = '自动保存',
  now = Date.now(),
): ContentState {
  const current = state.versions[key] ?? [];
  if (current[0]?.content === content) return state;
  const version: ArticleVersion = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, createdAt: now, content, label };
  return { ...state, versions: { ...state.versions, [key]: [version, ...current].slice(0, MAX_VERSIONS) } };
}

export function addPublishRecord(state: ContentState, record: Omit<PublishRecord, 'id'>): ContentState {
  const next = { ...record, id: `${record.createdAt}-${Math.random().toString(36).slice(2, 8)}` };
  const binding: DraftBinding = {
    accountId: record.accountId,
    mediaId: record.mediaId,
    articleIndex: record.articleIndex,
    title: record.title,
    updatedAt: record.createdAt,
  };
  return {
    ...state,
    bindings: { ...state.bindings, [record.articleKey]: { ...state.bindings[record.articleKey], [record.accountId]: binding } },
    publishRecords: [next, ...state.publishRecords].slice(0, MAX_PUBLISH_RECORDS),
  };
}

export function savePublishedLink(state: ContentState, key: string, accountId: string, input: string): ContentState {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port || !(url.pathname === '/s' || url.pathname.startsWith('/s/'))) {
    throw new Error('请输入 https://mp.weixin.qq.com/s 开头的正式文章链接');
  }
  if (!accountId.trim()) throw new Error('请选择公众号账户');
  const links = (state.publishedLinks[key] ?? []).filter(item => item.accountId !== accountId);
  return { ...state, statuses: { ...state.statuses, [key]: 'published' }, publishedLinks: { ...state.publishedLinks, [key]: [...links, { accountId, url: url.href, savedAt: Date.now() }] } };
}
