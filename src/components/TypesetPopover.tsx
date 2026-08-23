import type { CSSProperties, ReactNode } from 'react';
import { Check, Sparkle, Trash } from '@phosphor-icons/react';
import { DENSITIES, darkThemes, lightThemes, type Theme } from '../theme';
import type { Appearance } from '../store/appearance';

interface Props {
  themeId: string;
  onThemeChange: (id: string) => void;
  /** Themes the agent wrote, read off disk (see store/customThemes.ts) */
  customThemes: Theme[];
  onDeleteTheme: (id: string) => void;
  /** Hand the agent panel a half-written request for a new theme */
  onAskAgent: () => void;
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
}

const APPEARANCES: { id: Appearance; name: string }[] = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
];

/**
 * Everything about how things look, in one popover.
 *
 * Each theme card is a miniature sheet of paper drawn with that theme's own
 * tokens — its paper color, its heading face, its accent rule, two body
 * lines. That beats a list of names: you can see what separates the themes
 * without having to switch to each one.
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
/**
 * The heading of the sample sheet, drawn the way this theme draws a heading.
 *
 * The card used to show the same "Aa" in every theme, with only the colours
 * changing — which was an honest picture back when only colours changed. Now
 * that a theme picks how a heading is marked out, the card has to say which one
 * it picked, or the twelve cards still read as twelve colours.
 */
function headingSample(th: Theme): { style: CSSProperties; prefix: ReactNode; center: boolean } {
  const style: CSSProperties = { fontFamily: th.heading.font, color: th.heading.color };
  let prefix: ReactNode = null;
  const decor = th.heading.decor ?? 'none';
  const center = decor === 'center-rule' || th.heading.align === 'center';
  switch (decor) {
    case 'band':
      style.background = th.accentSoft ?? th.accent;
      style.padding = '1px 5px';
      style.borderRadius = '4px';
      break;
    case 'underline':
    case 'rule':
    case 'center-rule':
      style.borderBottom = `2px solid ${th.accent}`;
      style.paddingBottom = '2px';
      break;
    case 'accent-bar':
      style.borderTop = `2px solid ${th.accent}`;
      style.paddingTop = '3px';
      break;
    case 'left-bar':
      style.borderLeft = `3px solid ${th.accent}`;
      style.paddingLeft = '5px';
      break;
    case 'boxed':
      style.border = `1.5px solid ${th.accent}`;
      style.padding = '0 5px';
      style.borderRadius = '3px';
      break;
    case 'numbered':
      prefix = <span style={{ color: th.accent }}>01</span>;
      break;
    case 'marker':
      prefix = <span style={{ color: th.accent }}>{th.heading.markerGlyph ?? '▍'}</span>;
      break;
  }
  return { style, prefix, center };
}

export default function TypesetPopover({
  themeId,
  onThemeChange,
  customThemes,
  onDeleteTheme,
  onAskAgent,
  densityId,
  onDensityChange,
  linkFootnotes,
  onLinkFootnotes,
  appearance,
  onAppearance,
}: Props) {
  const renderCard = (th: Theme, mine = false) => {
    const active = th.id === themeId;
    const sample = headingSample(th);
    return (
      <div key={th.id} className="theme-slot">
        <button
          role="radio"
          aria-checked={active}
          className={`theme-card ${active ? 'active' : ''}`}
          title={`${th.name} — ${th.description}`}
          onClick={() => onThemeChange(th.id)}
        >
          <span className="swatch" style={{ background: th.body.bg ?? '#ffffff' }}>
            <span className={`swatch-head ${sample.center ? 'center' : ''}`}>
              {sample.prefix}
              <span className="swatch-aa" style={sample.style}>
                Aa
              </span>
            </span>
            <span className="swatch-bar" style={{ background: th.accent }} />
            <span className="swatch-line" style={{ background: th.body.color }} />
            <span className="swatch-line short" style={{ background: th.body.color }} />
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
          <button
            className="theme-drop"
            title={`删掉「${th.name}」`}
            aria-label={`删掉主题 ${th.name}`}
            onClick={() => onDeleteTheme(th.id)}
          >
            <Trash size={10} weight="bold" />
          </button>
        )}
      </div>
    );
  };

  const densityIndex = Math.max(0, DENSITIES.findIndex((d) => d.id === densityId));
  const appearanceIndex = Math.max(0, APPEARANCES.findIndex((a) => a.id === appearance));

  return (
    <div
      className="popover typeset-pop scroll-thin"
      role="dialog"
      aria-label="排版与外观"
      data-tauri-drag-region="false"
    >
      <section className="typeset-group">
        <span className="eyebrow">文章主题</span>
        <div role="radiogroup" aria-label="文章主题">
          <div className="typeset-sub">浅色</div>
          <div className="theme-grid">{lightThemes.map((th) => renderCard(th))}</div>
          <div className="typeset-sub">深色</div>
          <div className="theme-grid">{darkThemes.map((th) => renderCard(th))}</div>
          {customThemes.length > 0 && (
            <>
              <div className="typeset-sub">我的</div>
              <div className="theme-grid">{customThemes.map((th) => renderCard(th, true))}</div>
            </>
          )}
        </div>
        {/* The twelve presets are a floor, not a ceiling: anything past them is
            a JSON file the agent writes while you watch the preview change */}
        <button className="theme-ask" onClick={onAskAgent}>
          <Sparkle size={13} weight="fill" />
          <span>
            让 Agent 做一个
            <span className="theme-ask-sub">说清你想要的气质，它写成主题文件，预览立刻就变</span>
          </span>
        </button>
      </section>

      {/* Density scales font size / leading / spacing together within one
          theme; the middle preset is the theme's own designed values. */}
      <section className="typeset-group">
        <span className="eyebrow">排版密度</span>
        <div
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
              className={`seg-btn ${densityId === d.id ? 'active' : ''}`}
              onClick={() => onDensityChange(d.id)}
            >
              {d.name}
            </button>
          ))}
        </div>
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
              className={`seg-btn ${appearance === a.id ? 'active' : ''}`}
              onClick={() => onAppearance(a.id)}
            >
              {a.name}
            </button>
          ))}
        </div>
        <p className="typeset-hint">只影响编辑器自己，不写进稿子里。</p>
      </section>
    </div>
  );
}
