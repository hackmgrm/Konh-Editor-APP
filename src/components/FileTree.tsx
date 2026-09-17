import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Tooltip from "./Tooltip";
import EmptyState from "./EmptyState";
import { EXIT_POPOVER, usePresence } from "../usePresence";
import { hintFor } from "../shortcuts";
import {
  Broom,
  CaretDown,
  CaretRight,
  CaretUpDown,
  File as FileIcon,
  FileMd,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  GearSix,
  GithubLogo,
  Globe,
  Image as ImageIcon,
  PencilSimple,
  Plus,
  Trash,
  XLogo,
} from "@phosphor-icons/react";
import type { Draft, Entry } from "../store/vault";
import { isImagePath, isTextPath, parentOf } from "../store/vault";

interface Props {
  /** Absolute path of the current workspace */
  vaultDir: string;
  /** Switch workspaces (opens the native directory picker) */
  onChangeVault: () => void;
  /** The workspace's actual directory tree */
  tree: Entry[];
  /** Text files already read into memory, used for the word counts */
  drafts: Draft[];
  /** The open draft (relative path) */
  activeId: string;
  /** Image relative path → data URI, for thumbnails */
  images: Record<string, string>;
  /** Images referenced by a body (both bare names and full paths count) */
  usedImageRefs: Set<string>;
  /** Open a text file */
  onOpen: (path: string) => void;
  /** Click an image: jump to where the body references it */
  onLocateImage: (path: string) => void;
  /** A file we cannot open: hand it to the system file manager */
  onReveal: (path: string) => void;
  onNewDraft: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  /** Turn a web page into a draft, dropped into `parent` (see reader.ts) */
  onImportUrl: (parent: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
  /** Drag-move: put `path` inside the `toParent` directory (empty = root) */
  onMove: (path: string, toParent: string) => void;
  /** Sweep every image that no body references */
  onCleanupImages: () => void;
  /** Open settings (公众号凭据). Lives down here, out of the writing loop:
   *  it is configured once and then forgotten, like the links beside it */
  onOpenSettings: () => void;
}

/** Relative time: easier to read in a list than an absolute timestamp */
function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Cache of probed dimensions: decoding once is enough, and keying on length
 *  means a replaced image invalidates itself */
const dimCache = new Map<string, { w: number; h: number }>();

function dimKey(path: string, dataUrl: string): string {
  return `${path}:${dataUrl.length}`;
}

function probeSize(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Strip the extension — the tree shows a text file's title, not its file name */
function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** How long a row takes to leave, and how far apart the stagger sets them */
const ROW_EXIT_MS = 140;
const STAGGER_MS = 12;
const STAGGER_MAX = 8;

/** One row: a node in the tree plus its depth */
interface Row {
  entry: Entry;
  depth: number;
}

/** What is expanded decides what gets drawn; this flattens the tree into rows */
function toRows(
  entries: Entry[],
  expanded: Set<string>,
  depth = 0,
  out: Row[] = [],
): Row[] {
  for (const entry of entries) {
    out.push({ entry, depth });
    if (entry.isDir && entry.children && expanded.has(entry.path)) {
      toRows(entry.children, expanded, depth + 1, out);
    }
  }
  return out;
}

/** Where the context menu is, and what it targets */
interface Menu {
  x: number;
  y: number;
  entry: Entry | null; // null = empty space, so the target is the workspace root
}

/**
 * File tree panel: shows what is actually in the workspace folder.
 *
 * A workspace is an ordinary folder, so the tree is a real tree rather than
 * two fixed groups: subdirectories, images and other file types all listed as
 * they are, with create / rename / delete / drag-move going straight to disk.
 *
 * The drag-move below is plain HTML5 drag and drop, and it only works because
 * `dragDropEnabled` is false in tauri.conf.json. Left at its default, WebView2
 * hands every drag to Tauri's own native handler before the page sees it, and
 * on Windows — only there — dragstart/dragover/drop never fire at all: rows
 * refuse to pick up, and an image dropped on the editor does nothing. JSON has
 * nowhere to write that down, so it is written down here.
 */
export default function FileTree({
  vaultDir,
  onChangeVault,
  tree,
  drafts,
  activeId,
  images,
  usedImageRefs,
  onOpen,
  onLocateImage,
  onReveal,
  onNewDraft,
  onNewFolder,
  onImportUrl,
  onRename,
  onDelete,
  onMove,
  onCleanupImages,
  onOpenSettings,
}: Props) {
  /** Expanded directories. All collapsed by default; opening a draft expands
   *  the whole path down to it */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  /** The item currently being dragged */
  const [dragPath, setDragPath] = useState<string | null>(null);
  /** Which directory it is over (empty = root, null = not over a valid target) */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /**
   * Where a line is drawn between two rows.
   *
   * Dropping on a file means "into the folder this file is in" — which the
   * folder highlight says for a folder, and said nothing at all for a file:
   * the row lit up and you had to know that it meant its parent. A rule drawn
   * at the row's near edge, indented to that level, shows the level the file
   * is about to join.
   */
  const [dropLine, setDropLine] = useState<{ path: string; where: 'before' | 'after' } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuPresence = usePresence(menu !== null, EXIT_POPOVER);
  /** The menu outlives its own state by one animation, so it keeps its items */
  const lastMenu = useRef<Menu | null>(menu);
  if (menu) lastMenu.current = menu;
  const menuRef = useRef<HTMLDivElement>(null);
  /** The head's 「+」 menu — the three ways to create something, collapsed
   *  behind one button so the rail's eyebrow carries one glyph, not three */
  const [addOpen, setAddOpen] = useState(false);
  const addPresence = usePresence(addOpen, EXIT_POPOVER);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  /**
   * Which row the keyboard is on.
   *
   * The tree is one tab stop, not one per file: a workspace with forty drafts
   * should not cost forty presses of Tab to get past. Inside it, the arrows do
   * what they do in every file tree ever made.
   */
  const [cursor, setCursor] = useState<string | null>(null);
  /** Set when a key moved the cursor, so the effect below knows to chase it
   *  with real DOM focus — but leaves the mouse alone */
  const chaseRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Rows that just appeared, and how far down the stagger they sit */
  const [entering, setEntering] = useState<Map<string, number>>(new Map());
  /** A folder whose children are playing their exit; the actual collapse waits
   *  for them (see `toggle`) */
  const [collapsing, setCollapsing] = useState<string | null>(null);
  const collapseTimer = useRef<number | null>(null);
  /** Read the clock once at mount rather than on every render */
  const [now] = useState(() => Date.now());

  /** The open draft has to be visible: expand every directory above it */
  useEffect(() => {
    if (!activeId.includes("/")) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const segs = activeId.split("/");
      for (let i = 1; i < segs.length; i++)
        next.add(segs.slice(0, i).join("/"));
      return next;
    });
  }, [activeId]);

