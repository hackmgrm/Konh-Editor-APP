import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, Code, CodeBlock, Link, ListBullets, ListChecks, ListDashes, Minus, Quotes, Table, TextB, TextH, TextHFour, TextHOne, TextHThree, TextHTwo, TextItalic } from '@phosphor-icons/react';
import { Decoration, EditorView, ViewPlugin, keymap, lineNumbers } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { registerImageFiles } from '../images';
import Tooltip from './Tooltip';
import { EASE, EXIT_POPOVER, animate, usePresence } from '../usePresence';
import { hintFor } from '../shortcuts';
import { useEditorPrefs } from '../store/editorPrefs';
import type { ScrollSyncChannel } from '../scrollSync';

/* One size for every Phosphor icon; the H1–H4 menu items each use the glyph
   that matches their level. */
/* Icon weight, one rule for the app: a control gets `bold` at 15, a glyph
   naming a file or a piece of content gets `regular` at 14. The format strip
   is controls, so it is bold — which also stops it reading as a row of
   hairlines once the toolbar dims away from the caret. */
const ICON = 15;
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
  '&': { height: '100%', fontSize: '14px', color: 'var(--text-1)' },
  // The writing surface is set in the app's own proportional face, not in
  // the monospace one. `--mono` lists the UI font in its CJK tail so that Han
  // at least matched the rest of the app, but a Chinese glyph rendered at a
  // monospace face's size next to Latin that *is* monospaced still came out
  // lighter and narrower than the same sentence in the preview — the source
  // read grey beside the article it produces. Proportional, a notch larger,
  // a hair tighter in the leading: the two columns now read as one document.
  // Code keeps `--mono`, one rule down in markdownHighlight.
  '.cm-scroller': {
    fontFamily: 'var(--sans)',
    lineHeight: '1.75',
    overflow: 'auto',
  },
  // paddingLeft is deliberately absent: it is the one edge that depends on
  // whether the gutter is there, so it is declared once, in the compartment
  // below, and nowhere else. Two rules setting it would leave the result at
  // the mercy of which theme CodeMirror happens to mount last.
  '.cm-content': { paddingTop: '18px', paddingRight: '24px', paddingBottom: '28px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 4px' },
  // See `fencedCode` below: the whole block, fences included, in the face the
  // prose gave up. Set at the same 0.93em the inline `code` spans use, so an
  // expression reads the same size whichever of the two it is sitting in.
  '.cm-fenced': { fontFamily: 'var(--mono)', fontSize: '0.93em' },
  // A fence with no language tagged after it is `CodeText`, which @lezer
  // /markdown marks as `monospace` — the same tag inline `code` carries, and
  // the same 0.93em. Sitting inside a line that has already been scaled, that
  // second 0.93 compounds and a plain fence comes out a step smaller than the
  // fence above it with `ts` on it. The size belongs to the line here, so the
  // spans inside give it up.
  '.cm-fenced span': { fontSize: '1em' },
  // Line numbers are scaffolding, not content: you look for one when you need
  // it and never otherwise. At full --text-3 the column read as another line
  // of meta running down the page, so it is mixed most of the way out —
  // a whisper you can still count by. Tabular figures keep the column from
  // shifting as it passes 9, 99, 999. It keeps the monospace face the prose
  // gave up: these are figures in a column, which is the one thing a mono
  // stack is unambiguously better at.
  '.cm-gutters': {
    background: 'transparent',
    color: 'color-mix(in srgb, var(--text-3) 62%, transparent)',
    fontFamily: 'var(--mono)',
    fontSize: '11.5px',
    fontVariantNumeric: 'tabular-nums',
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
 * The gutter, and the text inset that goes with it.
 *
 * Switching the line numbers off drops the whole column — CodeMirror only
 * builds a gutter when an extension asks for one — so there is no empty 28px
 * channel left behind. What is left behind is the inset: the content's left
 * padding was written to sit *after* that column, and with the column gone
 * the first character no longer lines up with anything. So the two travel
 * together. Gutter off, the prose starts exactly where the toolbar's H glyph
 * does, and the pane reads as one left edge from the chrome down.
 */
const withGutter = [lineNumbers(), EditorView.theme({ '.cm-content': { paddingLeft: '20px' } })];
const withoutGutter = EditorView.theme({ '.cm-content': { paddingLeft: '18px' } });

/**
 * Fenced code blocks, kept monospace.
 *
 * With the prose in a proportional face this is the one thing that has to opt
 * out, and the highlighter cannot do it on its own: `t.monospace` reaches
 * inline `code` spans, but the moment a fence names a language its contents
 * are parsed by that language and tagged as keywords, strings and names —
 * none of which is a "this is code" tag you could hang a font on. The block
 * is a property of the *line*, not of any token inside it, so it is marked as
 * one: every line from the opening fence to the closing one gets a class, and
 * the class carries the face.
 *
 * Doing it per line rather than per token is also what keeps a fence's
 * indentation and its blank rows in the same rhythm as its code.
 */
const fencedCodeLine = Decoration.line({ class: 'cm-fenced' });

function fencedCodeDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return;
        const last = view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).number;
        for (let n = view.state.doc.lineAt(node.from).number; n <= last; n++) {
          builder.add(view.state.doc.line(n).from, view.state.doc.line(n).from, fencedCodeLine);
        }
      },
    });
  }
  return builder.finish();
}

