/**
 * Long-image export: paint the rendered body into a single PNG (for sharing to
 * a feed, or for archiving).
 *
 * No html2canvas or similar: this project's article styles are all inline and
 * its images are all data URIs, which is exactly what `<foreignObject>`
 * requires. So the real DOM is serialized to valid XHTML with XMLSerializer,
 * dropped into an SVG, and drawn onto a canvas as an image. XMLSerializer also
 * closes void elements like `<img>` and `<br>` and escapes attributes, which
 * hand-rolled string concatenation cannot do.
 */

import { extractTitle, stripFirstH1 } from './markdown';
import { st, type Theme } from './theme';

/** Layout width in CSS px: composed at phone body width, scaled up on export */
const WIDTH = 375;
const PADDING = 20;
/** Output scale: 2× ≈ 750px wide, matching how WeChat screenshots are usually taken */
const SCALE = 2;
/** Canvas per-side limit; go over and the scale drops (browsers simply fail to
 *  paint beyond it) */
const MAX_DEVICE_PX = 30000;

interface Options {
  /** renderArticle().body — body HTML with styles already inlined */
  body: string;
  theme: Theme;
  /** Byline in the article head; leave empty to omit the author line */
  author?: string;
}

/** Wait for every image in the body to decode, or the measured height is wrong */
async function waitForImages(root: HTMLElement): Promise<void> {
  const pending = Array.from(root.querySelectorAll('img')).map((img) =>
    img.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
  );
  await Promise.all(pending);
  // Heights measured before fonts finish loading use the fallback face, and the
  // exported text ends up misplaced
  if (document.fonts?.ready) await document.fonts.ready;
}

/** Article head (title plus byline), styled to match the preview's */
function headHtml(title: string, theme: Theme, author?: string): string {
  const dateText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const meta = author ? `${author} · ${dateText}` : dateText;
  return `<div style="${st({ 'margin-bottom': '20px' })}">
    <div style="${st({
      'font-family': theme.heading.font,
      'font-size': '22px',
      'font-weight': '700',
      'line-height': '1.4',
      color: theme.heading.color,
    })}">${title}</div>
    <div style="${st({
      'margin-top': '10px',
      'font-size': '13px',
      color: theme.footnote.textColor,
    })}">${meta}</div>
  </div>`;
}

/**
 * Render the long image and return a PNG Blob.
 * If the article is long enough that the scaled canvas exceeds the limit, drop
 * the scale first; if it still overflows, throw.
 */
export async function renderLongImage({ body, theme, author }: Options): Promise<Blob> {
  const title = extractTitle(body);
  const bg = theme.body.bg ?? '#ffffff';

  const stage = document.createElement('div');
  stage.style.cssText = `position:fixed;left:-10000px;top:0;width:${WIDTH}px;opacity:0;pointer-events:none;z-index:-1`;

  const card = document.createElement('div');
  card.style.cssText = st({
    width: `${WIDTH}px`,
    'box-sizing': 'border-box',
    padding: `${PADDING}px`,
    background: bg,
    'font-family': theme.body.font,
    'font-size': theme.body.fontSize,
    'line-height': theme.body.lineHeight,
    color: theme.body.color,
    'word-break': 'break-word',
  });
  card.innerHTML = (title ? headHtml(title, theme, author) : '') + (title ? stripFirstH1(body) : body);

  stage.appendChild(card);
  document.body.appendChild(stage);

  try {
    await waitForImages(card);
    const height = Math.ceil(card.getBoundingClientRect().height);
    if (height <= 0) throw new Error('正文为空');

    let scale = SCALE;
    if (height * scale > MAX_DEVICE_PX) scale = 1;
    if (height * scale > MAX_DEVICE_PX) {
      throw new Error(`文章过长（约 ${height}px），超出浏览器画布上限，建议分篇导出`);
    }

    const xhtml = new XMLSerializer().serializeToString(card);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('长图渲染失败'));
      img.src = src;
    });

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    // SVG is vector, so drawing straight at the target size keeps the text
    // crisp (rather than painting small and scaling up)
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('长图编码失败');
    return blob;
  } finally {
    stage.remove();
  }
}
