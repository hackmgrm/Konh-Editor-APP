import { useEffect, useRef, useState } from 'react';

/**
 * Keep a thing on screen long enough for it to leave.
 *
 * React's usual `{open && <Panel/>}` unmounts on the same commit that flips
 * the flag, so an overlay can spring in and then vanish in one frame — which
 * is the single loudest reason a window reads as cheap. This holds the element
 * mounted for `exitMs` after `open` goes false and reports `state`, which the
 * consumer writes onto the root as `data-state`; the stylesheet keys the exit
 * keyframes off `[data-state='exit']`.
 *
 * Exit is shorter than entry everywhere it is used: coming in is an event
 * worth watching, going away is not.
 *
 * Reopening mid-exit cancels the pending unmount rather than waiting it out,
 * so a double-press of a toggle never leaves a dead panel behind.
 */
export function usePresence(
  open: boolean,
  exitMs: number,
): { mounted: boolean; state: 'enter' | 'exit' } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'enter' | 'exit'>(open ? 'enter' : 'exit');
  /** Mirrors `mounted` so the effect can read it without depending on it —
   *  depending on it would restart the exit timer the moment it fires */
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (open) {
      setMounted(true);
      setState('enter');
      return;
    }
    setState('exit');
    if (!mountedRef.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setMounted(false);
    }, exitMs);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, exitMs]);

  return { mounted, state };
}

/** Exit durations, so a component and its stylesheet cannot drift apart */
export const EXIT_POPOVER = 140;
export const EXIT_MODAL = 180;

/**
 * Play a Web Animations timeline, unless the reader asked for less motion.
 *
 * styles.css zeroes every CSS transition and animation under
 * `prefers-reduced-motion`, and a script-driven animation slips straight
 * through that net — so the few places that need one (a measured FLIP, a
 * cross-fade that has to retrigger) ask here instead of calling `animate`
 * directly. Returns nothing: every one of these is decoration over a layout
 * that is already correct.
 */
export function animate(
  el: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): void {
  if (!el || typeof el.animate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  el.animate(keyframes, options);
}

/** The house deceleration curve, for the script-driven animations above —
 *  the same cubic-bezier as `--ease` in _tokens.css */
export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
