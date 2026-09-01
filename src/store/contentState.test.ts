import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_CONTENT_STATE,
  addPublishRecord,
  addVersion,
  articleKey,
  parseContentState,
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
  assert.equal(state.bindings['w::a.md'].mediaId, 'media');
  assert.equal(state.publishRecords[0].action, 'created');
});
