/**
 * Markdown → fully inline-styled HTML renderer.
 *
 * Every open/close rule in markdown-it (footnotes included) is overridden so
 * each element emits its own inline style and no CSS class at all — preview and
 * export share one piece of HTML, and pasting into WeChat loses nothing.
 * The theme arrives through markdown-it's env and each rule reads from it.
 */
import MarkdownIt from 'markdown-it';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItMark from 'markdown-it-mark';
import type { HLJSApi } from 'highlight.js';
import { applyDensity, getTheme, type DensityScale, type Theme, st } from './theme';
import { parseFrontMatter, type FrontMatter } from './frontMatter';

/**
 * Lazy-loaded highlight.js.
 *
 * `common` carries 30+ language definitions (still hundreds of KB minified),
 * and pulling all of it into the first-paint bundle slows a cold start for a
 * document that usually has no code block in view. So it is a dynamic import:
 * until it is ready, code blocks render as escaped source (same layout, just no
 * color), and once it is, the caller (App) triggers one re-render to fill the
 * highlighting in.
 */
let hljs: HLJSApi | null = null;
let hljsLoading: Promise<void> | null = null;

/** Whether the highlighter is ready (for the synchronous render path) */
export function isHighlighterReady(): boolean {
  return hljs !== null;
}

/** Trigger or await the highlighter load; repeat calls share one Promise */
export function ensureHighlighter(): Promise<void> {
  if (hljs) return Promise.resolve();
  if (!hljsLoading) {
    hljsLoading = import('highlight.js/lib/common')
      .then((m) => {
        hljs = m.default;
      })
      .catch(() => {
        // Load failed: keep rendering without highlighting, the body is unaffected
        hljsLoading = null;
      });
  }
  return hljsLoading;
}

/** The Token fields the render rules actually use (a structural subset of
 *  markdown-it's Token) */
interface Token {
  tag: string;
  type: string;
  level: number;
  content: string;
  /** Fence language tag (the info string, e.g. the ts in "```ts") */
  info?: string;
  /** Source line range [start, end], supplied by markdown-it for scroll sync */
  map: [number, number] | null;
  /** markdown-it hides the paragraphs of a tight list; its own renderToken
   *  drops them, and every rule overridden here has to do the same */
  hidden?: boolean;
  /** meta.tip: a callout blockquote; meta.title: its title (absent when untitled) */
  meta: { id?: number; subId?: number; name?: string; tip?: boolean; title?: string } | null;
  attrGet(name: string): string | null;
}

interface Env {
  theme: Theme;
  /** Local image registry: file name → data URI (for Obsidian ![[name]] embeds) */
  images?: Record<string, string>;
  /** Whether rendering is currently inside a footnote item (to skip the
   *  plugin's paragraph wrapper) */
  footnote?: boolean;
  /**
   * Where in the document the renderer currently is.
   *
   * markdown-it hands every rule one token and no context, which is fine while
   * a theme is only colours — but a section number has to know how many
   * sections came before it, an alternating row has to know which row it is,
   * and a paragraph inside a pull quote has to know that it is inside one. All
   * of that is counted here as the token stream goes by, and reset per render.
   */
  flow?: Flow;
}

/** Running state through one render (see Env.flow) */
interface Flow {
  /** h2s seen so far, for `numbered` headings */
  section: number;
  /** Enclosing blockquotes, innermost last */
  quotes: QuoteFrame[];
  /** Enclosing lists, innermost last */
  lists: ListFrame[];
  /** Body rows since the last table_open, for `striped` tables */
  row: number;
  /** Inside a thead (whose rows are never striped) */
  head: boolean;
  /** Whether the document's single 导语 (intro) card has already been emitted */
  introDone: boolean;
}

interface QuoteFrame {
  /** A callout renders on its own terms and ignores quote.style */
  tip: boolean;
  style: 'bar' | 'card' | 'bracket' | 'pull' | 'intro';
  /** Font size a pull quote imposes on the paragraphs inside it */
  fontSize?: string;
}

interface ListFrame {
  ordered: boolean;
  /** Number of the item last emitted (ordered lists only) */
  n: number;
  /** Task lists draw ☑ / ☐ and take no marker of their own */
  task: boolean;
  /** Whether this list draws its own markers rather than the browser's */
  own: boolean;
}

const newFlow = (): Flow => ({ section: 0, quotes: [], lists: [], row: 0, head: false, introDone: false });

/** The flow state, created on first use so every rule can assume it exists */
function flow(env: Env): Flow {
  if (!env.flow) env.flow = newFlow();
  return env.flow;
}

/** Multiply a px value ('16px' → '18px'). Used where a theme scales one of its
 *  own sizes rather than naming a second one */
function scalePx(value: string, k: number): string {
  const n = parseFloat(value);
  return Number.isFinite(n) ? `${Math.round(n * k * 100) / 100}px` : value;
}

type RenderRule = (tokens: Token[], idx: number, options: unknown, env: Env) => string;

const md = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
  typographer: false,
});
md.use(markdownItFootnote);
md.use(markdownItMark);

/* Obsidian image embed: ![[file name]] → an image from the local registry;
   unregistered names render a placeholder notice */
md.inline.ruler.before('image', 'obsidian_embed', (state: any, silent: boolean) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x21 /* ! */) return false;
  if (state.src.slice(start, start + 3) !== '![[') return false;
  const end = state.src.indexOf(']]', start + 3);
  if (end < 0) return false;
  if (!silent) {
    const name = state.src.slice(start + 3, end).trim();
    const token = state.push('obsidian_embed', 'span', 0);
    token.meta = { name };
    token.content = name;
  }
  state.pos = end + 2;
  return true;
});

/**
 * Scan from just past `(` for the matching `)` and return what is between.
 * Balanced parentheses inside the target are allowed (`screenshot (1).png`);
 * it does not cross lines, and returns null when there is no match.
 */
function scanParen(text: string, openAt: number): { inner: string; end: number } | null {
  let depth = 1;
  for (let i = openAt + 1; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0a) return null;
    if (ch === 0x28) depth++;
    else if (ch === 0x29) {
      depth--;
      if (depth === 0) return { inner: text.slice(openAt + 1, i), end: i };
    }
  }
  return null;
}

