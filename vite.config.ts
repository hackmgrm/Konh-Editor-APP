import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dependencies needed for first paint that almost never change — split out on
 * their own so only a version bump invalidates them.
 * The desktop build loads locally, so chunking matters less for speed than it
 * does online, but keeping it makes the build output readable: when something
 * gets fat, you can see at a glance which package it was.
 *
 * Note: list core packages only. @codemirror/lang-* and legacy-modes are
 * grammars that @codemirror/language-data loads dynamically on demand (the
 * hundred-odd small chunks in the output); folded into a fixed chunk they would
 * all become synchronous first-paint dependencies.
 */
const VENDOR_GROUPS: Record<string, string[]> = {
  react: ['react', 'react-dom', 'scheduler'],
  icons: ['@phosphor-icons/react'],
  codemirror: [
    '@codemirror/state',
    '@codemirror/view',
    '@codemirror/commands',
    '@codemirror/search',
    '@codemirror/autocomplete',
    '@codemirror/language',
    '@codemirror/lang-markdown',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    '@lezer/markdown',
    'style-mod',
    'w3c-keyname',
    'crelt',
  ],
  /* The agent panel's markdown pipeline. Loaded on demand (see AgentMarkdown);
     it is listed here only so it appears as "streamdown" in the output — left
     out, rollup picks a name from inside the package, and the one it picks is a
     re-export file called mermaid-xxxx */


  streamdown: ['streamdown'],
  markdown: [
    'markdown-it',
    'markdown-it-footnote',
    'markdown-it-mark',
    'linkify-it',
    'mdurl',
    'uc.micro',
    'entities',
    'punycode.js',
  ],
};

/** node_modules path → its group (exact package-name match, so lang-* and other
 *  shared-prefix packages are not caught by accident) */
function vendorChunk(id: string): string | undefined {
  const m = id.split('node_modules/').pop();
  if (!m) return undefined;
  const pkg = m.startsWith('@') ? m.split('/').slice(0, 2).join('/') : m.split('/')[0];
  for (const [group, pkgs] of Object.entries(VENDOR_GROUPS)) {
    if (pkgs.includes(pkg)) return group;
  }
  return undefined;
}

/**
 * Vite config for the desktop build.
 *
 * No dev middleware for fetching remote images or proxying the WeChat API:
 * both go out from Rust, where the same-origin policy does not apply, so the
 * front end never needs a server of its own — not in dev, not in production.
 */
export default defineConfig({
  plugins: [react()],
  // Tauri's error output has to stay visible; don't let vite clear the screen over it
  clearScreen: false,
  server: {
    port: 5273,
    // Fail loudly when the port is taken rather than quietly moving to another
    // one: devUrl in tauri.conf.json names this exact port.
    strictPort: true,
  },
  // Environment variables injected by Tauri have to be readable
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WKWebView on macOS matches Safari 13's feature set
    target: 'safari13',
    // Syntax highlighting and the editor's language packs are already loaded on
    // demand, so the remaining main bundle should sit well under this threshold
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules') ? vendorChunk(id) : undefined),
      },
    },
  },
});
