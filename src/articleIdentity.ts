export type ArticleIdentities = Record<string, Record<string, string>>;

/** Existing articles keep their old history key on first migration. New files
 * get a fresh identity, even when their filename was used by a deleted file. */
export function registerArticles(state: ArticleIdentities, workspace: string, paths: string[], fresh = false): ArticleIdentities {
  const existing = state[workspace];
  const entries = { ...existing };
  for (const path of paths) {
    if (fresh || !entries[path]) entries[path] = !existing && !fresh ? `${workspace.replace(/\/$/, '')}::${path}` : `article:${crypto.randomUUID()}`;
  }
  return { ...state, [workspace]: entries };
}

export function relocateArticles(state: ArticleIdentities, workspace: string, from: string, to: string): ArticleIdentities {
  const entries = { ...state[workspace] };
  const moved = Object.entries(entries).filter(([path]) => path === from || path.startsWith(`${from}/`));
  for (const [path] of moved) delete entries[path];
  for (const [path, id] of moved) entries[to + path.slice(from.length)] = id;
  return { ...state, [workspace]: entries };
}

export function forgetArticles(state: ArticleIdentities, workspace: string, from: string): ArticleIdentities {
  return { ...state, [workspace]: Object.fromEntries(Object.entries(state[workspace] ?? {}).filter(([path]) => path !== from && !path.startsWith(`${from}/`))) };
}

export interface IdentityMove { from: string; to: string }
export function recoverArticleMove(state: ArticleIdentities, workspace: string, move: IdentityMove, paths: string[]): ArticleIdentities {
  const affected = Object.keys(state[workspace] ?? {}).filter(path => path === move.from || path.startsWith(`${move.from}/`));
  const present = new Set(paths);
  const oldPresent = affected.some(path => present.has(path));
  const newPresent = affected.some(path => present.has(move.to + path.slice(move.from.length)));
  if (oldPresent && newPresent) throw new Error('上次路径变更结果不明确，请先核对原目录和目标目录，避免错误关联');
  return newPresent ? relocateArticles(state, workspace, move.from, move.to) : state;
}
