import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowCircleUp, ClipboardText, ImageSquare, PaperPlaneTilt, Sparkle, Stack, TextAa } from '@phosphor-icons/react';
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
  /** An export is running: the button keeps its label and spins instead */
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
 * needs to opt out by hand except a floating layer (see the popover).
 *
 * Left says what you are editing, right says what you can do to it, with a
 * single filled button for the one destructive-ish action worth emphasizing.
 *
 * The right end is four objects, not eight buttons: the mode switch, a capsule
 * for how the piece is set and who else may touch it (排版 / Agent), a capsule
 * for what comes out of it (长图 / 复制正文 / 草稿箱), and the one filled button.
 * Eight equally-spaced controls read as a list of eight things to consider;
 * two capsules and a switch read as three, and each capsule's sunken track says
 * where a group starts and ends without a divider having to be drawn.
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

  // Click outside / Esc closes the popover
  useEffect(() => {
    if (!typesetOpen) return;
    // Listen on pointerdown, not click: the preview head's theme name opens
    // this popover from outside the toolbar, and React flushes the effect
    // that registers this listener before that same click has finished
    // bubbling to the document — so a click listener would close the
    // popover in the very event that opened it. By the time pointerdown
    // fires for the *next* press, the popover really is open, and a press
    // on any opener is excluded so it toggles rather than fights itself.
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

  const modeIndex = MODES.findIndex((m) => m.id === viewMode);

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
              <ArrowCircleUp size={15} weight="bold" />
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

        {/* Capsule A — how the piece is set, and who else may touch it.
            Local agent: runs the claude / codex already on this machine.
            No model is wired into the editor itself. */}
        <div className="tb-group capsule">
          {/* Themes, density, body options and the shell's own light/dark */}
          <div className="menu-wrap" ref={typesetRef}>
            <Tooltip content="文章主题、排版密度、界面外观" shortcut={hintFor('typeset')}>
              <button
                className={`btn ${typesetOpen ? 'active' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={typesetOpen}
                onClick={() => onTypesetOpen(!typesetOpen)}
              >
                <TextAa size={15} weight="bold" />
                排版
              </button>
            </Tooltip>
            {typesetPresence.mounted && typeset(() => onTypesetOpen(false), typesetPresence.state)}
          </div>

          <Tooltip content="让本地的 claude / codex 在这个工作区里改稿" shortcut={hintFor('agent')}>
            <button
              className={`btn ${agentOpen ? 'active' : ''}`}
              onClick={onToggleAgent}
              aria-pressed={agentOpen}
            >
              <Sparkle size={15} weight="bold" />
              Agent
            </button>
          </Tooltip>
        </div>

        {/* Capsule B — what comes out of the finished piece */}
        <div className="tb-group capsule">
          <Tooltip content="把整篇正文渲染成一张长图 PNG" shortcut={hintFor('longImage')}>
            <button
              className={`btn ${exporting ? 'busy' : ''}`}
              onClick={onExportImage}
              disabled={exporting}
              aria-busy={exporting}
            >
              {exporting ? <Spinner /> : <ImageSquare size={15} weight="bold" />}
              长图
            </button>
          </Tooltip>

          <Tooltip content={`复制为富文本，去公众号编辑器 ${chord('V')} 粘贴`} shortcut={hintFor('copy')}>
            <button
              className={`btn ${copying ? 'busy' : ''}`}
              onClick={onCopy}
              disabled={copying}
              aria-busy={copying}
            >
              {copying ? <Spinner /> : <ClipboardText size={15} weight="bold" />}
              复制正文
            </button>
          </Tooltip>

          {/* The drafts box is otherwise only visible inside the WeChat console,
              so after a few pushes it is unclear which version is up there. Also
              where an article is picked to overwrite rather than duplicate. */}
          <Tooltip content="草稿箱：看看公众号上已有哪些草稿">
            <button className="btn" onClick={onOpenDraftBox} aria-label="草稿箱">
              <Stack size={15} weight="bold" />
              草稿箱
            </button>
          </Tooltip>
        </div>

        <Tooltip content="换图后直接推进公众号草稿箱" shortcut={hintFor('publish')}>
          <button className="btn primary" onClick={onPublish}>
            <PaperPlaneTilt size={15} weight="bold" />
            推草稿
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
