import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type Renderer from 'markdown-it/lib/renderer.mjs';
import { gzhTemplates, type GzhTemplate } from './gzhTemplates';
import type { FrontMatter } from './frontMatter';
import type { Theme } from './theme';

const libraries: Record<string, string> = {
  'moyu-green': 'moyu-green', 'red-white': 'red-white', 'graphite-minimal': 'graphite-minimal',
  'zen-whitespace': 'zen-whitespace', 'moyu-ticket': 'moyu-ticket', 'olive-journal-original': 'olive-journal',
};
export const isGzhTheme = (id: string): boolean => id in libraries;
function commonColors(html: string, key: string): string {
  if (['graphite-minimal', 'zen-whitespace'].includes(key)) html = html.replace(/background:#FEF2F2;/g, 'background:transparent;');
  const colors: Record<string, string[]> = {
    'moyu-green': ['#059669', '#F0FDF4', '#ECFDF5', '#065F46'],
    'red-white': ['#DC2626', '#FEF2F2', '#FEE2E2', '#991B1B'],
    'graphite-minimal': ['#52525B', '#FAFAFA', '#F4F4F5', '#27272A'],
    'zen-whitespace': ['#4A5D52', '#FFFFFF', '#EEF3F0', '#3D5046'],
    'moyu-ticket': ['#059669', '#F0FDF4', '#A7F3D0', '#1a1a1a'],
    'olive-journal': ['#ed7b2f', '#eeefe9', '#e5e7e0', '#23251d'],
  };
  const source = ['#DC2626', '#FEF2F2', '#FEE2E2', '#991B1B'];
  return html.replace(/#DC2626|#FEF2F2|#FEE2E2|#991B1B/g, color => colors[key][source.indexOf(color)]);
}
export function themeComponents(id: string): GzhTemplate[] {
  const key = libraries[id];
  return key ? gzhTemplates[key].slice(1).concat(gzhTemplates['common-components'].map(item => ({ ...item, html: commonColors(item.html, key) }))) : [];
}
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const leaf = (value: string): string => `<span leaf="">${escape(value)}</span>`;
const clean = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim();

function equalizeTocCards(html: string): string {
  if (!html.includes('overflow-x:scroll;') || !html.includes('PART 01')) return html;
  return html.replace('overflow-x:scroll;', 'display:flex;align-items:stretch;overflow-x:scroll;')
    .replace(/display:inline-block;white-space:normal;vertical-align:top;width:110px;/g,
      'display:block;box-sizing:border-box;flex:0 0 136px;white-space:normal;width:136px;')
    .replace('background:linear-gradient(135deg,#059669,#10B981);border-radius:12px;',
      'background:linear-gradient(135deg,#059669,#10B981);border:1px solid transparent;border-radius:12px;');
}

/** Values are already escaped text or rendered inline HTML, never raw user HTML. */
function fill(html: string, values: Record<string, string>): string {
  return html.replace(/<span leaf="">{{(.*?)}}<\/span>/g, (_all, key: string) => values[key] ?? '')
    .replace(/{{(.*?)}}/g, (_all, key: string) => values[key] ?? '');
}
function replaceText(html: string, value: string, pattern?: RegExp): string {
  let done = false;
  return html.replace(/<span leaf="">([^<]+)<\/span>/g, (all, text: string) => {
    if (done || (pattern && !pattern.test(text))) return all;
    done = true;
    return value;
  });
}
function contentTemplate(html: string, value: string): string {
  const slot = html.match(/{{(.*?)}}/)?.[1];
  return slot ? fill(html, { [slot]: value }) : replaceText(html, value);
}
function pairEnd(tokens: Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    depth += tokens[i].nesting;
    if (!depth) return i;
  }
  return start;
}
function anchor(html: string, token: Token): string {
  return token.map ? html.replace(/^<(section|p|h[1-6])\b/, `<$1 data-line="${token.map[0]}"`) : html;
}
function englishTag(title: string, end: boolean): string {
  if (end) return 'THE END';
  for (const [pattern, tag] of [[/实测|测评|测试/, 'TEST'], [/教程|步骤|操作/, 'TUTORIAL'], [/思考|观点/, 'THOUGHTS'], [/案例|实践/, 'CASE'], [/对比|比较/, 'COMPARE'], [/方法|原理/, 'METHOD'], [/工具|清单/, 'TOOLS']] as const) {
    if (pattern.test(title)) return tag;
  }
  return 'CHAPTER';
}

/** Insert the actual upstream markup; text slots remain editable in the source pane. */
export function componentMarkup(component: GzhTemplate): string {
  const html = clean(equalizeTocCards(component.html).replace(/{{([^}]+)}}/g, (_all, name: string) => escape(`填写${name}`))
    .replace(/<img\b[^>]*src="(?:图片URL|动图URL\.gif|填写[^\"]*|\.\.\.)"[^>]*>/g, leaf('请插入图片')));
  return /^<(section|p|ul|ol|table|figure)\b/.test(html) ? html : `<section>${html}</section>`;
}

