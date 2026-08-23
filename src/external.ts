/**
 * Links to the outside world.
 *
 * Inside the Tauri webview an `<a target="_blank">` does nothing whatsoever:
 * there is no tab strip to open into, and the webview will not spawn a second
 * window on the page's say-so. The click lands, the link highlights, and
 * nothing happens — which reads as a broken link rather than as a security
 * boundary.
 *
 * So every external address is handed to the operating system instead, and it
 * opens in whatever browser the user actually uses. One delegated listener
 * covers the whole application: the console links in the settings dialog, the
 * links inside a rendered article in the preview, and whatever the agent
 * writes into its own panel — none of those have to remember to do it
 * themselves.
 */

import { openUrl } from '@tauri-apps/plugin-opener';

/** Only http(s) leaves the app this way; the allow-list in the Tauri
 *  capability file is what actually enforces it */
const EXTERNAL = /^https?:\/\//i;

export async function openExternal(url: string): Promise<void> {
  if (!EXTERNAL.test(url)) return;
  try {
    await openUrl(url);
  } catch (err) {
    // Nothing useful to say to the user here — the address is on screen and
    // can be copied by hand
    console.warn('打不开外部链接', url, err);
  }
}

/** Install once, before the first render */
export function interceptExternalLinks(): void {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    // `href` on the element is already resolved against the document, so a
    // relative link cannot masquerade as an external one
    if (!(anchor instanceof HTMLAnchorElement) || !EXTERNAL.test(anchor.href)) return;
    e.preventDefault();
    void openExternal(anchor.href);
  });
}
