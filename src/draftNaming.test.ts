import assert from 'node:assert/strict';
import test from 'node:test';
import { draftTitle, syncedDraftFileName } from './draftNaming.ts';

test('空核域界使用 Front Matter title，其他主题使用首个 H1', () => {
  const source = '---\ntitle: 品牌标题\n---\n\n# 普通标题\n';
  assert.equal(draftTitle(source, true), '品牌标题');
  assert.equal(draftTitle(source, false), '普通标题');
});

test('代码块里的 H1 不是文章标题', () => {
  assert.equal(draftTitle('```md\n# 示例\n```\n\n# 真标题', false), '真标题');
});

test('同步文件名保留扩展名、过滤非法字符并避开同名文件', () => {
  assert.equal(
    syncedDraftFileName('货代/服务?', '专题/旧名.md', ['专题/旧名.md', '专题/货代-服务-.md']),
    '货代-服务- 2.md',
  );
  assert.equal(syncedDraftFileName('新标题', '旧名.markdown', ['旧名.markdown']), '新标题.markdown');
});
