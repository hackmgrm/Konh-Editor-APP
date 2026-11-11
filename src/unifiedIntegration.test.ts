import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('both writing hosts pass visibility to the shortcut gate', () => {
  assert.match(source('./tongyun/App.tsx'), /<WritingApp active=\{writingActive\}/);
  assert.match(source('./productivity/Shell.tsx'), /<WritingApp active=\{page === 'writing'\}/);
  assert.match(source('./App.tsx'), /active && !overlayOpen/);
});

test('mobile planner indicators are inactive while writing', () => {
  const app = source('./tongyun/App.tsx');
  for (const tab of ['matrix', 'list', 'analytics', 'journal', 'settings']) {
    assert.ok(app.includes(`aria-current={!writingActive && activeTab === "${tab}"`));
    assert.ok(app.includes(`!writingActive && activeTab === "${tab}"\n                  ?`));
  }
});

test('writing hosts establish responsive containers and native controls are not duplicated', () => {
  assert.match(source('./konhShell.css'), /container-type: inline-size/);
  assert.match(source('./productivity/productivity.css'), /\.p-writing-host \{ container-type: inline-size/);
  assert.match(source('./styles.css'), /@container \(max-width: 900px\)/);
  assert.match(source('./tongyun/components/TitleBar.tsx'), /\{IS_MAC && <div/);
});
