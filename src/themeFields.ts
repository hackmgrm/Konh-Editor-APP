/**
 * Every part of a Theme a person can set by hand, described once for the
 * theme studio (see components/ThemeStudio.tsx).
 *
 * The Theme type says what a theme *holds*; this says how each field is
 * *edited* — which control, which range, what it is called in Chinese, and
 * when it does anything at all. Only fields the renderer actually reads are
 * listed: a control that moves nothing on the page is worse than no control.
 * (`callout.badgeBg` is in the type and read by no one, so it is not here.)
 *
 * Sections follow the elements of an article rather than the shape of the
 * type, because that is how a person looks for them: "the quote looks wrong",
 * not "quote.borderLeft".
 */

import { MONO, SANS, SERIF, type Theme } from './theme';

export type SectionId =
  | 'global'
  | 'body'
  | 'heading'
  | 'quote'
  | 'callout'
  | 'list'
  | 'link'
  | 'code'
  | 'codeBlock'
  | 'palette'
  | 'table'
  | 'hr'
  | 'img'
  | 'mark'
  | 'footnote';

export interface Option {
  value: string;
  label: string;
}

/** A length with a unit; `unit: ''` is a bare number (line-height) */
export interface SizeSpec {
  min: number;
  max: number;
  step: number;
  unit: string;
}

export type Control =
  | { kind: 'color' }
  | ({ kind: 'size' } & SizeSpec)
  /** A shorthand of one to four lengths: padding, margin, radius */
  | { kind: 'box' }
  /** `4px solid #d97757` */
  | { kind: 'border' }
  | { kind: 'font' }
  | { kind: 'glyph'; presets: string[] }
  | { kind: 'choice'; options: Option[] }
  | { kind: 'bool' };

export interface Field {
  path: readonly string[];
  label: string;
  hint?: string;
  control: Control;
  /** May be left empty: the renderer has a default for it */
  optional?: boolean;
  /** What the renderer does when an optional field is empty — shown as the
   *  placeholder, and as the chosen chip of an unset choice */
  fallback?: string;
  /** Shown only when it does something. A glyph for a heading decor that
   *  draws none is a control that moves nothing */
  when?: (th: Theme) => boolean;
}

export interface Section {
  id: SectionId;
  title: string;
  hint: string;
  fields: Field[];
  /** Takes a free map of extra CSS declarations (see Theme['quote']['extra']) */
  extra?: boolean;
}

/* ---------------- Controls used more than once ---------------- */

const color: Control = { kind: 'color' };
const box: Control = { kind: 'box' };
const border: Control = { kind: 'border' };
const font: Control = { kind: 'font' };
const bool: Control = { kind: 'bool' };
const px = (min: number, max: number, step = 1): Control => ({ kind: 'size', min, max, step, unit: 'px' });
const lineHeight: Control = { kind: 'size', min: 1, max: 2.6, step: 0.05, unit: '' };
const choice = (...pairs: [string, string][]): Control => ({
  kind: 'choice',
  options: pairs.map(([value, label]) => ({ value, label })),
});

/** Font stacks offered by name. Anything else is kept as typed */
export const FONTS: Option[] = [
  { label: '系统黑体', value: SANS },
  { label: '宋体衬线', value: SERIF },
  { label: 'Georgia + 宋体', value: "Georgia, 'Songti SC', 'STSong', serif" },
  { label: '楷体', value: "'Kaiti SC', 'STKaiti', 'KaiTi', 'BiauKai', serif" },
  { label: '仿宋', value: "'STFangsong', 'FangSong', 'FangSong_GB2312', serif" },
  { label: '圆体', value: "'Yuanti SC', 'YouYuan', 'PingFang SC', sans-serif" },
  { label: '等宽', value: MONO },
];

/* ---------------- The sections ---------------- */

