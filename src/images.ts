/**
 * Bringing images in: turn a local image file into a data URI and embed it in
 * the markdown.
 *
 * The size arithmetic has to be done honestly. A WeChat body renders about
 * 677pt wide on a phone, and mainstream phones are 3x — meaning a full-width
 * image needs to be somewhere around 2000px before it can be called sharp, and
 * WeChat is going to compress it again on top of that.
 * So the principle here is: **touch nothing unless you must**. Only downscale
 * when the budget is genuinely exceeded, and reduce dimensions before quality.
 *
 * Early versions scaled unconditionally to 1280px at JPEG 0.82, re-encoding
 * even a 900px thumbnail, and pastes into WeChat came out visibly soft — that
 * was three stacked losses, not WeChat's compression.
 */

/** Long-edge cap: enough for a full-width image on a 3x screen; beyond that it
 *  only bloats the clipboard */
const MAX_DIM = 1920;

/**
 * Per-image data URI cap.
 * base64 inflates by another third, and a dozen images in one body is enough to
 * make pasting stall, so there has to be a ceiling.
 */
const MAX_DATA_URL = 2.5 * 1024 * 1024;

/** Read as a data URI, without touching a single byte */
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** Decode the dimensions (using the data URI as the source, which saves a disk
 *  read and involves no cross-origin issues) */
function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/** Rescale by long edge and re-encode */
function encode(img: HTMLImageElement, maxDim: number, mime: string, quality: number): string {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  // Canvas's default bilinear sampling gets fuzzy at large reductions, so ask
  // for high-quality resampling explicitly
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mime, quality);
}

/**
 * The degradation ladder on import: dimensions first, quality second.
 *
 * Import has no hard byte ceiling (what lands in the workspace is an ordinary
 * file), so the budget is generous and quality is preserved first; dimensions
 * only move when something is genuinely enormous.
 *
 * TODO: the desktop version could store the original untouched — compression
 * is only truly needed at the moment of copying or pushing a draft (both the
 * clipboard and the WeChat API have size limits). That change touches both the
 * clipboard and publish paths, so it is parked for now.
 */
const JPEG_LADDER = [
  { dim: MAX_DIM, quality: 0.92 },
  { dim: 1440, quality: 0.88 },
  { dim: 1080, quality: 0.82 },
];

/**
 * Normalize a data URI into something WeChat will accept.
 *
 * WeChat's "upload an image inside an article" endpoint takes only jpg/png and
 * requires under 1MB (see its documentation on developers.weixin.qq.com). A
 * wrong format or an oversized file has to be re-encoded; everything else is
 * returned untouched — re-encoding only costs quality.
 *
 * Dimensions first, quality second: the same trade-off as on import.
 */
export async function fitDataUrl(dataUrl: string, maxBytes: number): Promise<string> {
  const mime = dataUrl.slice(5, dataUrl.indexOf(';')).toLowerCase();
  const acceptable = mime === 'image/jpeg' || mime === 'image/png';
  if (acceptable && dataUrlBytes(dataUrl) <= maxBytes) return dataUrl;
  const img = await decode(dataUrl);
  // Wrong format (gif/webp/avif…) but within budget: swap the encoding only,
  // without moving a single pixel
  if (!acceptable && dataUrlBytes(dataUrl) <= maxBytes) {
    return encode(img, Math.max(img.naturalWidth, img.naturalHeight), 'image/jpeg', 0.92);
  }
  let out = dataUrl;
  for (const step of JPEG_LADDER) {
    out = encode(img, step.dim, 'image/jpeg', step.quality);
    if (dataUrlBytes(out) <= maxBytes) return out;
  }
  // Still over after the whole ladder: one last hard squeeze, which beats
  // failing to upload at all
  return encode(img, 900, 'image/jpeg', 0.7);
}

