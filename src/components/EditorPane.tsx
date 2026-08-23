import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, Code, CodeBlock, Link, ListBullets, ListChecks, ListDashes, Minus, Quotes, Table, TextB, TextH, TextHFour, TextHOne, TextHThree, TextHTwo, TextItalic } from '@phosphor-icons/react';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { registerImageFiles } from '../images';
import type { ScrollSyncChannel } from '../scrollSync';

/* One size for every Phosphor icon; the H1–H4 menu items each use the glyph
   that matches their level. */
const ICON = 16;
const HEADING_ICON = { 1: TextHOne, 2: TextHTwo, 3: TextHThree, 4: TextHFour } as const;

/**
 * Editor colors, all of them var() references into the shared tokens.
 *
 * Doing it this way is what lets the editor follow the light/dark switch:
 * CodeMirror only ever emits these strings into a stylesheet, so the values
 * resolve at paint time against whichever palette is active. A theme with
 * literal hex colors would need a second copy and a reconfigure on every
 * appearance change.
 */
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', color: 'var(--text-1)' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: '1.8',
    overflow: 'auto',
  },
  '.cm-content': { padding: '18px 24px 28px 20px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 4px' },
  '.cm-gutters': {
    background: 'transparent',
    color: 'var(--text-3)',
    fontSize: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderRight: 'none',
    userSelect: 'none',
  },
  // The line you are on: number picks up the accent, the row itself gets the
  // faintest possible wash — enough to find the caret, not enough to stripe
  // the page.
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--accent)' },
  '.cm-activeLine': { background: 'var(--accent-softer)', borderRadius: '4px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'var(--accent-ring)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '2px', borderLeftColor: 'var(--accent)' },
  '.cm-selectionMatch': { background: 'var(--accent-soft)' },
  '&.cm-focused': { outline: 'none' },
});

/**
 * Markdown highlighting.
 *
 * The rule here is that the source should look like prose that happens to
 * carry markup, not like code: headings get weight, emphasis gets slant, and
 * the markers themselves (`#`, `**`, `>`) recede rather than disappear —
 * you need to see them to edit them, you should not have to read them.
 *
 * The generic code tags below only ever show up inside fenced blocks, whose
 * grammars @codemirror/language-data loads on demand.
 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.2em', color: 'var(--text-1)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.1em', color: 'var(--text-1)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--text-1)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text-1)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-3)' },
  { tag: [t.link, t.url], color: 'var(--accent-hi)', textUnderlineOffset: '2px' },
  { tag: t.monospace, color: 'var(--accent-hi)' },
  { tag: t.quote, color: 'var(--text-2)', fontStyle: 'italic' },
  { tag: t.contentSeparator, color: 'var(--text-3)' },
  // Every markdown marker lands here (#, **, >, -, ```): present, recessive.
  // Note there is deliberately no rule for t.list — @lezer/markdown puts that
  // tag on the *whole* list, contents included, so styling it tints every
  // bullet's text rather than its marker.
  { tag: t.processingInstruction, color: 'var(--text-3)' },
  { tag: t.labelName, color: 'var(--text-2)' },

  // Inside fenced code blocks
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-str)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--text-2)' },
]);

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Register a local image: file name → data URI (what renders ![[name]]) */
  onAddImage: (name: string, dataUrl: string) => void;
  /** Names of imported images, for ![[ completion */
  imageNames: string[];
  /** Id of the open draft: switching drafts forces a doc sync */
  draftId: string;
  /** Scroll-sync channel: publishes the source position at the editor's top edge */
  sync: ScrollSyncChannel;
  /** Preview mode: the pane collapses */
  collapsed: boolean;
  /** Editor-side width, as a percentage */
  widthPct: number;
  /** A write is still pending (App owns the debounce; the toolbar shows it too) */
  saving: boolean;
  /**
   * An outside jump request (clicking an image in the file tree lands on its
   * reference). The nonce distinguishes "the same line, requested again" —
   * without it, clicking the same image twice would not re-run the effect.
   */
  jumpRequest: { line: number; nonce: number } | null;
}