export const SECTIONS: Section[] = [
  {
    id: 'global',
    title: '全局',
    hint: '强调色贯穿全篇：标题装饰、引用线、链接、列表符号、脚注号都吃它',
    fields: [
      { path: ['accent'], label: '强调色', control: color },
      {
        path: ['accentSoft'],
        label: '强调淡色',
        hint: '大面积铺底用：色带标题',
        control: color,
        optional: true,
        fallback: 'rgba(217,119,87,.12)',
      },
      {
        path: ['accentBright'],
        label: '强调亮色',
        hint: '第二强调色，铺形状用：高亮压线、列表符号、分隔线',
        control: color,
        optional: true,
        fallback: '#ffd400',
      },
      { path: ['strongColor'], label: '加粗', hint: 'inherit 表示跟正文同色', control: color },
      {
        path: ['strongWeight'],
        label: '加粗字重',
        control: choice(['700', '粗'], ['800', '特粗'], ['900', '黑']),
        optional: true,
        fallback: '700',
      },
      { path: ['delColor'], label: '删除线', control: color },
      { path: ['mono'], label: '等宽字体', hint: '代码用', control: font },
    ],
  },
  {
    id: 'body',
    title: '正文',
    hint: '段落、纸色、字号行距',
    fields: [
      { path: ['body', 'bg'], label: '纸色', hint: '深色主题必须设', control: color, optional: true, fallback: '#ffffff' },
      { path: ['body', 'color'], label: '文字', control: color },
      { path: ['body', 'font'], label: '字体', control: font },
      { path: ['body', 'fontSize'], label: '字号', control: px(12, 22, 0.5) },
      { path: ['body', 'lineHeight'], label: '行高', control: lineHeight },
      { path: ['pMargin'], label: '段间距', control: px(0, 48) },
      { path: ['body', 'indent'], label: '首行缩进', hint: '每段空两个字，中文书的排法', control: bool, optional: true },
      {
        path: ['body', 'letterSpacing'],
        label: '字距',
        hint: '中文比西文更吃得下一点余量',
        control: px(0, 3, 0.5),
        optional: true,
        fallback: '0px',
      },
      {
        path: ['body', 'align'],
        label: '对齐',
        control: choice(['left', '左对齐'], ['justify', '两端对齐']),
        optional: true,
        fallback: 'left',
      },
    ],
  },
  {
    id: 'heading',
    title: '标题',
    hint: '读者最先看见的就是它的样子',
    fields: [
      {
        path: ['heading', 'decor'],
        label: '装饰',
        control: choice(
          ['none', '无'],
          ['left-bar', '左竖条'],
          ['underline', '通栏下划线'],
          ['rule', '杂志粗线'],
          ['center-rule', '居中短线'],
          ['accent-bar', '顶部粗线'],
          ['band', '色带'],
          ['boxed', '描边框'],
          ['marker', '前置符号'],
          ['numbered', '01 编号'],
          ['highlight', '高亮压线'],
        ),
        optional: true,
        fallback: 'none',
      },
      {
        path: ['heading', 'markerGlyph'],
        label: '符号',
        control: { kind: 'glyph', presets: ['▍', '#', '$', '§', '❁', '◆', '●', '▶', '✦', '»'] },
        optional: true,
        fallback: '▍',
        when: (th) => th.heading.decor === 'marker',
      },
      {
        path: ['heading', 'align'],
        label: '对齐',
        control: choice(['left', '左对齐'], ['center', '居中']),
        optional: true,
        fallback: 'left',
        when: (th) => th.heading.decor !== 'center-rule',
      },
      { path: ['heading', 'color'], label: '颜色', control: color },
      { path: ['heading', 'font'], label: '字体', control: font },
      {
        path: ['heading', 'fontWeight'],
        label: '字重',
        control: choice(['400', '常规'], ['500', '中等'], ['600', '半粗'], ['700', '粗'], ['800', '特粗'], ['900', '黑']),
      },
      { path: ['headingSizes', 'h1'], label: 'H1 字号', control: px(14, 44, 0.5) },
      { path: ['headingSizes', 'h2'], label: 'H2 字号', control: px(14, 40, 0.5) },
      { path: ['headingSizes', 'h3'], label: 'H3 字号', control: px(13, 34, 0.5) },
      { path: ['headingSizes', 'h4'], label: 'H4 字号', control: px(12, 30, 0.5) },
      { path: ['headingSizes', 'h5'], label: 'H5 字号', control: px(12, 26, 0.5) },
      { path: ['headingSizes', 'h6'], label: 'H6 字号', control: px(12, 24, 0.5) },
      { path: ['heading', 'lineHeight'], label: '行高', control: lineHeight },
      {
        path: ['heading', 'letterSpacing'],
        label: '字距',
        control: { kind: 'size', min: -2, max: 6, step: 0.1, unit: 'px' },
        optional: true,
        fallback: '0px',
      },
      { path: ['heading', 'marginTop'], label: '上间距', control: px(0, 80) },
      { path: ['heading', 'marginBottom'], label: '下间距', control: px(0, 48) },
    ],
  },
  {
    id: 'quote',
    title: '引用',
    hint: '> 开头的段落',
    extra: true,
    fields: [
      {
        path: ['quote', 'style'],
        label: '形状',
        control: choice(['bar', '竖线'], ['card', '卡片'], ['bracket', '括号引'], ['pull', '杂志引言']),
        optional: true,
        fallback: 'bar',
      },
      {
        path: ['quote', 'markGlyph'],
        label: '引号',
        hint: '括号引要给一对，如「」',
        control: { kind: 'glyph', presets: ['「」', '『』', '“”', '《》', '❝❞'] },
        optional: true,
        fallback: '「」',
        when: (th) => th.quote.style === 'bracket' || !!th.quote.bigMark,
      },
      {
        path: ['quote', 'bigMark'],
        label: '大引号',
        hint: '开头画一个放大的引号',
        control: bool,
        optional: true,
        when: (th) => th.quote.style !== 'bracket',
      },
      { path: ['quote', 'color'], label: '文字', control: color },
      {
        path: ['quote', 'background'],
        label: '底色',
        control: color,
        when: (th) => !th.quote.style || th.quote.style === 'bar' || th.quote.style === 'card',
      },
      {
        path: ['quote', 'borderLeft'],
        label: '左竖线',
        control: border,
        when: (th) => !th.quote.style || th.quote.style === 'bar',
      },
      {
        path: ['quote', 'borderRadius'],
        label: '圆角',
        control: box,
        when: (th) => !th.quote.style || th.quote.style === 'bar' || th.quote.style === 'card',
      },
      {
        path: ['quote', 'padding'],
        label: '内边距',
        control: box,
        when: (th) => !th.quote.style || th.quote.style === 'bar' || th.quote.style === 'card',
      },
      { path: ['quote', 'margin'], label: '外边距', control: box },
      {
        path: ['quote', 'fontStyle'],
        label: '字形',
        control: choice(['normal', '正常'], ['italic', '斜体']),
        optional: true,
        fallback: 'normal',
      },
    ],
  },
  {
    id: 'callout',
    title: '提示块',
    hint: '> [!tip] 标题',
    extra: true,
    fields: [
      { path: ['callout', 'background'], label: '底色', control: color },
      { path: ['callout', 'color'], label: '文字', control: color },
      { path: ['callout', 'badgeColor'], label: '标题色', control: color, optional: true, fallback: '跟强调色' },
      { path: ['callout', 'borderLeft'], label: '左竖线', control: border },
      { path: ['callout', 'borderRadius'], label: '圆角', control: box },
      { path: ['callout', 'padding'], label: '内边距', control: box },
      { path: ['callout', 'margin'], label: '外边距', control: box },
    ],
  },
  {
    id: 'list',
    title: '列表',
    hint: '无序、有序，以及 - [ ] 待办清单',
    fields: [
      {
        path: ['list', 'bullet'],
        label: '无序符号',
        control: { kind: 'glyph', presets: ['•', '▸', '—', '◇', '○', '◆', '▪', '❀', '›', '*', '✓'] },
        optional: true,
        fallback: '浏览器默认',
      },
      {
        path: ['list', 'bulletColor'],
        label: '符号颜色',
        control: color,
        optional: true,
        fallback: '跟强调色',
        when: (th) => !!th.list?.bullet || (th.list?.ordered ?? 'plain') !== 'plain',
      },
      {
        path: ['list', 'ordered'],
        label: '有序数字',
        control: choice(['plain', '原样'], ['accent', '强调色'], ['pill', '圆牌']),
        optional: true,
        fallback: 'plain',
      },
      {
        path: ['list', 'taskGlyphs'],
        label: '待办符号',
        hint: '前一个是勾上的，后一个是没勾的（- [x] / - [ ]）',
        control: { kind: 'glyph', presets: ['☑☐', '✅⬜', '✔✗', '●○', '▣□', '◉○'] },
        optional: true,
        fallback: '☑☐',
      },
      {
        path: ['list', 'taskChecked'],
        label: '勾上颜色',
        control: color,
        optional: true,
        fallback: '跟强调色',
      },
      {
        path: ['list', 'taskUnchecked'],
        label: '未勾颜色',
        control: color,
        optional: true,
        fallback: '跟删除线色',
      },
      { path: ['listPaddingLeft'], label: '缩进', control: px(0, 60) },
      { path: ['listItemMargin'], label: '条目间距', control: box },
    ],
  },
  {
    id: 'link',
    title: '链接',
    hint: '外链转脚注开着时，正文里的是上标编号',
    fields: [
      { path: ['link', 'color'], label: '颜色', control: color },
      {
        path: ['link', 'textDecoration'],
        label: '下划线',
        control: choice(['underline', '实线'], ['underline dashed', '虚线'], ['underline dotted', '点线'], ['none', '无']),
        when: (th) => !th.link.underline,
      },
      {
        path: ['link', 'underline'],
        label: '下划线色',
        hint: '设了就画成 2px 色线，可以跟文字不同色',
        control: color,
        optional: true,
        fallback: '跟文字同色',
      },
    ],
  },
  {
    id: 'code',
    title: '行内代码',
    hint: '`反引号` 包住的字',
    extra: true,
    fields: [
      { path: ['code', 'color'], label: '文字', control: color },
      { path: ['code', 'background'], label: '底色', control: color },
      { path: ['code', 'fontSize'], label: '字号', control: { kind: 'size', min: 0.6, max: 1.2, step: 0.01, unit: 'em' } },
      { path: ['code', 'borderRadius'], label: '圆角', control: box },
      { path: ['code', 'padding'], label: '内边距', control: box },
    ],
  },
  {
    id: 'codeBlock',
    title: '代码块',
    hint: '``` 围起来的代码',
    extra: true,
    fields: [
      {
        path: ['codeBlock', 'chrome'],
        label: '顶栏',
        control: choice(['none', '无'], ['dots', '红黄绿灯'], ['lang', '语言角标']),
        optional: true,
        fallback: 'none',
      },
      { path: ['codeBlock', 'background'], label: '底色', control: color },
      { path: ['codeBlock', 'color'], label: '文字', control: color },
      { path: ['codeBlock', 'fontSize'], label: '字号', control: px(10, 18, 0.5) },
      { path: ['codeBlock', 'lineHeight'], label: '行高', control: lineHeight },
      { path: ['codeBlock', 'borderRadius'], label: '圆角', control: box },
      { path: ['codeBlock', 'padding'], label: '内边距', control: box },
    ],
  },
  {
    id: 'palette',
    title: '代码配色',
    hint: '代码高亮里每一类记号的颜色',
    fields: [
      {
        path: ['codePaletteMode'],
        label: '配色底',
        hint: '跟代码块底色的明暗一致',
        control: choice(['light', '浅色'], ['dark', '深色']),
      },
    ],
  },
  {
    id: 'table',
    title: '表格',
    hint: '',
    fields: [
      {
        path: ['table', 'style'],
        label: '样式',
        control: choice(['grid', '全框线'], ['minimal', '只留横线'], ['striped', '斑马纹'], ['rails', '上下包线']),
        optional: true,
        fallback: 'grid',
      },
      { path: ['table', 'borderColor'], label: '线色', control: color },
      {
        path: ['table', 'headBg'],
        label: '表头底色',
        control: color,
        when: (th) => th.table.style !== 'minimal' && th.table.style !== 'rails',
      },
      {
        path: ['table', 'headColor'],
        label: '表头文字',
        hint: '只留横线时表头跟标题同色',
        control: color,
        when: (th) => th.table.style !== 'minimal',
      },
      {
        path: ['table', 'stripeBg'],
        label: '斑马底色',
        control: color,
        optional: true,
        fallback: '跟表头底色',
        when: (th) => th.table.style === 'striped',
      },
      { path: ['table', 'fontSize'], label: '字号', control: px(11, 18, 0.5) },
      { path: ['table', 'cellPadding'], label: '单元格边距', control: box },
    ],
  },
  {
    id: 'hr',
    title: '分隔线',
    hint: '--- 三个减号',
    fields: [
      {
        path: ['hr', 'style'],
        label: '样式',
        control: choice(['line', '实线'], ['dashed', '虚线'], ['dotted', '点线'], ['double', '双线'], ['fade', '两端渐隐'], ['glyph', '花饰']),
        optional: true,
        fallback: 'line',
      },
      {
        path: ['hr', 'glyph'],
        label: '花饰',
        hint: '颜色跟强调色',
        control: { kind: 'glyph', presets: ['❋', '✦', '◈', '✿', '※', '· · ·', '◇ ◇ ◇', '———'] },
        optional: true,
        fallback: '❋',
        when: (th) => th.hr.style === 'glyph',
      },
      { path: ['hr', 'color'], label: '颜色', control: color, when: (th) => th.hr.style !== 'glyph' },
      {
        path: ['hr', 'width'],
        label: '宽度',
        hint: '短于 100% 自动居中',
        control: { kind: 'size', min: 5, max: 100, step: 1, unit: '%' },
        optional: true,
        fallback: '100%',
        when: (th) => th.hr.style !== 'glyph',
      },
      { path: ['hr', 'margin'], label: '上下间距', control: box },
    ],
  },
  {
    id: 'img',
    title: '图片',
    hint: '',
    fields: [
      { path: ['img', 'borderRadius'], label: '圆角', control: box },
      { path: ['img', 'frame'], label: '边框', control: border, optional: true, fallback: '无' },
      { path: ['img', 'margin'], label: '外边距', hint: 'auto 让图片居中', control: box },
      { path: ['img', 'caption'], label: '图注', hint: '把 alt 文字排在图下面', control: bool, optional: true },
    ],
  },
  {
    id: 'mark',
    title: '高亮',
    hint: '==两个等号== 包住的字',
    fields: [
      { path: ['mark', 'background'], label: '底色', control: color },
      { path: ['mark', 'color'], label: '文字', control: color },
      { path: ['mark', 'borderRadius'], label: '圆角', control: box },
      { path: ['mark', 'padding'], label: '内边距', control: box },
    ],
  },
  {
    id: 'footnote',
    title: '脚注',
    hint: '正文里的 [1] 和文末的引用列表；图注也用这里的字号和颜色',
    fields: [
      { path: ['footnote', 'refColor'], label: '上标', control: color },
      { path: ['footnote', 'numColor'], label: '编号', control: color },
      { path: ['footnote', 'textColor'], label: '文字', control: color },
      { path: ['footnote', 'textSize'], label: '字号', control: px(10, 16, 0.5) },
      { path: ['footnote', 'blockBorder'], label: '分隔线', control: color },
    ],
  },
];

