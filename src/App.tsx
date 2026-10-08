import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import LayoutDialog from './components/LayoutDialog';
import EditorPane from './components/EditorPane';
import FileTree from './components/FileTree';
import PreviewPane, { DEVICES, readDevice, writeDevice, type PreviewDevice } from './components/PreviewPane';
import TypesetPopover from './components/TypesetPopover';
import Toolbar from './components/Toolbar';
import DraftBoxDialog from './components/DraftBoxDialog';
import PublishDialog from './components/PublishDialog';
import ImportUrlDialog from './components/ImportUrlDialog';
import SettingsDialog from './components/SettingsDialog';
import UpdateDialog from './components/UpdateDialog';
import PreflightDialog from './components/PreflightDialog';
import ConflictBar from './components/ConflictBar';
import AgentPanel from './components/AgentPanel';
import ArticleCenterDialog from './components/ArticleCenterDialog';
import CloudinaryDialog from './components/CloudinaryDialog';
import ThemeStudio from './components/ThemeStudio';
import SniffThemeDialog from './components/SniffThemeDialog';
import VaultGate from './components/VaultGate';
import CommandPalette, { type PaletteItem } from './components/CommandPalette';
import { Toaster, toast } from './toast';
import { SHORTCUTS, hintFor, useShortcuts } from './shortcuts';
import { usePresence } from './usePresence';
import {
  collectImageRefs,
  ensureHighlighter,
  extractTitle,
  isHighlighterReady,
  lineReferencesImage,
  renderArticle,
} from './markdown';
import { copyRichText } from './clipboard';
import { ConfirmHost, confirmDestructive } from './confirm';
import { inlineRemoteImages } from './remoteImages';
import { importArticle } from './reader';
import { safeFileName, saveBlob } from './exchange';
import { renderLongImage } from './longimage';
import { DENSITIES, getDensity, getTheme, themes as presetThemes, type Theme } from './theme';
import type { SectionId } from './themeFields';
import { createScrollSyncChannel } from './scrollSync';
import { useVault } from './store/useVault';
import { useAppearance } from './store/appearance';
import { useTypesetHint } from './store/onboarding';
import { deleteCustomTheme, ensureThemeGuide, saveCustomTheme, useCustomThemes } from './store/customThemes';
import { sniffThemeFromUrl } from './themeSniff';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { chord } from './platform';
import { markAnnounced, useUpdate } from './store/updater';
import type { DraftTarget } from './publish';
import type { Entry } from './store/vault';
import { checkArticle, type PreflightIssue } from './preflight';
import { fetchDraft } from './wechat';
import { articleIdentity } from './store/articleIdentity';
import { getPublishAttempts } from './store/publishJournal';
import { getWechatConfig } from './store/wechatConfig';
import { addPublishRecord, addVersion, loadContentState, saveContentState, type ContentState } from './store/contentState';
import { draftTitle, syncedDraftFileName } from './draftNaming';
import './styles.css';

/** Minimum editor width, preserved while dragging — which is what lets the preview reach desktop width */
const MIN_EDITOR_PX = 180;
/** Minimum preview width (enough for a true phone measure) */
const MIN_PREVIEW_PX = 430;

type VaultApi = ReturnType<typeof useVault>;

/** Image relative path → file name */
const baseName = (path: string) => path.split('/').pop() ?? path;

/**
 * Yield until the browser has painted once: the rAF callback runs inside the
 * frame, and the timer after it only after the frame (paint included) is done.
 * Awaiting anything less leaves pending rendering unpainted behind the next
 * synchronous block — which is how a loading state ends up appearing only
 * after the work it was supposed to cover.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    // A hidden window gets no frames at all — and clicking copy, then switching
    // straight to the WeChat tab, is how this gets used. Never wait on a paint
    // nobody can see.
    setTimeout(resolve, 100);
  });
}

/** Find a node in the tree by its relative path */
function findEntry(entries: Entry[], path: string): Entry | null {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.children) {
      const hit = findEntry(e.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** Line number (0-based) of the first reference to that image, or -1 */
function findEmbedLine(content: string, name: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lineReferencesImage(lines[i], name)) return i;
  }
  return -1;
}

/**
 * The gate: the editor proper only renders once a workspace is open.
 *
 * The data lives in some folder on disk, and that folder may not have been
 * picked yet, or may have been moved away since. So: pick one, read it, and
 * only then continue.
 */
export default function App() {
  const vault = useVault();

  if (vault.status === 'booting') {
    return (
      <div className="vault-boot">
        <span className="spinner" aria-hidden="true" />
        正在打开工作区…
      </div>
    );
  }
  if (vault.status !== 'ready' || !vault.dir) {
    return <VaultGate error={vault.error} onChoose={() => void vault.chooseVault()} />;
  }
  // Keyed on dir: a different workspace is a different body of work, so
  // scroll positions and split widths should all start over
  return <Workspace key={vault.dir} vault={vault} />;
}

