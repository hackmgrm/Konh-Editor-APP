import { invoke } from '@tauri-apps/api/core';
import { fetchImageAsDataUrl } from './remoteImages';

export interface ArticleArtifact {
  id: string;
  kind: 'publish' | 'layout';
  articleKey: string;
  title: string;
  createdAt: number;
  markdown: string;
  html: string;
  submittedHtml: string;
  originalMarkdown?: string;
  originalHtml?: string;
  assets: Array<{ name: string; dataUrl: string }>;
}
export interface ArtifactSummary {
  id: string; kind: 'publish' | 'layout'; articleKey: string; title: string; createdAt: number; bytes: number;
}

/** Freeze every image, including WeChat CDN images, before preparing an artifact. */
export async function freezeArticleHtml(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const resolved = new Map<string, string>();
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('data:image/')) continue;
    if (!/^https?:\/\//i.test(src)) throw new Error('正文包含无法保存的图片，请检查图片地址');
    let data = resolved.get(src);
    if (!data) {
      data = await fetchImageAsDataUrl(src) ?? undefined;
      if (!data) throw new Error(`图片无法保存到快照：${img.alt || src}`);
      resolved.set(src, data);
    }
    img.setAttribute('src', data);
    img.removeAttribute('srcset');
  }
  return doc.body.innerHTML;
}

export function packageArtifact(input: Omit<ArticleArtifact, 'assets'>, frozenHtml = input.html, cover?: string): ArticleArtifact {
  const doc = new DOMParser().parseFromString(input.html, 'text/html');
  const frozen = new DOMParser().parseFromString(frozenHtml, 'text/html');
  const images = Array.from(doc.querySelectorAll('img'));
  const sources = Array.from(frozen.querySelectorAll('img'));
  if (images.length !== sources.length) throw new Error('发布图片与快照不一致，请重新排版');
  const assets: ArticleArtifact['assets'] = [];
  const seen = new Map<string, string>();
  const add = (dataUrl: string) => {
    if (!dataUrl.startsWith('data:image/')) throw new Error('快照图片尚未固定');
    const existing = seen.get(dataUrl);
    if (existing) return existing;
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp' } as Record<string, string>)[mime];
    if (!ext) throw new Error(`不支持的快照图片类型：${mime}`);
    const name = `${assets.length + 1}.${ext}`;
    assets.push({ name, dataUrl }); seen.set(dataUrl, name);
    return name;
  };
  images.forEach((img, index) => { img.setAttribute('src', `assets/${add(sources[index].getAttribute('src') ?? '')}`); img.removeAttribute('srcset'); });
  if (cover) {
    const section = doc.createElement('section');
    section.setAttribute('data-snapshot-cover', 'true');
    const label = doc.createElement('p'); label.textContent = '封面'; section.append(label);
    const image = doc.createElement('img'); image.setAttribute('src', `assets/${add(cover)}`); image.alt = '本次推送封面'; section.append(image);
    doc.body.prepend(section);
  }
  const original = new DOMParser().parseFromString(input.originalHtml ?? '', 'text/html');
  for (const img of Array.from(original.querySelectorAll('img'))) {
    img.setAttribute('src', `assets/${add(img.getAttribute('src') ?? '')}`);
    img.removeAttribute('srcset');
  }
  return { ...input, html: doc.body.innerHTML, originalHtml: original.body.innerHTML, assets };
}
export function artifactBody(artifact: ArticleArtifact, original = false): string {
  const doc = new DOMParser().parseFromString(original ? artifact.originalHtml ?? '' : artifact.html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const asset = artifact.assets.find(item => `assets/${item.name}` === img.getAttribute('src'));
    if (!asset) throw new Error('快照缺少图片文件');
    img.setAttribute('src', asset.dataUrl);
  }
  return doc.body.innerHTML;
}
export function artifactDocument(artifact: ArticleArtifact, original = false): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><style>body{margin:0 auto;padding:24px;max-width:720px;font:16px/1.8 system-ui;background:#fff;color:#222}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}[data-snapshot-cover]{border-bottom:1px solid #ddd;margin-bottom:24px}</style><body>${artifactBody(artifact, original)}</body></html>`;
}
export const saveArtifact = (artifact: ArticleArtifact) => invoke<void>('artifact_save', { artifact });
export const readArtifact = (id: string) => invoke<ArticleArtifact>('artifact_read', { id });
export const listArtifacts = (articleKey: string) => invoke<ArtifactSummary[]>('artifact_list', { articleKey });
export const deleteArtifact = (id: string) => invoke<void>('artifact_delete', { id });
