import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowCircleUp,
  CaretDown,
  ClipboardText,
  Export,
  ImageSquare,
  PaperPlaneTilt,
  Sparkle,
  Stack,
} from '@phosphor-icons/react';
import Tooltip from './Tooltip';
import Spinner from './Spinner';
import { EXIT_POPOVER, usePresence } from '../usePresence';
import { hintFor } from '../shortcuts';
import { chord } from '../platform';

interface Props {
  viewMode: 'split' | 'preview';
  onViewMode: (m: 'split' | 'preview') => void;
  /** Name of the open draft — the toolbar doubles as the window title */
  docName: string;
  /**
   * The folder(s) the draft sits in, outermost first.
   *
   * The editor's pane head used to show this, on a row the format strip now
   * occupies. It belongs here anyway: this bar already names the open file, so
   * the path simply grows a head — 系列 / 第一篇：从零开始 — instead of the same
   * draft being named in two places. A draft at the root of the workspace has
   * no folders and reads exactly as it did.
   */
  docFolders: string[];
  /** A write is still in flight (the save indicator breathes) */
  saving: boolean;
  onCopy: () => void;
  /**
   * Export the body as one long PNG.
   *
   * The only export left. A draft is already a .md file in the workspace and
   * the images are already image files, so "export a draft" and "back up
   * everything" were both offering to produce a copy of what is already on
   * disk. A long image is the one thing the folder does not already contain.
   */
  onExportImage: () => void;
  /** An export is running: the menu item keeps its label and spins instead */
  exporting: boolean;
  /** A copy is running (remote images have to be fetched first) */
  copying: boolean;
  /** Open "push to drafts" */
  onPublish: () => void;
  /** Open the drafts box: what is already up there, and what to overwrite */
  onOpenDraftBox: () => void;
  /**
   * A newer release is waiting.
   *
   * The launch check is silent by design (see store/updater.ts), so this pill
   * is the entire announcement: visible, ignorable, and gone once the version
   * is installed or dismissed.
   */
  hasUpdate: boolean;
  onOpenUpdate: () => void;
  /** Is the agent panel expanded */
  agentOpen: boolean;
  onToggleAgent: () => void;
  /** The typeset popover. Owned by App because ⌘⇧T and the preview head's
   *  theme name both open it, and this bar is not the only way in any more */
  typesetOpen: boolean;
  onTypesetOpen: (open: boolean) => void;
  /** Themes / density / body options / appearance, rendered into a popover.
   *  Given the popover's own close handle, so a control inside it can dismiss
   *  it on its way to opening something else (see the agent theme button), and
   *  the presence state, which it writes onto its root so it can animate shut */
  typeset: (close: () => void, state: 'enter' | 'exit') => ReactNode;
}

const MODES = [
  { id: 'split', name: '对照' },
  { id: 'preview', name: '预览' },
] as const;

/** Keep-inside-the-window margin for anything floating */
const PAD = 8;

/**
 * Where a floating layer hangs from.
 *
 * `getBoundingClientRect` on the trigger, or — when the trigger is not on
 * screen at all — the top right corner of the window, which is where every one
 * of these controls lives anyway.
 */
function anchorRect(el: HTMLElement | null): DOMRect {
  if (el) return el.getBoundingClientRect();
  return new DOMRect(window.innerWidth - PAD, 46, 0, 0);
}

/**
 * A menu hung under a toolbar button.
 *
 * On <body> rather than inside the bar: the header is a Tauri drag region and
 * a floating layer inside it has to opt out of the drag by hand, and nothing
 * up there should be able to clip a menu.
 *
 * It is right-aligned to its trigger and grows out of that corner, so the menu
 * reads as the button's own contents unfolding rather than as a panel that
 * arrived from somewhere else.
 */
