import assert from 'node:assert/strict';
import test from 'node:test';
import { composerQuery, parseWritingCommands } from './writingCommands.ts';

test('素材与指令只识别独立输入，避免误识别网址与邮箱', () => {
  assert.deepEqual(composerQuery('结合 @素材'), { kind: '@', query: '素材', start: 3 });
  assert.deepEqual(composerQuery('/摘要'), { kind: '/', query: '摘要', start: 0 });
  assert.equal(composerQuery('https://example.com/path'), null);
  assert.equal(composerQuery('me@example.com'), null);
  assert.equal(composerQuery('普通消息'), null);
  assert.deepEqual(composerQuery('@素材/AI'), { kind: '@', query: '素材/AI', start: 0 });
});
test('自定义指令兼容损坏配置并拒绝不完整数据', () => {
  assert.deepEqual(parseWritingCommands('{bad'), []);
  assert.deepEqual(parseWritingCommands('{}'), []);
  assert.deepEqual(parseWritingCommands(JSON.stringify([null, {}, { name: '非法 空格', prompt: 'test' }, { name: '摘要', prompt: '' }, { name: '我的风格', prompt: '保留作者语气' } ])), [{ name: '我的风格', prompt: '保留作者语气' }]);
});