/** Split `dest "title"` into its two parts (the title may be absent) */
function splitDestTitle(inner: string): { dest: string; title: string } {
  const trimmed = inner.trim();
  const m = trimmed.match(/^([\s\S]*?)\s+(["'])([\s\S]*?)\2$/);
  if (m) return { dest: m[1].trim(), title: m[3] };
  return { dest: trimmed, title: '' };
}

/*
 * Native image syntax with spaces in the file name: `![](Grok 4.6 review.png)`.
 *
 * CommonMark says an unbracketed link destination cannot contain spaces, so
 * markdown-it treats the whole thing as plain text and the image never renders —
 * but screenshot file names with spaces are extremely common in Obsidian and
 * Typora.
 * This rule only takes over the cases where the standard syntax is guaranteed
 * to fail (a destination with spaces and no angle brackets); everything else is
 * handed straight back to the built-in rule.
 */
md.inline.ruler.before('image', 'image_spaced', (state: any, silent: boolean) => {
  const src: string = state.src;
  const start: number = state.pos;
  if (src.charCodeAt(start) !== 0x21 /* ! */) return false;
  if (src.charCodeAt(start + 1) !== 0x5b /* [ */) return false;
  if (src.charCodeAt(start + 2) === 0x5b /* [ */) return false; // ![[ ]] belongs to obsidian_embed
  const labelEnd = src.indexOf(']', start + 2);
  if (labelEnd < 0) return false;
  if (src.charCodeAt(labelEnd + 1) !== 0x28 /* ( */) return false;
  const paren = scanParen(src, labelEnd + 1);
  if (!paren) return false;
  if (paren.inner.trim().startsWith('<')) return false; // the angle-bracket form is handled by the built-in rule
  const { dest, title } = splitDestTitle(paren.inner);
  if (!dest || !/\s/.test(dest)) return false; // no spaces in the destination ⇒ the built-in rule already works
  if (!silent) {
    const token = state.push('image', 'img', 0);
    token.attrs = title
      ? [['src', dest], ['alt', ''], ['title', title]]
      : [['src', dest], ['alt', '']];
    token.content = src.slice(start + 2, labelEnd);
    token.children = [];
  }
  state.pos = paren.end + 1;
  return true;
});

const esc = md.utils.escapeHtml;

/* ---------------- Block level ---------------- */

/**
 * Headings, and the widest structural choice a theme makes.
 *
 * Three of the decorations cannot be expressed as style on the heading alone:
 * `marker` and `numbered` put an element *before* the text, and `center-rule`
 * needs a rule as wide as the text rather than as wide as the column, which
 * means an inline-block wrapper around the content. So this rule may open more
 * than the tag, and heading_close reads the same theme to close what it opened.
 */
md.renderer.rules.heading_open = ((tokens, idx, _o, env) => {
  const th = env.theme;
  const tag = tokens[idx].tag;
  const h = th.heading;
  const styles: Record<string, string> = {
    'font-family': h.font,
    'font-weight': h.fontWeight,
    color: h.color,
    'font-size': th.headingSizes[tag as keyof typeof th.headingSizes] ?? th.headingSizes.h3,
    'line-height': h.lineHeight,
    'margin-top': idx === 0 ? '0' : h.marginTop,
    'margin-bottom': h.marginBottom,
  };
  if (h.letterSpacing) styles['letter-spacing'] = h.letterSpacing;
  const decor = h.decor ?? 'none';
  if (h.align === 'center' || decor === 'center-rule') styles['text-align'] = 'center';
  if (decor === 'accent-bar' && idx > 0) {
    styles['border-top'] = `3px solid ${th.accent}`;
    styles['padding-top'] = '10px';
  } else if (decor === 'underline') {
    styles['border-bottom'] = `2px solid ${th.accent}`;
    styles['padding-bottom'] = '6px';
  } else if (decor === 'rule') {
    // Magazine-weight rule: a heavier division of the page
    styles['border-bottom'] = `3px solid ${th.accent}`;
    styles['padding-bottom'] = '8px';
    styles['display'] = 'inline-block';
  } else if (decor === 'band') {
    styles['background'] = th.accentSoft ?? 'rgba(217,119,87,.12)';
    styles['padding'] = '4px 10px';
    styles['border-radius'] = '6px';
  } else if (decor === 'left-bar') {
    styles['border-left'] = `4px solid ${th.accent}`;
    styles['padding-left'] = '12px';
  } else if (decor === 'boxed') {
    styles['border'] = `2px solid ${th.accent}`;
    styles['padding'] = '6px 14px';
    styles['border-radius'] = '4px';
    styles['display'] = 'inline-block';
  }
  // Source-line anchors for scroll sync (map is 0-based, CodeMirror line
  // numbers are 1-based, hence the +1)
  const line = tokens[idx].map?.[0];
  let out = `<${tag}${line != null ? ` data-line="${line}"` : ''} style="${st(styles)}">`;
  if (decor === 'numbered' && tag === 'h2') {
    // Only h2 is numbered: it is the section level in a WeChat article, and
    // numbering every level turns a heading into a table of contents entry
    const n = String(++flow(env).section).padStart(2, '0');
    out += `<span style="${st({
      color: th.accent,
      'font-weight': '700',
      'margin-right': '10px',
      'letter-spacing': '0.02em',
    })}">${n}</span>`;
  } else if (decor === 'marker') {
    out += `<span style="${st({ color: th.accent, 'margin-right': '8px' })}">${esc(
      h.markerGlyph ?? '▍',
    )}</span>`;
  } else if (decor === 'center-rule') {
    out += `<span style="${st({
      display: 'inline-block',
      'border-bottom': `2px solid ${th.accent}`,
      'padding-bottom': '7px',
    })}">`;
  }
  return out;
}) as RenderRule;

md.renderer.rules.heading_close = ((tokens, idx, _o, env) => {
  const decor = env.theme.heading.decor ?? 'none';
  return `${decor === 'center-rule' ? '</span>' : ''}</${tokens[idx].tag}>`;
}) as RenderRule;

md.renderer.rules.paragraph_open = ((tokens, idx, _o, env) => {
  // The footnote content paragraph was already opened by footnote_open, so skip
  // the plugin's paragraph wrapper
  if (env.footnote) return '';
  // A tight list's paragraphs are marked hidden by markdown-it, and its own
  // renderToken drops them — but overriding this rule bypasses that check, so
  // it has to be made here. Without it every list item holds a block-level
  // paragraph, which is what pushed a theme's own bullet onto a line of its own
  if (tokens[idx].hidden) return '';
  const th = env.theme;
  const b = th.body;
  const nested = tokens[idx].level > 0;
  const line = tokens[idx].map?.[0];
  const dl = line != null ? ` data-line="${line}"` : '';
  if (nested) {
    // Inside a list item, a table cell or a quote. A pull quote is the one
    // container that imposes its own size and alignment on what it holds —
    // otherwise the paragraph would quietly reset the size the quote just set
    const quote = flow(env).quotes[flow(env).quotes.length - 1];
    const pull = quote && !quote.tip && quote.style === 'pull';
    // A loose list (blank lines between the items) keeps its paragraphs, and
    // the first of them has a marker sitting to its left; as a block it would
    // start on the line below it
    const list = flow(env).lists[flow(env).lists.length - 1];
    const afterMarker = !!list?.own && tokens[idx - 1]?.type === 'list_item_open';
    return `<p${dl} style="${st({
      'font-family': b.font,
      'font-size': pull ? quote.fontSize ?? b.fontSize : b.fontSize,
      'line-height': b.lineHeight,
      color: 'inherit',
      margin: '0',
      ...(afterMarker ? { display: 'inline' } : {}),
      ...(pull ? { 'text-align': 'center' } : {}),
    })}">`;
  }
  return `<p${dl} style="${st({
    'font-family': b.font,
    'font-size': b.fontSize,
    'line-height': b.lineHeight,
    color: b.color,
    margin: `0 0 ${th.pMargin}`,
    // Two-character first-line indent, the way Chinese prose is set on paper.
    // Only top-level paragraphs take it: an indented list item or table cell
    // reads as a mistake
    ...(b.indent ? { 'text-indent': '2em' } : {}),
    ...(b.align === 'justify' ? { 'text-align': 'justify' } : {}),
  })}">`;
}) as RenderRule;

md.renderer.rules.paragraph_close = ((tokens, idx, _o, env) => {
  if (env.footnote) return '';
  if (tokens[idx].hidden) return '';
  return '</p>';
}) as RenderRule;

const listOpen =
  (ordered: boolean): RenderRule =>
  (tokens, idx, _o, env) => {
    const b = env.theme.body;
    const tag = ordered ? 'ol' : 'ul';
    // Task-list detection: preprocess has already turned `- [x]` into ☑/☐, and
    // a list item's content sits inside an inline token, so scan forward to the
    // first inline to decide

    let isTask = false;
    for (let i = idx + 1; i < Math.min(idx + 8, tokens.length); i++) {
      const t = tokens[i];
      if (t.type === 'bullet_list_close') break;
      if (t.type === 'inline' && /^[☑☐]/.test(t.content)) {
        isTask = true;
        break;
      }
    }
    const styles: Record<string, string> = {
      'font-family': b.font,
      'font-size': b.fontSize,
      'line-height': b.lineHeight,
      color: b.color,
      'padding-left': env.theme.listPaddingLeft,
      margin: tokens[idx].level > 0 ? '0' : `0 0 ${env.theme.pMargin}`,
    };
    // Does this theme draw its own markers? A theme that names neither a
    // bullet nor a number style keeps the browser's, which is where every
    // theme started
    const list = env.theme.list;
    const own =
      !isTask &&
      (ordered ? (list?.ordered ?? 'plain') !== 'plain' : !!list?.bullet);
    if (isTask) {
      // Task list: no bullet (matching real WeChat styling), with the symbol
      // carrying the left indent
      styles['list-style'] = 'none';
      styles['padding-left'] = '8px';
    } else if (own) {
      styles['list-style'] = 'none';
    }
    const start = ordered ? parseInt(tokens[idx].attrGet('start') ?? '1', 10) : 1;
    flow(env).lists.push({
      ordered,
      n: (Number.isFinite(start) ? start : 1) - 1,
      task: isTask,
      own,
    });
    return `<${tag} style="${st(styles)}">`;
  };

md.renderer.rules.bullet_list_open = listOpen(false);
md.renderer.rules.ordered_list_open = listOpen(true);
const listClose =
  (tag: string): RenderRule =>
  (_t, _i, _o, env) => {
    flow(env).lists.pop();
    return `</${tag}>`;
  };
md.renderer.rules.bullet_list_close = listClose('ul');
md.renderer.rules.ordered_list_close = listClose('ol');

/**
 * List items, with the markers a theme draws itself.
 *
 * The browser's own bullet cannot be coloured, sized or replaced from an
 * inline style, and WeChat drops `list-style-type` with a string in it — so a
 * theme that wants its own marker gets a real element instead. The hanging
 * indent that keeps a wrapped second line under the first is the pair of
 * `text-indent: -Xem` on the item and a marker box exactly X wide.
 */
md.renderer.rules.list_item_open = ((tokens, idx, _o, env) => {
  const th = env.theme;
  const line = tokens[idx].map?.[0];
  const dl = line != null ? ` data-line="${line}"` : '';
  const frame = flow(env).lists[flow(env).lists.length - 1];
  if (!frame?.own) {
    return `<li${dl} style="${st({ margin: th.listItemMargin })}">`;
  }

  const kind = th.list?.ordered ?? 'plain';
  const pill = frame.ordered && kind === 'pill';
  const box = frame.ordered ? (pill ? '2em' : '1.8em') : '1.4em';
  const color = th.list?.bulletColor ?? th.accent;
  const label = frame.ordered ? `${(frame.n += 1)}` : (th.list?.bullet ?? '•');

  const marker = pill
    ? `<span style="${st({
        display: 'inline-block',
        'min-width': '1.35em',
        'text-align': 'center',
        'border-radius': '999px',
        background: color,
        color: th.body.bg ?? '#ffffff',
        'font-size': '0.8em',
        'font-weight': '700',
        padding: '0.1em 0',
        'vertical-align': '0.06em',
      })}">${esc(label)}</span>`
    : `${esc(label)}${frame.ordered ? '.' : ''}`;

  return (
    `<li${dl} style="${st({ margin: th.listItemMargin, 'text-indent': `-${box}` })}">` +
    // text-indent inherits into a block container, so the marker box has to
    // put it back to zero or the marker itself is dragged left as well
    `<span style="${st({
      display: 'inline-block',
      width: box,
      'text-indent': '0',
      color: pill ? 'inherit' : color,
      ...(frame.ordered && !pill ? { 'font-weight': '700' } : {}),
    })}">${marker}</span>`
  );
}) as RenderRule;
md.renderer.rules.list_item_close = (() => '</li>') as RenderRule;

/**
 * Callouts: preprocess expands `> [!tip] Title` into a `> <!--TIP:Title-->`
 * marker line. That marker is its own html_block token at the head of the
 * blockquote's content.
 * The core rule flags the enclosing blockquote as a tip (so it renders with
 * callout styling), hides the marker line itself, and stores the title in meta
 * for rendering.
 */
md.core.ruler.push('tip_callout', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'html_block') continue;
    const m = t.content.match(/^<!--TIP:(.*)-->\n?$/s);
    if (!m) continue;
    const bq = i > 0 && tokens[i - 1].type === 'blockquote_open' ? tokens[i - 1] : null;
    if (!bq) continue;
    const title = m[1].trim().replace(/&#45;/g, '-');
    bq.meta = { ...(bq.meta ?? {}), tip: true, ...(title ? { title } : {}) };
    t.content = ''; // hide the marker line
  }
  return state;
});

md.renderer.rules.blockquote_open = ((tokens, idx, _o, env) => {
  const th = env.theme;
  const line = tokens[idx].map?.[0];
  const tip = tokens[idx].meta?.tip;
  if (tip) {
    // Callout: rendered wholesale from the callout tokens (border, fill,
    // radius, margins)
    const c = th.callout;
    flow(env).quotes.push({ tip: true, style: 'bar' });
    const title = tokens[idx].meta?.title;
    let s = `<blockquote data-tip${line != null ? ` data-line="${line}"` : ''} style="${st({
      'border-left': c.borderLeft,
      background: c.background,
      color: c.color,
      'border-radius': c.borderRadius,
      padding: c.padding,
      margin: c.margin,
      ...(c.extra ?? {}),
    })}">`;
    if (title) {
      s += `<span style="${st({
        display: 'block',
        'font-weight': '700',
        color: c.badgeColor ?? th.accent,
        'margin-bottom': '8px',
      })}">${esc(title)}</span>`;
    }
    return s;
  }
  // Front-matter intro: the first non-callout blockquote becomes the 导语 card.
  if (th.components?.frontMatter && !flow(env).introDone) {
    flow(env).introDone = true;
    flow(env).quotes.push({ tip: false, style: 'intro' });
    return introCardOpen(th, line);
  }
  const q = th.quote;
  const style = q.style ?? 'bar';
  const marks = q.markGlyph ?? (style === 'bracket' ? '「」' : '“');
  const pullSize = scalePx(th.body.fontSize, 1.14);
  flow(env).quotes.push({ tip: false, style, fontSize: pullSize });

  // Each shape keeps only the theme values it can honour: a pull quote has no
  // fill to take a background, and a bracketed quote has no rule to take a
  // border. Handing them the unused value anyway is what made every quote in
  // every theme the same rectangle with a coloured edge
  const shape: Record<string, string> =
    style === 'card'
      ? {
          background: q.background,
          'border-radius': q.borderRadius,
          padding: q.padding,
        }
      : style === 'bracket'
        ? { padding: '0 4px' }
        : style === 'pull'
          ? {
              'border-top': `2px solid ${th.accent}`,
              'border-bottom': `2px solid ${th.accent}`,
              padding: '18px 4px',
              'text-align': 'center',
              'font-size': pullSize,
            }
          : {
              'border-left': q.borderLeft,
              background: q.background,
              'border-radius': q.borderRadius,
              padding: q.padding,
            };

  let s = `<blockquote${line != null ? ` data-line="${line}"` : ''} style="${st({
    ...shape,
    color: q.color,
    margin: q.margin,
    ...(q.fontStyle ? { 'font-style': q.fontStyle } : {}),
    ...(q.extra ?? {}),
  })}">`;
  if (style === 'bracket') {
    // The opening bracket takes a line of its own, and the closing one the
    // line after the text: a quote mark cannot sit inline with a paragraph
    // that is a block of its own, and half a bracket floating beside the first
    // line reads as a typo rather than as punctuation
    s += `<span style="${st({
      display: 'block',
      color: th.accent,
      'font-size': scalePx(th.body.fontSize, 1.6),
      'line-height': '1',
      'margin-bottom': '4px',
    })}">${esc(marks.slice(0, 1))}</span>`;
  } else if (q.bigMark) {
    s += `<span style="${st({
      'font-family': 'Georgia, serif',
      'font-size': '26px',
      'line-height': '0',
      color: th.accent,
      'margin-right': '6px',
      'vertical-align': '-4px',
    })}">${esc(marks.slice(0, 1))}</span>`;
  }
  return s;
}) as RenderRule;

md.renderer.rules.blockquote_close = ((_t, _i, _o, env) => {
  const frame = flow(env).quotes.pop();
  const th = env.theme;
  if (frame?.style === 'intro') return introCardClose();
  if (!frame || frame.tip || frame.style !== 'bracket') return '</blockquote>';
  const marks = th.quote.markGlyph ?? '「」';
  return `<span style="${st({
    display: 'block',
    color: th.accent,
    'font-size': scalePx(th.body.fontSize, 1.6),
    'line-height': '1',
    'text-align': 'right',
    'margin-top': '4px',
  })}">${esc(marks.slice(-1))}</span></blockquote>`;
}) as RenderRule;

/** Turn hljs's <span class="hljs-xxx"> output into inline color (so a WeChat
 *  paste loses nothing), leaving non-highlight tags as they are.
 *  palette: theme.codePalette (token class → color) */

function inlineHighlight(html: string, palette: Record<string, string>): string {
  return html.replace(/<span class="([^"]+)">/g, (_m, cls: string) => {
    const tokens = cls.split(/\s+/);
    let color = '';
    for (const t of tokens) {
      if (palette[t]) {
        color = palette[t];
        break;
      }
    }
    return color ? `<span style="color:${color}">` : '<span>';
  });
}

