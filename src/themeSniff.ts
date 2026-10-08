/**
 * Reading a theme back out of a published article.
 *
 * Paste the address of a WeChat piece whose typesetting you like, and this
 * works out what it was set in: paper and ink, the size and leading of the
 * prose, how its headings are marked, the shape of its quotes, its accent.
 * The result is an ordinary custom theme — the same file the studio and the
 * agent write — so it is a *starting point* to tune, never a copy: nothing of
 * the article's own writing or pictures comes across, only the numbers and
 * colours its styles were set with.
 *
 * Two things make that possible at all. A WeChat body carries its styling
 * inline on every element (the editor there throws away classes, exactly as
 * this app's renderer assumes), and what little does come from a stylesheet
 * sits in plain `<style>` blocks in the same page. So a small cascade —
 * stylesheet rules by selector, then the inline attribute, then inheritance
 * for the properties that inherit — recovers what each element was drawn
 * with, without a browser to lay the page out.
 *
 * What it cannot recover is everything that was never CSS: headings that are
 * images, decorative SVG, background pictures. Those come back as whatever
 * the base preset says, and are named in the notes so the difference is not a
 * mystery.
 */

import { formatColor, parseColor, rgbToHsv, type Rgba } from './color';
import { getTheme, type Theme } from './theme';

export interface SniffResult {
  theme: Theme;
  /** What was read off the page, and what had to be left to the preset */
  notes: string[];
}

type Decls = Record<string, string>;

/* ---------------- The page's own cascade ---------------- */

interface Rule {
  sel: string;
  decls: Decls;
  weight: number;
}

function parseDecls(css: string): Decls {
  const out: Decls = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part
      .slice(i + 1)
      .replace(/!important\s*$/i, '')
      .trim();
    if (prop && value) out[prop] = value;
  }
  return out;
}

/** Rough CSS specificity — enough to order rules that both match */
const specificity = (sel: string) =>
  (sel.match(/#/g)?.length ?? 0) * 100 +
  (sel.match(/[.[:]/g)?.length ?? 0) * 10 +
  (sel.match(/(^|[\s>+~])[a-z]/gi)?.length ?? 0);

/**
 * Rules from the page's `<style>` blocks.
 *
 * At-rules are skipped whole: honouring a media query would mean deciding a
 * viewport, and a print or dark-mode block is not what the reader saw.
 */
function readSheets(doc: Document): Rule[] {
  const rules: Rule[] = [];
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].trim();
      if (!selectors || selectors.includes('@')) continue;
      const decls = parseDecls(m[2]);
      if (!Object.keys(decls).length) continue;
      for (const sel of selectors.split(',')) {
        const s = sel.trim();
        if (s) rules.push({ sel: s, decls, weight: specificity(s) });
      }
    }
  }
  return rules;
}

/** Properties a child takes from its parent when it says nothing itself */
const INHERITED = new Set(['color', 'font-family', 'font-size', 'line-height', 'text-align', 'font-weight']);

/** The blue WeChat paints every in-article link, from its own stylesheet */
const WECHAT_LINK_BLUE = '#576b95';

/** WeChat's own default body size, used when nothing up the tree names one */
const ROOT_SIZE = 17;

interface Styles {
  /** Everything declared on this element, page rules then inline */
  own: (el: Element) => Decls;
  /** A declared value, walking up for the properties that inherit */
  prop: (el: Element | null, name: string) => string;
  /** Font size in px, resolving em / rem / % against the ancestors */
  size: (el: Element | null) => number;
  /** Line height as a multiple of the element's own font size */
  leading: (el: Element | null) => number | null;
}

