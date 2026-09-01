import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArticle, checkPublishFields, hasBlockingIssues } from './preflight.ts';

const article = (markdown: string, overrides: Partial<Parameters<typeof checkArticle>[0]> = {}) =>
  checkArticle({
    markdown,
    availableImages: new Set<string>(),
    referencedImages: new Set<string>(),
    frontMatterEnabled: false,
    linkFootnotes: false,
    ...overrides,
  });

const ids = (issues: ReturnType<typeof checkArticle>) => issues.map((item) => item.id);

test('clean article passes', () => {
  assert.deepEqual(article('# 标题\n\n正文'), []);
});

test('empty article is blocking', () => {
  const issues = article(' \n\t');
  assert.deepEqual(ids(issues), ['empty']);
  assert.equal(hasBlockingIssues(issues), true);
});

test('missing local image blocks, available image passes', () => {
  const markdown = '# 标题\n\n![[cover.png]]';
  assert.ok(ids(article(markdown, { referencedImages: new Set(['cover.png']) })).includes('missing-images'));
  assert.ok(!ids(article(markdown, {
    referencedImages: new Set(['cover.png']),
    availableImages: new Set(['images/cover.png', 'cover.png']),
  })).includes('missing-images'));
});

test('front matter only warns when theme cannot render it', () => {
  const markdown = '---\ntitle: 测试\n---\n\n正文';
  assert.ok(ids(article(markdown)).includes('frontmatter-theme'));
  assert.ok(!ids(article(markdown, { frontMatterEnabled: true })).includes('frontmatter-theme'));
});

test('external links warn unless converted to footnotes', () => {
  const markdown = '# 标题\n\n[官网](https://example.com)';
  assert.ok(ids(article(markdown)).includes('external-links'));
  assert.ok(!ids(article(markdown, { linkFootnotes: true })).includes('external-links'));
});

test('heading jumps and placeholders are detected but code fences are ignored', () => {
  const markdown = '# 标题\n### 跳级\nTODO：待补充\n```md\n# 代码\n#### 不检查\n```';
  const found = ids(article(markdown));
  assert.ok(found.includes('heading-jumps'));
  assert.ok(found.includes('placeholders'));
  assert.equal(article(markdown).find((item) => item.id === 'heading-jumps')?.detail.includes('不检查'), false);
});

test('wechat length thresholds warn and then block', () => {
  assert.equal(article('字'.repeat(18_000))[0]?.id, 'length-near');
  const over = article('字'.repeat(20_001));
  assert.equal(over[0]?.id, 'length-over');
  assert.equal(hasBlockingIssues(over), true);
});

test('publish fields distinguish required fields from recommendations', () => {
  const issues = checkPublishFields({
    title: '', digest: '', author: '', hasCover: false, keepsExistingCover: false, articleHasImage: false,
  });
  assert.deepEqual(issues.map((item) => item.id), [
    'publish-title-empty', 'publish-digest-empty', 'publish-author-empty', 'publish-cover-empty',
  ]);
  assert.equal(hasBlockingIssues(issues), true);
});

test('existing draft cover and valid fields pass', () => {
  assert.deepEqual(checkPublishFields({
    title: '标题', digest: '摘要', author: '空核域界', hasCover: false, keepsExistingCover: true, articleHasImage: false,
  }), []);
});
