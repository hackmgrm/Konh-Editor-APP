const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** The branded theme owns its title in Front Matter; ordinary articles use H1. */
export function draftTitle(markdown: string, branded: boolean): string {
  const block = markdown.match(/^-{3,}[ \t]*\r?\n([\s\S]*?)\r?\n-{3,}[ \t]*(?:\r?\n|$)/);
  let frontMatterTitle = '';
  if (block) {
    for (const line of block[1].split('\n')) {
      const colon = line.search(/[:：]/);
      if (colon > 0 && line.slice(0, colon).trim() === 'title') {
        frontMatterTitle = line.slice(colon + 1).trim();
        break;
      }
    }
  }
  if (branded) return frontMatterTitle;

  const body = block ? markdown.slice(block[0].length) : markdown;
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = line.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);
    if (heading) return heading[1].trim();
  }
  return '';
}

/** Mirror the vault's cross-platform filename rules before checking collisions. */
function safeName(title: string): string {
  const cleaned = [...title].map((char) =>
    /[\\/:*?"<>|]/.test(char) || char.charCodeAt(0) < 0x20 ? '-' : char,
  ).join('');
  const trimmed = cleaned.trim().replace(/^\.+|\.+$/g, '').trim() || '未命名';
  const stem = trimmed.replace(/\.[^.]+$/, '');
  return RESERVED_NAMES.has(stem.toUpperCase()) ? `_${trimmed}` : trimmed;
}

/** Produce an available filename beside the current draft, preserving its extension. */
export function syncedDraftFileName(title: string, currentPath: string, occupiedPaths: string[]): string {
  const currentFile = currentPath.split('/').pop() ?? currentPath;
  const dot = currentFile.lastIndexOf('.');
  const extension = dot > 0 ? currentFile.slice(dot) : '';
  let base = safeName(title);
  if (extension && base.toLowerCase().endsWith(extension.toLowerCase())) base = base.slice(0, -extension.length);

  const parent = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  const occupied = new Set(occupiedPaths.filter((path) => path !== currentPath).map((path) => path.toLowerCase()));
  let candidate = `${base}${extension}`;
  let suffix = 2;
  while (occupied.has(`${parent}${candidate}`.toLowerCase())) candidate = `${base} ${suffix++}${extension}`;
  return candidate;
}