interface GzhEnv { theme: Theme; images?: Record<string, string>; flow?: unknown }
export function renderGzh(
  parser: MarkdownIt, tokens: Token[], env: GzhEnv, fm: FrontMatter | null,
): { body: string; html: string; title: string; hasHero: boolean } {
  const key = libraries[env.theme.id];
  const library = gzhTemplates[key];
  const template = (index: number) => library[index].html;
  const common = (index: number) => commonColors(gzhTemplates['common-components'][index].html, key);
  // Reuse local images, Obsidian embeds, links and footnote rules from the app.
  const renderer: Renderer = new (parser.renderer.constructor as new () => Renderer)();
  renderer.rules = { ...parser.renderer.rules };
  const inline = (token: Token) => renderer.renderInline(token.children ?? [], parser.options, env);
  const inlineText = (text: string) => renderer.renderInline(parser.parseInline(text, env)[0]?.children ?? [], parser.options, env);
  const indices: Record<string, { paragraph: number; strong: number; mark: number; underline: number; code: number; quote: number; tip: number; image: number; caption?: number; end?: number; signature?: number }> = {
    'moyu-green': { paragraph: 5, strong: 6, mark: 8, underline: 10, code: 12, quote: 20, tip: 27, image: 39, signature: 41 },
    'red-white': { paragraph: 6, strong: 9, mark: 12, underline: 13, code: 15, quote: 17, tip: 20, image: 32, caption: 33, end: 34, signature: 35 },
    'graphite-minimal': { paragraph: 6, strong: 9, mark: 12, underline: 13, code: 16, quote: 18, tip: 21, image: 36, caption: 37, end: 38, signature: 39 },
    'zen-whitespace': { paragraph: 6, strong: 8, mark: 13, underline: 11, code: -1, quote: 15, tip: 17, image: 18, end: 26, signature: 27 },
    'moyu-ticket': { paragraph: 4, strong: 5, mark: 6, underline: 7, code: 8, quote: 12, tip: 12, image: 11, end: 17, signature: 16 },
    'olive-journal': { paragraph: 9, strong: 10, mark: 11, underline: -1, code: 13, quote: 19, tip: 18, image: 23, signature: 37 },
  };
  const ix = indices[key];
  const underline = key === 'olive-journal'
    ? '<span style="border-bottom:2px solid #ed7b2f;font-weight:600;color:#23251d;"><span leaf="">{{文字}}</span></span>' : template(ix.underline);
  const wrap = (html: string) => {
    const match = html.match(/^(.*?)<span leaf="">[\s\S]*?<\/span>(.*?)$/);
    return match ? [match[1], match[2]] : ['<span>', '</span>'];
  };
  for (const [kind, html] of [['strong', template(ix.strong)], ['mark', template(ix.mark)]] as const) {
    const [open, close] = wrap(html);
    renderer.rules[`${kind}_open`] = () => open;
    renderer.rules[`${kind}_close`] = () => close;
  }
  const strike = { 'moyu-green': 14, 'red-white': 14, 'graphite-minimal': 14, 'zen-whitespace': 13, 'olive-journal': 14 }[key];
  if (strike !== undefined) {
    const [open, close] = wrap(template(strike));
    renderer.rules.s_open = () => open;
    renderer.rules.s_close = () => close;
  }
  renderer.rules.text = (items, i) => items[i].content.split(/(\+\+[^+\n]+\+\+)/g).map(part =>
    part.startsWith('++') && part.endsWith('++') ? contentTemplate(underline, leaf(part.slice(2, -2))) : leaf(part)).join('');
  renderer.rules.html_inline = (items, i) => {
    const html = items[i].content;
    if (/^<u>$/i.test(html)) return wrap(underline)[0];
    if (/^<\/u>$/i.test(html)) return wrap(underline)[1];
    return parser.renderer.rules.html_inline!(items, i, parser.options, env, renderer);
  };
  renderer.rules.code_inline = (items, i) => contentTemplate(ix.code < 0 ? common(2).replace(/#DC2626/g, env.theme.accent) : template(ix.code), leaf(items[i].content));
  renderer.rules.softbreak = (items, i) => {
    const before = items[i - 1]?.content ?? '';
    const after = items[i + 1]?.content ?? '';
    return /[\u3400-\u9fff]$/.test(before) && /^[\u3400-\u9fff]/.test(after) ? '' : ' ';
  };

  const imageRule = (type: string): NonNullable<Renderer['rules'][string]> => (items, i, opts, e, r) => {
    const original = parser.renderer.rules[type]!(items, i, opts, e, r);
    const img = original.match(/<img\b[^>]*>/)?.[0];
    if (!img) return original;
    const image = img.replace(/\sstyle="[^"]*"/, ' style="max-width:100%;height:auto;display:block;margin:0 auto;"');
    if (items.some(t => !['image', 'obsidian_embed', 'softbreak'].includes(t.type))) return `<span leaf="">${image}</span>`;
    let html = template(key === 'zen-whitespace' && items[i].content ? 19 : ix.image);
    if (key === 'moyu-green') html = html.replace(/<!--[\s\S]*?-->/, `<span leaf="">${image}</span>`);
    else html = html.replace(/<img\b[^>]*>/, image);
    html = fill(html, { 图片说明: leaf(items[i].content) });
    const caption = items[i].content;
    if (key === 'zen-whitespace' && caption) html = replaceText(html, leaf(`— ${caption}`), /图片说明文字/);
    if (ix.caption !== undefined && caption) html += contentTemplate(template(ix.caption), leaf(caption));
    if (/\.gif(?:[?#]|$)/i.test(items[i].attrGet('src') ?? '')) html += `<p style="text-align:center;margin:0 0 24px;font-size:11px;color:${env.theme.accent};">${leaf('GIF 动图')}</p>`;
    return clean(html);
  };
  renderer.rules.image = imageRule('image');
  renderer.rules.obsidian_embed = imageRule('obsidian_embed');

  const tableIndex = { 'moyu-green': 37, 'red-white': 29, 'graphite-minimal': 32 }[key];
  if (tableIndex !== undefined) {
    const source = clean(template(tableIndex));
    const styles = (tag: string) => [...source.matchAll(new RegExp(`<${tag}\\b[^>]*style="([^"]*)"`, 'g'))].map(m => m[1]);
    const headStyle = styles('th')[0] ?? '';
    const cells = styles('td');
    const cellStyle = cells[0] ?? '';
    const alternate = cells.find(style => /background:/.test(style)) ?? cellStyle;
    let row = 0;
    renderer.rules.table_open = () => source.slice(0, source.indexOf('<thead'));
    renderer.rules.table_close = () => source.slice(source.indexOf('</table>'));
    renderer.rules.tbody_open = () => { row = 0; return '<tbody>'; };
    renderer.rules.tr_open = () => { row++; return '<tr>'; };
    renderer.rules.th_open = (items, i) => `<th style="${headStyle}${items[i].attrGet('style') ?? ''}">`;
    renderer.rules.td_open = (items, i) => `<td style="${row % 2 === 0 ? alternate : cellStyle}${items[i].attrGet('style') ?? ''}">`;
  }
  if (key === 'olive-journal') {
    const source = clean(template(26));
    const sections = [...source.matchAll(/<section style="([^"]*)">/g)].map(match => match[1]);
    let head = false;
    let columns = 0;
    let column = 0;
    renderer.rules.table_open = items => {
      columns = items.filter(t => t.type === 'th_open').length;
      return `<section style="${sections[0]}"><section style="${sections[1]}">`;
    };
    renderer.rules.table_close = () => '</section></section>';
    renderer.rules.thead_open = () => { head = true; return ''; };
    renderer.rules.thead_close = () => '';
    renderer.rules.tbody_open = () => { head = false; return ''; };
    renderer.rules.tbody_close = () => '';
    renderer.rules.tr_open = () => { column = 0; return `<section style="${head ? sections[2] : sections[6]}">`; };
    renderer.rules.tr_close = () => '</section>';
    const cell = (items: Token[], i: number) => {
      const style = sections[(head ? 3 : 7) + Math.min(column++, 2)];
      const width = columns === 3 ? style : style.replace(/width:[^;]+;/, `width:${100 / columns}%;`);
      return `<section style="${width}${items[i].attrGet('style') ?? ''}">`;
    };
    renderer.rules.th_open = cell;
    renderer.rules.td_open = cell;
    renderer.rules.th_close = () => '</section>';
    renderer.rules.td_close = () => '</section>';
  }

  const chapters = tokens.filter(t => t.type === 'heading_open' && t.tag === 'h2' && t.level === 0);
  const chapterNames = chapters.map(t => tokens[tokens.indexOf(t) + 1].content);
  let title = fm?.title ?? '';
  let hasHero = false;
  let introUsed = false;
  let section = 0;
  let chapterOpen = false;
  let existingSignature = '';

  function paragraph(value: string, insideChapter: boolean): string {
    let html = contentTemplate(template(ix.paragraph), value);
    if (key === 'zen-whitespace') html = replaceText(template(ix.paragraph), value);
    // Ticket paragraphs in a chapter share its 20px gutter instead of doubling it.
    if (key === 'moyu-ticket' && insideChapter) html = html.replace('padding:0 20px;', '');
    if (!insideChapter && ['moyu-green', 'red-white', 'graphite-minimal'].includes(key)) {
      html = `<section style="padding:0 ${key === 'moyu-green' ? '20' : '10'}px;">${html}</section>`;
    }
    return clean(html);
  }
  function intro(value: string): string {
    introUsed = true;
    if (['red-white', 'graphite-minimal'].includes(key)) {
      let html = template(1);
      html = html.replace(/<p\b[^>]*>\s*<span leaf="">—— {{[\s\S]*?<\/p>/, fm?.author ? `<p style="text-align:right;font-size:12px;color:#9CA3AF;margin:16px 0 0;">${leaf(`—— ${fm.author}`)}</p>` : '');
      const content = key === 'red-white' ? value.replace(/<span style="background:#FEE2E2;[^"]*">/g, '<span style="background:#DC2626;color:#FFFFFF;padding:2px 8px;border-radius:4px;">') : value;
      html = html.replace(/(<p\b[^>]*>)([\s\S]*?)(<\/p>)/g, (all, open: string, text: string, close: string) => text.includes('{{') ? open + content + close : all);
      // The original uses a straight quote as decoration; keep it typographic.
      html = html.replace('<span leaf="">"</span>', '<span leaf="">“</span>');
      return clean(fill(html, {}));
    }
    if (key === 'zen-whitespace') {
      let html = template(1).replace(/<p\b[^>]*>\s*<span leaf="">——[\s\S]*?<\/p>/, fm?.author ? `<p style="font-size:12px;color:#A3A3A3;margin:0;">${leaf(`—— ${fm.author}`)}</p>` : '');
      html = html.replace(/(<p\b[^>]*>)[\s\S]*?(<\/p>)/, `$1${value}$2`);
      return clean(html);
    }
    return quote(value, false);
  }
  function quote(value: string, tip: boolean, label = ''): string {
    const html = template(tip ? ix.tip : ix.quote);
    if (key === 'moyu-ticket') return clean(fill(html, { 前缀: leaf(label || '观点'), 结论内容: value }));
    if (key === 'olive-journal') return clean(fill(html, tip ? { 批注标签: leaf(label || '编者按'), 编者按正文: value } : { 重点观点: value }));
    if (key === 'zen-whitespace') {
      let result = html.replace(/(<p\b[^>]*>)[\s\S]*?(<\/p>)/, `$1${tip ? leaf(label || '提示') : value}$2`);
      if (tip) result = result.replace(/(<p\b[^>]*>)[\s\S]*?(<\/p>)(\s*<\/section>\s*)$/, `$1${value}$2$3`);
      return clean(result);
    }
    if (key === 'moyu-green' && tip) return clean(fill(html, { 提示标题: leaf(label || '提示'), 提示内容: value }));
    return clean(contentTemplate(html, value));
  }
  function cover(value: string): string {
    const tags = (fm?.tags ?? '').split(/[·,，、]/).filter(Boolean);
    if (key === 'moyu-green') return clean(fill(template(2), {
      顶部标签: leaf(fm?.kicker ?? ''), 日期: leaf(fm?.date ?? ''), 主标题行1: value,
      主标题行2: leaf(fm?.coverTitle2 ?? ''), 绿色高亮词: leaf(fm?.highlight ?? ''),
      划线旧认知: leaf(fm?.oldTitle ?? ''), 副标题关键词: inlineText(fm?.subtitle ?? ''),
      底部左侧文字: leaf(fm?.summary ?? fm?.author ?? ''), 标签1: leaf(tags[0] ?? ''), 标签2: leaf(tags[1] ?? ''),
    }));
    if (key === 'moyu-ticket') {
      let html = fill(template(1), { 头部标签: leaf(fm?.kicker ?? ''), 大标题: value, 副标题: inlineText(fm?.subtitle ?? ''),
        作者名: leaf(fm?.author ?? ''), 作者身份: leaf(fm?.bio ?? ''), 简介段落: inlineText(fm?.summary ?? ''),
        '#标签1': leaf(tags[0] ?? ''), '#标签2': leaf(tags[1] ?? ''), '#标签3': leaf(tags[2] ?? ''),
        编号: leaf(fm?.issue ?? '001'), 竖排文字: leaf(fm?.kicker ?? ''), 等级: leaf(fm?.grade ?? ''),
      });
      html = html.replace(/<section style="width:48px;height:48px;[\s\S]*?<\/section>/, '');
      return clean(html);
    }
    return clean(fill(template(1), { 内刊标签: leaf(fm?.kicker ?? ''), 日期: leaf(fm?.date ?? ''),
      主标题: value, 强调词: leaf(fm?.highlight ?? ''), 旧标题占位: leaf(fm?.oldTitle ?? ''),
      副标题说明: inlineText(fm?.subtitle ?? ''), 底部摘要: inlineText(fm?.summary ?? ''), 标签1: leaf(tags[0] ?? ''), 标签2: leaf(tags[1] ?? ''),
    }));
  }
  function toc(): string {
    if (chapterNames.length < (key === 'moyu-green' ? 2 : 3) || ['moyu-ticket', 'olive-journal'].includes(key)) return '';
    if (key === 'moyu-green') {
      let html = template(3).replace(/{{N}}/g, String(chapterNames.length - 1));
      const cards = html.match(/<section style="display:inline-block;[\s\S]*?<\/section>/g) ?? [];
      if (cards.length !== 3) return '';
      const content = chapterNames.map((name, index) => {
        let card = cards[index === 0 ? 0 : index === chapterNames.length - 1 ? 2 : 1]!;
        card = card.replace(/PART (?:01|02|\/\/\/)/g, `PART ${index === chapterNames.length - 1 ? '///' : String(index + 1).padStart(2, '0')}`);
        card = card.replace('写在最后', '{{章节名}}');
        return fill(card, { 章节名: leaf(name), 副标题: '' });
      }).join('');
      const start = html.indexOf(cards[0]!);
      const stop = html.lastIndexOf(cards[2]!) + cards[2]!.length;
      html = html.slice(0, start) + content + html.slice(stop);
      return clean(equalizeTocCards(fill(html, {})));
    }
    let html = template(2);
    if (key === 'zen-whitespace') {
      for (const [index, text] of ['第一个要点', '第二个要点', '第三个要点'].entries()) html = html.replace(text, escape(chapterNames[index]));
    } else html = fill(html, { 看点一: leaf(chapterNames[0]), 看点二: leaf(chapterNames[1]), 看点三: leaf(chapterNames[2]) });
    return clean(html);
  }

  function renderRange(items: Token[], insideChapter = false): string {
    let out = '';
    for (let i = 0; i < items.length; i++) {
      const token = items[i];
      const end = token.nesting === 1 ? pairEnd(items, i) : i;
      const child = items.slice(i + 1, end);
      let html = '';
      if (token.type === 'heading_open') {
        const value = inline(items[i + 1]);
        if (token.tag === 'h1' && !title) title = items[i + 1].content;
        if (token.tag === 'h1' && ['moyu-green', 'moyu-ticket', 'olive-journal'].includes(key)) {
          if (!hasHero) { html = cover(value); hasHero = true; if (key === 'moyu-green') html += toc(); }
        } else if (token.tag === 'h1') {
          // These themes start with a quote; the WeChat title is separate.
          html = '';
        } else if (token.tag === 'h2' && token.level === 0) {
          if (chapterOpen) out += '</section>';
          if (section === 0 && key !== 'moyu-green') out += toc();
          const n = ++section;
          const last = n === chapters.length && (key === 'moyu-green' || /总结|结语|写在最后|最后|结尾|后记|收尾/.test(items[i + 1].content)) && !['moyu-ticket', 'olive-journal'].includes(key);
          const num = last ? (key === 'moyu-green' ? '///' : '∞') : String(n).padStart(2, '0');
          const tag = englishTag(items[i + 1].content, last);
          const index = key === 'moyu-green' ? 4 : ['moyu-ticket', 'olive-journal'].includes(key) ? 2 : 4;
          const source = template(index);
          html = key === 'olive-journal' ? source : source.split('<!-- 本章节正文内容放在这里 -->')[0];
          if (key === 'zen-whitespace') {
            html = html.replace('01 · CHAPTER ONE', `${num} · ${last ? 'POSTSCRIPT' : tag}`).replace('中文章节大标题', value);
          } else html = fill(html, { '01': leaf(num), 编号: leaf(num), 中文标题: value, 中文章节标题: value, 标题: value, 副标题: leaf(tag), 'ENGLISH TAG': leaf(tag), 'ENGLISH · 英文副标题': leaf(tag) });
          if (key === 'moyu-green') html = html.replace('>PART<', last ? '>LAST<' : '>PART<');
          else if (key !== 'moyu-ticket' && key !== 'olive-journal') html = replaceText(html, leaf(num), /^01$/);
          if (n === 1 && ['moyu-green', 'red-white', 'graphite-minimal'].includes(key)) html = html.replace(/margin-top:\s*(?:48|56)px/, 'margin-top:16px');
          chapterOpen = key !== 'olive-journal';
        } else {
          const sub = key === 'moyu-green' ? 24 : key === 'moyu-ticket' ? 3 : key === 'olive-journal' ? 7 : ['red-white', 'graphite-minimal'].includes(key) ? 8 : -1;
          html = sub < 0 ? `<h3 style="font-family:'Noto Serif SC',Georgia,serif;font-size:18px;color:#2B2B2B;margin:28px 0 14px;">${value}</h3>` : contentTemplate(template(sub), value);
        }
      } else if (token.type === 'paragraph_open') {
        const value = child.map(t => t.type === 'inline' ? inline(t) : renderer.render([t], parser.options, env)).join('');
        const onlyImage = child.length === 1 && child[0].children?.every(t => ['image', 'obsidian_embed', 'softbreak'].includes(t.type));
        const signature = token.level === 0 && end === items.length - 1 && /^(?:我是[^，。\n]{1,24}，|作者[：:])/.test(child[0]?.content ?? '');
        if (signature) existingSignature = value;
        else if (onlyImage) html = value;
        else if (!introUsed && !section && ['red-white', 'graphite-minimal', 'zen-whitespace'].includes(key)) html = intro(value);
        else html = paragraph(value, insideChapter || chapterOpen);
      } else if (token.type === 'blockquote_open') {
        let pending: string[] = [];
        const flush = () => {
          if (!pending.length) return;
          const value = pending.join('<br>');
          html += !introUsed && !section && !token.meta?.tip && ['red-white', 'graphite-minimal', 'zen-whitespace'].includes(key) ? intro(value) : quote(value, !!token.meta?.tip, token.meta?.title);
          pending = [];
        };
        for (let j = 0; j < child.length; j++) {
          const stop = child[j].nesting === 1 ? pairEnd(child, j) : j;
          if (child[j].type === 'paragraph_open' && !child[j + 1].children?.every(t => ['image', 'obsidian_embed'].includes(t.type))) pending.push(inline(child[j + 1]));
          else if (child[j].type !== 'html_block' || child[j].content) {
            flush();
            html += renderRange(child.slice(j, stop + 1), insideChapter);
          }
          j = stop;
        }
        flush();
      } else if (token.type === 'fence' || token.type === 'code_block') {
        const language = token.info.trim().split(/\s/)[0];
        let htmlCode = common(0);
        htmlCode = htmlCode.replace('>python<', `>${escape(language)}<`);
        const lines = token.content.replace(/\n$/, '').split('\n').map(line => {
          const text = line.replace(/\t/g, '    ').replace(/ /g, '\u00a0');
          return `<p style="margin:0;font-family:'SF Mono',Consolas,Monaco,monospace;font-size:13px;line-height:1.6;color:#E2E8F0;white-space:nowrap;">${leaf(text || '\u00a0')}</p>`;
        }).join('');
        htmlCode = htmlCode.replace(/<p\b[\s\S]*<\/p>/, lines).replace('<section style="padding:11px 14px;">', '<section style="padding:11px 14px;overflow-x:auto;">');
        html = clean(htmlCode.replace(/(<span\b[^>]*>)\.(<\/span>)/g, '$1<span leaf="">.</span>$2'));
      } else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
        const ordered = token.type === 'ordered_list_open';
        let count = Number(token.attrGet('start') ?? 1);
        const listParts: string[] = [];
        for (let j = 0; j < child.length; j++) {
          if (child[j].type !== 'list_item_open') continue;
          const stop = pairEnd(child, j);
          const parts = child.slice(j + 1, stop);
          const first = parts.find(t => t.type === 'inline');
          const value = first ? inline(first) : '';
          const listIndex = key === 'moyu-green' ? (ordered ? 38 : 30) : key === 'red-white' ? (ordered ? 24 : 25) : key === 'graphite-minimal' ? (ordered ? 27 : 28) : key === 'moyu-ticket' ? 13 : key === 'olive-journal' ? 17 : -1;
          let item = '';
          if (listIndex >= 0) {
            const source = template(listIndex);
            // Repeating source templates include several sample rows; retain one row per item.
            const marker = key === 'olive-journal' ? source.match(/<li\b[\s\S]*?<\/li>/)?.[0] : source.match(/<section style="display:flex;align-items:flex-start;[\s\S]*?<\/section>/)?.[0];
            item = marker ?? source;
            if (key === 'moyu-ticket') item = item.replace('<span leaf="">：{{描述}}</span>', '');
            item = fill(item, { 列表项内容: value, 列表项文字: value, 要点标题: value, 要点说明: '', 列表项: value, 序号: leaf(String(count)), 小标题: value, 描述: '' });
            if (ordered) item = replaceText(item, leaf(String(count)), /^1$|^01$/);
          } else item = paragraph(`${leaf(ordered ? `${count}. ` : '• ')}${value}`, true);
          const firstParagraph = parts.findIndex(t => t.type === 'paragraph_open');
          const rest = firstParagraph >= 0 ? parts.slice(pairEnd(parts, firstParagraph) + 1) : parts;
          const extra = renderRange(rest, true);
          listParts.push(anchor(clean(key === 'olive-journal' ? item.replace('</li>', `${extra}</li>`) : item + extra), child[j]));
          count++; j = stop;
        }
        if (key === 'olive-journal') {
          html = template(17).replace(/<li\b[\s\S]*?<\/li>/, listParts.join(''));
          if (ordered) {
            const lastClose = html.lastIndexOf('</ul>');
            html = html.slice(0, lastClose) + '</ol>' + html.slice(lastClose + 5);
            html = html.replace('<ul ', `<ol start="${token.attrGet('start') ?? 1}" `);
          }
        } else html = `<section style="margin-bottom:24px;">${listParts.join('')}</section>`;
      } else if (token.type === 'hr') {
        html = ['red-white', 'graphite-minimal', 'zen-whitespace'].includes(key) ? template(3) : key === 'olive-journal' ? template(20) : `<section style="border-top:2px dashed #A7F3D0;margin:32px 0;"><span leaf=""><br></span></section>`;
      } else html = renderer.render(items.slice(i, end + 1), parser.options, env);
      out += anchor(clean(html), token);
      i = end;
    }
    return out;
  }
  let prefix = '';
  if (fm?.title && ['moyu-green', 'moyu-ticket', 'olive-journal'].includes(key)) { prefix = cover(inlineText(fm.title)); hasHero = true; }
  if (hasHero && key === 'moyu-green') prefix += toc();
  if (fm?.intro) prefix += intro(inlineText(fm.intro));
  let body = renderRange(tokens);
  if (chapterOpen) body += '</section>';
  const bio = fm?.author ? inlineText(`我是 ${fm.author}${fm.bio ? `，${fm.bio}` : ''}。`) : '';
  if (['moyu-green', 'moyu-ticket', 'olive-journal'].includes(key)) {
    if (existingSignature || bio) body += paragraph(existingSignature || bio, false);
    if (key === 'moyu-green') {
      let footer = template(41);
      if (/点赞|在看|转发/.test(existingSignature)) footer = footer.replace(/<p\b[\s\S]*?<\/p>/, '');
      body += clean(footer);
    } else {
      const footer = template(key === 'moyu-ticket' ? 16 : 32);
      body += clean(fill(footer, { 互动文案: leaf('如果你觉得今天这篇有收获，欢迎点赞、在看、转发三连，我们下篇见。'), 文末互动引导: leaf('如果你觉得今天这篇有收获，欢迎点赞、在看、转发三连，我们下篇见。') }));
    }
  }
  if (ix.end !== undefined) body += clean(template(ix.end));
  if ((fm?.author || existingSignature) && ix.signature !== undefined && !['moyu-green', 'moyu-ticket'].includes(key)) {
    let signature = template(ix.signature);
    // Optional original business-card image is absent unless the article supplied it.
    signature = signature.replace(/<section[^>]*>\s*<span leaf=""><img[\s\S]*?<\/section>/g, '');
    if (key === 'olive-journal') signature = fm?.author ? fill(signature, { 头像字: leaf(fm.author.slice(0, 1)), 签名文字: leaf(fm.author) }) : '';
    else {
      const text = existingSignature || bio;
      let replaced = false;
      signature = signature.replace(/(<p\b[^>]*>)([\s\S]*?)(<\/p>)/g, (all, open: string, content: string, close: string) => {
        if (!replaced && content.includes('{{作者名}}')) { replaced = true; return open + text + close; }
        if (existingSignature && /点赞|在看|转发/.test(content)) return '';
        return all;
      });
      signature = fill(signature, {});
    }
    body += clean(signature);
  }
  body = prefix + body;
  const wrapper = template(0).replace(/<!--[\s\S]*?-->/, body);
  return { body, html: clean(wrapper), title, hasHero };
}
