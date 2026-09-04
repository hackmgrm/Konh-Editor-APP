import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHumanizePrompt } from './humanizer.ts';

test('humanizer protects structural and factual content', () => {
  const prompt = buildHumanizePrompt('# 标题\n\n价格 100 元。', 'standard');
  assert.match(prompt, /保留事实、数字/);
  assert.match(prompt, /Markdown 标题层级和 Front Matter/);
  assert.match(prompt, /价格 100 元/);
});

test('humanizer rejects empty input', () => {
  assert.throws(() => buildHumanizePrompt('  ', 'light'), /没有可处理的正文/);
});
