/**
 * WeChat Official Account API client.
 *
 * Pushing a draft needs three things: swap the body images, upload a cover,
 * create the draft.
 * Swapping images is not only about making them display — an image pasted into
 * WeChat gets compressed when WeChat re-hosts it, visibly so, whereas an image
 * uploaded through the API into WeChat's media library and referenced from the
 * body by its mmbiz.qpic.cn address is left alone.
 *
 * The desktop build talks to WeChat directly, with the request going out from
 * Rust (see wechatTransport.ts): there is no CORS to work around, and the
 * AppSecret passes through no third party — it goes from this machine to WeChat.
 * Credentials live in the app config directory, never in the workspace, which
 * is a directory meant to be committed to git.
 */

import { fitDataUrl, fitKeepingSize, measureDataUrl } from './images';
import { measureRemoteImage } from './remoteImages';
import { getConfig, removeConfig, setConfig } from './store/appConfig';
import { callWechat } from './wechatTransport';

const STORAGE_CONFIG = 'wechat';
const STORAGE_TOKEN = 'wechat-token';
/** Image dedupe table: content fingerprint → WeChat CDN address, so the same
 *  image is never uploaded twice */
const STORAGE_UPLOADED = 'wechat-uploads';

/**
 * Body images go through material/add_material (permanent media), which allows
 * 10MB.
 *
 * The documentation recommends media/uploadimg for body images, but that
 * endpoint is hard-capped at 1MB — a 1920px screenshot has to be re-encoded as
 * JPEG to fit. Permanent media has 10MB and usually uploads untouched, with no
 * re-encoding at all.
 *
 * Both routes were compared side by side inside one article (the "route
 * comparison" button in the dialog *is* that experiment), and **permanent media
 * is visibly sharper**. WeChat normalizes body images to /640 (about 1080 wide)
 * either way, but the one generated from a lossless source is cleaner than the
 * one generated from a q0.85 JPEG.
 *
 * The cost is media-library quota (a 100,000-image ceiling). Caching by content
 * fingerprint means each image is uploaded once.
 */
const MAX_MATERIAL_BYTES = 10 * 1024 * 1024;
/** The article-image endpoint's limit; only the "route comparison" experiment
 *  still uses it */
const MAX_UPLOAD_BYTES = 1024 * 1024;

/**
 * The WeChat developer console — AppID, AppSecret and the API IP allow-list are
 * all configured here, under 我的业务 → 公众号.
 *
 * It is the console's own landing address with the business tab preselected.
 * The tidier-looking /console/product/mp/ does not open: it 404s unless you
 * arrive from inside the console, so anyone following it lands nowhere.
 *
 * Several places in the UI point at this one address, so nobody has to go
 * looking for it twice.
 */
export const DEV_PROFILE_URL = 'https://developers.weixin.qq.com/console/index?tab1=business&tab2=dev';

export interface WechatConfig {
  appid: string;
  secret: string;
  /** Default author on a draft */
  author: string;
  /** Source URL (optional, shown as "read the original") */
  sourceUrl: string;
  /** Whether comments are open */
  openComment: boolean;
}

export const DEFAULT_CONFIG: WechatConfig = {
  appid: '',
  secret: '',
  author: '',
  sourceUrl: '',
  openComment: true,
};

export function loadConfig(): WechatConfig {
  try {
    const raw = getConfig(STORAGE_CONFIG);
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<WechatConfig>) };
  } catch {
    // Corrupt: fall back to the defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg: WechatConfig): void {
  try {
    setConfig(STORAGE_CONFIG, JSON.stringify(cfg));
  } catch {
    // Failing to store it does not affect this session
  }
}

export function isConfigured(cfg: WechatConfig): boolean {
  return Boolean(cfg.appid.trim() && cfg.secret.trim());
}

/* ---------------- Error messages ---------------- */

