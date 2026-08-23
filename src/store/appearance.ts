/**
 * Light / dark appearance of the application shell.
 *
 * Two different things must not be confused here: this controls how the
 * *editor itself* looks (toolbar, file tree, panel fills). It has nothing to
 * do with the article themes in theme.ts — those are part of the draft and
 * travel with it into the WeChat editor when you paste. Appearance is only
 * "what is easy on my eyes, on this machine, right now".
 *
 * That is also why it lives in the app config rather than in vault prefs:
 * switch workspaces and you are still looking with the same pair of eyes.
 *
 * What lands on the DOM is always the *resolved* value (light / dark), never
 * 'system' — that way the stylesheet needs a single dark ramp instead of two
 * copies of it (one for [data-appearance='dark'], one for the media query).
 */

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getConfig, setConfig } from './appConfig';

export type Appearance = 'system' | 'light' | 'dark';
export type Resolved = 'light' | 'dark';

const KEY = 'ui.appearance';
const QUERY = '(prefers-color-scheme: dark)';

/**
 * The canvas and its ink, for the one surface CSS cannot paint: the system
 * title bar that Windows keeps above our toolbar. Same values as --canvas and
 * --text-1 in _tokens.css, repeated here because the OS wants a colour, not a
 * stylesheet.
 */
const TITLE_BAR = {
  light: { caption: '#efece4', text: '#2f2b25' },
  dark: { caption: '#141311', text: '#ece6db' },
} as const;

export function getAppearance(): Appearance {
  const v = getConfig(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveAppearance(a: Appearance): Resolved {
  if (a !== 'system') return a;
  return window.matchMedia(QUERY).matches ? 'dark' : 'light';
}

/** Writes the DOM. Must run before the first render, or frame one is light. */
export function applyAppearance(a: Appearance): Resolved {
  const resolved = resolveAppearance(a);
  document.documentElement.dataset.appearance = resolved;
  // Let native widgets (scrollbars, carets, form controls) follow along
  document.documentElement.style.colorScheme = resolved;
  // A no-op everywhere but Windows 11, and failing is fine: the title bar just
  // keeps the system colours
  void invoke('window_chrome', TITLE_BAR[resolved]).catch(() => {});
  return resolved;
}

/**
 * Appearance state. While following the system we have to watch it: macOS
 * flips at sunset while the app is running, and without a listener you would
 * have to restart to catch up.
 */
export function useAppearance() {
  const [appearance, setState] = useState<Appearance>(getAppearance);
  const [resolved, setResolved] = useState<Resolved>(() => resolveAppearance(getAppearance()));

  useEffect(() => {
    setResolved(applyAppearance(appearance));
    if (appearance !== 'system') return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setResolved(applyAppearance('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [appearance]);

  const set = (next: Appearance) => {
    setConfig(KEY, next);
    setState(next);
  };

  return { appearance, resolved, setAppearance: set };
}