/**
 * Split highlighted HTML by line: span tags close at the end of each line and
 * reopen on the next.
 * A WeChat paste breaks the \n inside a <pre> into separate paragraphs, which
 * mangles the line breaks and loses content. A per-line block <code> contains
 * no bare \n, so there is nothing to break.
 */
function splitCodeLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  let hasText = false;
  const flush = () => {
    const body = cur + open.map(() => '</span>').join('');
    lines.push(hasText ? body : '&nbsp;');
    cur = open.join('');
    hasText = false;
  };
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) open.pop();
      else open.push(tag);
      cur += tag;
      i = end + 1;
    } else if (ch === '\n') {
      flush();
      i++;
    } else {
      cur += ch;
      // A per-character regex (/\s/) is measurably expensive on a long code
      // block, so compare whitespace characters directly
      if (ch !== ' ' && ch !== '\t' && ch !== '\r') hasText = true;
      i++;
    }
  }
  if (cur && (hasText || lines.length === 0)) flush();
  return lines;
}

/**
 * Highlight cache (LRU).
 *
 * Every keystroke re-renders the whole article, so the same block of code gets
 * tokenized over and over — and highlighting is the most expensive step in a
 * render. This caches hljs's raw (class-based) output by (language, source),
 * leaving the theme-dependent inline coloring (inlineHighlight) outside the
 * cache, so switching themes does not re-tokenize anything.
 */
