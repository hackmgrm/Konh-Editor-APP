/**
 * The theme system — the single source of styling for both preview and export.
 * Every style must be inline (the WeChat editor discards class and <style> and
 * keeps only inline style), so nothing here emits a CSS class; it emits style
 * strings.
 *
 * Each theme is a complete set of style tokens, and the renderer parameterizes
 * its inline output on them.
 */

export interface Theme {
  id: string;
  name: string;
  description: string;
  /** Whether the preview paper is light or dark (used to group the theme list;
   *  do not infer it from codePaletteMode) */
  appearance: 'light' | 'dark';
  /** Monospace face (code) */
  mono: string;
  /** Body baseline (wrapped by the section, inherited by paragraphs) */
  body: {
    font: string;
    fontSize: string;
    lineHeight: string;
    color: string;
    /** Article background (used by both the preview card and exports once set) */
    bg?: string;
    /** Indent the first line of every paragraph by two characters — the way a
     *  Chinese book sets prose, and a different silhouette from the blank line
     *  between paragraphs that the web defaults to */
    indent?: boolean;
    /** Justified prose. Only worth it with indent on; ragged-right is the
     *  safer default on a phone */
    align?: 'left' | 'justify';
  };
  /** Accent (heading decoration, quotes, links…) */
  accent: string;
  /** A pale form of the accent, for large fills like heading bands */
  accentSoft?: string;
  /** Headings */
  heading: {
    font: string;
    fontWeight: string;
    color: string;
    lineHeight: string;
    letterSpacing?: string;
    marginTop: string;
    marginBottom: string;
    /**
     * How a heading is marked out from the prose around it. This is the single
     * most defining choice in a theme — it is what you see before you read a
     * word — so the vocabulary is deliberately wide:
     *
     * - `none` — nothing but weight and size
     * - `underline` — a hairline under the whole width
     * - `band` — the heading sits in a filled, rounded band
     * - `accent-bar` — a rule *above* the heading, dividing the page
     * - `rule` — a heavy magazine rule under the text only
     * - `left-bar` — a vertical bar down the left, the WeChat house style
     * - `boxed` — a full outline around the text
     * - `marker` — a glyph in front of the text (see markerGlyph)
     * - `numbered` — an accent section number in front of every h2 (01, 02…)
     * - `center-rule` — centered, with a short rule under the text only
     */
    decor?:
      | 'none'
      | 'underline'
      | 'band'
      | 'accent-bar'
      | 'rule'
      | 'left-bar'
      | 'boxed'
      | 'marker'
      | 'numbered'
      | 'center-rule';
    /** The glyph the `marker` decor puts in front of the text (default ▍) */
    markerGlyph?: string;
    /** Centre every heading. `center-rule` implies this; set it on its own to
     *  centre without drawing anything */
    align?: 'left' | 'center';
  };
  headingSizes: { h1: string; h2: string; h3: string; h4: string; h5: string; h6: string };
  /** Paragraph spacing */
  pMargin: string;
  /** Callout (> [!tip]) */
  callout: {
    background: string;
    color: string;
    borderLeft: string;
    borderRadius: string;
    padding: string;
    margin: string;
    /** Title badge background (defaults to accentSoft) */
    badgeBg?: string;
    /** Title badge text color (defaults to accent) */
    badgeColor?: string;
    extra?: Record<string, string>;
  };
  /** Blockquote */
  quote: {
    background: string;
    color: string;
    borderLeft: string;
    borderRadius: string;
    padding: string;
    margin: string;
    fontStyle?: string;
  /** The oversized decorative quote character */
    bigMark?: boolean;
    /**
     * The shape of a quote, which `borderLeft` and `background` alone cannot
     * express:
     *
     * - `bar` — fill plus the left rule (the default, and what every theme did
     *   before there was a choice)
     * - `card` — a fill with no rule, floating free of the text
     * - `bracket` — no fill at all, wrapped in oversized 「」 corner brackets
     * - `pull` — a magazine pull quote: centred, a size up, rules above and
     *   below, nothing else
     *
     * `card`, `bracket` and `pull` ignore `borderLeft`; `bracket` and `pull`
     * also ignore `background`.
     */
    style?: 'bar' | 'card' | 'bracket' | 'pull';
    /** The character `bigMark` draws, and the pair `bracket` wraps with
     *  (give both, e.g. "「」"). Defaults to “ and 「」 */
    markGlyph?: string;
    extra?: Record<string, string>;
  };
  /** Inline code */
  code: { background: string; color: string; borderRadius: string; padding: string; fontSize: string; extra?: Record<string, string> };
  /** Code block */
  codeBlock: {
    background: string;
    color: string;
    borderRadius: string;
    padding: string;
    fontSize: string;
    lineHeight: string;
    /** What sits above the code: nothing, three window dots, or the language
     *  spelled out in the corner (only when the fence names one) */
    chrome?: 'none' | 'dots' | 'lang';
    extra?: Record<string, string>;
  };
  /** Links */
  link: { color: string; textDecoration: string };
  listPaddingLeft: string;
  listItemMargin: string;
  /**
   * List markers. Left alone, the browser's own bullets and numbers are used —
   * which is where every theme started, and why every theme's lists looked
   * identical. Naming a bullet switches to markers we draw ourselves, in the
   * accent, with a hanging indent.
   */
  list?: {
    /** Bullet glyph for unordered lists, e.g. '•' '▸' '—' '◇' '·' */
    bullet?: string;
    /** Bullet colour (defaults to the accent) */
    bulletColor?: string;
    /** How the numbers of an ordered list are drawn: as they come, in the
     *  accent, or as filled accent pills */
    ordered?: 'plain' | 'accent' | 'pill';
  };
  /** Tables */
  table: {
    borderColor: string;
    headBg: string;
    headColor: string;
    fontSize: string;
    cellPadding: string;
    /** `grid` rules every cell (the default), `minimal` keeps only the
     *  horizontal lines, `striped` fills alternate rows */
    style?: 'grid' | 'minimal' | 'striped';
    /** The fill `striped` uses on every other row */
    stripeBg?: string;
  };
  /** Horizontal rule */
  hr: {
    color: string;
    margin: string;
    /** A divider is a whole sentence of punctuation in a long article: a line,
     *  a dashed or dotted rule, a double rule, or a centred ornament */
    style?: 'line' | 'dashed' | 'dotted' | 'double' | 'glyph';
    /** What `glyph` draws, e.g. '❋' or '· · ·' */
    glyph?: string;
    /** Rule width; anything under 100% is centred */
    width?: string;
  };
  /** Images */
  img: {
    borderRadius: string;
    margin: string;
    /** Print the alt text (or title) under the picture as a caption, in the
     *  footnote colour and size */
    caption?: boolean;
    /** A border around the picture, e.g. '1px solid #e5e3dc' */
    frame?: string;
  };
  /** Bold color ('inherit' means take the body color) */
  strongColor: string;
  /** Strikethrough color */
  delColor: string;
  /** ==mark== highlight */
  mark: { background: string; color: string; borderRadius: string; padding: string; underline?: boolean; borderColor?: string };
  /** Footnotes */
  footnote: { refColor: string; blockBorder: string; textColor: string; numColor: string; textSize: string };
  /** highlight.js palette (key = hljs class, value = color) */
  codePalette: Record<string, string>;
  /** Palette mode (dark for the terminal theme, light for the rest) */
  codePaletteMode: 'light' | 'dark';
  /**
   * Front-matter driven article components (hero / intro / signature cards).
   *
   * Opt-in per theme: when `frontMatter` is unset the renderer behaves exactly
   * as before, so adding this block never changes articles that do not open
   * with a `---` front-matter. Colors default to other theme fields
   * (heading.color, hr.color, accentSoft…), so a theme can opt in with just
   * `{ "frontMatter": true }` and inherit the rest.
   */
  components?: {
    /** Enable `---` YAML front-matter → hero + intro + signature cards */
    frontMatter?: boolean;
    /** Card surface (defaults to body.bg) */
    cardBg?: string;
    /** Dark bar / header fill (defaults to heading.color) */
    ink?: string;
    /** Hairline / divider color (defaults to hr.color) */
    border?: string;
    /** Secondary text (defaults to body.color) */
    sub?: string;
    /** Muted text (defaults to delColor) */
    weak?: string;
    /** Soft fill for the intro body (defaults to accentSoft) */
    olive?: string;
  };
}

/* ---------------- Font stacks ---------------- */

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const SERIF = "Georgia, 'Songti SC', 'SimSun', 'Times New Roman', serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
const OLIVE_FONT = "'IBM Plex Sans',-apple-system,system-ui,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

/* ---------------- highlight.js palettes (one light, one dark) ---------------- */

/** Light palette: gentle contrast on a warm paper code block (shared by the
 *  classic, editorial and cream themes) */