const ERRMSG: Record<number, string> = {
  [-1]: '微信服务端繁忙，稍后重试',
  40001: 'AppSecret 不对，或这个 AppID 不是公众号的',
  40013: 'AppID 不合法',
  40164: '出口 IP 不在白名单里 —— 白名单是强制的，必须把下面这个 IP 填进控制台',
  40007: '素材 media_id 不合法',
  53400: '草稿内容不合法：标题、正文或封面为空',
  53401: '草稿内容含敏感信息，被微信拦下',
  53404: '账号已被限制发布能力',
  41001: '缺少 access_token',
  42001: 'access_token 已过期，重试一次即可',
  45009: '接口调用超过频率限制，等一会儿再试',
  48001: '微信说这个号没有该接口权限。下面是它的原话，拿这段去搜或问客服比我的猜测靠谱',
};

/**
 * A 40164 response carries the rejected IP inside it, in the form
 * `invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4, not in whitelist`。
 * Digging it straight out saves the user the "go look up your IP" step.
 */
export function extractBlockedIp(errmsg: string): string | null {
  const m = errmsg.match(/invalid ip ([0-9.]+)/i);
  return m ? m[1] : null;
}

export class WechatError extends Error {
  readonly blockedIp: string | null;
  /** WeChat's raw errmsg, not one character changed */
  readonly raw: string;

  constructor(readonly errcode: number, errmsg: string) {
    const ip = extractBlockedIp(errmsg);
    const hint = ERRMSG[errcode];
    // A translation only ever adds; it never replaces. Swallowing WeChat's own
    // wording and substituting our guess would leave the user with nothing exact
    // to search for, and no way to tell when our guess is wrong.

    const parts = [hint ?? '微信返回了一个错误'];
    if (errcode === 40164 && ip) parts[0] += `：${ip}`;
    parts.push(`[errcode ${errcode}] ${errmsg}`);
    super(parts.join('\n'));
    this.name = 'WechatError';
    this.blockedIp = ip;
    this.raw = errmsg;
  }
}

/* ---------------- Base calls ---------------- */

