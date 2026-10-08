/**
 * 公众号文章 → Markdown, fetched by this machine rather than by a reader service.
 *
 * This exists because the hosted route does not work here and cannot be made
 * to. Ask r.jina.ai for an `mp.weixin.qq.com/s/...` address and what comes back
 * is not the article but WeChat's 「环境异常，完成验证后即可继续访问」 page —
 * datacenter addresses get the verification wall, and no header changes that.
 * The same link fetched from an ordinary connection returns the article in
 * full, so that is where the request goes: out of this window, over the user's
 * own line, exactly as if they had opened the page.
 *
 * The other half of the argument is that no extraction guesswork is needed for
 * these pages. Every WeChat article has the same skeleton — the body is
 * `#js_content`, the title is `#activity-name`, the images hang off `data-src`
 * — so "which part is the article" has a known answer, and what is left is a
 * plain walk of a small, familiar subtree.
 *
 * Which is what the converter below is: tuned to the markup WeChat's own
 * editor produces (a great many nested `<section>`s carrying inline styles),
 * not a general-purpose HTML-to-Markdown engine.
 */

import { fetch } from '@tauri-apps/plugin-http';
import type { Article } from './reader';

/** WeChat's iPhone client gets the public article shape without desktop-only chrome. */
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30';

const RETRY_DELAYS = [0, 1000, 2000] as const;

export function isWechatArticle(url: string): boolean {
  try {
    return new URL(url).hostname === 'mp.weixin.qq.com';
  } catch {
    return false;
  }
}

export async function fetchWechatArticle(url: string, signal?: AbortSignal): Promise<Article> {
  let res: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (RETRY_DELAYS[attempt]) await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS[attempt]));
    if (signal?.aborted) throw new Error('已取消');
    try {
      const candidate = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://mp.weixin.qq.com/',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal,
      });
      res = candidate;
      if (candidate.status !== 429 && candidate.status < 500) break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!res) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`打不开这篇文章：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  if (!res.ok) throw new Error(`打不开这篇文章（HTTP ${res.status}）。`);

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const content = doc.querySelector('#js_content');

  if (!content) {
    // The two ways a WeChat link stops being an article, both of which look
    // like a perfectly good page to anything that only checks the status code
    if (html.includes('环境异常')) {
      throw new Error('微信要求验证后才让访问这篇文章。在浏览器里打开一次通过验证，过一会儿再试。');
    }
    if (html.includes('该内容已被发布者删除') || html.includes('内容无法查看')) {
      throw new Error('这篇文章已经被发布者删除了。');
    }
    throw new Error('这个链接里没有文章正文 —— 确认一下是不是文章页的地址。');
  }

  return {
    // The parsed page travels with the article so a theme can be read off the
    // same visit (see sniffed() in reader.ts)
    doc,
    title: textOf(doc.querySelector('#activity-name')),
    markdown: toMarkdown(content, url),
    url,
    byline: [textOf(doc.querySelector('#js_author_name')), textOf(doc.querySelector('#js_name'))]
      .filter(Boolean)
      .join(' · '),
    publishedTime: publishedTime(html),
  };
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * When it was published.
 *
 * `#publish_time` is filled in by the page's own JavaScript, so in the HTML we
 * fetch it is an empty element. The timestamp the script reads from is right
 * there in the source, which is where this takes it.
 */
function publishedTime(html: string): string {
  const match = /(?:var\s+)?(?:oriCreateTime|create_time)\s*=\s*['"](\d{10})['"]/.exec(html);
  if (!match) return '';
  return new Date(Number(match[1]) * 1000).toISOString();
}

/* ---------- HTML → Markdown ---------- */

interface Ctx {
  /** For resolving whatever relative addresses turn up in links */
  base: string;
  /** The article's own root, and its length: a "box" as wide as the whole
   *  piece is the page's wrapper, not a box drawn on the page */
  root: Element;
  total: number;
}

/** Absolute address, or null if there is nothing usable */
function absolute(href: string | null, ctx: Ctx): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') return null;
  try {
    return new URL(trimmed, ctx.base).toString();
  } catch {
    return null;
  }
}

