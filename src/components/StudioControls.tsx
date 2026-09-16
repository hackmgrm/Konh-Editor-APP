/**
 * The inputs of the theme studio, one per kind of value a theme holds.
 *
 * Every one of them edits a CSS value *as text* underneath — the swatch, the
 * slider and the chips are ways of producing that text, never a replacement
 * for it — because a theme value can always be something no widget
 * anticipated (`rgba(…)`, `0 6px 6px 0`, `inherit`), and a control that cannot
 * show the value it was handed would quietly overwrite it.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from 'react';
import { Minus, Plus, X } from '@phosphor-icons/react';
import { cleanCss } from '../store/customThemes';
import { FONTS, type Option, type SizeSpec } from '../themeFields';
import ColorPicker, { parseColor } from './ColorPicker';
import Select from './Select';
import Slider from './Slider';
import Tooltip from './Tooltip';
import { EXIT_POPOVER, usePresence } from '../usePresence';

/** The colours the theme being edited already uses, offered in every picker —
 *  reusing one is how a theme stays a palette rather than a pile of colours */
export const SwatchContext = createContext<string[]>([]);

/* ---------------- Text, with arrow-key nudging ---------------- */

const decimals = (s: string) => (s.includes('.') ? s.split('.')[1].length : 0);

/**
 * Step the number under the caret (or the first one) by `delta`, keeping its
 * unit and the text around it — the way a browser's style inspector does, and
 * the only sane way to adjust `12px 16px` without retyping it.
 */
export function nudge(value: string, caret: number, delta: number, signed: boolean): string | null {
  const re = /-?\d*\.?\d+/g;
  let hit: RegExpExecArray | null = null;
  let first: RegExpExecArray | null = null;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    first ??= m;
    if (caret >= m.index && caret <= m.index + m[0].length) {
      hit = m;
      break;
    }
  }
  const m = hit ?? first;
  if (!m) return null;
  const places = Math.max(decimals(m[0]), decimals(String(Math.abs(delta))));
  let next = parseFloat(m[0]) + delta;
  if (!signed && next < 0) next = 0;
  const text = next.toFixed(places).replace(/^-0(\.0+)?$/, '0');
  return value.slice(0, m.index) + text + value.slice(m.index + m[0].length);
}

interface TextProps {
  value: string;
  onCommit: (v: string | undefined) => void;
  placeholder?: string;
  /** Empty means "unset" rather than "not finished typing" */
  optional?: boolean;
  mono?: boolean;
  /** Arrow keys step the number under the caret */
  step?: number;
  signed?: boolean;
  maxLength?: number;
  className?: string;
  ariaLabel?: string;
  /** Reject a value outright (it stays in the box, uncommitted, marked) */
  validate?: (v: string) => boolean;
}

/**
 * A text box that commits as you type, but only values that can stand: an
 * empty required field or a rejected value stays in the box, marked, until it
 * is fixed — and snaps back to the real value on blur. Without that split,
 * clearing a field to retype it would flash the preview through a broken
 * state on every keystroke.
 */