interface WxResponse {
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

async function call(_cfg: WechatConfig, route: string, body: Record<string, unknown>): Promise<WxResponse> {
  let data: WxResponse;
  try {
    data = await callWechat(route, body);
  } catch (err) {
    // Essentially the only things that throw here are a dead network or DNS;
    // WeChat's own errors all arrive inside errcode
    throw new Error(err instanceof Error ? `连不上微信接口：${err.message}` : '连不上微信接口');
  }
  // On success WeChat either omits errcode or sets it to 0
  if (typeof data.errcode === 'number' && data.errcode !== 0) {
    throw new WechatError(data.errcode, String(data.errmsg ?? ''));
  }
  return data;
}

/* ---------------- access_token ---------------- */

interface CachedToken {
  appid: string;
  token: string;
  /** Expiry timestamp (already pulled back by five minutes) */
  expiresAt: number;
}

function readCachedToken(appid: string): string | null {
  try {
    const raw = getConfig(STORAGE_TOKEN);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedToken;
    if (cached.appid === appid && cached.expiresAt > Date.now()) return cached.token;
  } catch {
    // A corrupt cache just means fetching again
  }
  return null;
}

export async function getAccessToken(cfg: WechatConfig): Promise<string> {
  const cached = readCachedToken(cfg.appid);
  if (cached) return cached;
  const data = await call(cfg, 'token', { appid: cfg.appid.trim(), secret: cfg.secret.trim() });
  const token = String(data.access_token ?? '');
  if (!token) throw new Error('没拿到 access_token');
  const ttl = Number(data.expires_in ?? 7200);
  try {
    setConfig(
      STORAGE_TOKEN,
      JSON.stringify({ appid: cfg.appid, token, expiresAt: Date.now() + Math.max(60, ttl - 300) * 1000 } satisfies CachedToken),
    );
  } catch {
    // Failing to cache costs one extra API call
  }
  return token;
}

/** Changed credentials invalidate the cached token */
export function clearToken(): void {
  removeConfig(STORAGE_TOKEN);
}

/**
 * Clear the image upload cache.
 *
 * The cache records "I have uploaded this image, here are its address and
 * media_id", but it has no way to know you deleted that asset in the WeChat
 * console — once deleted, the media_id is a bad cheque (40007) and the url
 * becomes a broken image.
 * Hitting that case throws the whole cache away and re-uploads, which is
 * clearer than leaving the user to guess.
 */
export function clearUploadCache(): void {
  removeConfig(STORAGE_UPLOADED);
}

/* ---------------- Self-check ---------------- */

export interface ConnectionCheck {
  /** Whether the account has media / drafts API permission — without it, the
   *  whole push path is a dead end */
  canPublish: boolean;
  message: string;
}

/**
 * Self-check: fetch a token first (are the credentials right), then probe the
 * drafts endpoint (does the account have permission).
 *
 * Splitting it in two matters: any Official Account can obtain an access_token,
 * so testing only that gives a false sense that everything is fine, right up
 * until an actual push hits 48001. The probe is aimed at draft/count — same
 * endpoint group as pushing a draft, read-only and side-effect free, which
 * makes it the right indicator (an earlier version probed media management,
 * a different group, so its verdict did not mean anything).
 *
 * Credential errors throw as usual; only "credentials fine but no permission"
 * returns normally, because that is a verdict for the user to act on rather
 * than an error.
 */
export async function testConnection(cfg: WechatConfig): Promise<ConnectionCheck> {
  clearToken();
  const token = await getAccessToken(cfg);
  try {
    const data = await call(cfg, 'probe', { access_token: token });
    const drafts = Number(data.total_count ?? 0);
    return { canPublish: true, message: `连接正常，草稿箱接口可用（草稿箱现有 ${drafts} 篇）` };
  } catch (err) {
    if (err instanceof WechatError && err.errcode === 48001) {
      return {
        canPublish: false,
        message: `凭据没问题，但草稿箱接口调不了。微信原话：\n${err.raw}`,
      };
    }
    throw err;
  }
}

/**
 * Ask for the egress IP — the address WeChat sees, which is what goes on the
 * allow-list, not whatever the machine calls its own IP.
 * A false `stable` means that address can change, and an allow-list entry for
 * it would then work only intermittently.
 */
export async function getEgressIp(cfg: WechatConfig): Promise<{ ip: string; stable: boolean }> {
  const data = await call(cfg, 'whoami', {});
  return { ip: String(data.ip ?? ''), stable: Boolean(data.stable) };
}

/* ---------------- Image upload ---------------- */

/**
 * Upload-strategy version.
 *
 * The cache keys on image content only, not on how we encoded it — so after a
 * change to the compression strategy, an old image's fingerprint is unchanged,
 * the cache hits, and the new logic never runs once. What that looks like is
 * "did you actually change anything? mine still looks the same".
 * Folding a version into the fingerprint fixes it: bump this when the upload
 * encoding changes, and old records expire and re-upload on their own.
 *
 * v5: body images moved to permanent media (10MB, usually uploaded untouched) —
 *     sharper than the article endpoint in a same-article side-by-side
 * v4: never reduce dimensions under any circumstances (v3 added a
 *     downscale-to-stay-lossless step for PNG; measured, it was blurrier, and
 *     it has been withdrawn)
 */
const UPLOAD_POLICY_VERSION = 5;

/** Content fingerprint: the same image used across several drafts is still
 *  uploaded once */
async function fingerprint(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`v${UPLOAD_POLICY_VERSION}:${source}`));
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface CachedUpload {
  url: string;
  /** Only cover assets have one — body images go through uploadimg, which
   *  returns no media_id */
  mediaId?: string;
}

function readUploadCache(): Record<string, CachedUpload> {
  try {
    const raw = JSON.parse(getConfig(STORAGE_UPLOADED) ?? '{}') as Record<string, unknown>;
    const out: Record<string, CachedUpload> = {};
    for (const [k, v] of Object.entries(raw)) {
      // Older versions stored only the url string; accept those but treat the
      // media_id as absent (a cover gets uploaded separately)
      if (typeof v === 'string') out[k] = { url: v };
      else if (v && typeof v === 'object') out[k] = v as CachedUpload;
    }
    return out;
  } catch {
    return {};
  }
}

