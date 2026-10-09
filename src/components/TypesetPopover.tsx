import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Eyedropper, PencilSimple, SlidersHorizontal, Sparkle, Trash } from '@phosphor-icons/react';
import { DENSITIES, darkThemes, lightThemes, punkThemes, gzhThemes, type Theme } from '../theme';
import { componentMarkup, isGzhTheme, themeComponents } from '../gzhTheme';
import { sampleHtmlFor } from '../themeSample';
import type { Appearance } from '../store/appearance';
import { useEditorPrefs } from '../store/editorPrefs';
import Tooltip from './Tooltip';

interface Props {
  themeId: string;
  onThemeChange: (id: string) => void;
  onInsertComponent: (html: string) => void;
  /** Themes the agent wrote, read off disk (see store/customThemes.ts) */
  customThemes: Theme[];
  onDeleteTheme: (id: string) => void;
  /** Hand the agent panel a half-written request for a new theme */
  onAskAgent: () => void;
  /** Open the theme studio — on one of your own themes, or (no id) starting
   *  from whichever theme is in use */
  onOpenStudio: (id?: string) => void;
  /** Read a theme off a published article (see themeSniff.ts) */
  onSniffTheme: () => void;
  /** Density preset id (see DENSITIES in theme.ts) */
  densityId: string;
  onDensityChange: (id: string) => void;
  /** Turn links into footnotes — affects the preview and every export
   *  (see RenderOptions in markdown.ts) */
  linkFootnotes: boolean;
  onLinkFootnotes: (on: boolean) => void;
  /** Light/dark of the app shell itself — not part of the draft */
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  /** Enter / exit, from the toolbar's presence hook — see usePresence.ts */
  state: 'enter' | 'exit';
}

/**
 * ←→ inside a radiogroup.
 *
 * A group of radios is one tab stop by convention, with the arrows moving
 * between them — which the segmented controls here look exactly like and did
 * not behave like. Returns the id to move to, or null if the key was not an
 * arrow.
 */
function arrowPick<T extends { id: string }>(
  e: React.KeyboardEvent,
  options: readonly T[],
  current: number,
): T | null {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return null;
  e.preventDefault();
  return options[(current + step + options.length) % options.length];
}

/**
 * Fit the miniature to the card it is printed on.
 *
 * Each thumb lays its article out at `--thumb-page` (a real article width) and
 * then scales it down, so the only scale that shows the whole page and no more
 * is `cardInnerWidth / pageWidth`. That number cannot be written in CSS —
 * `calc()` will not divide two lengths into the unitless value `scale()` takes
 * — and every hard-coded guess was wrong: the popover's own scrollbar eats
 * 10px of the grid, which at four across is ~2.5px per card, which is exactly
 * how much of every sample was running off the right edge.
 *
 * So measure. One observer on the list, watching the first thumb: the four
 * grids share a width, so one card's width is every card's width.
 *
 * Returns the ref to hang on the element that owns `--thumb-scale`.
 */
function useThumbScale() {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const thumb = list.querySelector<HTMLElement>('.theme-thumb');
    if (!thumb) return;

    // The page width lives in CSS, so it stays in one place
    const page = parseFloat(getComputedStyle(list).getPropertyValue('--thumb-page')) || 360;

    const fit = (w: number) => {
      if (w > 0) list.style.setProperty('--thumb-scale', String(w / page));
    };

    // Before the first paint. `offsetWidth` rather than getBoundingClientRect:
    // the popover opens on a `scale(.96)` pop-in, and a rect read mid-animation
    // is the animated rect — which would bake the first frame of the animation
    // into the scale and leave every card 4% short for the rest of its life.
    fit(thumb.offsetWidth);

    const ro = new ResizeObserver(([entry]) => {
      // ResizeObserver reports layout sizes, unrounded and untouched by the
      // pop-in transform, so this corrects the rounding in offsetWidth too.
      const box = entry.borderBoxSize?.[0];
      fit(box ? box.inlineSize : (entry.target as HTMLElement).offsetWidth);
    });
    ro.observe(thumb);
    return () => ro.disconnect();
  }, []);

  return ref;
}