const fencedCode = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = fencedCodeDecorations(view);
    }
    update(update: ViewUpdate) {
      // The tree is parsed incrementally, so "the highlighting changed" is its
      // own reason to rebuild — a fence can finish parsing a frame after the
      // edit that opened it
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = fencedCodeDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
  // Heading sizes are set against the proportional body face, which carries
  // more weight per pixel than the monospace one did — the old 1.2 / 1.1 pair
  // read as barely-bigger body text next to it. Three steps now, each one
  // clearly the level above the next, and H1 still well short of the
  // preview's display size: this is the source, not the article.
  { tag: t.heading1, fontWeight: '700', fontSize: '1.35em', color: 'var(--text-1)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.2em', color: 'var(--text-1)' },
  { tag: t.heading3, fontWeight: '700', fontSize: '1.08em', color: 'var(--text-1)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--text-1)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text-1)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-3)' },
  { tag: [t.link, t.url], color: 'var(--accent-hi)', textUnderlineOffset: '2px' },
  // The one place the mono face survives. @lezer/markdown puts `monospace` on
  // inline code *and* on the text inside a fenced block, so this single rule
  // covers both. Slightly down-sized: a monospace face set at the body's own
  // size always looks a size too big beside proportional text.
  { tag: t.monospace, color: 'var(--accent-hi)', fontFamily: 'var(--mono)', fontSize: '0.93em' },
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
  /** The heading outline drawer. Owned by App so ⌘⇧O and the command palette
   *  can reach it too */
  outlineOpen: boolean;
  onOutlineOpen: (open: boolean) => void;
  /**
   * An outside jump request (clicking an image in the file tree lands on its
   * reference). The nonce distinguishes "the same line, requested again" —
   * without it, clicking the same image twice would not re-run the effect.
   */
  jumpRequest: { line: number; nonce: number } | null;
}

