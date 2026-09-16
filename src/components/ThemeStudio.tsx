import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowCounterClockwise, CaretRight, MagnifyingGlass, PaintBrush, X } from '@phosphor-icons/react';
import { PALETTE_DARK, PALETTE_LIGHT, getTheme, themes as PRESETS, type Theme } from '../theme';
import { saveCustomTheme } from '../store/customThemes';
import { confirmDestructive } from '../confirm';
import {
  PALETTE_LABELS,
  SECTIONS,
  getAt,
  setAt,
  stableKey,
  type Field,
  type Section,
  type SectionId,
} from '../themeFields';
import {
  BorderField,
  BoxField,
  ChoiceField,
  ColorField,
  ExtraEditor,
  FontField,
  GlyphField,
  SizeField,
  SwatchContext,
  Toggle,
} from './StudioControls';
import { collectColors } from './ColorPicker';
import EmptyState from './EmptyState';
import Select from './Select';
import Tooltip from './Tooltip';
import Spinner from './Spinner';

interface Props {
  /** Where editing starts. A preset is copied into a new theme; a custom
   *  theme is edited in place */
  from: Theme;
  /** Every theme the start-point menu offers (presets first, then custom) */
  choices: Theme[];
  /** A click in the preview asking for one section. A new object each time,
   *  so clicking the same element twice still scrolls back to it */
  pick: { section: SectionId; at: number } | null;
  /** The draft, on every change — the preview draws with it */
  onDraft: (th: Theme) => void;
  onSaved: (th: Theme) => void;
  /** Start over from another theme (the parent remounts the studio) */
  onRestart: (th: Theme) => void;
  onClose: () => void;
  onFlash: (msg: string) => void;
}

type Path = readonly string[];

const isPreset = (id: string) => PRESETS.some((t) => t.id === id);
const newId = () => `my-${Date.now().toString(36)}`;

/** A preset is the floor everything else stands on, so it is never edited:
 *  starting from one means a copy under a fresh id */
function start(from: Theme): { draft: Theme; editing: string | null } {
  if (!isPreset(from.id)) return { draft: from, editing: from.id };
  return {
    draft: {
      ...from,
      id: newId(),
      base: from.id,
      name: `${from.name}·改`.slice(0, 24),
      description: `在「${from.name}」上自己调的`,
    },
    editing: null,
  };
}

/**
 * Two representations of the same setting count as the same: an optional
 * switch that is off may be `false` or absent, and an unset choice *is* its
 * fallback. Otherwise flipping a switch back would still read as a change.
 */
const norm = (f: Field) => (v: unknown) => {
  if (f.control.kind === 'bool') return !!v;
  if (f.control.kind === 'choice' && v === undefined) return f.fallback;
  return v;
};

/** How long a section takes to roll open or shut */
const SECTION_MS = 200;

/**
 * One section's field list, rolling rather than appearing.
 *
 * Fifteen headings that swap instantly between "nothing" and "eleven rows"
 * make the list under the pointer jump by a few hundred pixels, and after two
 * or three of those nobody knows where they are in the panel any more.
 *
 * `grid-template-rows: 0fr → 1fr` is the way to transition to a height nobody
 * knows in advance: the row track resolves to the content's own height, and
 * unlike a max-height guess it is exact, so the motion has no dead tail and no
 * clipped last row.
 *
 * Two things this is careful about, both of them performance:
 * - closed sections render nothing at all. A hundred and one fields with a
 *   colour picker apiece, mounted and merely hidden, is what would make
 *   dragging a slider stutter.
 * - `render` is a function rather than children, so building a section's rows
 *   is skipped entirely while it is closed. The last result is held through
 *   the closing animation — there has to be something to roll up.
 */
function StudioSection({ open, render }: { open: boolean; render: () => ReactNode }) {
  const [mounted, setMounted] = useState(open);
  /** Separate from `open` by one frame: grid-template-rows needs a 0fr to
   *  travel from, and an element that mounts already at 1fr has none */
  const [tall, setTall] = useState(false);
  const last = useRef<ReactNode>(null);
  if (open) last.current = render();

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames, not one. `requestAnimationFrame` runs *before* the paint of
      // the frame it is scheduled in, so a single one flips to 1fr in the same
      // frame the element was inserted at 0fr — the browser never paints the
      // closed state, the transition has no start value, and the section
      // simply appears. The second frame is the one that guarantees a paint
      // has happened in between.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setTall(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setTall(false);
    const timer = window.setTimeout(() => setMounted(false), SECTION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={`st-sec-slide ${tall ? 'open' : ''}`}>
      <div className="st-sec-clip">{last.current}</div>
    </div>
  );
}