  useEffect(() => {
    if (renamingPath) renameInputRef.current?.select();
  }, [renamingPath]);

  // Click elsewhere or press Esc to close the context menu
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // The menu lives in a portal on <body>, so it is measured against the window:
  // if it would run off the right or bottom edge, flip it back over the cursor.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    const x =
      menu.x + width + pad > window.innerWidth
        ? Math.max(pad, menu.x - width)
        : menu.x;
    const y =
      menu.y + height + pad > window.innerHeight
        ? Math.max(pad, window.innerHeight - height - pad)
        : menu.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.transformOrigin = `${x < menu.x ? "right" : "left"} ${y < menu.y ? "bottom" : "top"}`;
  }, [menu]);

  // Close the 「+」 menu on an outside press or Esc.
  //
  // pointerdown rather than click, and the trigger excluded by attribute: React
  // flushes this effect before the click that opened the menu has finished
  // bubbling to the document, so a click listener would shut the menu inside
  // the very event that opened it (the same trap the typeset popover fell into
  // — see Toolbar.tsx).
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (addMenuRef.current?.contains(target)) return;
      if (target?.closest("[data-tree-add-trigger]")) return;
      setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setAddOpen(false);
      // Esc means "never mind": the focus goes back where the press started
      addBtnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  // Anchored under the button and right-aligned to it, measured against the
  // window because the menu lives in a portal on <body>
  useLayoutEffect(() => {
    const el = addMenuRef.current;
    const btn = addBtnRef.current;
    if (!addOpen || !el || !btn) return;
    const pad = 8;
    const anchor = btn.getBoundingClientRect();
    // offsetWidth, not a bounding rect: this runs on the first frame of the
    // pop-in, where the menu is still scaled to 0.96 — measuring the rect
    // would right-align the menu to a width it is about to outgrow
    const { offsetWidth: width, offsetHeight: height } = el;
    const left = Math.max(pad, Math.min(anchor.right - width, window.innerWidth - width - pad));
    const top = Math.min(anchor.bottom + 6, Math.max(pad, window.innerHeight - height - pad));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    // Straight into the menu: it was opened to be chosen from
    el.querySelector<HTMLElement>(".menu-item")?.focus();
  }, [addOpen, addPresence.mounted]);

  /** ↑↓ cycle the items — a menu is a ring, not a list that dead-ends */
  const onAddMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(".menu-item"),
    );
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  };

  /** Open one overlay or the other, never both */
  const openMenu = (next: Menu) => {
    setAddOpen(false);
    setMenu(next);
  };

  const rows = useMemo(() => toRows(tree, expanded), [tree, expanded]);
  const draftById = useMemo(
    () => new Map(drafts.map((d) => [d.id, d])),
    [drafts],
  );

  /** Dimensions are decoded asynchronously; bump this counter once the cache
   *  fills to trigger a re-layout */
  const [dimTick, setDimTick] = useState(0);
  // Only decode what is currently on screen: nobody is looking at the images
  // inside a collapsed folder, so they are not worth a decode
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let added = false;
      for (const { entry } of rows) {
        const dataUrl = images[entry.path];
        if (!dataUrl) continue;
        const key = dimKey(entry.path, dataUrl);
        if (dimCache.has(key)) continue;
        const size = await probeSize(dataUrl);
        if (cancelled) return;
        if (size) {
          dimCache.set(key, size);
          added = true;
        }
      }
      if (added && !cancelled) setDimTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, images]);

  /** Read an already-probed size. dimTick is only the "cache grew" signal and
   *  takes no part in the computation */
  const dimOf = useMemo(
    () => (path: string, dataUrl: string) =>
      dimCache.get(dimKey(path, dataUrl)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dimTick],
  );

  /** How many images no body references — the cleanup entry only appears when
   *  there is something to clean */
  const unusedImages = useMemo(
    () =>
      Object.keys(images).filter((p) => {
        const name = p.split("/").pop() ?? p;
        return !usedImageRefs.has(name) && !usedImageRefs.has(p);
      }),
    [images, usedImageRefs],
  );

  /**
   * Fold a directory open or shut.
   *
   * Opening is immediate — the new rows animate themselves in. Closing waits
   * out the children's exit first: rows that are simply dropped from the list
   * blink out of existence and the ones below snap upward, which is the exact
   * moment a tree stops feeling like a physical thing.
   */
  const toggle = (path: string) => {
    if (!expanded.has(path)) {
      setExpanded((prev) => new Set(prev).add(path));
      return;
    }
    if (collapsing) return;
    setCollapsing(path);
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      setCollapsing(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }, ROW_EXIT_MS);
  };

  useEffect(
    () => () => {
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    },
    [],
  );

  /**
   * Which rows are new since the last render, for the staggered entrance.
   *
   * Capped at eight: past that the stagger stops reading as one gesture and
   * starts reading as a slow list, and a folder of forty files would spend
   * half a second assembling itself.
   */
  const seenRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const now = new Set(rows.map((r) => r.entry.path));
    const fresh: string[] = [];
    for (const path of now) if (!seenRef.current.has(path)) fresh.push(path);
    seenRef.current = now;
    if (!fresh.length) return;
    setEntering(new Map(fresh.slice(0, STAGGER_MAX).map((path, i) => [path, i])));
    const timer = window.setTimeout(() => setEntering(new Map()), ROW_EXIT_MS + STAGGER_MAX * STAGGER_MS);
    return () => window.clearTimeout(timer);
  }, [rows]);

  // Chase the cursor with real focus, but only when a key moved it
  useEffect(() => {
    if (!chaseRef.current || !cursor) return;
    chaseRef.current = false;
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-row="${CSS.escape(cursor)}"]`)
      ?.focus();
  }, [cursor, rows]);

  const moveCursor = (path: string | null) => {
    if (!path) return;
    chaseRef.current = true;
    setCursor(path);
  };

  /** ↑↓ walk the visible rows, ←→ fold, Enter opens, F2 renames, Delete asks */
  const onRowKeyDown = (e: React.KeyboardEvent, entry: Entry, index: number) => {
    const { path, isDir } = entry;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)];
        moveCursor(next?.entry.path ?? null);
        return;
      }
      case 'ArrowRight': {
        // On a file this does nothing on purpose: there is nothing to open
        if (!isDir) return;
        e.preventDefault();
        if (!expanded.has(path)) toggle(path);
        else moveCursor(rows[index + 1]?.entry.path ?? null);
        return;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (isDir && expanded.has(path)) {
          toggle(path);
          return;
        }
        // Otherwise go up a level, which is where ← means "out of here"
        const parent = parentOf(path);
        if (parent) moveCursor(parent);
        return;
      }
      case 'Enter':
        e.preventDefault();
        activate(entry);
        return;
      case 'F2':
        e.preventDefault();
        startRename(entry);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        onDelete(path);
        return;
    }
  };

  function startRename(entry: Entry) {
    setRenamingPath(entry.path);
    setRenameValue(
      entry.isDir || !isTextPath(entry.path) ? entry.name : stemOf(entry.name),
    );
  }

  const submitRename = () => {
    if (renamingPath && renameValue.trim())
      onRename(renamingPath, renameValue.trim());
    setRenamingPath(null);
    setRenameValue("");
  };

  /** Click a row: folders toggle, text opens in the editor, images jump to
   *  their reference, anything else goes to the system */
  function activate(entry: Entry) {
    if (entry.isDir) toggle(entry.path);
    else if (isTextPath(entry.path)) onOpen(entry.path);
    else if (isImagePath(entry.path)) onLocateImage(entry.path);
    else onReveal(entry.path);
  }

  /** Dropping onto a file means its directory — the gesture means "put it at
   *  this level" */
  const dropDirOf = (entry: Entry) =>
    entry.isDir ? entry.path : parentOf(entry.path);

  /**
   * The thing that follows the pointer while dragging a row.
   *
   * The browser's default is a translucent photograph of the whole row —
   * including its hover background, the actions that were revealed under the
   * pointer, and the file size at the far right, stretched across the width of
   * the rail. What is being dragged is one file, so the picture of it should
   * be one file: its glyph and its name, in a small capsule.
   *
   * It has to be in the document and painted for `setDragImage` to snapshot
   * it, hence the off-screen position and the removal on the next tick — by
   * then the browser has taken its copy.
   */
  const makeDragGhost = (row: HTMLElement, name: string) => {
    const ghost = document.createElement("div");
    ghost.className = "tree-drag-ghost";
    // The row's own glyph, not a guess at which one it should be. The caret is
    // excluded: it belongs to the tree, not to the file
    const icon = row.querySelector(".tree-file-main svg:not(.tree-caret)");
    if (icon) ghost.appendChild(icon.cloneNode(true));
    const label = document.createElement("span");
    label.textContent = name;
    ghost.appendChild(label);
    document.body.appendChild(ghost);
    window.setTimeout(() => ghost.remove(), 0);
    return ghost;
  };

  const finishDrop = (toParent: string) => {
    const from = dragPath;
    setDragPath(null);
    setDropTarget(null);
    setDropLine(null);
    if (!from) return;
    // Neither a no-op move nor dragging a directory into itself (which would
    // take the whole subtree with it) needs to bother the disk
    if (
      parentOf(from) === toParent ||
      toParent === from ||
      toParent.startsWith(`${from}/`)
    )
      return;
    onMove(from, toParent);
  };

  /**
   * The three ways to make something new.
   *
   * Both menus offer them — the head's 「+」 into the workspace root, the
   * right-click menu into whatever was clicked — and they are written once so
   * the two can never drift into different words for the same act.
   */
  const createItems = (parent: string, close: () => void) => (
    <>
      <button
        className="menu-item"
        role="menuitem"
        onClick={() => {
          close();
          onNewDraft(parent);
        }}
      >
        <FilePlus size={16} className="menu-icon" />
        新建草稿
        <span className="menu-hint">{hintFor("newDraft")}</span>
      </button>
      <button
        className="menu-item"
        role="menuitem"
        onClick={() => {
          close();
          onNewFolder(parent);
        }}
      >
        <FolderPlus size={16} className="menu-icon" />
        新建文件夹
      </button>
      <button
        className="menu-item"
        role="menuitem"
        onClick={() => {
          close();
          onImportUrl(parent);
        }}
      >
        <Globe size={16} className="menu-icon" />
        从链接导入
      </button>
    </>
  );

  const renderRow = ({ entry, depth }: Row, index: number) => {
    const { path, name, isDir } = entry;
    const active = path === activeId;
    const indent = { paddingLeft: 6 + depth * 11 };
    // A row of a folder that is folding shut plays its exit; one that has just
    // appeared plays its entrance, staggered by where it sits in the run
    const leaving = !!collapsing && path.startsWith(`${collapsing}/`);
    const enterAt = entering.get(path);

    if (renamingPath === path) {
      return (
        <div key={path} className="tree-file renaming" style={indent}>
          {isDir ? <Folder size={14} /> : <FileMd size={14} />}
          <input
            ref={renameInputRef}
            className="tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setRenamingPath(null);
            }}
            onBlur={submitRename}
          />
        </div>
      );
    }

    const dataUrl = images[path];
    const draft = draftById.get(path);
    const dim = dataUrl ? dimOf(path, dataUrl) : undefined;
    const unusedImage = !!dataUrl && unusedImages.includes(path);

    let icon = <FileIcon size={14} />;
    if (isDir)
      icon = expanded.has(path) ? (
        <FolderOpen size={14} />
      ) : (
        <Folder size={14} />
      );
    else if (isTextPath(path)) icon = <FileMd size={14} />;
    else if (dataUrl)
      icon = <img className="tree-thumb" src={dataUrl} alt="" />;
    else if (isImagePath(path)) icon = <ImageIcon size={14} />;

    // Single line per row, so the secondary column has to be short: the full
    // story lives in the row's title attribute.
    let meta = "";
    let full = path;
    if (isDir) meta = `${entry.children?.length ?? 0} 项`;
    else if (draft) {
      const words = draft.content.replace(/\s/g, "").length;
      meta = words > 999 ? `${(words / 1000).toFixed(1)}k 字` : `${words} 字`;
      full = `${path}\n${words} 字 · ${relativeTime(entry.updatedAt, now)}`;
    } else if (dataUrl) {
      meta = formatBytes(entry.size);
      full = `${path}\n${dim ? `${dim.w}×${dim.h} · ` : ""}${formatBytes(entry.size)}${unusedImage ? " · 还没有草稿引用它" : ""}`;
    } else if (!isTextPath(path)) {
      meta = formatBytes(entry.size);
      full = `${path} — 右键有更多操作`;
    }

    return (
      <div
        key={path}
        className={[
          "tree-file",
          active ? "active" : "",
          unusedImage ? "unused" : "",
          dragPath === path ? "dragging" : "",
          // Highlight only the folder that would actually catch it, or every
          // sibling file at that level lights up too
          isDir && dragPath && dropTarget === path ? "drop-into" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="treeitem"
        aria-selected={active}
        aria-expanded={isDir ? expanded.has(path) : undefined}
        data-state={leaving ? 'exit' : undefined}
        data-enter={enterAt !== undefined ? '' : undefined}
        style={
          enterAt !== undefined || leaving
            ? ({ '--row-i': enterAt ?? 0 } as React.CSSProperties)
            : undefined
        }
        data-drop={dropLine?.path === path ? dropLine.where : undefined}
        draggable
        onDragStart={(e) => {
          setDragPath(path);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", path);
          e.dataTransfer.setDragImage(makeDragGhost(e.currentTarget, name), 16, 15);
        }}
        onDragEnd={() => {
          setDragPath(null);
          setDropTarget(null);
          setDropLine(null);
        }}
        onDragOver={(e) => {
          if (!dragPath) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDropTarget(dropDirOf(entry));
          // A folder says where it is going by lighting up; a file has to say
          // it with a rule, and which edge it is drawn on follows the pointer
          // so the gesture reads as aiming between two rows
          if (isDir || path === dragPath) {
            setDropLine(null);
          } else {
            const r = e.currentTarget.getBoundingClientRect();
            setDropLine({ path, where: e.clientY < r.top + r.height / 2 ? "before" : "after" });
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          finishDrop(dropDirOf(entry));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ x: e.clientX, y: e.clientY, entry });
        }}
      >
        <button
          className="tree-file-main"
          style={indent}
          data-row={path}
          // One tab stop for the whole tree; the arrows move inside it.
          // `||` rather than `??`: with no draft open activeId is the empty
          // string, and a nullish fallback would leave no row reachable at all
          tabIndex={(cursor || activeId || rows[0]?.entry.path) === path ? 0 : -1}
          onFocus={() => setCursor(path)}
          onKeyDown={(e) => onRowKeyDown(e, entry, index)}
          onClick={() => activate(entry)}
          title={full}
        >
          {isDir ? (
            expanded.has(path) ? (
              <CaretDown size={11} weight="bold" className="tree-caret" />
            ) : (
              <CaretRight size={11} weight="bold" className="tree-caret" />
            )
          ) : (
            <span className="tree-caret" />
          )}
          {icon}
          <span className="tree-file-name">
            {isTextPath(path) ? stemOf(name) : name}
          </span>
          {unusedImage && (
            <span className="tree-dot-unused" title="还没有草稿引用它" />
          )}
        </button>
        {meta && <span className="tree-file-meta">{meta}</span>}
        <span className="tree-file-actions">
          <Tooltip content="重命名" shortcut="F2" side="left">
            <button aria-label={`重命名 ${name}`} onClick={() => startRename(entry)}>
              <PencilSimple size={14} weight="regular" />
            </button>
          </Tooltip>
          <Tooltip content="删除" shortcut="Delete" side="left">
            <button aria-label={`删除 ${name}`} onClick={() => onDelete(path)}>
              <Trash size={14} weight="regular" />
            </button>
          </Tooltip>
        </span>
      </div>
    );
  };

  return (
    <nav className="file-tree" aria-label="文件">
      <div className="tree-head">
        {/* The title slot shows the workspace folder name — with two workspaces
            open at once, this is the only thing that says which one you are in */}
        <Tooltip content={`当前工作区：${vaultDir.split("/").filter(Boolean).pop() ?? ""} · 点击换一个文件夹`}>
          <button className="tree-vault" aria-label="切换工作区" onClick={onChangeVault}>
            {/* A place, not an action: regular 14, like every other file and
                folder glyph in this rail. The caret beside it is the control */}
            <FolderOpen size={14} weight="regular" />
            <span className="tree-vault-name">
              {vaultDir.split("/").filter(Boolean).pop() ?? "工作区"}
            </span>
            <CaretUpDown size={11} weight="bold" className="tree-vault-caret" />
          </button>
        </Tooltip>
        {/* One glyph for the three ways of making something: a draft, a folder
            and a page pulled in from a link were three near-identical marks in
            a row, and the eyebrow of the rail is not where a toolbar belongs.
            What they have in common is 「新建…」, so that is what the button says */}
        <Tooltip content="新建…">
          <button
            ref={addBtnRef}
            className={`ghost-btn tree-add ${addOpen ? "on" : ""}`}
            data-tree-add-trigger=""
            aria-label="新建"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => {
              setMenu(null);
              setAddOpen((v) => !v);
            }}
          >
            <Plus size={16} weight="regular" />
          </button>
        </Tooltip>
      </div>

      {/* Empty space is a drop target too: dropping here moves back to the root */}
      <div
        ref={bodyRef}
        className={`tree-body scroll-thin ${dropTarget === "" && dragPath ? "drop-into" : ""}`}
        role="tree"
        aria-label="文件"
        onDragOver={(e) => {
          if (!dragPath) return;
          e.preventDefault();
          setDropTarget("");
          // Empty space below the rows means the workspace root, which the
          // rail's own highlight says; no line belongs to it
          setDropLine(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          finishDrop("");
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={FilePlus}
            title="这个文件夹还是空的"
            hint="新建一篇草稿，或者直接把 .md 文件拷进来。"
            action={{ label: '新建草稿', onClick: () => onNewDraft('') }}
          />
        ) : (
          rows.map((row, i) => renderRow(row, i))
        )}

        {unusedImages.length > 0 && (
          <button className="tree-cleanup" onClick={onCleanupImages}>
            <Broom size={14} weight="regular" />
            清理 {unusedImages.length} 张未引用图片
          </button>
        )}
      </div>

      {/* Foot of the rail: the bottom counterpart of the head — one 28px row,
          a grouped object on the left and a single ghost button pushed right,
          the same shape as the vault pill and its 「+」 above.

          Plain anchors on purpose: the app-wide external link listener catches
          them and hands the address to the system browser, the same path every
          other outside link takes. */}
      <div className="tree-foot">
        <div className="tree-foot-links">
          <Tooltip content="作者的 X" side="top">
            <a className="ghost-btn" href="https://x.com/yanxi067" aria-label="作者的 X">
              <XLogo size={16} weight="regular" />
            </a>
          </Tooltip>
          <Tooltip content="作者的 GitHub" side="top">
            <a className="ghost-btn" href="https://github.com/whyubel1eve" aria-label="作者的 GitHub">
              <GithubLogo size={16} weight="regular" />
            </a>
          </Tooltip>
        </div>
        <Tooltip content="设置（公众号凭据）" shortcut={hintFor("settings")} side="top">
          <button className="ghost-btn tree-foot-settings" onClick={onOpenSettings} aria-label="设置">
            <GearSix size={16} weight="regular" />
          </button>
        </Tooltip>
      </div>

      {/* Rendered on <body>: the workspace sheet is a frosted surface, and its
          backdrop-filter makes it the containing block for fixed children —
          which would both offset the menu and clip it to the sidebar */}
      {menuPresence.mounted &&
        lastMenu.current &&
        createPortal(
          <div
            ref={menuRef}
            className="popover tree-menu"
            data-state={menuPresence.state}
            role="menu"
            style={{ left: lastMenu.current.x, top: lastMenu.current.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* The target: a directory is itself, a file is the level it sits in */}
            {(() => {
              const shown = lastMenu.current as Menu;
              const parent = shown.entry
                ? shown.entry.isDir
                  ? shown.entry.path
                  : parentOf(shown.entry.path)
                : "";
              const entry = shown.entry;
              return (
                <>
                  {createItems(parent, () => setMenu(null))}
                  {entry && (
                    <>
                      <div className="menu-divider" />
                      <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          startRename(entry);
                        }}
                      >
                        <PencilSimple size={16} className="menu-icon" />
                        重命名
                      </button>
                      <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          onReveal(entry.path);
                        }}
                      >
                        <FolderOpen size={16} className="menu-icon" />
                        在文件管理器中显示
                      </button>
                      <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          onDelete(entry.path);
                        }}
                      >
                        <Trash size={16} className="menu-icon" />
                        删除
                      </button>
                    </>
                  )}
                </>
              );
            })()}
          </div>,
          document.body,
        )}

      {/* The head's 「+」 menu, on <body> for the same reason as the one above:
          a portal cannot be clipped by the rail, whatever the rail becomes */}
      {addPresence.mounted &&
        createPortal(
          <div
            ref={addMenuRef}
            className="popover tree-add-menu"
            data-state={addPresence.state}
            role="menu"
            aria-label="新建"
            onKeyDown={onAddMenuKeyDown}
          >
            {/* No focus hand-back on a pick: what was chosen takes the keyboard
                next (a new draft opens in the editor, a dialog takes over) */}
            {createItems("", () => setAddOpen(false))}
          </div>,
          document.body,
        )}
    </nav>
  );
}
