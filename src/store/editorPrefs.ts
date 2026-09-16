/**
 * Preferences for the writing surface itself.
 *
 * The same distinction appearance.ts draws applies here: nothing in this file
 * travels with the draft. Whether the source pane shows a line-number column
 * is a fact about this machine and this pair of eyes, not about the article —
 * so it lives in the app config beside the light/dark switch rather than in
 * the vault's prefs.
 *
 * Line numbers are off by default. They are scaffolding for code, and what is
 * in this pane is prose: the column is there when you are hunting a line an
 * error message named, and in the way every other minute of the day.
 *
 * Unlike appearance, which only ever had one consumer, this value is read in
 * two places at once — the editor draws by it and the typeset popover sets
 * it. So the hook below is backed by a module-level value with a subscriber
 * list: whoever flips the switch, every mounted reader hears about it in the
 * same tick. Without that the popover and the editor would each hold their
 * own copy of the boolean and only agree again after a reload.
 */

import { useEffect, useState } from 'react';
import { getConfig, setConfig } from './appConfig';

const KEY = 'editor.lineNumbers';

let current: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();

/** The stored value, read off disk once and then kept in memory */
export function getLineNumbers(): boolean {
  if (current === null) current = getConfig(KEY) === 'true';
  return current;
}

/** Write the value through and wake every mounted reader */
export function setLineNumbers(on: boolean): void {
  current = on;
  setConfig(KEY, String(on));
  listeners.forEach((fn) => fn(on));
}

/**
 * Editor preferences, as React state. Every caller sees the same value and
 * any caller may set it.
 */
export function useEditorPrefs() {
  const [lineNumbers, setState] = useState<boolean>(getLineNumbers);

  useEffect(() => {
    // Another component may have flipped it between our first render and this
    // effect, so start by catching up
    setState(getLineNumbers());
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return { lineNumbers, setLineNumbers };
}
