/**
 * Push a draft: turn the rendered body into an article in the WeChat drafts box.
 *
 * The order is "swap every image first, then create the draft" — a failure part
 * way through leaves no half-written article full of dead images behind.
 */

import { stripPreviewMeta } from './clipboard';
import { contentSize, contentWarning, sanitizeForDraft } from './draftContent';
import {
  WechatError,
  addDraft,
  clearUploadCache,
  getAccessToken,
  uploadArticleImageOnce,
  uploadMaterialImage,
  updateDraft,
  uploadArticleImages,
  uploadCoverMaterial,
  type DraftArticle,
  type ImageSourceInput,
  type WechatConfig,
} from './wechat';

/**
 * An existing draft this push should overwrite instead of creating a new one.
 *
 * `index` addresses the article inside the draft; `thumbMediaId` is the cover
 * that draft already carries, kept as the fallback so an update does not
 * silently swap the cover for the body's first image.
 */
export interface DraftTarget {
  mediaId: string;
  index: number;
  thumbMediaId: string;
  /** Title as it stands in the drafts box, only for wording the messages */
  title: string;
}

export interface PublishOptions {
  /** Article title (WeChat allows 64 characters) */
  title: string;
  /** Body HTML (renderArticle's html field) */
  html: string;
  /** Digest; left empty, WeChat takes the opening of the body */
  digest?: string;
  /** Cover image as a data URI; without one, the body's first image is used */
  cover?: { dataUrl: string; filename: string };
  /** Progress callback, so the UI can say which step it is on */
  onProgress?: (message: string) => void;
  /** Set to overwrite an existing draft rather than create a new one */
  target?: DraftTarget;
}

export interface PublishResult {
  mediaId: string;
  /** Whether this overwrote an existing draft */
  updated: boolean;
  /** How many images were swapped for WeChat addresses */
  uploaded: number;
  /** The smallest long edge among the uploads — the first number to check when
   *  verifying sharpness */
  smallestEdge: number | null;
  /** The first image's "sent vs stored" comparison, for deciding who softened it */
  roundTrip: {
    sent: { w: number; h: number; bytes: number };
    stored: { w: number; h: number; bytes: number };
    rendered: { w: number; h: number; bytes: number } | null;
    url: string;
  } | null;
}

/**
 * Minimal-body self test.
 *
 * 45166 "invalid content" does not say what is wrong, so the only way in is to
 * bisect. This pushes a draft with the simplest possible body first:
 * success ⇒ credentials, allow-list, cover and API permission are all fine, and
 *           the problem is in the body HTML we generate;
 * same failure ⇒ the body is not involved; look at the account or the parameters.
 *
 * It really does create a draft in the drafts box, and deletes it afterwards.
 */
export async function publishMinimalTest(cfg: WechatConfig): Promise<string> {
  const token = await getAccessToken(cfg);
  // Draw a flat-color cover on the spot: the drafts API requires
  // thumb_media_id to be permanent media
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 500;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#d97757';
  ctx.fillRect(0, 0, 900, 500);
  const thumbMediaId = await uploadCoverMaterial(
    cfg,
    token,
    { dataUrl: canvas.toDataURL('image/jpeg', 0.9) },
    'minimal-test.jpg',
  );
  return await addDraft(cfg, token, {
    title: '接口自测（可删）',
    content: '<p>这是一次最小正文自测，确认草稿接口本身可用。看到这篇就说明成功了，可以直接删掉。</p>',
    thumb_media_id: thumbMediaId,
  });
}

/** The first image in the body usable as a cover */
function firstImage(html: string): { source: ImageSourceInput; filename: string } | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src) continue;
    const name = (img.getAttribute('alt') ?? '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'cover';
    if (src.startsWith('data:')) return { source: { dataUrl: src }, filename: name };
    if (/^https?:\/\//i.test(src)) return { source: { url: src }, filename: name };
  }
  return null;
}