const HL_CACHE_MAX = 128;
const hlCache = new Map<string, string>();

/** The class-based highlighted HTML; null when there is no language tag, the
 *  highlighter is not ready, or highlighting failed */
function highlightCached(code: string, lang: string): string | null {
  if (!lang || !hljs) return null;
  const key = `${lang}\u0000${code}`;
  const hit = hlCache.get(key);
  if (hit !== undefined) {
    // On a hit, move to the tail to maintain LRU order
    hlCache.delete(key);
    hlCache.set(key, hit);
    return hit;
  }
  let out: string;
  try {
    out = hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : // The language tag exists but is not registered: fall back to auto-detection
        hljs.highlightAuto(code).value;
  } catch {
    return null;
  }
  hlCache.set(key, out);
  if (hlCache.size > HL_CACHE_MAX) hlCache.delete(hlCache.keys().next().value as string);
  return out;
}

const renderCode: RenderRule = (tokens, idx, _o, env) => {
  const c = env.theme.codeBlock;
  const raw = tokens[idx].content;
  const lang = (tokens[idx].info || '').trim().split(/\s+/)[0];
  const highlighted = highlightCached(raw, lang);
  const inner = highlighted !== null ? inlineHighlight(highlighted, env.theme.codePalette) : esc(raw);
  const line = tokens[idx].map?.[0];
  // Every line takes the same style, so compute it once outside the loop (which
  // saves hundreds of string concatenations on a long block)
  const lineStyle = st({
    display: 'block',
    'font-family': env.theme.mono,
    'font-size': c.fontSize,
    'line-height': c.lineHeight,
    color: 'inherit',
    'white-space': 'pre',
  });
  // Per-line block <code>: no bare \n, so a WeChat paste cannot break lines or
  // drop content
  const linesHtml = splitCodeLines(inner)
    .map((l) => `<code style="${lineStyle}">${l}</code>`)
    .join('');
  // Window chrome. Both forms are a real element inside the <pre> rather than
  // anything positioned: a code block is a rectangle of monospace in every
  // theme, and this is the cheapest thing that tells two of them apart
  const chrome = c.chrome ?? 'none';
  let head = '';
  if (chrome === 'dots') {
    const dot = (fill: string, first: boolean) =>
      `<span style="${st({ color: fill, ...(first ? {} : { 'margin-left': '7px' }) })}">●</span>`;
    head = `<span style="${st({ display: 'block', 'line-height': '1', 'margin-bottom': '12px' })}">${dot('#ff5f56', true)}${dot('#ffbd2e', false)}${dot('#27c93f', false)}</span>`;
  } else if (chrome === 'lang' && lang) {
    head = `<span style="${st({
      display: 'block',
      'text-align': 'right',
      'font-family': env.theme.mono,
      'font-size': '11px',
      'letter-spacing': '0.12em',
      color: env.theme.codePalette['hljs-comment'] ?? c.color,
      'margin-bottom': '8px',
    })}">${esc(lang.toUpperCase())}</span>`;
  }
  return `<pre${line != null ? ` data-line="${line}"` : ''} style="${st({
    background: c.background,
    color: c.color,
    'border-radius': c.borderRadius,
    padding: c.padding,
    'overflow-x': 'auto',
    margin: `0 0 ${env.theme.pMargin}`,
    'font-family': env.theme.mono,
    'font-size': c.fontSize,
    'line-height': c.lineHeight,
    ...(c.extra ?? {}),
  })}">${head}${linesHtml}</pre>`;
};
md.renderer.rules.fence = renderCode;
md.renderer.rules.code_block = renderCode;

/**
 * The divider — a whole sentence of punctuation in a long article, and until
 * now a 1px line in every theme.
 *
 * `glyph` is not an <hr> at all but a centred ornament, which is how most
 * Chinese magazine layouts break a section.
 */
md.renderer.rules.hr = ((_t, _i, _o, env) => {
  const h = env.theme.hr;
  const style = h.style ?? 'line';
  if (style === 'glyph') {
    return `<p style="${st({
      margin: h.margin,
      'text-align': 'center',
      color: env.theme.accent,
      'font-size': scalePx(env.theme.body.fontSize, 1.05),
      'letter-spacing': '0.5em',
      // The tracking pushes the ornament off-centre by half a step; the padding
      // gives it back
      'padding-left': '0.5em',
      'line-height': '1',
    })}">${esc(h.glyph ?? '❋')}</p>`;
  }
  const width = h.width ?? '100%';
  // 'double' collapses into a single line under 3px — the two rules and the gap
  // between them need somewhere to be
  const weight = style === 'double' ? '3px' : '1px';
  return `<hr style="${st({
    border: 'none',
    'border-top': `${weight} ${style} ${h.color}`,
    margin: width === '100%' ? h.margin : `${h.margin.trim().split(/\s+/)[0]} auto`,
    ...(width === '100%' ? {} : { width }),
  })}" />`;
}) as RenderRule;

/* ---------------- Tables ---------------- */