function writeUploadCache(map: Record<string, CachedUpload>): void {
  try {
    setConfig(STORAGE_UPLOADED, JSON.stringify(map));
  } catch {
    // A cache that will not write is treated as absent; the worst case is re-uploading
  }
}

type ImageSource = { dataUrl: string } | { url: string };

/** Upload one image and return its WeChat CDN address */
interface Uploaded {
  url: string;
  /** Permanent media returns the media_id in the same call — a cover can reuse
   *  it directly, saving one upload */
  mediaId: string;
  measured: { w: number; h: number; bytes: number } | null;
}

async function uploadOne(
  cfg: WechatConfig,
  token: string,
  source: ImageSource,
  filename: string,
): Promise<Uploaded> {
  const key = await fingerprint('dataUrl' in source ? source.dataUrl : source.url);
  const cache = readUploadCache();
  const hit = cache[key];
  // The cache may hold an address stored by an earlier version, without
  // from=appmsg; patch it on the way out
  if (hit) return { url: articleImageUrl(hit.url), mediaId: hit.mediaId ?? '', measured: null };

  let measured: { w: number; h: number; bytes: number } | null = null;
  let payload: ImageSource = source;
  if ('dataUrl' in source) {
    // Under a 10MB budget this passes through essentially untouched; fitDataUrl
    // only intervenes on a wrong format or a genuine overage
    const fitted = await fitDataUrl(source.dataUrl, MAX_MATERIAL_BYTES);
    payload = { dataUrl: fitted };
    // Measure what actually went out — "the image is still soft" has to be
    // checkable against numbers, not against a feeling
    measured = await measureDataUrl(fitted);
    const untouched = fitted === source.dataUrl ? '，原样未重编码' : '';
    console.info(
      `[正文图] ${filename} → ${measured.w}×${measured.h}，${Math.round(measured.bytes / 1024)}KB${untouched}`,
    );
  }

  const data = await call(cfg, 'material', { access_token: token, ...payload, filename });
  const raw = String(data.url ?? '');
  if (!raw) throw new Error('上传成功但没返回图片地址');
  const url = articleImageUrl(raw);
  const mediaId = String(data.media_id ?? '');
  cache[key] = { url, mediaId };
  writeUploadCache(cache);
  return { url, mediaId, measured };
}

/**
 * Shape the returned address into what a *body image* address should look like.
 *
 * Comparing two tags is what made this clear. An image inserted by hand from
 * the media library has the address
 *   .../0?wx_fmt=png&from=appmsg      → WeChat leaves it alone, sharp
 * while the one we embedded
 *   .../0?wx_fmt=png                  → WeChat rewrites it to /640, measured at
 *                                        1080 wide, soft
 *
 * `from=appmsg` is the marker for "this image belongs to an article body".
 * With it, WeChat leaves the size segment alone; without it, the image counts
 * as external and gets normalized to /640. The trailing /0 is the
 * original-size segment and must not be dropped either.
 *
 * It also upgrades http to https — WeChat returns http, while the article page
 * is served over https.
 */
function articleImageUrl(raw: string): string {
  const https = raw.replace(/^http:\/\//i, 'https://');
  if (/[?&]from=appmsg\b/i.test(https)) return https;
  return `${https}${https.includes('?') ? '&' : '?'}from=appmsg`;
}

/** Already on WeChat's CDN: no need to upload again */
function isWechatCdn(src: string): boolean {
  return /^https?:\/\/mmbiz\.(qpic|qlogo)\.cn\//i.test(src);
}

/** Give an uploaded image a file name, preferring its alt text */
function imageName(alt: string, index: number): string {
  const base = alt.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40);
  return base || `image-${index + 1}`;
}

export interface UploadResult {
  html: string;
  /** How many images were swapped for WeChat addresses */
  uploaded: number;
  /** The smallest long edge among them — the first number to check when
   *  something looks soft */
  smallestEdge: number | null;
  /** media_id of the first body image, usable directly as the cover: it saves
   *  an upload and leaves no duplicate in the media library */
  firstMediaId: string | null;
  /**
   * The first image's "what we sent vs what WeChat stored" comparison.
   * A mismatch means WeChat compressed it while re-hosting, independent of any
   * local setting — which is the only evidence that settles the question.
   */
  roundTrip: {
    sent: { w: number; h: number; bytes: number };
    stored: { w: number; h: number; bytes: number };
    /** The /640 size the body actually renders — the one readers see */
    rendered: { w: number; h: number; bytes: number } | null;
    /** The address the body actually references */
    url: string;
  } | null;
}

