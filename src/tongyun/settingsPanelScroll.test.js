import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const panels = ['ai/AISettingsPanel', 'email/EmailSettingsPanel', 'fun/FunSettingsPanel', 'sunset/SunsetPanel', 'sync/SyncSettingsPanel', 'system/SystemSettingsPanel'];

test('settings category wrappers grow naturally', () => {
  for (const panel of panels) {
    const source = readFileSync(new URL(`./components/${panel}.tsx`, import.meta.url), 'utf8');
    const wrapper = source.match(/return\s*\(\s*<div className="([^"]+)"/);
    assert.ok(wrapper, `${panel}: wrapper found`);
    assert.doesNotMatch(wrapper[1], /overflow-y-|max-h-/, panel);
  }
});
