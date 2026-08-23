/**
 * Which machine this window is running on.
 *
 * Two things in the interface genuinely differ per platform and neither can be
 * expressed in CSS alone: the modifier key in written hints (⌘ on a Mac, Ctrl
 * everywhere else), and the room the toolbar has to leave for the macOS traffic
 * lights. Everything else is handled by tokens.
 *
 * There is no Tauri OS plugin here on purpose. The webview's own identity is
 * already the answer and it costs nothing: WKWebView says Macintosh, WebView2
 * says Windows, WebKitGTK says X11; Linux, and it works in a plain browser too
 * — which is what makes the frontend still runnable outside the shell.
 */

export type OS = 'mac' | 'windows' | 'linux' | 'other';

function detect(): OS {
  // Chromium (so WebView2) exposes this directly and does not lie about it.
  // WebKit — both WKWebView and WebKitGTK — does not implement it at all, so
  // those two arrive by way of the user agent string
  const hinted = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const name = hinted || navigator.userAgent;
  if (/mac|iphone|ipad/i.test(name)) return 'mac';
  if (/win/i.test(name)) return 'windows';
  // Tested after the other two: a Windows UA contains no "linux", but checking
  // it first would still be reading the string in the wrong order
  if (/linux|x11|cros|bsd/i.test(name)) return 'linux';
  return 'other';
}

export const OS: OS = detect();
export const IS_MAC = OS === 'mac';

/**
 * A keyboard hint written the way that platform writes it.
 *
 * `chord('V')` → `⌘V` on a Mac, `Ctrl+V` everywhere else. macOS spells
 * modifiers as glyphs run together; Windows and Linux both spell them as words
 * joined by a plus. Printing `⌘V` to someone on either is not a cosmetic
 * mismatch — it names a key their keyboard does not have.
 */
export function chord(key: string): string {
  if (IS_MAC) return `⌘${key === 'Enter' ? '↩' : key}`;
  return `Ctrl+${key}`;
}

/** Put the resolved OS on <html> so the stylesheet can branch on it too */
export function applyPlatform(): void {
  document.documentElement.dataset.os = OS;
}