/**
 * Replace every image in the body HTML with a WeChat CDN address.
 *
 * Not one may be missed: the drafts documentation states that image URLs must
 * come from the "get URL for an image inside an article" endpoint, and that
 * **external image URLs will be filtered out** — so an image that fails to
 * upload does not degrade into a remote link, it is swallowed by WeChat and
 * that spot in the draft is simply empty, which you discover only after
 * publishing. Any single failure therefore aborts, and the draft is not sent.
 */
export async function uploadArticleImages(
  cfg: WechatConfig,
  token: string,
  html: string,
  onProgress?: (done: number, total: number) => void,
): Promise<UploadResult> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  const targets = imgs
    .map((img, i) => ({ img, src: img.getAttribute('src') ?? '', name: imageName(img.getAttribute('alt') ?? '', i) }))
    .filter((t) => t.src && !isWechatCdn(t.src));
  if (!targets.length)
    return { html, uploaded: 0, smallestEdge: null, firstMediaId: null, roundTrip: null };

  /*
   * Only src is replaced; data-w / data-ratio / class are no longer added.
   *
   * Matching what the editor emits was tried and measured useless: the drafts
   * API strips them all. Push and read back, and an <img> retains exactly three
   * things — alt, data-src and style (src has become data-src, and the address
   * has been normalized from /0 to /640). Since none of it survives, there is
   * no point carrying it.
   */
  const resolved = new Map<string, string>();
  let done = 0;
  let smallestEdge: number | null = null;
  let firstMediaId: string | null = null;
  let roundTrip: UploadResult['roundTrip'] = null;
  // Serial uploads: the WeChat endpoints are rate limited, and going parallel
  // runs straight into 45009
  for (const t of targets) {
    if (!resolved.has(t.src)) {
      try {
        const source: ImageSource = t.src.startsWith('data:') ? { dataUrl: t.src } : { url: t.src };
        const { url, mediaId, measured } = await uploadOne(cfg, token, source, t.name);
        resolved.set(t.src, url);
        if (!firstMediaId && mediaId) firstMediaId = mediaId;
        // Checking the first image is enough to settle it; no need to fetch
        // every one back
        if (measured && !roundTrip) {
          const stored = await measureRemoteImage(url);
          // The body actually renders the /640 size, not the /0 we embedded.
          // An earlier version measured only /0 and reported "WeChat did not
          // touch this image", which was misleading — that is not the size
          // readers see.

          const rendered = await measureRemoteImage(url.replace(/\/0(\?|$)/, '/640$1'));
          if (stored) {
            roundTrip = { sent: measured, stored, rendered, url };
            console.info(
              `[核对] 传出 ${measured.w}×${measured.h} ${Math.round(measured.bytes / 1024)}KB` +
                ` → /0 存 ${stored.w}×${stored.h} ${Math.round(stored.bytes / 1024)}KB` +
                (rendered ? ` → 正文用的 /640 出 ${rendered.w}×${rendered.h} ${Math.round(rendered.bytes / 1024)}KB` : ''),
            );
          }
        }
        if (measured) {
          const edge = Math.max(measured.w, measured.h);
          smallestEdge = smallestEdge === null ? edge : Math.min(smallestEdge, edge);
        }
      } catch (err) {
        if (err instanceof WechatError) throw err;
        throw new Error(`图片「${t.name}」上传失败：${err instanceof Error ? err.message : '未知原因'}`);
      }
    }
    t.img.setAttribute('src', resolved.get(t.src)!);
    onProgress?.(++done, targets.length);
  }
  return { html: doc.body.innerHTML, uploaded: resolved.size, smallestEdge, firstMediaId, roundTrip };
}

