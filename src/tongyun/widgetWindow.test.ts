import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "index.css"), "utf8");
const widget = readFileSync(join(here, "components", "WidgetWindow.tsx"), "utf8");
const card = readFileSync(join(here, "components", "SwipeCard.tsx"), "utf8");

test("Windows auxiliary windows clear the WebView surface before clipping the widget", () => {
  assert.match(css, /html\.platform-windows\.transparent-window body::after[\s\S]*display: none/);
  assert.match(css, /html\.platform-windows \.widget-window-root[\s\S]*clip-path: inset\(0 round 16px\)/);
  assert.match(css, /html\.platform-windows\.transparent-window #root\s*\{\s*background: transparent !important/);
});

test("widget controls reserve space instead of wrapping into the card", () => {
  assert.match(widget, /min-w-0 overflow-hidden whitespace-nowrap cursor-move/);
  assert.match(widget, /flex items-center gap-1 shrink-0/);
  assert.match(card, /max-w-\[280px\]/);
  assert.match(card, /whitespace-nowrap/);
  assert.match(card, /min-w-0 flex-1 truncate/);
});
