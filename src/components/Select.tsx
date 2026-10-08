import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CaretUpDown, Check } from '@phosphor-icons/react';
import { EXIT_POPOVER, usePresence } from '../usePresence';

export interface SelectOption {
  value: string;
  label: string;
  /** Draw the row (and the trigger, when chosen) in this face — the font menu */
  font?: string;
  /** Group heading this option belongs under. Consecutive options sharing one
   *  are drawn as a group, in the order given */
  group?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Inline style for the trigger — the font menu sets its own face on it */
  triggerStyle?: CSSProperties;
  className?: string;
}

/** Keep the list off the edges of the window */
const PAD = 8;
/** Never taller than this; past it the list scrolls */
const MAX_H = 320;

/**
 * A listbox, because the platform's is not ours to draw.
 *
 * `<select>` renders its popup in the compositor, outside the document: on
 * macOS it is an NSMenu in the system font with the system's own highlight
 * blue, on Windows a flat white Win32 list, on Linux whatever GTK decides.
 * Three appearances, none of them this one, in a panel whose whole job is
 * choosing how things look. It also cannot show a font in its own face, mark
 * the current value with anything but its own tick, or animate.
 *
 * What is kept from the native control is everything about its behaviour:
 * ↑↓ to move, Enter to take, Esc to leave, typing to jump, focus returning to
 * the trigger, and the list opening with the current value already under the
 * cursor.
 *
 * The list is portalled onto <body>: the studio's field list is a scroll
 * container and a backdrop-filtered panel, either of which would clip it.
 */
export default function Select({
  value,
  options,
  onChange,
  ariaLabel,
  triggerStyle,
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const { mounted, state } = usePresence(open, EXIT_POPOVER);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  /** Row under the keyboard cursor. Starts on the current value */
  const [active, setActive] = useState(0);
  /** Recent keystrokes, for jump-to-letter */
  const typed = useRef({ text: '', at: 0 });

  const current = options.find((o) => o.value === value);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setPos(null);
    setOpen(true);
  };

  const take = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Placed before paint, from the real measured height: below the trigger when
  // there is room, above it when there is not, and the width of the trigger so
  // the list reads as the field expanding rather than as a menu arriving
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!trigger || !list || !open) return;
    const place = () => {
      const r = trigger.getBoundingClientRect();
      const h = Math.min(list.scrollHeight, MAX_H);
      const below = r.bottom + 4;
      const top = below + h > window.innerHeight - PAD ? Math.max(PAD, r.top - 4 - h) : below;
      setPos({
        top,
        left: Math.max(PAD, Math.min(r.left, window.innerWidth - r.width - PAD)),
        width: Math.max(r.width, 132),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, mounted]);

  // Keep the cursor row visible while arrowing through a long list
  useEffect(() => {
    if (!open || !pos) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open, pos]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (listRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'Escape') {
      // Stopped here: the studio panel also listens for Esc, and one press
      // should close one thing
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const picked = options[active];
      if (picked) take(picked.value);
      return;
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) {
      e.preventDefault();
      setActive((i) => (i + step + options.length) % options.length);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    // Type-ahead. A second press of the same letter within the window extends
    // the search rather than cycling — "so" finds 宋体 where "s","o" would
    // have found two different things
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current = {
        text: (now - typed.current.at < 800 ? typed.current.text : '') + e.key.toLowerCase(),
        at: now,
      };
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`st-select ${open ? 'open' : ''} ${className}`}
        style={triggerStyle}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span className="st-select-value">{current?.label ?? ''}</span>
        <CaretUpDown size={11} weight="bold" className="st-select-caret" />
      </button>
      {mounted &&
        createPortal(
          <div
            ref={listRef}
            className="popover select-menu"
            data-state={state}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              // Off screen until measured, so nobody sees it at 0,0 first
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: pos?.width,
              visibility: pos ? undefined : 'hidden',
            }}
            onKeyDown={onKey}
          >
            {options.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={o.value || `blank-${i}`}>
                  {head && <div className="eyebrow select-group">{head}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    data-active={i === active}
                    className="menu-item select-item"
                    style={o.font ? { fontFamily: o.font } : undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => take(o.value)}
                  >
                    <span className="select-item-label">{o.label}</span>
                    <Check size={12} weight="bold" className="menu-check" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