const EditorPane = forwardRef<HTMLElement, Props>(function EditorPane(
  {
    value,
    onChange,
    onAddImage,
    imageNames,
    draftId,
    sync,
    collapsed,
    widthPct,
    outlineOpen,
    onOutlineOpen,
    jumpRequest,
  },
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
  /** Line numbers on/off, shared with the switch in the typeset popover */
  const { lineNumbers: showLineNumbers } = useEditorPrefs();
  // Swapping the gutter in and out goes through a compartment rather than
  // through a remount: rebuilding the editor would throw away the undo
  // history and the scroll position every time the switch was touched.
  const gutterComp = useRef(new Compartment()).current;
  const showLineNumbersRef = useRef(showLineNumbers);
  showLineNumbersRef.current = showLineNumbers;

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
          gutterComp.of(showLineNumbersRef.current ? withGutter : withoutGutter),
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
          fencedCode,
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
      // A scroll here may be the reader's, or it may be this pane following
      // the preview — the event is identical either way. The channel decides,
      // and while the preview has the wheel this reports nothing
      if (!syncRef.current.canDrive('editor')) return;
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
        source: 'editor',
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /**
     * Preview → editor.
     *
     * The other direction, and the one that was missing: reading the rendered
     * article and wanting to fix a sentence meant scrolling the preview and
     * then hunting for the same paragraph in the source. The preview sends
     * back a source position and this puts the editor's top edge on it.
     *
     * `scrollTop` rather than a CodeMirror `scrollIntoView` dispatch: an
     * effect that arrives sixty times a second must not go through the
     * editor's transaction system, and this pane is a follower here — nothing
     * about the document or the selection is changing.
     */
    let raf = 0;
    const follow = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const channel = syncRef.current;
        if (!channel.shouldFollow('editor')) return;
        const { position, atTop, atBottom } = channel.state;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (atTop) {
          if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
          return;
        }
        if (atBottom) {
          scroller.scrollTop = max;
          return;
        }
        const doc = view.state.doc;
        const line = Math.min(doc.lines, Math.max(1, Math.floor(position) + 1));
        const block = view.lineBlockAt(doc.line(line).from);
        const frac = Math.min(1, Math.max(0, position - Math.floor(position)));
        const top = view.documentPadding.top + block.top + block.height * frac;
        if (Math.abs(scroller.scrollTop - top) < 0.5) return;
        scroller.scrollTop = Math.min(max, Math.max(0, top));
      });
    };
    const unsubscribe = syncRef.current.subscribe(follow);

    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', onScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Line numbers on / off, live. One reconfigure of the compartment — the
  // document, the history and the scroll position all stay exactly as they
  // were, so the column appears under your caret rather than around a
  // rebuilt editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: gutterComp.reconfigure(showLineNumbers ? withGutter : withoutGutter),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLineNumbers]);

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

  /**
   * Cross-fade the editor when the draft under it changes.
   *
   * Switching drafts replaces the whole document in one dispatch, and a page
   * of text swapped for a different page of text between two frames reads as a
   * glitch rather than as navigation. The new text comes up from dimmed
   * instead — short enough that it never feels like waiting.
   */
  useLayoutEffect(() => {
    animate(hostRef.current, [{ opacity: 0.42 }, { opacity: 1 }], {
      duration: 140,
      easing: EASE,
    });
  }, [draftId]);

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
  const headingPresence = usePresence(headingOpen, EXIT_POPOVER);
  /** The drawer folds shut over its own height, so it outlives `outlineOpen` */
  const outlinePresence = usePresence(outlineOpen, 180);
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
   *  drawer gone, do not scan the document at all */
  const outline = useMemo(() => {
    // Gated on `mounted`, not on `open`. The drawer folds shut over 180ms and
    // stays in the tree for all of it, so emptying the list the moment the
    // button is pressed does not hide anything — it swaps the headings for
    // 「还没有标题」 and plays *that* out. Scanning stops when the element
    // actually leaves, which is the point of the presence hook.
    if (!outlinePresence.mounted) return [];
    const items: { level: number; text: string; line: number }[] = [];
    value.split('\n').forEach((line, i) => {
      const m = line.match(/^(#{1,4})\s+(.+)$/);
      if (m) items.push({ level: m[1].length, text: m[2].trim(), line: i });
    });
    return items;
  }, [value, outlinePresence.mounted]);

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
    { key: 'bold', title: '加粗', icon: <TextB size={ICON} weight="bold" />, onClick: () => wrapSelection('**', '**') },
    { key: 'italic', title: '斜体', icon: <TextItalic size={ICON} weight="bold" />, onClick: () => wrapSelection('*', '*') },
    { key: 'code', title: '行内代码', icon: <Code size={ICON} weight="bold" />, onClick: () => wrapSelection('`', '`') },
    { key: 'quote', title: '引用', icon: <Quotes size={ICON} weight="bold" />, onClick: () => prefixLine('> ') },
    { key: 'list', title: '无序列表', icon: <ListBullets size={ICON} weight="bold" />, onClick: () => prefixLine('- ') },
    { key: 'task', title: '待办事项', icon: <ListChecks size={ICON} weight="bold" />, onClick: () => prefixLine('- [ ] ') },
    { key: 'fence', title: '代码块', icon: <CodeBlock size={ICON} weight="bold" />, onClick: () => insertBlock('\n```ts\n\n```\n') },
    { key: 'table', title: '表格', icon: <Table size={ICON} weight="bold" />, onClick: insertTable },
    { key: 'link', title: '链接', icon: <Link size={ICON} weight="bold" />, onClick: () => wrapSelection('[', '](https://)') },
    { key: 'hr', title: '分割线', icon: <Minus size={ICON} weight="bold" />, onClick: () => insertBlock('\n---\n') },
    { key: 'undo', title: '撤销', icon: <ArrowCounterClockwise size={ICON} weight="bold" />, onClick: undoEdit },
  ];

  return (
    <section
      ref={ref}
      className={`split-pane editor-side ${collapsed ? 'collapsed' : ''}`}
      style={{ width: `${widthPct}%` }}
    >
      <div className="pane-head">
        {/* The format strip lives in the head now, on the left the folder
            breadcrumb used to hold: one row of chrome above the writing
            instead of two. Which folder the draft sits in moved up to the
            toolbar, beside the file's name, where the save dot already is. */}
        <div className="md-toolbar" role="toolbar" aria-label="Markdown 格式">
          {/* Heading-level dropdown */}
          <div className="md-toolbar-dropdown" ref={headingWrapRef}>
            <Tooltip content="标题（H1–H4）">
              <button
                className="md-toolbar-btn"
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
            </Tooltip>
            {headingPresence.mounted && (
              <div className="popover md-toolbar-menu" role="menu" data-state={headingPresence.state}>
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
            <Tooltip key={b.key} content={b.title}>
              <button className="md-toolbar-btn" aria-label={b.title} onClick={b.onClick}>
                {b.icon}
              </button>
            </Tooltip>
          )).reduce<React.ReactNode[]>((acc, btn, i) => {
            // Logical clusters: bold|italic|code · quote|list|task · fence|table|link|rule · undo
            const groupEnd = [2, 5, 9];
            acc.push(btn);
            if (groupEnd.includes(i)) acc.push(<span key={`d${i}`} className="md-toolbar-divider"></span>);
            return acc;
          }, [])}
        </div>
        <div className="pane-head-right">
          <Tooltip content="大纲" shortcut={hintFor('outline')}>
            <button
              className={`ghost-btn ${outlineOpen ? 'on' : ''}`}
              aria-label="大纲"
              aria-expanded={outlineOpen}
              onClick={() => onOutlineOpen(!outlineOpen)}
            >
              <ListDashes size={15} weight="bold" />
            </button>
          </Tooltip>
          <Tooltip
            content={
              countLevel === 'over'
                ? '已超过微信 2 万字上限'
                : countLevel === 'warn'
                  ? '接近微信 2 万字上限'
                  : '正文字数，不算空白'
            }
          >
            <span className={countClass}>{charCount} 字</span>
          </Tooltip>
          <Tooltip content="按每分钟 400 字估算">
            <span className="pane-stat">约 {readMinutes} 分钟</span>
          </Tooltip>
        </div>
      </div>
      {outlinePresence.mounted && (
        <div className="outline-drawer scroll-thin" data-state={outlinePresence.state}>
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
      <div className="code-edit" ref={hostRef}></div>
    </section>
  );
});

export default EditorPane;
