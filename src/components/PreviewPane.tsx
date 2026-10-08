import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, Palette } from '@phosphor-icons/react';
import { createPortal } from 'react-dom';
import Tooltip from './Tooltip';
import { stripFirstH1 } from '../markdown';
import type { ScrollSyncChannel } from '../scrollSync';
import { getConfig, setConfig } from '../store/appConfig';
import type { Theme } from '../theme';
import { SECTION_TITLE, sectionAt, type SectionId } from '../themeFields';
import { hintFor } from '../shortcuts';
import { morphChildren } from '../morph';
import { EASE, animate } from '../usePresence';

/* ---------------- iOS status glyphs ----------------
   Drawn here rather than taken from an icon set: the status bar is the one
   place in this app that has to pass for a photograph of iOS, and no general
   icon family draws these three shapes the way the system does. Each viewBox
   is stated in device points at the size iOS draws the glyph, so _preview.css
   can size them with `--pt` and they scale with the frame. `currentColor`
   keeps them on the colour the article theme hands the bar. */

/** Cellular: four bars, all filled because the mock is always at full signal.
 *  Every number here is on a grid and has to stay on it, or the glyph reads as
 *  hand-drawn at 4×: x steps by 4.5 (3 wide, 1.5 gap), height steps by 2.5
 *  (4.5 → 12), every bar shares the bottom edge at y = 12 and the same 1 pt
 *  radius. The tops then fall on one straight diagonal. 16.5 × 12 pt. */
function StatusCellular() {
  return (
    <svg className="sb-cellular" viewBox="0 0 16.5 12" fill="currentColor" aria-hidden="true">
      <rect x="0" y="7.5" width="3" height="4.5" rx="1" />
      <rect x="4.5" y="5" width="3" height="7" rx="1" />
      <rect x="9" y="2.5" width="3" height="9.5" rx="1" />
      <rect x="13.5" y="0" width="3" height="12" rx="1" />
    </svg>
  );
}

/** Wi-Fi: traced off the system glyph, not estimated. `SF Symbols wifi` was
 *  rendered at pointSize 1200 in .bold (NSImage(systemSymbolName:)), split into
 *  its three connected components, and every boundary circle-fitted to under
 *  0.4 px. What came back, in that pixel space:
 *
 *    common centre   (793.2, 1062)   all three arcs are concentric
 *    apex            (793.2, 1132.4) the two straight side cuts converge BELOW
 *                                    the arc centre, 70 px down — that is what
 *                                    makes it a fan rather than a pie slice
 *    side cuts       45.4° either side of vertical (a 90.8° fan)
 *    outer band      r 957 → 757     thickness 200
 *    middle band     r 604 → 411     thickness 193
 *    wedge           r 261 down to the apex, filled
 *    gaps            153 and 150     so thickness : gap = 1.31
 *    corners         r 36 on all of them, including the apex
 *
 *  Scaled to a 12 pt ink height that is a 16.55 × 12 pt box. .bold rather than
 *  .semibold (which measures 1.22): the reference photograph shows thick bands
 *  and narrow gaps, and bold also survives antialiasing at this size.
 *
 *  Each band is ONE closed filled path — outer arc, rounded corner, straight
 *  cut, rounded corner, inner arc, and back — so all three bands share the same
 *  two straight sides. No strokes: a round-capped stroke ends perpendicular to
 *  its arc, which is the wrong shape, and it cannot give the sides. The numbers
 *  come from scratchpad/genwifi.py; re-run it to change anything. */
function StatusWifi() {
  return (
    <svg className="sb-wifi" viewBox="0 0 16.546 12" fill="currentColor" aria-hidden="true">
      <path d="M0.0598 3.5123A11.3591 11.3591 0 0 1 16.4861 3.5123A0.4273 0.4273 0 0 1 16.4771 4.1118L15.3947 5.1782A0.4273 0.4273 0 0 1 14.7851 5.1683A8.9852 8.9852 0 0 0 1.7609 5.1683A0.4273 0.4273 0 0 1 1.1513 5.1782L0.0689 4.1118A0.4273 0.4273 0 0 1 0.0598 3.5123Z" />
      <path d="M3.0423 6.4564A7.1691 7.1691 0 0 1 13.5037 6.4564A0.4273 0.4273 0 0 1 13.4918 7.0530L12.4683 8.0613A0.4273 0.4273 0 0 1 11.8547 8.0470A4.8783 4.8783 0 0 0 4.6913 8.0470A0.4273 0.4273 0 0 1 4.0777 8.0613L3.0542 7.0530A0.4273 0.4273 0 0 1 3.0423 6.4564Z" />
      <path d="M5.9338 9.3279A3.0979 3.0979 0 0 1 10.6122 9.3279A0.4273 0.4273 0 0 1 10.5894 9.9125L8.5729 11.8992A0.4273 0.4273 0 0 1 7.9731 11.8992L5.9566 9.9125A0.4273 0.4273 0 0 1 5.9338 9.3279Z" />
    </svg>
  );
}

/** Battery: a 25 × 12.5 pt outline at 40% with the terminal nub beside it, and
 *  the charge as a solid inset fill — full, so it spans the whole inside. */
