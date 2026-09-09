import { forgetArticles, registerArticles, relocateArticles, recoverArticleMove, type ArticleIdentities, type IdentityMove } from '../articleIdentity';
import { getConfig, setConfigDurable } from './appConfig';
const KEY = 'article-identities.v1';
interface Registry { identities: ArticleIdentities; moves: Record<string, IdentityMove> }
let current: Registry | undefined;
let writes: Promise<void> = Promise.resolve();
function read(): Registry {
  if (!current) {
    const value = JSON.parse(getConfig(KEY) ?? '{}');
    current = value.identities ? value : { identities: value, moves: {} };
  }
  return current!;
}
function update(change: (state: Registry) => Registry): Promise<void> {
  const next = writes.then(async () => {
    const state = change(read());
    await setConfigDurable(KEY, JSON.stringify(state));
    current = state;
  });
  writes = next.catch(() => {});
  return next;
}
export function articleIdentity(workspace: string, path: string): string {
  const state = read();
  const move = state.moves[workspace];
  const before = move && (path === move.to || path.startsWith(`${move.to}/`)) ? move.from + path.slice(move.to.length) : path;
  return state.identities[workspace]?.[path] ?? state.identities[workspace]?.[before] ?? `${workspace.replace(/\/$/, '')}::${path}`;
}
export const registerArticlePaths = (workspace: string, paths: string[], fresh = false) => update(state => ({ ...state, identities: registerArticles(state.identities, workspace, paths, fresh) }));
export const recoverArticlePaths = (workspace: string, paths: string[]) => update(state => {
  const move = state.moves[workspace];
  if (!move) return state;
  const moves = { ...state.moves }; delete moves[workspace];
  return { identities: recoverArticleMove(state.identities, workspace, move, paths), moves };
});
export const prepareArticleMove = (workspace: string, from: string, to: string) => update(state => {
  if (state.moves[workspace]) throw new Error('上次路径变更尚未完成，请重新打开工作区后再操作');
  return { ...state, moves: { ...state.moves, [workspace]: { from, to } } };
});
export const cancelArticleMove = (workspace: string) => update(state => {
  const moves = { ...state.moves }; delete moves[workspace]; return { ...state, moves };
});
export const relocateArticlePaths = (workspace: string, from: string, to: string) => update(state => {
  const moves = { ...state.moves }; delete moves[workspace];
  return { identities: relocateArticles(state.identities, workspace, from, to), moves };
});
export const forgetArticlePaths = (workspace: string, from: string) => update(state => ({ ...state, identities: forgetArticles(state.identities, workspace, from) }));
