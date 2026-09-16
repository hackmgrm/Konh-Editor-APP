import { useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Appended to the bubble — px, em, %. Not part of the value */
  unit?: string;
  onChange: (value: number) => void;
  ariaLabel?: string;
}

/** Round to the step, and to the step's own precision: 0.05 steps must not
 *  produce 1.3000000000000003 */
function snap(v: number, min: number, max: number, step: number): number {
  const n = Math.round((v - min) / step) * step + min;
  const places = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Math.min(max, Math.max(min, Number(n.toFixed(places))));
}

/**
 * The size slider.
 *
 * `<input type="range">` cannot be drawn the same way twice: the track and the
 * thumb are vendor pseudo-elements with different names per engine, the fill
 * to the left of the thumb has no standard expression at all (WebKit has no
 * `::-moz-range-progress`), and the thumb sizes itself off the platform. What
 * shipped was a bare grey rail with a system knob sitting in a panel made of
 * warm paper.
 *
 * Behaviour beyond the native control, all of it from watching someone tune a
 * theme: the value shows as a bubble *while dragging only*, so the number is
 * there exactly when it is wanted and never crowding the row otherwise; the
 * wheel works over the track, with ⇧ for ten steps; and the pointer is
 * captured, so a drag that wanders out of the 32px-tall row — which every drag
 * does — keeps going instead of stopping dead.
 */
export default function Slider({ value, min, max, step, unit = '', onChange, ariaLabel }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;

  const at = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = r.width > 0 ? (clientX - r.left) / r.width : 0;
    const next = snap(min + t * (max - min), min, max, step);
    if (next !== value) onChange(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    // Capture is what keeps a drag alive once the pointer leaves the 26px row,
    // which every drag does. It throws if the id is not an active pointer —
    // which real input never is, but a synthesised event is — and the drag
    // should still work in that case rather than dying on the first line
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer; the drag simply is not captured */
    }
    el.focus();
    setDragging(true);
    at(e.clientX);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step * k;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step * k;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    const v = snap(next, min, max, step);
    if (v !== value) onChange(v);
  };

  return (
    <div
      ref={trackRef}
      className={`slider ${dragging ? 'dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value}${unit}`}
      style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (dragging) at(e.clientX);
      }}
      onPointerUp={(e) => {
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* never captured; nothing to release */
        }
      }}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={onKeyDown}
      onWheel={(e: WheelEvent<HTMLDivElement>) => {
        // A wheel over the track adjusts the value; the field list behind it
        // does not scroll, because the pointer is on a control
        const d = e.deltaY < 0 ? 1 : -1;
        const v = snap(value + d * step * (e.shiftKey ? 10 : 1), min, max, step);
        if (v !== value) onChange(v);
      }}
    >
      <span className="slider-track" aria-hidden="true">
        <span className="slider-fill" />
      </span>
      <span className="slider-thumb" aria-hidden="true">
        <span className="slider-bubble">
          {value}
          {unit}
        </span>
      </span>
    </div>
  );
}