function styling(doc: Document): Styles {
  const rules = readSheets(doc);
  const cache = new Map<Element, Decls>();

  const own = (el: Element): Decls => {
    const hit = cache.get(el);
    if (hit) return hit;
    const decls: Decls = {};
    const matched = rules.filter((r) => {
      try {
        return el.matches(r.sel);
      } catch {
        // A selector this engine will not parse (`:has()` on an old build,
        // vendor pseudos) is simply not applied
        return false;
      }
    });
    for (const r of matched.sort((a, b) => a.weight - b.weight)) Object.assign(decls, r.decls);
    Object.assign(decls, parseDecls(el.getAttribute('style') ?? ''));
    cache.set(el, decls);
    return decls;
  };

  const prop = (el: Element | null, name: string): string => {
    for (let cur = el; cur; cur = cur.parentElement) {
      const v = own(cur)[name];
      if (v && v !== 'inherit') return v;
      if (!INHERITED.has(name)) break;
    }
    return '';
  };

  const size = (el: Element | null): number => {
    if (!el) return ROOT_SIZE;
    const v = own(el)['font-size'];
    if (!v) return el.parentElement ? size(el.parentElement) : ROOT_SIZE;
    const m = /^(-?[\d.]+)(px|pt|em|rem|%)?$/.exec(v.trim());
    if (!m) return el.parentElement ? size(el.parentElement) : ROOT_SIZE;
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case 'em':
        return n * size(el.parentElement);
      case '%':
        return (n / 100) * size(el.parentElement);
      case 'rem':
        return n * ROOT_SIZE;
      case 'pt':
        return (n * 4) / 3;
      default:
        return n;
    }
  };

  const leading = (el: Element | null): number | null => {
    const v = prop(el, 'line-height');
    if (!v) return null;
    const m = /^(-?[\d.]+)(px|em|%)?$/.exec(v.trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (m[2] === 'px') return n / (size(el) || ROOT_SIZE);
    if (m[2] === '%') return n / 100;
    return n;
  };

  return { own, prop, size, leading };
}

/* ---------------- Counting what the page does most ---------------- */

/** A weighted vote. Whatever carried the most text wins, which is what makes
 *  a long article's body style obvious and its one odd pull quote harmless */
function poll<T extends string | number>() {
  const tally = new Map<T, number>();
  return {
    add(value: T | null | undefined, weight = 1) {
      if (value === null || value === undefined || value === '') return;
      tally.set(value, (tally.get(value) ?? 0) + weight);
    },
    best(): T | null {
      let top: T | null = null;
      let max = 0;
      for (const [v, w] of tally) {
        if (w > max) {
          max = w;
          top = v;
        }
      }
      return top;
    },
    get size() {
      return tally.size;
    },
  };
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`;

/** `0.5rem 1em` as px, so the value means the same wherever it is pasted */
const lengths = (v: string | undefined, em: number): string | undefined =>
  v?.replace(/([\d.]+)(rem|em)\b/g, (_m, n: string, unit: string) =>
    px(parseFloat(n) * (unit === 'rem' ? ROOT_SIZE : em)),
  );

/** A colour as the themes write them, or null for "not really a colour" */
function colour(v: string | undefined): string | null {
  const c = parseColor(v ?? '');
  if (!c || c.a === 0) return null;
  return formatColor(c);
}

const luminance = (c: Rgba) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const saturation = (c: Rgba) => rgbToHsv(c).s;
const near = (a: string | null, b: string | null) => {
  const x = parseColor(a ?? '');
  const y = parseColor(b ?? '');
  if (!x || !y) return false;
  // Per channel, not summed: a pale tint on pale paper differs by a couple of
  // counts in each, and a sum called those the same colour
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)) <= 6;
};

/** The border a value like `4px solid #d97757` describes. `em` needs the
 *  element's own size, which the caller knows and this does not */
function border(
  v: string | undefined,
  em = 16,
): { width: number; style: string; color: string | null } | null {
  if (!v) return null;
  const parts = v.match(/(rgba?|hsla?)\([^)]*\)|\S+/g) ?? [];
  let width = 0;
  let style = '';
  let color: string | null = null;
  for (const p of parts) {
    const m = /^([\d.]*\d)(px|pt|em|rem)$/.exec(p);
    if (m) {
      const n = parseFloat(m[1]);
      const raw = m[2] === 'pt' ? (n * 4) / 3 : m[2] === 'em' ? n * em : m[2] === 'rem' ? n * ROOT_SIZE : n;
      width = Math.round(raw * 2) / 2;
    }
    else if (/^(solid|dashed|dotted|double|none|hidden)$/.test(p)) style = p;
    else color ??= colour(p);
  }
  if (!width && !style) return null;
  return { width, style: style || 'solid', color };
}

/** The four sides, however they were written (shorthand or one at a time) */
function sides(d: Decls, side: 'top' | 'bottom' | 'left' | 'right', em = 16) {
  const one = border(d[`border-${side}`], em);
  if (one) return one;
  const all = border(d.border, em);
  if (all) return all;
  const w = d[`border-${side}-width`];
  const st = d[`border-${side}-style`];
  const c = d[`border-${side}-color`];
  if (!w && !st && !c) return null;
  const wide = border(w, em);
  return {
    width: wide?.width ?? (parseFloat(w ?? '0') || 0),
    style: st || 'solid',
    color: colour(c) ?? null,
  };
}

