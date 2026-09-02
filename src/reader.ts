/**
 * Any web page → Markdown, by way of Jina Reader.
 *
 * The hard part of "turn this page into Markdown" was never the Markdown. It is
 * deciding which fifth of the DOM is the article: navigation, sidebars, cookie
 * banners, related-post rails and comment threads all have to go, and on a
 * JavaScript-rendered site none of the article exists at all until a real
 * browser has run the page. Readability heuristics plus a headless Chrome are
 * what that actually takes, and neither belongs inside a desktop editor.
 *
 * So the extraction is rented: r.jina.ai fetches the page, renders it, keeps
 * the article and hands back Markdown. No account, no key — free at 20 requests
 * a minute per address, which is a great many pasted links. A key (Settings →
 * 网页导入) only exists to raise that ceiling.
 *
 * The trade is worth naming plainly, because the WeChat side of this app
 * promises the opposite: **the address you import is visible to jina.ai**.
 * That is all that travels — no credentials, no drafts, nothing about the
 * workspace. Everything downstream stays local: the images are pulled from
 * their own hosts by this machine (see remoteImages.ts), and what lands in the
 * workspace is an ordinary .md file with ordinary image files beside it.
 *
 * One exception, and it is the link this app's users paste most: 公众号文章 go
 * out over this machine's own connection and are converted here, because a
 * hosted reader gets WeChat's verification wall rather than the article. That
 * split is decided in fetchArticle; the local half lives in wechatArticle.ts.
 */

import { fetch } from '@tauri-apps/plugin-http';
import { getConfig, removeConfig, setConfig } from './store/appConfig';
import { dataUrlBytes } from './images';
import { fetchImageAsDataUrl } from './remoteImages';
import { fetchWechatArticle, isWechatArticle } from './wechatArticle';

const ENDPOINT = 'https://r.jina.ai/';
const STORAGE_KEY = 'reader-key';
const STORAGE_IMAGES = 'reader-with-images';

/** How long Reader itself may spend on a slow page, in seconds */
const READER_TIMEOUT = 30;
/** Our own ceiling, generous enough to cover a cold render on the far side */
const REQUEST_TIMEOUT = 90_000;

/** Images pulled into the workspace per import. Beyond this they stay remote —
 *  a gallery page should not quietly write two hundred files */
const MAX_IMAGES = 60;
/** Skip anything absurd: a poster-sized hero image is not worth a copy on disk */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Same as the copy path uses: enough to be quick, polite enough to the host */
const CONCURRENCY = 3;

/* ---------- The optional key ---------- */

export function getReaderKey(): string {
  return getConfig(STORAGE_KEY) ?? '';
}

export function setReaderKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed) setConfig(STORAGE_KEY, trimmed);
  else removeConfig(STORAGE_KEY);
}

/* ---------- The one thing worth remembering between imports ---------- */

/**
 * Whether to pull the images down with the text. On by default, and it lives
 * here rather than in the dialog because most imports never open the dialog:
 * a link on the clipboard goes straight through, and this is what that path
 * has to consult.
 */
export function getImportImages(): boolean {
  return getConfig(STORAGE_IMAGES) !== 'off';
}

export function setImportImages(on: boolean): void {
  setConfig(STORAGE_IMAGES, on ? 'on' : 'off');
}

/* ---------- The address ---------- */

/**
 * Accept what a person actually pastes and hand back a real URL, or null.
 *
 * A bare `example.com/x` is the common case — nobody copies the scheme when
 * they retype an address from memory — so it gets https:// rather than a
 * complaint. Anything that is not http(s) is refused: Reader cannot fetch a
 * file:// or a mailto:, and failing here is clearer than failing over there.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const parse = (candidate: string): URL | null => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };
  const accept = (url: URL | null): string | null =>
    url && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')
      ? url.toString()
      : null;

  const direct = parse(raw);
  if (direct) {
    if (direct.protocol === 'http:' || direct.protocol === 'https:') return accept(direct);
    // A scheme we cannot fetch (mailto:, file:, ftp:) is refused rather than
    // mangled. `example.com:8080/x` parses as a scheme too — a dot in it gives
    // it away as a host and a port, so that one falls through to the retry
    if (!direct.protocol.includes('.')) return null;
  }
  // No scheme at all, which is how an address usually gets retyped
  return accept(parse(`https://${raw}`));
}

/** Host without the www., for the attribution line */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/* ---------- Fetching ---------- */

