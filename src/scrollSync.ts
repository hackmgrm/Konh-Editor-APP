/**
 * The scroll-sync channel between the editor and the preview.
 *
 * Deliberately not React state: scrolling can fire every frame, and routing it
 * through setState would re-render the whole component tree along with it —
 * slow, and it chops the follow motion into discrete steps. This passes values
 * through a mutable object; each side subscribes, reads inside a rAF and writes
 * the DOM. React takes no part in the scroll path at all.
 *
 * It runs both ways. The editor converts its scrollTop into a source position
 * and the preview interpolates that into an offset; the preview inverts the
 * same anchor table to answer the other question. Two followers pointed at
 * each other is a feedback loop by construction — every write lands as the
 * other side's scroll event — so a scroll carries who caused it, and a side
 * ignores the channel for a moment after it has driven.
 */
export type ScrollSource = 'editor' | 'preview';

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
  /** Scrolled to the very top / bottom (used to align the edges exactly,
   *  so interpolation error leaves no gap) */
  atTop: boolean;
  atBottom: boolean;
  /** Which pane the reader was actually scrolling */
  source: ScrollSource;
}

/**
 * How long one side keeps the wheel after it has published.
 *
 * It has to outlast the other side's write plus the scroll event that write
 * fires, and stay under the gap between two deliberate gestures. 150ms is
 * about one flick of a trackpad's inertia: long enough that a follow-scroll
 * never bounces back, short enough that letting go of one pane and reaching
 * for the other feels like nothing happened.
 */
const COOLDOWN_MS = 150;

export interface ScrollSyncChannel {
  /** Current state (a mutable object, so a read is always the latest value) */
  readonly state: ScrollSyncState;
  /** Publish a new position and notify subscribers. The publisher takes the
   *  wheel for COOLDOWN_MS */
  publish(next: ScrollSyncState): void;
  /** Subscribe to changes, returns an unsubscribe function */
  subscribe(fn: () => void): () => void;
  /**
   * May this side publish what just happened to it?
   *
   * A scroll event says nothing about who caused it: a pane being driven by
   * the other one fires exactly the same event as a pane somebody is dragging.
   * The difference is the clock. Yes if this side already has the wheel, or if
   * nobody has touched anything for a cooldown — in which case the event can
   * only be a new gesture, because a follow would have arrived immediately.
   */
  canDrive(side: ScrollSource): boolean;
  /** Whether this side should act on what it has just been told — that is,
   *  whether the message came from the other pane */
  shouldFollow(side: ScrollSource): boolean;
}

export function createScrollSyncChannel(): ScrollSyncChannel {
  const state: ScrollSyncState = {
    position: 0,
    endPosition: 0,
    atTop: true,
    atBottom: false,
    source: 'editor',
  };
  const listeners = new Set<() => void>();
  /** Who last moved, and when */
  let driver: ScrollSource = 'editor';
  let drivenAt = 0;

  return {
    state,
    publish(next) {
      state.position = next.position;
      state.endPosition = next.endPosition;
      state.atTop = next.atTop;
      state.atBottom = next.atBottom;
      state.source = next.source;
      driver = next.source;
      drivenAt = performance.now();
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    canDrive(side) {
      return driver === side || performance.now() - drivenAt > COOLDOWN_MS;
    },
    shouldFollow(side) {
      return state.source !== side;
    },
  };
}