/**
 * Escape the characters that would otherwise change the meaning of the text.
 *
 * Deliberately the short list. Aggressive escaping is the usual failure mode of
 * these converters and it is a bad trade here: the text is overwhelmingly
 * Chinese, where `*` and `_` inside a word are vanishingly rare, while a body
 * peppered with backslashes is unreadable in the editor pane — which is where
 * the user has to actually work on it afterwards.
 */
function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

/** Collapse the whitespace the HTML source is padded with, `&nbsp;` included */
function normalizeText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
}

const HEADINGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

/**
 * Text that is nothing but an address.
 *
 * Emphasis around one of those is never emphasis: it is how WeChat prints a
 * reference URL (in italics, right after the bold label). Marking it up adds
 * nothing a reader can see, and the markers end up against the label's own —
 * `**label:**` followed by `*url*` runs into `***`, which Markdown reads as
 * something else entirely.
 */
const BARE_URL = /^<?(https?:\/\/|www\.)[^\s<>]+>?$/i;

/** Elements whose content is not part of the article no matter what is in them */
const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO']);

/** Elements that start and end a block, so their content cannot run into the
 *  text on either side */
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'ADDRESS']);

/**
 * The WeChat editor has no callout and no blockquote: a box there is a
 * `<section>` with a fill, a rule down its left, or both. Markdown has words
 * for exactly those two shapes — a callout and a quote — and without this
 * step both arrive as loose paragraphs, which is why a themed callout had
 * nothing to style.
 *
 * A rule down the left reads as a quote even when the box is also filled;
 * a plain fill is a callout.
 */
function boxKind(el: Element, ctx: Ctx): 'callout' | 'quote' | null {
  const style = (el as HTMLElement).style;
  if (!style) return null;
  const len = (el.textContent ?? '').trim().length;
  if (len < 6 || len > ctx.total * 0.6) return null;
  // Only the outermost box: nested ones would stack into `> >`
  for (let up = el.parentElement; up && up !== ctx.root; up = up.parentElement) {
    if (boxKind(up, ctx)) return null;
  }
  const width = (v: string) => {
    const m = /^([\d.]*\d)(px|pt|em|rem)?$/.exec(v.trim());
    if (!m) return 0;
    const n = parseFloat(m[1]);
    // `.25em` is how the editor writes a quote bar, and 0.25 is not 2px
    return m[2] === 'em' || m[2] === 'rem' ? n * 16 : m[2] === 'pt' ? (n * 4) / 3 : n;
  };
  const bar =
    width(style.borderLeftWidth || '') >= 2 &&
    !!style.borderLeftStyle &&
    style.borderLeftStyle !== 'none';
  if (bar) return 'quote';
  const fill = style.backgroundColor || '';
  const filled = !!fill && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/i.test(fill.trim());
  return filled ? 'callout' : null;
}

/** Wrap block content as a quote, keeping it one block: a bare blank line
 *  would end the quote and start another */