/**
 * Push a draft.
 *
 * This outer layer handles exactly one thing: on a 40007, throw the upload
 * cache away and try once more.
 * The media_id / url in the cache may point at an asset you deleted in the
 * console, which is unknowable from here, and a re-upload fixes it — but only
 * one retry, so a genuine problem cannot loop forever.
 */
export async function publishToDraft(cfg: WechatConfig, opts: PublishOptions): Promise<PublishResult> {
  try {
    return await pushOnce(cfg, opts);
  } catch (err) {
    if (err instanceof WechatError && err.errcode === 40007) {
      opts.onProgress?.('素材已失效，正在重新上传…');
      clearUploadCache();
      return await pushOnce(cfg, opts);
    }
    throw err;
  }
}

async function pushOnce(cfg: WechatConfig, opts: PublishOptions): Promise<PublishResult> {
  const title = opts.title.trim();
  if (!title) throw new Error('标题不能为空');
  // Straight from the documentation: "title, no longer than 32 characters"
  if (title.length > 32) throw new Error(`标题 ${title.length} 字，超过微信 32 字上限`);
  if (cfg.author.trim().length > 16) throw new Error('作者超过微信 16 字上限');

  const report = opts.onProgress ?? (() => {});
  report('正在获取 access_token…');
  const token = await getAccessToken(cfg);

  const clean = sanitizeForDraft(stripPreviewMeta(opts.html));
  const { html, uploaded, smallestEdge, firstMediaId, roundTrip } = await uploadArticleImages(cfg, token, clean, (done, total) =>
    report(`正在上传图片 ${done}/${total}…`),
  );

  // Size must be measured *after* the swap. Before it, the images in the body
  // are still data URIs — one of them is hundreds of thousands of characters,
  // so what gets measured is image data rather than the article. The swapped
  // version is what actually goes to WeChat.

  const oversize = contentWarning(html);
  if (oversize) throw new Error(`${oversize} —— 拆成两篇`);

  /*
   * The cover goes through permanent media (the drafts API's thumb_media_id
   * accepts nothing else).
   * Body images now go through permanent media too, so the two can share one
   * asset — see the firstMediaId branch below.
   */
  let thumbMediaId: string;
  if (opts.cover) {
    report('正在上传封面…');
    thumbMediaId = await uploadCoverMaterial(cfg, token, { dataUrl: opts.cover.dataUrl }, opts.cover.filename);
  } else if (opts.target?.thumbMediaId) {
    // Updating: the cover already on that draft wins over the body's first
    // image. It may have been chosen by hand in the WeChat console, and an
    // update that quietly replaced it would be a change nobody asked for.

    thumbMediaId = opts.target.thumbMediaId;
  } else if (firstMediaId) {
    // Body images were already uploaded as permanent media, and the media_id
    // came back in that same call — using it as the cover saves an upload and
    // leaves no second copy of the same image in the library

    thumbMediaId = firstMediaId;
  } else {
    const fallback = firstImage(html);
    if (!fallback) throw new Error('缺少封面：正文里没有图片，请在下面单独选一张');
    report('正在上传封面…');
    thumbMediaId = await uploadCoverMaterial(cfg, token, fallback.source, fallback.filename);
  }

  const article: DraftArticle = {
    title,
    author: cfg.author.trim() || undefined,
    digest: opts.digest?.trim() || undefined,
    content: html,
    content_source_url: cfg.sourceUrl.trim() || undefined,
    thumb_media_id: thumbMediaId,
    need_open_comment: cfg.openComment ? 1 : 0,
  };

  report(opts.target ? '正在更新草稿…' : '正在推送草稿…');
  try {
    if (opts.target) {
      // draft/update replaces the article whole, so the same complete object
      // goes out either way — see updateDraft
      await updateDraft(cfg, token, opts.target.mediaId, opts.target.index, article);
      return { mediaId: opts.target.mediaId, updated: true, uploaded, smallestEdge, roundTrip };
    }
    const mediaId = await addDraft(cfg, token, article);
    return { mediaId, updated: false, uploaded, smallestEdge, roundTrip };
  } catch (err) {
    // Content errors (45166 invalid content, 45002 over the limit) only say
    // "no" without pointing anywhere, so attach the measurements of the body
    // that actually went out. Note this *edits* message rather than throwing a
    // new Error: wrapping it would discard WechatError's type along with its
    // errcode, and every retry and branch keyed on errcode outside would stop
    // working (a mistake already made once).



    if (err instanceof WechatError && (err.errcode === 45166 || err.errcode === 45002)) {
      const { chars, bytes } = contentSize(html);
      err.message += `\n\n实际发出的正文：${chars} 字符 / ${Math.round(bytes / 1024)}KB（上限 2 万字符、1MB）`;
    }
    throw err;
  }
}

