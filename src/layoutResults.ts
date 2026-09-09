export interface LayoutResult { id: string; requestId: string; sourceHash: string; resultHash: string; createdAt: number }
export interface LayoutState {
  requests: Record<string, string>;
  candidates: Record<string, LayoutResult[]>;
  confirmed: Record<string, string>;
}
export const EMPTY_LAYOUT_STATE: LayoutState = { requests: {}, candidates: {}, confirmed: {} };
export function beginLayout(state: LayoutState, articleKey: string, requestId: string): LayoutState {
  return { ...state, requests: { ...state.requests, [articleKey]: requestId } };
}
export function acceptLayout(state: LayoutState, articleKey: string, result: LayoutResult, currentHash: string): LayoutState {
  if (state.requests[articleKey] !== result.requestId || result.sourceHash !== currentHash) return state;
  return { ...state, candidates: { ...state.candidates, [articleKey]: [result, ...(state.candidates[articleKey] ?? [])] } };
}
export function confirmLayout(state: LayoutState, articleKey: string, id: string, currentHash: string): LayoutState {
  const result = state.candidates[articleKey]?.find(item => item.id === id);
  if (!result || result.sourceHash !== currentHash) throw new Error('原文已变化，请重新生成候选后再采用');
  return { ...state, confirmed: { ...state.confirmed, [articleKey]: id } };
}