/**
 * Squeeze an image into uploadimg's 1MB budget — **never reducing dimensions**;
 * returns null when it will not fit.
 *
 * The order was paid for in experiments:
 *
 * 1. Lossless PNG at original size, if it fits under 1MB (ideal for
 *    screenshots — not one pixel lost)
 * 2. Otherwise JPEG, **keeping the long edge**, letting quality fall from 0.92
 *    down toward 0.7
 * 3. Only then does downscaling come up (handled by the caller), and the user
 *    has to be told
 *
 * A "downscale the PNG to stay lossless" step once sat before step 2, on the
 * theory that WeChat only renders at 1080 anyway — measured, it was blurrier.
 * The /640 size looks like a proportional scale rather than a fixed cap
 * (1080/1920 is exactly 0.5625), so the smaller the image fed in, the smaller
 * the one rendered out. Better to give up quality than resolution.
 */
export async function fitKeepingSize(dataUrl: string, maxBytes: number): Promise<string | null> {
  const mime = dataUrl.slice(5, dataUrl.indexOf(';')).toLowerCase();
  if ((mime === 'image/jpeg' || mime === 'image/png') && dataUrlBytes(dataUrl) <= maxBytes) return dataUrl;
  const img = await decode(dataUrl);
  const edge = Math.max(img.naturalWidth, img.naturalHeight);

  // Best case: lossless PNG at original size fits (a canvas re-encode is
  // sometimes even smaller than the original file)
  if (mime === 'image/png') {
    const lossless = encode(img, edge, 'image/png', 1);
    if (dataUrlBytes(lossless) <= maxBytes) return lossless;
  }

  for (const quality of [0.92, 0.85, 0.78, 0.7]) {
    const out = encode(img, edge, 'image/jpeg', quality);
    if (dataUrlBytes(out) <= maxBytes) return out;
  }
  return null;
}

/** Measure a data URI's dimensions and weight, to verify what actually went up */
export async function measureDataUrl(dataUrl: string): Promise<{ w: number; h: number; bytes: number }> {
  const img = await decode(dataUrl);
  return { w: img.naturalWidth, h: img.naturalHeight, bytes: dataUrlBytes(dataUrl) };
}

/** Real byte count of a data URI (base64 carries 3 bytes per 4 characters) */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/**
 * Turn an image file into an embeddable data URI.
 *
 * If both dimensions and weight are within budget, return it untouched —
 * re-encoding only costs quality and buys nothing.
 */
export async function prepareImage(file: File): Promise<string> {
  const original = await readAsDataUrl(file);

  // A GIF run through a canvas comes out as its first frame only, so animated
  // images are kept as-is no matter their size
  if (file.type === 'image/gif') return original;

  const img = await decode(original);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_DIM && dataUrlBytes(original) <= MAX_DATA_URL) return original;

  // PNG has no quality dial, so only dimensions can move; if it is still over
  // budget at the floor, switch to JPEG (at the cost of the alpha channel)
  const attempts =
    file.type === 'image/png'
      ? [
          { dim: MAX_DIM, mime: 'image/png', quality: 1 },
          { dim: 1440, mime: 'image/png', quality: 1 },
          ...JPEG_LADDER.map((step) => ({ ...step, mime: 'image/jpeg' })),
        ]
      : JPEG_LADDER.map((step) => ({ ...step, mime: 'image/jpeg' }));

  let out = original;
  for (const attempt of attempts) {
    out = encode(img, attempt.dim, attempt.mime, attempt.quality);
    if (dataUrlBytes(out) <= MAX_DATA_URL) return out;
  }
  return out;
}

/**
 * Register a batch of image files: process each, then call onAdd(name, dataUrl).
 * Returns the names that succeeded and failed, for inserting ![[name]] or
 * reporting the problem.
 */
export async function registerImageFiles(
  files: File[],
  onAdd: (name: string, dataUrl: string) => void,
): Promise<{ names: string[]; failures: string[] }> {
  const names: string[] = [];
  const failures: string[] = [];
  for (const f of files) {
    try {
      const dataUrl = await prepareImage(f);
      onAdd(f.name, dataUrl);
      names.push(f.name);
    } catch (err) {
      console.warn('图片处理失败', f.name, err);
      failures.push(f.name);
    }
  }
  return { names, failures };
}
