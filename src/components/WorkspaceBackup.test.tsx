// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceBackup from './WorkspaceBackup';

const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<WorkspaceBackup />));
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); delete (window as any).__TAURI_INTERNALS__; });

async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  await act(async () => { element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
async function click(button: HTMLButtonElement) { await act(async () => { button.click(); }); }

describe('workspace backup settings', () => {
  it('exports only after paths are provided and reports errors', async () => {
    expect(host.textContent).toContain('不是统一备份');
    const inputs = host.querySelectorAll('input');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '创建备份')!;
    expect(button.disabled).toBe(true);
    await change(inputs[0], '/work'); await change(inputs[1], '/backup');
    invoke.mockRejectedValueOnce('exists');
    await click(button);
    expect(invoke).toHaveBeenCalledWith('workspace_backup_export', { workspace: '/work', destination: '/backup' });
    expect(host.textContent).toContain('exists');
    expect(host.textContent).toContain('手动删除残留');
  });
  it('imports to a new directory and leaves opening it to the user', async () => {
    await change(host.querySelector('select')!, 'import');
    open.mockResolvedValueOnce('/backup');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '选择目录')!);
    await change(host.querySelectorAll('input')[1], '/restored');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '恢复到新目录')!);
    expect(invoke).toHaveBeenCalledWith('workspace_backup_import', { backup: '/backup', destination: '/restored' });
    expect(host.textContent).toContain('请手动打开');
  });
});
