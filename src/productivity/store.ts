import { validateData } from './validation';
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { emptyData, type ProductivityData } from './model.ts';

interface Snapshot {
  revision: number;
  data: ProductivityData | null;
}
const native = () => '__TAURI_INTERNALS__' in window;
const key = 'konh.productivity.v1';
let snapshot: Snapshot = { revision: 0, data: null };
let state = { data: emptyData(), ready: false, error: '' };
const listeners = new Set<() => void>();
let queue: Promise<unknown> = Promise.resolve();
let initializing: Promise<void> | null = null;
function notify() {
  listeners.forEach((fn) => fn());
}
async function read(): Promise<Snapshot> {
  if (native()) return invoke('productivity_load');
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : { revision: 0, data: null };
}
function accept(next: Snapshot) {
  if (next.revision < snapshot.revision) return;
  if (next.data) validateData(next.data);
  snapshot = next;
  state = { data: next.data ?? emptyData(), ready: true, error: '' };
  notify();
}
export async function reloadProductivity() {
  try {
    accept(await read());
  } catch (e) {
    state = { ...state, error: String(e) };
    notify();
  }
}
export function initProductivity(): Promise<void> {
  if (!initializing)
    initializing = (async () => {
      if (native())
        await listen('productivity-changed', () => {
          void reloadProductivity();
        });
      else
        window.addEventListener('storage', (e) => {
          if (e.key === key) void reloadProductivity();
        });
      await reloadProductivity();
    })();
  return initializing;
}
export function getProductivity() {
  return state.data;
}
export function mutateProductivity(
  change: (data: ProductivityData) => void,
): Promise<void> {
  const run = async () => {
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = await read();
        const data = structuredClone(current.data ?? emptyData());
        change(data);
        validateData(data);
        try {
          let next: Snapshot;
          if (native())
            next = await invoke('productivity_save', {
              expected: current.revision,
              data,
            });
          else {
            next = { revision: current.revision + 1, data };
            localStorage.setItem(key, JSON.stringify(next));
          }
          accept(next);
          return;
        } catch (e) {
          if (String(e).includes('PRODUCTIVITY_CONFLICT') && attempt < 5)
            continue;
          throw e;
        }
      }
    } catch (e) {
      state = { ...state, error: `保存失败：${String(e)}` };
      notify();
      throw e;
    }
  };
  const operation = queue.then(run);
  queue = operation.catch(() => {});
  return operation;
}
export function useProductivity() {
  useEffect(() => {
    void initProductivity();
  }, []);
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
