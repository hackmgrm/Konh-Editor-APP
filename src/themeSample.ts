/**
 * The miniature article every theme card shows.
 *
 * A card used to be a hand-drawn approximation — an "Aa" in the theme's
 * heading face, a bar in its accent, two grey rules for prose. It could only
 * ever be an approximation, and the things that actually separate two themes
 * (how a quote is marked, how tight the leading is, what a list bullet looks
 * like, whether the paper is warm or cold) were exactly the things it left
 * out. So the card renders a real article with the real renderer instead.
 *
 * Nothing here touches theme.ts or markdown.ts: the thumbnail only *consumes*
 * them, and a paste into WeChat is unaffected by definition.
 */

import { renderArticle } from './markdown';
import { getDensity, type Theme } from './theme';

/**
 * Deliberately short, and deliberately covering the four blocks that differ
 * most between themes: a heading (which carries the decoration), prose (size,
 * leading, colour, indent), a quote, and a list. No image — an image in a
 * 100px card is a grey box, and it would mean handing every render an image
 * index it does not otherwise need.
 *
 * The length is load-bearing. The card is 9:8 and the page inside it is laid
 * out at 360px, so whatever this renders to has to fit in 320px of height or
 * the bottom of it is clipped — a second list item put the list half over the
 * fold, which reads as a rendering bug rather than as a sample. One item says
 * everything about a bullet that two do. As written, the tallest theme (松墨)
 * comes to 306px and the shortest to 208, so every card ends on a strip of its
 * own paper rather than on a cut-off line.
 */
const SAMPLE = `## 标题示例

这是一段正文，用来看清这套主题的**字号、行距和配色**，以及[链接](https://example.com)长什么样。

> 引用里的一句话。

- 列表的一项
`;

/**
 * Cheap content hash (djb2). The key is the theme id *plus* this, because a
 * theme edited in the studio keeps its id while every value under it changes —
 * and a length-only key misses every edit that happens to be length-neutral,
 * which "change one hex colour" always is.
 */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

const cache = new Map<string, string>();

/**
 * The sample rendered with `th`, as the HTML the card drops into its thumb.
 * Memoised, so re-opening the popover — twenty-odd renders — costs one Map
 * lookup per card.
 */
export function sampleHtmlFor(th: Theme): string {
  const json = JSON.stringify(th);
  const key = `${th.id}:${hash(json)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // `.html` rather than `.body`: the wrapper section is where the body font,
  // size, colour and tracking live, and without it the thumb would inherit
  // the popover's own 13.5px sans for anything the renderer leaves unstyled.
  // Standard density, because the card is showing the theme, not the density
  // — that is the control directly below it.
  const { html } = renderArticle(SAMPLE, th, {}, getDensity('standard'), { linkFootnotes: false });

  // The card is a <button>, and an <a href> inside one is interactive content
  // nested in interactive content: invalid, and a real keyboard trap. The
  // anchor keeps its inline style — which is the only part of it the card is
  // showing — and loses the parts that make it a link.
  const inert = html.replace(/<a href="[^"]*" target="_blank" rel="noopener noreferrer"/g, '<a');

  cache.set(key, inert);
  return inert;
}