export interface Article {
  title: string;
  /** The body alone — the title is never repeated inside it */
  markdown: string;
  /** The address that actually answered, after redirects */
  url: string;
  byline: string;
  /** Whatever the page claimed, in whatever shape it claimed it */
  publishedTime: string;
}

/** What each rejection from Reader actually means, in terms the user can act on */
function explainStatus(status: number, hasKey: boolean): string {
  switch (status) {
    case 401:
      return hasKey
        ? 'Jina 的 key 不对，去设置里改一下，或者清空后改用匿名访问。'
        : '你没有填 Jina key。Jina 拒绝了当前网络的匿名请求（通常是出口 IP 信誉限制）；换个网络，或填入 key 后再试。';
    case 402:
      return 'Jina 这个 key 的额度用完了。清空 key 就回到免费额度，或者去 jina.ai 充值。';
    case 429:
      return hasKey
        ? '请求太频繁了，等一会儿再试。'
        : '请求太频繁了（不填 key 是每分钟 20 次）。等一分钟再试，或者去设置里填一个免费 key。';
    case 451:
      return '这个页面拒绝被抓取。';
    case 400:
    case 422:
      return '这个地址抓不出正文 —— 多半是登录墙、付费墙，或者压根不是文章页。';
    default:
      return status >= 500
        ? `Jina 那边出错了（HTTP ${status}），稍后再试。`
        : `抓取失败（HTTP ${status}）。`;
  }
}

/**
 * Ask Reader for one page.
 *
 * POST rather than the documented `r.jina.ai/<url>` form on purpose: the target
 * goes in the body, so a `#`-routed single-page app survives (a fragment never
 * leaves the client when it is part of the request line) and no question of
 * double-encoding a query string arises.
 *
 * 公众号文章 never come through here — WeChat shows a hosted reader its
 * verification wall instead of the article, so those are fetched by this
 * machine and converted locally (see wechatArticle.ts). Which also means the
 * one kind of link this app's users paste most often never leaves for a third
 * party at all.
 */
