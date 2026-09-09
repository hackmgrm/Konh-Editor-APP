import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadCacheKey } from './uploadCache.ts';

test('素材缓存隔离账号、用途、编码策略和内容', async () => {
  const key = await uploadCacheKey('wx-a', 'image', 5, 'body');
  assert.equal(key, await uploadCacheKey(' wx-a ', 'image', 5, 'body'));
  for (const args of [['wx-b', 'image', 5, 'body'], ['wx-a', 'image', 5, 'cover'], ['wx-a', 'image', 6, 'body'], ['wx-a', 'changed', 5, 'body']] as const) {
    assert.notEqual(key, await uploadCacheKey(args[0], args[1], args[2], args[3]));
  }
});
