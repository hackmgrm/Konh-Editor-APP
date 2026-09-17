/**
 * Rich-text clipboard copy: writes both text/html and text/plain, so pasting
 * into the WeChat editor (a UEditor derivative) keeps every inline style.
 */

/** Strip preview-only markers before copying (data-line / data-tip mean nothing
 *  to the article, and WeChat keeps stray attributes verbatim) */
export function stripPreviewMeta(html: string): string {
  return html.replace(/ data-line="\d+"/g, '').replace(/ data-tip(?=[ >])/g, '');
}

/** Block-level tags: where a list item's "leading inline run" ends */
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'OL', 'UL', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR']);

/**
 * The span that draws a list's own bullet or number — an inline-block with a
 * width, the shape every marker in markdown.ts takes.
 */
function isMarkerSpan(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    node.tagName === 'SPAN' &&
    node.style.display === 'inline-block' &&
    node.style.width !== ''
  );
}

/**
 * Reshape list items into the single-unit form WeChat's editor keeps on one
 * line.
 *
 * A paste runs every <li> through the editor's normalizer: the first inline
 * node stays put and everything after it is rewrapped in a <section> — a
 * block — so an item like `**标签**：正文` ends up on two lines no matter how
 * the HTML was written (an inline <p> wrapper is dissolved on the way
 * through, and content already inside one element is left alone — both
 * observed on real pastes). Each item's inline run is therefore handed over
 * as a single <section>, and the theme's own marker spans are dropped: the
 * editor rebuilds native markers anyway, and one kept inside the section
 * would double the bullet.
 */
export function prepareListsForPaste(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  /** Lists whose own markers were dropped — they need their native ones back */
  const stripped = new Set<HTMLElement>();
  for (const li of Array.from(doc.querySelectorAll('li'))) {
    // The leading inline run: everything up to the first block child (a
    // nested list, a table…). An inline <p> — what both tight and loose items
    // wrap their content in — is dissolved into the run, so both shapes are
    // handled the same way.
    const run: ChildNode[] = [];
    for (const child of Array.from(li.childNodes)) {
      if (child instanceof HTMLElement) {
        const inlineP = child.tagName === 'P' && child.style.display === 'inline';
        if (BLOCK_TAGS.has(child.tagName) && !inlineP) break;
        if (inlineP) {
          run.push(...child.childNodes);
          child.remove();
          continue;
        }
      }
      run.push(child);
    }
    let droppedMarker = false;
    const content: ChildNode[] = [];
    for (const node of run) {
      if (isMarkerSpan(node)) droppedMarker = true;
      else content.push(node);
    }
    if (!content.length) continue;
    const section = doc.createElement('section');
    li.insertBefore(section, run[0]);
    for (const node of run) {
      if (isMarkerSpan(node)) node.remove();
      else section.appendChild(node);
    }
    // The hanging indent existed to line a wrapped line up with the marker
    li.style.textIndent = '';
    if (droppedMarker && li.parentElement) stripped.add(li.parentElement);
  }
  // A list that drew its own markers hides the browser's (list-style:none);
  // with the drawn ones gone the native markers have to come back. Task lists
  // keep theirs hidden — ☑ / ☐ are the markers.
  for (const list of stripped) list.style.listStyle = '';
  return doc.body.innerHTML;
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
  const clean = prepareListsForPaste(stripPreviewMeta(html));
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