function StatusBattery() {
  return (
    <svg className="sb-battery" viewBox="0 0 26.8 12.5" aria-hidden="true">
      <rect
        x="0.5"
        y="0.5"
        width="24"
        height="11.5"
        rx="3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.4"
      />
      <rect x="25.3" y="4" width="1.5" height="4.5" rx="0.75" fill="currentColor" opacity="0.4" />
      <rect x="2" y="2" width="21" height="8.5" rx="2.5" fill="currentColor" />
    </svg>
  );
}

/** Keep-inside-the-window margin for the hint bubble */
const HINT_PAD = 8;
/** Gap between the capsule's bottom edge and the bubble */
const HINT_GAP = 9;

/**
 * The one-time callout that points at the theme capsule.
 *
 * On <body> like every other floating layer, so the pane's clipping cannot
 * reach it, and placed from the capsule's own rect — re-read whenever the pane
 * changes size, because the splitter, the view mode and the side columns all
 * move the capsule without moving the window. It renders nothing while the
 * capsule has no box (the preview is not on screen).
 */
function TypesetHint({
  paneRef,
  onDismiss,
}: {
  paneRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const [at, setAt] = useState<{ left: number; top: number; arrow: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const place = () => {
      const chip = pane.querySelector<HTMLElement>('[data-typeset-trigger]');
      const r = chip?.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) {
        setAt(null);
        return;
      }
      const w = bubbleRef.current?.offsetWidth ?? 300;
      // Start where the capsule starts; the arrow finds the capsule's centre
      // from there, however far the window edge pushed the bubble
      const left = Math.max(HINT_PAD, Math.min(r.left, window.innerWidth - HINT_PAD - w));
      const arrow = Math.max(14, Math.min(r.left + r.width / 2 - left, w - 14));
      setAt({ left: Math.round(left), top: Math.round(r.bottom + HINT_GAP), arrow: Math.round(arrow) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(pane);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [paneRef]);

  return createPortal(
    <div
      ref={bubbleRef}
      className="popover typeset-callout"
      role="dialog"
      aria-label="在这里换排版主题"
      style={at ? { left: at.left, top: at.top } : { visibility: 'hidden', left: 0, top: 0 }}
    >
      <span className="typeset-callout-arrow" style={{ left: at?.arrow ?? 0 }} aria-hidden="true" />
      <div className="typeset-callout-title">在这里换排版主题</div>
      <div className="typeset-callout-body">十几套公众号主题、排版密度和界面外观都在这里。</div>
      <div className="typeset-callout-foot">
        <button type="button" className="typeset-callout-ok" onClick={onDismiss}>
          知道了
        </button>
      </div>
    </div>,
    document.body,
  );
}

interface Props {
  body: string;
  title: string;
  hasHero: boolean;
  collapsed: boolean;
  theme: Theme;
  /** Whether the body contains images (shows the WeChat paste notice) */
  hasImage: boolean;
  /** Set while the theme studio is open: clicking an element in the article
   *  names the section that styles it, instead of doing what a click does */
  onPick?: (section: SectionId) => void;
  /** Name of the current density preset, shown next to the theme name */
  densityName: string;
  /** Which draft is open. Only used to cross-fade when it changes — a new
   *  article should arrive, not blink into place */
  draftId: string;
  /** Which device the article is drawn as. Owned by App: the command palette
   *  switches it too, and two owners of one setting is one owner too many */
  device: PreviewDevice;
  onDevice: (device: PreviewDevice) => void;
  /** Open the typeset popover — the theme name in this head is a way in */
  onOpenTypeset: () => void;
  /** Whether that popover is up, so the capsule can show itself pressed */
  typesetOpen: boolean;
  /** Set while the one-time 「在这里换排版主题」 callout should show; called to
   *  dismiss it for good (see store/onboarding.ts) */
  onDismissTypesetHint?: () => void;
  /**
   * Layout-change signal (editor width and mode switching both change it):
   * a backstop for the ResizeObserver — dragging the splitter or switching
   * between side-by-side and preview forces the stage to be re-measured.
   */
  resizeKey: string;
  /** Scroll-sync channel (the editor publishes, this subscribes and writes DOM) */
  sync: ScrollSyncChannel;
}

interface Anchor {
  line: number;
  top: number;
}

/** Tail blend range: the last stretch of editor travel used to converge
 *  smoothly onto the bottom of the preview */
const TAIL_BLEND = 0.18;

/**
 * What the preview is drawn as — always exactly what was picked, whatever the
 * pane's width:
 * - iphone: the phone frame
 * - duo: iPhone Duo lying open, outside up, as in Apple's photos — back half
 *   on the left, outer screen (the article) on the right
 * - duo-open: the Duo's inner screen, held landscape
 * - desktop: a macOS window, for judging the wide measure
 */
export type PreviewDevice = 'iphone' | 'duo' | 'duo-open' | 'desktop';
type DuoView = 'duo' | 'duo-open';

export const DEVICES: { id: PreviewDevice; name: string; hint: string }[] = [
  { id: 'iphone', name: 'iPhone', hint: 'iPhone 竖屏' },
  {
    id: 'duo',
    name: 'Duo 外屏',
    hint: 'iPhone Duo 摊开、外侧朝上：左边背壳，右边外屏（466×678pt）。面板窄时整台缩小，切到「预览」模式看得更清楚',
  },
  {
    id: 'duo-open',
    name: 'Duo 内屏',
    hint: 'iPhone Duo 展开、内屏横握（890×626pt）。面板窄时整台缩小，切到「预览」模式看得更清楚',
  },
  { id: 'desktop', name: '桌面', hint: '桌面版式：macOS 窗口里的宽排版' },
];

/** Per machine, like the light/dark appearance: it is how you like to look, not part of the draft */
const DEVICE_KEY = 'ui.previewDevice';

export function readDevice(): PreviewDevice {
  const v = getConfig(DEVICE_KEY);
  return DEVICES.find((d) => d.id === v)?.id ?? 'iphone';
}

/** Remembered per machine, like the light/dark appearance */
export function writeDevice(device: PreviewDevice): void {
  setConfig(DEVICE_KEY, device);
}

/** How long the frame takes to travel between two device sizes */
const FLIP_MS = 240;
/** How long the article takes to come back up after being restyled */
const RESTYLE_MS = 200;
/** How dim it goes first. Far enough to read as a change, not so far that the
 *  page looks like it went away */
const RESTYLE_FROM = 0.38;

/** Unzoomed frame sizes of the two Duo views; keep in step with the
 *  [data-device^='duo'] .phone-frame rules in _preview.css */
const DUO_FRAMES: Record<DuoView, { width: number; height: number }> = {
  duo: { width: 897, height: 647 },
  'duo-open': { width: 842, height: 599 },
};

/** The stage's content box, which the Duo views fit into */
function measure(stage: HTMLElement | null) {
  let w = 0;
  let h = 0;
  if (stage) {
    const cs = getComputedStyle(stage);
    // Floored so sub-pixel jitter while dragging doesn't re-render every frame
    w = Math.floor(stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    h = Math.floor(stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  }
  return { w, h };
}

/** Zoom that fits a Duo view into the stage, keeping its real proportions (1 = real size) */
function fitFor(device: PreviewDevice, w: number, h: number): number {
  if ((device !== 'duo' && device !== 'duo-open') || w <= 0 || h <= 0) return 1;
  const f = DUO_FRAMES[device];
  return Math.max(0.3, Math.round(Math.min(1, w / f.width, h / f.height) * 1000) / 1000);
}

/**
 * Convert a source position into a preview scroll offset.
 *
 * The point is interpolation, not snapping: find the two anchors the position
 * falls between and take a linear value between their offsets, in proportion to
 * the line number. Snapping to the nearest anchor makes the preview jump a
 * paragraph at a time — that was the old stutter. Interpolated, the preview
 * follows the editor continuously.
 */
function offsetForPosition(anchors: Anchor[], position: number, end: Anchor | null): number {
  // Binary search for the last anchor with line <= position
  let lo = 0;
  let hi = anchors.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].line <= position) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i < 0) {
    // The position sits above the first anchor (the preview drops the duplicate
    // h1, so the opening lines have no anchor of their own): interpolate from a
    // virtual "top of content" to the first anchor, otherwise reaching it jumps
    // a long way at once

    const first = anchors[0];
    if (first.line <= 0) return 0;
    return Math.max(0, first.top * Math.min(1, Math.max(0, position / first.line)));
  }
  const cur = anchors[i];
  // Past the last anchor, attach a virtual "end of article" anchor so the tail
  // keeps interpolating instead of freezing and then jumping
  const next = anchors[i + 1] ?? (end && end.line > cur.line ? end : null);
  if (!next) return Math.max(0, cur.top);
  const span = next.line - cur.line;
  if (span <= 0) return Math.max(0, cur.top);
  const t = Math.min(1, Math.max(0, (position - cur.line) / span));
  return Math.max(0, cur.top + (next.top - cur.top) * t);
}

/**
 * The inverse of offsetForPosition: a preview offset back into a source
 * position.
 *
 * Same table, same linear interpolation, read the other way. Above the first
 * anchor it interpolates from a virtual "top of content", and below the last
 * one it extrapolates at the rate of the final pair rather than pinning to the
 * last anchor — otherwise scrolling the tail of a long article would leave the
 * editor parked on the last heading.
 */
function positionForOffset(anchors: Anchor[], offset: number): number {
  if (!anchors.length) return 0;
  let lo = 0;
  let hi = anchors.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].top <= offset) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i < 0) {
    const first = anchors[0];
    if (first.top <= 0) return first.line;
    return Math.max(0, first.line * Math.min(1, Math.max(0, offset / first.top)));
  }
  const cur = anchors[i];
  const next = anchors[i + 1];
  if (!next) {
    // Past the last anchor: continue at the slope of the last pair, so the
    // final screenful still moves the editor
    const prev = anchors[i - 1];
    if (!prev || cur.top <= prev.top) return cur.line;
    const rate = (cur.line - prev.line) / (cur.top - prev.top);
    return Math.max(0, cur.line + (offset - cur.top) * rate);
  }
  const span = next.top - cur.top;
  if (span <= 0) return cur.line;
  const t = Math.min(1, Math.max(0, (offset - cur.top) / span));
  return Math.max(0, cur.line + (next.line - cur.line) * t);
}

