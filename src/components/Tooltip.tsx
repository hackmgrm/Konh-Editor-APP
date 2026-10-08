import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { EXIT_POPOVER, usePresence } from '../usePresence';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  /** The label. Short: this is a name for a glyph, not documentation */
  content: ReactNode;
  /** Shown in mono at the end, dimmed — `chord('K')` and friends */
  shortcut?: string;
  side?: Side;
  /** Exactly one element, which gets the pointer and focus handlers */
  children: ReactElement<Record<string, unknown>>;
}

/** How long the first tooltip of a group makes you wait */
const WARM_MS = 350;
/** How long after one closes the next still counts as "the same visit" */
const COOL_MS = 250;
/** Gap between the trigger and the capsule */
const OFFSET = 8;
/** Keep-inside-the-window margin */
const PAD = 8;

/**
 * Warm-up state, shared by every tooltip on the page.
 *
 * The delay exists so that moving the pointer across a toolbar on its way
 * somewhere else does not set off eight labels. Once you have actually stopped
 * and read one, the delay has done its job — and re-imposing it on the button
 * next door is the thing that makes native tooltips feel like wading. So while
 * one is up, and for a moment after it goes down, the rest appear instantly.
 */
let warm = false;
let coolTimer: number | null = null;
/** The tooltip currently up, so a second one can take its place at once */
let current: (() => void) | null = null;

function goWarm() {
  warm = true;
  if (coolTimer !== null) {
    window.clearTimeout(coolTimer);
    coolTimer = null;
  }
}

function goCool() {
  if (coolTimer !== null) window.clearTimeout(coolTimer);
  coolTimer = window.setTimeout(() => {
    coolTimer = null;
    warm = false;
  }, COOL_MS);
}

/**
 * The app's own tooltip.
 *
 * Native `title` was doing this job for forty-odd buttons, and doing it badly:
 * a full second of nothing, then an OS-drawn box in a font from a different
 * design, in a place we do not choose, with no way to show the keyboard
 * shortcut that is the actual reason a hint is worth having. This is a dark
 * capsule in the same language as a toast, it knows the shortcut, and it flips
 * itself when it would otherwise run off the edge of the window.
 *
 * Rendered through a portal on <body>: the panels are frosted `.surface`
 * elements, and a backdrop-filter makes an element the containing block for
 * fixed descendants — a tooltip left inside one would be clipped by the pane.
 */
export default function Tooltip({ content, shortcut, side = 'bottom', children }: Props) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const { mounted, state } = usePresence(anchor !== null, EXIT_POPOVER);

  const hide = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setAnchor((prev) => {
      if (prev === null) return prev;
      goCool();
      return null;
    });
    if (current === hide) current = null;
  }, []);

  const show = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    // Whatever was up goes down first: two capsules on screen at once reads as
    // a bug, and the second one is always the one being asked for
    if (current && current !== hide) current();
    current = hide;
    goWarm();
    setAnchor(el.getBoundingClientRect());
  }, [hide]);

  const scheduleShow = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (warm) {
      show();
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      show();
    }, WARM_MS);
  }, [show]);

  useEffect(() => hide, [hide]);

  // Place it once it has a size to measure. Written straight to the style
  // rather than kept in state: this runs before paint, and a second render
  // for a pair of pixel values is a render nobody needs.
  //
  // `mounted` is in the deps because the portal appears one render after the
  // anchor is measured (usePresence flips in an effect), and without it the
  // placement never runs for that commit — the capsule paints at 0,0.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip || !anchor) return;
    const { width, height } = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let place = side;
    // Flip to the opposite side when this one has no room left
    if (place === 'bottom' && anchor.bottom + OFFSET + height > vh - PAD) place = 'top';
    else if (place === 'top' && anchor.top - OFFSET - height < PAD) place = 'bottom';
    else if (place === 'right' && anchor.right + OFFSET + width > vw - PAD) place = 'left';
    else if (place === 'left' && anchor.left - OFFSET - width < PAD) place = 'right';

    let left: number;
    let top: number;
    if (place === 'bottom' || place === 'top') {
      left = anchor.left + anchor.width / 2 - width / 2;
      top = place === 'bottom' ? anchor.bottom + OFFSET : anchor.top - OFFSET - height;
    } else {
      left = place === 'right' ? anchor.right + OFFSET : anchor.left - OFFSET - width;
      top = anchor.top + anchor.height / 2 - height / 2;
    }
    // Slide along the other axis rather than hang off the edge
    tip.style.left = `${Math.round(Math.max(PAD, Math.min(left, vw - width - PAD)))}px`;
    tip.style.top = `${Math.round(Math.max(PAD, Math.min(top, vh - height - PAD)))}px`;
    tip.dataset.side = place;
  }, [anchor, side, mounted]);

  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Whatever ref the caller already put on the element keeps working.
      // React 19 carries refs in props, so that is where to look for it
      const given = (children.props as { ref?: unknown }).ref;
      if (typeof given === 'function') given(node);
      else if (given && typeof given === 'object') (given as { current: unknown }).current = node;
    },
    onMouseEnter: (e: React.MouseEvent) => {
      (children.props.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
      scheduleShow();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      (children.props.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
      hide();
    },
    // A press means the button is about to do something; the label has had
    // its say and would only sit on top of whatever opens
    onPointerDown: (e: React.PointerEvent) => {
      (children.props.onPointerDown as ((e: React.PointerEvent) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      (children.props.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      // Keyboard arrival only: a click focuses too, and showing a label over
      // the thing that was just pressed is noise
      if (e.target instanceof Element && e.target.matches(':focus-visible')) show();
    },
    onBlur: (e: React.FocusEvent) => {
      (children.props.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {mounted &&
        createPortal(
          <div ref={tipRef} className="tooltip" data-state={state} role="tooltip">
            <span className="tooltip-text">{content}</span>
            {shortcut && <kbd className="tooltip-key">{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}