const PALETTE_LIGHT: Record<string, string> = {
  'hljs-keyword': '#9a3d9e',
  'hljs-string': '#b4552f',
  'hljs-title': '#7a4a9e',
  'hljs-title.function_': '#7a4a9e',
  'hljs-title.class_': '#7a4a9e',
  'hljs-number': '#c0781a',
  'hljs-literal': '#c0781a',
  'hljs-built_in': '#4a7a9e',
  'hljs-type': '#4a7a9e',
  'hljs-attr': '#8a6d1a',
  'hljs-attribute': '#8a6d1a',
  'hljs-comment': '#a39c90',
  'hljs-meta': '#8a8376',
  'hljs-variable': '#2b6a52',
  'hljs-params': '#6a4a3a',
  'hljs-symbol': '#c0781a',
  'hljs-regexp': '#b4552f',
  'hljs-addition': '#4a7a52',
  'hljs-deletion': '#b44545',
  'hljs-selector-tag': '#9a3d9e',
  'hljs-selector-class': '#7a4a9e',
  'hljs-selector-id': '#7a4a9e',
  'hljs-selector-attr': '#8a6d1a',
  'hljs-selector-pseudo': '#8a6d1a',
  'hljs-tag': '#b4552f',
  'hljs-name': '#9a3d9e',
  'hljs-operator': '#6a5a4a',
  'hljs-bullet': '#c0781a',
  'hljs-quote': '#a39c90',
  'hljs-emphasis': '#6a5a4a',
  'hljs-strong': '#4a443c',
};

/** Dark palette: high-contrast neon on a black terminal (the dark terminal theme) */
const PALETTE_DARK: Record<string, string> = {
  'hljs-keyword': '#ff7ab2',
  'hljs-string': '#ffd27a',
  'hljs-title': '#7ad0ff',
  'hljs-title.function_': '#7ad0ff',
  'hljs-title.class_': '#7ad0ff',
  'hljs-number': '#ff9e64',
  'hljs-literal': '#ff9e64',
  'hljs-built_in': '#9eceff',
  'hljs-type': '#9eceff',
  'hljs-attr': '#c0e39a',
  'hljs-attribute': '#c0e39a',
  'hljs-comment': '#6a7a68',
  'hljs-meta': '#7a8a76',
  'hljs-variable': '#7adfae',
  'hljs-params': '#d8ceb8',
  'hljs-symbol': '#ff9e64',
  'hljs-regexp': '#ffd27a',
  'hljs-addition': '#7adfae',
  'hljs-deletion': '#ff7a7a',
  'hljs-selector-tag': '#ff7ab2',
  'hljs-selector-class': '#7ad0ff',
  'hljs-selector-id': '#7ad0ff',
  'hljs-selector-attr': '#c0e39a',
  'hljs-selector-pseudo': '#c0e39a',
  'hljs-tag': '#ffd27a',
  'hljs-name': '#ff7ab2',
  'hljs-operator': '#8a9a88',
  'hljs-bullet': '#ff9e64',
  'hljs-quote': '#6a7a68',
  'hljs-emphasis': '#8a9a88',
  'hljs-strong': '#e6ffe9',
};

/* ---------------- Theme presets ---------------- */