export function TextField({
  value,
  onCommit,
  placeholder,
  optional,
  mono,
  step,
  signed = false,
  maxLength = 240,
  className = '',
  ariaLabel,
  validate,
}: TextProps) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  // Follow outside changes (a slider, a reset) unless this box is mid-edit
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  const accept = (raw: string): boolean => {
    const v = cleanCss(raw).trim();
    if (!v) return !!optional;
    return validate ? validate(v) : true;
  };

  const push = (raw: string) => {
    setText(raw);
    if (!accept(raw)) return;
    const v = cleanCss(raw).trim();
    onCommit(v ? v : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
      return;
    }
    if (!step || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * k;
    const source = text || placeholder || '';
    const next = nudge(source, e.currentTarget.selectionStart ?? 0, delta, signed);
    if (next === null) return;
    e.preventDefault();
    const caret = e.currentTarget.selectionStart;
    push(next);
    const input = e.currentTarget;
    requestAnimationFrame(() => input.setSelectionRange(caret, caret));
  };

  return (
    <input
      className={`st-input ${mono ? 'mono' : ''} ${accept(text) ? '' : 'bad'} ${className}`}
      value={text}
      placeholder={placeholder}
      maxLength={maxLength}
      spellCheck={false}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(value);
      }}
      onChange={(e) => push(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/* ---------------- Colour ---------------- */

/** A swatch that opens the picker (see ColorPicker.tsx), beside the value as
 *  text for anything the picker cannot say (`inherit`) */
export function ColorField({
  value,
  onCommit,
  optional,
  placeholder,
}: {
  value: string | undefined;
  onCommit: (v: string | undefined) => void;
  optional?: boolean;
  placeholder?: string;
}) {
  const swatches = useContext(SwatchContext);
  const [open, setOpen] = useState(false);
  // The picker is a floating panel like any other, so it leaves like one
  const presence = usePresence(open, EXIT_POPOVER);
  const swatch = useRef<HTMLButtonElement>(null);
  const concrete = parseColor(value) !== null;
  return (
    <div className="st-color">
      <Tooltip content={concrete || !value ? '取色' : '这个值不是具体颜色，取色会换掉它'} side="left">
        <button
          ref={swatch}
          type="button"
          className={`st-swatch st-checker ${open ? 'open' : ''}`}
          aria-label="取色"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span style={{ background: value || placeholder || 'transparent' }} />
        </button>
      </Tooltip>
      {presence.mounted && swatch.current && (
        <ColorPicker
          anchor={swatch.current}
          state={presence.state}
          value={value || placeholder || ''}
          swatches={swatches}
          onChange={onCommit}
          onClose={() => setOpen(false)}
        />
      )}
      <TextField
        value={value ?? ''}
        onCommit={onCommit}
        optional={optional}
        placeholder={placeholder}
        mono
        validate={(v) => v === 'inherit' || v === 'currentColor' || parseColor(v) !== null}
      />
    </div>
  );
}

/* ---------------- Sizes ---------------- */

function parseSize(v: string | undefined, unit: string): number | null {
  if (!v) return null;
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(v.trim());
  if (!m || m[2] !== unit) return null;
  return parseFloat(m[1]);
}

const fmt = (n: number, unit: string) => `${Math.round(n * 1000) / 1000}${unit}`;

/** A slider for the common case, the text box for everything the slider
 *  cannot say (a value in another unit keeps just the text box) */
export function SizeField({
  value,
  spec,
  onCommit,
  optional,
  placeholder,
}: {
  value: string | undefined;
  spec: SizeSpec;
  onCommit: (v: string | undefined) => void;
  optional?: boolean;
  placeholder?: string;
}) {
  const n = parseSize(value, spec.unit) ?? (value ? null : parseSize(placeholder, spec.unit));
  return (
    <div className="st-size">
      {n !== null && (
        <Slider
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={Math.min(spec.max, Math.max(spec.min, n))}
          unit={spec.unit}
          onChange={(v) => onCommit(fmt(v, spec.unit))}
        />
      )}
      <TextField
        className={n !== null ? 'st-num' : ''}
        value={value ?? ''}
        onCommit={onCommit}
        optional={optional}
        placeholder={placeholder}
        mono
        step={spec.step}
        signed={spec.min < 0}
      />
    </div>
  );
}

/** Padding, margin, radius: one to four lengths, stepped with the arrow keys */
export function BoxField({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (v: string | undefined) => void;
}) {
  return (
    <TextField
      value={value ?? ''}
      onCommit={onCommit}
      mono
      step={1}
      validate={(v) => /^(-?\d*\.?\d+[a-z%]*|auto)(\s+(-?\d*\.?\d+[a-z%]*|auto)){0,3}$/.test(v)}
    />
  );
}

/* ---------------- Borders ---------------- */

const BORDER_STYLES: Option[] = [
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' },
  { value: 'double', label: '双线' },
  { value: 'none', label: '无' },
];

interface Border {
  width: number;
  style: string;
  color: string;
}

function parseBorder(v: string | undefined): Border | null {
  const s = (v ?? '').trim();
  if (!s || s === 'none') return { width: 0, style: 'none', color: '' };
  const parts = s.match(/(rgba?|hsla?)\([^)]*\)|\S+/g) ?? [];
  let width: number | null = null;
  let style: string | null = null;
  const rest: string[] = [];
  for (const p of parts) {
    if (/^\d*\.?\d+px$/.test(p) && width === null) width = parseFloat(p);
    else if (BORDER_STYLES.some((o) => o.value === p) && style === null) style = p;
    else rest.push(p);
  }
  if (rest.length > 1) return null;
  return { width: width ?? 1, style: style ?? 'solid', color: rest[0] ?? 'currentColor' };
}

/** `4px solid #d97757`, taken apart into the three things anyone changes */
export function BorderField({
  value,
  onCommit,
  optional,
  defaultColor,
}: {
  value: string | undefined;
  onCommit: (v: string | undefined) => void;
  optional?: boolean;
  /** What a border switched on from `none` is drawn in */
  defaultColor: string;
}) {
  const b = parseBorder(value);
  if (!b) {
    return <TextField value={value ?? ''} onCommit={onCommit} optional={optional} mono />;
  }
  const off = b.style === 'none' || b.width <= 0;
  const emit = (next: Border) => {
    if (next.style === 'none' || next.width <= 0) {
      onCommit(optional ? undefined : 'none');
      return;
    }
    onCommit(`${fmt(next.width, 'px')} ${next.style} ${next.color || defaultColor}`);
  };
  const width = off ? 0 : b.width;
  /** One press, one arrow key or one wheel notch, all the same move */
  const step = (d: number) => {
    const next = Math.max(0, width + d);
    emit({ ...b, style: d > 0 && off ? 'solid' : b.style, width: next });
  };
  return (
    <div className="st-border">
      <div className="st-stepper" role="group" aria-label="粗细">
        <button type="button" onClick={() => step(-1)} aria-label="细一点">
          <Minus size={10} weight="bold" />
        </button>
        {/* The number itself is the control, not just a readout: ↑↓ and the
            wheel are how anyone who has used a style inspector expects to
            change a border width, and reaching for one of two 18px buttons
            with the mouse is the slowest way to say "one more pixel" */}
        <span
          className="st-stepper-value"
          role="spinbutton"
          tabIndex={0}
          aria-label="粗细"
          aria-valuenow={width}
          aria-valuemin={0}
          aria-valuetext={`${width}px`}
          onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => {
            const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            step(d * (e.shiftKey ? 10 : 1));
          }}
          onWheel={(e: WheelEvent<HTMLSpanElement>) => {
            // Only while it has focus: a wheel over a field list is someone
            // scrolling the list, not editing the value under the pointer
            if (document.activeElement !== e.currentTarget) return;
            const d = e.deltaY < 0 ? 1 : -1;
            step(d * (e.shiftKey ? 10 : 1));
          }}
        >
          {width}px
        </span>
        <button type="button" onClick={() => step(1)} aria-label="粗一点">
          <Plus size={10} weight="bold" />
        </button>
      </div>
      <Select
        value={off ? 'none' : b.style}
        options={BORDER_STYLES}
        ariaLabel="线型"
        onChange={(v) => emit({ ...b, style: v, width: Math.max(1, width) })}
      />
      {!off && (
        <ColorField value={b.color} onCommit={(c) => c && emit({ ...b, color: c })} />
      )}
    </div>
  );
}