const EditorPane = forwardRef<HTMLElement, Props>(function EditorPane(
  { value, onChange, onAddImage, imageNames, draftId, sync, collapsed, widthPct, saving, jumpRequest },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const syncRef = useRef(sync);
  syncRef.current = sync;
  // Completion candidates go through a ref: CodeMirror extensions are built
  // once at mount, so a direct closure would be stuck on the empty list forever
  const imageNamesRef = useRef(imageNames);
  imageNamesRef.current = imageNames;
  /** The text last reported upward — tells "I typed that" from "someone else did" */
  const lastEmittedRef = useRef(value);

  /** Register the images and insert Obsidian-style ![[name]] embeds at the caret */
  const insertImages = async (files: File[]) => {
    const view = viewRef.current;
    const { names } = await registerImageFiles(files, onAddImage);
    if (!names.length || !view) return;
    const block = names.map((n) => `![[${n}]]\n`).join('');
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: block },
      selection: { anchor: view.state.selection.main.head + block.length },
    });
  };

  // Set up the CodeMirror editor
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
            // Mod-B bold / Mod-I italic (⌘ on macOS, Ctrl on Windows — CodeMirror
            // resolves `Mod` per platform): wrap a selection, or insert the pair with
            // the caret between them when there is none
            {
              key: 'Mod-b',
              run: () => {
                wrapSelection('**', '**');
                return true;
              },
            },
            {
              key: 'Mod-i',
              run: () => {
                wrapSelection('*', '*');
                return true;
              },
            },
          ]),
          EditorView.lineWrapping,
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
          }),
          // ![[ image-name completion
          autocompletion({
            override: [
              (ctx) => {
                const before = ctx.matchBefore(/!\[\[[\w一-龥.-]*$/);
                if (!before) return null;
                return {
                  from: before.from + 3,
                  options: imageNamesRef.current.map((name) => ({
                    label: name,
                    type: 'image',
                    apply: `${name}]]`,
                  })),
                };
              },
            ],
          }),
          editorTheme,
          syntaxHighlighting(markdownHighlight),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            lastEmittedRef.current = next;
            onChangeRef.current(next);
          }),
        ],
      }),
    });
    viewRef.current = view;

    // Editor scroll → preview sync: report a continuous quantity, "line number
    // plus fraction into that line". Reporting whole lines only would make the
    // preview wait for a full line to turn over before moving, which reads as a
    // stutter.

    const scroller = view.scrollDOM;
    /** The source position (line + fraction) at a given scrollTop */
    const positionAt = (scrollTop: number) => {
      // lineBlockAtHeight works in document-height coordinates, so the content
      // area's top padding has to come off first
      const docTop = Math.max(0, scrollTop - view.documentPadding.top);
      const block = view.lineBlockAtHeight(docTop);
      const line = view.state.doc.lineAt(block.from).number - 1;
      const frac = block.height > 0 ? Math.min(1, Math.max(0, (docTop - block.top) / block.height)) : 0;
      return line + frac;
    };
    const onScroll = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      const atBottom = max > 0 && scroller.scrollTop >= max - 2;
      const atTop = scroller.scrollTop <= 2;
      const position = positionAt(scroller.scrollTop);
      // Also report where the bottom of the scroll lands, which the preview
      // uses as a virtual anchor for the end of the article
      syncRef.current.publish({
        position,
        endPosition: max > 0 ? positionAt(max) : position,
        atTop,
        atBottom,
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Content sync: when the draft changes (draftId) or value changes from the
  // outside (import, cleanup), replace the doc wholesale if it differs and keep
  // the caret where possible.
  // Edits and undos already wrote back through updateListener (cur === value),
  // so they never reach this path and neither typing nor undo is affected.



  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Changes typed here were already reported through updateListener, so skip
    // straight past — otherwise every keystroke would toString the whole
    // document just to compare it

    if (lastEmittedRef.current === value) return;
    const cur = view.state.doc.toString();
    if (cur === value) {
      lastEmittedRef.current = value;
      return;
    }
    const { anchor, head } = view.state.selection.main;
    lastEmittedRef.current = value;
    view.dispatch({
      changes: { from: 0, to: cur.length, insert: value },
      selection: { anchor: Math.min(anchor, value.length), head: Math.min(head, value.length) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, value]);

  // Outside jump: land on the given line and center it.
  // Declared after the content sync on purpose — on a cross-draft jump the new
  // document has to be in place before the line number means anything.

  useEffect(() => {
    if (!jumpRequest) return;
    const view = viewRef.current;
    if (!view) return;
    const lineNo = Math.min(Math.max(1, jumpRequest.line + 1), view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  }, [jumpRequest]);

  // Paste an image (⌘V / Ctrl+V straight after a screenshot)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const dom = view.dom;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (!files.length) return;
      e.preventDefault();
      void insertImages(files);
    };
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      void insertImages(files);
    };
    const onDragover = (e: DragEvent) => e.preventDefault();
    dom.addEventListener('paste', onPaste);
    dom.addEventListener('drop', onDrop);
    dom.addEventListener('dragover', onDragover);
    return () => {
      dom.removeEventListener('paste', onPaste);
      dom.removeEventListener('drop', onDrop);
      dom.removeEventListener('dragover', onDragover);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const charCount = useMemo(() => value.replace(/\s/g, '').length, [value]);
  /**
   * Estimated reading time.
   *
   * 400 characters a minute is the middle of the range usually quoted for
   * Chinese prose on a phone. It is a rough number and shown as one ("about"),
   * but for someone writing to a length it says far more than a raw count: the
   * question is never "how many characters", it is "how long is this to read".
   */
  const readMinutes = Math.max(1, Math.round(charCount / 400));
  /** Where this draft sits in the workspace, as breadcrumb segments */
  const pathSegs = useMemo(() => {
    const segs = draftId.split('/').filter(Boolean);
    const last = segs.pop();
    // The tree shows a text file by its title, so drop the extension here too
    if (last) segs.push(last.replace(/\.(md|markdown|txt)$/i, ''));
    return segs;
  }, [draftId]);
  /** WeChat caps a body at 20k characters: warn at 18000, red line at 20000 */
  const WARN_LIMIT = 18000;
  const HARD_LIMIT = 20000;
  const countLevel: 'normal' | 'warn' | 'over' =
    charCount >= HARD_LIMIT ? 'over' : charCount >= WARN_LIMIT ? 'warn' : 'normal';
  const countClass = `pane-stat count ${countLevel === 'warn' ? 'count-warn' : countLevel === 'over' ? 'count-over' : ''}`;

  /* ---------------- Markdown format toolbar ---------------- */

  /** Get the editor view, or null before it mounts */
  const withView = <T,>(fn: (view: EditorView) => T): T | null => {
    const view = viewRef.current;
    return view ? fn(view) : null;
  };

  /** Wrap the selection (bold / italic / inline code); with no selection,
   *  insert the pair and put the caret between them */
  const wrapSelection = (before: string, after: string) =>
    withView((view) => {
      const { from, to } = view.state.selection.main;
      const text = view.state.doc.sliceString(from, to);
      const sel = text ? { anchor: from + before.length, head: to + before.length } : { anchor: from + before.length };
      view.dispatch({ changes: [{ from, to, insert: before + text + after }], selection: sel });
      view.focus();
    });

  /** Prefix the line (heading / quote / list / task); applies to the whole
   *  line the caret is on */
  const prefixLine = (prefix: string) =>
    withView((view) => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({ changes: { from: line.from, insert: prefix }, selection: { anchor: line.from + prefix.length } });
      view.focus();
    });

  /** Insert a block at the caret (fence / rule / table) */
  const insertBlock = (text: string) =>
    withView((view) => {
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length } });
      view.focus();
    });

  /** Undo, through CodeMirror's history stack */
  const undoEdit = () => withView((view) => { undo(view); view.focus(); });

  /** Insert a 3×3 table template, caret in the first body cell */
  const insertTable = () =>
    withView((view) => {
      const head = view.state.selection.main.head;
      const table = '\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n';
      const bodyStart = head + table.indexOf('|  |');
      view.dispatch({ changes: { from: head, insert: table }, selection: { anchor: bodyStart + 2 } });
      view.focus();
    });

  /** Heading-level menu open state */
  const [headingOpen, setHeadingOpen] = useState(false);
  /** Outline drawer open state */
  const [outlineOpen, setOutlineOpen] = useState(false);
  const headingWrapRef = useRef<HTMLDivElement>(null);
  // Click outside to close
  useEffect(() => {
    if (!headingOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!headingWrapRef.current?.contains(e.target as Node)) setHeadingOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHeadingOpen(false);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [headingOpen]);

  /** Pull a heading outline (line number → title) out of the markdown; with the
   *  drawer closed, do not scan the document at all */
  const outline = useMemo(() => {
    if (!outlineOpen) return [];
    const items: { level: number; text: string; line: number }[] = [];
    value.split('\n').forEach((line, i) => {
      const m = line.match(/^(#{1,4})\s+(.+)$/);
      if (m) items.push({ level: m[1].length, text: m[2].trim(), line: i });
    });
    return items;
  }, [value, outlineOpen]);

  /** Click an outline entry: jump the editor to that line */
  const jumpToLine = (line: number) =>
    withView((view) => {
      view.dispatch({
        selection: { anchor: view.state.doc.line(line + 1).from },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(view.state.doc.line(line + 1).from, { y: 'center' }),
      });
      view.focus();
    });

  const headingLevels = [
    { level: 1, label: 'H1 · 一级标题', prefix: '# ' },
    { level: 2, label: 'H2 · 二级标题', prefix: '## ' },
    { level: 3, label: 'H3 · 三级标题', prefix: '### ' },
    { level: 4, label: 'H4 · 四级标题', prefix: '#### ' },
  ];

  const toolbarBtns: { key: string; title: string; icon: React.ReactNode; onClick: () => void }[] = [
    { key: 'bold', title: '加粗', icon: <TextB size={ICON} />, onClick: () => wrapSelection('**', '**') },
    { key: 'italic', title: '斜体', icon: <TextItalic size={ICON} />, onClick: () => wrapSelection('*', '*') },
    { key: 'code', title: '行内代码', icon: <Code size={ICON} />, onClick: () => wrapSelection('`', '`') },
    { key: 'quote', title: '引用', icon: <Quotes size={ICON} />, onClick: () => prefixLine('> ') },
    { key: 'list', title: '无序列表', icon: <ListBullets size={ICON} />, onClick: () => prefixLine('- ') },
    { key: 'task', title: '待办事项', icon: <ListChecks size={ICON} />, onClick: () => prefixLine('- [ ] ') },
    { key: 'fence', title: '代码块', icon: <CodeBlock size={ICON} />, onClick: () => insertBlock('\n```ts\n\n```\n') },
    { key: 'table', title: '表格', icon: <Table size={ICON} />, onClick: insertTable },
    { key: 'link', title: '链接', icon: <Link size={ICON} />, onClick: () => wrapSelection('[', '](https://)') },
    { key: 'hr', title: '分割线', icon: <Minus size={ICON} />, onClick: () => insertBlock('\n---\n') },
    { key: 'undo', title: '撤销', icon: <ArrowCounterClockwise size={ICON} />, onClick: undoEdit },
  ];

  return (
    <section
      ref={ref}
      className={`split-pane surface editor-side ${collapsed ? 'collapsed' : ''}`}
      style={{ width: `${widthPct}%` }}
    >
      <div className="pane-head">
        {/* Where the draft lives, rather than the word "source". The toolbar
            already names the open file; what it cannot say is which folder of a
            nested workspace you are actually in. */}
        <span className="pane-path" title={draftId}>
          {pathSegs.map((seg, i) => (
            <span key={i} className={i === pathSegs.length - 1 ? 'seg last' : 'seg'}>
              {seg}
            </span>
          ))}
          {saving && <span className="pane-saving">保存中</span>}
        </span>
        <div className="pane-head-right">
          <button
            className={`ghost-btn ${outlineOpen ? 'on' : ''}`}
            title="大纲"
            aria-label="大纲"
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((v) => !v)}
          >
            <ListDashes size={15} weight="bold" />
          </button>
          <span
            className={countClass}
            title={countLevel === 'over' ? '已超过微信 2 万字上限' : countLevel === 'warn' ? '接近微信 2 万字上限' : undefined}
          >
            {charCount} 字
          </span>
          <span className="pane-stat" title="按每分钟 400 字估算">
            约 {readMinutes} 分钟
          </span>
        </div>
      </div>
      {outlineOpen && (
        <div className="outline-drawer scroll-thin">
          {outline.length === 0 ? (
            <p className="outline-empty">还没有标题。用 <code>#</code> 开一行，大纲就长出来了。</p>
          ) : (
            outline.map((item, idx) => (
              <button
                key={idx}
                className={`outline-item lv${item.level}`}
                style={{ paddingLeft: `${8 + (item.level - 1) * 14}px` }}
                onClick={() => jumpToLine(item.line)}
              >
                {item.text}
              </button>
            ))
          )}
        </div>
      )}
      {/* Markdown format toolbar */}
      <div className="md-toolbar" role="toolbar" aria-label="Markdown 格式">
        {/* Heading-level dropdown */}
        <div className="md-toolbar-dropdown" ref={headingWrapRef}>
          <button
            className="md-toolbar-btn"
            title="标题（H1–H4）"
            aria-label="标题"
            aria-expanded={headingOpen}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              setHeadingOpen((v) => !v);
            }}
          >
            <TextH size={ICON} />
          </button>
          {headingOpen && (
            <div className="popover md-toolbar-menu" role="menu">
              {headingLevels.map((h) => {
                const HeadingIcon = HEADING_ICON[h.level as keyof typeof HEADING_ICON];
                return (
                  <button
                    key={h.level}
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setHeadingOpen(false);
                      prefixLine(h.prefix);
                    }}
                  >
                    <HeadingIcon size={17} className="menu-icon" />
                    {h.label.split('·')[1]?.trim()}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {toolbarBtns.map((b) => (
          <button key={b.key} className="md-toolbar-btn" title={b.title} aria-label={b.title} onClick={b.onClick}>
            {b.icon}
          </button>
        )).reduce<React.ReactNode[]>((acc, btn, i) => {
          // Logical clusters: bold|italic|code · quote|list|task · fence|table|link|rule · undo
          const groupEnd = [2, 5, 9];
          acc.push(btn);
          if (groupEnd.includes(i)) acc.push(<span key={`d${i}`} className="md-toolbar-divider"></span>);
          return acc;
        }, [])}
      </div>
      <div className="code-edit" ref={hostRef}></div>
    </section>
  );
});

export default EditorPane;
