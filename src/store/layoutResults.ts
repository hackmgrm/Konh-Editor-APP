import { useSyncExternalStore } from 'react';
import { EMPTY_LAYOUT_STATE, type LayoutState } from '../layoutResults';
import { getConfig, setConfigDurable } from './appConfig';
const KEY = 'layout-results.v1';
let state: LayoutState | undefined;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
export const getLayoutState = (): LayoutState => state ??= JSON.parse(getConfig(KEY) ?? JSON.stringify(EMPTY_LAYOUT_STATE));
export function updateLayouts(change: (state: LayoutState) => LayoutState): Promise<void> {
  const next = writes.then(async () => {
    const changed = change(getLayoutState());
    await setConfigDurable(KEY, JSON.stringify(changed));
    state = changed;
    for (const listener of listeners) listener();
  });
  writes = next.catch(() => {});
  return next;
}
export function useLayoutState() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLayoutState);
}
