import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeepTalkPrompt, detectDeepTalkTemplate } from './deepTalk.ts';

test('auto-detects common article structures', () => {
  assert.equal(detectDeepTalkTemplate('React 入门教程'), 'tutorial');
  assert.equal(detectDeepTalkTemplate('本周 AI 新闻与产品发布'), 'news');
  assert.equal(detectDeepTalkTemplate('为什么大模型价格还在下降'), 'analysis');
});

test('builds a new-file task by default', () => {
  const prompt = buildDeepTalkPrompt({
    topic: 'AI Agent 的真实生产力',
    category: 'ai',
    style: 'professional',
    length: 'medium',
    template: 'analysis',
    destination: 'new',
  });
  assert.match(prompt, /AI Agent 的真实生产力/);
  assert.match(prompt, /1500–2500 字/);
  assert.match(prompt, /不要覆盖已有文件/);
});

test('names the current draft when rewriting it', () => {
  const prompt = buildDeepTalkPrompt({
    topic: '重写现有内容',
    category: 'tech',
    style: 'casual',
    length: 'short',
    template: 'auto',
    destination: 'current',
    activeId: '草稿/旧文.md',
  });
  assert.match(prompt, /草稿\/旧文\.md/);
  assert.match(prompt, /写回这个文件/);
});

test('rejects an empty topic', () => {
  assert.throws(() => buildDeepTalkPrompt({
    topic: '  ',
    category: 'tech',
    style: 'professional',
    length: 'medium',
    template: 'auto',
    destination: 'new',
  }), /请填写文章主题/);
});

test('uses the freight-forwarding domain guide', () => {
  const prompt = buildDeepTalkPrompt({
    topic: '跨境电商旺季订舱避坑',
    category: 'freight',
    style: 'professional',
    length: 'medium',
    template: 'analysis',
    destination: 'new',
  });
  assert.match(prompt, /国际货运代理/);
  assert.match(prompt, /运价/);
  assert.doesNotMatch(prompt, /投资建议/);
});