/**
 * The theme studio: every value a theme holds, set by hand.
 *
 * It sits beside the preview rather than in a dialog because the preview *is*
 * its output. Nothing here renders a sample of its own; each control writes
 * the draft, the draft goes up through onDraft, and the article beside it
 * redraws. So what you tune against is your own article, in the device you
 * picked, at the density you picked.
 *
 * Changes are marked against the theme as it was opened (or last saved), not
 * against the preset underneath: the question while tuning is "what have I
 * touched", and the dot and the undo arrow on each row answer exactly that.
 *
 * Saving writes the same file the agent writes (see themeFile), so a theme
 * started here can be finished by the agent, and the other way round.
 */
export default function ThemeStudio({
  from,
  choices,
  pick,
  onDraft,
  onSaved,
  onRestart,
  onClose,
  onFlash,
}: Props) {
  const [init] = useState(() => start(from));
  const [draft, setDraft] = useState(init.draft);
  const [origin, setOrigin] = useState(init.draft);
  /** Id of the custom theme being edited; null until a new one is first saved */
  const [editing, setEditing] = useState(init.editing);
  const [open, setOpen] = useState<Set<SectionId>>(() => new Set(['global']));
  const [query, setQuery] = useState('');
  /** A section to bring into view once it has been rendered open */
  const [jump, setJump] = useState<{ id: SectionId; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const secRefs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onDraft(draft);
  }, [draft, onDraft]);

  // A click in the preview: open that section (and clear a search that might
  // be hiding it) — all in one render, so the jump below sees it open
  useEffect(() => {
    if (!pick) return;
    setQuery('');
    // Only the picked one. With fifteen sections, keeping every section
    // picked earlier open buries the one just asked for
    setOpen(new Set([pick.section]));
    setJump({ id: pick.section, at: pick.at });
  }, [pick]);

  /**
   * Then bring it to the top of the field list, and flash it so the eye lands
   * on the right block among fifteen.
   *
   * A layout effect, so the section is measured already open, and a scrollTo
   * on the list itself rather than scrollIntoView: WebKit — the macOS
   * window — quietly skipped a smooth scrollIntoView on a block that had just
   * been opened, and scrollIntoView also scrolls every ancestor it can,
   * panel shell included, which is never what is wanted here.
   *
   * Instant, not smooth: a smooth scroll was seen to sit still for most of a
   * second before moving, which reads exactly like "nothing happened". The
   * flash is what tells the eye where it landed.
   *
   * The flash is a class toggled on the element directly, so picking the same
   * section twice in a row flashes it again — and taken off again when the
   * next pick comes, or it would linger on every section picked before.
   */
  useLayoutEffect(() => {
    if (!jump) return;
    const el = secRefs.current[jump.id];
    const list = scrollRef.current;
    if (!el || !list) return;
    const pin = () => {
      const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 6;
      list.scrollTo({ top: Math.max(0, top) });
    };
    pin();
    /*
     * And keep it pinned while the sections settle.
     *
     * The picked section opens and the one that was open rolls shut, both over
     * SECTION_MS — so the offset measured in this commit is stale by the time
     * the animation ends, and the section would drift away from the top edge
     * it was just brought to. Re-pinning every frame for the duration holds it
     * exactly where it landed; because it never moves, the settling is
     * invisible rather than a second jump.
     */
    let raf = 0;
    const until = performance.now() + SECTION_MS + 40;
    const hold = () => {
      pin();
      if (performance.now() < until) raf = requestAnimationFrame(hold);
    };
    raf = requestAnimationFrame(hold);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    const fade = window.setTimeout(() => el.classList.remove('flash'), 1300);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(fade);
      el.classList.remove('flash');
    };
  }, [jump]);

  const dirty = useMemo(() => stableKey(draft) !== stableKey(origin), [draft, origin]);

  /** The palette the pickers offer: the colours this theme already uses.
   *  The code palette is left out — thirty syntax colours would drown the
   *  handful that make up the page */
  const themeColors = useMemo(() => {
    const { codePalette: _skip, ...rest } = draft;
    void _skip;
    return collectColors(rest);
  }, [draft]);

  const set = (path: Path, value: unknown) => setDraft((d) => setAt(d, path, value));

  /**
   * Everything that differs from the theme as it was opened, worked out once.
   *
   * This used to be three functions called during render — one per row for the
   * dot and the undo arrow, one per section for the count — and each of them
   * ran `stableKey`, which is a recursive JSON.stringify. Over a hundred and
   * one fields and thirty palette colours that is several hundred
   * serialisations of a whole subtree on *every render of the panel*, which is
   * every frame of dragging a colour. Now it is one pass, and only when the
   * draft or the baseline actually changes.
   *
   * One set of dotted paths, so the extra-CSS rows and the palette colours can
   * ask the same question the ordinary fields do.
   */
  const changed = useMemo(() => {
    const paths = new Set<string>();
    const counts = new Map<SectionId, number>();
    for (const s of SECTIONS) {
      let n = 0;
      for (const f of s.fields) {
        const nm = norm(f);
        if (stableKey(nm(getAt(draft, f.path))) !== stableKey(nm(getAt(origin, f.path)))) {
          paths.add(f.path.join('.'));
          n += 1;
        }
      }
      if (s.extra && stableKey(getAt(draft, [s.id, 'extra'])) !== stableKey(getAt(origin, [s.id, 'extra']))) {
        paths.add(`${s.id}.extra`);
        n += 1;
      }
      if (s.id === 'palette') {
        for (const k of Object.keys(draft.codePalette)) {
          if (draft.codePalette[k] !== origin.codePalette[k]) {
            paths.add(`codePalette.${k}`);
            n += 1;
          }
        }
      }
      counts.set(s.id, n);
    }
    return { paths, counts };
  }, [draft, origin]);

  const fieldChanged = (f: Field) => changed.paths.has(f.path.join('.'));

  /** Landing back on the opened value restores its exact form, so that
   *  wandering off and returning leaves nothing marked as changed */
  const commit = (f: Field, value: unknown) => {
    const n = norm(f);
    const was = getAt(origin, f.path);
    set(f.path, stableKey(n(value)) === stableKey(n(was)) ? was : value);
  };

  const pathChanged = (path: Path) => changed.paths.has(path.join('.'));

  const changesIn = (s: Section) => changed.counts.get(s.id) ?? 0;

  /* ---------- Search ---------- */

  const q = query.trim().toLowerCase();
  const matches = (s: Section, label: string, key: string) =>
    !q || s.title.includes(q) || label.toLowerCase().includes(q) || key.toLowerCase().includes(q);
  const fieldsOf = (s: Section) =>
    s.fields.filter((f) => (!f.when || f.when(draft)) && matches(s, f.label, f.path.join('.')));
  const paletteKeys = Object.keys(draft.codePalette).filter((k) =>
    matches(SECTIONS.find((s) => s.id === 'palette')!, PALETTE_LABELS[k] ?? k, k),
  );

  /* ---------- Lifecycle ---------- */

  const save = async (asCopy: boolean) => {
    const name = draft.name.trim();
    if (!name) {
      onFlash('先给主题起个名字');
      return;
    }
    const th: Theme = {
      ...draft,
      id: asCopy || !editing ? newId() : editing,
      name: asCopy ? `${name}·副本`.slice(0, 24) : name,
      description: draft.description.trim() || '我自己调的主题',
    };
    setSaving(true);
    try {
      const saved = await saveCustomTheme(th);
      // parseTheme is the door the file comes back in through; anything it
      // turned away is a value the user saw in the preview and will not get
      const lost = stableKey(saved) !== stableKey(th);
      setDraft(saved);
      setOrigin(saved);
      setEditing(saved.id);
      onSaved(saved);
      onFlash(lost ? `已存「${saved.name}」，有几项值不合法没存进去` : `已存「${saved.name}」`);
    } catch (err) {
      onFlash(typeof err === 'string' ? err : err instanceof Error ? err.message : '存不了主题');
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirmDestructive('还有没存的修改，关掉就没了。', '不存了'))) return;
    onClose();
  };

  /**
   * Esc closes the panel.
   *
   * Not in capture: the colour picker, the search box and any popover inside
   * get first refusal and stop the event when they have something of their own
   * to dismiss. Only an Esc nobody wanted reaches here, which is the one that
   * means "I am done with this panel".
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      void close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // `close` closes over `dirty`, which changes on every edit; re-binding a
    // listener that often is cheaper than a ref indirection here
  });

  const restart = async (id: string) => {
    const target = choices.find((t) => t.id === id) ?? getTheme(id);
    if (dirty && !(await confirmDestructive('换一个起点，现在没存的修改就没了。', '换'))) return;
    onRestart(target);
  };

  /* ---------- Rendering ---------- */

  const control = (f: Field) => {
    const v = getAt(draft, f.path);
    const c = f.control;
    const put = (x: unknown) => commit(f, x);
    switch (c.kind) {
      case 'color':
        return <ColorField value={v as string | undefined} onCommit={put} optional={f.optional} placeholder={f.fallback} />;
      case 'size':
        return (
          <SizeField value={v as string | undefined} spec={c} onCommit={put} optional={f.optional} placeholder={f.fallback} />
        );
      case 'box':
        return <BoxField value={v as string | undefined} onCommit={put} />;
      case 'border':
        return (
          <BorderField value={v as string | undefined} onCommit={put} optional={f.optional} defaultColor={draft.accent} />
        );
      case 'font':
        return <FontField value={v as string | undefined} onCommit={put} />;
      case 'glyph':
        return (
          <GlyphField
            value={v as string | undefined}
            presets={c.presets}
            onCommit={put}
            optional={f.optional}
            placeholder={f.fallback}
          />
        );
      case 'choice':
        return <ChoiceField value={(v as string | undefined) ?? f.fallback ?? ''} options={c.options} onCommit={put} />;
      case 'bool':
        return <Toggle on={!!v} label={f.label} onCommit={(on) => put(on ? true : f.optional ? undefined : false)} />;
    }
  };

  const row = (key: string, label: string, changed: boolean, onReset: () => void, body: React.ReactNode, hint?: string, wide = false) => (
    <div key={key} className={`st-field ${changed ? 'changed' : ''} ${wide ? 'wide' : ''}`}>
      <div className="st-label">
        <span>{label}</span>
        {changed && (
          <button type="button" className="st-reset" title="改回打开时的样子" aria-label={`还原${label}`} onClick={onReset}>
            <ArrowCounterClockwise size={10} weight="bold" />
          </button>
        )}
      </div>
      <div className="st-control">{body}</div>
      {hint && <p className="st-field-hint">{hint}</p>}
    </div>
  );

  const sectionBody = (s: Section, fields: Field[]) => (
    <div className="st-sec-body">
      {fields.map((f) =>
        row(f.path.join('.'), f.label, fieldChanged(f), () => set(f.path, getAt(origin, f.path)), control(f), f.hint),
      )}
      {s.id === 'palette' && (
        <>
          <div className="st-palette-actions">
            <button
              type="button"
              className="st-chip"
              onClick={() => setDraft((d) => ({ ...d, codePalette: { ...PALETTE_LIGHT }, codePaletteMode: 'light' }))}
            >
              整套换成浅底配色
            </button>
            <button
              type="button"
              className="st-chip"
              onClick={() => setDraft((d) => ({ ...d, codePalette: { ...PALETTE_DARK }, codePaletteMode: 'dark' }))}
            >
              整套换成深底配色
            </button>
          </div>
          {paletteKeys.map((k) => {
            const path = ['codePalette', k];
            return row(
              k,
              PALETTE_LABELS[k] ?? k.replace(/^hljs-/, ''),
              pathChanged(path),
              () => set(path, getAt(origin, path)),
              <ColorField value={draft.codePalette[k]} onCommit={(c) => c && set(path, c)} />,
            );
          })}
        </>
      )}
      {s.extra &&
        matches(s, '额外 CSS', 'extra') &&
        row(
          'extra',
          '额外 CSS',
          pathChanged([s.id, 'extra']),
          () => set([s.id, 'extra'], getAt(origin, [s.id, 'extra'])),
          <ExtraEditor
            value={getAt(draft, [s.id, 'extra']) as Record<string, string> | undefined}
            onCommit={(m) => set([s.id, 'extra'], m)}
          />,
          '上面没列出来的属性都能加，比如 box-shadow、border-top。键用连字符写法',
          true,
        )}
    </div>
  );

  const visibleSections = SECTIONS.map((s) => ({ s, fields: fieldsOf(s) })).filter(
    ({ s, fields }) =>
      !q ||
      fields.length > 0 ||
      (s.id === 'palette' && paletteKeys.length > 0) ||
      (s.extra && matches(s, '额外 CSS', 'extra')),
  );

  // The start-point menu has to list the theme being edited even in the
  // moment between saving it and the watcher reading it back
  const customs = choices.filter((t) => !isPreset(t.id));
  if (editing && !customs.some((t) => t.id === editing)) customs.push(draft);
  const startValue = editing ?? draft.base ?? PRESETS[0].id;
  /** The two groups the native <optgroup>s used to draw, now data */
  const startOptions = [
    ...PRESETS.map((t) => ({ value: t.id, label: t.name, group: '内置（改完存成新主题）' })),
    ...customs.map((t) => ({ value: t.id, label: t.name, group: '我的（直接改）' })),
  ];

  return (
    <SwatchContext.Provider value={themeColors}>
    <aside className="studio-side" aria-label="主题工坊">
      <div className="pane-head">
        <span className="pane-title">
          <PaintBrush size={13} weight="fill" />
          主题工坊
        </span>
        <span className="st-mode">{editing ? (dirty ? '有改动未存' : '已存') : '新主题'}</span>
        <Tooltip content="关掉主题工坊" shortcut="Esc" side="left">
          <button className="ghost-btn st-close" onClick={() => void close()} aria-label="关掉主题工坊">
            <X size={14} weight="bold" />
          </button>
        </Tooltip>
      </div>

      <div className="st-top">
        <div className="st-row">
          <span className="st-row-label">起点</span>
          <Select
            value={startValue}
            options={startOptions}
            ariaLabel="从哪个主题开始改"
            onChange={(id) => void restart(id)}
          />
        </div>
        <div className="st-row">
          <span className="st-row-label">名字</span>
          <input
            className="st-input"
            value={draft.name}
            maxLength={24}
            placeholder="两到四个字最好看"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <div
            className="segmented st-appearance"
            role="radiogroup"
            aria-label="归到浅色还是深色"
            title="只决定它排在主题列表的哪一组，要和纸色的明暗一致"
            style={{ '--seg-n': 2, '--seg-i': draft.appearance === 'dark' ? 1 : 0 } as React.CSSProperties}
          >
            {(['light', 'dark'] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={draft.appearance === a}
                className={`seg-btn ${draft.appearance === a ? 'active' : ''}`}
                onClick={() => setDraft((d) => ({ ...d, appearance: a }))}
              >
                {a === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
        </div>
        <div className="st-row">
          <span className="st-row-label">描述</span>
          <input
            className="st-input"
            value={draft.description}
            maxLength={60}
            placeholder="一句话说清它的性格"
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
        <label className="st-search">
          <MagnifyingGlass size={12} weight="bold" />
          <input
            className="st-input"
            value={query}
            placeholder="找一项：行高、圆角、引用…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Clear the search first; a second Esc closes the panel
              if (e.key !== 'Escape' || !query) return;
              e.preventDefault();
              setQuery('');
            }}
          />
        </label>
        <p className="st-tip">点左边预览里的任何元素，直接跳到它的样式。输入框里按 ↑↓ 微调数字，⇧ 一次十步。</p>
      </div>

      <div className="st-scroll scroll-thin" ref={scrollRef}>
        {visibleSections.length === 0 && (
          <EmptyState
            icon={MagnifyingGlass}
            title={`没有叫「${query}」的样式项`}
            hint="试试「行高」「圆角」「引用」，或者点左边预览里的元素直接跳过去。"
            action={{ label: '清除搜索', onClick: () => setQuery('') }}
          />
        )}
        {visibleSections.map(({ s, fields }) => {
          const expanded = !!q || open.has(s.id);
          const n = changesIn(s);
          return (
            <section
              key={s.id}
              ref={(el) => {
                secRefs.current[s.id] = el;
              }}
              className={`st-sec ${expanded ? 'open' : ''}`}
            >
              <button
                type="button"
                className="st-sec-head"
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
              >
                <CaretRight size={10} weight="bold" className="st-caret" />
                <span className="st-sec-title">{s.title}</span>
                {s.hint && <span className="st-sec-sub">{s.hint}</span>}
                {n > 0 && (
                  <span className="st-sec-count" title={`这一组改了 ${n} 项`}>
                    {n}
                  </span>
                )}
              </button>
              <StudioSection open={expanded} render={() => sectionBody(s, fields)} />
            </section>
          );
        })}
      </div>

      <div className="st-foot">
        <button className="btn" disabled={!dirty} onClick={() => setDraft(origin)} title="所有改动退回打开时的样子">
          全部还原
        </button>
        <span className="grow" />
        {editing && (
          <button className="btn" disabled={saving} onClick={() => void save(true)} title="存成一个新主题，原来的不动">
            另存为
          </button>
        )}
        <button
          className={`btn primary ${saving ? 'busy' : ''}`}
          disabled={saving || (!!editing && !dirty)}
          aria-busy={saving}
          onClick={() => void save(false)}
        >
          {saving && <Spinner />}
          {editing ? '保存' : '存成我的主题'}
        </button>
      </div>
    </aside>
    </SwatchContext.Provider>
  );
}
