import { invoke } from '@tauri-apps/api/core';
import { getConfig, setConfig } from './store/appConfig.ts';

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

export interface CloudinaryUpload {
  secureUrl: string;
  publicId: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

interface CachedUpload extends CloudinaryUpload { hash: string }

const CONFIG_KEYS = {
  cloudName: 'cloudinary.cloudName',
  apiKey: 'cloudinary.apiKey',
  apiSecret: 'cloudinary.apiSecret',
  folder: 'cloudinary.folder',
} as const;
const CACHE_KEY = 'cloudinary.uploadCache';

export function getCloudinaryConfig(): CloudinaryConfig {
  return {
    cloudName: getConfig(CONFIG_KEYS.cloudName) ?? '',
    apiKey: getConfig(CONFIG_KEYS.apiKey) ?? '',
    apiSecret: getConfig(CONFIG_KEYS.apiSecret) ?? '',
    folder: getConfig(CONFIG_KEYS.folder) ?? 'konh-editor/articles',
  };
}

export function setCloudinaryConfig(patch: Partial<CloudinaryConfig>): void {
  for (const [key, value] of Object.entries(patch) as Array<[keyof CloudinaryConfig, string]>) {
    setConfig(CONFIG_KEYS[key], value.trim());
  }
}

export function cloudinaryReady(config = getCloudinaryConfig()): boolean {
  return Boolean(config.cloudName && config.apiKey && config.apiSecret);
}

export function testCloudinary(): Promise<string> {
  return invoke<string>('cloudinary_test');
}

function cache(): Record<string, CachedUpload> {
  try { return JSON.parse(getConfig(CACHE_KEY) ?? '{}') as Record<string, CachedUpload>; }
  catch { return {}; }
}

async function digest(dataUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function uploadCloudinaryImage(path: string, dataUrl: string, folder: string): Promise<CloudinaryUpload & { cached: boolean }> {
  const hash = await digest(dataUrl);
  const known = cache();
  const prior = known[hash];
  if (prior) return { ...prior, cached: true };
  const filename = path.split('/').pop() ?? 'image';
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 48) || 'image';
  const result = await invoke<CloudinaryUpload>('cloudinary_upload', {
    dataUrl,
    filename,
    publicId: `${stem}-${hash.slice(0, 10)}`,
    folder,
  });
  known[hash] = { ...result, hash };
  setConfig(CACHE_KEY, JSON.stringify(known));
  return { ...result, cached: false };
}

/** Local image refs used by the current Markdown, resolved against vault images. */
export function articleLocalImages(markdown: string, images: Record<string, string>): string[] {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) refs.add(match[1].trim());
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    if (!/^(?:https?:|data:)/i.test(match[1])) refs.add(match[1].replace(/^\.\//, ''));
  }
  return Object.keys(images).filter((path) => refs.has(path) || refs.has(path.split('/').pop() ?? path));
}

export function replaceArticleImages(markdown: string, urls: Record<string, string>): string {
  const lookup = (ref: string) => urls[ref] ?? Object.entries(urls).find(([path]) => path.split('/').pop() === ref.split('/').pop())?.[1];
  let next = markdown.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (whole, ref: string, alt?: string) => {
    const url = lookup(ref.trim());
    return url ? `![${alt?.trim() ?? ref.trim()}](${url})` : whole;
  });
  next = next.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g, (whole, alt: string, ref: string, title = '') => {
    const url = lookup(ref.replace(/^\.\//, ''));
    return url ? `![${alt}](${url}${title})` : whole;
  });
  return next;
}
