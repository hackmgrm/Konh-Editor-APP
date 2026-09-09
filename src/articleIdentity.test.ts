import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CONTENT_STATE, addPublishRecord } from './store/contentState.ts';
import { registerArticles, relocateArticles, forgetArticles, recoverArticleMove } from './articleIdentity.ts';

test('首次迁移保留历史键，改名和移动目录不改变身份', () => {
  let state = registerArticles({}, '/work', ['系列/a.md', '系列/b.md', '系列二/c.md']);
  const original = state['/work']['系列/a.md'];
  assert.equal(original, '/work::系列/a.md');
  state = relocateArticles(state, '/work', '系列/a.md', '系列/新标题.md');
  state = relocateArticles(state, '/work', '系列', '归档/合集');
  assert.equal(state['/work']['归档/合集/新标题.md'], original);
  assert.equal(state['/work']['系列二/c.md'], '/work::系列二/c.md');
  assert.equal(state['/work']['系列/a.md'], undefined);
  assert.equal(registerArticles(state, '/work', ['归档/合集/新标题.md'])['/work']['归档/合集/新标题.md'], original);
});

test('同名新文章不继承已删除文章的草稿，跨工作区隔离', () => {
  let state = registerArticles({}, '/work', ['a.md']);
  const old = state['/work']['a.md'];
  state = forgetArticles(state, '/work', 'a.md');
  state = registerArticles(state, '/work', ['a.md'], true);
  assert.notEqual(state['/work']['a.md'], old);
  state = registerArticles(state, '/other', ['a.md']);
  assert.notEqual(state['/work']['a.md'], state['/other']['a.md']);
});

test('路径变更中断后按磁盘位置恢复，同名双份时不猜测', () => {
  const state = registerArticles({}, '/work', ['old/a.md']);
  const move = { from: 'old', to: 'new' };
  assert.equal(recoverArticleMove(state, '/work', move, ['old/a.md']), state);
  assert.equal(recoverArticleMove(state, '/work', move, ['new/a.md'])['/work']['new/a.md'], '/work::old/a.md');
  assert.throws(() => recoverArticleMove(state, '/work', move, ['old/a.md', 'new/a.md']), /不明确/);
});

test('稳定标识继续命中多账户草稿与历史，无需改写发布记录', () => {
  let identities = registerArticles({}, '/work', ['a.md']);
  const key = identities['/work']['a.md'];
  let content = structuredClone(EMPTY_CONTENT_STATE);
  for (const accountId of ['wx-a', 'wx-b']) content = addPublishRecord(content, { articleKey: key, accountId, mediaId: accountId, articleIndex: 0, title: '标题', action: 'created', createdAt: 1 });
  identities = relocateArticles(identities, '/work', 'a.md', 'folder/b.md');
  const movedKey = identities['/work']['folder/b.md'];
  assert.equal(content.bindings[movedKey]['wx-a'].mediaId, 'wx-a');
  assert.equal(content.bindings[movedKey]['wx-b'].mediaId, 'wx-b');
  assert.equal(content.publishRecords.filter(item => item.articleKey === movedKey).length, 2);
});
