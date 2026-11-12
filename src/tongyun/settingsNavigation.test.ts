import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

const view = readFileSync(new URL('./components/SettingsView.tsx', import.meta.url), 'utf8');
const css = postcss.parse(readFileSync(new URL('./index.css', import.meta.url), 'utf8'));

test('every settings category uses the shared selected-state navigation', () => {
  assert.match(view, /className="settings-category-nav /);
  assert.match(view, /filteredTabs\.map\(\(tab\)/);
  assert.match(view, /aria-current=\{subTab === tab\.id \? "page" : undefined\}/);
  assert.match(view, /bg-\[#2D323A\] dark:bg-\[#2A2E38\]/);
});

test('selected category foreground overrides the host reset in both themes', () => {
  const rule = css.nodes.find((node) => node.type === 'rule' && node.selectors.includes('.settings-category-nav button[aria-current="page"]')); 
  assert.ok(rule && rule.type === 'rule', 'selected-state rule must be unlayered to override the host reset');
  const color = rule.nodes.find((node) => node.type === 'decl' && node.prop === 'color');
  assert.ok(color && color.type === 'decl');
  assert.equal(color.value, '#fff');
  assert.ok(rule.selectors.includes('.dark nav.settings-category-nav button[aria-current="page"]'));
  assert.ok(rule.selectors.includes('.dark nav.settings-category-nav button[aria-current="page"]:hover'));
});

test('category changes reset the main scroll without moving focus or sticky navigation', () => {
  assert.match(view, /useLayoutEffect\(\(\) => \{\s*const main = settingsRef\.current\?\.closest\("main"\);\s*if \(main\) main\.scrollTop = 0;\s*\}, \[subTab\]\)/);
  assert.doesNotMatch(view, /settings-category-nav[^"\n]*\bsticky\b/);
  assert.doesNotMatch(view, /\.focus\(/);
});
