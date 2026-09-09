import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_LAYOUT_STATE, beginLayout, acceptLayout, confirmLayout } from './layoutResults.ts';
const result = { id: 'candidate', requestId: 'one', sourceHash: 'original', resultHash: 'result', createdAt: 1 };
test('候选独立保存，确认前无已采用版本', () => {
  let state = beginLayout(EMPTY_LAYOUT_STATE, 'a', 'one');
  state = acceptLayout(state, 'a', result, 'original');
  assert.equal(state.confirmed.a, undefined);
  assert.equal(state.candidates.a[0].id, 'candidate');
  assert.equal(confirmLayout(state, 'a', 'candidate', 'original').confirmed.a, 'candidate');
});
test('较晚返回的旧请求及原文过期结果不覆盖最新候选', () => {
  let state = beginLayout(EMPTY_LAYOUT_STATE, 'a', 'one');
  state = beginLayout(state, 'a', 'two');
  assert.equal(acceptLayout(state, 'a', result, 'original'), state);
  assert.equal(acceptLayout(state, 'a', { ...result, requestId: 'two' }, 'changed'), state);
  state = acceptLayout(state, 'a', { ...result, requestId: 'two' }, 'original');
  assert.throws(() => confirmLayout(state, 'a', 'candidate', 'changed'), /原文已变化/);
  assert.equal(state.confirmed.a, undefined);
});