/* ---------------- Cover and draft ---------------- */

export type ImageSourceInput = { dataUrl: string } | { url: string };

/** Upload a cover as permanent media — the drafts API's thumb_media_id accepts
 *  nothing else */
/**
 * Upload one image directly to permanent media, returning its media_id and
 * address. Bypasses the cache — the comparison experiment wants fresh results.
 */
export async function uploadMaterialImage(
  cfg: WechatConfig,
  token: string,
  dataUrl: string,
  filename: string,
): Promise<{ mediaId: string; url: string }> {
  const payload = await fitDataUrl(dataUrl, MAX_MATERIAL_BYTES);
  const data = await call(cfg, 'material', { access_token: token, dataUrl: payload, filename });
  return { mediaId: String(data.media_id ?? ''), url: articleImageUrl(String(data.url ?? '')) };
}

/** Upload one image through the article endpoint, returning a body-usable
 *  address. Bypasses the cache. */
export async function uploadArticleImageOnce(
  cfg: WechatConfig,
  token: string,
  dataUrl: string,
  filename: string,
): Promise<string> {
  const fitted = (await fitKeepingSize(dataUrl, MAX_UPLOAD_BYTES)) ?? (await fitDataUrl(dataUrl, MAX_UPLOAD_BYTES));
  const data = await call(cfg, 'uploadimg', { access_token: token, dataUrl: fitted, filename });
  return articleImageUrl(String(data.url ?? ''));
}

export async function uploadCoverMaterial(
  cfg: WechatConfig,
  token: string,
  source: ImageSourceInput,
  filename: string,
): Promise<string> {
  /*
   * A cover must go through permanent media (the drafts API's thumb_media_id
   * accepts nothing else), which means it necessarily lands in the media
   * library and consumes quota.
   * Body images do not — the uploadimg documentation states they "do not count
   * against the media library's limit of 100,000 images".
   *
   * So covers have to be cached by content fingerprint: pushing the same cover
   * repeatedly should leave exactly one copy in the library.
   * A previous version uploaded a fresh copy on every push, so ten pushes piled
   * up ten identical images that had to be deleted by hand in the console.
   */
  const key = `cover:${await fingerprint('dataUrl' in source ? source.dataUrl : source.url)}`;
  const cache = readUploadCache();
  const hit = cache[key];
  if (hit?.mediaId) return hit.mediaId;

  // A cover is not bound by the body-image rule and has a 10MB budget, so send
  // it as close to untouched as possible
  const payload: ImageSourceInput =
    'dataUrl' in source ? { dataUrl: await fitDataUrl(source.dataUrl, MAX_MATERIAL_BYTES) } : source;
  const data = await call(cfg, 'material', { access_token: token, ...payload, filename });
  const mediaId = String(data.media_id ?? '');
  if (!mediaId) throw new Error('封面上传成功但没返回 media_id');
  cache[key] = { url: String(data.url ?? ''), mediaId };
  writeUploadCache(cache);
  return mediaId;
}

export interface DraftArticle {
  title: string;
  author?: string;
  digest?: string;
  content: string;
  content_source_url?: string;
  thumb_media_id: string;
  need_open_comment?: 0 | 1;
}

/** Push one draft into the drafts box, returning its media_id */
export async function addDraft(cfg: WechatConfig, token: string, article: DraftArticle): Promise<string> {
  const data = await call(cfg, 'draft', { access_token: token, articles: [article] });
  return String(data.media_id ?? '');
}

/**
 * Overwrite one article inside an existing draft.
 *
 * `index` addresses the article within the draft — a draft may hold several,
 * and 0 is the only value a draft pushed from here ever uses.
 *
 * The article must be sent **whole**. draft/update is a replace, not a patch:
 * whatever field is left out comes back empty, so pushing only `content` would
 * silently wipe the author, the cover and the "read the original" link. Every
 * caller therefore builds the same complete DraftArticle it would have sent to
 * draft/add.
 */
export async function updateDraft(
  cfg: WechatConfig,
  token: string,
  mediaId: string,
  index: number,
  article: DraftArticle,
): Promise<void> {
  await call(cfg, 'draftupdate', { access_token: token, media_id: mediaId, index, articles: article });
}

