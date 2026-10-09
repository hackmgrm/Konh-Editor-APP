import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL) {
    const path = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(path)) return next(path.href, context);
  }
  return next(specifier, context);
} });
const { renderArticle } = await import('./markdown.ts');
const { gzhThemes, getTheme, getDensity } = await import('./theme.ts');
const { gzhTemplates } = await import('./gzhTemplates.ts');
const { componentMarkup, themeComponents } = await import('./gzhTheme.ts');
const plain = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
const count = (text: string, word: string) => text.split(word).length - 1;
const sample = '# 本文标题\n\n> 开篇引言\n\n前言正文。\n\n## 第一章\n\n第一段**重点**、==高亮==、++下划线++与`code`。\n\n## 第二章\n\n第二段。\n\n## 写在最后\n\n结语正文。';

function balanced(html: string) {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*>/gi)) {
    const tag = match[2].toLowerCase();
    if (['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tag) || match[0].endsWith('/>')) continue;
    if (!match[1]) stack.push(tag);
    else assert.equal(stack.pop(), tag, `mismatched ${match[0]}`);
  }
  assert.deepEqual(stack, []);
}

test('ships all six original presets and retains the branded olive preset', () => {
  assert.equal(gzhThemes.length, 6);
  assert.equal(getTheme('olive-journal').name, '空核域界');
  assert.equal(getTheme('olive-journal-original').name, '橄榄手记');
  for (const [id, size, lineHeight] of [['moyu-green', '14px', '1.9'], ['red-white', '15px', '1.8'], ['graphite-minimal', '15px', '1.8'], ['zen-whitespace', '15px', '1.9'], ['moyu-ticket', '14px', '1.9'], ['olive-journal-original', '14px', '1.9']]) {
    const th = getTheme(id);
    assert.equal(th.body.fontSize, size);
    assert.equal(th.body.lineHeight, lineHeight);
    assert.equal(renderArticle(sample, th, {}, getDensity('compact')).html, renderArticle(sample, th).html);
  }
});

test('compiled catalog preserves every original component HTML verbatim', () => {
  for (const [key, blocks] of Object.entries(gzhTemplates)) {
    const file = key === 'common-components' ? `${key}.md` : `theme-${key}.md`;
    const source = readFileSync(new URL(`../vendor/gzh-design/references/${file}`, import.meta.url), 'utf8');
    const expected = [...source.matchAll(/```html\n([\s\S]*?)```/g)].map(m => m[1].trim());
    for (const block of blocks) assert.ok(expected.includes(block.html), `${key}: ${block.name}`);
    assert.equal(blocks.length, expected.length - (key === 'common-components' ? 0 : 1));
  }
});

test('renders original chapter structures, underline and background emphasis separately', () => {
  const green = renderArticle(sample, getTheme('moyu-green'));
  assert.match(green.html, /font-size:28px;font-weight:900;color:#059669/);
  assert.match(green.html, /font-size:17px;font-weight:900;color:#111827/);
  assert.match(green.html, /border-bottom:2px solid #A7F3D0/);
  assert.match(green.html, /background:linear-gradient\(120deg,#FDE68A/);
  assert.match(green.html, />LAST</);
  assert.match(renderArticle(sample, getTheme('red-white')).html, /<p style="font-size:16px;[^"]*"><span leaf="">开篇引言<\/span><\/p>/);
  assert.match(renderArticle(sample, getTheme('graphite-minimal')).html, /<p style="font-size:18px;[^"]*"><span leaf="">开篇引言<\/span><\/p>/);
  assert.equal(count(plain(green.html), '开篇引言'), 1);
  assert.match(renderArticle(sample, getTheme('graphite-minimal')).html, /font-size:48px;font-weight:900;color:#E4E4E7/);
  const zen = renderArticle(sample, getTheme('zen-whitespace')).html;
  assert.match(zen, /font-size:\s*22px/);
  assert.match(zen, /border-bottom:\s*1.5px solid #B5C8BC/);
  assert.match(zen, /margin-top: 64px/);
  for (const th of gzhThemes) {
    const result = renderArticle(sample, th);
    balanced(result.html);
    assert.equal(result.previewBody, result.html);
    assert.equal(result.title, '本文标题');
    assert.equal(count(plain(result.html), '本文标题'), result.hasHero ? 1 : 0);
    assert.doesNotMatch(result.html, /{{|填写|甲木|空核域界/);
  }
});

test('preserves nested block order, list starting numbers and arbitrary table columns', () => {
  const source = '## 正文\n\n> 引用前\n>\n> - 嵌套甲\n> - 嵌套乙\n>\n> 引用后\n\n5. 列表甲\n   - 子项甲\n6. 列表乙\n\n| 列甲 | 列乙 | 列丙 | 列丁 |\n| --- | --- | --- | --- |\n| 数据甲 | 数据乙 | 数据丙 | 数据丁 |';
  for (const th of gzhThemes) {
    const html = renderArticle(source, th).html;
    const text = plain(html);
    for (const word of ['引用前', '嵌套甲', '嵌套乙', '引用后', '列表甲', '子项甲', '列表乙', '数据甲', '数据乙', '数据丙', '数据丁']) assert.equal(count(text, word), 1, `${th.id}: ${word}`);
    assert.ok(text.indexOf('引用前') < text.indexOf('嵌套甲') && text.indexOf('嵌套乙') < text.indexOf('引用后'));
    if (th.id === 'olive-journal-original') assert.match(html, /width:25%;/);
    else {
      assert.equal((html.match(/<th\b/g) ?? []).length, 4);
      assert.equal((html.match(/<td\b/g) ?? []).length, 4);
    }
    balanced(html);
    if (th.id === 'olive-journal-original') assert.match(html, /<ol start="5"/);
    else assert.match(text, /5.*列表甲.*6.*列表乙/);
  }
});

test('front matter creates one cover and preserves metadata without branded signatures', () => {
  for (const th of gzhThemes) {
    const result = renderArticle('---\ntitle: 元数据标题\nintro: 独立引言\nauthor: 小王\nbio: 写作人\n---\n\n## 正文\n\n测试正文。', th);
    assert.equal(result.title, '元数据标题');
    assert.equal(count(plain(result.html), '独立引言'), 1);
    assert.doesNotMatch(result.html, /甲木|空核域界|{{/);
    balanced(result.html);
  }
});

test('preserves small images, GIFs, local embeds and inline images', () => {
  for (const th of gzhThemes) {
    const result = renderArticle('## 图像\n\n![小图](https://example.com/small.png)\n\n![动图](https://example.com/a.gif)\n\n![[local.png]]\n\n文字![内联](https://example.com/inline.png)继续。', th, { 'local.png': 'data:image/png;base64,AA==' });
    assert.equal((result.html.match(/<img\b/g) ?? []).length, 4);
    assert.match(result.html, /GIF 动图/);
    assert.match(result.html, /data:image\/png;base64,AA==/);
    assert.doesNotMatch(result.html, /<img[^>]*style="[^\"]*(?<!-)width:100%/);
    balanced(result.html);
  }
});

test('every library component can be inserted without being rewritten by the renderer', () => {
  for (const th of gzhThemes) for (const component of themeComponents(th.id)) {
    const html = componentMarkup(component);
    const result = renderArticle(html, th);
    assert.ok(result.body.replace(/ data-line="\d+"/g, '').includes(html), `${th.id}: ${component.name}`);
  }
});

test('six exported articles pass the original WeChat validator', () => {
  for (const th of gzhThemes) {
    const result = renderArticle(sample + '\n\n```js\n  const x = "保留半角";\n```', th);
    const check = spawnSync('python3', ['vendor/gzh-design/scripts/validate_gzh_html.py', '--stdin'], { input: result.html, encoding: 'utf8' });
    assert.equal(check.status, 0, `${th.id}: ${check.stdout}${check.stderr}`);
    assert.doesNotMatch(check.stdout, /WARNING|⚠️/);
  }
});


test('merges existing author signatures into a single ending', () => {
  for (const th of gzhThemes) {
    const html = renderArticle('---\nauthor: 小王\n---\n\n## 正文\n\n文章正文。\n\n我是小王，分享写作。如果有收获，欢迎点赞、在看、转发。', th).html;
    assert.equal(count(plain(html), '我是小王'), 1, th.id);
    balanced(html);
  }
});