/* ---------------- Fonts ---------------- */

export function FontField({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (v: string | undefined) => void;
}) {
  const known = FONTS.find((f) => f.value === value);
  const [custom, setCustom] = useState(!known);
  useEffect(() => {
    if (!FONTS.some((f) => f.value === value)) setCustom(true);
  }, [value]);
  return (
    <div className="st-font">
      <Select
        value={custom ? '' : (known?.value ?? '')}
        // Each name set in the face it names — the one thing a font menu is for
        options={[...FONTS.map((f) => ({ ...f, font: f.value })), { value: '', label: '自定义字体栈…' }]}
        triggerStyle={{ fontFamily: value }}
        ariaLabel="字体"
        onChange={(v) => {
          if (!v) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onCommit(v);
        }}
      />
      {custom && (
        <TextField
          value={value ?? ''}
          onCommit={onCommit}
          mono
          placeholder="Georgia, 'Songti SC', serif"
          ariaLabel="字体栈"
        />
      )}
    </div>
  );
}

/* ---------------- Glyphs and choices ---------------- */

export function GlyphField({
  value,
  presets,
  onCommit,
  optional,
  placeholder,
}: {
  value: string | undefined;
  presets: string[];
  onCommit: (v: string | undefined) => void;
  optional?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="st-glyph">
      <TextField
        className="st-glyph-input"
        value={value ?? ''}
        onCommit={onCommit}
        optional={optional}
        placeholder={placeholder}
        maxLength={8}
      />
      <div className="st-chips" role="radiogroup">
        {presets.map((g) => (
          <button
            key={g}
            type="button"
            role="radio"
            aria-checked={value === g}
            className="st-chip glyph"
            onClick={() => onCommit(g)}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChoiceField({
  value,
  options,
  onCommit,
}: {
  value: string;
  options: Option[];
  onCommit: (v: string) => void;
}) {
  return (
    <div className="st-chips" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className="st-chip"
          onClick={() => onCommit(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onCommit, label }: { on: boolean; onCommit: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch-row st-toggle"
      onClick={() => onCommit(!on)}
    >
      <span className="switch" aria-hidden="true" />
    </button>
  );
}

/* ---------------- Free CSS ---------------- */

const propOk = (k: string) => /^[a-z-]{2,40}$/.test(k);

interface Row {
  k: string;
  v: string;
  /** Stable React key: the property name is the thing being edited */
  id: number;
}

let rowSeq = 0;
const rowsOf = (map: Record<string, string> | undefined): Row[] =>
  Object.entries(map ?? {}).map(([k, v]) => ({ k, v, id: ++rowSeq }));
const mapOf = (rows: Row[]) => {
  const out: Record<string, string> = {};
  for (const r of rows) if (propOk(r.k) && r.v.trim()) out[r.k] = cleanCss(r.v).trim();
  return out;
};
const sameMap = (a: Record<string, string> | undefined, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * The escape hatch: any CSS declaration the fields above do not name, on the
 * four elements whose renderer passes `extra` straight through. A row that is
 * half typed (no property yet, or no value) lives here without reaching the
 * theme until it is whole.
 */
export function ExtraEditor({
  value,
  onCommit,
}: {
  value: Record<string, string> | undefined;
  onCommit: (v: Record<string, string> | undefined) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(value));
  // An outside change (a reset) replaces the rows; our own commits come back
  // equal to what the rows already say, and leave the half-typed ones alone
  useEffect(() => {
    setRows((cur) => (sameMap(value, mapOf(cur)) ? cur : rowsOf(value)));
  }, [value]);

  const update = (next: Row[]) => {
    setRows(next);
    const map = mapOf(next);
    if (!sameMap(value, map)) onCommit(Object.keys(map).length ? map : undefined);
  };

  return (
    <div className="st-extra">
      {rows.map((r) => (
        <div key={r.id} className="st-extra-row">
          <input
            className={`st-input mono ${r.k && !propOk(r.k) ? 'bad' : ''}`}
            value={r.k}
            placeholder="box-shadow"
            spellCheck={false}
            aria-label="CSS 属性"
            onChange={(e) =>
              update(rows.map((x) => (x.id === r.id ? { ...x, k: e.target.value.trim().toLowerCase() } : x)))
            }
          />
          <input
            className="st-input mono"
            value={r.v}
            placeholder="0 2px 8px rgba(0,0,0,.1)"
            spellCheck={false}
            aria-label="值"
            onChange={(e) => update(rows.map((x) => (x.id === r.id ? { ...x, v: e.target.value } : x)))}
          />
          <Tooltip content="删掉这一条" side="left">
            <button
              type="button"
              className="ghost-btn"
              aria-label={`删掉 ${r.k || '这一条'}`}
              onClick={() => update(rows.filter((x) => x.id !== r.id))}
            >
              <X size={11} weight="bold" />
            </button>
          </Tooltip>
        </div>
      ))}
      <button
        type="button"
        className="st-extra-add"
        onClick={() => setRows([...rows, { k: '', v: '', id: ++rowSeq }])}
      >
        <Plus size={11} weight="bold" />
        加一条 CSS
      </button>
    </div>
  );
}
