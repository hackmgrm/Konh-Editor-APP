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
  statuses: Record<string, ContentStatus>;
  versions: Record<string, ArticleVersion[]>;
  bindings: Record<string, DraftBinding>;
  publishRecords: PublishRecord[];
}

export const EMPTY_CONTENT_STATE: ContentState = {
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
    return {
      statuses: value.statuses ?? {},
      versions: value.versions ?? {},
      bindings: value.bindings ?? {},
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
    bindings: { ...state.bindings, [record.articleKey]: binding },
    publishRecords: [next, ...state.publishRecords].slice(0, MAX_PUBLISH_RECORDS),
  };
}