export async function fetchArticle(url: string, signal?: AbortSignal): Promise<Article> {
  if (isWechatArticle(url)) return await fetchWechatArticle(url, signal);

  const key = getReaderKey();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    // Images are half of an article, and the workspace is a folder that can
    // hold them — so keep them, addresses and all
    'X-Retain-Images': 'all',
    // Resolve relative addresses against the page that actually answered,
    // not the one we asked for
    'X-Base': 'final',
    'X-Timeout': String(READER_TIMEOUT),
  };
  if (key) headers.Authorization = `Bearer ${key}`;

  // Two clocks: the caller's cancel button, and a ceiling of our own so a
  // request that will never answer does not sit in the dialog forever
  const guard = new AbortController();
  const timer = window.setTimeout(() => guard.abort(), REQUEST_TIMEOUT);
  const onAbort = () => guard.abort();
  signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: `url=${encodeURIComponent(url)}`,
      signal: guard.signal,
    });
    // Jina's anonymous edge occasionally rejects one request on network
    // reputation and accepts the documented prefix form immediately after.
    // Keep keyless Reader useful without changing the normal POST path.
    if (res.status === 401 && !key) {
      const retryHeaders = { ...headers };
      delete retryHeaders['Content-Type'];
      res = await fetch(`${ENDPOINT}${url}`, {
        method: 'GET',
        headers: retryHeaders,
        signal: guard.signal,
      });
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('已取消');
    if (guard.signal.aborted) throw new Error('抓取超时了，这个页面可能加载太慢。');
    throw new Error(`连不上 r.jina.ai：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) throw new Error(explainStatus(res.status, Boolean(key)));

  const article = parsePayload(await res.text(), url);
  if (!article.markdown.trim()) {
    throw new Error('抓回来是空的 —— 这个页面多半要登录才看得到正文。');
  }
  return article;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * What the *target* said, which is a separate question from what Reader said.
 *
 * Reader answers 200 with a body either way, so a dead link comes back as a
 * perfectly successful conversion of an error page — a draft titled "404" with
 * somebody's navigation menu in it. It reports the real status alongside, and
 * that is worth refusing on: nothing good is downstream of it.
 */
function explainTargetStatus(status: number): string {
  if (status === 404 || status === 410) return '这个链接打不开了（对方返回 404）。检查一下地址对不对。';
  if (status === 401 || status === 403) return '这个页面要登录才看得到，抓不到正文。';
  if (status === 429) return '对方站点觉得访问太频繁，拒绝了这次抓取。等一会儿再试。';
  if (status >= 500) return `对方站点这会儿有问题（HTTP ${status}），稍后再试。`;
  return `对方站点返回了 HTTP ${status}，没有正文可抓。`;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON — Reader answered in its plain-text shape
    return null;
  }
}

/**
 * Reader answers in JSON when asked to, and in a plain-text shape when
 * something upstream decides otherwise. Both are handled: the field names are
 * theirs, so read them defensively and fall back rather than throwing.
 */
function parsePayload(text: string, requested: string): Article {
  const json = parseJson(text);
  const data = json ? ((json.data ?? json) as Record<string, unknown>) : null;
  if (data) {
    const status = typeof data.httpStatus === 'number' ? data.httpStatus : 0;
    if (status >= 400) throw new Error(explainTargetStatus(status));
    const content = asString(data.content) || asString(data.text);
    if (content) {
      const title = asString(data.title);
      return {
        title,
        markdown: dropRepeatedTitle(tidy(content), title),
        url: asString(data.url) || requested,
        byline: asString(data.byline) || asString(data.author),
        publishedTime: asString(data.publishedTime),
      };
    }
  }
  return fromPlainText(text, requested);
}

/**
 * Reader's plain-text shape puts a few labelled lines in front of the body:
 *
 *   Title: ...
 *   URL Source: ...
 *   Published Time: ...
 *   Markdown Content:
 *   <the article>
 *
 * They are metadata, not prose, so they come off the front rather than into
 * the draft.
 */
function fromPlainText(text: string, requested: string): Article {
  const fields: Record<string, string> = {};
  const lines = text.split('\n');
  let start = 0;
  for (; start < lines.length; start++) {
    const line = lines[start];
    if (/^Markdown Content:\s*$/.test(line)) {
      start++;
      break;
    }
    const match = /^([A-Z][A-Za-z ]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
    else if (line.trim()) break;
  }
  const title = fields['Title'] ?? '';
  return {
    title,
    markdown: dropRepeatedTitle(tidy(lines.slice(start).join('\n')), title),
    url: fields['URL Source'] || requested,
    byline: fields['Author'] ?? '',
    publishedTime: fields['Published Time'] ?? '',
  };
}

/**
 * Scrub the artefacts the extractor leaves behind.
 *
 * None of these are things the page said — they are scaffolding from the
 * conversion, and every one of them is something the user would otherwise
 * delete by hand on the first read-through.
 */
function tidy(markdown: string): string {
  return (
    markdown
      // Reader numbers each image it keeps: `![Image 12: real alt](src)`. The
      // number is its own bookkeeping; the alt text after it is the page's
      .replace(/!\[Image \d+(?::\s*)?/g, '![')
      // An image wrapped in a link, which is how most sites mark up a figure.
      // The link is dead weight here — in a WeChat body it is not even
      // clickable — so keep the picture and drop the wrapper
      .replace(/\[(!\[[^\]]*\]\([^)]*\))\]\([^)]*\)/g, '$1')
      // A line that is only a link with no text, or only the ¶/# a blog engine
      // hangs off each heading and figure as its permalink. Both are furniture
      // of the original page and read as debris once it is a draft
      .replace(/^[ \t]*\[[#¶§]?\]\([^)]*\)[ \t]*$/gm, '')
      // Setext underlines that survived the conversion as bare rules
      .replace(/^[ \t]*[=]{3,}[ \t]*$/gm, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** The title is composed into the file's own H1, so a body that opens by
 *  repeating it would say it twice */
function dropRepeatedTitle(markdown: string, title: string): string {
  if (!title) return markdown;
  const first = markdown.split('\n', 1)[0] ?? '';
  const heading = /^#{1,2}\s+(.*)$/.exec(first);
  if (heading && heading[1].trim() === title.trim()) {
    return markdown.slice(first.length).replace(/^\n+/, '');
  }
  return markdown;
}

/* ---------- Images inside the body ---------- */

/** Split an image destination from the optional title that may follow it */
function splitDest(inner: string): { dest: string; rest: string } {
  const trimmed = inner.trim();
  if (trimmed.startsWith('<')) {
    const close = trimmed.indexOf('>');
    if (close > 0) return { dest: trimmed.slice(1, close), rest: trimmed.slice(close + 1).trim() };
  }
  const space = trimmed.search(/\s/);
  if (space < 0) return { dest: trimmed, rest: '' };
  return { dest: trimmed.slice(0, space), rest: trimmed.slice(space).trim() };
}

/**
 * Walk every native-syntax image in a body, handing each destination to `fn`;
 * a string replaces it, null leaves it as it was.
 *
 * Scanned rather than matched with one regular expression, for the same reason
 * markdown.ts scans: image addresses contain parentheses often enough
 * (Wikipedia alone guarantees it) that a non-greedy `\(([^)]*)\)` mangles them.
 * Balancing the parens costs twenty lines and gets those right.
 */
function mapImageDests(markdown: string, fn: (dest: string) => string | null): string {
  let out = '';
  let i = 0;
  while (i < markdown.length) {
    const bang = markdown.indexOf('![', i);
    if (bang < 0) break;
    // `![[name]]` is the Obsidian embed, which has no destination to rewrite
    if (markdown.charCodeAt(bang + 2) === 0x5b /* [ */) {
      out += markdown.slice(i, bang + 2);
      i = bang + 2;
      continue;
    }
    const labelEnd = markdown.indexOf(']', bang + 2);
    if (labelEnd < 0) break;
    if (markdown.charCodeAt(labelEnd + 1) !== 0x28 /* ( */) {
      out += markdown.slice(i, labelEnd + 1);
      i = labelEnd + 1;
      continue;
    }
    let depth = 0;
    let j = labelEnd + 1;
    for (; j < markdown.length; j++) {
      const c = markdown[j];
      if (c === '\n') break;
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (depth !== 0 || j >= markdown.length) {
      out += markdown.slice(i, labelEnd + 1);
      i = labelEnd + 1;
      continue;
    }
    const { dest, rest } = splitDest(markdown.slice(labelEnd + 2, j));
    const replaced = fn(dest);
    out += markdown.slice(i, labelEnd + 2) + (replaced ?? dest) + (rest ? ` ${rest}` : '') + ')';
    i = j + 1;
  }
  return out + markdown.slice(i);
}

/** Every distinct remote image the body points at, in the order it points at them */
export function remoteImagesIn(markdown: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  mapImageDests(markdown, (dest) => {
    if (/^https?:\/\//i.test(dest) && !seen.has(dest)) {
      seen.add(dest);
      found.push(dest);
    }
    return null;
  });
  return found;
}

/** Point the body at the copies now sitting in the workspace */
function localizeImages(markdown: string, saved: Map<string, string>): string {
  return mapImageDests(markdown, (dest) => saved.get(dest) ?? null);
}

/* ---------- Naming what lands on disk ---------- */

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

function extensionOf(dataUrl: string): string {
  const mime = dataUrl.slice(5, dataUrl.indexOf(';')).toLowerCase();
  return EXTENSIONS[mime] ?? 'jpg';
}

/**
 * Name an imported image after the piece it came from.
 *
 * `images/` is one flat folder shared by every draft in the workspace, so
 * `image-1.jpg` from two different articles is a collision waiting to happen —
 * and image_write overwrites rather than complaining. Leading with a slug of
 * the title keeps a batch together in the listing, keeps it recognizable a
 * month later, and makes the collision rare; `taken` closes the rest.
 */
function nameImage(title: string, index: number, dataUrl: string, taken: Set<string>): string {
  const cut = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 24);
  // Truncating an English title lands mid-word; back up to the last separator
  // when there is still enough left to recognize
  const lastBreak = cut.lastIndexOf('-');
  const slug = (lastBreak >= 8 ? cut.slice(0, lastBreak) : cut) || 'web';
  const ext = extensionOf(dataUrl);
  let name = `${slug}-${index}.${ext}`;
  let n = 2;
  while (taken.has(name)) name = `${slug}-${index}-${n++}.${ext}`;
  taken.add(name);
  return name;
}

/* ---------- The whole import ---------- */

export interface ImportOptions {
  /** Pull the images into the workspace, rather than leaving them as addresses */
  withImages: boolean;
  /** Store one image, returning its workspace-relative path (see useVault) */
  addImage: (name: string, dataUrl: string) => Promise<string | null>;
  /** Image file names already in use, so one import cannot overwrite another */
  taken: Set<string>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ImportResult {
  title: string;
  /** The finished file: heading, attribution, body */
  markdown: string;
  /** Images now sitting in the workspace */
  saved: number;
  /** Images left as addresses, because their host would not hand them over */
  missed: number;
}

/**
 * Fetch a page and assemble the draft it becomes.
 *
 * The images are deliberately stored as they came: the publish path already
 * re-encodes on the way to WeChat (see wechat.ts), and doing it twice only
 * costs quality. The one thing checked here is that they are not absurd.
 *
 * An image the host refuses is left as a remote address rather than failing the
 * import — the same call the copy path makes. A body with one broken picture is
 * worth having; nothing at all is not.
 */
export async function importArticle(url: string, opts: ImportOptions): Promise<ImportResult> {
  const article = await fetchArticle(url, opts.signal);
  let body = article.markdown;
  let saved = 0;
  let missed = 0;

  if (opts.withImages) {
    const targets = remoteImagesIn(body);
    const batch = targets.slice(0, MAX_IMAGES);
    missed = targets.length - batch.length;
    const stored = new Map<string, string>();
    let done = 0;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= batch.length || opts.signal?.aborted) return;
        const src = batch[index];
        const dataUrl = await fetchImageAsDataUrl(src);
        if (dataUrl && dataUrlBytes(dataUrl) <= MAX_IMAGE_BYTES) {
          const name = nameImage(article.title, index + 1, dataUrl, opts.taken);
          try {
            const path = await opts.addImage(name, dataUrl);
            if (path) stored.set(src, path);
            else missed++;
          } catch (err) {
            console.warn('导入图片写盘失败', src, err);
            missed++;
          }
        } else {
          missed++;
        }
        opts.onProgress?.(++done, batch.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));

    if (opts.signal?.aborted) throw new Error('已取消');
    saved = stored.size;
    body = localizeImages(body, stored);
  }

  return { title: article.title, markdown: compose(article, body), saved, missed };
}

/**
 * Heading, one line of attribution, body.
 *
 * The attribution is a quote rather than a comment because it should be visible
 * in the preview: an imported piece is somebody else's work until it has been
 * rewritten, and the line saying so is one keystroke to delete once it has.
 */
function compose(article: Article, body: string): string {
  const parts: string[] = [];
  if (article.title) parts.push(`# ${article.title}`);
  const credit = [
    `来源：[${hostOf(article.url)}](${article.url})`,
    article.byline,
    article.publishedTime.slice(0, 10),
  ].filter(Boolean);
  parts.push(`> ${credit.join(' · ')}`);
  parts.push(body);
  return `${parts.join('\n\n')}\n`;
}
