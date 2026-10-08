import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The app uses bundler resolution; let Node's stripped-TypeScript tests resolve
// the same extensionless source imports without changing production imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { renderArticle } = await import('./markdown.ts');
const { getTheme, themes } = await import('./theme.ts');
const { parseTheme, themeFile } = await import('./store/customThemes.ts');
const { diagnose, exitEvidence } = await import('./store/agent.ts');

test('tight drawn lists keep their marker and inline paragraph for WeChat paste', () => {
  const html = renderArticle('- **标签**：正文\n- 第二项').html;
  assert.match(html, /<li[^>]*><span[^>]*>•<\/span><p[^>]*display:inline/);
  assert.match(html, /<strong[^>]*>标签<\/strong>：正文<\/p>/);
  assert.equal((html.match(/<p\b/g) ?? []).length, 2);
  assert.equal((html.match(/<\/p>/g) ?? []).length, 2);
});

test('native ordered lists preserve the source starting number', () => {
  const theme = { ...getTheme('classic'), list: { ordered: 'plain' as const } };
  assert.match(renderArticle('5. 第五项\n6. 第六项', theme).html, /<ol start="5"/);
  assert.doesNotMatch(renderArticle('1. 第一项', theme).html, /start=/);
});

test('soft breaks fold by language while explicit hard breaks stay explicit', () => {
  assert.match(renderArticle('第一行\n第二行').html, /第一行第二行/);
  assert.match(renderArticle('hello\nworld').html, /hello world/);
  assert.match(renderArticle('第一行  \n第二行').html, /第一行<br>第二行/);
});

test('coloured paper exports retain padding and branded Front Matter components', () => {
  assert.match(renderArticle('正文', getTheme('cream')).html, /padding:24px 16px/);
  const article = renderArticle('---\ntitle: 我的标题\nintro: 导语\nauthor: 测试\n---\n\n正文', getTheme('olive-journal'));
  assert.equal(article.title, '我的标题');
  assert.equal(article.hasHero, true);
  assert.match(article.html, /导语/);
  assert.match(article.html, /关注并星标空核域界/);
});

test('studio serialization retains every local and upstream preset base', () => {
  for (const theme of themes) {
    const round = parseTheme(themeFile({ ...theme, id: `qa-${theme.id}`, name: '测试主题', base: theme.id }));
    assert.ok(round, theme.id);
    assert.equal(round.body.bg, theme.body.bg, theme.id);
    assert.equal(round.components?.frontMatter, theme.components?.frontMatter, theme.id);
  }
});

test('API diagnoses give API remedies for auth, quota, network and model failures', () => {
  for (const [text, code] of [['HTTP 401 invalid API key', 'auth'], ['HTTP 429 quota exceeded', 'rate'], ['fetch failed', 'network'], ['model not found', 'model']]) {
    const diagnosis = diagnose('api', [text, exitEvidence('start')]);
    assert.equal(diagnosis?.code, code);
    assert.equal(diagnosis?.command, undefined);
    assert.doesNotMatch(diagnosis!.hint, /CLI|终端/);
  }
});