/* ---------------- Content-problem diagnosis ---------------- */

export interface Diagnosis {
  /** Whether the minimal body pushes successfully — if it does not, the body is
   *  not the problem */
  baselineOk: boolean;
  /** The section of body HTML it narrowed down to; null if it found nothing */
  culprit: string | null;
  /** A running log, shown to the user step by step */
  log: string[];
  /** How many test drafts were created, so the user knows to delete them */
  drafts: number;
}

/** Wrap a set of blocks back into their original shell, keeping the context intact */
function reassemble(shell: Element, blocks: Element[]): string {
  const clone = shell.cloneNode(false) as Element;
  for (const b of blocks) clone.appendChild(b.cloneNode(true));
  return clone.outerHTML;
}

/**
 * Locate which part of the body WeChat is rejecting.
 *
 * No longer a checklist of "maybe it is the <a>, maybe the <mark>" — one wrong
 * guess and a whole round is wasted. Instead it bisects the body's top-level
 * blocks: keep the first half or the second, follow whichever fails, and
 * converge on one block, then hand that HTML over verbatim. What the culprit is
 * gets decided by the bisection, not by me guessing.
 *
 * Images have to be swapped for WeChat addresses before it starts — otherwise
 * the body is all data URIs and the very first attempt hits 45002 (over the
 * size limit), which measures the images rather than the article.
 */
export async function diagnoseDraftContent(
  cfg: WechatConfig,
  rawHtml: string,
  onProgress?: (message: string) => void,
): Promise<Diagnosis> {
  const report = onProgress ?? (() => {});
  const log: string[] = [];
  let drafts = 0;

  const token = await getAccessToken(cfg);

  report('先把图片换成微信地址…');
  const { html } = await uploadArticleImages(cfg, token, sanitizeForDraft(stripPreviewMeta(rawHtml)), (done, total) =>
    report(`正在上传图片 ${done}/${total}…`),
  );
  const size = contentSize(html);
  log.push(`换图后的正文：${size.chars} 字符 / ${Math.round(size.bytes / 1024)}KB`);

  report('准备封面…');
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 500;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#d97757';
  ctx.fillRect(0, 0, 900, 500);
  const thumb = await uploadCoverMaterial(cfg, token, { dataUrl: canvas.toDataURL('image/jpeg', 0.9) }, 'probe.jpg');

  /** Push one test draft; returns whether it succeeded */
  const attempt = async (label: string, content: string): Promise<boolean> => {
    try {
      await addDraft(cfg, token, { title: `自测·${label}`.slice(0, 32), content, thumb_media_id: thumb });
      drafts++;
      log.push(`✓ ${label}`);
      return true;
    } catch (err) {
      const detail =
        err instanceof WechatError
          ? `[errcode ${err.errcode}] ${err.raw}`
          : err instanceof Error
            ? err.message.split('\n')[0]
            : '失败';
      log.push(`✗ ${label} —— ${detail}`);
      return false;
    }
  };

  report('试探：最小正文…');
  const baselineOk = await attempt('最小正文', '<p>最小正文自测，可删。</p>');
  if (!baselineOk) return { baselineOk, culprit: null, log, drafts };

  report('试探：换图后的完整正文…');
  if (await attempt('完整正文（已换图）', html)) {
    log.push('这次推成功了 —— 说明问题出在换图那一步之前，不是正文构造本身');
    return { baselineOk, culprit: null, log, drafts };
  }

  // Bisect the top-level blocks
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const shell = doc.body.firstElementChild;
  if (!shell || shell.children.length < 2) {
    log.push('正文结构太简单，没法再二分');
    return { baselineOk, culprit: null, log, drafts };
  }

  let blocks = Array.from(shell.children);
  log.push(`开始二分：正文顶层有 ${blocks.length} 块`);

  while (blocks.length > 1) {
    const mid = Math.ceil(blocks.length / 2);
    const first = blocks.slice(0, mid);
    const second = blocks.slice(mid);

    report(`二分中：试前 ${first.length} 块…`);
    if (!(await attempt(`前 ${first.length}/${blocks.length} 块`, reassemble(shell, first)))) {
      blocks = first;
      continue;
    }
    report(`二分中：试后 ${second.length} 块…`);
    if (!(await attempt(`后 ${second.length}/${blocks.length} 块`, reassemble(shell, second)))) {
      blocks = second;
      continue;
    }
    // Each half passes alone but together they fail — that is a total-size
    // problem, not a problem with any one block
    log.push('两半单独都能推成功，合起来才失败 —— 是总量超限，不是某一块有毛病');
    return { baselineOk, culprit: null, log, drafts };
  }

  const culprit = blocks[0].outerHTML;
  log.push(`收敛到 1 块，长度 ${culprit.length} 字符`);
  return { baselineOk, culprit, log, drafts };
}