function quoteLines(inner: string): string {
  return inner
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}`.trimEnd() : '>'))
    .join('\n');
}

function renderChildren(node: Node, ctx: Ctx): string {
  let out = '';
  node.childNodes.forEach((child) => {
    out += renderNode(child, ctx);
  });
  return out;
}

/**
 * One line of WeChat's reference list at the foot of an article.
 *
 * It is written as a flex row: a fixed-width span holding `[1]`, then the
 * text. Recognising it is what turns the list into real footnotes — left
 * alone it arrives as loose paragraphs with the marker escaped to `\[1\]`,
 * which is neither a footnote nor readable.
 */
function refEntry(el: Element): { n: string; body: Element } | null {
  const kids = Array.from(el.children);
  if (kids.length !== 2) return null;
  const m = /^\[(\d{1,3})\]$/.exec((kids[0].textContent ?? '').trim());
  return m ? { n: m[1], body: kids[1] } : null;
}

/** The heading WeChat puts above that list. The renderer draws a footnote
 *  section of its own, so keeping this would head it twice */
const REF_HEADING = /^(references?|参考(资料|链接|文献)?|注释)$/i;

function renderNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(normalizeText(node.nodeValue ?? ''));
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP.has(tag)) return '';
  // WeChat hides the odd fragment rather than removing it; what the reader
  // never saw does not belong in the draft either
  if ((el as HTMLElement).style?.display === 'none') return '';

  const ref = refEntry(el);
  if (ref) {
    const body = renderChildren(ref.body, ctx).replace(/\s+/g, ' ').trim();
    // `**label:**https://…` with nothing between them reads as one word
    const spaced = body.replace(/(\*\*)(?=https?:\/\/)/g, '$1 ');
    return spaced ? `\n\n[^${ref.n}]: ${spaced}\n\n` : '';
  }

  if (tag in HEADINGS) {
    const text = renderChildren(el, ctx).replace(/\s+/g, ' ').trim();
    if (REF_HEADING.test(text) && /^\s*\[\d+\]/.test(el.nextElementSibling?.textContent ?? '')) {
      return '';
    }
    return text ? `\n\n${'#'.repeat(HEADINGS[tag])} ${text}\n\n` : '';
  }

  switch (tag) {
    case 'SUP': {
      const text = (el.textContent ?? '').trim();
      const m = /^\[(\d{1,3})\]$/.exec(text);
      // A numbered superscript is a footnote reference; anything else is
      // ordinary superscript text (a date, a unit) and stays as it reads
      return m ? `[^${m[1]}]` : escapeText(normalizeText(text));
    }
    case 'BR':
      return '\n';
    case 'HR':
      return '\n\n---\n\n';
    case 'IMG': {
      // The address lives in data-src until the page's own script moves it
      const src = absolute(el.getAttribute('data-src') ?? el.getAttribute('src'), ctx);
      if (!src) return '';
      const alt = normalizeText(el.getAttribute('alt') ?? '').trim();
      return `\n\n![${escapeText(alt)}](${src})\n\n`;
    }
    case 'A': {
      const text = renderChildren(el, ctx).trim();
      if (!text) return '';
      const href = absolute(el.getAttribute('href'), ctx);
      return href ? `[${text}](${href})` : text;
    }
    case 'STRONG':
    case 'B': {
      const text = renderChildren(el, ctx).trim();
      if (!text) return '';
      return BARE_URL.test(text) ? text : `**${text}**`;
    }
    case 'SPAN':
    case 'FONT': {
      // The WeChat editor writes bold as a weight on a span, not as <strong>,
      // so without this every emphasis in an article — and every card's own
      // title line — arrives as plain text
      const weight = (el as HTMLElement).style?.fontWeight ?? '';
      const bold = weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600;
      const text = renderChildren(el, ctx);
      if (!bold) return text;
      const trimmed = text.trim();
      if (!trimmed || /^\*\*/.test(trimmed) || BARE_URL.test(trimmed)) return text;
      // Keep the spaces that sat around it: they separate words either side
      const [, before, core, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? ['', '', text, ''];
      return `${before}**${core}**${after}`;
    }
    case 'EM':
    case 'I': {
      const text = renderChildren(el, ctx).trim();
      if (!text) return '';
      return BARE_URL.test(text) ? text : `*${text}*`;
    }
    case 'DEL':
    case 'S':
    case 'STRIKE': {
      const text = renderChildren(el, ctx).trim();
      return text ? `~~${text}~~` : '';
    }
    case 'CODE': {
      // Inside a <pre> the parent has already taken the text verbatim
      if (el.closest('pre')) return '';
      const text = normalizeText(el.textContent ?? '').trim();
      return text ? `\`${text}\`` : '';
    }
    case 'PRE': {
      const code = (el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
      return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : '';
    }
    case 'BLOCKQUOTE': {
      const inner = renderChildren(el, ctx).trim();
      if (!inner) return '';
      const quoted = inner
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }
    case 'UL':
    case 'OL':
      return renderList(el, ctx);
    case 'LI':
      // Only reachable when a list item sits outside any list, which happens
      // in hand-pasted markup; treat it as its own block
      return `\n\n${renderChildren(el, ctx).trim()}\n\n`;
    case 'TABLE':
      return renderTable(el, ctx);
    default:
      break;
  }

  if (BLOCKS.has(tag)) {
    const kind = boxKind(el, ctx);
    if (kind) {
      const inner = renderChildren(el, ctx).trim();
      if (!inner) return '';
      if (kind === 'quote') return `\n\n${quoteLines(inner)}\n\n`;
      // A card's first line is usually its title, and usually set bold —
      // which is exactly what a callout's title is
      const lines = inner.split('\n');
      const lead = /^\*\*(.{1,30}?)\*\*$/.exec(lines[0].trim());
      const title = lead ? lead[1].trim() : '';
      const body = title ? lines.slice(1).join('\n').trim() : inner;
      const head = `> [!tip]${title ? ` ${title}` : ''}`;
      return body ? `\n\n${head}\n${quoteLines(body)}\n\n` : `\n\n${head}\n\n`;
    }
  }

  const inner = renderChildren(el, ctx);
  return BLOCKS.has(tag) ? `\n\n${inner}\n\n` : inner;
}

function renderList(list: Element, ctx: Ctx): string {
  const ordered = list.tagName.toUpperCase() === 'OL';
  const lines: string[] = [];
  let n = 1;
  for (const item of Array.from(list.children)) {
    if (item.tagName.toUpperCase() !== 'LI') continue;
    const body = renderChildren(item, ctx).trim();
    if (!body) continue;
    const marker = ordered ? `${n++}. ` : '- ';
    // Continuation lines are indented to the marker, or they read as new items
    const indented = body.split('\n').join(`\n${' '.repeat(marker.length)}`);
    lines.push(marker + indented);
  }
  return lines.length ? `\n\n${lines.join('\n')}\n\n` : '';
}

/**
 * A pipe table, when the shape allows one.
 *
 * Markdown tables cannot express a merged cell or a second header row, so
 * anything ragged is left as its rows of text rather than silently reshaped
 * into a table that says something the page did not.
 */
function renderTable(table: Element, ctx: Ctx): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children)
      .filter((cell) => /^(TD|TH)$/.test(cell.tagName.toUpperCase()))
      .map((cell) => renderChildren(cell, ctx).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  const usable = rows.filter((cells) => cells.length);
  if (!usable.length) return '';
  const width = usable[0].length;
  if (usable.some((cells) => cells.length !== width) || width < 2) {
    return `\n\n${usable.map((cells) => cells.join(' ')).join('\n\n')}\n\n`;
  }
  const [head, ...body] = usable;
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ];
  return `\n\n${lines.join('\n')}\n\n`;
}

/**
 * Walk the body, then tidy what the walk leaves behind.
 *
 * The nesting in a WeChat body is deep and mostly decorative, so every block
 * boundary is emitted unconditionally and the runs of blank lines they produce
 * are collapsed once at the end. Doing it that way costs one pass and removes
 * every "did this element need a break before it" decision from the walk.
 */
/** Exported for the conversion tests; the article path uses it through
 *  fetchWechatArticle */
export function toMarkdown(content: Element, base: string): string {
  return renderNode(content, {
    base,
    root: content,
    total: (content.textContent ?? '').trim().length,
  })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    // Two bold runs written back to back (the editor splits a bold line into
    // several spans) meet as `****`, which reads as an empty emphasis as
    // easily as a join. They are one bold run; make them one
    .replace(/\*\*\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