export const SECTION_TITLE: Record<SectionId, string> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.title]),
) as Record<SectionId, string>;

/** highlight.js classes, in words. Keys a theme adds beyond these show raw */
export const PALETTE_LABELS: Record<string, string> = {
  'hljs-keyword': '关键字',
  'hljs-string': '字符串',
  'hljs-title': '名称',
  'hljs-title.function_': '函数名',
  'hljs-title.class_': '类名',
  'hljs-number': '数字',
  'hljs-literal': 'true / null',
  'hljs-built_in': '内置',
  'hljs-type': '类型',
  'hljs-attr': '属性名',
  'hljs-attribute': 'CSS 属性',
  'hljs-comment': '注释',
  'hljs-meta': '元信息',
  'hljs-variable': '变量',
  'hljs-params': '参数',
  'hljs-symbol': '符号',
  'hljs-regexp': '正则',
  'hljs-addition': '新增行',
  'hljs-deletion': '删除行',
  'hljs-selector-tag': '选择器·标签',
  'hljs-selector-class': '选择器·类',
  'hljs-selector-id': '选择器·ID',
  'hljs-selector-attr': '选择器·属性',
  'hljs-selector-pseudo': '伪类',
  'hljs-tag': '标签',
  'hljs-name': '标签名',
  'hljs-operator': '运算符',
  'hljs-bullet': '列表符',
  'hljs-quote': '引用',
  'hljs-emphasis': '强调',
  'hljs-strong': '加粗',
};

