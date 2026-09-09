import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_CONTENT_STATE,
  addPublishRecord,
  addVersion,
  articleKey,
  parseContentState,
  savePublishedLink,
} from './contentState.ts';

test('文章键隔离工作区', () => {
  assert.equal(articleKey('/a/', '稿.md'), '/a::稿.md');
  assert.notEqual(articleKey('/a', '稿.md'), articleKey('/b', '稿.md'));
});

test('损坏的存储安全回退', () => {
  assert.deepEqual(parseContentState('{bad'), EMPTY_CONTENT_STATE);
});

test('相同正文不重复保存版本且只保留 30 份', () => {
  let state = structuredClone(EMPTY_CONTENT_STATE);
  state = addVersion(state, 'a', 'same', '初稿', 1);
  assert.equal(addVersion(state, 'a', 'same', '自动保存', 2), state);
  for (let i = 0; i < 35; i++) state = addVersion(state, 'a', `v${i}`, '自动保存', i + 10);
  assert.equal(state.versions.a.length, 30);
  assert.equal(state.versions.a[0].content, 'v34');
});

test('发布记录同时建立草稿绑定', () => {
  const state = addPublishRecord(structuredClone(EMPTY_CONTENT_STATE), {
    articleKey: 'w::a.md', accountId: 'wx1', mediaId: 'media', articleIndex: 0,
    title: '标题', action: 'created', createdAt: 9,
  });
  assert.equal(state.bindings['w::a.md'].wx1.mediaId, 'media');
  assert.equal(state.publishRecords[0].action, 'created');
});

test('旧版文章数据补齐正式链接存储', () => {
  assert.deepEqual(parseContentState('{"statuses":{"a":"writing"}}').publishedLinks, {});
});

test('正式文章关联按账户更新、保留其他账户并标记发布状态', () => {
  let state = savePublishedLink(structuredClone(EMPTY_CONTENT_STATE), 'a', 'wx1', 'https://mp.weixin.qq.com/s/first');
  state = savePublishedLink(state, 'a', 'wx2', 'https://mp.weixin.qq.com/s/second');
  state = savePublishedLink(state, 'a', 'wx1', 'https://mp.weixin.qq.com/s/new');
  assert.equal(state.publishedLinks.a.length, 2);
  assert.equal(state.publishedLinks.a.find(item => item.accountId === 'wx1')?.url, 'https://mp.weixin.qq.com/s/new');
  assert.equal(state.statuses.a, 'published');
  assert.equal(state.publishedLinks.b, undefined);
  assert.equal(state.publishRecords.length, 0);
});

test('拒绝伪造域名、脚本、凭据网址和空账户', () => {
  for (const url of ['javascript:alert(1)', 'https://mp.weixin.qq.com.evil.test/s/a', 'https://mp.weixin.qq.com@evil.test/s/a', 'http://mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com/', 'https://me@mp.weixin.qq.com/s/a']) {
    assert.throws(() => savePublishedLink(EMPTY_CONTENT_STATE, 'a', 'wx1', url));
  }
  assert.throws(() => savePublishedLink(EMPTY_CONTENT_STATE, 'a', '', 'https://mp.weixin.qq.com/s/a'));
});


test('同一文章在多个公众号的草稿绑定独立保留', () => {
  let state = structuredClone(EMPTY_CONTENT_STATE);
  for (const [accountId, mediaId, createdAt] of [['wx1', 'a', 1], ['wx2', 'b', 2], ['wx1', 'a2', 3]] as const) {
    state = addPublishRecord(state, { articleKey: 'article', accountId, mediaId, articleIndex: 1, title: mediaId, action: 'created', createdAt });
  }
  assert.equal(state.bindings.article.wx1.mediaId, 'a2');
  assert.equal(state.bindings.article.wx2.mediaId, 'b');
});

test('旧绑定迁移并从历史记录恢复其他账户的最新关联', () => {
  const old = {
    bindings: { article: { accountId: 'wx1', mediaId: 'new', articleIndex: 0, title: '新', updatedAt: 10 } },
    publishRecords: [
      { articleKey: 'article', accountId: 'wx2', mediaId: 'b2', articleIndex: 0, title: 'B2', createdAt: 8 },
      { articleKey: 'article', accountId: 'wx2', mediaId: 'b1', articleIndex: 0, title: 'B1', createdAt: 2 },
      { articleKey: 'article', accountId: 'wx1', mediaId: 'old', articleIndex: 0, title: '旧', createdAt: 1 },
    ],
  };
  const state = parseContentState(JSON.stringify(old));
  assert.equal(state.bindings.article.wx1.mediaId, 'new');
  assert.equal(state.bindings.article.wx2.mediaId, 'b2');
  assert.deepEqual(parseContentState(JSON.stringify(state)), state);
});
