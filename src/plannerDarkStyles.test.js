import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

// The preview inserts the same inline-styled article HTML used for export.
// An !important planner rule beats those inline colors in the live preview.
const css = postcss.parse(readFileSync(new URL('./tongyun/index.css', import.meta.url), 'utf8'));
function importantColorRules(element) {
  const matches = [];
  css.walkRules((rule) => {
    if (!rule.nodes.some((node) => node.type === 'decl' && node.prop === 'color' && node.important)) return;
    for (const selector of rule.selectors) {
      try {
        if (element.matches(selector)) matches.push(selector);
      } catch {
        // Browser-specific selectors such as scrollbar pseudo-elements.
      }
    }
  });
  return matches;
}

test('planner dark heading override does not reach themed writing articles', () => {
  for (const dark of [false, true]) {
    const dom = new JSDOM(`<html class="${dark ? 'dark' : ''}"><body>
      <div class="konh-planner-content"><h2>Planner</h2></div>
      <div class="konh-writing-content"><div class="article-scroll"><div class="article-head"><h1 class="head-title" style="color: #123456">Title</h1></div><div class="article-body"><h2 style="color: #abcdef">Heading</h2></div></div></div>
    </body></html>`);
    const document = dom.window.document;
    for (const heading of document.querySelectorAll('.konh-writing-content h1, .konh-writing-content h2')) {
      assert.deepEqual(importantColorRules(heading), [], `planner override reaches ${heading.outerHTML}`);
      assert.ok(heading.style.color, 'article inline theme color is retained');
    }
    assert.equal(importantColorRules(document.querySelector('.konh-planner-content h2')).length > 0, dark);
  }
});
