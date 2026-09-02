import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFrontMatter, setFrontMatterField } from './frontMatter.ts';
import { BRAND_LOGO_DATA_URL } from './brandLogo.ts';

test('解析标准 Front Matter 并从正文移除', () => {
  const parsed = parseFrontMatter('---\ntitle: 标题\nauthor: 作者\n---\n\n正文');
  assert.deepEqual(parsed?.data, { title: '标题', author: '作者' });
  assert.equal(parsed?.content, '\n正文');
});

test('兼容长度不固定的 Front Matter 分隔线', () => {
  const source = '---\ntitle: 标题\n-------------\n正文';
  const parsed = parseFrontMatter(source);
  assert.equal(parsed?.data.title, '标题');
  assert.equal(parsed?.content, '正文');
  assert.equal(setFrontMatterField(source, 'author', '空运新视角'), '---\ntitle: 标题\nauthor: 空运新视角\n---\n正文');
});

test('空核域界固定 Logo 是可发布的内嵌 PNG', () => {
  assert.match(BRAND_LOGO_DATA_URL, /^data:image\/png;base64,/);
  assert.ok(BRAND_LOGO_DATA_URL.length > 1000);
});