/* ---------------- Reading the article ---------------- */

const BLOCK = 'p, section, div, h1, h2, h3, h4, h5, h6, blockquote, li, pre, table, hr, img, figure';
/** A block whose text is its own, not a container of other blocks */
const leafText = (el: Element) => {
  const inner = el.textContent?.trim() ?? '';
  if (!inner) return '';
  for (const child of Array.from(el.children)) {
    if (child.matches('p, section, div, blockquote, table, ul, ol, pre, figure, h1, h2, h3, h4, h5, h6')) {
      if ((child.textContent?.trim().length ?? 0) > inner.length * 0.8) return '';
    }
  }
  return inner;
};

const SYMBOL = /^[^\p{L}\p{N}\s]/u;

export interface SniffOptions {
  /** Name for the theme this produces */
  name: string;
  /** Preset it inherits everything unread from */
  base?: string;
  description?: string;
}

/**
 * Work a theme out of an already-parsed page.
 *
 * Kept apart from the fetching so it can be run against any document — which
 * is also how it is tested, since a fixture is a document and a network round
 * trip is not.
 */
export function sniffTheme(doc: Document, opts: SniffOptions): SniffResult {
  const root =
    doc.querySelector('#js_content') ??
    doc.querySelector('.rich_media_content') ??
    doc.querySelector('article, main') ??
    doc.body;
  const st = styling(doc);
  const notes: string[] = [];
  /**
   * The paper comes first: everything this cannot read falls back to a
   * preset, and a light preset's code block or table on a dark article's
   * paper is a bright rectangle in the middle of the page.
   */
  let paper: string | null = null;
  for (let el: Element | null = root; el; el = el.parentElement) {
    const bg = colour(st.own(el)['background-color'] ?? st.own(el).background);
    const c = parseColor(bg ?? '');
    if (bg && c && c.a > 0.5) {
      paper = bg;
      break;
    }
  }
  const ownPaper = !!paper && !near(paper, '#ffffff');
  if (!ownPaper) paper = '#ffffff';
  const dark = luminance(parseColor(paper!) ?? { r: 255, g: 255, b: 255, a: 1 }) < 0.45;
  const base = getTheme(opts.base ?? (dark ? 'midnight' : 'classic'));
  const out: Theme = {
    ...base,
    id: 'sniffed',
    name: opts.name.slice(0, 24),
    base: base.id,
    description: (opts.description ?? '从一篇文章里扒来的排版').slice(0, 60),
    body: { ...base.body },
    heading: { ...base.heading },
    headingSizes: { ...base.headingSizes },
    quote: { ...base.quote },
    callout: { ...base.callout },
    code: { ...base.code },
    codeBlock: { ...base.codeBlock },
    link: { ...base.link },
    list: { ...base.list },
    table: { ...base.table },
    hr: { ...base.hr },
    img: { ...base.img },
    mark: { ...base.mark },
    footnote: { ...base.footnote },
  };

  /**
   * Anything hidden takes no part in any of this. A WeChat page carries
   * placeholder headings under `visibility: hidden`, and the article's
   * heading colour was being read off one of them.
   */
  const hidden = (el: Element): boolean => {
    // Only inside the article: WeChat serves `#js_content` itself as
    // `visibility: hidden` and reveals it with a script, so counting the
    // container in would call the whole piece invisible
    for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
      const d = st.own(cur);
      if (d.display === 'none' || d.visibility === 'hidden') return true;
      if (d.opacity !== undefined && parseFloat(d.opacity) === 0) return true;
    }
    return false;
  };
  const seen = <T extends Element>(list: T[]) => list.filter((el) => !hidden(el));

  const blocks = seen(Array.from(root.querySelectorAll(BLOCK)));

  /* ---- paper ---- */

  if (ownPaper) {
    out.body.bg = paper!;
    notes.push(`纸色 ${paper}`);
  } else {
    delete out.body.bg;
  }
  out.appearance = dark ? 'dark' : 'light';
  out.codePaletteMode = dark ? 'dark' : 'light';
  if (dark) notes.push('这是一篇深色文章，没扒到的部分用了内置深色主题的值');

  /* ---- prose: the longest-running size, leading and ink ---- */

  const sizeVote = poll<number>();
  const leadVote = poll<number>();
  const inkVote = poll<string>();
  const gapVote = poll<string>();
  const proseBlocks: Element[] = [];
  for (const el of blocks) {
    if (el.closest('blockquote, pre, table, li')) continue;
    const text = leafText(el);
    if (text.length < 12) continue;
    proseBlocks.push(el);
    const w = text.length;
    sizeVote.add(Math.round(st.size(el) * 2) / 2, w);
    const lh = st.leading(el);
    if (lh) leadVote.add(Math.round(lh * 20) / 20, w);
    inkVote.add(colour(st.prop(el, 'color')), w);
    const mb = st.own(el)['margin-bottom'] ?? st.own(el).margin?.split(/\s+/)[2];
    if (mb && /^[\d.]+px$/.test(mb)) gapVote.add(mb, 1);
  }
  const bodySize = sizeVote.best() ?? parseFloat(base.body.fontSize);
  out.body.fontSize = px(bodySize);
  const lead = leadVote.best();
  if (lead) out.body.lineHeight = String(Math.round(lead * 100) / 100);
  const ink = inkVote.best();
  if (ink) out.body.color = ink;
  const gap = gapVote.best();
  if (gap) out.pMargin = gap;
  notes.push(`正文 ${out.body.fontSize} / 行高 ${out.body.lineHeight}${ink ? ` / ${ink}` : ''}`);

  const fontOf = (el: Element | null) => {
    const f = st.prop(el, 'font-family');
    return f ? f.replace(/["]/g, "'").slice(0, 200) : null;
  };
  const bodyFont = fontOf(proseBlocks[0] ?? root);
  if (bodyFont) out.body.font = bodyFont;

  /* ---- headings ---- */

  const barVote = poll<string>();
  const bandVote = poll<string>();
  const headColour = poll<string>();

  /** A heading, and the element its styling is actually written on: in a
   *  WeChat article the line is a paragraph with a bold <span> inside, and
   *  the size and colour that matter are the span's */
  interface Head {
    el: Element;
    box: Element;
  }

  const realHeads: Head[] = blocks
    .filter((el) => /^h[1-6]$/i.test(el.tagName))
    .map((el) => ({ el, box: el }));
  // The WeChat editor has no heading tags: a heading there is an ordinary
  // line set bold or a size up, standing on its own. Both kinds count, and
  // both at once — this article carries a single stray <h3> and does all its
  // real section headings as bold lines, so taking either alone reads the
  // wrong one as the article's heading style
  const pseudoHeads: Head[] = [];
  for (const el of blocks) {
    if (el.closest('blockquote, pre, table, li')) continue;
    if (/^h[1-6]$/i.test(el.tagName)) continue;
    const text = leafText(el);
    if (!text || text.length > 40) continue;
    const isBold = (n: Element) => {
      const w = st.prop(n, 'font-weight');
      return w === 'bold' || parseInt(w, 10) >= 600;
    };
    // The whole line set bold inside a span of its own is the commonest way
    // a heading is written there, and the span is what carries the styling
    const inner = Array.from(el.querySelectorAll('strong, b, span')).find(
      (n) => isBold(n) && (n.textContent ?? '').trim().length >= text.length * 0.8,
    );
    const node = inner ?? el;
    const bold = !!inner || isBold(el);
    if (st.size(node) >= bodySize * 1.12 || (bold && text.length <= 24)) {
      pseudoHeads.push({ el: node, box: el });
    }
  }
  const heads: Head[] = [...realHeads, ...pseudoHeads];

  if (heads.length) {
    const headWeight = poll<string>();
    const decorVote = poll<string>();
    const markerVote = poll<string>();
    const alignVote = poll<string>();
    const levelSizes = new Map<string, ReturnType<typeof poll<number>>>();

    for (const { el, box } of heads) {
      const text = leafText(box);
      headColour.add(colour(st.prop(el, 'color')));
      const weight = st.prop(el, 'font-weight');
      if (weight) headWeight.add(weight === 'bold' ? '700' : weight === 'normal' ? '400' : weight);
      alignVote.add(st.prop(box, 'text-align'));

      const tag = /^h[1-6]$/i.test(box.tagName) ? box.tagName.toLowerCase() : '';
      if (tag) {
        if (!levelSizes.has(tag)) levelSizes.set(tag, poll<number>());
        levelSizes.get(tag)!.add(Math.round(st.size(el) * 2) / 2);
      }

      // The decoration may sit on the heading or on the section wrapped
      // around it — the WeChat editor writes both
      for (const carrier of [box, box.parentElement].filter(Boolean) as Element[]) {
        const cd = st.own(carrier);
        const cem = st.size(carrier);
        const left = sides(cd, 'left', cem);
        const bottom = sides(cd, 'bottom', cem);
        const top = sides(cd, 'top', cem);
        const bg = colour(cd['background-color'] ?? cd.background);
        if (left && left.width >= 2 && left.style !== 'none') {
          decorVote.add('left-bar', 2);
          barVote.add(left.color ?? '', 2);
        } else if (bottom && bottom.width >= 1 && bottom.style !== 'none') {
          decorVote.add(bottom.width >= 3 ? 'rule' : 'underline', 2);
          barVote.add(bottom.color ?? '', 2);
        } else if (top && top.width >= 2 && top.style !== 'none') {
          decorVote.add('accent-bar', 2);
          barVote.add(top.color ?? '', 2);
        } else if (bg && !near(bg, paper)) {
          decorVote.add('band', 2);
          bandVote.add(bg, 2);
        }
      }
      if (SYMBOL.test(text)) {
        const glyph = [...text][0];
        decorVote.add('marker');
        markerVote.add(glyph);
      } else if (/^\d\d[\s、.．]/.test(text)) {
        decorVote.add('numbered');
      }
    }

    // One lone heading with no decoration is not a heading style: this
    // article's only heading tag is a thin grey "References" at the end, and
    // taking it as the article's would have every h2 come out thin and grey.
    // Better to say so and leave the preset's headings alone
    const weak = heads.length < 2 && !decorVote.best();
    if (weak) {
      notes.push('文章里没有成形的小标题，标题样式沿用底板主题');
    }

    const hc = weak ? null : headColour.best();
    if (hc) out.heading.color = hc;
    const hw = weak ? null : headWeight.best();
    if (hw && /^\d+$/.test(hw)) out.heading.fontWeight = hw;
    const headFont = weak ? null : fontOf(heads[0].el);
    if (headFont) out.heading.font = headFont;

    // Real levels keep their own sizes; inferred ones are ranked biggest
    // first, since a bold line carries no level to read
    for (const [tag, votes] of levelSizes) {
      const n = weak ? null : votes.best();
      if (n) out.headingSizes[tag as keyof Theme['headingSizes']] = px(n);
    }
    if (pseudoHeads.length && !weak) {
      // Bold lines carry no level, so they are ranked: biggest is h2, next h3
      const ranked = [...new Set(pseudoHeads.map((h) => Math.round(st.size(h.el) * 2) / 2))].sort((a, b) => b - a);
      if (ranked[0] && !levelSizes.has('h2')) out.headingSizes.h2 = px(ranked[0]);
      if (!levelSizes.has('h3')) out.headingSizes.h3 = px(ranked[1] ?? Math.max(bodySize + 1, ranked[0] - 2));
      notes.push(`标题里有 ${pseudoHeads.length} 处是加粗段落写的，按字号推断了层级`);
    }

    const decor = weak ? null : decorVote.best();
    if (decor) {
      out.heading.decor = decor as Theme['heading']['decor'];
      if (decor === 'marker') {
        const glyph = markerVote.best();
        if (glyph) out.heading.markerGlyph = glyph;
      }
      const band = bandVote.best();
      if (decor === 'band' && band) out.accentSoft = band;
      notes.push(`标题装饰：${decor}`);
    }
    if (!weak && alignVote.best() === 'center') out.heading.align = 'center';
  } else {
    notes.push('没认出标题，标题样式沿用底板主题');
  }

  /* ---- the accent ----
     Whatever colour the article spends on decoration: its heading rule, its
     quote bar, its links, its bold. Never the ink or the paper, and never
     something so grey or so pale that it would read as either */

  const accentVote = poll<string>();
  const consider = (c: string | null, w: number) => {
    const rgba = parseColor(c ?? '');
    if (!c || !rgba) return;
    if (saturation(rgba) < 0.15) return;
    const lum = luminance(rgba);
    if (lum > 0.93 || lum < 0.06) return;
    if (near(c, out.body.color) || near(c, paper)) return;
    accentVote.add(c, w);
  };
  consider(barVote.best(), 4);
  consider(bandVote.best(), 2);
  consider(headColour.best(), 1);
  // Inline code and the fill of a card are decoration as much as a rule is,
  // and on a plainly-set article they are the only colour in the piece
  for (const el of seen(Array.from(root.querySelectorAll('code')))) {
    consider(colour(st.own(el).color ?? ''), 3);
  }
  for (const a of seen(Array.from(root.querySelectorAll('a[href]')))) consider(colour(st.own(a).color ?? ''), 3);
  for (const b of seen(Array.from(root.querySelectorAll('strong, b')))) consider(colour(st.own(b).color ?? ''), 1);
  for (const el of blocks) {
    const d = st.own(el);
    for (const side of ['left', 'top', 'bottom', 'right'] as const) {
      const b = sides(d, side, st.size(el));
      if (b && b.width > 0 && b.style !== 'none') consider(b.color, 1);
    }
  }
  const accent = accentVote.best();
  if (accent) {
    out.accent = accent;
    notes.push(`强调色 ${accent}`);
  } else {
    notes.push('没找到明显的强调色，沿用了底板主题的');
  }

  /* ---- boxes: quotes, callouts, code ----

     A WeChat article has no <blockquote> and nothing that says "callout":
     every box in it is a <section> carrying a fill, a rule down its left, or
     both. So boxes are found by shape and then told apart — a rule reads as a
     quote, a plain fill as a callout, a monospace face as code — instead of
     by tag name, which was the earlier mistake: articles came back with the
     preset's quote and callout untouched because neither element was ever
     there to find. */

  interface Box {
    el: Element;
    d: Decls;
    /** Fill, once it is something other than the paper */
    bg: string | null;
    bar: { width: number; style: string; color: string | null } | null;
    mono: boolean;
    len: number;
  }

  const articleLen = (root.textContent ?? '').trim().length;
  const boxes: Box[] = [];
  for (const el of blocks) {
    if (el === root || el.closest('table')) continue;
    const d = st.own(el);
    const bg = colour(d['background-color'] ?? d.background);
    const left = sides(d, 'left', st.size(el));
    const filled = !!bg && !near(bg, paper);
    const barred = !!left && left.width >= 2 && left.style !== 'none';
    if (!filled && !barred) continue;
    const len = (el.textContent ?? '').trim().length;
    // Too short to be a block of its own, or so long it is the page's own
    // wrapper rather than a box on the page
    if (len < 6 || len > articleLen * 0.6) continue;
    // A heading's own bar is a heading decoration, already read above
    if (heads.some((h) => h.box === el || (el.contains(h.box) && (h.box.textContent ?? '').trim().length >= len * 0.8))) continue;
    const family = st.prop(el, 'font-family').toLowerCase();
    boxes.push({
      el,
      d,
      bg: filled ? bg : null,
      bar: barred ? left : null,
      mono: /mono|consolas|courier|menlo|sf mono/.test(family),
      len,
    });
  }

  const asBox = (el: Element): Box => {
    const d = st.own(el);
    const bg = colour(d['background-color'] ?? d.background);
    const left = sides(d, 'left', st.size(el));
    return {
      el,
      d,
      bg: bg && !near(bg, paper) ? bg : null,
      bar: left && left.width >= 2 && left.style !== 'none' ? left : null,
      mono: false,
      len: (el.textContent ?? '').trim().length,
    };
  };

  const realQuotes = seen(Array.from(root.querySelectorAll('blockquote'))).map(asBox);
  const codeBoxes = boxes.filter((b) => b.mono);
  const barred = boxes.filter((b) => b.bar && !b.mono);
  const filled = boxes.filter((b) => !b.bar && b.bg && !b.mono);

  const quoteBox = realQuotes[0] ?? barred[0] ?? filled[0] ?? null;
  // Whatever is left over is the callout: a filled box the quote did not take,
  // or a second bordered one
  const calloutBox =
    filled.find((b) => b !== quoteBox) ?? barred.find((b) => b !== quoteBox) ?? null;

  if (quoteBox) {
    const { el, d, bg, bar } = quoteBox;
    const qc = colour(st.prop(el, 'color'));
    if (qc) out.quote.color = qc;
    if (bg) out.quote.background = bg;
    if (bar) {
      out.quote.style = 'bar';
      out.quote.borderLeft = `${px(bar.width)} ${bar.style} ${bar.color ?? out.accent}`;
    } else if (bg) {
      out.quote.style = 'card';
      out.quote.borderLeft = 'none';
    }
    const em = st.size(el);
    if (d['border-radius']) out.quote.borderRadius = lengths(d['border-radius'], em)!;
    if (d.padding) out.quote.padding = lengths(d.padding, em)!;
    if (d.margin) out.quote.margin = lengths(d.margin, em)!;
    if (st.prop(el, 'text-align') === 'center') out.quote.style = 'pull';
    if (d['font-style'] === 'italic') out.quote.fontStyle = 'italic';
    notes.push(`引用：${out.quote.style ?? 'bar'}${realQuotes.length ? '' : '（文章里是个带样式的段落块）'}`);
  } else {
    notes.push('文章里没有引用块，引用样式沿用底板主题');
  }

  if (calloutBox) {
    const { el, d, bg, bar } = calloutBox;
    if (bg) out.callout.background = bg;
    const cc = colour(st.prop(el, 'color'));
    if (cc) out.callout.color = cc;
    out.callout.borderLeft = bar ? `${px(bar.width)} ${bar.style} ${bar.color ?? out.accent}` : 'none';
    const em = st.size(el);
    if (d['border-radius']) out.callout.borderRadius = lengths(d['border-radius'], em)!;
    if (d.padding) out.callout.padding = lengths(d.padding, em)!;
    if (d.margin) out.callout.margin = lengths(d.margin, em)!;
    // The title line inside a card is usually the one thing in it with a
    // colour of its own
    const lead = Array.from(el.querySelectorAll('strong, b, span, p')).find((n) => {
      const c = colour(st.prop(n, 'color'));
      return c && cc && !near(c, cc);
    });
    if (lead) {
      const c = colour(st.prop(lead, 'color'));
      if (c) out.callout.badgeColor = c;
    }
    notes.push(`提示块：底色 ${out.callout.background}`);
  } else {
    notes.push('没找到提示块那样的色块，提示块样式沿用底板主题');
  }

  /* ---- code ---- */

  const preEl = root.querySelector('pre');
  const codeBox = preEl ? asBox(preEl) : (codeBoxes[0] ?? null);
  if (codeBox) {
    const { el, d } = codeBox;
    const bg = colour(d['background-color'] ?? d.background);
    if (bg) out.codeBlock.background = bg;
    const c = colour(st.prop(el, 'color'));
    if (c) out.codeBlock.color = c;
    if (d['border-radius']) out.codeBlock.borderRadius = lengths(d['border-radius'], st.size(el))!;
    if (d.padding) out.codeBlock.padding = lengths(d.padding, st.size(el))!;
    out.codeBlock.fontSize = px(st.size(el));
    const family = st.prop(el, 'font-family');
    if (family) out.mono = family.replace(/["]/g, "'").slice(0, 200);
    notes.push('代码块读到了');
  } else {
    notes.push('文章里没有代码块，代码块样式沿用底板主题');
  }
  const codeInline = seen(Array.from(root.querySelectorAll('code'))).find((el) => !el.closest('pre'));
  if (codeInline) {
    const d = st.own(codeInline);
    const bg = colour(d['background-color'] ?? d.background);
    if (bg) out.code.background = bg;
    const c = colour(st.prop(codeInline, 'color'));
    if (c) out.code.color = c;
    const em = st.size(codeInline);
    if (d['border-radius']) out.code.borderRadius = lengths(d['border-radius'], em)!;
    if (d.padding) out.code.padding = lengths(d.padding, em)!;
  }

  /* ---- table, rule, links, emphasis, lists ---- */

  const td = root.querySelector('td');
  if (td) {
    const d = st.own(td);
    const b = sides(d, 'bottom', st.size(td)) ?? sides(d, 'top', st.size(td));
    if (b?.color) out.table.borderColor = b.color;
    if (d.padding) out.table.cellPadding = lengths(d.padding, st.size(td))!;
    const th = root.querySelector('th');
    const thBg = th ? colour(st.own(th)['background-color'] ?? st.own(th).background) : null;
    if (thBg) out.table.headBg = thBg;
    const vertical = sides(d, 'left');
    out.table.style = vertical && vertical.width > 0 && vertical.style !== 'none' ? 'grid' : 'minimal';
    notes.push(`表格：${out.table.style}`);
  }

  const hr = root.querySelector('hr');
  if (hr) {
    const d = st.own(hr);
    const b = sides(d, 'top', st.size(hr)) ?? border(d['border-bottom']) ?? border(d.border);
    if (b) {
      if (b.color) out.hr.color = b.color;
      out.hr.style = (['dashed', 'dotted', 'double'] as const).find((s) => s === b.style) ?? 'line';
    }
    if (d.width && /%$/.test(d.width)) out.hr.width = d.width;
  }

  // Links: what most of them are set in, and only if they are set at all —
  // a link that says nothing is the body colour, and adopting that as the
  // link colour makes every link in the new theme invisible
  const links = seen(Array.from(root.querySelectorAll('a[href]')));
  const linkVote = poll<string>();
  const decorVoteLink = poll<string>();
  for (const a of links) {
    const own = st.own(a);
    const c = colour(own.color ?? '');
    if (c) linkVote.add(c, (a.textContent ?? '').trim().length || 1);
    const dec = own['text-decoration'] ?? own['text-decoration-line'];
    if (dec) decorVoteLink.add(dec.includes('none') ? 'none' : 'underline');
  }
  const linkColour = linkVote.best();
  if (linkColour) {
    out.link.color = linkColour;
    notes.push(`链接 ${linkColour}`);
  } else if (links.some((a) => /link/i.test(a.className))) {
    // The colour lives in WeChat's own stylesheet, which the page does not
    // carry — but it is the same blue on every article ever published there
    out.link.color = WECHAT_LINK_BLUE;
    notes.push(`链接用的是微信默认蓝 ${WECHAT_LINK_BLUE}`);
  } else if (links.length) {
    notes.push('链接没有自己的颜色，链接色沿用底板主题');
  }
  const linkDecor = decorVoteLink.best();
  if (linkDecor) out.link.textDecoration = linkDecor;

  // Footnote marks, where the article has them: the superscript is the one
  // piece of a WeChat article that is styled like nothing else in it
  const supVote = poll<string>();
  for (const el of seen(Array.from(root.querySelectorAll('sup')))) supVote.add(colour(st.prop(el, 'color')));
  const supColour = supVote.best();
  if (supColour) {
    out.footnote.refColor = supColour;
    out.footnote.numColor = supColour;
    notes.push(`脚注号 ${supColour}`);
  }

  const strong = root.querySelector('strong, b');
  if (strong) {
    const c = colour(st.prop(strong, 'color'));
    if (c && !near(c, out.body.color)) out.strongColor = c;
  }

  // A list marker the editor drew itself: a short symbol in a span of its own
  const li = root.querySelector('li');
  if (li) {
    const first = li.firstElementChild;
    const glyph = first?.textContent?.trim() ?? '';
    if (glyph && glyph.length <= 2 && SYMBOL.test(glyph)) {
      out.list = { ...out.list, bullet: glyph };
      const c = colour(st.prop(first!, 'color'));
      if (c) out.list.bulletColor = c;
    }
  }

  if (root.querySelector('img')) {
    const img = root.querySelector('img')!;
    const d = st.own(img);
    if (d['border-radius']) out.img.borderRadius = d['border-radius'];
    notes.push('文章里的图片、图形装饰扒不下来，只取了圆角');
  }

  return { theme: out, notes };
}

/* ---------------- Fetching ---------------- */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** The article's own title, for naming the theme after where it came from */
export function titleOf(doc: Document): string {
  const el = doc.querySelector('#activity-name') ?? doc.querySelector('title');
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Fetch a page and read a theme out of it.
 *
 * The fetch is the app's own, not a reader service: those are handed a
 * verification wall by WeChat instead of the article (see wechatArticle.ts),
 * and a wall has a typography of its own that would come back as the theme.
 */
export async function sniffThemeFromUrl(
  url: string,
  fetcher: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>,
  opts: { signal?: AbortSignal; base?: string } = {},
): Promise<SniffResult> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('已取消');
    throw new Error(`打不开这个链接：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`打不开这个链接（HTTP ${res.status}）。`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const isWechat = /mp\.weixin\.qq\.com/.test(url);
  if (isWechat && !doc.querySelector('#js_content')) {
    if (html.includes('环境异常')) {
      throw new Error('微信要求验证后才让访问这篇文章。在浏览器里打开一次通过验证，过一会儿再试。');
    }
    throw new Error('这个链接里没有文章正文 —— 确认一下是不是文章页的地址。');
  }
  const title = titleOf(doc);
  return sniffTheme(doc, {
    name: title ? `${title.slice(0, 10)} 的排版` : '扒来的排版',
    description: title ? `从《${title.slice(0, 20)}》扒来的排版` : '从一篇文章里扒来的排版',
    base: opts.base,
  });
}
