import { useSyncExternalStore } from 'react';
import { createPublishJournal, type PublishAttempt } from '../publishJournal';
import { getConfig, setConfigDurable } from './appConfig';

const KEY = 'publish-journal.v1';
let current: PublishAttempt[] | undefined;
const listeners = new Set<() => void>();
export function getPublishAttempts(): PublishAttempt[] {
  if (!current) {
    const raw = getConfig(KEY);
    // Do not silently discard a damaged journal and permit duplicate requests.
    current = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(current)) throw new Error('发布记录无法读取，请检查本机配置备份');
  }
  return current;
}
export const publishJournal = createPublishJournal({
  read: getPublishAttempts,
  write: async attempts => {
    await setConfigDurable(KEY, JSON.stringify(attempts));
    current = attempts;
    for (const listener of listeners) listener();
  },
});
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function usePublishAttempts() {
  return useSyncExternalStore(subscribe, getPublishAttempts);
}
