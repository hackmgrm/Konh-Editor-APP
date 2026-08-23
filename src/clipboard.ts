/**
 * Rich-text clipboard copy: writes both text/html and text/plain, so pasting
 * into the WeChat editor (a UEditor derivative) keeps every inline style.
 */

/** Strip preview-only markers before copying (data-line / data-tip mean nothing
 *  to the article, and WeChat keeps stray attributes verbatim) */
export function stripPreviewMeta(html: string): string {
  return html.replace(/ data-line="\d+"/g, '').replace(/ data-tip(?=[ >])/g, '');
}

/** Block-level elements (which need a newline when flattening to plain text) */
const BLOCK_SELECTOR = 'p,div,section,h1,h2,h3,h4,h5,h6,li,tr,pre,pre code,blockquote,hr,table';

/**
 * HTML → plain text.
 *
 * A DOMParser document takes no part in layout, so innerText degrades to
 * textContent and the whole article collapses onto one line. Adding newlines
 * for block elements explicitly is what gives the plain-text paste paragraphs.
 */
function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.body.querySelectorAll(BLOCK_SELECTOR).forEach((el) => el.append('\n'));
  return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Copy rich text to the clipboard; returns whether it worked */
export async function copyRichText(html: string): Promise<boolean> {
  const clean = stripPreviewMeta(html);
  const plain = htmlToPlainText(clean);

  // Preferred: the modern ClipboardItem API (Chrome 76+ / Edge, the browsers
  // people actually run the WeChat backend in)
  if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([clean], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch {
      // fall through to execCommand
    }
  }

  // Fallback: a hidden contenteditable container plus execCommand('copy')
  return copyViaExecCommand(clean);
}

function copyViaExecCommand(html: string): boolean {
  const container = document.createElement('div');
  container.setAttribute('contenteditable', 'true');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.innerHTML = html;
  document.body.appendChild(container);

  const range = document.createRange();
  range.selectNodeContents(container);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  selection?.removeAllRanges();
  document.body.removeChild(container);
  return ok;
}