/** Classic: serif headings, terracotta accent — restrained and clean */
export const classicTheme: Theme = {
  id: 'classic',
  name: '经典',
  description: '衬线标题 + 陶土橙圆点，克制干净的默认',
  appearance: 'light',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.75', color: '#2b2b2b' },
  accent: '#d97757',
  heading: {
    font: SERIF,
    fontWeight: '700',
    color: '#1a1a1a',
    lineHeight: '1.4',
    letterSpacing: '0.5px',
    marginTop: '28px',
    marginBottom: '12px',
    decor: 'none',
  },
  headingSizes: { h1: '28px', h2: '24px', h3: '21px', h4: '19px', h5: '17px', h6: '16px' },
  pMargin: '16px',
  list: { bullet: '•', ordered: 'accent' },
  quote: {
    background: '#faf6f2',
    color: '#4a4a45',
    borderLeft: '4px solid #d97757',
    borderRadius: '0 6px 6px 0',
    padding: '12px 16px',
    margin: '20px 0',
  },
  callout: {
    background: '#f2efe8',
    color: '#4a4a45',
    borderLeft: '4px solid #d97757',
    borderRadius: '0 10px 10px 0',
    padding: '14px 16px',
    margin: '20px 0',
  },
  code: { background: '#f4f1ec', color: '#26231e', borderRadius: '4px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#f7f5f0', color: '#2b2823', borderRadius: '6px', padding: '14px 16px', fontSize: '14px', lineHeight: '1.6' },
  link: { color: '#d97757', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '6px 0',
  table: { borderColor: '#e5e3dc', headBg: '#f4f1ec', headColor: '#26231e', fontSize: '15px', cellPadding: '8px 12px' },
  hr: { color: '#e5e3dc', margin: '28px 0' },
  img: { borderRadius: '8px', margin: '16px auto' },
  strongColor: 'inherit',
  delColor: '#a6a29a',
  mark: { background: '#fff3c4', color: '#4a3a10', borderRadius: '3px', padding: '1px 4px' },
  footnote: { refColor: '#d97757', blockBorder: '#e5e3dc', textColor: '#8a867e', numColor: '#d97757', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Editorial: crimson accent, heavy serif display headings, newspaper pull
 *  quotes — the feel of a print newsroom */
export const editorialTheme: Theme = {
  id: 'editorial',
  name: '杂志编辑',
  description: '01/02 编号小节 + 居中引言 + 花饰分隔，报刊味',
  appearance: 'light',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.9', color: '#22211e', align: 'justify' },
  accent: '#c43a2d',
  accentSoft: 'rgba(196,58,45,.09)',
  heading: {
    font: "Georgia, 'Songti SC', 'STSong', serif",
    fontWeight: '800',
    color: '#14120e',
    lineHeight: '1.22',
    letterSpacing: '0.5px',
    marginTop: '40px',
    marginBottom: '16px',
    decor: 'numbered',
  },
  headingSizes: { h1: '32px', h2: '27px', h3: '22px', h4: '19px', h5: '17px', h6: '16px' },
  pMargin: '20px',
  list: { bullet: '▪', ordered: 'accent' },
  quote: {
    style: 'pull',
    background: 'transparent',
    color: '#6b4a3f',
    borderLeft: '3px solid #c43a2d',
    borderRadius: '0',
    padding: '6px 0 6px 20px',
    margin: '26px 0',
    fontStyle: 'italic',
    extra: {
      'font-family': "Georgia, 'Songti SC', serif",
      'font-size': '18px',
      'line-height': '1.8',
    },
  },
  callout: {
    background: 'rgba(196,58,45,.05)',
    color: '#5a463c',
    borderLeft: '3px solid #c43a2d',
    borderRadius: '0',
    padding: '14px 18px',
    margin: '26px 0',
  },
  code: { background: '#f0ece5', color: '#c43a2d', borderRadius: '3px', padding: '1px 5px', fontSize: '0.85em' },
  codeBlock: { background: '#f3efe9', color: '#2a2722', borderRadius: '0', padding: '18px 20px', fontSize: '14px', lineHeight: '1.7' },
  link: { color: '#c43a2d', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '8px 0',
  table: { borderColor: '#d9d3c8', headBg: '#14120e', headColor: '#f5f0e6', fontSize: '15px', cellPadding: '9px 12px', style: 'minimal' },
  hr: { color: '#c43a2d', margin: '32px 0', style: 'glyph', glyph: '❋' },
  img: { borderRadius: '0', margin: '20px auto', caption: true },
  strongColor: '#c43a2d',
  delColor: '#a39c90',
  mark: { background: '#ffe9a8', color: '#4a3a10', borderRadius: '2px', padding: '1px 4px' },
  footnote: { refColor: '#c43a2d', blockBorder: '#d9d3c8', textColor: '#8a8376', numColor: '#c43a2d', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Cream journal: honey amber on cream paper, sticker-like quote cards */
export const creamTheme: Theme = {
  id: 'cream',
  name: '奶油手账',
  description: '色带标题 + 卡片引用 + 数字圆牌，手账贴纸感',
  appearance: 'light',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.9', color: '#54422f', bg: '#fbf3e4' },
  accent: '#e0891a',
  accentSoft: 'rgba(224,137,26,.12)',
  heading: {
    font: "Georgia, 'Songti SC', serif",
    fontWeight: '700',
    color: '#7a4a12',
    lineHeight: '1.35',
    letterSpacing: '0.5px',
    marginTop: '34px',
    marginBottom: '12px',
    decor: 'band',
  },
  headingSizes: { h1: '28px', h2: '24px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '16px',
  list: { bullet: '◆', ordered: 'pill' },
  quote: {
    style: 'card',
    background: '#ffffff',
    color: '#6b553a',
    borderLeft: '5px solid #e0891a',
    borderRadius: '14px',
    padding: '16px 20px',
    margin: '22px 0',
    extra: { 'box-shadow': '0 3px 14px rgba(160,110,40,.12)' },
  },
  callout: {
    background: '#fff9ec',
    color: '#6b553a',
    borderLeft: '5px solid #e0891a',
    borderRadius: '14px',
    padding: '14px 18px',
    margin: '22px 0',
    extra: { 'box-shadow': '0 3px 14px rgba(160,110,40,.10)' },
  },
  code: { background: '#f7e8cd', color: '#a06a15', borderRadius: '6px', padding: '2px 6px', fontSize: '0.88em' },
  codeBlock: {
    chrome: 'lang',
    background: '#f8ecd6',
    color: '#5a4426',
    borderRadius: '12px',
    padding: '16px 18px',
    fontSize: '14px',
    lineHeight: '1.7',
    extra: { 'box-shadow': 'inset 0 0 0 1px rgba(200,140,40,.18)' },
  },
  link: { color: '#e0891a', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '7px 0',
  table: { borderColor: '#ecd9b8', headBg: '#f6e3c0', headColor: '#7a4a12', fontSize: '15px', cellPadding: '9px 12px' },
  hr: { color: '#e8d2a8', margin: '30px 0', style: 'dashed' },
  img: { borderRadius: '14px', margin: '18px auto', frame: '3px solid #f0e6d2' },
  strongColor: '#c97a08',
  delColor: '#b8a183',
  mark: { background: '#ffe9b0', color: '#6a4a10', borderRadius: '4px', padding: '1px 5px' },
  footnote: { refColor: '#e0891a', blockBorder: '#e8d2a8', textColor: '#9a8260', numColor: '#c97a08', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Dark terminal: terminal green, monospace headings, glowing code on black */
export const darkTheme: Theme = {
  id: 'dark',
  name: '暗夜终端',
  description: '$ 提示符标题 + 窗口红黄绿灯，终端气质',
  appearance: 'dark',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.85', color: '#c9d4c3', bg: '#0d1117' },
  accent: '#4ade80',
  accentSoft: 'rgba(74,222,128,.12)',
  heading: {
    font: MONO,
    fontWeight: '700',
    color: '#e6ffe9',
    lineHeight: '1.4',
    letterSpacing: '0.5px',
    marginTop: '34px',
    marginBottom: '12px',
    decor: 'marker',
    markerGlyph: '$',
  },
  headingSizes: { h1: '27px', h2: '22px', h3: '19px', h4: '17px', h5: '16px', h6: '15px' },
  pMargin: '16px',
  list: { bullet: '›', ordered: 'plain' },
  quote: {
    background: '#11161d',
    color: '#a8b8a3',
    borderLeft: '3px solid #4ade80',
    borderRadius: '0 10px 10px 0',
    padding: '13px 17px',
    margin: '22px 0',
    extra: { 'box-shadow': 'inset 0 0 0 1px rgba(74,222,128,.08)' },
  },
  callout: {
    background: 'rgba(74,222,128,.08)',
    color: '#a8b8a3',
    borderLeft: '3px solid #4ade80',
    borderRadius: '0 10px 10px 0',
    padding: '14px 16px',
    margin: '22px 0',
    extra: { 'box-shadow': 'inset 0 0 0 1px rgba(74,222,128,.10)' },
  },
  code: {
    background: '#0a0e13',
    color: '#4ade80',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '0.88em',
    extra: { border: '1px solid rgba(74,222,128,.22)', 'text-shadow': '0 0 8px rgba(74,222,128,.35)' },
  },
  codeBlock: {
    chrome: 'dots',
    background: '#080b0f',
    color: '#9fdcae',
    borderRadius: '10px',
    padding: '16px 18px',
    fontSize: '14px',
    lineHeight: '1.7',
    extra: { border: '1px solid rgba(74,222,128,.18)', 'box-shadow': '0 0 24px rgba(74,222,128,.06) inset' },
  },
  link: { color: '#4ade80', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '6px 0',
  table: { borderColor: '#1e2a24', headBg: '#111c16', headColor: '#b8f2c6', fontSize: '15px', cellPadding: '8px 12px', style: 'striped' },
  hr: { color: '#1e2a24', margin: '30px 0', style: 'dashed' },
  img: { borderRadius: '10px', margin: '16px auto' },
  strongColor: '#4ade80',
  delColor: '#5c6757',
  mark: { background: 'rgba(74,222,128,.22)', color: '#b8f2c6', borderRadius: '3px', padding: '1px 4px' },
  footnote: { refColor: '#4ade80', blockBorder: '#1e2a24', textColor: '#7c8a77', numColor: '#4ade80', textSize: '12px' },
  codePalette: PALETTE_DARK,
  codePaletteMode: 'dark',
};

/** Quiet blue notes: indigo accent over cool grey body — technical documentation */
export const indigoTheme: Theme = {
  id: 'indigo',
  name: '静蓝笔记',
  description: '左竖条标题 + 语言角标 + 斑马表格，技术文档',
  appearance: 'light',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.8', color: '#2f3540' },
  accent: '#3f6ecc',
  accentSoft: 'rgba(63,110,204,.10)',
  heading: {
    font: SANS,
    fontWeight: '700',
    color: '#1b2430',
    lineHeight: '1.42',
    letterSpacing: '0.2px',
    marginTop: '30px',
    marginBottom: '13px',
    decor: 'left-bar',
  },
  headingSizes: { h1: '27px', h2: '23px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '17px',
  list: { bullet: '▸', ordered: 'accent' },
  quote: {
    style: 'card',
    background: '#f3f6fc',
    color: '#44505f',
    borderLeft: '3px solid #3f6ecc',
    borderRadius: '0 8px 8px 0',
    padding: '12px 16px',
    margin: '22px 0',
  },
  callout: {
    background: 'rgba(63,110,204,.08)',
    color: '#3a4657',
    borderLeft: '3px solid #3f6ecc',
    borderRadius: '0 10px 10px 0',
    padding: '14px 16px',
    margin: '22px 0',
    badgeColor: '#2f58ad',
  },
  code: { background: '#eef2f9', color: '#2b3648', borderRadius: '4px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#f5f7fb', color: '#2b3648', borderRadius: '8px', padding: '14px 16px', fontSize: '14px', lineHeight: '1.62', chrome: 'lang' },
  link: { color: '#3f6ecc', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '6px 0',
  table: { borderColor: '#dde4ef', headBg: '#eef2f9', headColor: '#2b3648', fontSize: '15px', cellPadding: '8px 12px', style: 'striped' },
  hr: { color: '#dde4ef', margin: '30px 0' },
  img: { borderRadius: '8px', margin: '18px auto' },
  strongColor: '#1b2430',
  delColor: '#9aa3b0',
  mark: { background: '#dbe7ff', color: '#22355c', borderRadius: '3px', padding: '1px 4px' },
  footnote: { refColor: '#3f6ecc', blockBorder: '#dde4ef', textColor: '#7d8797', numColor: '#3f6ecc', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Pine ink: ink-green accent, Song-style headings, generous margins — an
 *  eastern, scholarly air */
export const inkTheme: Theme = {
  id: 'ink',
  name: '松墨',
  description: '首行缩进 + 居中标题 + 「」引文，中文书卷气',
  appearance: 'light',
  mono: MONO,
  body: { font: SERIF, fontSize: '16.5px', lineHeight: '1.95', color: '#33352f', indent: true },
  accent: '#4a6b52',
  accentSoft: 'rgba(74,107,82,.10)',
  heading: {
    font: SERIF,
    fontWeight: '700',
    color: '#232620',
    lineHeight: '1.5',
    letterSpacing: '1.5px',
    marginTop: '34px',
    marginBottom: '15px',
    decor: 'center-rule',
  },
  headingSizes: { h1: '27px', h2: '23px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '19px',
  list: { bullet: '○', ordered: 'accent' },
  quote: {
    style: 'bracket',
    markGlyph: '「」',
    background: 'transparent',
    color: '#55584f',
    borderLeft: '2px solid #4a6b52',
    borderRadius: '0',
    padding: '4px 0 4px 18px',
    margin: '26px 0',
    fontStyle: 'italic',
  },
  callout: {
    background: 'rgba(74,107,82,.07)',
    color: '#434639',
    borderLeft: '2px solid #4a6b52',
    borderRadius: '0 8px 8px 0',
    padding: '14px 18px',
    margin: '26px 0',
    badgeColor: '#3d5a44',
  },
  code: { background: '#f0f1ea', color: '#2f322b', borderRadius: '3px', padding: '2px 5px', fontSize: '0.88em' },
  codeBlock: { background: '#f4f5ee', color: '#2f322b', borderRadius: '4px', padding: '15px 17px', fontSize: '13.5px', lineHeight: '1.68' },
  link: { color: '#4a6b52', textDecoration: 'underline' },
  listPaddingLeft: '25px',
  listItemMargin: '8px 0',
  table: { borderColor: '#e0e1d8', headBg: '#f0f1ea', headColor: '#2f322b', fontSize: '15px', cellPadding: '9px 13px', style: 'minimal' },
  hr: { color: '#dcded3', margin: '34px 0', style: 'dotted' },
  img: { borderRadius: '2px', margin: '20px auto', caption: true },
  strongColor: '#232620',
  delColor: '#a3a59b',
  mark: { background: '#e6ecd9', color: '#333720', borderRadius: '2px', padding: '1px 4px' },
  footnote: { refColor: '#4a6b52', blockBorder: '#dcdede', textColor: '#847f76', numColor: '#4a6b52', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Sakura snow: soft pink accent and rounded cards — light and airy */
export const sakuraTheme: Theme = {
  id: 'sakura',
  name: '樱雪',
  description: '❁ 标题符 + 圆润卡片 + 花瓣列表，轻盈通透',
  appearance: 'light',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.85', color: '#4a3f45', bg: '#fffafc' },
  accent: '#d9628a',
  accentSoft: 'rgba(217,98,138,.10)',
  heading: {
    font: SANS,
    fontWeight: '700',
    color: '#3d2f36',
    lineHeight: '1.45',
    letterSpacing: '0.3px',
    marginTop: '30px',
    marginBottom: '13px',
    decor: 'marker',
    markerGlyph: '❁',
  },
  headingSizes: { h1: '27px', h2: '23px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '17px',
  list: { bullet: '❀', ordered: 'pill' },
  quote: {
    style: 'card',
    background: '#fdeef4',
    color: '#5a4a52',
    borderLeft: 'none',
    borderRadius: '12px',
    padding: '14px 18px',
    margin: '22px 0',
  },
  callout: {
    background: '#fce8f0',
    color: '#59444e',
    borderLeft: 'none',
    borderRadius: '14px',
    padding: '15px 18px',
    margin: '22px 0',
    badgeColor: '#c14a76',
  },
  code: { background: '#fbeaf1', color: '#6d3b50', borderRadius: '5px', padding: '2px 6px', fontSize: '0.9em' },
  codeBlock: { background: '#fdf2f6', color: '#4a3540', borderRadius: '12px', padding: '15px 17px', fontSize: '14px', lineHeight: '1.62' },
  link: { color: '#d9628a', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '7px 0',
  table: { borderColor: '#f3dae4', headBg: '#fceaf2', headColor: '#5c3f4c', fontSize: '15px', cellPadding: '8px 12px' },
  hr: { color: '#f3dae4', margin: '30px 0', style: 'glyph', glyph: '✿' },
  img: { borderRadius: '14px', margin: '18px auto' },
  strongColor: '#c14a76',
  delColor: '#b9a8af',
  mark: { background: '#ffe0ec', color: '#7a2f4d', borderRadius: '4px', padding: '1px 5px' },
  footnote: { refColor: '#d9628a', blockBorder: '#f3dae4', textColor: '#95848c', numColor: '#d9628a', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Minimal grey: no accent decoration, neutral greyscale — typography alone */
export const minimalTheme: Theme = {
  id: 'minimal',
  name: '极简灰',
  description: '零装饰标题 + 短分隔线 + 破折号列表，只剩排版',
  appearance: 'light',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.8', color: '#3a3a3a' },
  accent: '#5c5c5c',
  accentSoft: 'rgba(92,92,92,.08)',
  heading: {
    font: SANS,
    fontWeight: '600',
    color: '#171717',
    lineHeight: '1.4',
    letterSpacing: '-0.2px',
    marginTop: '32px',
    marginBottom: '12px',
    decor: 'none',
  },
  headingSizes: { h1: '26px', h2: '22px', h3: '19px', h4: '17px', h5: '16px', h6: '15px' },
  pMargin: '16px',
  list: { bullet: '—', bulletColor: '#a8a49c', ordered: 'plain' },
  quote: {
    background: 'transparent',
    color: '#5c5c5c',
    borderLeft: '3px solid #d4d4d4',
    borderRadius: '0',
    padding: '2px 0 2px 16px',
    margin: '22px 0',
  },
  callout: {
    background: '#f5f5f5',
    color: '#454545',
    borderLeft: '3px solid #a3a3a3',
    borderRadius: '0 6px 6px 0',
    padding: '13px 16px',
    margin: '22px 0',
    badgeColor: '#262626',
  },
  code: { background: '#f0f0f0', color: '#262626', borderRadius: '3px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#fafafa', color: '#292929', borderRadius: '6px', padding: '14px 16px', fontSize: '13.5px', lineHeight: '1.62', extra: { border: '1px solid #ebebeb' } },
  link: { color: '#171717', textDecoration: 'underline' },
  listPaddingLeft: '25px',
  listItemMargin: '6px 0',
  table: { borderColor: '#e0e0e0', headBg: '#f5f5f5', headColor: '#262626', fontSize: '15px', cellPadding: '8px 12px', style: 'minimal' },
  hr: { color: '#e0e0e0', margin: '32px 0', style: 'line', width: '15%' },
  img: { borderRadius: '4px', margin: '18px auto' },
  strongColor: '#171717',
  delColor: '#a3a3a3',
  mark: { background: '#ececec', color: '#171717', borderRadius: '2px', padding: '1px 4px' },
  footnote: { refColor: '#5c5c5c', blockBorder: '#e0e0e0', textColor: '#8a8a8a', numColor: '#5c5c5c', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Vintage typewriter: monospace body on kraft paper — the look of a typescript */
export const typewriterTheme: Theme = {
  id: 'typewriter',
  name: '打字机',
  description: '# 号标题 + 虚线分隔 + 星号列表，打字稿气质',
  appearance: 'light',
  mono: MONO,
  body: { font: MONO, fontSize: '15px', lineHeight: '1.85', color: '#3c352b', bg: '#f7f2e7' },
  accent: '#8a5a2b',
  accentSoft: 'rgba(138,90,43,.10)',
  heading: {
    font: MONO,
    fontWeight: '700',
    color: '#2b2519',
    lineHeight: '1.4',
    letterSpacing: '0.6px',
    marginTop: '30px',
    marginBottom: '13px',
    decor: 'marker',
    markerGlyph: '#',
  },
  headingSizes: { h1: '24px', h2: '21px', h3: '18px', h4: '17px', h5: '16px', h6: '15px' },
  pMargin: '17px',
  list: { bullet: '*', ordered: 'plain' },
  quote: {
    background: 'rgba(138,90,43,.06)',
    color: '#4d4436',
    borderLeft: '3px double #8a5a2b',
    borderRadius: '0',
    padding: '12px 16px',
    margin: '22px 0',
  },
  callout: {
    background: 'rgba(138,90,43,.09)',
    color: '#463d2f',
    borderLeft: '3px double #8a5a2b',
    borderRadius: '0',
    padding: '14px 16px',
    margin: '22px 0',
    badgeColor: '#75471f',
  },
  code: { background: '#ece3d1', color: '#3a3226', borderRadius: '2px', padding: '2px 5px', fontSize: '0.92em' },
  codeBlock: { background: '#efe7d6', color: '#39311f', borderRadius: '2px', padding: '14px 16px', fontSize: '13px', lineHeight: '1.65', extra: { border: '1px dashed #c9b795' } },
  link: { color: '#8a5a2b', textDecoration: 'underline' },
  listPaddingLeft: '24px',
  listItemMargin: '6px 0',
  table: { borderColor: '#d8c9a9', headBg: '#ece3d1', headColor: '#39311f', fontSize: '14px', cellPadding: '8px 12px', style: 'grid' },
  hr: { color: '#d8c9a9', margin: '30px 0', style: 'dashed' },
  img: { borderRadius: '2px', margin: '18px auto' },
  strongColor: '#2b2519',
  delColor: '#a3977f',
  mark: { background: '#e8d79f', color: '#453718', borderRadius: '2px', padding: '1px 4px' },
  footnote: { refColor: '#8a5a2b', blockBorder: '#d8c9a9', textColor: '#867a63', numColor: '#8a5a2b', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
};

/** Midnight indigo: deep indigo ground with a cyan accent — dark reading
 *  without the glare */
export const midnightTheme: Theme = {
  id: 'midnight',
  name: '午夜靛',
  description: '色带标题 + 居中引言 + ◈ 分隔，暗色长读',
  appearance: 'dark',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.85', color: '#c3cbd9', bg: '#161b26' },
  accent: '#61b6f2',
  accentSoft: 'rgba(97,182,242,.13)',
  heading: {
    font: SANS,
    fontWeight: '700',
    color: '#eaf1fb',
    lineHeight: '1.42',
    letterSpacing: '0.2px',
    marginTop: '30px',
    marginBottom: '13px',
    decor: 'band',
  },
  headingSizes: { h1: '27px', h2: '23px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '17px',
  list: { bullet: '◆', ordered: 'pill' },
  quote: {
    style: 'pull',
    background: 'rgba(97,182,242,.07)',
    color: '#aab6c8',
    borderLeft: '3px solid #61b6f2',
    borderRadius: '0 8px 8px 0',
    padding: '12px 16px',
    margin: '22px 0',
  },
  callout: {
    background: 'rgba(97,182,242,.12)',
    color: '#c3cbd9',
    borderLeft: '3px solid #61b6f2',
    borderRadius: '0 10px 10px 0',
    padding: '14px 16px',
    margin: '22px 0',
    badgeColor: '#8fd0ff',
  },
  code: { background: 'rgba(255,255,255,.08)', color: '#d8e3f2', borderRadius: '4px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#0f131c', color: '#d3dcea', borderRadius: '8px', padding: '15px 17px', fontSize: '13.5px', lineHeight: '1.65', extra: { border: '1px solid rgba(255,255,255,.07)' } },
  link: { color: '#61b6f2', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '6px 0',
  table: { borderColor: 'rgba(255,255,255,.12)', headBg: 'rgba(255,255,255,.06)', headColor: '#eaf1fb', fontSize: '15px', cellPadding: '8px 12px', style: 'striped' },
  hr: { color: 'rgba(255,255,255,.12)', margin: '30px 0', style: 'glyph', glyph: '◈' },
  img: { borderRadius: '8px', margin: '18px auto' },
  strongColor: '#eaf1fb',
  delColor: '#6d7688',
  mark: { background: 'rgba(97,182,242,.25)', color: '#eaf1fb', borderRadius: '3px', padding: '1px 4px' },
  footnote: { refColor: '#61b6f2', blockBorder: 'rgba(255,255,255,.12)', textColor: '#8b95a6', numColor: '#61b6f2', textSize: '12px' },
  codePalette: PALETTE_DARK,
  codePaletteMode: 'dark',
};

/** Graphite: neutral warm black with an amber accent, easy on the eyes through
 *  a long night of writing */
export const graphiteTheme: Theme = {
  id: 'graphite',
  name: '石墨',
  description: '杂志粗线标题 + 双线分隔 + 极简表格，沉稳',
  appearance: 'dark',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.85', color: '#d2cec6', bg: '#1c1c1e' },
  accent: '#e8a33d',
  accentSoft: 'rgba(232,163,61,.13)',
  heading: {
    font: SANS,
    fontWeight: '700',
    color: '#f5f2ec',
    lineHeight: '1.42',
    letterSpacing: '0.2px',
    marginTop: '30px',
    marginBottom: '13px',
    decor: 'rule',
  },
  headingSizes: { h1: '27px', h2: '23px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '17px',
  list: { bullet: '—', ordered: 'accent' },
  quote: {
    background: 'rgba(232,163,61,.07)',
    color: '#bab5ab',
    borderLeft: '3px solid #e8a33d',
    borderRadius: '0 8px 8px 0',
    padding: '12px 16px',
    margin: '22px 0',
  },
  callout: {
    background: 'rgba(232,163,61,.12)',
    color: '#d2cec6',
    borderLeft: '3px solid #e8a33d',
    borderRadius: '0 10px 10px 0',
    padding: '14px 16px',
    margin: '22px 0',
    badgeColor: '#f0bc6e',
  },
  code: { background: 'rgba(255,255,255,.08)', color: '#e6e1d8', borderRadius: '4px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#141416', color: '#ddd8ce', borderRadius: '8px', padding: '15px 17px', fontSize: '13.5px', lineHeight: '1.65', extra: { border: '1px solid rgba(255,255,255,.07)' } },
  link: { color: '#e8a33d', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '6px 0',
  table: { borderColor: 'rgba(255,255,255,.12)', headBg: 'rgba(255,255,255,.06)', headColor: '#f5f2ec', fontSize: '15px', cellPadding: '8px 12px', style: 'minimal' },
  hr: { color: 'rgba(255,255,255,.12)', margin: '30px 0', style: 'double' },
  img: { borderRadius: '8px', margin: '18px auto' },
  strongColor: '#f5f2ec',
  delColor: '#7d786f',
  mark: { background: 'rgba(232,163,61,.25)', color: '#f5f2ec', borderRadius: '3px', padding: '1px 4px' },
  footnote: { refColor: '#e8a33d', blockBorder: 'rgba(255,255,255,.12)', textColor: '#969085', numColor: '#e8a33d', textSize: '12px' },
  codePalette: PALETTE_DARK,
  codePaletteMode: 'dark',
};

/** Night sakura: purple-black paper, cherry-pink accent, serif headings — the
 *  literary end of the dark themes */
export const nightSakuraTheme: Theme = {
  id: 'night-sakura',
  name: '夜樱',
  description: '居中标题 + 『』引文 + ✦ 分隔，夜里的樱',
  appearance: 'dark',
  mono: MONO,
  body: { font: SANS, fontSize: '16px', lineHeight: '1.9', color: '#d3c8d6', bg: '#1a1520' },
  accent: '#e07a9f',
  accentSoft: 'rgba(224,122,159,.13)',
  heading: {
    font: SERIF,
    fontWeight: '700',
    color: '#f6ecf2',
    lineHeight: '1.45',
    letterSpacing: '0.6px',
    marginTop: '32px',
    marginBottom: '14px',
    decor: 'center-rule',
  },
  headingSizes: { h1: '27px', h2: '23px', h3: '20px', h4: '18px', h5: '17px', h6: '16px' },
  pMargin: '18px',
  list: { bullet: '❖', ordered: 'accent' },
  quote: {
    style: 'bracket',
    markGlyph: '『』',
    background: 'rgba(224,122,159,.07)',
    color: '#bcb0c0',
    borderLeft: '3px solid #e07a9f',
    borderRadius: '0 8px 8px 0',
    padding: '12px 16px',
    margin: '24px 0',
    fontStyle: 'italic',
  },
  callout: {
    background: 'rgba(224,122,159,.12)',
    color: '#d3c8d6',
    borderLeft: '3px solid #e07a9f',
    borderRadius: '0 10px 10px 0',
    padding: '14px 16px',
    margin: '24px 0',
    badgeColor: '#f0a3bf',
  },
  code: { background: 'rgba(255,255,255,.08)', color: '#ecdfe6', borderRadius: '4px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#130f18', color: '#ddd2e0', borderRadius: '8px', padding: '15px 17px', fontSize: '13.5px', lineHeight: '1.65', extra: { border: '1px solid rgba(255,255,255,.07)' } },
  link: { color: '#e07a9f', textDecoration: 'underline' },
  listPaddingLeft: '26px',
  listItemMargin: '7px 0',
  table: { borderColor: 'rgba(255,255,255,.12)', headBg: 'rgba(255,255,255,.06)', headColor: '#f6ecf2', fontSize: '15px', cellPadding: '8px 12px' },
  hr: { color: 'rgba(255,255,255,.12)', margin: '32px 0', style: 'glyph', glyph: '✦' },
  img: { borderRadius: '10px', margin: '18px auto', caption: true },
  strongColor: '#f6ecf2',
  delColor: '#8a7f8d',
  mark: { background: 'rgba(224,122,159,.25)', color: '#f6ecf2', borderRadius: '3px', padding: '1px 4px' },
  footnote: { refColor: '#e07a9f', blockBorder: 'rgba(255,255,255,.12)', textColor: '#9a8fa0', numColor: '#e07a9f', textSize: '12px' },
  codePalette: PALETTE_DARK,
  codePaletteMode: 'dark',
};

/** 空核域界定制版：墨黑标题、橄榄灰卡片与橙色强调，并通过
 *  front-matter 生成品牌头图、导语和签名卡。内部 id 保留 olive-journal，
 *  以免升级后让已经选用该主题的草稿失去主题。 */
export const oliveJournalTheme: Theme = {
  ...editorialTheme,
  id: 'olive-journal',
  name: '空核域界',
  description: '空核域界品牌定制版：墨黑标题、橄榄灰底卡与橙色强调；front-matter 自动生成品牌头图、导语和签名',
  appearance: 'light',
  mono: MONO,
  body: { font: OLIVE_FONT, fontSize: '14px', lineHeight: '1.9', color: '#4d4f46', bg: '#fdfdf8', align: 'justify' },
  accent: '#ed7b2f',
  accentSoft: '#eeefe9',
  heading: { font: OLIVE_FONT, fontWeight: '800', color: '#23251d', lineHeight: '1.3', letterSpacing: '0.2px', marginTop: '24px', marginBottom: '8px', decor: 'numbered' },
  headingSizes: { h1: '24px', h2: '18px', h3: '16px', h4: '15px', h5: '17px', h6: '16px' },
  pMargin: '24px',
  list: { bullet: '•', bulletColor: '#4d4f46', ordered: 'accent' },
  quote: { style: 'bar', background: '#eeefe9', color: '#4d4f46', borderLeft: '4px solid #ed7b2f', borderRadius: '0 8px 8px 0', padding: '14px 18px', margin: '24px 0', fontStyle: 'italic', extra: { 'text-align': 'justify' } },
  callout: { background: '#eeefe9', color: '#4d4f46', borderLeft: '4px solid #ed7b2f', borderRadius: '0 10px 10px 0', padding: '14px 18px', margin: '24px 0', badgeBg: '#ed7b2f', badgeColor: '#ffffff' },
  code: { background: '#e5e7e0', color: '#1e1f23', borderRadius: '4px', padding: '2px 5px', fontSize: '0.9em' },
  codeBlock: { background: '#eeefe9', color: '#1e1f23', borderRadius: '6px', padding: '14px 16px', fontSize: '14px', lineHeight: '1.6' },
  link: { color: '#ed7b2f', textDecoration: 'underline' },
  listPaddingLeft: '22px',
  listItemMargin: '8px 0',
  table: { borderColor: '#bfc1b7', headBg: '#eeefe9', headColor: '#23251d', fontSize: '15px', cellPadding: '8px 12px', style: 'minimal' },
  hr: { color: '#bfc1b7', margin: '28px 0', style: 'glyph', glyph: '· · ·' },
  img: { borderRadius: '8px', margin: '16px auto', caption: true },
  strongColor: '#23251d',
  delColor: '#9ea096',
  mark: { background: '#fbe6d6', color: '#23251d', borderRadius: '3px', padding: '1px 4px', underline: true, borderColor: '#ed7b2f' },
  footnote: { refColor: '#ed7b2f', blockBorder: '#bfc1b7', textColor: '#9ea096', numColor: '#ed7b2f', textSize: '12px' },
  codePalette: PALETTE_LIGHT,
  codePaletteMode: 'light',
  components: { frontMatter: true, cardBg: '#fdfdf8', ink: '#1e1f23', border: '#bfc1b7', sub: '#65675e', weak: '#9ea096', olive: '#eeefe9' },
};

/** Presets adapted from isjiamu/gzh-design-skill. The source component
 * libraries are richer than this renderer's token vocabulary, so these keep
 * each theme's palette, heading silhouette and characteristic surfaces. */
export const moyuGreenTheme: Theme = {
  ...classicTheme,
  id: 'moyu-green', name: '摸鱼绿', description: '翡翠绿杂志风，卡片丰富、信息密度高，适合教程与工具盘点',
  accent: '#059669', accentSoft: '#ECFDF5',
  body: { ...classicTheme.body, fontSize: '14px', lineHeight: '1.9', color: '#374151' },
  heading: { ...classicTheme.heading, color: '#111827', decor: 'band' },
  quote: { ...classicTheme.quote, background: '#ECFDF5', color: '#374151', borderLeft: '4px solid #059669', borderRadius: '10px' },
  callout: { ...classicTheme.callout, background: '#F0FDF4', color: '#374151', borderLeft: '4px solid #059669', borderRadius: '10px', badgeBg: '#059669', badgeColor: '#ffffff' },
  list: { bullet: '▸', bulletColor: '#059669', ordered: 'pill' },
  table: { ...classicTheme.table, borderColor: '#BBF7D0', headBg: '#059669', headColor: '#ffffff', style: 'striped', stripeBg: '#F0FDF4' },
  hr: { color: '#A7F3D0', margin: '30px 0', style: 'dashed' },
  mark: { background: '#FDE68A', color: '#111827', borderRadius: '3px', padding: '1px 4px', underline: true, borderColor: '#059669' },
  strongColor: '#111827', link: { color: '#059669', textDecoration: 'underline' },
};

export const redWhiteTheme: Theme = {
  ...editorialTheme,
  id: 'red-white', name: '红白色系', description: '正红点睛的经典编辑风，编号章节与力量感标题',
  accent: '#DC2626', accentSoft: '#FEF2F2',
  body: { ...editorialTheme.body, color: '#44403C', bg: '#ffffff' },
  heading: { ...editorialTheme.heading, color: '#1C1917', decor: 'numbered' },
  quote: { ...editorialTheme.quote, background: '#ffffff', color: '#1C1917', borderLeft: '4px solid #DC2626', borderRadius: '12px', style: 'card', bigMark: true },
  callout: { ...editorialTheme.callout, background: '#FEF2F2', color: '#44403C', borderLeft: '4px solid #DC2626', badgeBg: '#DC2626', badgeColor: '#ffffff' },
  table: { ...editorialTheme.table, borderColor: '#FECACA', headBg: '#DC2626', headColor: '#ffffff' },
  hr: { color: '#FECACA', margin: '32px 0', style: 'double' },
  mark: { background: '#FEE2E2', color: '#991B1B', borderRadius: '4px', padding: '1px 4px', underline: true, borderColor: '#DC2626' },
  strongColor: '#1C1917', link: { color: '#DC2626', textDecoration: 'underline' },
};

export const graphiteMinimalTheme: Theme = {
  ...minimalTheme,
  id: 'graphite-minimal', name: '石墨极简', description: '纯白、石墨灰、几何细线与大留白，理性克制',
  accent: '#52525B', accentSoft: '#F4F4F5',
  body: { ...minimalTheme.body, color: '#52525B', bg: '#ffffff' },
  heading: { ...minimalTheme.heading, color: '#27272A', decor: 'numbered' },
  quote: { ...minimalTheme.quote, background: '#FAFAFA', color: '#3F3F46', borderLeft: '0', borderRadius: '0', style: 'pull' },
  callout: { ...minimalTheme.callout, background: '#FAFAFA', color: '#52525B', borderLeft: '3px solid #52525B', borderRadius: '0' },
  hr: { color: '#E4E4E7', margin: '38px 0', style: 'line', width: '18%' },
  mark: { background: '#F4F4F5', color: '#27272A', borderRadius: '0', padding: '1px 3px', underline: true, borderColor: '#52525B' },
  strongColor: '#27272A', link: { color: '#52525B', textDecoration: 'underline' },
};

export const zenWhitespaceTheme: Theme = {
  ...minimalTheme,
  id: 'zen-whitespace', name: '留白禅意', description: '墨绿点睛、东方衬线与超大留白，沉静舒展',
  accent: '#4A5D52', accentSoft: '#EEF3F0',
  body: { ...minimalTheme.body, lineHeight: '1.9', color: '#525252', bg: '#ffffff' },
  heading: { ...minimalTheme.heading, font: SERIF, color: '#2B2B2B', align: 'center', decor: 'center-rule', marginTop: '46px' },
  quote: { ...minimalTheme.quote, background: '#ffffff', color: '#2B2B2B', borderLeft: '0', borderRadius: '0', style: 'pull', fontStyle: 'normal' },
  callout: { ...minimalTheme.callout, background: '#EEF3F0', color: '#3D5046', borderLeft: '0', borderRadius: '0' },
  hr: { color: '#E8E8E8', margin: '46px 0', style: 'line', width: '15%' },
  mark: { background: '#D6E4DC', color: '#2B2B2B', borderRadius: '0', padding: '1px 3px', underline: true, borderColor: '#B5C8BC' },
  strongColor: '#2B2B2B', link: { color: '#4A5D52', textDecoration: 'underline' },
};

export const moyuTicketTheme: Theme = {
  ...typewriterTheme,
  id: 'moyu-ticket', name: '摸鱼票据', description: '米黄纸感、票据描边与硬阴影，适合测评和工具对比',
  accent: '#059669', accentSoft: '#F0FDF4',
  body: { ...typewriterTheme.body, font: SANS, fontSize: '14px', lineHeight: '1.9', color: '#555555', bg: '#fffef8' },
  heading: { ...typewriterTheme.heading, font: SANS, color: '#1a1a1a', decor: 'boxed' },
  quote: { ...typewriterTheme.quote, background: '#fffef8', color: '#555555', borderLeft: '2px dashed #059669', borderRadius: '0', extra: { border: '2px solid #1a1a1a', 'box-shadow': '4px 4px 0 #1a1a1a' } },
  callout: { ...typewriterTheme.callout, background: '#F0FDF4', color: '#555555', borderLeft: '4px solid #059669', borderRadius: '0' },
  list: { bullet: '★', bulletColor: '#059669', ordered: 'pill' },
  table: { ...typewriterTheme.table, borderColor: '#1a1a1a', headBg: '#059669', headColor: '#ffffff' },
  hr: { color: '#A7F3D0', margin: '34px 0', style: 'dashed' },
  img: { ...typewriterTheme.img, borderRadius: '0', frame: '2px solid #1a1a1a' },
  mark: { background: '#F0FDF4', color: '#1a1a1a', borderRadius: '0', padding: '1px 4px', underline: true, borderColor: '#059669' },
  strongColor: '#1a1a1a', link: { color: '#059669', textDecoration: 'underline' },
};

/** Presets adapted from Kianzzz/zhouxing-paiban-wx's style library. */
export const graphiteDossierTheme: Theme = {
  ...editorialTheme,
  id: 'graphite-dossier', name: '石墨档案', description: '等宽编号、档案章标、密集网格与无圆角结构',
  accent: '#4B5563', accentSoft: '#F3F4F6',
  body: { ...editorialTheme.body, color: '#374151', bg: '#ffffff' },
  heading: { ...editorialTheme.heading, font: MONO, color: '#111827', decor: 'numbered' },
  quote: { ...editorialTheme.quote, background: '#F3F4F6', color: '#374151', borderLeft: '4px solid #4B5563', borderRadius: '0' },
  callout: { ...editorialTheme.callout, background: '#F3F4F6', color: '#374151', borderLeft: '4px solid #4B5563', borderRadius: '0' },
  table: { ...editorialTheme.table, borderColor: '#9CA3AF', headBg: '#1F2937', headColor: '#ffffff', style: 'grid' },
  hr: { color: '#4B5563', margin: '34px 0', style: 'double' },
  img: { ...editorialTheme.img, borderRadius: '0', frame: '1px solid #9CA3AF' },
  strongColor: '#111827', link: { color: '#4B5563', textDecoration: 'underline' },
};

export const greenWhiteCleanTheme: Theme = {
  ...moyuGreenTheme,
  id: 'green-white-clean', name: '绿白清简', description: '水印刊头、轻量章节、对话引用卡与克制代码卡',
  accent: '#01A539', accentSoft: '#F2FFF5',
  heading: { ...moyuGreenTheme.heading, color: '#015F25', decor: 'accent-bar' },
  quote: { ...moyuGreenTheme.quote, background: '#ffffff', color: '#475569', borderLeft: '4px solid #01A539', borderRadius: '10px' },
  table: { ...moyuGreenTheme.table, borderColor: '#C8F0D2', headBg: '#F2FFF5', headColor: '#015F25' },
  hr: { color: '#C8F0D2', margin: '40px 0', style: 'line' },
  link: { color: '#01A539', textDecoration: 'underline' },
};

export const inkBlueEditorialTheme: Theme = {
  ...editorialTheme,
  id: 'ink-blue-editorial', name: '墨蓝刊读', description: '衬线正文、通栏深色章节、居中引语与影印图片',
  accent: '#315B7D', accentSoft: '#F2F6F9',
  body: { ...editorialTheme.body, font: SERIF, color: '#263746', bg: '#ffffff' },
  heading: { ...editorialTheme.heading, font: SERIF, color: '#183247', decor: 'band' },
  quote: { ...editorialTheme.quote, background: '#ffffff', color: '#294C67', borderLeft: '0', borderRadius: '0', style: 'pull' },
  callout: { ...editorialTheme.callout, background: '#F2F6F9', color: '#294C67', borderLeft: '4px solid #315B7D', borderRadius: '0' },
  table: { ...editorialTheme.table, borderColor: '#7895AB', headBg: '#183247', headColor: '#ffffff' },
  hr: { color: '#315B7D', margin: '40px 0', style: 'double' },
  img: { borderRadius: '0', margin: '28px auto', caption: true, frame: '9px solid #ffffff' },
  strongColor: '#183247', link: { color: '#315B7D', textDecoration: 'underline' },
};

export const mistPurpleStoryTheme: Theme = {
  ...zenWhitespaceTheme,
  id: 'mist-purple-story', name: '雾紫叙事', description: '窄栏衬线、大段呼吸、居中章名与大字金句',
  accent: '#7559A6', accentSoft: '#F4EEFC',
  body: { ...zenWhitespaceTheme.body, font: SERIF, lineHeight: '2.08', color: '#4C4556' },
  heading: { ...zenWhitespaceTheme.heading, color: '#4E3C70', decor: 'center-rule' },
  quote: { ...zenWhitespaceTheme.quote, color: '#594A70' },
  callout: { ...zenWhitespaceTheme.callout, background: '#F4EEFC', color: '#594A70' },
  table: { ...zenWhitespaceTheme.table, borderColor: '#DCCFF0', headBg: '#ffffff', headColor: '#4E3C70', style: 'minimal' },
  hr: { color: '#7559A6', margin: '48px 0', style: 'line', width: '38px' },
  mark: { background: '#DCCFF0', color: '#3E3158', borderRadius: '0', padding: '1px 3px' },
  strongColor: '#3E3158', link: { color: '#7559A6', textDecoration: 'underline' },
};

export const sandGoldJournalTheme: Theme = {
  ...moyuTicketTheme,
  id: 'sand-gold-journal', name: '沙金手记', description: '米黄纸张、虚线撕口、硬阴影与盖章式章节',
  accent: '#9A6A2F', accentSoft: '#FFFDF8',
  body: { ...moyuTicketTheme.body, font: SERIF, color: '#594837', bg: '#FFFDF8' },
  heading: { ...moyuTicketTheme.heading, font: SERIF, color: '#4E3822', decor: 'boxed' },
  quote: { ...moyuTicketTheme.quote, background: '#FFFDF8', color: '#6A5138', borderLeft: '1px dashed #9A6A2F', extra: { border: '1px dashed #9A6A2F', 'box-shadow': '5px 5px 0 #EFE2CB' } },
  callout: { ...moyuTicketTheme.callout, background: '#FFFDF8', color: '#6A5138', borderLeft: '4px solid #9A6A2F' },
  table: { ...moyuTicketTheme.table, borderColor: '#C7A675', headBg: '#6B4A26', headColor: '#ffffff' },
  hr: { color: '#9A6A2F', margin: '40px 0', style: 'dashed' },
  img: { borderRadius: '0', margin: '28px auto', caption: true, frame: '10px solid #FFFDF8' },
  mark: { background: '#FFFDF8', color: '#6B4A26', borderRadius: '999px', padding: '1px 5px', underline: true, borderColor: '#9A6A2F' },
  strongColor: '#4E3822', link: { color: '#9A6A2F', textDecoration: 'underline' },
};

/** Seven editorial presets adapted from DeepTalk's ISC-licensed design
 * references. Brand names are intentionally replaced with descriptive Chinese
 * names; the presets preserve the visual ideas without implying affiliation. */
export const orbitalBlackTheme: Theme = {
  ...darkTheme,
  id: 'orbital-black', name: '航际黑', description: '纯黑航天电影感，大字留白与幽灵白线框，适合航空和航线专题',
  body: { ...darkTheme.body, color: '#f0f0fa', bg: '#000000', lineHeight: '1.9' },
  accent: '#f0f0fa', accentSoft: 'rgba(240,240,250,.10)',
  heading: { ...darkTheme.heading, color: '#f0f0fa', letterSpacing: '0.8px', decor: 'accent-bar' },
  quote: { ...darkTheme.quote, background: 'rgba(240,240,250,.06)', color: '#d5d5df', borderLeft: '1px solid rgba(240,240,250,.35)', borderRadius: '0' },
  callout: { ...darkTheme.callout, background: 'rgba(240,240,250,.10)', color: '#f0f0fa', borderLeft: '1px solid rgba(240,240,250,.35)', borderRadius: '18px' },
  codeBlock: { ...darkTheme.codeBlock, background: '#09090b', color: '#f0f0fa', borderRadius: '0', extra: { border: '1px solid rgba(240,240,250,.22)' } },
  table: { ...darkTheme.table, borderColor: 'rgba(240,240,250,.25)', headBg: '#111115', headColor: '#f0f0fa', style: 'minimal' },
  hr: { color: 'rgba(240,240,250,.35)', margin: '38px 0', style: 'line', width: '28%' },
  img: { borderRadius: '0', margin: '28px auto', caption: true }, strongColor: '#ffffff', link: { color: '#f0f0fa', textDecoration: 'underline' },
};

export const businessWarmGrayTheme: Theme = {
  ...creamTheme,
  id: 'business-warm-gray', name: '商务暖灰', description: '暖灰年报纸张、墨黑正文与信号橙点睛，适合货代服务和企业观察',
  body: { ...creamTheme.body, color: '#262627', bg: '#F3F0EE', lineHeight: '1.9' },
  accent: '#CF4500', accentSoft: '#FCFBFA',
  heading: { ...creamTheme.heading, color: '#141413', letterSpacing: '-0.2px', decor: 'center-rule' },
  quote: { ...creamTheme.quote, background: '#FCFBFA', color: '#555555', borderLeft: '3px solid #CF4500', borderRadius: '18px', style: 'card' },
  callout: { ...creamTheme.callout, background: '#FCFBFA', color: '#262627', borderLeft: '4px solid #CF4500', borderRadius: '18px', badgeBg: '#141413', badgeColor: '#F3F0EE' },
  table: { ...creamTheme.table, borderColor: '#D1CDC7', headBg: '#141413', headColor: '#F3F0EE', style: 'striped', stripeBg: '#FCFBFA' },
  hr: { color: '#D1CDC7', margin: '36px 0', style: 'glyph', glyph: '●  ●' },
  mark: { background: '#F8D8C8', color: '#141413', borderRadius: '999px', padding: '1px 6px' }, strongColor: '#141413', link: { color: '#3860BE', textDecoration: 'underline' },
};

export const crossBorderPurpleTheme: Theme = {
  ...minimalTheme,
  id: 'cross-border-purple', name: '跨境紫', description: '深海军蓝配精致紫，技术与金融并重，适合跨境支付和供应链科技',
  body: { ...minimalTheme.body, color: '#64748d', bg: '#ffffff', lineHeight: '1.85' },
  accent: '#533afd', accentSoft: '#f1f0ff',
  heading: { ...minimalTheme.heading, color: '#061b31', fontWeight: '600', decor: 'left-bar' },
  quote: { ...minimalTheme.quote, background: '#f7f7ff', color: '#273951', borderLeft: '3px solid #533afd', borderRadius: '8px' },
  callout: { ...minimalTheme.callout, background: '#f1f0ff', color: '#273951', borderLeft: '3px solid #533afd', borderRadius: '8px' },
  code: { ...minimalTheme.code, background: '#f1f0ff', color: '#2e2b8c' },
  codeBlock: { ...minimalTheme.codeBlock, background: '#1c1e54', color: '#ffffff', borderRadius: '10px', chrome: 'dots' },
  table: { ...minimalTheme.table, borderColor: '#d6d9fc', headBg: '#061b31', headColor: '#ffffff', style: 'minimal' },
  mark: { background: '#ffd7ef', color: '#061b31', borderRadius: '4px', padding: '1px 4px' }, strongColor: '#061b31', link: { color: '#533afd', textDecoration: 'underline' },
};

export const industryNewspaperTheme: Theme = {
  ...typewriterTheme,
  id: 'industry-newspaper', name: '行业报刊', description: '暖色新闻纸、衬线标题与印刷红，适合行业新闻、政策和市场复盘',
  body: { ...typewriterTheme.body, font: SERIF, color: '#2d2a26', bg: '#f4f1ea', indent: true, align: 'justify', lineHeight: '1.95' },
  accent: '#8b1a1a', accentSoft: '#f0ebe0',
  heading: { ...typewriterTheme.heading, font: SERIF, color: '#1a1a1a', decor: 'rule', align: 'center' },
  quote: { ...typewriterTheme.quote, background: '#f0ebe0', color: '#2d2a26', borderLeft: '3px solid #8b1a1a', borderRadius: '0', style: 'pull', bigMark: true },
  callout: { ...typewriterTheme.callout, background: '#f5f0e5', color: '#2d2a26', borderLeft: '3px solid #8b1a1a', borderRadius: '0' },
  table: { ...typewriterTheme.table, borderColor: '#a09a8d', headBg: '#2d2a26', headColor: '#f4f1ea', style: 'minimal' },
  hr: { color: '#2d2a26', margin: '36px 0', style: 'double' },
  img: { borderRadius: '0', margin: '24px auto', caption: true, frame: '1px solid #c5c0b5' },
  mark: { background: '#e8e4d9', color: '#8b1a1a', borderRadius: '0', padding: '1px 3px' }, strongColor: '#1a1a1a', link: { color: '#1a2a4a', textDecoration: 'underline' },
};

export const productMinimalTheme: Theme = {
  ...minimalTheme,
  id: 'product-minimal', name: '产品极简', description: '黑白灰与单一蓝色强调，清晰克制，适合工具介绍和产品评测',
  body: { ...minimalTheme.body, color: '#1d1d1f', bg: '#ffffff', fontSize: '17px', lineHeight: '1.72' },
  accent: '#0071e3', accentSoft: '#f5f5f7',
  heading: { ...minimalTheme.heading, color: '#1d1d1f', letterSpacing: '-0.3px', decor: 'none' },
  quote: { ...minimalTheme.quote, background: '#f5f5f7', color: '#424245', borderLeft: '0', borderRadius: '14px', style: 'card' },
  callout: { ...minimalTheme.callout, background: '#f5f5f7', color: '#1d1d1f', borderLeft: '3px solid #0071e3', borderRadius: '14px' },
  codeBlock: { ...minimalTheme.codeBlock, background: '#1d1d1f', color: '#f5f5f7', borderRadius: '14px', chrome: 'dots' },
  table: { ...minimalTheme.table, borderColor: '#d2d2d7', headBg: '#f5f5f7', headColor: '#1d1d1f', style: 'minimal' },
  hr: { color: '#d2d2d7', margin: '42px 0', style: 'line', width: '16%' }, strongColor: '#000000', link: { color: '#0066cc', textDecoration: 'none' },
};

export const knowledgeCleanTheme: Theme = {
  ...minimalTheme,
  id: 'knowledge-clean', name: '知识清简', description: '温润白纸、暖黑文字与轻蓝提示，适合知识教程和操作指南',
  body: { ...minimalTheme.body, color: '#31302e', bg: '#ffffff', lineHeight: '1.85' },
  accent: '#0075de', accentSoft: '#f6f5f4',
  heading: { ...minimalTheme.heading, color: '#000000', decor: 'underline' },
  quote: { ...minimalTheme.quote, background: '#f6f5f4', color: '#615d59', borderLeft: '3px solid #31302e', borderRadius: '4px' },
  callout: { ...minimalTheme.callout, background: '#f2f9ff', color: '#31302e', borderLeft: '3px solid #0075de', borderRadius: '6px', badgeColor: '#097fe8' },
  code: { ...minimalTheme.code, background: '#f6f5f4', color: '#31302e' },
  codeBlock: { ...minimalTheme.codeBlock, background: '#f6f5f4', color: '#31302e', borderRadius: '6px', extra: { border: '1px solid rgba(0,0,0,.10)' } },
  table: { ...minimalTheme.table, borderColor: '#dedbd8', headBg: '#f6f5f4', headColor: '#31302e', style: 'minimal' },
  hr: { color: '#dedbd8', margin: '38px 0', style: 'line' }, strongColor: '#000000', link: { color: '#0075de', textDecoration: 'underline' },
};

export const businessReportTheme: Theme = {
  ...classicTheme,
  id: 'business-report', name: '商业研报', description: '绿金双主色、清晰信息层级和斑马表格，适合运价与市场分析',
  body: { ...classicTheme.body, color: '#333333', bg: '#ffffff', lineHeight: '1.75' },
  accent: '#05c15f', accentSoft: '#f0f8f4',
  heading: { ...classicTheme.heading, color: '#049a4d', decor: 'left-bar' },
  quote: { ...classicTheme.quote, background: '#fdfbf7', color: '#444444', borderLeft: '5px solid #fdbb2d', borderRadius: '4px' },
  callout: { ...classicTheme.callout, background: '#f0f4f8', color: '#444444', borderLeft: '5px solid #05c15f', borderRadius: '4px', badgeBg: '#05c15f', badgeColor: '#ffffff' },
  list: { bullet: '▸', bulletColor: '#05c15f', ordered: 'pill' },
  table: { ...classicTheme.table, borderColor: '#dfe8e3', headBg: '#049a4d', headColor: '#ffffff', style: 'striped', stripeBg: '#f6fbf8' },
  hr: { color: '#fdbb2d', margin: '34px 0', style: 'double' },
  mark: { background: '#fff1bd', color: '#333333', borderRadius: '999px', padding: '1px 6px' }, strongColor: '#049a4d', link: { color: '#05a653', textDecoration: 'underline' },
};

export const themes: Theme[] = [
  classicTheme,
  oliveJournalTheme,
  moyuGreenTheme,
  redWhiteTheme,
  graphiteMinimalTheme,
  zenWhitespaceTheme,
  moyuTicketTheme,
  graphiteDossierTheme,
  greenWhiteCleanTheme,
  inkBlueEditorialTheme,
  mistPurpleStoryTheme,
  sandGoldJournalTheme,
  orbitalBlackTheme,
  businessWarmGrayTheme,
  crossBorderPurpleTheme,
  industryNewspaperTheme,
  productMinimalTheme,
  knowledgeCleanTheme,
  businessReportTheme,
  minimalTheme,
  editorialTheme,
  inkTheme,
  creamTheme,
  sakuraTheme,
  typewriterTheme,
  indigoTheme,
  darkTheme,
  midnightTheme,
  graphiteTheme,
  nightSakuraTheme,
];

/** Look a theme up by id, falling back to classic */
/** Light / dark groups (shown as separate sections in the theme list) */
export const lightThemes: Theme[] = themes.filter((t) => t.appearance === 'light');
export const darkThemes: Theme[] = themes.filter((t) => t.appearance === 'dark');

export function getTheme(id?: string): Theme {
  return themes.find((t) => t.id === id) ?? classicTheme;
}

/* ---------------- Density scaling (size / leading / spacing) ---------------- */

export interface DensityScale {
  /** Font-size multiplier */
  font: number;
  /** Line-height multiplier (body and headings) */
  line: number;
  /** Vertical spacing multiplier (paragraph, heading and quote margins…) */
  margin: number;
}

/** Multiply every px value in a string by k (zeros are unaffected) */
const px = (v: string, k: number) =>
  v.replace(/-?\d+(\.\d+)?(?=px)/g, (m) => `${(parseFloat(m) * k).toFixed(2).replace(/\.?0+$/, '')}`);

/** Produce a scaled copy of a theme at the given density (the original is untouched) */
export function applyDensity(th: Theme, d: DensityScale): Theme {
  const f = d.font;
  const m = f * d.margin;
  return {
    ...th,
    body: {
      ...th.body,
      fontSize: px(th.body.fontSize, f),
      lineHeight: `${parseFloat(th.body.lineHeight) * d.line}`,
    },
    pMargin: px(th.pMargin, m),
    heading: {
      ...th.heading,
      lineHeight: `${parseFloat(th.heading.lineHeight) * d.line}`,
      marginTop: px(th.heading.marginTop, m),
      marginBottom: px(th.heading.marginBottom, m),
    },
    headingSizes: Object.fromEntries(
      Object.entries(th.headingSizes).map(([k, v]) => [k, px(v, f)]),
    ) as Theme['headingSizes'],
    quote: { ...th.quote, margin: px(th.quote.margin, m) },
    callout: { ...th.callout, margin: px(th.callout.margin, m) },
    hr: { ...th.hr, margin: px(th.hr.margin, m) },
    img: { ...th.img, margin: px(th.img.margin, m) },
    footnote: { ...th.footnote, textSize: px(th.footnote.textSize, f) },
    listItemMargin: px(th.listItemMargin, m),
    table: { ...th.table, fontSize: px(th.table.fontSize, f) },
  };
}

/**
 * Typographic density presets.
 * The middle one is the identity transform — the size, leading and spacing each
 * theme was tuned with *are* the design baseline, and compact and roomy only
 * offset either side of it. That way switching themes never distorts a theme
 * because of a density default.
 */
export const DENSITIES: { id: string; name: string; scale: DensityScale }[] = [
  { id: 'compact', name: '紧凑', scale: { font: 0.92, line: 0.94, margin: 0.78 } },
  { id: 'standard', name: '标准', scale: { font: 1, line: 1, margin: 1 } },
  { id: 'roomy', name: '宽松', scale: { font: 1.08, line: 1.06, margin: 1.22 } },
];

export function getDensity(id?: string): DensityScale {
  return (DENSITIES.find((d) => d.id === id) ?? DENSITIES[1]).scale;
}

/** Join a style object into a style string: { color:'red' } → 'color:red;' */
export function st(styles: Record<string, string | number>): string {
  // A render hot spot: called once per element for the whole article, so avoid
  // the intermediate arrays of Object.entries + map + join
  let out = '';
  for (const k in styles) {
    if (out) out += ';';
    out += k;
    out += ':';
    out += styles[k];
  }
  return out;
}
