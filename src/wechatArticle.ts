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

/** Elements whose content is not part of the article no matter what is in them */
const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO']);

/** Elements that start and end a block, so their content cannot run into the
 *  text on either side */
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'ADDRESS']);

function renderChildren(node: Node, ctx: Ctx): string {
  let out = '';
  node.childNodes.forEach((child) => {
    out += renderNode(child, ctx);
  });
  return out;
}

function renderNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(normalizeText(node.nodeValue ?? ''));
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP.has(tag)) return '';
  // WeChat hides the odd fragment rather than removing it; what the reader
  // never saw does not belong in the draft either
  if ((el as HTMLElement).style?.display === 'none') return '';

  if (tag in HEADINGS) {
    const text = renderChildren(el, ctx).replace(/\s+/g, ' ').trim();
    return text ? `\n\n${'#'.repeat(HEADINGS[tag])} ${text}\n\n` : '';
  }

  switch (tag) {
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
      return text ? `**${text}**` : '';
    }
    case 'EM':
    case 'I': {
      const text = renderChildren(el, ctx).trim();
      return text ? `*${text}*` : '';
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
function toMarkdown(content: Element, base: string): string {
  return renderNode(content, { base })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
