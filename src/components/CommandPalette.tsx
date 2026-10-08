import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { EXIT_POPOVER, usePresence } from '../usePresence';

export interface PaletteItem {
  id: string;
  /** Heading this row files under — 草稿 / 动作 / 主题 / 密度 / 机型 */
  section: string;
  name: string;
  /** Where a draft lives, shown dimmed at the right and searched along with the name */
  path?: string;
  /** An action's keyboard shortcut, shown at the right in mono */
  hint?: string;
  /** This is the one currently in force (theme, density, device) */
  checked?: boolean;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  placeholder: string;
}

/** Plain case-insensitive substring. Pinyin initials would be the next step;
 *  they are not worth a dependency until someone asks for them */
function matches(item: PaletteItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.name.toLowerCase().includes(q) || (item.path ?? '').toLowerCase().includes(q);
}

/**
 * ⌘K: everything the window can do, reachable by typing part of its name.
 *
 * It exists because the toolbar can only hold so many buttons before it stops
 * being readable, and the answer to that is not a smaller font — it is a place
 * where the rarely-used things live without taking any room. ⌘P opens the same
 * component filtered down to drafts, which is the one list big enough to be
 * worth searching by itself.
 *
 * Drops from 18% down the window rather than sitting dead centre: the list
 * grows downwards, and a box that grows in both directions makes the row under
 * the cursor move while you read it.
 */
export default function CommandPalette({ open, onClose, items, placeholder }: Props) {
  const { mounted, state } = usePresence(open, EXIT_POPOVER);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => items.filter((i) => matches(i, query)), [items, query]);

  // A fresh visit starts empty, at the top: the palette is for going somewhere,
  // and last time's search is never where you are going now
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Esc at the window, not just in the field: clicking a row's scrollbar or
  // the backdrop takes focus out of the input, and an overlay you cannot
  // dismiss from the keyboard is a trap
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Keep the selected row on screen while arrowing through a long list
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, shown]);

  if (!mounted) return null;

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      // Wrapping, because a list you can run off the end of makes you look
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((i) => (i + step + shown.length) % shown.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pick(shown[index]);
      return;
    }
  };

  let lastSection = '';

  return (
    <div className="palette-backdrop" data-state={state} onMouseDown={onClose}>
      <div
        className="popover palette"
        data-state={state}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list scroll-thin" id="palette-list" role="listbox" ref={listRef}>
          {shown.length === 0 && <p className="palette-empty">没有匹配的条目</p>}
          {shown.map((item, i) => {
            // Headings come from the run of rows under them, so filtering can
            // never leave a heading with nothing beneath it
            const heading = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            return (
              <div key={item.id}>
                {heading && <div className="eyebrow palette-section">{heading}</div>}
                <button
                  className="menu-item palette-row"
                  role="option"
                  aria-selected={i === index}
                  // Pointer and keyboard drive the same selection, so moving
                  // the mouse never leaves two rows looking active
                  onMouseMove={() => setIndex(i)}
                  onClick={() => pick(item)}
                >
                  {item.checked && <Check size={14} weight="regular" className="menu-icon" />}
                  <span className="palette-name">{item.name}</span>
                  {item.path && <span className="palette-path">{item.path}</span>}
                  {item.hint && <span className="palette-key">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd> 选择
          </span>
          <span>
            <kbd>↩</kbd> 执行
          </span>
          <span>
            <kbd>esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
}