md.renderer.rules.table_open = ((_t, _i, _o, env) => {
  const b = env.theme.body;
  const f = flow(env);
  f.row = 0;
  f.head = false;
  return `<table style="${st({
    'font-family': b.font,
    'font-size': env.theme.table.fontSize,
    'line-height': b.lineHeight,
    color: b.color,
    'border-collapse': 'collapse',
    width: '100%',
    margin: `0 0 ${env.theme.pMargin}`,
  })}">`;
}) as RenderRule;

md.renderer.rules.thead_open = ((_t, _i, _o, env) => {
  flow(env).head = true;
  return '<thead>';
}) as RenderRule;

md.renderer.rules.thead_close = ((_t, _i, _o, env) => {
  flow(env).head = false;
  return '</thead>';
}) as RenderRule;

/** Alternate body rows get the stripe fill; the head is never striped, and a
 *  theme that did not ask for stripes gets a plain <tr> */
md.renderer.rules.tr_open = ((_t, _i, _o, env) => {
  const tb = env.theme.table;
  const f = flow(env);
  if (f.head) return '<tr>';
  const odd = ++f.row % 2 === 0;
  if ((tb.style ?? 'grid') !== 'striped' || !odd) return '<tr>';
  return `<tr style="${st({ background: tb.stripeBg ?? tb.headBg })}">`;
}) as RenderRule;

/** Cell borders. `grid` rules every side, the other two keep the horizontal
 *  lines only — which is what separates a spreadsheet from a printed table */
function cellBorder(tb: Theme['table'], head: boolean): Record<string, string> {
  if ((tb.style ?? 'grid') === 'grid') return { border: `1px solid ${tb.borderColor}` };
  return {
    border: 'none',
    'border-bottom': `${head ? '2px' : '1px'} solid ${tb.borderColor}`,
  };
}

md.renderer.rules.th_open = ((_t, _i, _o, env) => {
  const th = env.theme;
  const tb = th.table;
  // `minimal` drops the head fill — the heavy rule under it is the division
  // already. Its text colour has to go with it: headColor was picked to read
  // *on* headBg, and several themes make it light enough to vanish on paper
  const bare = (tb.style ?? 'grid') === 'minimal';
  return `<th style="${st({
    ...cellBorder(tb, true),
    padding: tb.cellPadding,
    'text-align': 'left',
    'font-weight': '700',
    ...(bare ? {} : { background: tb.headBg }),
    color: bare ? th.heading.color : tb.headColor,
  })}">`;
}) as RenderRule;

md.renderer.rules.td_open = ((_t, _i, _o, env) => {
  const tb = env.theme.table;
  return `<td style="${st({
    ...cellBorder(tb, false),
    padding: tb.cellPadding,
  })}">`;
}) as RenderRule;

/* ---------------- Inline ---------------- */

md.renderer.rules.code_inline = ((tokens, idx, _o, env) => {
  const c = env.theme.code;
  return `<code style="${st({
    background: c.background,
    color: c.color,
    'border-radius': c.borderRadius,
    padding: c.padding,
    'font-family': env.theme.mono,
    'font-size': c.fontSize,
    ...(c.extra ?? {}),
  })}">${esc(tokens[idx].content)}</code>`;
}) as RenderRule;

md.renderer.rules.strong_open = ((_t, _i, _o, env) =>
  `<strong style="${st({ 'font-weight': '700', color: env.theme.strongColor })}">`) as RenderRule;
md.renderer.rules.strong_close = (() => '</strong>') as RenderRule;

md.renderer.rules.em_open = (() => '<em style="font-style: italic;">') as RenderRule;
md.renderer.rules.em_close = (() => '</em>') as RenderRule;

md.renderer.rules.del_open = ((_t, _i, _o, env) =>
  `<del style="${st({ color: env.theme.delColor })}">`) as RenderRule;
md.renderer.rules.del_close = (() => '</del>') as RenderRule;

/* ==mark== highlight (markdown-it-mark) */
md.renderer.rules.mark_open = ((_t, _i, _o, env) => {
  const m = env.theme.mark;
  // olive-journal asks for an orange underline instead of a tinted box
  if (m.underline) {
    return `<mark style="${st({
      'border-bottom': `2px solid ${m.borderColor ?? '#ed7b2f'}`,
      'font-weight': '600',
      color: m.color,
      'background': 'transparent',
      'border-radius': '0',
      padding: '0',
    })}">`;
  }
  return `<mark style="${st({
    background: m.background,
    color: m.color,
    'border-radius': m.borderRadius,
    padding: m.padding,
  })}">`;
}) as RenderRule;
md.renderer.rules.mark_close = (() => '</mark>') as RenderRule;

md.renderer.rules.link_open = ((tokens, idx, _o, env) => {
  const l = env.theme.link;
  const href = esc(tokens[idx].attrGet('href') ?? '');
  return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="${st({
    color: l.color,
    'text-decoration': l.textDecoration,
    'word-break': 'break-all',
  })}">`;
}) as RenderRule;
md.renderer.rules.link_close = (() => '</a>') as RenderRule;

/** Absolute addresses (protocol-relative, data and blob included) are used
 *  as-is, without consulting the image library */
function isAbsoluteUrl(src: string): boolean {
  return /^(?:https?:)?\/\//i.test(src) || /^(?:data|blob):/i.test(src);
}

/**
 * Resolve a local relative path against the image library's data URIs.
 *
 * Two things to watch:
 * - markdown-it percent-encodes src, so a non-ASCII file name arrives as
 *   %E5%9B%BE… and has to be decoded first;
 * - Obsidian and Typora commonly write paths like `assets/figure.png`, while
 *   the library is keyed by file name only, so fall back to the basename and
 *   look again.
 */
function lookupLocalImage(src: string, images?: Record<string, string>): string | null {
  if (!images || !src) return null;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // Malformed encoding: use the original value
  }
  for (const candidate of [decoded, src]) {
    if (images[candidate]) return images[candidate];
    const base = candidate.split(/[\\/]/).pop() ?? candidate;
    if (images[base]) return images[base];
  }
  return null;
}

/** Normalize a local path into an image-library key (decode, drop directories) */
function localImageKey(src: string): string {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // Malformed encoding: use the original value
  }
  return decoded.split(/[\\/]/).pop() ?? decoded;
}

/**
 * Collect the local image file names a body references (both syntaxes count).
 *
 * "Is this image referenced" has to be decided by exactly the same rules the
 * renderer resolves with, or an image referenced with the native syntax would
 * read as unreferenced and get swept away by the cleanup button.
 */
export function collectImageRefs(markdown: string): Set<string> {
  const names = new Set<string>();
  // Obsidian embeds ![[name]]
  for (const m of markdown.matchAll(/!\[\[\s*([^\]\n]+?)\s*\]\]/g)) {
    names.add(m[1]);
    names.add(localImageKey(m[1]));
  }
  // Native syntax ![alt](src "title"): the same scanning rules as rendering, so
  // file names with spaces and parentheses are recognized too
  let i = 0;
  while (i < markdown.length) {
    const bang = markdown.indexOf('![', i);
    if (bang < 0) break;
    if (markdown.charCodeAt(bang + 2) === 0x5b) {
      i = bang + 2;
      continue;
    }
    const labelEnd = markdown.indexOf(']', bang + 2);
    if (labelEnd < 0) break;
    if (markdown.charCodeAt(labelEnd + 1) !== 0x28) {
      i = labelEnd + 1;
      continue;
    }
    const paren = scanParen(markdown, labelEnd + 1);
    if (!paren) {
      i = labelEnd + 1;
      continue;
    }
    const raw = paren.inner.trim().replace(/^<|>$/g, '');
    const { dest } = splitDestTitle(raw);
    if (dest && !isAbsoluteUrl(dest)) names.add(localImageKey(dest));
    i = paren.end + 1;
  }
  return names;
}

/** Whether a given line references a given image (for jump-to; same rules as above) */
export function lineReferencesImage(line: string, name: string): boolean {
  return collectImageRefs(line).has(name);
}

