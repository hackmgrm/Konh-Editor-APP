export type FrontMatter = Record<string, string>;

const BLOCK_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Read the simple string-valued front matter used by article themes. */
export function parseFrontMatter(src: string): { data: FrontMatter; content: string } | null {
  const match = src.match(BLOCK_RE);
  if (!match) return null;
  const data: FrontMatter = {};
  for (const line of match[1].split('\n')) {
    const colon = line.search(/[:：]/);
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key) data[key] = line.slice(colon + 1).trim();
  }
  return { data, content: src.slice(match[0].length) };
}

/** Change one property without rewriting comments, unknown keys, or their order. */
export function setFrontMatterField(src: string, key: string, value: string): string {
  const match = src.match(BLOCK_RE);
  const nextValue = value.replace(/[\r\n]+/g, ' ').trim();
  if (!match) return nextValue ? `---\n${key}: ${nextValue}\n---\n\n${src}` : src;

  const lines = match[1].split('\n');
  const index = lines.findIndex((line) => {
    const colon = line.search(/[:：]/);
    return colon > 0 && line.slice(0, colon).trim() === key;
  });
  if (index >= 0) {
    if (nextValue) lines[index] = `${key}: ${nextValue}`;
    else lines.splice(index, 1);
  } else if (nextValue) lines.push(`${key}: ${nextValue}`);

  return `---\n${lines.join('\n')}\n---\n` + src.slice(match[0].length);
}