function ToolbarMenu({
  open,
  onClose,
  anchor,
  label,
  children,
}: {
  open: boolean;
  /** Close, and put the keyboard back on the trigger */
  onClose: () => void;
  anchor: RefObject<HTMLButtonElement | null>;
  label: string;
  children: ReactNode;
}) {
  const presence = usePresence(open, EXIT_POPOVER);
  const ref = useRef<HTMLDivElement>(null);

  // Outside press or Esc closes it.
  //
  // pointerdown rather than click, and the trigger excluded: React flushes
  // this effect before the click that opened the menu has finished bubbling to
  // the document, so a click listener would shut the menu inside the very
  // event that opened it (the same trap the typeset popover fell into — see
  // below, and FileTree's 「+」 menu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target)) return;
      if (anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc means "never mind": the focus goes back where the press started
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchor]);

  // Under the button and right-aligned to it, measured against the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const rect = anchorRect(anchor.current);
    // offsetWidth, not a bounding rect: this runs on the first frame of the
    // pop-in, where the menu is still scaled to 0.96 — measuring the rect
    // would right-align the menu to a width it is about to outgrow
    const { offsetWidth: width, offsetHeight: height } = el;
    el.style.left = `${Math.round(
      Math.max(PAD, Math.min(rect.right - width, window.innerWidth - width - PAD)),
    )}px`;
    el.style.top = `${Math.round(
      Math.min(rect.bottom + 6, Math.max(PAD, window.innerHeight - height - PAD)),
    )}px`;
    // Straight into the menu: it was opened to be chosen from
    el.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus();
  }, [open, presence.mounted, anchor]);

  /** ↑↓ cycle the items — a menu is a ring, not a list that dead-ends */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)'),
    );
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  };

  if (!presence.mounted) return null;
  return createPortal(
    <div
      ref={ref}
      className="popover tb-menu"
      data-state={presence.state}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Top bar. On macOS this *is* the window title bar (see tauri.conf.json:
 * titleBarStyle Overlay) — the traffic lights float over its left end and
 * dragging it moves the window.
 *
 * That drag comes from `data-tauri-drag-region="deep"` on the header, and the
 * `deep` matters: a bare attribute means "only a click landing on this exact
 * element drags", so every span inside — the wordmark, the document name —
 * would swallow the gesture and leave just the slivers of empty header between
 * them draggable. `deep` makes the whole subtree drag, and Tauri already
 * excludes buttons and other interactive elements from it, so nothing here
 * needs to opt out by hand.
 *
 * Left says what you are editing, right says what you can do to it, with a
 * single filled button for the one destructive-ish action worth emphasizing.
 *
 * The right end is four objects: the mode switch, Agent, 导出, and the filled
 * 推草稿. It used to be eight buttons in two capsules, which read as a list of
 * eight things to consider every time you looked up. Three of them are gone
 * from the bar without being gone from the app:
 *
 *   排版 — the preview head already says 「经典 · 标准 ⌄」 and that chip opens
 *          this very popover, so the bar was a second door to one room.
 *   长图 / 复制正文 — one question ("get it out of here how?") asked twice.
 *          They are the two items of the 导出 menu now.
 *   草稿箱 — not an export and not a step in writing: it is "what did I
 *          already push?", which belongs next to 推草稿 rather than beside it.
 *          It hangs off the primary button's caret.
 *
 * A capsule's sunken track still says where a group starts and ends without a
 * divider having to be drawn; with one button left in each, it mostly says
 * "these two are the same kind of thing as the mode switch".
 */
export default function Toolbar({
  viewMode,
  onViewMode,
  docName,
  docFolders,
  saving,
  onCopy,
  onExportImage,
  exporting,
  copying,
  onPublish,
  onOpenDraftBox,
  hasUpdate,
  onOpenUpdate,
  agentOpen,
  onToggleAgent,
  typesetOpen,
  onTypesetOpen,
  typeset,
}: Props) {
  const typesetRef = useRef<HTMLDivElement>(null);
  const typesetPresence = usePresence(typesetOpen, EXIT_POPOVER);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLButtonElement>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const pushRef = useRef<HTMLButtonElement>(null);

  // Click outside / Esc closes the typeset popover
  useEffect(() => {
    if (!typesetOpen) return;
    // Listen on pointerdown, not click: the preview head's theme name opens
    // this popover, and React flushes the effect that registers this listener
    // before that same click has finished bubbling to the document — so a
    // click listener would close the popover in the very event that opened
    // it. By the time pointerdown fires for the *next* press, the popover
    // really is open, and a press on the opener is excluded so it toggles
    // rather than fights itself.
    const onDocClick = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (typesetRef.current?.contains(target)) return;
      if (target?.closest('[data-typeset-trigger]')) return;
      onTypesetOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onTypesetOpen(false);
    };
    document.addEventListener('pointerdown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [typesetOpen, onTypesetOpen]);

  /**
   * Park the typeset popover over the preview head's 「经典 · 标准 ⌄」 chip.
   *
   * The popover used to be a child of the 排版 button's wrapper and positioned
   * itself against it in CSS — `top: calc(100% + 8px); right: 0`. With that
   * button gone the chip is the only opener left, so the wrapper moves to a
   * portal and is laid over the chip's own rect: the popover's stylesheet is
   * untouched and still resolves to "under the trigger, right-aligned".
   *
   * ⌘⇧T opens the same popover without going near the chip, and lands in the
   * same place — the anchor is read from the DOM, not from the click.
   */
  useLayoutEffect(() => {
    const el = typesetRef.current;
    if (!typesetOpen || !el) return;
    const place = () => {
      const rect = anchorRect(document.querySelector<HTMLElement>('[data-typeset-trigger]'));
      const pop = el.firstElementChild as HTMLElement | null;
      const popW = pop?.offsetWidth ?? 0;
      // The chip is sized to its words now, in both modes, so the only
      // question is which of its edges the popover hangs from. Right-aligned
      // is the default (the chip sits right of centre in 对照); when that
      // would push the popover off the window's left edge — the chip is near
      // the left in 预览 — it starts at the chip's left edge instead. The
      // popover's stylesheet pins it `right: 0`, so a left-aligned hang is a
      // box exactly as wide as the popover, starting where the chip starts.
      const rightAligned = rect.right - popW >= PAD;
      const boxW = rightAligned ? rect.width : popW;
      const left = rightAligned
        ? rect.left
        : Math.min(rect.left, window.innerWidth - PAD - popW);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(rect.top)}px`;
      el.style.width = `${Math.round(boxW)}px`;
      el.style.height = `${Math.round(rect.height)}px`;
      // Grow out of the corner it is pinned to — the stylesheet can only name
      // one (see .popover)
      if (pop) pop.style.transformOrigin = rightAligned ? 'top right' : 'top left';
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [typesetOpen, typesetPresence.mounted]);

  const modeIndex = MODES.findIndex((m) => m.id === viewMode);

  /** Picking from the 导出 menu shuts it and hands the keyboard back: neither
   *  of these two opens anything that would otherwise claim focus */
  const closeExport = useCallback(() => setExportOpen(false), []);
  const runExport = (run: () => void) => {
    setExportOpen(false);
    exportRef.current?.focus();
    run();
  };
  const closePush = useCallback(() => setPushOpen(false), []);

  return (
    <header className="toolbar" data-tauri-drag-region="deep">
      <div className="brand">
        {/* Horizon mark, identical to public/favicon.svg and the app icon.
            Colors are fixed brand colors, not theme tokens, so the mark reads
            the same in every theme. */}
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <rect width="100" height="100" rx="22" fill="#F1ECE3" />
            <path d="M18 58A32 32 0 0 1 82 58Z" fill="#C4482A" />
            <rect x="14" y="64" width="72" height="10" rx="5" fill="#6E2715" />
          </svg>
        </span>
        <span className="brand-name">火星编辑器</span>
      </div>

      {docName && (
        <>
          <span className="tb-sep" aria-hidden="true" />
          <div className="tb-doc">
            <span className={`tb-dot ${saving ? 'saving' : ''}`} aria-hidden="true" />
            <span className="tb-doc-name" title={saving ? '正在保存…' : '已保存到工作区'}>
              {docFolders.map((seg, i) => (
                <span key={`${i}:${seg}`} className="tb-doc-folder">{`${seg} / `}</span>
              ))}
              {docName}
            </span>
          </div>
        </>
      )}

      <div className="toolbar-right">
        {hasUpdate && (
          <Tooltip content="有新版本可以安装">
            <button className="btn update-pill" onClick={onOpenUpdate}>
              <ArrowCircleUp size={16} weight="regular" />
              新版本
            </button>
          </Tooltip>
        )}

        {/* What you are looking at */}
        <div
          className="segmented"
          role="radiogroup"
          aria-label="工作区模式"
          style={{ '--seg-n': MODES.length, '--seg-i': modeIndex } as React.CSSProperties}
        >
          {MODES.map((m, i) => (
            <Tooltip
              key={m.id}
              content={m.id === 'split' ? '源码和预览并排' : '只看预览'}
              shortcut={hintFor('viewMode')}
            >
              <button
                role="radio"
                aria-checked={viewMode === m.id}
                tabIndex={viewMode === m.id ? 0 : -1}
                className={`seg-btn ${viewMode === m.id ? 'active' : ''}`}
                onKeyDown={(e) => {
                  // One tab stop for the group; ←→ move inside it
                  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                  if (!step) return;
                  e.preventDefault();
                  onViewMode(MODES[(i + step + MODES.length) % MODES.length].id);
                }}
                onClick={() => onViewMode(m.id)}
              >
                {m.name}
              </button>
            </Tooltip>
          ))}
        </div>

        {/* Who else may touch the draft. Local agent: runs the claude / codex
            already on this machine. No model is wired into the editor itself. */}
        <div className="tb-group capsule">
          <Tooltip content="让本地的 claude / codex 在这个工作区里改稿" shortcut={hintFor('agent')}>
            <button
              className={`btn ${agentOpen ? 'active' : ''}`}
              onClick={onToggleAgent}
              aria-pressed={agentOpen}
            >
              <Sparkle size={16} weight="regular" />
              Agent
            </button>
          </Tooltip>
        </div>

        {/* What comes out of the finished piece. Two ways out of the editor is
            one question, so it is one button with two answers under it. */}
        <div className="tb-group capsule">
          <Tooltip content="复制正文，或渲染成一张长图">
            <button
              ref={exportRef}
              className={`btn ${exportOpen ? 'active' : ''} ${copying || exporting ? 'busy' : ''}`}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              onClick={() => setExportOpen((v) => !v)}
            >
              {/* The trigger spins too: picking an item closes the menu, and a
                  copy that has to fetch remote images takes long enough that
                  the bar would otherwise look like nothing happened */}
              {copying || exporting ? <Spinner /> : <Export size={16} weight="regular" />}
              导出
              <CaretDown size={10} weight="bold" className="tb-caret" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>

        <div className="tb-split">
          <Tooltip content="换图后直接推进公众号草稿箱" shortcut={hintFor('publish')}>
            <button className="btn primary tb-split-main" onClick={onPublish}>
              <PaperPlaneTilt size={15} weight="bold" />
              推草稿
            </button>
          </Tooltip>
          <button
            ref={pushRef}
            className="btn primary tb-split-more"
            aria-label="推送的其他去处"
            aria-haspopup="menu"
            aria-expanded={pushOpen}
            onClick={() => setPushOpen((v) => !v)}
          >
            <CaretDown size={10} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>

      <ToolbarMenu open={exportOpen} onClose={closeExport} anchor={exportRef} label="导出">
        <button
          className={`menu-item ${copying ? 'busy' : ''}`}
          role="menuitem"
          title={`复制为富文本，去公众号编辑器 ${chord('V')} 粘贴`}
          disabled={copying}
          aria-busy={copying}
          onClick={() => runExport(onCopy)}
        >
          {copying ? <Spinner /> : <ClipboardText size={14} className="menu-icon" />}
          复制正文
          <span className="menu-hint">{hintFor('copy')}</span>
        </button>
        <button
          className={`menu-item ${exporting ? 'busy' : ''}`}
          role="menuitem"
          title="把整篇正文渲染成一张长图 PNG"
          disabled={exporting}
          aria-busy={exporting}
          onClick={() => runExport(onExportImage)}
        >
          {exporting ? <Spinner /> : <ImageSquare size={14} className="menu-icon" />}
          导出长图
          <span className="menu-hint">{hintFor('longImage')}</span>
        </button>
      </ToolbarMenu>

      {/* The drafts box is otherwise only visible inside the WeChat console, so
          after a few pushes it is unclear which version is up there. Also where
          an article is picked to overwrite rather than duplicate. */}
      <ToolbarMenu open={pushOpen} onClose={closePush} anchor={pushRef} label="推送">
        <button
          className="menu-item"
          role="menuitem"
          title="草稿箱：看看公众号上已有哪些草稿"
          onClick={() => {
            // No focus hand-back: the drafts box takes the keyboard next
            setPushOpen(false);
            onOpenDraftBox();
          }}
        >
          <Stack size={14} className="menu-icon" />
          查看草稿箱
        </button>
      </ToolbarMenu>

      {typesetPresence.mounted &&
        createPortal(
          <div className="typeset-anchor" ref={typesetRef}>
            {typeset(() => onTypesetOpen(false), typesetPresence.state)}
          </div>,
          document.body,
        )}
    </header>
  );
}