/** Placeholder shown when an image is missing (shared by both syntaxes) */
function missingImage(name: string, th: Theme): string {
  return `<span style="${st({
    display: 'block',
    border: `1px dashed ${th.hr.color}`,
    'border-radius': '8px',
    padding: '12px 14px',
    color: th.footnote.textColor,
    'font-size': '13px',
    margin: th.img.margin,
  })}">${esc(name)} — 本地图片库里没有这张图，把图片文件拖进左侧编辑器即可</span>`;
}

/** Render one image; with inline true it does not take a line of its own (an
 *  image mid-sentence should not break the sentence apart) */
function renderImg(src: string, alt: string, title: string | null, th: Theme, inline: boolean): string {
  const frame: Record<string, string> = th.img.frame ? { border: th.img.frame } : {};
  const style = inline
    ? st({
        'max-width': '100%',
        'border-radius': th.img.borderRadius,
        display: 'inline-block',
        'vertical-align': 'middle',
        ...frame,
      })
    : st({
        'max-width': '100%',
        'border-radius': th.img.borderRadius,
        display: 'block',
        // With a caption the wrapper carries the margin, or the gap between
        // picture and caption is the picture's own bottom margin
        margin: th.img.caption ? '0 auto' : th.img.margin,
        ...frame,
      });
  const img = `<img src="${esc(src)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''} style="${style}" />`;
  const caption = (title ?? alt).trim();
  if (inline || !th.img.caption || !caption) return img;
  return `<span style="${st({ display: 'block', margin: th.img.margin, 'text-align': 'center' })}">${img}<span style="${st(
    {
      display: 'block',
      'margin-top': '8px',
      'font-size': th.footnote.textSize,
      'line-height': '1.6',
      color: th.footnote.textColor,
    },
  )}">${esc(caption)}</span></span>`;
}

/** Anything else visible in the same inline container ⇒ this image sits inside
 *  running text */
function isInlineImage(tokens: Token[], idx: number): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (i === idx) continue;
    const t = tokens[i];
    if (t.type === 'image' || t.type === 'obsidian_embed') continue;
    if (t.type === 'softbreak' || t.type === 'hardbreak') continue;
    if (t.type === 'text') {
      if (t.content.trim()) return true;
      continue;
    }
    return true;
  }
  return false;
}

md.renderer.rules.image = ((tokens, idx, _o, env) => {
  const token = tokens[idx];
  const rawSrc = token.attrGet('src') ?? '';
  const alt = token.content;
  const title = token.attrGet('title');
  const inline = isInlineImage(tokens, idx);
  if (isAbsoluteUrl(rawSrc)) {
    return renderImg(rawSrc, alt, title, env.theme, inline);
  }
  // Relative path: look it up in the local library by file name, so ![](x.png)
  // and ![[x.png]] behave identically
  const local = lookupLocalImage(rawSrc, env.images);
  if (local) return renderImg(local, alt || rawSrc, title, env.theme, inline);
  if (!rawSrc) return '';
  let label = rawSrc;
  try {
    label = decodeURIComponent(rawSrc);
  } catch {
    // Keep the original value
  }
  return missingImage(label, env.theme);
}) as RenderRule;

md.renderer.rules.obsidian_embed = ((tokens, idx, _o, env) => {
  const name = tokens[idx].meta?.name ?? tokens[idx].content ?? '';
  const uri = env.images?.[name] ?? lookupLocalImage(name, env.images);
  if (uri) return renderImg(uri, name, null, env.theme, isInlineImage(tokens, idx));
  return missingImage(name, env.theme);
}) as RenderRule;

/* ---------------- Footnotes ---------------- */

/*
 * A footnote reference renders as a superscript number only, never wrapped in
 * <a href="#fnN">.
 *
 * A WeChat body does not support in-page anchor jumps at all, so that link does
 * nothing when tapped. Worse, the drafts API rejects an <a> with a # anchor as
 * "invalid content" (45166) and the whole piece fails to push — external links
 * are fine, oddly enough.
 * Preview and export share this rendering, so both agree: keep the number, drop
 * the link.
 */
md.renderer.rules.footnote_ref = ((tokens, idx, _o, env) => {
  const n = Number(tokens[idx].meta?.id ?? 0) + 1;
  return `<sup style="${st({
    'font-size': '0.72em',
    'line-height': '1',
    color: env.theme.footnote.refColor,
  })}">[${n}]</sup>`;
}) as RenderRule;

md.renderer.rules.footnote_block_open = ((_t, _i, _o, env) => {
  const f = env.theme.footnote;
  return `<section style="${st({
    'margin-top': '36px',
    'padding-top': '14px',
    'border-top': `1px solid ${f.blockBorder}`,
  })}">`;
}) as RenderRule;
md.renderer.rules.footnote_block_close = (() => '</section>') as RenderRule;

md.renderer.rules.footnote_open = ((tokens, idx, _o, env) => {
  const f = env.theme.footnote;
  const n = Number(tokens[idx].meta?.id ?? 0) + 1;
  env.footnote = true;
  return `<p style="${st({
    margin: '3px 0',
    'font-size': f.textSize,
    'line-height': '1.6',
    color: f.textColor,
  })}"><span style="${st({
    color: f.numColor,
    'font-weight': '700',
    'margin-right': '4px',
  })}">[${n}]</span> `;
}) as RenderRule;
md.renderer.rules.footnote_close = ((_t, _i, _o, env) => {
  env.footnote = false;
  return '</p>';
}) as RenderRule;

/* The "back to text" arrow at the end is the same story: with no anchor to jump
   to, an inert ↩ is just noise */
md.renderer.rules.footnote_anchor = (() => '') as RenderRule;

/* ---------------- Links as footnotes ---------------- */

/** Footnote label prefix: a name a body will essentially never collide with */
const LINK_FOOTNOTE_LABEL = 'wxlink';

/**
 * External links in a WeChat body cannot be tapped, so the only way out is to
 * move the address to the end.
 * Before rendering, this turns `[text](https://…)` into `text[^wxlinkN]` and
 * appends the footnote definitions — the numbering, the superscript and the
 * list at the end all reuse the existing footnote rendering.
 *
 * What is left alone:
 * - images `![alt](url)`: an image is displayed anyway, so a footnote is pointless
 * - in-platform links `https://mp.weixin.qq.com/…`: WeChat articles can link to
 *   each other, so those are live
 * - `#anchor` / `mailto:` / relative paths: not external links to begin with
 * - anything inside a fenced block or inline code
 */
function convertLinkFootnotes(src: string): string {
  /** Numbering table; the same address reuses the same number */
  const urls: string[] = [];
  const seen = new Map<string, number>();

  const claim = (url: string): number => {
    const existing = seen.get(url);
    if (existing) return existing;
    urls.push(url);
    seen.set(url, urls.length);
    return urls.length;
  };

  let inFence = false;
  const lines = src.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // Link reference definitions and footnote definitions (`[id]: url`):
    // converting one would tear the definition itself apart
    if (/^ {0,3}\[[^\]]+\]:\s/.test(line)) return line;
    return convertLineLinks(line, claim);
  });

  if (!urls.length) return src;
  const block = urls.map((url, i) => `[^${LINK_FOOTNOTE_LABEL}${i + 1}]: ${url}`).join('\n\n');
  return `${lines.join('\n').replace(/\s+$/, '')}\n\n${block}\n`;
}