/* ---------------- Reading and writing by path ---------------- */

type Dict = Record<string, unknown>;

export function getAt(th: Theme, path: readonly string[]): unknown {
  let cur: unknown = th;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Dict)[k];
  }
  return cur;
}

/** A copy of the theme with one value replaced; `undefined` removes the key.
 *  Paths are arrays because hljs class names carry dots of their own */
export function setAt(th: Theme, path: readonly string[], value: unknown): Theme {
  const write = (obj: Dict | undefined, i: number): Dict => {
    const next: Dict = { ...(obj ?? {}) };
    const k = path[i];
    if (i === path.length - 1) {
      if (value === undefined) delete next[k];
      else next[k] = value;
    } else {
      next[k] = write(next[k] as Dict | undefined, i + 1);
    }
    return next;
  };
  return write(th as unknown as Dict, 0) as unknown as Theme;
}

/** A key that ignores property order, for "has anything changed" */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  const obj = v as Dict;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`)
    .join(',')}}`;
}

/* ---------------- From the preview back to a section ---------------- */

/**
 * Which section styles the element under the pointer, and which element to
 * outline for it.
 *
 * This reads the renderer's output (markdown.ts), so it has to agree with it:
 * the preview body carries no outer `<section>`, which makes any `<section>`
 * in it the footnote block; a `<p>` at the top level with no `data-line` is a
 * glyph divider, since every real paragraph carries its source line. The walk
 * goes from the innermost element out, so a link inside a quote is the link.
 */