/**
 * Build the "source line → preview offset" anchor table.
 * `top` is relative to the top of the scrolled content (it excludes the current
 * scrollTop), so it can be reused while scrolling and only needs rebuilding
 * after the body or the layout changes.
 */
function buildAnchors(scroll: HTMLElement): Anchor[] {
  // Read every geometry value in one pass without writing DOM in between, so
  // the browser is forced through a single reflow
  const box = scroll.getBoundingClientRect();
  // Rects are in visual pixels, scrollTop in the scroller's own layout pixels.
  // They differ by every zoom above the scroller (0.92 on the phone screen,
  // times the fit-to-pane zoom of the Duo views), and engines disagree on
  // whether rects include zoom at all — so measure the ratio, don't assume it.
  const k = scroll.offsetHeight > 0 ? box.height / scroll.offsetHeight : 1;
  const anchors: Anchor[] = [];
  for (const el of scroll.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(el.dataset.line);
    if (anchors.length && anchors[anchors.length - 1].line === line) continue;
    anchors.push({ line, top: (el.getBoundingClientRect().top - box.top) / k + scroll.scrollTop });
  }
  return anchors;
}

/**
 * The right-hand preview, drawn as the chosen device (see PreviewDevice):
 * - the Duo views keep their real proportions and zoom to fit the pane
 * - desktop is a macOS window with a traffic-light title bar
 * - article head on top (title plus byline), action bar at the end of the content
 * Every style in the body HTML is inline ⇒ preview and export (the WeChat
 * paste) are identical.
 */