/* ---------------- Comparing the two upload routes ---------------- */

/**
 * Upload the same image down both routes and put them side by side in one draft.
 *
 * The routes differ in more than the endpoint:
 * - uploadimg caps at 1MB, so a large image is necessarily re-encoded as JPEG (lossy)
 * - add_material allows 10MB and usually uploads untouched (lossless)
 * But the documentation says body images should use the former, while the
 * latter's address may be processed differently by WeChat inside a body.
 *
 * Which is sharper cannot be settled by guessing or by testing one side alone —
 * put them in the same article under the same rendering conditions and one look
 * decides it. This creates a draft marked as safe to delete.
 */
export async function compareImageRoutes(
  cfg: WechatConfig,
  html: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const report = onProgress ?? (() => {});
  const doc = new DOMParser().parseFromString(stripPreviewMeta(html), 'text/html');
  const img = Array.from(doc.querySelectorAll('img')).find((el) =>
    (el.getAttribute('src') ?? '').startsWith('data:'),
  );
  const dataUrl = img?.getAttribute('src');
  if (!dataUrl) throw new Error('正文里没有本地图片，没法做对照');

  report('正在获取 access_token…');
  const token = await getAccessToken(cfg);

  report('路线 A：图文接口上传…');
  const a = await uploadArticleImageOnce(cfg, token, dataUrl, 'route-a.png');
  report('路线 B：永久素材上传…');
  const b = await uploadMaterialImage(cfg, token, dataUrl, 'route-b.png');

  const label = 'margin:0 0 8px;font-size:15px;font-weight:700;color:#d97757';
  report('正在推送对照草稿…');
  await addDraft(cfg, token, {
    title: '图片路线对照（可删）',
    thumb_media_id: b.mediaId,
    content:
      `<p style="${label}">A · 图文接口 uploadimg（1MB 上限，大图会被重编码）</p>` +
      `<img src="${a}">` +
      `<p style="${label}">B · 永久素材 add_material（10MB，通常原样上传）</p>` +
      `<img src="${b.url}">` +
      `<p style="margin:16px 0 0;font-size:13px;color:#8a857a">在手机上看这两张，哪张清楚就用哪条路线。</p>`,
  });
}