export function sectionAt(target: Element, root: Element): { section: SectionId; el: Element } {
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    switch (el.tagName.toLowerCase()) {
      case 'pre':
        return { section: 'codeBlock', el };
      case 'code': {
        const pre = el.closest('pre');
        return pre ? { section: 'codeBlock', el: pre } : { section: 'code', el };
      }
      case 'mark':
        return { section: 'mark', el };
      case 'a':
        return { section: 'link', el };
      case 'sup':
      case 'section':
        return { section: 'footnote', el };
      case 'img':
        return { section: 'img', el };
      case 'strong':
      case 'del':
        return { section: 'global', el };
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return { section: 'heading', el };
      case 'table':
      case 'thead':
      case 'tbody':
      case 'tr':
      case 'th':
      case 'td':
        return { section: 'table', el: el.closest('table') ?? el };
      case 'hr':
        return { section: 'hr', el };
      case 'blockquote':
        return { section: el.hasAttribute('data-tip') ? 'callout' : 'quote', el };
      case 'li':
      case 'ul':
      case 'ol':
        return { section: 'list', el: el.closest('ul, ol') ?? el };
      case 'p':
        // Only a top-level paragraph is prose. One nested in a quote, a
        // callout, a loose list item, a table cell or a footnote belongs to
        // that container — deciding "body" here sent every click on a quote's
        // text to the body section
        if (el.parentElement === root) {
          return { section: el.hasAttribute('data-line') ? 'body' : 'hr', el };
        }
        break;
    }
  }
  return { section: 'body', el: target };
}
