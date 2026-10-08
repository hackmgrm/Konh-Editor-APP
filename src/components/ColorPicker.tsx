/**
 * The theme studio's colour picker.
 *
 * Ours rather than the platform's `<input type="color">`, for the reason that
 * decides it: that input speaks opaque hex and nothing else, while a good
 * share of what a theme holds is translucent — the soft accent behind a band
 * heading, a hairline at 12% white on a dark page. With the native picker
 * those could be typed but never picked. It is also the same picker on all
 * three platforms, where the native one is an NSColorPanel on macOS, a Win32
 * dialog on Windows and a GTK one on Linux.
 *
 * It renders into document.body, positioned against its swatch: the studio's
 * field list is a scroll container, and a popover inside it would be cut off
 * by its edge.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Eyedropper } from '@phosphor-icons/react';
import {
  clamp,
  collectColors,
  formatColor,
  hsvToRgb,
  parseColor,
  rgbToHsv,
  same,
  toHex,
  type Hsva,
  type Rgba,
} from '../color';

export { collectColors, formatColor, parseColor };

/* ---------------- The picker ---------------- */

const WIDTH = 236;
const GREY: Rgba = { r: 136, g: 136, b: 136, a: 1 };

interface EyeDropperCtor {
  new (): { open: () => Promise<{ sRGBHex: string }> };
}
/** Chromium (WebView2 on Windows) has a screen eyedropper; WebKit does not */
const EyeDropperApi = (globalThis as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

/** Drag inside an element, reported as fractions of its box. Pointer capture
 *  keeps the drag alive when the pointer strays outside the popover */
const drag =
  (onAt: (x: number, y: number) => void, onEnd?: () => void) =>
  (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    el.setPointerCapture(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onAt(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height));
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      // The rAF-coalesced value goes out now rather than on the next frame:
      // releasing the thumb must not leave the theme a frame behind
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

/** Arrow keys for the sliders; ⇧ for ten steps at a time */
const arrows =
  (horizontal: (d: number) => void, vertical: (d: number) => void = horizontal) =>
  (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') horizontal(-step);
    else if (e.key === 'ArrowRight') horizontal(step);
    else if (e.key === 'ArrowUp') vertical(step);
    else if (e.key === 'ArrowDown') vertical(-step);
    else return;
    e.preventDefault();
  };

/** A text box that follows its value except while being typed in */
function Entry({
  value,
  onValue,
  className,
  ariaLabel,
  suffix,
}: {
  value: string;
  onValue: (text: string) => boolean;
  className: string;
  ariaLabel: string;
  suffix?: string;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const [bad, setBad] = useState(false);
  return (
    <label className={`st-picker-entry ${className}`}>
      <input
        className={`st-input mono ${bad ? 'bad' : ''}`}
        value={text}
        spellCheck={false}
        aria-label={ariaLabel}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(value);
          setBad(false);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setBad(!onValue(e.target.value.trim()));
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {suffix && <span className="st-picker-suffix">{suffix}</span>}
    </label>
  );
}

export default function ColorPicker({
  value,
  anchor,
  state,
  swatches,
  onChange,
  onClose,
}: {
  value: string;
  /** Enter / exit, from the swatch's presence hook — see usePresence.ts */
  state: 'enter' | 'exit';
  /** The swatch it opened from: where it is placed, and a click that does
   *  not count as "outside" (the swatch toggles it itself) */
  anchor: HTMLElement;
  swatches: string[];
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const [hsva, setHsva] = useState<Hsva>(() => rgbToHsv(parseColor(value) ?? GREY));
  /** The live value, for handlers that fire many times between renders */
  const cur = useRef(hsva);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /**
   * Colour out, at most once a frame.
   *
   * `onChange` here is the whole article re-rendering: the theme draft goes up
   * to App, markdown-it runs again, and the preview morphs. A pointermove
   * fires far more often than a frame on a trackpad, and each one used to
   * start that. Coalescing means the drag costs one render per painted frame,
   * which is the most that could ever be seen anyway.
   *
   * The final value is flushed on release rather than left in the queue —
   * letting go of the thumb must never leave the theme one frame behind where
   * the pointer stopped.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const emitRaf = useRef(0);
  const emitValue = useRef<string | null>(null);
  const flushEmit = () => {
    if (emitRaf.current) {
      cancelAnimationFrame(emitRaf.current);
      emitRaf.current = 0;
    }
    const v = emitValue.current;
    emitValue.current = null;
    if (v !== null) onChangeRef.current(v);
  };
  const emit = (v: string) => {
    emitValue.current = v;
    if (emitRaf.current) return;
    emitRaf.current = requestAnimationFrame(() => {
      emitRaf.current = 0;
      const next = emitValue.current;
      emitValue.current = null;
      if (next !== null) onChangeRef.current(next);
    });
  };
  useEffect(() => () => {
    if (emitRaf.current) cancelAnimationFrame(emitRaf.current);
  }, []);

  const adopt = (next: Hsva) => {
    // A grey has no hue and black has no saturation either: keep the ones we
    // had, or the thumbs jump to the corner the moment the colour passes
    // through one of them
    if (next.s === 0 || next.v === 0) next.h = cur.current.h;
    if (next.v === 0) next.s = cur.current.s;
    cur.current = next;
    setHsva(next);
  };

  // Typing in the field beside the swatch moves the picker as well — unless
  // the value is just the one we sent up a moment ago
  useEffect(() => {
    const c = parseColor(value);
    if (!c || same(c, hsvToRgb(cur.current))) return;
    adopt(rgbToHsv(c));
  }, [value]);

  const update = (patch: Partial<Hsva>) => {
    const next = { ...cur.current, ...patch };
    cur.current = next;
    setHsva(next);
    emit(formatColor(hsvToRgb(next)));
  };

  /** A discrete choice — a swatch, a typed hex, the eyedropper. One event, so
   *  it goes straight out */
  const take = (c: Rgba) => {
    adopt(rgbToHsv(c));
    emitValue.current = null;
    onChangeRef.current(formatColor(c));
  };

  // Below the swatch, or above it when there is no room below
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = pop.current?.offsetHeight ?? 320;
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
      const left = clamp(r.left, 8, window.innerWidth - WIDTH - 8);
      // Same position, same object: a setState with equal numbers still
      // re-renders, and `scroll` fires on the studio's field list for every
      // wheel notch
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    // Scroll fires many times a frame while the field list glides; one
    // measurement per frame is all that can be seen
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
      anchor.focus();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);

  const rgb = hsvToRgb(hsva);
  const solid = toHex(rgb);
  const now = formatColor(rgb);
  const alpha = Math.round(hsva.a * 100);

  return createPortal(
    <div
      ref={pop}
      className="popover st-picker"
      data-state={state}
      role="dialog"
      aria-label="取色"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: WIDTH,
        // Laid out but not drawn until it has been measured and placed. The
        // old -9999 alone still painted a full picker off the top-left of the
        // window for one frame, and on a slow frame you saw it go past
        visibility: pos ? undefined : 'hidden',
      }}
    >
      <div
        className="st-sv"
        style={{ background: `hsl(${hsva.h} 100% 50%)` }}
        role="slider"
        tabIndex={0}
        aria-label="饱和度与明度"
        aria-valuetext={`饱和度 ${Math.round(hsva.s * 100)}%，明度 ${Math.round(hsva.v * 100)}%`}
        onPointerDown={drag((x, y) => update({ s: x, v: 1 - y }), flushEmit)}
        onKeyDown={arrows(
          (d) => update({ s: clamp(cur.current.s + d / 100) }),
          (d) => update({ v: clamp(cur.current.v + d / 100) }),
        )}
      >
        <span className="st-thumb" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, background: solid }} />
      </div>

      <div className="st-bars">
        <div
          className="st-bar hue"
          role="slider"
          tabIndex={0}
          aria-label="色相"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsva.h)}
          onPointerDown={drag((x) => update({ h: x * 360 }), flushEmit)}
          onKeyDown={arrows((d) => update({ h: clamp(cur.current.h + d, 0, 360) }))}
        >
          <span className="st-thumb" style={{ left: `${(hsva.h / 360) * 100}%`, background: `hsl(${hsva.h} 100% 50%)` }} />
        </div>
        <div
          className="st-bar alpha st-checker"
          role="slider"
          tabIndex={0}
          aria-label="不透明度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={alpha}
          onPointerDown={drag((x) => update({ a: Math.round(x * 100) / 100 }), flushEmit)}
          onKeyDown={arrows((d) => update({ a: clamp(Math.round(cur.current.a * 100 + d) / 100) }))}
        >
          <span
            className="st-bar-fill"
            style={{
              background: `linear-gradient(to right, rgba(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)},0), ${solid})`,
            }}
          />
          <span className="st-thumb" style={{ left: `${hsva.a * 100}%` }}>
            <span style={{ background: now }} />
          </span>
        </div>
      </div>

      <div className="st-picker-row">
        <span className="st-picker-now st-checker" title={now}>
          <span style={{ background: now }} />
        </span>
        <Entry
          className="hex"
          value={solid}
          ariaLabel="十六进制颜色"
          onValue={(t) => {
            if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return false;
            const c = parseColor(t.startsWith('#') ? t : `#${t}`);
            if (c) take({ ...c, a: cur.current.a });
            return !!c;
          }}
        />
        <Entry
          className="alpha"
          value={String(alpha)}
          suffix="%"
          ariaLabel="不透明度百分比"
          onValue={(t) => {
            if (!/^\d{1,3}$/.test(t) || Number(t) > 100) return false;
            update({ a: Number(t) / 100 });
            return true;
          }}
        />
        {EyeDropperApi && (
          <button
            type="button"
            className="ghost-btn"
            title="从屏幕上取色"
            onClick={() => {
              void new EyeDropperApi()
                .open()
                .then((r) => {
                  const c = parseColor(r.sRGBHex);
                  if (c) take({ ...c, a: cur.current.a });
                })
                .catch(() => undefined);
            }}
          >
            <Eyedropper size={14} weight="bold" />
          </button>
        )}
      </div>

      {swatches.length > 0 && (
        <div className="st-picker-swatches-wrap">
          <span className="st-picker-label">这个主题里的颜色</span>
          <div className="st-picker-swatches">
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                className="st-picker-sw st-checker"
                title={c}
                aria-label={`用 ${c}`}
                onClick={() => {
                  const p = parseColor(c);
                  if (p) take(p);
                }}
              >
                <span style={{ background: c }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
