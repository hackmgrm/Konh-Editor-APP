/** Turn pasted rich text into restrained Markdown instead of importing fonts,
 * colors, tracking pixels and editor-specific spans. */
export function richHtmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,meta,link,iframe,object,svg').forEach((node) => node.remove());

  const walk = (node: Node, depth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ');
    if (!(node instanceof HTMLElement)) return '';
    const body = Array.from(node.childNodes).map((child) => walk(child, depth)).join('');
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return `\n${body.trim()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return body.trim() ? `**${body.trim()}**` : '';
    if (tag === 'em' || tag === 'i') return body.trim() ? `*${body.trim()}*` : '';
    if (tag === 'code') return `\`${body.trim()}\``;
    if (tag === 'blockquote') return `\n${body.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'a') {
      const href = node.getAttribute('href') ?? '';
      return href && !href.startsWith('javascript:') ? `[${body.trim() || href}](${href})` : body;
    }
    if (tag === 'li') return `\n${'  '.repeat(depth)}- ${body.trim()}`;
    if (tag === 'ul' || tag === 'ol') return `${Array.from(node.children).map((child) => walk(child, depth + 1)).join('')}\n`;
    if (tag === 'img') {
      const src = node.getAttribute('src') ?? '';
      const alt = node.getAttribute('alt') ?? '';
      return src && !src.startsWith('data:') ? `![${alt}](${src})` : '';
    }
    return body;
  };

  return walk(doc.body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanPlainPaste(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[ \t]+$/gm, '');
}