/** Whether this external link should become a footnote */
function needsFootnote(dest: string): boolean {
  if (!/^https?:\/\//i.test(dest)) return false;
  // WeChat articles can link to each other, which makes those the only links in
  // a body that still work
  return !/^https?:\/\/mp\.weixin\.qq\.com\//i.test(dest);
}

/** Mark the ranges inline code occupies (`code` / ``co`de``), to skip while scanning */
function codeSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /(`+)(?:[\s\S]*?)\1/g;
  for (const m of line.matchAll(re)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** One line's conversion: replace its external links with text plus a footnote reference */
function convertLineLinks(line: string, claim: (url: string) => number): string {
  const spans = codeSpans(line);
  const inCode = (pos: number) => spans.some(([a, b]) => pos >= a && pos < b);

  let out = '';
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf('[', i);
    if (open < 0) break;
    const prev = open > 0 ? line[open - 1] : '';
    // Images, footnote references, escaped brackets and anything inside inline
    // code are all skipped
    if (prev === '!' || prev === '\\' || line[open + 1] === '^' || inCode(open)) {
      out += line.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const labelEnd = matchBracket(line, open);
    if (labelEnd < 0 || line[labelEnd + 1] !== '(') {
      out += line.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const paren = scanParen(line, labelEnd + 1);
    if (!paren) {
      out += line.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const { dest } = splitDestTitle(paren.inner);
    if (!needsFootnote(dest)) {
      out += line.slice(i, paren.end + 1);
      i = paren.end + 1;
      continue;
    }
    const text = line.slice(open + 1, labelEnd) || dest;
    out += line.slice(i, open) + text + `[^${LINK_FOOTNOTE_LABEL}${claim(dest)}]`;
    i = paren.end + 1;
  }
  return out + line.slice(i);
}

/** From `[`, find the matching `]` (nested brackets allowed); -1 when there is none */
function matchBracket(line: string, openAt: number): number {
  let depth = 1;
  for (let i = openAt + 1; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '[') depth++;
    else if (line[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ---------------- Task-list preprocessing ---------------- */

/**
 * markdown-it supports neither task lists nor callouts natively, so both are
 * substituted before rendering:
 * - `- [ ]` / `- [x]` → ☐ / ☑ (task lists)
 * - `> [!tip]` → `> <!--TIP:title-->` (the callout marker; an HTML comment takes
 *   no part in rendering, and the core rule reads the title back out of it —
 *   see tip_callout)
 * Both are plain text and safe for WeChat, and content inside fenced blocks is
 * skipped.
 */
function preprocess(src: string): string {
  let inFence = false;
  const lines = src.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line
      .replace(/^(\s*)-\s+\[ \]\s+/, '$1- ☐ ')
      .replace(/^(\s*)-\s+\[[xX]\]\s+/, '$1- ☑ ')
      .replace(/^\s*>\s*\[!tip\]\s*(.*)$/i, (_m, title: string) => {
        // Expand into a marker line: with `> [!tip]` alone on its line the title
        // goes inside the comment; with content following, marker and title
        // share the paragraph.
        // Hyphens in the title are escaped so they cannot terminate the HTML
        // comment early (and are restored when read back)

        const safe = title.trim().replace(/-/g, '&#45;');
        return safe ? `> <!--TIP:${safe}-->` : '> <!--TIP:-->';
      });
  });
  return lines.join('\n');
}

/** Task-symbol coloring: ☑ takes the accent, ☐ a light grey (a straight
 *  substitution on the ☐/☑ characters) */
function colorTasks(html: string, th: Theme): string {
  return html
    .replace(/☑/g, `<span style="color:${th.accent};font-weight:700">☑</span>`)
    .replace(/☐/g, `<span style="color:${th.delColor};font-weight:400">☐</span>`);
}

/* ---------------- Front-matter driven article components ---------------- */

/** Resolve the component color overrides, falling back to existing theme fields. */
function comp(th: Theme) {
  const c = th.components ?? {};
  return {
    cardBg: c.cardBg ?? th.body.bg ?? '#ffffff',
    ink: c.ink ?? th.heading.color ?? '#1e1f23',
    border: c.border ?? th.hr.color ?? '#e5e3dc',
    sub: c.sub ?? th.body.color,
    weak: c.weak ?? th.delColor ?? '#9a9a9a',
    olive: c.olive ?? th.accentSoft ?? th.body.bg ?? '#eeeeee',
  };
}

/** Hero card: kicker / date / title / subtitle / tags, plus a dark summary bar. */
function buildHero(fm: FrontMatter, th: Theme): string {
  const c = comp(th);
  const kicker = fm.kicker ?? '';
  const date = fm.date ?? '';
  const title = fm.title ?? '';
  const subtitle = fm.subtitle ?? '';
  const summary = fm.summary ?? '';
  const tags = (fm.tags ?? '')
    .split(/[·,，、]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const tagHtml = tags
    .map(
      (t) =>
        `<span style="${st({
          background: c.olive,
          color: c.ink,
          padding: '3px 8px',
          'border-radius': '4px',
          'font-size': '12px',
          'font-weight': '700',
          border: `1px solid ${c.border}`,
        })}">${esc(t)}</span>`,
    )
    .join('');
  const barStyle: Record<string, string> = {
    display: 'flex',
    'align-items': 'center',
    gap: '4px',
  };
  if (subtitle) barStyle['margin-bottom'] = '12px';
  return (
    `<section style="${st({
      background: c.cardBg,
      border: `1px solid ${c.border}`,
      'border-radius': '6px',
      overflow: 'hidden',
      'font-family': th.body.font,
    })}">` +
    `<section style="padding:28px 24px 22px;">` +
    `<section style="${st({ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '22px' })}">` +
    `<span style="${st({ width: '8px', height: '8px', background: c.ink, 'border-radius': '50%', display: 'inline-block' })}"></span>` +
    `<span style="${st({ 'font-size': '11px', 'font-weight': '700', 'letter-spacing': '3px', color: c.sub })}">${esc(kicker)}</span>` +
    `<span style="${st({ flex: '1', height: '1px', background: c.border, display: 'inline-block' })}"></span>` +
    `<span style="${st({ 'font-size': '11px', color: c.weak, 'font-weight': '500' })}">${esc(date)}</span>` +
    `</section>` +
    `<section style="${st({ display: 'flex', 'align-items': 'stretch', gap: '18px' })}">` +
    `<section style="flex:1;min-width:0;">` +
    `<p style="${st({ 'font-size': '24px', 'font-weight': '800', color: c.ink, margin: '0 0 10px', 'line-height': '1.2', 'letter-spacing': '-0.5px' })}">${esc(title)}</p>` +
    `<section style="${st(barStyle)}">` +
    `<span style="${st({ width: '22px', height: '3px', background: c.ink, 'border-radius': '2px', display: 'inline-block' })}"></span>` +
    `<span style="${st({ width: '8px', height: '3px', background: c.border, 'border-radius': '2px', display: 'inline-block' })}"></span>` +
    `</section>` +
    (subtitle
      ? `<p style="${st({ 'font-size': '14px', color: c.sub, margin: '0', 'line-height': '1.7' })}">${esc(subtitle)}</p>`
      : '') +
    `</section>` +
    `<section style="${st({ 'flex-shrink': '0', width: '96px', display: 'flex', 'flex-direction': 'column', 'align-items': 'center', 'justify-content': 'center', background: c.olive, border: `1px dashed ${c.border}`, 'border-radius': '6px', padding: '8px' })}">` +
    `<span style="${st({ 'font-size': '22px', 'font-weight': '800', color: c.ink, 'line-height': '1' })}">空</span>` +
    `<span style="${st({ 'font-size': '9px', 'font-weight': '700', color: c.weak, 'letter-spacing': '1px', 'margin-top': '4px' })}">${esc('空核域界')}</span>` +
    `</section>` +
    `</section>` +
    `</section>` +
    `<section style="${st({ background: c.ink, padding: '11px 24px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '10px', 'flex-wrap': 'wrap' })}">` +
    `<p style="${st({ 'font-size': '13px', color: 'rgba(255,255,255,0.92)', margin: '0', 'font-weight': '600' })}">${esc(summary)}</p>` +
    `<section style="${st({ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' })}">${tagHtml}</section>` +
    `</section>` +
    `</section>`
  );
}

