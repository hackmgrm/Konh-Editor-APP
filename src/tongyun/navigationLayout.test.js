import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('./components/DashboardView.tsx', import.meta.url), 'utf8');

test('each planner tab gets a fresh main scroll container', () => {
  assert.match(app, /<main\s+key=\{activeTab\}/);
});

test('dashboard greeting can shrink and wrap unbroken nicknames', () => {
  assert.match(dashboard, /className="space-y-1\.5 min-w-0 max-w-full"/);
  assert.match(dashboard, /<h1 className=\{`min-w-0 \[overflow-wrap:anywhere\]/);
});
