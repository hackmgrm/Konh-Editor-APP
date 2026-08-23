/**
 * The editor → preview scroll-sync channel.
 *
 * Deliberately not React state: scrolling can fire every frame, and routing it
 * through setState would re-render the whole component tree along with it —
 * slow, and it chops the follow motion into discrete steps. This passes values
 * through a mutable object; the preview subscribes, reads it inside a rAF and
 * writes the DOM. React takes no part in the scroll path at all.
 */
export interface ScrollSyncState {
  /**
   * The source position at the editor's top edge.
   * The integer part is a 0-based line number (matching the rendered
   * data-line attributes); the fraction is how far into that line block the
   * scroll has travelled — which is what lets the preview follow continuously
   * rather than jumping once per line turned over.
   */
  position: number;
  /**
   * The position when the editor is scrolled all the way down.
   *
   * Past the last anchor there is no next anchor to interpolate toward, so the
   * preview would sit still until "at the bottom" made it jump — which reads as
   * a sudden leap near the end, as though content had been skipped.
   * Treating the end of the article as a virtual anchor (endPosition → the
   * preview's maximum scroll) lets the tail interpolate all the way across,
   * with both ends still landing exactly.
   */
  endPosition: number;
  /** Editor scrolled to the very top / bottom (used to align the edges exactly,
   *  so interpolation error leaves no gap) */
  atTop: boolean;
  atBottom: boolean;
}

export interface ScrollSyncChannel {
  /** Current state (a mutable object, so a read is always the latest value) */
  readonly state: ScrollSyncState;
  /** Editor side: publish a new position and notify subscribers */
  publish(next: ScrollSyncState): void;
  /** Preview side: subscribe to changes, returns an unsubscribe function */
  subscribe(fn: () => void): () => void;
}

export function createScrollSyncChannel(): ScrollSyncChannel {
  const state: ScrollSyncState = { position: 0, endPosition: 0, atTop: true, atBottom: false };
  const listeners = new Set<() => void>();
  return {
    state,
    publish(next) {
      state.position = next.position;
      state.endPosition = next.endPosition;
      state.atTop = next.atTop;
      state.atBottom = next.atBottom;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
