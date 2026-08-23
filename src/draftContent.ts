/**
 * The last pass over a draft's body.
 *
 * The drafts API is far stricter about `content` than a browser is, and
 * anything it dislikes comes back as 45166 "invalid content" without saying
 * what. This normalizes the constructs known to trip it, and reports size the
 * way WeChat measures it — so when something does go wrong you can at least
 * see how big the body is instead of guessing.
 */

/** WeChat's documented limits for a body: under 20k characters and under 1MB */
export const MAX_CONTENT_CHARS = 20000;
export const MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * Turn single quotes inside style attributes into entities.
 *
 * A theme's font stack is written `Georgia, 'Songti SC', serif`, which is
 * perfectly legal in a browser — but community reports of 45166 keep pointing
 * at quote handling in the body HTML. Single quotes make no difference to
 * rendering, so swapping in &#39; is a zero-cost way to take this variable out
 * of the equation.
 */
function normalizeQuotes(html: string): string {
  return html.replace(/style="([^"]*)"/g, (_m, value: string) => `style="${value.replace(/'/g, '&#39;')}"`);
}

/** Body size the way WeChat measures it (UTF-8 bytes and characters) */
export function contentSize(html: string): { chars: number; bytes: number } {
  return { chars: html.length, bytes: new TextEncoder().encode(html).length };
}

/**
 * Unwrap anchor links, keeping only their text.
 *
 * `<a href="#xxx">` is not tappable in a WeChat body, and the drafts API
 * answers 45166 because of it. The renderer no longer emits footnote anchors,
 * so this is a second line of defense — a body may still contain hand-written
 * HTML anchors.
 */
function unwrapFragmentLinks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#') || !href) a.replaceWith(...Array.from(a.childNodes));
  }
  return doc.body.innerHTML;
}

/**
 * Clear image styles, matching the images WeChat's own editor inserts.
 *
 * The drafts API preserves only three things on an <img>: alt, data-src and
 * style. Everything else is stripped. And an image inserted by hand from the
 * media library comes out sharp while ours comes out blurry — the only
 * surviving difference is that style: the editor supplies an empty one, while
 * ours carries `display:inline-block; vertical-align:middle` (the inline-image
 * style, taken whenever an image shares a paragraph with text). An inline
 * image skips WeChat's fill-the-container-width logic and renders at a size
 * that is somewhat too small, which on a high-density screen is blur.
 *
 * Decorations like rounded corners go with it — whether an image in the body
 * is sharp matters more than whether its corners are round.
 * This only affects pushing a draft; preview, copy and paste are untouched.
 */
function stripImageStyles(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) img.removeAttribute('style');
  return doc.body.innerHTML;
}

/** Normalization before sending a draft */
export function sanitizeForDraft(html: string): string {
  return stripImageStyles(normalizeQuotes(unwrapFragmentLinks(html)));
}

/** A sentence in plain words when the body exceeds WeChat's limits, else null */
export function contentWarning(html: string): string | null {
  const { chars, bytes } = contentSize(html);
  if (chars > MAX_CONTENT_CHARS) return `正文 ${chars} 字符，超过微信 2 万字符上限`;
  if (bytes > MAX_CONTENT_BYTES) return `正文 ${Math.round(bytes / 1024)}KB，超过微信 1MB 上限`;
  return null;
}
