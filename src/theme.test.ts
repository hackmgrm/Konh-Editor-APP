import assert from 'node:assert/strict';
import test from 'node:test';
import { getTheme, themes } from './theme.ts';

const deepTalkThemeIds = [
  'orbital-black',
  'business-warm-gray',
  'cross-border-purple',
  'industry-newspaper',
  'product-minimal',
  'knowledge-clean',
  'business-report',
];

test('registers all seven DeepTalk-inspired themes with unique ids', () => {
  assert.equal(themes.length, 30);
  assert.equal(new Set(themes.map((theme) => theme.id)).size, themes.length);
  for (const id of deepTalkThemeIds) assert.equal(getTheme(id).id, id);
});

test('keeps the aviation preset dark and the other six light', () => {
  assert.equal(getTheme('orbital-black').appearance, 'dark');
  for (const id of deepTalkThemeIds.slice(1)) assert.equal(getTheme(id).appearance, 'light');
});