function Workspace({ vault }: { vault: VaultApi }) {
  const { tree, drafts, images, prefs, conflicts } = vault;

  // Fall back if the id went stale: drop to the first draft, and let every
  // later edit use that id, which is known to exist
  const activeDraft = drafts.find((d) => d.id === prefs.activeId) ?? drafts[0];
  const activeId = activeDraft?.id ?? '';
  const markdown = activeDraft?.content ?? '';
  const draftPathsRef = useRef<string[]>([]);
  draftPathsRef.current = drafts.map((draft) => draft.id);
  const setMarkdown = (v: string) => {
    if (activeId) vault.setDraftContent(activeId, v);
  };
  const setActiveDraft = (id: string) => vault.setPrefs({ activeId: id });

  const currentArticleKey = articleIdentity(vault.dir ?? '', activeId);
  const themeId = prefs.themeByArticle?.[currentArticleKey] ?? prefs.themeId;
  const setArticleTheme = (id: string) => {
    if (!activeId) return;
    vault.setPrefs({
      themeByDraft: { ...prefs.themeByDraft, [activeId]: id },
      themeByArticle: { ...prefs.themeByArticle, [currentArticleKey]: id },
    });
  };
  const densityId = prefs.densityId;
  const linkFootnotes = prefs.linkFootnotes;

  /** Light/dark of the shell. Nothing to do with the draft, so it stays out of
   *  the vault prefs (see store/appearance.ts) */
  const { appearance, setAppearance } = useAppearance();

  /**
   * The "not on disk yet" indicator.
   *
   * It reports `vault.pending` — the real thing: the dirty set is non-empty, or
   * a write is out over IPC. It used to be a 700ms timer restarted by every
   * keystroke, which meant the dot said "probably fine" and went out on
   * schedule whether or not the file had been written, including when the write
   * had failed.
   *
   * The one embellishment is a floor on how briefly it can appear. A small
   * edit is saved within a frame or two of the debounce firing, and a dot that
   * blinks for 40ms is worse than no dot: it registers as a flicker, and the
   * eye goes to it without being able to read it. 300ms is about the shortest
   * a state change can be shown and still be seen as a state.
   */
  const [saving, setSaving] = useState(false);
  const savingSinceRef = useRef(0);
  useEffect(() => {
    if (vault.pending) {
      savingSinceRef.current = performance.now();
      setSaving(true);
      return;
    }
    const left = 300 - (performance.now() - savingSinceRef.current);
    if (left <= 0) {
      setSaving(false);
      return;
    }
    const timer = window.setTimeout(() => setSaving(false), left);
    return () => window.clearTimeout(timer);
  }, [vault.pending]);

  /** A copy is running (remote images have to be fetched first) */
  const [copying, setCopying] = useState(false);
  /** Copy warnings wait here until the user decides whether to continue. */
  const [copyIssues, setCopyIssues] = useState<PreflightIssue[]>([]);
  const [copyCheckOpen, setCopyCheckOpen] = useState(false);
  /** "From a link": the dialog, and the folder the new draft should land in */
  const [importOpen, setImportOpen] = useState(false);
  const [importParent, setImportParent] = useState('');
  /** The push-to-drafts dialog */
  const [publishOpen, setPublishOpen] = useState(false);
  /** The drafts box, read back from WeChat */
  const [draftBoxOpen, setDraftBoxOpen] = useState(false);
  const [cloudinaryOpen, setCloudinaryOpen] = useState(false);
  /**
   * The draft the next push should overwrite, picked in the drafts box.
   *
   * It is cleared whenever the push dialog closes: a target left lying around
   * would turn the next ordinary 推草稿 into a silent overwrite of an article
   * chosen minutes ago, which is exactly the kind of thing you find out about
   * afterwards.
   */
  const [publishTarget, setPublishTarget] = useState<DraftTarget | null>(null);
  const [publishTargetDigest, setPublishTargetDigest] = useState('');
  /** Settings (公众号凭据) — configured once, so it is a dialog of its own
   *  rather than a section of the push dialog */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [articleCenterOpen, setArticleCenterOpen] = useState(false);
  const [contentState, setContentStateValue] = useState<ContentState>(loadContentState);
  const publishOpenRequest = useRef(0);
  const currentArticleKeyRef = useRef(currentArticleKey);
  currentArticleKeyRef.current = currentArticleKey;
  const setContentState = (next: ContentState) => {
    setContentStateValue(next);
    saveContentState(next);
  };

  // A quiet snapshot after a burst of editing. Identical bodies are ignored and
  // each article keeps its newest 30 versions.
  useEffect(() => {
    if (!activeId || !markdown.trim()) return;
    const timer = window.setTimeout(() => {
      setContentStateValue((prev) => {
        const next = addVersion(prev, currentArticleKey, markdown);
        if (next !== prev) saveContentState(next);
        return next;
      });
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [activeId, currentArticleKey, markdown]);

  /** The toolbar pill is the standing reminder — see store/updater.ts */
  const update = useUpdate();
  const hasUpdate =
    update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready';
  /**
   * Say it once, on the launch check that found it.
   *
   * The pill alone is easy to never notice — it is a small thing in a corner
   * that was not there a moment ago. The toast names the version and offers
   * the way in, then leaves; the pill stays behind as the reminder. Only the
   * silent pass sets `announce`, so pressing 检查更新 by hand does not get a
   * toast on top of the dialog that already answered the question.
   */
  useEffect(() => {
    if (update.phase !== 'available' || !update.announce) return;
    toast(`有新版本 v${update.info.version} 可以安装`, {
      action: { label: '查看', onClick: () => setUpdateOpen(true) },
      ms: 10000,
    });
    markAnnounced();
  }, [update]);
  /** Local agent panel. Once opened it is never unmounted — a run in flight
   *  still needs someone watching it when the panel is collapsed */
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMounted, setAgentMounted] = useState(false);
  /** A request composed for the agent elsewhere in the app, waiting to be
   *  finished by hand in the composer */
  const [agentSeed, setAgentSeed] = useState<{ text: string; at: number } | null>(null);
  /** An export is running (long images and backup archives both take a while) */
  const [exporting, setExporting] = useState(false);
  /** Side-by-side / preview-only */
  const [viewMode, setViewMode] = useState<'split' | 'preview' | 'focus'>('split');
  /**
   * Overlay state that more than one control can reach.
   *
   * All three used to live inside the component that drew them, which was fine
   * until a keyboard shortcut and the command palette also needed to open them
   * — a piece of state with three owners has none.
   */
  const [typesetOpen, setTypesetOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [device, setDeviceState] = useState<PreviewDevice>(readDevice);
  const setDevice = (next: PreviewDevice) => {
    writeDevice(next);
    setDeviceState(next);
  };
  /** The command palette: null closed, otherwise which list it is showing */
  const [palette, setPalette] = useState<'all' | 'drafts' | null>(null);
  const [typewriterMode, setTypewriterMode] = useState(false);
  /** Editor width as a percentage; defaults to the preview's minimum */
  const [editorPct, setEditorPct] = useState<number>(() => {
    const w = window.innerWidth;
    return Math.round(((w - MIN_PREVIEW_PX) / w) * 1000) / 10;
  });
  /** Disable the width transition while dragging */
  const draggingRef = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);

  /**
   * The image index used for rendering.
   *
   * The library is keyed by workspace-relative path (the tree has to show where
   * each file actually lives), while the body usually writes a bare file name
   * like `![[cover.png]]` — so both keys point at the same data URI here.
   * When two directories hold the same name, first one wins (path order, which
   * is stable and predictable).
   */
  const imageIndex = useMemo(() => {
    const index: Record<string, string> = {};
    for (const [path, dataUrl] of Object.entries(images)) index[path] = dataUrl;
    for (const [path, dataUrl] of Object.entries(images)) {
      const name = baseName(path);
      if (!(name in index)) index[name] = dataUrl;
    }
    return index;
  }, [images]);

  /** Candidates for ![[ completion: the body refers to images by file name */
  const imageNames = useMemo(() => [...new Set(Object.keys(images).map(baseName))], [images]);

  /** Themes the agent wrote. They are files on disk, watched, so this list
   *  changes underfoot while a run is going — which is the whole idea.
   *  null while the first read is still out */
  const loadedThemes = useCustomThemes();
  const customThemes = useMemo(() => loadedThemes ?? [], [loadedThemes]);
  /**
   * The theme studio (see components/ThemeStudio.tsx). `from` is where it
   * started and `at` is its identity — a new value remounts it fresh.
   * While it is open the preview draws with its draft rather than the
   * chosen theme, which is the entire point of it sitting beside the preview.
   */
  const [studio, setStudio] = useState<{ from: Theme; at: number } | null>(null);
  const [studioDraft, setStudioDraft] = useState<Theme | null>(null);
  const [studioPick, setStudioPick] = useState<{ section: SectionId; at: number } | null>(null);
  /** The theme the studio last saved, held until the watcher reads the file
   *  back — without it the preview would flash to classic in between */
  const [savedTheme, setSavedTheme] = useState<Theme | null>(null);
  /** Dragging a slider re-renders the whole article; let that yield to the
   *  drag the same way it yields to typing */
  const liveDraft = useDeferredValue(studioDraft);

  /** A custom theme wins over a preset of the same name only because ids can
   *  never collide (see parseTheme); a deleted one falls back to classic */
  const chosenTheme = useMemo(
    () =>
      customThemes.find((t) => t.id === themeId) ??
      (savedTheme?.id === themeId ? savedTheme : getTheme(themeId)),
    [themeId, customThemes, savedTheme],
  );
  const theme = studio && liveDraft ? liveDraft : chosenTheme;

  // The article title is the source of truth for its filename. Wait for a quiet
  // typing window so a title is renamed once, not once per keystroke.
  useEffect(() => {
    if (!activeId) return;
    const title = draftTitle(markdown, theme.id === 'olive-journal');
    if (!title) return;

    const timer = window.setTimeout(() => {
      const nextName = syncedDraftFileName(title, activeId, draftPathsRef.current);
      if (baseName(activeId) === nextName) return;
      void vault.renameEntry(activeId, nextName).catch((error) => {
        console.warn('标题同步文件名失败', error);
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [activeId, markdown, theme.id, vault.renameEntry]);
  const density = useMemo(() => getDensity(densityId), [densityId]);
  const densityName = useMemo(
    () => DENSITIES.find((d) => d.id === densityId)?.name ?? '标准',
    [densityId],
  );
  /** Flips once the highlighter is ready, to trigger the re-render that adds it */
  const [hlReady, setHlReady] = useState(isHighlighterReady);
  // Whole-document re-render yields to typing: keep showing the previous
  // render while keys are coming in, recompute when the main thread is idle
  const deferredMarkdown = useDeferredValue(markdown);
  const renderOptions = useMemo(() => ({ linkFootnotes }), [linkFootnotes]);
  const result = useMemo(
    () => renderArticle(deferredMarkdown, theme, imageIndex, density, renderOptions),
    // hlReady is only a "recompute once" signal, not a render input
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredMarkdown, theme, imageIndex, density, renderOptions, hlReady],
  );

  // highlight.js loads lazily (never blocking first paint); once it is ready,
  // fill in the code highlighting
  useEffect(() => {
    if (hlReady) return;
    let cancelled = false;
    void ensureHighlighter().then(() => {
      if (!cancelled) setHlReady(isHighlighterReady());
    });
    return () => {
      cancelled = true;
    };
  }, [hlReady]);

  /** Say something, briefly. The queue and the animation live in toast.tsx;
   *  this name stays because two dozen call sites use it */
  const flash = (msg: string) => toast(msg);

  /* ---------- Themes the agent makes ---------- */

  /**
   * A theme that was not there a moment ago is one the agent just wrote, so
   * switch to it.
   *
   * Without this the loop stops one step short: you ask for a theme, it
   * appears in the list, and the preview keeps showing the old one until you
   * go and find the new card. The first load is exempt — every theme is new
   * then, and adopting one at startup would override the workspace's own
   * choice.
   */
  const knownThemes = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loadedThemes) return;
    const before = knownThemes.current;
    knownThemes.current = new Set(loadedThemes.map((t) => t.id));
    if (!before) return;
    const fresh = loadedThemes.find((t) => !before.has(t.id));
    if (fresh) setArticleTheme(fresh.id);
    // vault.setPrefs is stable enough for this; the list is the real trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThemes]);

  /** Prepare the current theme guide before opening an editable API request.
   *  Nothing is sent until the user finishes describing the theme. */
  const askAgentForTheme = () => {
    void (async () => {
      try {
        await ensureThemeGuide();
      } catch (err) {
        flash(err instanceof Error ? err.message : '写不了主题说明');
        return;
      }
      setAgentMounted(true);
      setAgentOpen(true);
      setAgentSeed({
        at: Date.now(),
        text:
          `帮我做一个公众号文章主题。\n\n` +
          `先调用 read_theme_guide 阅读格式、全部字段和完整示例。\n` +
          `通过 save_theme 保存主题，修改已有主题前先调用 list_themes 读取。\n` +
          `存盘我这边预览立刻会变，我看了会告诉你哪儿再改，你改同一个文件就行。\n\n` +
          `我想要：`,
      });
    })();
  };

  /**
   * Open the studio on one of your own themes, or on the theme in use.
   *
   * A second open while one is already going would remount it and silently
   * drop whatever was not saved, so that is refused instead. The agent panel
   * steps aside: both are 340px columns, and the preview between them is
   * what the studio is for.
   */
  const openStudio = (id?: string) => {
    if (studio) {
      flash('主题工坊已经开着');
      return;
    }
    const from = (id && customThemes.find((t) => t.id === id)) || chosenTheme;
    setStudioDraft(null);
    setStudioPick(null);
    setStudio({ from, at: Date.now() });
    setAgentOpen(false);
  };

  /** The "paste a link" dialog for sniffing a theme off an article */
  const [sniffOpen, setSniffOpen] = useState(false);

  /**
   * Read a published article's typesetting into a theme of your own, and open
   * it in the studio — where it belongs, because a sniffed theme is a first
   * draft by definition (see themeSniff.ts).
   */
  const runSniff = async (url: string, onProgress: (msg: string) => void): Promise<string[]> => {
    if (studio) throw new Error('主题工坊开着，先存好或关掉它，再扒一个新的。');
    onProgress('正在打开文章…');
    const { theme, notes } = await sniffThemeFromUrl(url, (target, init) => httpFetch(target, init));
    onProgress('正在存主题…');
    const saved = await saveCustomTheme({ ...theme, id: `sniff-${Date.now().toString(36)}` });
    setSavedTheme(saved);
    setArticleTheme(saved.id);
    setStudioDraft(null);
    setStudioPick(null);
    setStudio({ from: saved, at: Date.now() });
    setAgentOpen(false);
    return notes;
  };

  const closeStudio = () => {
    setStudio(null);
    setStudioDraft(null);
    setStudioPick(null);
  };

  /** Throw one away. If it was the one in use, the draft falls back to the
   *  default preset rather than silently keeping a theme that no longer exists */
  const dropTheme = (id: string) => {
    void deleteCustomTheme(id)
      .then(() => {
        const themeByDraft = Object.fromEntries(
          Object.entries(prefs.themeByDraft).filter(([, usedThemeId]) => usedThemeId !== id),
        );
        vault.setPrefs({
          themeId: prefs.themeId === id ? 'classic' : prefs.themeId,
          themeByDraft,
          themeByArticle: Object.fromEntries(Object.entries(prefs.themeByArticle ?? {}).filter(([, usedThemeId]) => usedThemeId !== id)),
        });
        flash('主题已删掉');
      })
      .catch((err) => flash(err instanceof Error ? err.message : '删不掉主题'));
  };

  // Surface disk trouble (cannot write, cannot read) — otherwise all the user
  // sees is that their work did not save
  useEffect(() => {
    if (vault.error) flash(vault.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.error]);

  /** New draft, created under `parent` (empty string = workspace root) */
  const handleNewDraft = (parent = '') => {
    void (async () => {
      try {
        const created = await vault.newDraft(`草稿 ${drafts.length + 1}`, '', parent);
        if (created) {
          setActiveDraft(created.id);
          flash(`已新建「${created.name}」`);
        }
      } catch (err) {
        flash(err instanceof Error ? err.message : '新建失败');
      }
    })();
  };

  /**
   * A web page, turned into a draft in this workspace.
   *
   * Two things happen and both belong to the workspace, not to reader.ts: the
   * images are written through the vault (so the tree and the preview pick them
   * up like any other image), and the finished body becomes a real file named
   * after the article.
   */
  const runImport = async (
    url: string,
    parent: string,
    withImages: boolean,
    withTheme: boolean,
    onProgress: (msg: string) => void,
  ) => {
    const result = await importArticle(url, {
      withImages,
      withTheme,
      addImage: vault.addImage,
      // The file names already in images/ — one import must not overwrite
      // pictures another one put there
      taken: new Set(imageNames),
      onProgress: (done, total) => onProgress(`正在存图 ${done}/${total}…`),
    });
    const created = await vault.newDraft(result.title || '网页导入', result.markdown, parent);
    if (created) setActiveDraft(created.id);
    const note = result.saved ? `，存了 ${result.saved} 张图` : '';
    const missed = result.missed ? `（${result.missed} 张没抓到，正文里还是外链）` : '';
    // The theme is a second, independent outcome: it applies at once, and a
    // failure to read one never touches the draft that did arrive
    let styling = '';
    if (result.theme) {
      try {
        const saved = await saveCustomTheme({ ...result.theme, id: `sniff-${Date.now().toString(36)}` });
        setSavedTheme(saved);
        if (created) {
          const key = articleIdentity(vault.dir ?? '', created.id);
          vault.setPrefs({ themeByDraft: { ...prefs.themeByDraft, [created.id]: saved.id }, themeByArticle: { ...prefs.themeByArticle, [key]: saved.id } });
        }
        styling = `，排版也扒成了主题「${saved.name}」`;
      } catch (err) {
        styling = `，主题存不下来：${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (result.themeError) {
      styling = `，但排版没扒到：${result.themeError}`;
    }
    const author = result.byline ? ` · ${result.byline}` : '';
    const date = result.publishedTime ? ` · ${result.publishedTime.slice(0, 10)}` : '';
    flash(`已导入「${created?.name ?? result.title}」 · ${result.characterCount} 字 · ${result.imageCount} 张图${note}${missed}${styling}${author}${date}`);
  };

  /** New folder */
  const handleNewFolder = (parent = '') => {
    void (async () => {
      try {
        const path = await vault.newFolder('新文件夹', parent);
        if (path) flash(`已新建文件夹「${baseName(path)}」`);
      } catch (err) {
        flash(err instanceof Error ? err.message : '新建文件夹失败');
      }
    })();
  };

  /** Rename — on disk this renames a real file or directory, so collisions
   *  have to be caught */
  const handleRename = (path: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void (async () => {
      try {
        const next = await vault.renameEntry(path, trimmed);
        // The path *is* the id, so renaming changes it; the selection has to
        // follow, including for a draft inside a renamed directory
        if (next && (path === activeId || activeId.startsWith(`${path}/`))) {
          setActiveDraft(activeId === path ? next : next + activeId.slice(path.length));
        }
      } catch (err) {
        flash(err instanceof Error ? err.message : '改名失败');
      }
    })();
  };

  /** Drag-move into another directory */
  const handleMove = (paths: string[], toParent: string) => {
    void (async () => {
      try {
        let nextActive = activeId;
        for (const path of paths) {
          const next = await vault.moveEntry(path, toParent);
          if (next && (path === nextActive || nextActive.startsWith(`${path}/`))) {
            nextActive = nextActive === path ? next : next + nextActive.slice(path.length);
          }
        }
        if (nextActive !== activeId) setActiveDraft(nextActive);
        if (paths.length > 1) flash(`已移动 ${paths.length} 篇文章`);
      } catch (err) {
        flash(err instanceof Error ? err.message : '移动失败');
      }
    })();
  };

  /**
   * Delete a file or a folder.
   *
   * It goes to the system trash now (see entry_delete in vault.rs), which is
   * what makes the question a question about tidiness rather than about loss.
   * It is still asked: a folder takes its contents, and an image the body
   * still references leaves a placeholder behind — a vague confirmation is
   * worse than none.
   *
   * A text draft also gets 撤销 on the toast, because the content is in memory
   * at the moment it is deleted and putting it back is exact. Everything else
   * is told where it went instead: the trash is a real undo for those, one
   * window away, and offering a button that only half works would be worse
   * than saying plainly what happened.
   */
  const handleDelete = (path: string) => {
    const name = baseName(path);
    const entry = findEntry(tree, path);
    const isDir = !!entry?.isDir;
    const stillUsed = images[path] && (usedImageRefs.has(name) || usedImageRefs.has(path));
    /** Held before the delete: after it, the draft is gone from state */
    const deleted = drafts.find((d) => d.id === path);
    const question = isDir
      ? `删除文件夹「${name}」？里面的东西会一起挪进废纸篓。`
      : stillUsed
        ? `「${name}」还被正文引用，删除后那里会变成占位提示。仍要删除？`
        : `删除「${name}」？文件会挪进系统废纸篓。`;
    void (async () => {
      if (!(await confirmDestructive(question))) return;
      try {
        const trashed = await vault.removeEntry(path);
        // The deleted item was the open draft (or the directory holding it):
        // the selection has to land on a file that really exists
        if (activeId === path || activeId.startsWith(`${path}/`)) {
          const remaining = drafts.filter((d) => d.id !== path && !d.id.startsWith(`${path}/`));
          const next = remaining.length ? remaining[0] : await vault.newDraft('未命名草稿');
          if (next) setActiveDraft(next.id);
        }
        const where = trashed ? '已挪进废纸篓' : '已删除';
        if (!deleted) {
          toast(`${where}「${name}」`);
          return;
        }
        toast(`${where}「${name}」`, {
          action: {
            label: '撤销',
            onClick: () => {
              void (async () => {
                try {
                  const back = await vault.newDraft(
                    name.replace(/\.[^.]+$/, ''),
                    deleted.content,
                    path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
                  );
                  if (back) {
                    setActiveDraft(back.id);
                    toast(`「${back.name}」回来了`);
                  }
                } catch (err) {
                  flash(err instanceof Error ? err.message : '撤销失败');
                }
              })();
            },
          },
        });
      } catch (err) {
        flash(err instanceof Error ? err.message : '删除失败');
      }
    })();
  };

  /** Files we cannot open (pdf, psd…): hand them to the system file manager */
  const handleReveal = (path: string) => {
    void vault.revealEntry(path).catch((err) => flash(err instanceof Error ? err.message : '打开失败'));
  };

  /** Images referenced by any draft (both bare names and full paths count) */
  const usedImageRefs = useMemo(() => {
    const used = new Set<string>();
    for (const d of drafts) {
      for (const name of collectImageRefs(d.content)) used.add(name);
    }
    return used;
  }, [drafts]);

  /** Editor jump request (used when an image is clicked in the file tree) */
  const [jumpRequest, setJumpRequest] = useState<{ line: number; nonce: number } | null>(null);
  const jumpNonce = useRef(0);

  /** Click an image: jump to the line referencing it, switching drafts if needed */
  const handleLocateImage = (path: string) => {
  // The body usually writes the bare name; the path is only where it lives
    const name = baseName(path);
    const inActive = activeDraft ? findEmbedLine(activeDraft.content, name) : -1;
    let line = inActive;
    let jumpedTo: { id: string; name: string } | null = null;
    if (line < 0) {
      // Not in the current draft, so look through the others
      for (const d of drafts) {
        if (d.id === activeId) continue;
        const l = findEmbedLine(d.content, name);
        if (l >= 0) {
          line = l;
          jumpedTo = d;
          break;
        }
      }
    }
    if (line < 0) {
      flash(`「${name}」还没有被任何草稿引用`);
      return;
    }
    if (jumpedTo) {
      setActiveDraft(jumpedTo.id);
      flash(`已跳到「${jumpedTo.name}」`);
    }
    jumpNonce.current += 1;
    setJumpRequest({ line, nonce: jumpNonce.current });
  };

  /** Sweep every image that no draft references */
  const handleCleanupImages = () => {
    const unused = Object.keys(images).filter(
      (p) => !usedImageRefs.has(baseName(p)) && !usedImageRefs.has(p),
    );
    if (!unused.length) {
      flash('没有未引用的图片');
      return;
    }
    void (async () => {
      const question = `把 ${unused.length} 张未被任何草稿引用的图片挪进废纸篓？`;
      if (!(await confirmDestructive(question))) return;
      try {
        await Promise.all(unused.map((p) => vault.removeEntry(p)));
        flash(`已清理 ${unused.length} 张未引用图片，都在系统废纸篓里`);
      } catch {
        flash('部分图片删除失败');
      }
    })();
  };

  /** Images dropped or pasted into the editor land under the workspace's images/ */
  const handleAddImage = (name: string, dataUrl: string) => {
    void vault.addImage(name, dataUrl).catch(() => flash('图片保存失败'));
  };

  const articleCheckInput = useMemo(
    () => ({
      markdown,
      availableImages: new Set(Object.keys(imageIndex)),
      referencedImages: collectImageRefs(markdown),
      frontMatterEnabled: !!theme.components?.frontMatter,
      linkFootnotes,
    }),
    [markdown, imageIndex, theme.components?.frontMatter, linkFootnotes],
  );

  const performCopy = async () => {
    if (copying) return;
    setCopying(true);
    // The loading state has to be painted before the heavy synchronous render
    // starts; a plain await only reaches microtasks, which run before the
    // browser gets its frame (rAF callback, then a timer after the paint)
    await nextPaint();
    try {
      // The preview runs off a deferred value and the highlighter may still be
      // loading, so an export has to re-render from the current body
      await ensureHighlighter();
      const { html } = renderArticle(markdown, theme, imageIndex, density, renderOptions);
      // Inline remote images first: the moment an image host turns on hotlink
      // protection, WeChat cannot fetch them and the paste is all broken images
      const { html: inlined, failed } = await inlineRemoteImages(html, (done, total) =>
        flash(`正在抓取外链图 ${done}/${total}…`),
      );
      const ok = await copyRichText(inlined);
      flash(
        ok
          ? `已复制，去公众号 ${chord('V')} 粘贴${failed ? `（${failed} 张外链图没抓到，仍是外链）` : ''}`
          : '复制失败',
      );
    } catch (err) {
      // Errors from the image host (bad credentials, IP not allow-listed) have
      // to come through verbatim, or all the user sees is "copy failed"
      console.warn('复制失败', err);
      flash(err instanceof Error ? err.message : '复制失败');
    } finally {
      setCopying(false);
    }
  };

  const handleCopy = () => {
    const issues = checkArticle(articleCheckInput);
    if (issues.length) {
      setCopyIssues(issues);
      setCopyCheckOpen(true);
      return;
    }
    void performCopy();
  };

  /* ---------------- Export ---------------- */

  /** Export the body as one long PNG (re-rendered from the current body, not
   *  the deferred preview value) */
  const handleExportImage = async () => {
    setExporting(true);
    // Same as the copy button: paint the loading state first
    await nextPaint();
    try {
      await ensureHighlighter();
      const { body } = renderArticle(markdown, theme, imageIndex, density, renderOptions);
      // A long image goes through <foreignObject>, which only sees resources it
      // carries itself, so remote images must be inlined first
      const { html: inlined } = await inlineRemoteImages(body);
      const blob = await renderLongImage({ body: inlined, theme, author: '空核域界' });
      if (await saveBlob(`${safeFileName(activeDraft?.name ?? '长图')}.png`, blob)) flash('长图已导出');
    } catch (err) {
      console.warn('长图导出失败', err);
      flash(err instanceof Error ? err.message : '长图导出失败');
    } finally {
      setExporting(false);
    }
  };

  /** Closing the push dialog also drops the overwrite target — see publishTarget */
  const closePublish = () => {
    setPublishOpen(false);
    setPublishTarget(null);
    setPublishTargetDigest('');
  };

  const openPublish = async () => {
    const request = ++publishOpenRequest.current;
    const currentAccount = { ...getWechatConfig() };
    let binding = contentState.bindings[currentArticleKey]?.[currentAccount.appid];
    try {
      // A crash can happen after the durable receipt but before UI history saves.
      const completed = getPublishAttempts().find(item => item.snapshot.articleKey === currentArticleKey && item.snapshot.accountId === currentAccount.appid && item.state === 'completed' && item.receipt);
      if (completed?.receipt && (!binding || completed.updatedAt > binding.updatedAt)) {
        binding = { accountId: currentAccount.appid, mediaId: completed.receipt.mediaId, articleIndex: completed.snapshot.target?.index ?? 0, title: completed.snapshot.title, updatedAt: completed.updatedAt };
      }
      let target: DraftTarget | null = null;
      let digest = '';
      if (binding) {
        flash('正在读取已关联草稿…');
        const articles = await fetchDraft(currentAccount, binding.mediaId);
        const article = articles[binding.articleIndex];
        if (!article?.thumb_media_id) throw new Error('关联草稿不存在或缺少封面，请在草稿箱重新选择');
        target = { accountId: currentAccount.appid, mediaId: binding.mediaId, index: binding.articleIndex, thumbMediaId: article.thumb_media_id, thumbUrl: article.thumb_url, title: article.title };
        digest = article.digest;
      }
      if (request !== publishOpenRequest.current || currentArticleKeyRef.current !== currentArticleKey || getWechatConfig().appid !== currentAccount.appid) return;
      setPublishTarget(target);
      setPublishTargetDigest(digest);
      setPublishOpen(true);
    } catch (error) {
      flash(error instanceof Error ? error.message : '读取关联草稿失败');
    }
  };

  /** Body HTML for the push: the preview runs off a deferred value and the
   *  highlighter may still be loading, so re-render from the current body */
  const buildArticleHtml = async (): Promise<string> => {
    await ensureHighlighter();
    return renderArticle(markdown, theme, imageIndex, density, renderOptions).html;
  };

  const publishRevision = useMemo(() => ({}), [markdown, theme, imageIndex, density, renderOptions]);

  /** Default title: the first H1 in the body, falling back to the draft name.
   *  Computed only at the moment the dialog opens */
  const defaultTitle = useMemo(() => {
    const rendered = renderArticle(markdown, theme, imageIndex, density, renderOptions);
    const fromBody = rendered.title || extractTitle(rendered.body);
    return fromBody || activeDraft?.name || '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishOpen]);

  /**
   * The two widths worth stopping on, as percentages of the split.
   *
   * Half and half is the obvious one. The other is the width at which the
   * preview is exactly MIN_PREVIEW_PX — the narrowest a true phone measure
   * fits into — which is the most useful position in the app and the one
   * anybody dragging towards the right edge is actually aiming at. Landing on
   * it by hand means hitting a single pixel.
   */
  const snapPoints = (railWidth: number) => [50, ((railWidth - MIN_PREVIEW_PX) / railWidth) * 100];
  /** How near a snap point counts as aiming at it, in pixels of travel */
  const SNAP_PX = 12;

  /** The handle, for the snap pulse. `.split-bar` is written to directly for
   *  the same reason the width is: no render belongs on a drag path */
  const barRef = useRef<HTMLDivElement>(null);
  /** Which snap point the handle is currently resting on, so the pulse fires
   *  on arrival rather than on every frame spent inside the window */
  const snappedRef = useRef<number | null>(null);

  /**
   * One frame of a drag: clamp, snap, write.
   *
   * Straight to the DOM, skipping React's render latency — a splitter that
   * lags the cursor by a frame feels broken in a way that a slow anything else
   * does not, because the pointer is right there to compare against.
   */
  const applyDrag = (clientX: number) => {
    const split = splitRef.current;
    const editor = editorRef.current;
    if (!split || !editor) return;
    const rect = split.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    // Editor width range: [MIN_EDITOR_PX, W - MIN_PREVIEW_PX], which keeps a
    // true phone measure available to the preview
    const minPct = (MIN_EDITOR_PX / rect.width) * 100;
    const maxPct = ((rect.width - MIN_PREVIEW_PX) / rect.width) * 100;
    let clamped = Math.max(minPct, Math.min(maxPct, pct));
    const snapWindow = (SNAP_PX / rect.width) * 100;
    const hit = snapPoints(rect.width).find((p) => Math.abs(clamped - p) <= snapWindow) ?? null;
    if (hit !== null) clamped = Math.max(minPct, Math.min(maxPct, hit));
    // A pulse on arrival, so the stop is felt rather than only obeyed. The
    // class is taken off and re-added to restart the animation
    if (hit !== snappedRef.current) {
      snappedRef.current = hit;
      const bar = barRef.current;
      if (hit !== null && bar) {
        bar.classList.remove('snapped');
        void bar.offsetWidth;
        bar.classList.add('snapped');
      }
    }
    editor.style.width = `${clamped}%`;
    void editor.offsetHeight; // Force a reflow so the width transition is skipped
  };

  /** Latest pointer position, read once per frame */
  const dragXRef = useRef(0);
  const dragRafRef = useRef(0);
  const scheduleDrag = (clientX: number) => {
    dragXRef.current = clientX;
    if (dragRafRef.current) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0;
      applyDrag(dragXRef.current);
    });
  };

  /** Drag start/end: toggle the DOM class by hand (a ref triggers no render,
   *  so the class has to be set manually) */
  const setDraggingUi = (on: boolean) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.classList.toggle('no-transition', on);
  };

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    snappedRef.current = null;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    document.body.style.userSelect = '';
    document.documentElement.classList.remove('split-dragging');
    setDraggingUi(false);
    const editor = editorRef.current;
    const split = splitRef.current;
    if (editor && split) {
      const rect = split.getBoundingClientRect();
      // Write the final width back to state (used by mode switching and reset)
      setEditorPct(Math.max(0, Math.min(100, (editor.getBoundingClientRect().width / rect.width) * 100)));
    }
  };

  /** Put the editor at an exact percentage, without a transition (used by the
   *  double-click reset and the arrow keys) */
  const setSplitPct = (pct: number) => {
    const editor = editorRef.current;
    const split = splitRef.current;
    if (!editor || !split) return;
    const rect = split.getBoundingClientRect();
    const minPct = (MIN_EDITOR_PX / rect.width) * 100;
    const maxPct = ((rect.width - MIN_PREVIEW_PX) / rect.width) * 100;
    const clamped = Math.round(Math.max(minPct, Math.min(maxPct, pct)) * 10) / 10;
    setDraggingUi(true);
    editor.style.width = `${clamped}%`;
    void editor.offsetHeight;
    setDraggingUi(false);
    setEditorPct(clamped);
  };

  /** Double-click the splitter to reset (to the preview's minimum width) */
  const resetSplit = () => {
    const split = splitRef.current;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    setSplitPct(((rect.width - MIN_PREVIEW_PX) / rect.width) * 100);
  };

  /** Arrow keys on the focused handle. 2% is a visible step without being a
   *  jump — eight presses cross the useful range */
  const nudgeSplit = (delta: number) => {
    const editor = editorRef.current;
    const split = splitRef.current;
    if (!editor || !split) return;
    const rect = split.getBoundingClientRect();
    setSplitPct((editor.getBoundingClientRect().width / rect.width) * 100 + delta);
  };

  /**
   * Scroll-sync channel: the editor publishes a position, the preview subscribes.
   * A mutable object rather than state — scrolling should not re-render the tree.
   */
  const scrollSync = useRef(createScrollSyncChannel()).current;

  const isPreviewOnly = viewMode === 'preview';
  const isFocus = viewMode === 'focus';

  /**
   * The one-time pointer at the theme capsule. With the toolbar's 排版 button
   * gone the capsule is the only visible way to the themes, so a first launch
   * points at it once. Not while the studio has the preview (the capsule is
   * replaced by the pick prompt then) and not without a draft to preview.
   */
  const typesetHint = useTypesetHint(!studio && !!activeId);
  const dismissTypesetHint = typesetHint.dismiss;
  // Reaching the popover any way at all — capsule, shortcut, palette — is the
  // lesson learnt
  useEffect(() => {
    if (typesetOpen) dismissTypesetHint();
  }, [typesetOpen, dismissTypesetHint]);
  // Someone who has moved between drafts twice is already finding their way
  // around, and the callout has become furniture
  const draftSwitches = useRef({ last: activeId, count: 0 });
  useEffect(() => {
    const seen = draftSwitches.current;
    if (seen.last === activeId) return;
    seen.last = activeId;
    seen.count += 1;
    if (seen.count >= 2) dismissTypesetHint();
  }, [activeId, dismissTypesetHint]);

  /* ---------------- Keyboard, palette ---------------- */

  /** A dialog or the palette owns the keyboard while it is up */
  const overlayOpen =
    publishOpen || draftBoxOpen || settingsOpen || updateOpen || importOpen || sniffOpen || layoutOpen || articleCenterOpen || cloudinaryOpen || copyCheckOpen || !!palette;

  const toggleAgent = () => {
    setAgentOpen((v) => !v);
    setAgentMounted(true);
  };

  useShortcuts(
    {
      viewMode: () => setViewMode((m) => (m === 'split' ? 'preview' : 'split')),
      copy: () => void handleCopy(),
      longImage: () => void handleExportImage(),
      publish: () => void openPublish(),
      settings: () => setSettingsOpen(true),
      agent: toggleAgent,
      typeset: () => setTypesetOpen((v) => !v),
      outline: () => setOutlineOpen((v) => !v),
      palette: () => setPalette('all'),
      quickOpen: () => setPalette('drafts'),
      newDraft: () => handleNewDraft(''),
    },
    !overlayOpen,
  );

  /**
   * What the palette can reach.
   *
   * Built in one place rather than assembled per section, because the ordering
   * *is* the design: drafts first (the thing you are most often looking for),
   * then the actions, then the three settings that are otherwise two clicks
   * deep inside the typeset popover.
   */
  const draftItems = useMemo<PaletteItem[]>(
    () =>
      drafts.map((d) => ({
        id: `draft:${d.id}`,
        section: '草稿',
        name: d.name,
        path: d.id.includes('/') ? d.id.slice(0, d.id.lastIndexOf('/')) : undefined,
        checked: d.id === activeId,
        run: () => setActiveDraft(d.id),
      })),
    // setActiveDraft closes over vault.setPrefs, which is stable enough here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, activeId],
  );

  const paletteItems: PaletteItem[] =
    palette === 'drafts'
      ? draftItems
      : [
          ...draftItems,
          {
            id: 'act:new',
            section: '动作',
            name: SHORTCUTS.newDraft.label,
            hint: SHORTCUTS.newDraft.hint,
            run: () => handleNewDraft(''),
          },
          {
            id: 'act:view',
            section: '动作',
            name: SHORTCUTS.viewMode.label,
            hint: SHORTCUTS.viewMode.hint,
            run: () => setViewMode((m) => (m === 'split' ? 'preview' : 'split')),
          },
          {
            id: 'act:outline',
            section: '动作',
            name: SHORTCUTS.outline.label,
            hint: SHORTCUTS.outline.hint,
            run: () => setOutlineOpen((v) => !v),
          },
          {
            id: 'act:copy',
            section: '动作',
            name: SHORTCUTS.copy.label,
            hint: SHORTCUTS.copy.hint,
            run: () => void handleCopy(),
          },
          {
            id: 'act:long',
            section: '动作',
            name: SHORTCUTS.longImage.label,
            hint: SHORTCUTS.longImage.hint,
            run: () => void handleExportImage(),
          },
          {
            id: 'act:publish',
            section: '动作',
            name: SHORTCUTS.publish.label,
            hint: SHORTCUTS.publish.hint,
            run: () => void openPublish(),
          },
          {
            id: 'act:typeset',
            section: '动作',
            name: '排版与主题',
            hint: hintFor('typeset'),
            run: () => setTypesetOpen(true),
          },
          { id: 'act:box', section: '动作', name: '草稿箱', run: () => setDraftBoxOpen(true) },
          {
            id: 'act:agent',
            section: '动作',
            name: SHORTCUTS.agent.label,
            hint: SHORTCUTS.agent.hint,
            run: toggleAgent,
          },
          { id: 'act:studio', section: '动作', name: '主题工坊', run: () => openStudio() },
          { id: 'act:import', section: '动作', name: '从链接导入', run: () => {
            setImportParent('');
            setImportOpen(true);
          } },
          {
            id: 'act:settings',
            section: '动作',
            name: SHORTCUTS.settings.label,
            hint: SHORTCUTS.settings.hint,
            run: () => setSettingsOpen(true),
          },
          ...[...presetThemes, ...customThemes].map((th) => ({
            id: `theme:${th.id}`,
            section: '主题',
            name: th.name,
            path: th.description,
            checked: th.id === themeId,
            run: () => setArticleTheme(th.id),
          })),
          ...DENSITIES.map((d) => ({
            id: `density:${d.id}`,
            section: '密度',
            name: d.name,
            checked: d.id === densityId,
            run: () => vault.setPrefs({ densityId: d.id }),
          })),
          ...DEVICES.map((d) => ({
            id: `device:${d.id}`,
            section: '机型',
            name: d.name,
            checked: d.id === device,
            run: () => setDevice(d.id),
          })),
        ];

  /* ---------------- Side panels ---------------- */

  /**
   * The studio has to outlive its own state by one animation.
   *
   * Everything it draws comes from `studio`, which is null the instant it is
   * closed — so the last value is held here and rendered until the column has
   * finished sliding shut. The key is unchanged, so nothing remounts.
   */
  const studioPresence = usePresence(!!studio, 340);
  const lastStudio = useRef(studio);
  if (studio) lastStudio.current = studio;
  const shownStudio = studio ?? lastStudio.current;

  return (
    <div className={`app ${isFocus ? 'focus-mode' : ''} ${typewriterMode ? 'typewriter-mode' : ''}`}>
      <Toolbar
        viewMode={viewMode}
        onViewMode={setViewMode}
        typewriterMode={typewriterMode}
        onToggleTypewriter={() => setTypewriterMode((on) => !on)}
        docName={activeDraft?.name ?? ''}
        docFolders={activeId.split('/').filter(Boolean).slice(0, -1)}
        saving={saving}
        onCopy={handleCopy}
        onExportImage={() => void handleExportImage()}
        exporting={exporting}
        copying={copying}
        onPublish={openPublish}
        onOpenDraftBox={() => setDraftBoxOpen(true)}
        onOpenArticleCenter={() => setArticleCenterOpen(true)}
        onOpenLayout={() => setLayoutOpen(true)}
        onOpenCloudinary={() => setCloudinaryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        hasUpdate={hasUpdate}
        onOpenUpdate={() => setUpdateOpen(true)}
        agentOpen={agentOpen}
        onToggleAgent={toggleAgent}
        typesetOpen={typesetOpen}
        onTypesetOpen={setTypesetOpen}
        typeset={(close, state) => (
          <TypesetPopover
            state={state}
            themeId={themeId}
            onThemeChange={setArticleTheme}
            customThemes={customThemes}
            onDeleteTheme={dropTheme}
            onAskAgent={() => {
              close();
              askAgentForTheme();
            }}
            onOpenStudio={(id) => {
              close();
              openStudio(id);
            }}
            onSniffTheme={() => {
              close();
              setSniffOpen(true);
            }}
            densityId={densityId}
            onDensityChange={(id) => vault.setPrefs({ densityId: id })}
            linkFootnotes={linkFootnotes}
            onLinkFootnotes={(on) => vault.setPrefs({ linkFootnotes: on })}
            appearance={appearance}
            onAppearance={setAppearance}
          />
        )}
      />
      <ConflictBar
        conflicts={conflicts}
        drafts={drafts}
        onTakeDisk={vault.takeDisk}
        onKeepMine={vault.keepMine}
      />
      <main className={`workspace ${isPreviewOnly ? 'mode-preview' : ''}`}>
        <FileTree
          vaultDir={vault.dir ?? ''}
          onChangeVault={() => void vault.chooseVault()}
          tree={tree}
          drafts={drafts}
          activeId={activeId}
          images={images}
          usedImageRefs={usedImageRefs}
          onOpen={setActiveDraft}
          onLocateImage={handleLocateImage}
          onReveal={handleReveal}
          onNewDraft={handleNewDraft}
          onNewFolder={handleNewFolder}
          onImportUrl={(parent) => {
            setImportParent(parent);
            setImportOpen(true);
          }}
          onRename={handleRename}
          onDelete={handleDelete}
          onMove={handleMove}
          onCleanupImages={handleCleanupImages}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {/*
          The sheet. One frosted object holding the source, the preview and
          whichever side column is open — instead of the three or four separate
          cards this used to be, which spent the whole session telling you that
          the window has parts.

          `.split-main` is the resizable row inside it, and it is what the drag
          measures against: the editor's width is a percentage of source +
          preview, so opening the agent must not change what that percentage
          means. Keeping the side slots as its siblings rather than its
          children is what guarantees that.
        */}
        <div className="split">
          <div className="split-main" ref={splitRef}>
            <EditorPane
              ref={editorRef}
              value={markdown}
              onChange={setMarkdown}
              onAddImage={handleAddImage}
              imageNames={imageNames}
              draftId={activeId}
              sync={scrollSync}
              jumpRequest={jumpRequest}
              collapsed={isPreviewOnly}
              widthPct={editorPct}
              vaultDir={vault.dir ?? ''}
              typewriterMode={typewriterMode}
              focusMode={isFocus}
              outlineOpen={outlineOpen}
              onOutlineOpen={setOutlineOpen}
            />
            {/*
              Pointer Events with capture, rather than the old mousedown plus a
              pair of document listeners: capture keeps every move going to this
              element no matter what it passes over — an iframe, the CodeMirror
              scroller, the window edge — which is the thing that used to lose
              drags. It also makes the handle work under touch and pen for free.

              A separator with a value is a real control: ←→ move it, and the
              screen reader is told what it is rather than finding an unlabelled
              div in the middle of the window.
            */}
            <div
              ref={barRef}
              className="split-bar"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整编辑器宽度"
              aria-valuenow={Math.round(editorPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              title="拖动调整 · 双击复位 · ←→ 微调"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                // Capture is the whole point — it is what keeps the drag alive
                // over the CodeMirror scroller and off the edge of the window.
                // It throws for an id that is not a live pointer, and a drag
                // should degrade to "uncaptured" rather than not start
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* not a live pointer */
                }
                e.currentTarget.focus();
                draggingRef.current = true;
                snappedRef.current = null;
                document.body.style.userSelect = 'none';
                document.documentElement.classList.add('split-dragging');
                setDraggingUi(true);
                applyDrag(e.clientX);
              }}
              onPointerMove={(e) => {
                if (draggingRef.current) scheduleDrag(e.clientX);
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' ? 2 : e.key === 'ArrowLeft' ? -2 : 0;
                if (step) {
                  e.preventDefault();
                  nudgeSplit(step);
                  return;
                }
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  resetSplit();
                }
              }}
              onDoubleClick={resetSplit}
            />
            <PreviewPane
              body={result.previewBody}
              title={result.title}
              hasHero={result.hasHero}
              theme={theme}
              hasImage={result.hasImage}
              densityName={densityName}
              draftId={activeId}
              device={device}
              onDevice={setDevice}
              onOpenTypeset={() => {
                dismissTypesetHint();
                setTypesetOpen(true);
              }}
              typesetOpen={typesetOpen}
              onDismissTypesetHint={typesetHint.show ? dismissTypesetHint : undefined}
              collapsed={isFocus}
              resizeKey={`${viewMode}:${editorPct}`}
              sync={scrollSync}
              onPick={studio ? (section) => setStudioPick({ section, at: Date.now() }) : undefined}
            />
          </div>
          {/* Both side columns open by growing their slot from zero width, so the
              preview between them is pushed aside rather than jumping. The panel
              inside keeps its own fixed width and never reflows. */}
          {studioPresence.mounted && shownStudio && (
            <div className={`side-slot studio ${studio ? 'open' : ''}`}>
              <ThemeStudio
                key={shownStudio.at}
                from={shownStudio.from}
                choices={[...presetThemes, ...customThemes]}
                pick={studioPick}
                onDraft={setStudioDraft}
                onSaved={(th) => {
                  setSavedTheme(th);
                  setArticleTheme(th.id);
                }}
                onRestart={(th) => {
                  setStudioDraft(null);
                  setStudioPick(null);
                  setStudio({ from: th, at: Date.now() });
                }}
                onClose={closeStudio}
                onFlash={flash}
              />
            </div>
          )}
          {agentMounted && (
            <div
              className={`side-slot agent ${agentOpen ? 'open' : ''}`}
              // Collapsed but mounted — a run in flight still reports into it.
              // `inert` keeps it out of the tab order while it has no width.
              inert={!agentOpen}
            >
              <AgentPanel
                open={agentOpen}
                vaultDir={vault.dir ?? ''}
                activeId={activeId}
                files={drafts.map((draft) => draft.id)}
                onOpenSettings={() => setSettingsOpen(true)}
                onClose={() => setAgentOpen(false)}
                onBeforeRun={vault.flush}
                seed={agentSeed}
              />
            </div>
          )}
        </div>
      </main>
      <SniffThemeDialog open={sniffOpen} onClose={() => setSniffOpen(false)} onSniff={runSniff} />
      <ImportUrlDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        parent={importParent}
        onImport={(url, withImages, withTheme, onProgress) =>
          runImport(url, importParent, withImages, withTheme, onProgress)
        }
      />
      <CloudinaryDialog
        open={cloudinaryOpen}
        onClose={() => setCloudinaryOpen(false)}
        article={markdown}
        images={images}
        onReplace={setMarkdown}
        onOpenSettings={() => { setCloudinaryOpen(false); setSettingsOpen(true); }}
      />
      <LayoutDialog
        open={layoutOpen}
        articleKey={currentArticleKey}
        markdown={markdown}
        revision={publishRevision}
        renderMarkdown={async content => { await ensureHighlighter(); return renderArticle(content, theme, imageIndex, density, renderOptions).html; }}
        onClose={() => setLayoutOpen(false)}
        onApply={content => {
          setContentState(addVersion(loadContentState(), currentArticleKey, markdown, '采用 AI 排版前'));
          setMarkdown(content);
          flash('已采用排版，原稿已保存到版本历史');
        }}
      />
      <ArticleCenterDialog
        open={articleCenterOpen}
        onClose={() => setArticleCenterOpen(false)}
        articleKey={currentArticleKey}
        content={markdown}
        state={contentState}
        onState={setContentState}
        onRestore={(restored) => {
          const next = addVersion(contentState, currentArticleKey, markdown, '恢复前');
          setContentState(next);
          setMarkdown(restored);
        }}
      />
      <PublishDialog
        open={publishOpen}
        onClose={closePublish}
        articleKey={currentArticleKey}
        contentRevision={publishRevision}
        defaultTitle={defaultTitle}
        articleCheckInput={articleCheckInput}
        articleHasImage={result.hasImage}
        buildHtml={buildArticleHtml}
        onFlash={flash}
        onPublished={(published) => {
          const next = addPublishRecord(loadContentState(), {
            articleKey: published.articleKey,
            accountId: published.accountId,
            mediaId: published.mediaId,
            articleIndex: published.articleIndex,
            title: published.title,
            action: published.updated ? 'updated' : 'created',
            createdAt: Date.now(),
          });
          setContentState(next);
        }}
        target={publishTarget}
        targetDigest={publishTargetDigest}
        onOpenDraftBox={() => {
          setPublishOpen(false);
          setDraftBoxOpen(true);
        }}
        onClearTarget={() => {
          setPublishTarget(null);
          setPublishTargetDigest('');
        }}
        onOpenSettings={() => {
          // One modal at a time: the push dialog steps aside, and pressing
          // 推草稿 again afterwards comes back with the new credentials
          setPublishOpen(false);
          setSettingsOpen(true);
        }}
      />
      <PreflightDialog
        open={copyCheckOpen}
        issues={copyIssues}
        onClose={() => setCopyCheckOpen(false)}
        onContinue={() => {
          setCopyCheckOpen(false);
          void performCopy();
        }}
      />
      <DraftBoxDialog
        open={draftBoxOpen}
        onClose={() => setDraftBoxOpen(false)}
        onPickTarget={(target, digest) => {
          setPublishTarget(target);
          setPublishTargetDigest(digest);
          setDraftBoxOpen(false);
          setPublishOpen(true);
        }}
        onOpenSettings={() => {
          setDraftBoxOpen(false);
          setSettingsOpen(true);
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenUpdate={() => {
          // One modal at a time, same as the push dialog does
          setSettingsOpen(false);
          setUpdateOpen(true);
        }}
      />
      <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
      <CommandPalette
        open={palette !== null}
        onClose={() => setPalette(null)}
        items={paletteItems}
        placeholder={palette === 'drafts' ? '切换到哪篇草稿…' : '搜草稿、动作、主题…'}
      />
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
