import { useEffect, useRef } from 'react';
import { IS_MAC, chord } from './platform';

/**
 * Every keyboard shortcut the shell owns, in one table.
 *
 * Scattering `keydown` listeners across the components that happen to own the
 * state was never going to hold: two of them would claim the same chord, none
 * of them would fire while the editor had focus, and nothing anywhere could
 * answer "what are the shortcuts". One table, one listener, and the same table
 * feeds the tooltips and the command palette — so a hint can never drift from
 * what the key actually does.
 *
 * Deliberately absent: ⌘B, ⌘I, ⌘F and ⌘Z. CodeMirror binds those inside the
 * editor and they mean the right thing there; taking them at the window would
 * break bold, italic, find and undo while typing, which is where they matter.
 */
export type ShortcutId =
  | 'viewMode'
  | 'copy'
  | 'longImage'
  | 'publish'
  | 'settings'
  | 'agent'
  | 'typeset'
  | 'outline'
  | 'palette'
  | 'quickOpen'
  | 'newDraft';

interface Binding {
  /** `e.key` in lower case, and whether Shift is part of the chord */
  key: string;
  shift: boolean;
  /** What to print next to the command — ⌘⇧C on a Mac, Ctrl+Shift+C elsewhere */
  hint: string;
  /** Chinese label, used by the command palette */
  label: string;
}

export const SHORTCUTS: Record<ShortcutId, Binding> = {
  viewMode: { key: '\\', shift: false, hint: chord('\\'), label: '对照 / 预览切换' },
  copy: { key: 'c', shift: true, hint: chord('C', true), label: '复制正文' },
  longImage: { key: 'e', shift: true, hint: chord('E', true), label: '导出长图' },
  publish: { key: 'p', shift: true, hint: chord('P', true), label: '推到草稿箱' },
  settings: { key: ',', shift: false, hint: chord(','), label: '设置' },
  agent: { key: 'j', shift: false, hint: chord('J'), label: 'Agent 面板' },
  typeset: { key: 't', shift: true, hint: chord('T', true), label: '排版' },
  outline: { key: 'o', shift: true, hint: chord('O', true), label: '大纲' },
  palette: { key: 'k', shift: false, hint: chord('K'), label: '命令面板' },
  quickOpen: { key: 'p', shift: false, hint: chord('P'), label: '快速切换草稿' },
  newDraft: { key: 'n', shift: false, hint: chord('N'), label: '新建草稿' },
};

/** Convenience for call sites that only want the printed form */
export function hintFor(id: ShortcutId): string {
  return SHORTCUTS[id].hint;
}

/**
 * The one listener, mounted in Workspace.
 *
 * Registered in capture so it beats CodeMirror's own keymap — none of these
 * chords is bound inside the editor, but capture is what makes "works while
 * typing" true by construction rather than by luck.
 *
 * `enabled` goes false while a dialog or the palette is up: those own the
 * keyboard for as long as they are open, and ⌘K inside the push dialog opening
 * a palette behind it is nobody's idea of a shortcut. Esc is not in this table
 * — each overlay closes itself.
 */
export function useShortcuts(
  handlers: Partial<Record<ShortcutId, () => void>>,
  enabled: boolean,
): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // One modifier key per platform: ⌘ on a Mac, Ctrl everywhere else.
      // Checking the other one too would make ⌃K fire on macOS, where it is
      // the system's own "delete to end of line".
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      for (const [id, binding] of Object.entries(SHORTCUTS) as [ShortcutId, Binding][]) {
        if (binding.key !== key || binding.shift !== e.shiftKey) continue;
        const run = ref.current[id];
        if (!run) continue;
        // ⌘P is the browser's print dialog and ⌘N its new window; taking the
        // event outright is the point
        e.preventDefault();
        e.stopPropagation();
        run();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
