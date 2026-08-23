/**
 * Right-click, made to mean the same thing on all three platforms.
 *
 * Each webview brings its own context menu and they are not the same menu.
 * WKWebView offers a short one (copy, look up, services); WebKitGTK offers
 * copy, reload and inspect; WebView2 offers Edge's, which includes **重新加载**,
 * **另存为** and **打印** — items that belong to a browser looking at a page,
 * not to an editor looking at your draft, and one of which throws the window
 * back to a cold start in the middle of a sentence.
 *
 * There is no setting for this: wry exposes it as a Windows-only builder flag
 * and Tauri does not surface it in tauri.conf.json, so it has to be handled
 * from the page.
 *
 * The rule is narrow on purpose. Right-clicking *text* — an editable field, or
 * a selection in the preview — still gets the native menu, because copy and
 * paste are the reason the menu exists. What gets suppressed is only the
 * right-click that lands on chrome, where every one of those menus is offering
 * to do something to the "page".
 */

/** Where a native menu is worth having: somewhere text is typed or selected */
function overText(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) {
    return true;
  }
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed;
}

/** Install once, before the first render */
export function tameContextMenu(): void {
  document.addEventListener('contextmenu', (e) => {
    // Something already dealt with it — the file tree puts up its own menu
    if (e.defaultPrevented) return;
    if (!overText(e.target)) e.preventDefault();
  });
}