/** Opening of the 导语 (intro) card: dark header bar + olive body well. */
function introCardOpen(th: Theme, line?: number): string {
  const c = comp(th);
  const dl = line != null ? ` data-line="${line}"` : '';
  return (
    `<section${dl} style="${st({
      'margin-top': '24px',
      background: c.cardBg,
      border: `1px solid ${c.border}`,
      'border-radius': '6px',
      overflow: 'hidden',
      'font-family': th.body.font,
    })}">` +
    `<section style="${st({ padding: '10px 16px', background: c.ink, display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '10px' })}">` +
    `<p style="${st({ margin: '0', 'font-size': '11px', 'font-weight': '800', 'letter-spacing': '2px', color: '#ffffff' })}">${esc('导语')}</p>` +
    `<span style="${st({ 'font-size': '10px', color: 'rgba(255,255,255,0.65)' })}">${esc('INTRO')}</span>` +
    `</section>` +
    `<section style="${st({ padding: '16px 18px 18px', background: c.olive, color: c.sub })}">`
  );
}

/** Closing of the 导语 card. */
function introCardClose(): string {
  return '</section></section>';
}

/** Standalone intro card for an explicit `intro:` front-matter field. */
function buildIntroCard(text: string, th: Theme): string {
  return (
    introCardOpen(th) +
    `<p style="${st({ margin: '0', 'font-size': '14px', 'line-height': '1.9', color: comp(th).sub, 'text-align': 'justify' })}">${esc(text)}</p>` +
    introCardClose()
  );
}

/** Signature + engagement card: author line, 点赞/在看/收藏, sign-off. */
function buildSignature(author: string, th: Theme): string {
  const c = comp(th);
  const requestedAuthor = author.trim();
  // Existing 空运新视角 drafts belong to the renamed brand. Preserve any
  // other explicit byline so guest-authored articles still work.
  const a = !requestedAuthor || requestedAuthor === '空运新视角' ? '空核域界' : requestedAuthor;
  const icon = (glyph: string, label: string, fill: string, txt: string) =>
    `<section style="${st({ 'text-align': 'center', color: txt })}">` +
    `<section style="${st({ width: '40px', height: '40px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', margin: '0 auto 6px', background: fill, 'border-radius': '6px', border: `1px solid ${c.border}` })}">` +
    `<span style="${st({ 'font-size': '18px', 'line-height': '1' })}">${esc(glyph)}</span>` +
    `</section>` +
    `<span style="${st({ 'font-size': '11px', 'font-weight': '600' })}">${esc(label)}</span>` +
    `</section>`;
  return (
    `<section style="margin-top:24px;">` +
    `<section style="${st({ background: c.cardBg, border: `1px solid ${c.border}`, 'border-radius': '6px', padding: '18px 20px', 'font-family': th.body.font })}">` +
    `<p style="${st({ margin: '0 0 10px', 'font-size': '14px', 'font-weight': '700', color: c.ink, 'line-height': '1.8' })}">${esc(
      `我是 ${a}，以国际航空货运为核心，合纵连横且围绕着包括但不仅限于物流、航空、科技、AI、新媒体等横向思维相关内容，为你开启全新视角。`,
    )}</p>` +
    `</section>` +
    `</section>` +
    `<section style="margin-top:18px;">` +
    `<section style="${st({ background: c.cardBg, border: `1px solid ${c.border}`, 'border-radius': '6px', padding: '22px 16px', 'text-align': 'center', 'font-family': th.body.font })}">` +
    `<p style="${st({ 'font-size': '13px', 'font-weight': '700', color: c.ink, 'line-height': '1.6', margin: '0 0 14px' })}">${esc(
      '如果这篇对你有用，欢迎点赞、在看、转发，让更多朋友看到。我们下篇见。',
    )}</p>` +
    `<section style="${st({ display: 'flex', 'justify-content': 'center', gap: '18px', 'margin-bottom': '14px', 'flex-wrap': 'wrap' })}">` +
    icon('👍', '赞', c.olive, c.sub) +
    icon('👁', '在看', c.olive, c.sub) +
    icon('⭐', '收藏', c.olive, c.ink) +
    `</section>` +
    `<p style="${st({ 'line-height': '1.6', 'font-size': '10px', color: c.weak, 'letter-spacing': '2px', margin: '0', 'font-weight': '500' })}">${esc(
      'THANKS FOR READING',
    )}</p>` +
    `</section>` +
    `</section>`
  );
}

/* ---------------- Render entry point ---------------- */

/** Render switches (body processing that has nothing to do with the theme) */
export interface RenderOptions {
  /** Links as footnotes: replace external links with superscript numbers and
   *  collect the addresses into a reference list at the end */
  linkFootnotes?: boolean;
}

export interface RenderResult {
  /** Body HTML (without the outer wrapper; shared by preview and export checks) */
  body: string;
  /** Body as it should appear in preview, including front-matter components. */
  previewBody: string;
  /** Complete export HTML (wrapped in a section carrying the base font) */
  html: string;
  /** Whether the body contains any images */
  hasImage: boolean;
  /** Article title: a front-matter `title`, else the first H1 (may be empty) */
  title: string;
  /** Whether the preview body already contains its own article head. */
  hasHero: boolean;
}

export function renderArticle(
  markdown: string,
  theme?: Theme,
  images?: Record<string, string>,
  density?: DensityScale,
  options?: RenderOptions,
): RenderResult {
  const th = density ? applyDensity(theme ?? getTheme(), density) : theme ?? getTheme();

  // Front-matter → hero / intro / signature cards. Only when the theme opts in
  // (components.frontMatter) and the document actually opens with `---`, so
  // ordinary articles render exactly as before.
  let content = markdown;
  let fm: FrontMatter | null = null;
  if (th.components?.frontMatter) {
    const parsed = parseFrontMatter(markdown);
    if (parsed) {
      fm = parsed.data;
      content = parsed.content;
    }
  }

  // The footnote conversion has to run before preprocess: it scans the raw
  // Markdown line by line, and the callout comments preprocess introduces would
  // shift the lines its links sit on
  const src = options?.linkFootnotes ? convertLinkFootnotes(content) : content;
  // A fresh flow per render: section numbers, row stripes and the quote stack
  // all count from the top of the document (see Env.flow)
  const flow0 = newFlow();
  // An explicit `intro:` field renders its own card; don't also turn the first
  // blockquote into one.
  if (fm?.intro) flow0.introDone = true;
  const body = colorTasks(md.render(preprocess(src), { theme: th, images, flow: flow0 }), th);

  const heroHtml = fm ? buildHero(fm, th) : '';
  const introHtml = fm?.intro ? buildIntroCard(fm.intro, th) : '';
  const sigHtml = fm ? buildSignature(fm.author ?? '', th) : '';
  const title = fm?.title ?? extractTitle(body);
  const previewBody = `${heroHtml}${introHtml}${body}${sigHtml}`;

  const html = `<section style="${st({
    'font-family': th.body.font,
    'font-size': th.body.fontSize,
    'line-height': th.body.lineHeight,
    color: th.body.color,
    'word-break': 'break-word',
    // A light article already sits on WeChat's own paper. Pinning a nearly
    // white background here makes WeChat's dark-mode converter turn the whole
    // article into a second, slightly different dark rectangle. Dark themes
    // still need their canvas or their light text disappears in light mode.
    ...(th.appearance === 'dark' && th.body.bg ? { background: th.body.bg } : {}),
  })}">${previewBody}</section>`;
  return {
    body,
    previewBody,
    html,
    hasImage: /<img\s/i.test(previewBody),
    title,
    hasHero: fm !== null,
  };
}

/* ---------------- Body-HTML helpers (shared by preview and long image) ---------------- */

/** Pull the first level-one heading out of the body HTML as the article title */
export function extractTitle(body: string): string {
  const m = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Remove the first h1 from the body (the article head already shows the title;
 *  exports to WeChat are unaffected) */
export function stripFirstH1(body: string): string {
  return body.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '');
}