const APPEARANCES: { id: Appearance; name: string }[] = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
];

/** The line-number column in the source pane. Off by default — see
 *  store/editorPrefs.ts */
const LINE_NUMBERS = [
  { id: 'off', name: '隐藏' },
  { id: 'on', name: '显示' },
] as const;

/**
 * Everything about how things look, in one popover.
 *
 * Each theme card is a real article rendered with that theme and scaled down
 * (see themeSample.ts) — its paper, its heading decoration, its quote, its
 * list, at its own leading. That beats a list of names, and it beats the
 * hand-drawn swatch it replaces: a swatch could only show the things that are
 * easy to draw, which were never the things that separate two themes.
 *
 * Light and dark are grouped separately. Dark cards carry a lot of visual
 * weight and mixed into the light ones they read as errors.
 *
 * This lived in a permanent 96px column down the left edge until now. Picking
 * a theme is a once-in-a-while act, so that column was charging rent on the
 * best real estate in the window; folded in here it gets more room and the
 * workspace gets its width back.
 *
 * The `data-tauri-drag-region="false"` on the root is not decoration: this
 * renders inside the toolbar, which is a `deep` drag region, so without opting
 * out, pressing anywhere in the panel that is not itself a control would drag
 * the window instead of doing nothing.
 */
export default function TypesetPopover({
  themeId,
  onThemeChange,
  onInsertComponent,
  customThemes,
  onDeleteTheme,
  onAskAgent,
  onOpenStudio,
  onSniffTheme,
  densityId,
  onDensityChange,
  linkFootnotes,
  onLinkFootnotes,
  appearance,
  onAppearance,
  state,
}: Props) {
  const renderCard = (th: Theme, mine = false) => {
    const active = th.id === themeId;
    return (
      <div key={th.id} className="theme-slot">
        <button
          role="radio"
          aria-checked={active}
          className={`theme-card ${active ? 'active' : ''}`}
          title={`${th.name} — ${th.description}`}
          onClick={() => onThemeChange(th.id)}
        >
          {/* The paper, then a real article on it, scaled down. aria-hidden
              because the name below and the button's own title already say
              which theme this is — a screen reader reading the sample text
              twenty times over is noise, not information. */}
          <span
            className="theme-thumb"
            style={{ background: th.body.bg ?? '#ffffff' }}
            aria-hidden="true"
          >
            <span
              className="theme-thumb-page"
              dangerouslySetInnerHTML={{ __html: sampleHtmlFor(th) }}
            />
          </span>
          {active && (
            <span className="swatch-check" aria-hidden="true">
              <Check size={9} weight="bold" />
            </span>
          )}
          <span className="theme-card-name">{th.name}</span>
        </button>
        {/* Only the agent's own themes can be thrown away; a preset is the
            floor the workspace falls back to */}
        {mine && (
          <Tooltip content={`在主题工坊里改「${th.name}」`} side="top">
            <button
              className="theme-edit"
              aria-label={`编辑主题 ${th.name}`}
              onClick={() => onOpenStudio(th.id)}
            >
              <PencilSimple size={11} weight="regular" />
            </button>
          </Tooltip>
        )}
        {mine && (
          <Tooltip content={`删掉「${th.name}」`} side="top">
            <button
              className="theme-drop"
              aria-label={`删掉主题 ${th.name}`}
              onClick={() => onDeleteTheme(th.id)}
            >
              <Trash size={11} weight="regular" />
            </button>
          </Tooltip>
        )}
      </div>
    );
  };

  const listRef = useThumbScale();

  const densityIndex = Math.max(0, DENSITIES.findIndex((d) => d.id === densityId));
  const appearanceIndex = Math.max(0, APPEARANCES.findIndex((a) => a.id === appearance));
  // Straight off the shared store rather than down through App: nothing above
  // this popover has any use for the value, and the editor reads the same
  // store, so the two stay in step without a prop chain between them.
  const { lineNumbers, setLineNumbers } = useEditorPrefs();
  const lineNumbersIndex = lineNumbers ? 1 : 0;

  return (
    <div
      className="popover typeset-pop scroll-thin"
      data-state={state}
      role="dialog"
      aria-label="排版与外观"
      data-tauri-drag-region="false"
    >
      <section className="typeset-group">
        <span className="eyebrow">文章主题</span>
        {/* The presets are a floor, not a ceiling: past them is a theme you tune
            yourself, one read off an article you liked, or a JSON file the
            agent writes — all three the same file on disk. They sit above the
            grid because they are the answer to "none of these is it", which is
            a thing you know before you have scrolled the whole list */}
        {/* One row of three, not three stacked cards. Each used to take two
            lines — icon, title, and a sentence of description — which is 96px
            of explanation above a grid of twelve themes, and pushed the grid
            itself below the fold of the popover. The sentence moves into the
            tooltip, where it is still one hover away on the day it is needed. */}
        <div className="theme-ways">
          <Tooltip content="从当前主题出发，每个元素的颜色、字号、间距、装饰都能改" side="bottom">
            <button className="theme-ask" onClick={() => onOpenStudio()}>
              <SlidersHorizontal size={14} weight="regular" />
              <span>自己调</span>
            </button>
          </Tooltip>
          <Tooltip content="粘一篇排版好看的公众号文章，把它的排版扒成主题" side="bottom">
            <button className="theme-ask" onClick={onSniffTheme}>
              <Eyedropper size={14} weight="regular" />
              <span>从链接扒</span>
            </button>
          </Tooltip>
          <Tooltip content="说清你想要的气质，它写成主题文件，预览立刻就变" side="bottom">
            <button className="theme-ask" onClick={onAskAgent}>
              <Sparkle size={13} weight="fill" />
              <span>让 Agent 做</span>
            </button>
          </Tooltip>
        </div>
        <div className="theme-list" role="radiogroup" aria-label="文章主题" ref={listRef}>
          <div className="typeset-sub">公众号原版</div>
          <div className="theme-grid">{gzhThemes.map((th) => renderCard(th))}</div>
          <div className="typeset-sub">浅色</div>
          <div className="theme-grid">{lightThemes.map((th) => renderCard(th))}</div>
          <div className="typeset-sub">深色</div>
          <div className="theme-grid">{darkThemes.map((th) => renderCard(th))}</div>
          {/* Its own section rather than a corner of 浅色: the four differ from
              each other by palette, which is not the axis the rest of the list
              is sorted on */}
          <div className="typeset-sub">Punk</div>
          <div className="theme-grid">{punkThemes.map((th) => renderCard(th))}</div>
          {customThemes.length > 0 && (
            <>
              <div className="typeset-sub">我的</div>
              <div className="theme-grid">{customThemes.map((th) => renderCard(th, true))}</div>
            </>
          )}
        </div>
      </section>

      {isGzhTheme(themeId) && <ThemeComponentPicker key={themeId} themeId={themeId} onInsert={onInsertComponent} />}

      {/* Density scales font size / leading / spacing together within one
          theme; the middle preset is the theme's own designed values. */}
      <section className="typeset-group">
        <span className="eyebrow">排版密度</span>
        {isGzhTheme(themeId) ? <p className="switch-sub">原版主题使用固定字号、行高与间距。</p> : <div
          className="segmented"
          role="radiogroup"
          aria-label="排版密度"
          style={{ '--seg-n': DENSITIES.length, '--seg-i': densityIndex } as React.CSSProperties}
        >
          {DENSITIES.map((d) => (
            <button
              key={d.id}
              role="radio"
              aria-checked={densityId === d.id}
              tabIndex={densityId === d.id ? 0 : -1}
              className={`seg-btn ${densityId === d.id ? 'active' : ''}`}
              onKeyDown={(e) => {
                const next = arrowPick(e, DENSITIES, densityIndex);
                if (next) onDensityChange(next.id);
              }}
              onClick={() => onDensityChange(d.id)}
            >
              {d.name}
            </button>
          ))}
        </div>}
      </section>

      {/* WeChat readers cannot tap an external link in the body, so this moves
          the address down to a footnote list at the end. */}
      <section className="typeset-group">
        <span className="eyebrow">正文</span>
        <button
          role="switch"
          aria-checked={linkFootnotes}
          className="switch-row"
          onClick={() => onLinkFootnotes(!linkFootnotes)}
        >
          <span className="switch-label">
            外链转脚注
            <span className="switch-sub">正文里换成上标编号，地址收进文末引用（站内链接不动）</span>
          </span>
          <span className="switch" aria-hidden="true" />
        </button>
      </section>

      {/* The shell's own light/dark. Nothing here travels with the draft. */}
      <section className="typeset-group">
        <span className="eyebrow">界面外观</span>
        <div
          className="segmented"
          role="radiogroup"
          aria-label="界面外观"
          style={{ '--seg-n': APPEARANCES.length, '--seg-i': appearanceIndex } as React.CSSProperties}
        >
          {APPEARANCES.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={appearance === a.id}
              tabIndex={appearance === a.id ? 0 : -1}
              className={`seg-btn ${appearance === a.id ? 'active' : ''}`}
              onKeyDown={(e) => {
                const next = arrowPick(e, APPEARANCES, appearanceIndex);
                if (next) onAppearance(next.id);
              }}
              onClick={() => onAppearance(a.id)}
            >
              {a.name}
            </button>
          ))}
        </div>

        {/* Second row of the same group: also the shell, also not the draft.
            Line numbers are scaffolding for code and this pane holds prose,
            so they start hidden and this is where you go looking for them. */}
        <span className="eyebrow">行号</span>
        <div
          className="segmented"
          role="radiogroup"
          aria-label="行号"
          style={{ '--seg-n': LINE_NUMBERS.length, '--seg-i': lineNumbersIndex } as React.CSSProperties}
        >
          {LINE_NUMBERS.map((o, i) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={lineNumbersIndex === i}
              tabIndex={lineNumbersIndex === i ? 0 : -1}
              className={`seg-btn ${lineNumbersIndex === i ? 'active' : ''}`}
              onKeyDown={(e) => {
                const next = arrowPick(e, LINE_NUMBERS, lineNumbersIndex);
                if (next) setLineNumbers(next.id === 'on');
              }}
              onClick={() => setLineNumbers(o.id === 'on')}
            >
              {o.name}
            </button>
          ))}
        </div>
        <p className="typeset-hint">只影响编辑器自己，不写进稿子里。</p>
      </section>
    </div>
  );
}


function ThemeComponentPicker({ themeId, onInsert }: { themeId: string; onInsert: (html: string) => void }) {
  const components = themeComponents(themeId);
  const [selected, setSelected] = useState(0);
  const component = components[selected];
  const html = componentMarkup(component);
  return <section className="typeset-group">
    <span className="eyebrow">主题组件</span>
    <select aria-label="选择主题组件" value={selected} onChange={e => setSelected(Number(e.target.value))}>
      {components.map((item, index) => <option key={index} value={index}>{item.name}（{index + 1}）</option>)}
    </select>
    <div className="gzh-component-preview scroll-thin" dangerouslySetInnerHTML={{ __html: html }} />
    <button className="theme-ask" onClick={() => onInsert(html)}>在光标处插入</button>
    <p className="switch-sub">插入后在编辑器中替换文字和图片。样式沿用原版组件。</p>
    <p className="switch-sub">甲木 × 摸鱼小李 · <a href="https://github.com/isjiamu/gzh-design-skill" target="_blank" rel="noopener noreferrer">gzh-design-skill</a> · AGPL-3.0-or-later</p>
  </section>;
}