export default function PreviewPane({
  body,
  title,
  hasHero,
  collapsed,
  theme,
  hasImage,
  densityName,
  draftId,
  device,
  onDevice,
  onOpenTypeset,
  typesetOpen,
  onDismissTypesetHint,
  resizeKey,
  sync,
  onPick,
}: Props) {
  const paneRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Content box of the device stage, for fitting the Duo views */
  const [stage, setStage] = useState({ w: 0, h: 0 });
  /**
   * Where the frame was standing when the switch was pressed.
   *
   * Measured in the click handler rather than in an effect: that is the last
   * moment the old size is still on screen, and reading it there costs one
   * layout on a gesture instead of one on every keystroke.
   */
  const flipFromRef = useRef<DOMRect | null>(null);
  const pickDevice = (next: PreviewDevice) => {
    if (next === device) return;
    flipFromRef.current = frameRef.current?.getBoundingClientRect() ?? null;
    onDevice(next);
  };
  /** What actually gets drawn */
  const layout = device === 'desktop' ? 'desktop' : 'phone';
  const fit = fitFor(device, stage.w, stage.h);
  const deviceIndex = DEVICES.findIndex((d) => d.id === device);
  /** Body used for the preview (duplicate h1 removed; exports still use the full body) */
  const previewBody = useMemo(() => (title && !hasHero ? stripFirstH1(body) : body), [body, title, hasHero]);
  /*
   * The article is no longer handed to React at all — see the morph effect
   * below, and morph.ts for why. `previewBody` stays memoised for the same
   * reason it always was: it is the value the effect keys off, and a new
   * string on every render of this pane (every hover of the studio's colour
   * picker, for one) would re-run the walk for nothing.
   */
  /** The theme studio is open and wants the clicks in the article (see onPick) */
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const picking = !!onPick;
  /** Same flag, for callbacks that outlive the render they were made in */
  const pickingRef = useRef(picking);
  pickingRef.current = picking;

  /** The theme and density the last render drew with. A change to either is a
   *  *style* change: the same article, set differently — so the reader has to
   *  stay on the paragraph they were reading, not be sent back to the top */
  const styleKeyRef = useRef(`${theme.id}|${densityName}`);
  /**
   * True while a style change settles. Unlike `picking` this is not a mode the
   * user is in, so it cannot be read off a prop: it has to outlive the commit,
   * because the new heights wake the ResizeObserver a frame or two later and
   * that must not realign either.
   */
  const restylingRef = useRef(false);
  /** Date in the article head (a new Date() on every render means nothing) */
  const today = useMemo(() => new Date(), []);

  // Track the stage size as the pane resizes, for fitting the Duo views
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const update = () => {
      const m = measure(stageRef.current);
      setStage((prev) => (prev.w === m.w && prev.h === m.h ? prev : m));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  // Backstop refresh on a layout change (drag, mode switch)
  useEffect(() => {
    const m = measure(stageRef.current);
    setStage((prev) => (prev.w === m.w && prev.h === m.h ? prev : m));
  }, [resizeKey]);

  /** Where the article is scrolled to, tracked so a re-render can restore it */
  const keptTopRef = useRef(0);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const remember = () => {
      keptTopRef.current = scroll.scrollTop;
    };
    scroll.addEventListener('scroll', remember, { passive: true });
    return () => scroll.removeEventListener('scroll', remember);
  }, []);

  /**
   * Preview → editor.
   *
   * The same anchor table read backwards: find the two anchors this offset
   * falls between and take the source position in the same proportion. Using
   * the one table for both directions is what keeps the two panes agreeing —
   * a second mapping, however carefully written, would disagree with the first
   * one somewhere, and the disagreement would show up as a slow drift while
   * the reader scrolled back and forth.
   *
   * Whether the scroll was the reader's or this pane following the editor is
   * the channel's question to answer; see canDrive in scrollSync.ts.
   */
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!sync.canDrive('preview')) return;
        // While the studio is open, or a restyle is settling, the offsets are
        // about to be wrong anyway and nobody is reading
        if (pickingRef.current || restylingRef.current) return;
        let anchors = anchorsRef.current;
        if (!anchors) {
          anchors = buildAnchors(scroll);
          anchorsRef.current = anchors;
        }
        if (!anchors.length) return;
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        const top = scroll.scrollTop;
        sync.publish({
          position: positionForOffset(anchors, top),
          endPosition: positionForOffset(anchors, max),
          atTop: top <= 2,
          atBottom: max > 0 && top >= max - 2,
          source: 'preview',
        });
      });
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sync]);

  /** Anchor cache (null means it needs rebuilding) */
  const anchorsRef = useRef<Anchor[] | null>(null);
  /** Request one sync (coalesced onto a rAF); reused when the body changes.
   *  `true` realigns even when this pane was the last to scroll */
  const scheduleRef = useRef<(force?: boolean) => void>(() => {});

  // Editor scroll → preview scroll. None of this path goes through React:
  // subscribe to the channel → coalesce onto a frame → interpolate the anchors
  // → write scrollTop.

  useEffect(() => {
    const apply = (force = false) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      // Its own message coming back around, or the editor following this pane:
      // either way there is nothing here to do. `force` is the realignment
      // after a new body, which has to land whoever scrolled last — otherwise
      // a draft opened after a scroll in this pane would never be aligned.
      if (!force && !sync.shouldFollow('preview')) return;
      const { position, endPosition, atTop, atBottom } = sync.state;
      // Align the edges exactly, so interpolation error leaves no gap at either
      // end. Snapping at the bottom is now "the interpolation had already
      // converged there", not a jump.

      if (atBottom) {
        scroll.scrollTop = scroll.scrollHeight;
        return;
      }
      if (atTop) {
        if (scroll.scrollTop !== 0) scroll.scrollTop = 0;
        return;
      }
      let anchors = anchorsRef.current;
      if (!anchors) {
        anchors = buildAnchors(scroll);
        anchorsRef.current = anchors;
      }
      if (!anchors.length) return;
      const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const end = endPosition > 0 ? { line: endPosition, top: maxScroll } : null;
      let top = offsetForPosition(anchors, position, end);

      // Landing alignment: when the editor hits its bottom, the topmost visible
      // line is still mid-document, and the anchor-derived position falls short
      // of the preview's bottom. That gap used to be closed by "at the bottom,
      // jump to the bottom", which is why the ending lurched. Now it converges
      // over the final stretch instead.


      if (endPosition > 0) {
        const t = Math.min(1, Math.max(0, position / endPosition));
        if (t > 1 - TAIL_BLEND) {
          const w = (t - (1 - TAIL_BLEND)) / TAIL_BLEND;
          const eased = w * w * (3 - 2 * w); // smoothstep: no kink on entering the blend
          top = top + (maxScroll - top) * eased;
        }
      }
      if (Math.abs(scroll.scrollTop - top) < 0.5) return;
      scroll.scrollTop = top;
    };

    let raf = 0;
    let forced = false;
    const schedule = (force = false) => {
      forced ||= force;
      // Collapse several scroll events in one frame into a single read/write
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const f = forced;
        forced = false;
        apply(f);
      });
    };
    scheduleRef.current = schedule;
    const unsubscribe = sync.subscribe(() => schedule());
    schedule(true);
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sync]);

  /**
   * Device switch, as one continuous move.
   *
   * iPhone → 桌面 is a jump from 390pt wide to a whole macOS window, and drawn
   * as a straight swap it reads as two different screenshots rather than one
   * device changing shape. FLIP: put the new frame back where the old one was,
   * then let it travel. Web Animations rather than a CSS transition because
   * the start value is measured, not declared.
   */
  useLayoutEffect(() => {
    const from = flipFromRef.current;
    flipFromRef.current = null;
    const frame = frameRef.current;
    if (!from || !frame) return;
    const to = frame.getBoundingClientRect();
    if (!to.width || !to.height || !from.width || !from.height) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    animate(
      frame,
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
      { duration: FLIP_MS, easing: EASE },
    );
  }, [device, fit]);

  // A different draft is a different article: same treatment as a restyle,
  // for the same reason
  useLayoutEffect(() => {
    animate(bodyRef.current, [{ opacity: RESTYLE_FROM }, { opacity: 1 }], {
      duration: RESTYLE_MS,
      easing: EASE,
    });
  }, [draftId]);

  /**
   * The article into the DOM, block by block.
   *
   * A layout effect, not an effect: it has to be done before the browser
   * paints, or a keystroke shows one frame of the previous article. And it is
   * declared above the two scroll-keeping effects below on purpose — effects
   * run in source order, so by the time they look at the scroller the new
   * content is already in it.
   */
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) morphChildren(el, previewBody);
  }, [previewBody]);

  useLayoutEffect(() => {
    const key = `${theme.id}|${densityName}`;
    if (key === styleKeyRef.current) return;
    styleKeyRef.current = key;
    restylingRef.current = true;
    // Cross-fade the restyle. The article's innerHTML is replaced wholesale in
    // this same commit, so there is no "before" left to fade out of: the new
    // setting comes up from dimmed instead, which is enough to read as one
    // article changing clothes rather than two articles swapped.
    //
    // A script-driven animation rather than a CSS transition, because this has
    // to fire again on the very next switch — and a transition that starts from
    // the value it is already at does nothing at all.
    animate(bodyRef.current, [{ opacity: RESTYLE_FROM }, { opacity: 1 }], {
      duration: RESTYLE_MS,
      easing: EASE,
    });
    // Two frames: one for the new body to lay out, one for the ResizeObserver
    // it wakes to have had its say
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        restylingRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [theme.id, densityName]);

  // A re-rendered body, a phone⇄desktop switch, a device switch or a refit
  // invalidates every anchor offset, and calls for one realignment
  useEffect(() => {
    anchorsRef.current = null;
    // A new body is not always new writing. While the studio is open, and for
    // the moment a theme or density switch takes to settle, it is the same
    // article restyled — and realigning would drag it to wherever the source
    // pane sits, which is the top, since nobody is typing
    if (!picking && !restylingRef.current) scheduleRef.current(true);
  }, [body, layout, device, fit, picking]);

  /**
   * Keep the reader where they were across a restyle — a studio tweak, or a
   * theme or density switch.
   *
   * Setting innerHTML empties the scroller for an instant, and an empty
   * scroller clamps its offset to zero — which is why a restyle used to land
   * the article back at the top, away from the very paragraph being looked at.
   * So remember the offset and put it back in the same frame, before any paint.
   */
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || (!picking && !restylingRef.current)) return;
    if (Math.abs(scroll.scrollTop - keptTopRef.current) > 1) scroll.scrollTop = keptTopRef.current;
  }, [body, picking]);

  // Async height changes — image decoding, font loading — invalidate them too
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      anchorsRef.current = null;
      // A restyle that changes a margin changes the article's height, and
      // realigning on that would pull the reader back to the source pane's
      // position — the top — mid-edit. Hold them where they were instead
      if (pickingRef.current || restylingRef.current) {
        const scroll = scrollRef.current;
        if (scroll && Math.abs(scroll.scrollTop - keptTopRef.current) > 1) {
          scroll.scrollTop = keptTopRef.current;
        }
        return;
      }
      scheduleRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Picking, while the theme studio is open: mark the element under the
   * pointer and hand a click to the studio.
   *
   * The mark is a box of its own laid over the article, not a style on the
   * element: an outline on the element itself sat right on top of the very
   * borders being tuned, and read as part of the theme. The box is tinted and
   * labelled, the way a style inspector marks things, so nobody mistakes it
   * for the article. It goes away on the click that picks, so the element can
   * be seen clean while its colours change, and comes back only when the
   * pointer moves on to something else.
   *
   * Placed by offsetTop/offsetLeft summed up to the scroll container, not by
   * getBoundingClientRect: the Duo views scale the whole device with CSS
   * zoom, and layout offsets are the one coordinate system zoom leaves alone.
   */
  const [mark, setMark] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    section: SectionId;
  } | null>(null);
  /** The element the mark belongs to (kept through a click, so the mark
   *  stays down until the pointer reaches a different one) */
  const litRef = useRef<Element | null>(null);
  useEffect(() => {
    const root = bodyRef.current;
    const scroller = scrollRef.current;
    if (!root || !scroller || !picking) return;
    const boxOf = (el: Element) => {
      if (!(el instanceof HTMLElement)) return null;
      let top = 0;
      let left = 0;
      let node: HTMLElement | null = el;
      while (node && node !== scroller) {
        top += node.offsetTop;
        left += node.offsetLeft;
        node = node.offsetParent as HTMLElement | null;
      }
      if (node !== scroller) return null;
      return { top, left, width: el.offsetWidth, height: el.offsetHeight };
    };
    /**
     * What the pointer means. The gaps between blocks are the body element
     * itself; a pointer there means the divider sitting in that gap if there
     * is one, or else the nearest block within a few pixels.
     *
     * The divider needs the help: a 1px rule under the phone screen's
     * `zoom: 0.92` is less than a pixel tall, and WebKit's hit test never
     * lands on it at all. So look for the blocks above and below the pointer
     * and take any divider between them in document order.
     *
     * Everything goes through elementFromPoint rather than element rects:
     * inside a zoomed subtree WebKit's getBoundingClientRect and the event's
     * clientY are not in the same coordinate space, and elementFromPoint is
     * the browser's own hit test in the event's own coordinates.
     */
    const topLevel = (n: Element): Element => {
      let cur = n;
      while (cur.parentElement && cur.parentElement !== root) cur = cur.parentElement;
      return cur;
    };
    const probe = (e: MouseEvent, dir: -1 | 1) => {
      for (let d = 3; d <= 42; d += 3) {
        const hit = document.elementFromPoint(e.clientX, e.clientY + dir * d);
        if (hit && hit !== root && root.contains(hit)) return { hit, block: topLevel(hit), d };
      }
      return null;
    };
    const isDivider = (n: Element) => n.tagName === 'HR' || (n.tagName === 'P' && !n.hasAttribute('data-line'));
    const targetOf = (e: MouseEvent): Element | null => {
      if (!(e.target instanceof Element)) return null;
      if (e.target !== root) return e.target;
      const up = probe(e, -1);
      const down = probe(e, 1);
      if (up && down && up.block !== down.block) {
        for (let n = up.block.nextElementSibling; n && n !== down.block; n = n.nextElementSibling) {
          if (isDivider(n)) return n;
        }
      }
      const near = [up, down].filter((p) => p && p.d <= 18).sort((a, b) => a!.d - b!.d)[0];
      return near ? near.hit : null;
    };
    const onOver = (e: MouseEvent) => {
      const target = targetOf(e);
      if (!target) {
        litRef.current = null;
        setMark(null);
        return;
      }
      const hit = sectionAt(target, root);
      if (hit.el === litRef.current) return;
      litRef.current = hit.el;
      const box = boxOf(hit.el);
      setMark(box ? { ...box, section: hit.section } : null);
    };
    const onLeave = () => {
      litRef.current = null;
      setMark(null);
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopPropagation();
      setMark(null);
      pickRef.current?.(sectionAt(targetOf(e) ?? root, root).section);
    };
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseleave', onLeave);
    root.addEventListener('click', onClick);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseleave', onLeave);
      root.removeEventListener('click', onClick);
      litRef.current = null;
      setMark(null);
    };
  }, [picking]);

  // A new body (every studio edit is one) replaces the element the mark was
  // measured from, so the mark would point at where it used to be
  useEffect(() => {
    litRef.current = null;
    setMark(null);
  }, [body, layout, device, fit]);

  // Follow the article theme in the status bar and desktop window chrome
  useEffect(() => {
    document.documentElement.style.setProperty('--art-accent', theme.accent);
    document.documentElement.style.setProperty('--art-heading', theme.heading.color);
    document.documentElement.style.setProperty('--art-ink', theme.body.color);
    document.documentElement.style.setProperty('--art-hr', theme.hr.color);
    document.documentElement.style.setProperty('--art-foot-text', theme.footnote.textColor);
    document.documentElement.style.setProperty('--art-bg', theme.body.bg ?? '#ffffff');
    document.documentElement.style.setProperty('--art-heading-font', theme.heading.font);
    return () => {
      document.documentElement.style.removeProperty('--art-accent');
      document.documentElement.style.removeProperty('--art-heading');
      document.documentElement.style.removeProperty('--art-ink');
      document.documentElement.style.removeProperty('--art-hr');
      document.documentElement.style.removeProperty('--art-foot-text');
      document.documentElement.style.removeProperty('--art-bg');
      document.documentElement.style.removeProperty('--art-heading-font');
    };
  }, [theme]);

  return (
    <section
      className={`split-pane preview-side ${collapsed ? 'collapsed' : ''}`}
      ref={paneRef}
      data-width={layout}
      data-device={device}
    >
      <div className="pane-head">
        {/* What is being previewed, rather than the word "preview" — which of
            the twelve themes is on, and at which density. With the theme rail
            folded into a popover, this is the only place that still says. */}
        {/* While the studio is open this says what a click would style. It
            takes the theme name's place rather than crowding in beside the
            device switcher: the name is right there in the studio's own
            header, and the two together left neither of them readable */}
        {picking ? (
          <span className="pane-pick" aria-live="polite">
            {mark ? `点一下改「${SECTION_TITLE[mark.section]}」` : '点元素改样式'}
          </span>
        ) : (
          <Tooltip content="换主题、密度和界面外观" shortcut={hintFor('typeset')} side="bottom">
            <button
              className="pane-path pane-path-btn"
              onClick={onOpenTypeset}
              aria-haspopup="dialog"
              aria-expanded={typesetOpen}
              data-typeset-trigger
            >
              <Palette size={14} weight="regular" className="pane-path-icon" aria-hidden="true" />
              {/* Keyed on the name so a theme switch replays the slide */}
              <span className="seg last" key={theme.name}>
                {theme.name}
              </span>
              <span className="seg">{densityName}</span>
              {/* Says the capsule opens downward, not that it cycles */}
              <CaretDown size={10} weight="bold" className="pane-path-caret" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {!picking && onDismissTypesetHint && (
          <TypesetHint paneRef={paneRef} onDismiss={onDismissTypesetHint} />
        )}
        <div className="pane-head-right">
          {hasImage && (
            /* A sentence that is always true while the article has a picture
               is not news, and this one sat in the middle of the head
               competing with the device switcher for the whole session. It is
               a mark now: present, findable, and silent until asked. */
            <Tooltip content="正文里有图片。公众号里单独上传一次，读者看到的清晰度更好" side="bottom">
              <span className="pane-stat warn" tabIndex={0} role="note" aria-label="正文含图片">
                <span className="pane-stat-dot" aria-hidden="true" />
              </span>
            </Tooltip>
          )}
          <div
            className="segmented device-switch"
            role="radiogroup"
            aria-label="预览机型"
            style={{ '--seg-n': DEVICES.length, '--seg-i': deviceIndex } as React.CSSProperties}
          >
            {DEVICES.map((d, i) => (
              <Tooltip key={d.id} content={d.hint} side="bottom">
                <button
                  role="radio"
                  aria-checked={device === d.id}
                  tabIndex={device === d.id ? 0 : -1}
                  className={`seg-btn ${device === d.id ? 'active' : ''}`}
                  onKeyDown={(e) => {
                    // A radiogroup is one tab stop; ←→ move within it
                    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    pickDevice(DEVICES[(i + step + DEVICES.length) % DEVICES.length].id);
                  }}
                  onClick={() => pickDevice(d.id)}
                >
                  {d.name}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      <div className="phone-stage scroll-thin" ref={stageRef}>
        <div
          className="phone-frame"
          ref={frameRef}
          style={device === 'duo' || device === 'duo-open' ? { zoom: fit } : undefined}
        >
          {/* Side buttons (phone mode): on the iPhone, action and volume left,
              power right; the Duo views move them to where its edges carry them */}
          <span className="side-btn action" aria-hidden="true"></span>
          <span className="side-btn vol-up" aria-hidden="true"></span>
          <span className="side-btn vol-down" aria-hidden="true"></span>
          <span className="side-btn power" aria-hidden="true"></span>
          {/* iPhone Duo's back half, lying beside the outer screen */}
          {device === 'duo' && (
            <div className="duo-back" aria-hidden="true">
              <div className="duo-plateau">
                <span className="duo-lens l1"></span>
                <span className="duo-lens l2"></span>
                <span className="duo-mic"></span>
                <span className="duo-flash"></span>
              </div>
              {/* The Apple mark — the true outline, from Simple Icons (CC0) —
                  in one quiet tone with a faint diagonal sheen */}
              <svg className="duo-logo" viewBox="0 0 24 24" width="112" height="112" aria-hidden="true">
                <defs>
                  <linearGradient id="duo-logo-sheen" x1="0" y1="0" x2="1" y2="1">
                    <stop className="a" offset="0" />
                    <stop className="sheen" offset="0.46" />
                    <stop className="a" offset="0.54" />
                    <stop className="b" offset="1" />
                  </linearGradient>
                </defs>
                <path
                  fill="url(#duo-logo-sheen)"
                  d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
                />
              </svg>
            </div>
          )}
          <div className="phone-screen">
            {/* macOS window title bar (desktop mode) */}
            <div className="desktop-bar">
              <span className="traffic t1"></span>
              <span className="traffic t2"></span>
              <span className="traffic t3"></span>
              <span className="bar-title">文章预览 · {theme.name}</span>
            </div>
            {/* Phone status bar: Dynamic Island centered, real status icons on
                either side. The Duo has no bar: the time and one status ring
                (Wi-Fi inside, signal as dots) stack in the top-right corner. */}
            <div className="statusbar">
              <span className="time">9:41</span>
              <span className="dynamic-island" aria-hidden="true"></span>
              <span className="sb-icons" aria-hidden="true">
                <StatusCellular />
                <StatusWifi />
                <StatusBattery />
              </span>
              <svg className="sb-orb" viewBox="0 0 32 32" aria-hidden="true">
                {/* Circle outline over the top and down both sides, to just below the middle */}
                <path className="ring" d="M1.99 19.75A14.5 14.5 0 1 1 30.01 19.75" />
                <g className="wifi">
                  <path d="M13.6 16.1A3.4 3.4 0 0 1 18.4 16.1" />
                  <path d="M11.19 13.69A6.8 6.8 0 0 1 20.81 13.69" />
                  <path d="M8.79 11.29A10.2 10.2 0 0 1 23.21 11.29" />
                </g>
                <circle cx="16" cy="18.5" r="1.4" />
                {/* The bottom of the circle, finished in five dots */}
                <circle cx="27.11" cy="25.32" r="1.15" />
                <circle cx="22.13" cy="29.14" r="1.15" />
                <circle cx="16" cy="30.5" r="1.15" />
                <circle cx="9.87" cy="29.14" r="1.15" />
                <circle cx="4.89" cy="25.32" r="1.15" />
              </svg>
            </div>
            <div className="article-scroll scroll-thin" ref={scrollRef}>
              {/* WeChat article head: title (with a placeholder when empty) plus byline */}
              {!hasHero && <div className="article-head">
                <h1 className="head-title">{title || '未命名文章'}</h1>
                <div className="meta">
                  <span className="author">空核域界</span>
                  <span className="byline">
                    {today.getFullYear()} 年 {today.getMonth() + 1} 月 {today.getDate()} 日
                  </span>
                </div>
              </div>}
              {/* Empty in JSX: its children are the article, written by the
                  morph effect above. React must never own them — it would
                  reconcile against a tree it did not build and throw the whole
                  thing away on the first render that disagreed. */}
              <div className={`check-body ${picking ? 'picking' : ''}`} ref={bodyRef} />
              {mark && (
                <div
                  className="pick-mark"
                  style={{ top: mark.top, left: mark.left, width: mark.width, height: mark.height }}
                  aria-hidden="true"
                >
                  <span className="pick-tag">{SECTION_TITLE[mark.section]}</span>
                </div>
              )}
              {/* Article footer: share / save / recommend / like, at the end of the content */}
              <div className="article-footer">
                <div className="actions">
                  <button className="action">分享</button>
                  <button className="action">收藏</button>
                  <button className="action">在看</button>
                  <button className="action">点赞</button>
                </div>
              </div>
            </div>
            {/* The fold down the middle of the Duo's inner screen */}
            <span className="crease" aria-hidden="true"></span>
            {/* Home indicator (phone mode) */}
            <span className="home-indicator" aria-hidden="true"></span>
          </div>
        </div>
      </div>
    </section>
  );
}