/* ---------------- Reading the drafts box ---------------- */

/** One article inside a draft, as WeChat hands it back */
export interface DraftNewsItem {
  title: string;
  author: string;
  digest: string;
  /** Empty in a listing (no_content=1); filled by fetchDraft */
  content: string;
  content_source_url: string;
  thumb_media_id: string;
  /** Cover address, directly displayable */
  thumb_url: string;
  need_open_comment: number;
  /** Preview address; empty until the draft has been published */
  url: string;
}

export interface DraftItem {
  media_id: string;
  /** Last-modified time, in seconds */
  update_time: number;
  articles: DraftNewsItem[];
}

export interface DraftPage {
  /** How many drafts the box holds in total, not how many this page returned */
  total: number;
  items: DraftItem[];
}

function toNewsItem(raw: Record<string, unknown>): DraftNewsItem {
  return {
    title: String(raw.title ?? ''),
    author: String(raw.author ?? ''),
    digest: String(raw.digest ?? ''),
    content: String(raw.content ?? ''),
    content_source_url: String(raw.content_source_url ?? ''),
    thumb_media_id: String(raw.thumb_media_id ?? ''),
    // WeChat returns cover addresses over http while the app is served over a
    // secure origin, so an http address simply does not load
    thumb_url: String(raw.thumb_url ?? '').replace(/^http:\/\//i, 'https://'),
    need_open_comment: Number(raw.need_open_comment ?? 0),
    url: String(raw.url ?? ''),
  };
}

function toItem(raw: Record<string, unknown>): DraftItem {
  const content = (raw.content ?? {}) as { news_item?: Array<Record<string, unknown>> };
  return {
    media_id: String(raw.media_id ?? ''),
    update_time: Number(raw.update_time ?? 0),
    articles: (content.news_item ?? []).map(toNewsItem),
  };
}

/**
 * One page of the drafts box, newest first.
 *
 * Bodies are left out (no_content=1): they are the bulk of the response and a
 * list shows none of them. Whoever wants one asks for that single draft by
 * media_id — see fetchDraft.
 */
export async function listDrafts(cfg: WechatConfig, offset: number, count: number): Promise<DraftPage> {
  const token = await getAccessToken(cfg);
  const data = await call(cfg, 'draftget', { access_token: token, offset, count, no_content: 1 });
  const items = ((data.item ?? []) as Array<Record<string, unknown>>).map(toItem);
  return { total: Number(data.total_count ?? items.length), items };
}

/** One draft in full, bodies included */
export async function fetchDraft(cfg: WechatConfig, mediaId: string): Promise<DraftNewsItem[]> {
  const token = await getAccessToken(cfg);
  const data = await call(cfg, 'draftitem', { access_token: token, media_id: mediaId });
  return ((data.news_item ?? []) as Array<Record<string, unknown>>).map(toNewsItem);
}

/* ---------------- Comparing against WeChat's own markup ---------------- */

/**
 * Read the newest draft back and extract its <img> tags verbatim.
 *
 * An image inserted by hand from the media library is sharp while ours is soft,
 * so the difference has to be in the tag. Rather than guessing which attributes
 * WeChat honors, make it hand over the markup it produces itself and copy that.
 * How to use it: insert an image by hand in the WeChat editor, save as a draft,
 * then press this.
 */
export async function fetchLatestDraftImages(cfg: WechatConfig): Promise<{ title: string; imgs: string[] }> {
  const token = await getAccessToken(cfg);
  const data = await call(cfg, 'draftget', { access_token: token, offset: 0, count: 1 });
  const items = (data.item ?? []) as Array<{ content?: { news_item?: Array<{ title?: string; content?: string }> } }>;
  const first = items[0]?.content?.news_item?.[0];
  if (!first?.content) throw new Error('草稿箱是空的，或者最新一篇没有正文');
  return {
    title: String(first.title ?? '（无标题）'),
    imgs: first.content.match(/<img[^>]*>/g) ?? [],
  };
}
