import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CaretDown,
  Check,
  ClockCounterClockwise,
  FileText,
  Globe,
  MagnifyingGlass,
  NotePencil,
  Paperclip,
  PencilSimple,
  PlugsConnected,
  Quotes,
  Sparkle,
  Terminal,
  Stop,
  Trash,
  TreeStructure,
  Wrench,
  X,
  type Icon,
} from '@phosphor-icons/react';
import {
  interpret,
  listApiModels,
  onAgentEvent,
  readSessions,
  runApiAgent,
  stderrGist,
  stopAgent,
  writeSessions,
  type AgentKind,
  type Beat,
  type Session,
  type ToolAct,
} from '../store/agent';
import { getConfig, setConfig } from '../store/appConfig';
import {
  buildDeepTalkPrompt,
  type DeepTalkCategory,
  type DeepTalkDestination,
  type DeepTalkLength,
  type DeepTalkStyle,
  type DeepTalkTemplate,
} from '../deepTalk';
import AgentMarkdown from './AgentMarkdown';

interface Props {
  /** Collapsed means hidden, not unmounted — see the note on the component */
  open: boolean;
  /** Absolute workspace path — the agent works inside this directory */
  vaultDir: string;
  /** The open draft (workspace-relative path), used to give the agent context */
  activeId: string;
  onClose: () => void;
  /** Open the API credentials section in the app settings. */
  onOpenSettings: () => void;
  /** Flush unsaved edits before starting; see the comment further down */
  onBeforeRun: () => Promise<void>;
  /** A request written for you elsewhere in the app (currently: "make me a
   *  theme"), dropped into the composer for you to finish and send. It is
   *  never sent on your behalf — the last line is the part only you can write.
   *  A new object means a new request, which is why the timestamp is in it */
  seed?: { text: string; at: number } | null;
}

/** One icon per kind of tool call. Not decoration — a run of a dozen calls is
 *  read by shape long before it is read by name */
const TOOL_ICONS: Record<ToolAct, Icon> = {
  run: Terminal,
  read: FileText,
  edit: PencilSimple,
  search: MagnifyingGlass,
  web: Globe,
  mcp: PlugsConnected,
  task: TreeStructure,
  other: Wrench,
};
/** How many sessions to keep. You will not scroll further back than this, and
 *  the CLI has most likely forgotten those ids anyway */
const KEEP = 40;
/** Debounce on writing the session log to disk */
const SAVE_DELAY = 600;
/** How long to accumulate streamed tokens before repainting. Repainting on
 *  every token leaves the panel too busy to scroll; batched to this, it still
 *  looks like typing but repaints an order of magnitude less often */

const DRAW_DELAY = 60;
/** Within this many pixels of the bottom counts as "reading the latest", and
 *  new content scrolls along. Further up you are re-reading what was already
 *  said, and yanking someone back there means not letting them read */

const FOLLOW_SLACK = 96;

/** The timestamp in the session list, in plain words */
function whenText(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * One tool call: an icon, what was called, and what it was called on.
 *
 * It stays on one line and trims to the panel's width — a command line or a
 * path wrapped across three lines in a 336px column costs more attention than
 * it is worth, and these are meant to be skimmed past on the way to what the
 * agent actually said. The untrimmed text is the tooltip.
 *
 * Sessions written before tool calls were split into verb + target have
 * neither, only the one preformatted string; that still renders, just without
 * the icon carrying any particular meaning.
 */
function ToolBeat({ beat }: { beat: Beat }) {
  const Glyph = TOOL_ICONS[beat.act ?? 'other'];
  const full = [beat.verb, beat.text].filter(Boolean).join(' ');
  return (
    <div className={`agent-beat tool${beat.bad ? ' bad' : ''}`} title={full}>
      <span className="agent-tool-icon" aria-hidden="true">
        <Glyph size={11} weight="bold" />
      </span>
      {beat.verb && <span className="agent-tool-verb">{beat.verb}</span>}
      {beat.text && <span className="agent-tool-target">{beat.text}</span>}
    </div>
  );
}

/**
 * Let the local claude / codex edit drafts inside this workspace.
 *
 * There is no model here and no network — this runs the CLI already on the
 * user's machine, just moved next to the editor, which saves the "switch to a
 * terminal, cd over, read the file name out to it" steps. Whose quota it runs
 * on is not decided here either: whatever the CLI itself is configured with,
 * subscription or key, is what it uses (that is exactly what switchers like
 * cc-switch change), and the panel only surfaces what it reports on startup.
 *
 * Edits do not flow back through this path: the agent writes .md files on disk
 * and the watcher notices them as usual. So the panel only ever shows what it
 * said and which file it touched — the left-hand side is the authority on what
 * the body actually looks like.
 *
 * The two CLIs get separate session areas: they are two processes that know
 * nothing about each other, claude cannot read what codex said, and laying
 * them out on one timeline would only suggest that they can. What genuinely
 * passes between them is the .md files on disk — that is the shared context.
 *
 * "Collapse" only hides, never unmounts: a run in flight must not become an
 * orphaned process because you wanted the space back, and reopening should
 * still show the last exchange. Only a real unmount (switching workspaces,
 * closing the window) kills it.
 */
export default function AgentPanel({ open, vaultDir, activeId, onClose, onOpenSettings, onBeforeRun, seed }: Props) {
  const kind: AgentKind = 'api';
  /** Every conversation held in this workspace, both CLIs in one list, each
   *  entry carrying its own kind */
  const [sessions, setSessions] = useState<Session[]>([]);
  /** Which session each CLI currently has open. null = none yet; it is only
   *  really created when the first message is sent */
  const [activeKey, setActiveKey] = useState<Record<AgentKind, string | null>>({
    api: null,
    claude: null,
    codex: null,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [apiModels, setApiModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => getConfig('agent.api.model') ?? '');
  const [deepTalkOpen, setDeepTalkOpen] = useState(false);
  const [deepTalkTopic, setDeepTalkTopic] = useState('');
  const [deepTalkCategory, setDeepTalkCategory] = useState<DeepTalkCategory>('ai');
  const [deepTalkStyle, setDeepTalkStyle] = useState<DeepTalkStyle>('professional');
  const [deepTalkLength, setDeepTalkLength] = useState<DeepTalkLength>('medium');
  const [deepTalkTemplate, setDeepTalkTemplate] = useState<DeepTalkTemplate>('auto');
  const [deepTalkDestination, setDeepTalkDestination] = useState<DeepTalkDestination>('new');

  /** Events are claimed by run_id. The callback cannot see the latest state,
   *  so this goes through a ref */
  const runIdRef = useRef<string | null>(null);
  /** Which conversation this run's output belongs to — the session may only
   *  have been created at the moment of sending */
  const runKeyRef = useRef<string | null>(null);
  /** stderr already reported this run (path-stripped), so the same thing is
   *  never posted twice */
  const saidOnce = useRef<Set<string>>(new Set());
  const seq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  /** The trailing agent beat is unfinished — streamed tokens land on it */
  const writing = useRef(false);
  /** Text not painted yet. append = add to the end, set = the beat is exactly this */
  const draft = useRef<{ mode: 'append' | 'set'; text: string } | null>(null);
  const drawTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  /** No need to write back what we only just read off disk */
  const loaded = useRef(false);
  /** An IME candidate window is open — Enter belongs to it, not to us */
  const composing = useRef(false);

  const apiBaseUrl = getConfig('agent.api.baseUrl') ?? '';
  const apiKey = getConfig('agent.api.key') ?? '';
  const apiModel = selectedModel;
  const apiReady = !!(apiBaseUrl.trim() && apiKey.trim() && apiModel.trim());

  const current = sessions.find((s) => s.key === activeKey[kind]) ?? null;
  const lines = current?.lines ?? [];
  const continuing = !!current?.cliId;

  useEffect(() => {
    const configured = getConfig('agent.api.model') ?? '';
    if (configured !== selectedModel) setSelectedModel(configured);
  });

  useEffect(() => {
    if (!apiBaseUrl.trim() || !apiKey.trim()) {
      setApiModels([]);
      return;
    }
    let alive = true;
    void listApiModels(apiBaseUrl, apiKey)
      .then((models) => {
        if (alive) setApiModels(models);
      })
      .catch(() => {
        if (alive) setApiModels(apiModel ? [apiModel] : []);
      });
    return () => {
      alive = false;
    };
  }, [apiBaseUrl, apiKey]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, [modelMenuOpen]);

  /** Patch one conversation by key, pushing its timestamp to now */
  const patch = (key: string, fn: (s: Session) => Session) => {
    setSessions((prev) =>
      prev.map((s) => (s.key === key ? { ...fn(s), updatedAt: Date.now() } : s)),
    );
  };

  /** Append entries to a conversation. An empty title takes the first message */
  const pushTo = (key: string, beats: Beat[]) => {
    if (!beats.length) return;
    patch(key, (s) => ({
      ...s,
      title: s.title || beats.find((b) => b.role === 'you')?.text.slice(0, 40) || s.title,
      lines: [...s.lines, ...beats],
    }));
  };

  /* ---------- A request written elsewhere ---------- */

  /**
   * Drop a seeded request into the composer and put the caret at the end of it.
   *
   * Deliberately not sent: the seed is a preamble ending in "我想要：", and the
   * sentence after that colon is the whole point — only the person who wanted a
   * new theme can write it. Sending automatically would send an empty wish.
   *
   * Anything half-typed is kept in front of nothing: the seed replaces it, but
   * only because arriving here means the user just asked for exactly this.
   */
  useEffect(() => {
    if (!seed) return;
    setInput(seed.text);
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(seed.text.length, seed.text.length);
    el.scrollTop = el.scrollHeight;
  }, [seed]);

  /* ---------- The beat currently being spoken ---------- */

  /** Paint what has accumulated. Continue the current beat if it is still
   *  speaking, otherwise start a new one */
  const flush = (key: string) => {
    window.clearTimeout(drawTimer.current);
    drawTimer.current = undefined;
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    const going = writing.current;
    writing.current = true;
    patch(key, (s) => {
      const lines = s.lines.slice();
      const last = lines.length - 1;
      if (going && lines[last]?.role === 'agent') {
        const now = d.mode === 'append' ? lines[last].text + d.text : d.text;
        lines[last] = { ...lines[last], text: now };
      } else {
        lines.push({ role: 'agent', text: d.text });
      }
      return { ...s, lines };
    });
  };

  /** Accumulate, then paint on a timer. A snapshot (set) is newer than the
   *  pending increments, so it simply overwrites them */
  const jot = (key: string, mode: 'append' | 'set', text: string) => {
    const d = draft.current;
    draft.current = mode === 'set' || !d ? { mode, text } : { mode: d.mode, text: d.text + text };
    if (drawTimer.current === undefined) {
      drawTimer.current = window.setTimeout(() => flush(key), DRAW_DELAY);
    }
  };

  /** Finalize: the whole-block version wins, then stop writing */
  const settle = (key: string, text: string) => {
    draft.current = { mode: 'set', text };
    flush(key);
    writing.current = false;
  };

  /** Stop writing without changing the text: something else is about to land on
   *  the timeline, or this run is over */
  const close = (key: string) => {
    flush(key);
    writing.current = false;
  };

  /* ---------- Session log, to and from disk ---------- */

  // Read them back when the panel opens, but do not auto-resume any of them —
  // silently continuing an old conversation on launch leaves you unsure who you
  // are even talking to. To continue one, pick it from the history.

  useEffect(() => {
    let alive = true;
    void readSessions(vaultDir)
      .then((list) => {
        if (alive) setSessions(list);
      })
      .catch(() => undefined)
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      alive = false;
    };
  }, [vaultDir]);

  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // Drop empty conversations: the ones opened and switched away from without
      // a word only serve to fill up the list
      const keep = sessions
        .filter((s) => s.lines.length)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, KEEP);
      void writeSessions(vaultDir, keep).catch(() => undefined);
    }, SAVE_DELAY);
  }, [sessions, vaultDir]);

  /* ---------- Running ---------- */

  // One subscription covers every run, filtered by run_id — a late event from
  // the previous run cannot leak into the next one
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onAgentEvent((e) => {
      if (e.runId !== runIdRef.current) return;
      if (e.stream === 'stderr') {
        const gist = stderrGist(e.line);
        if (saidOnce.current.has(gist)) return;
        saidOnce.current.add(gist);
      }
      const out = interpret(vaultDir, e);
      const key = runKeyRef.current;
      if (key) {
        if (out.delta) jot(key, 'append', out.delta);
        if (out.live !== undefined) jot(key, 'set', out.live);
        if (out.seal !== undefined) settle(key, out.seal);
        if (out.beats.length) {
          close(key);
          pushTo(key, out.beats);
        }
        // A mid-flight break (the process died, you pressed stop) still has to
        // close the beat, or the next run's text continues this one
        if (out.done) close(key);
        // The CLI reported its own session id; record it on this conversation —
        // "continue" means handing that id back
        if (out.sessionId) patch(key, (s) => ({ ...s, cliId: out.sessionId! }));
      }
      // Release the input as soon as result / task_complete arrives; no need to
      // wait for the process to actually exit
      if (out.done) setRunning(false);
      if (e.stream === 'exit') runIdRef.current = null;
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [vaultDir]);

  // Only clean up when the component really goes away (workspace switch, window
  // close) — collapsing the panel does not count
  useEffect(
    () => () => {
      window.clearTimeout(drawTimer.current);
      const id = runIdRef.current;
      if (id) void stopAgent(id).catch(() => undefined);
    },
    [],
  );

  // Switched conversations, or opened/closed the panel: drop straight to the
  // bottom, where the latest is
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeKey[kind], kind, open, historyOpen]);

  // Follow new content down, but only when you were already at the bottom.
  //
  // Watch the DOM rather than state: streamdown parses markdown inside a
  // transition, so the element only grows a beat after state settles, and
  // scrolling off state is permanently one step behind.
  // The browser's own scroll anchoring is no help either — the beat being
  // spoken reflows every 60ms and anchoring would push the viewport down the
  // whole way, which is why it is turned off in CSS (see .agent-log).



  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const follow = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK) {
        el.scrollTop = el.scrollHeight;
      }
    };
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [historyOpen]);

  const send = (prompt?: string) => {
    const text = (prompt ?? input).trim();
    if (!text || running) return;
    void (async () => {
      // Flush unsaved edits first. Otherwise the agent reads a stale body, and
      // what it writes back no longer matches the version in our memory — the
      // conflict bar is guaranteed, and that conflict was self-inflicted.

      await onBeforeRun();

      // Create the session now if none is open: empty conversations are never
      // written to disk, so creating one early would only clutter the list
      let key = activeKey[kind];
      if (!key) {
        key = `s${(seq.current += 1)}-${Date.now()}`;
        setSessions((prev) => [
          { key: key!, kind, cliId: null, title: '', updatedAt: Date.now(), lines: [] },
          ...prev,
        ]);
        setActiveKey((prev) => ({ ...prev, [kind]: key }));
      }

      pushTo(key, [{ role: 'you', text }]);
      setInput('');
      saidOnce.current.clear();
      // If the previous run broke off mid-sentence, that sentence ends here:
      // this run's text starts a new beat
      writing.current = false;
      draft.current = null;
      setRunning(true);
      runKeyRef.current = key;
      try {
        const history = (current?.lines ?? [])
          .filter((line) => line.role === 'you' || line.role === 'agent')
          .map((line) => ({
            role: line.role === 'you' ? 'user' as const : 'assistant' as const,
            content: line.text,
          }));
        const result = await runApiAgent({ dir: vaultDir, activeId, prompt: text, history });
        pushTo(key, [
          ...result.tools.map((tool) => ({
            role: 'tool' as const,
            act: tool.name === 'write_file' ? 'edit' as const : tool.name === 'search_files' ? 'search' as const : 'read' as const,
            verb: tool.name,
            text: tool.target,
          })),
          { role: 'agent', text: result.reply },
        ]);
        setRunning(false);
      } catch (err) {
        setRunning(false);
        pushTo(key, [
          { role: 'note', text: err instanceof Error ? err.message : String(err), bad: true },
        ]);
      }
    })();
  };

  const runDeepTalk = () => {
    const prompt = buildDeepTalkPrompt({
      topic: deepTalkTopic,
      category: deepTalkCategory,
      style: deepTalkStyle,
      length: deepTalkLength,
      template: deepTalkTemplate,
      destination: deepTalkDestination,
      activeId,
    });
    setDeepTalkOpen(false);
    send(prompt);
  };

  const stop = () => {
    const id = runIdRef.current;
    if (id) void stopAgent(id).catch(() => undefined);
  };

  /* ---------- Switching between conversations ---------- */

  /** Start a new one: this only clears the pointer for the current CLI; the
   *  session is really created when the first message is sent */
  const startNew = () => {
    setActiveKey((prev) => ({ ...prev, [kind]: null }));
    setHistoryOpen(false);
  };

  /** Open an API conversation from history. Legacy CLI sessions stay hidden. */
  const openSession = (s: Session) => {
    if (s.kind !== 'api') return;
    setActiveKey((prev) => ({ ...prev, api: s.key }));
    setHistoryOpen(false);
  };

  const dropSession = (key: string) => {
    setSessions((prev) => prev.filter((s) => s.key !== key));
    setActiveKey((prev) => ({
      api: prev.api === key ? null : prev.api,
      claude: prev.claude === key ? null : prev.claude,
      codex: prev.codex === key ? null : prev.codex,
    }));
  };

  /** History list: API conversations only, newest first. */
  const history = useMemo(
    () => sessions.filter((s) => s.kind === 'api' && s.lines.length).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  return (
    <aside className={`agent-side surface ${open ? '' : 'collapsed'}`}>
      <div className="pane-head">
        <span className="pane-title">
          <Sparkle size={13} weight="fill" />
          Agent
        </span>
        <button type="button" className="agent-api-config" onClick={onOpenSettings} disabled={running}>
          API 配置
        </button>
        <button
          className={`ghost-btn ${historyOpen ? 'on' : ''}`}
          onClick={() => setHistoryOpen((v) => !v)}
          title="历史会话"
          aria-pressed={historyOpen}
        >
          <ClockCounterClockwise size={14} weight="bold" />
        </button>
        <button className="ghost-btn" onClick={startNew} disabled={running} title="新对话">
          <NotePencil size={14} weight="bold" />
        </button>
        <button className="ghost-btn" onClick={onClose} title="收起">
          <X size={14} weight="bold" />
        </button>
      </div>

      {!apiReady && !historyOpen && (
        <div className="agent-missing agent-api-missing">
          <p>先配置 OpenAI 兼容接口、API Key 和模型，测试通过后即可让 Agent 直接处理文章。</p>
          <button type="button" className="btn primary" onClick={onOpenSettings}>
            配置 API
          </button>
        </div>
      )}

      {historyOpen ? (
        <div className="agent-history scroll-thin">
          {history.length === 0 && <p className="agent-history-empty">还没有聊过什么</p>}
          {history.map((s) => (
            <div
              key={s.key}
              className={`agent-history-row ${s.key === activeKey[s.kind] ? 'active' : ''}`}
            >
              <button type="button" className="agent-history-open" onClick={() => openSession(s)}>
                <span className={`agent-badge ${s.kind}`}>{s.kind}</span>
                <span className="agent-history-title">{s.title || '（没说什么）'}</span>
                <span className="agent-history-when">{whenText(s.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="agent-history-drop"
                title="删掉这段记录"
                onClick={() => dropSession(s.key)}
              >
                <Trash size={12} weight="bold" />
              </button>
            </div>
          ))}
          <p className="agent-history-note">
            只收录从这个面板发起的 API 对话。
          </p>
        </div>
      ) : (
        <div className="agent-log scroll-thin" ref={logRef}>
          {lines.length === 0 && (
            <div className="agent-empty" aria-hidden="true">
              <Terminal size={44} weight="duotone" />
            </div>
          )}
          {lines.map((l, i) =>
            l.role === 'tool' ? (
              <ToolBeat key={i} beat={l} />
            ) : (
              <div key={i} className={`agent-beat ${l.role}${l.bad ? ' bad' : ''}`}>
                {l.role === 'agent' ? <AgentMarkdown text={l.text} /> : l.text}
              </div>
            ),
          )}
          {running && (
            <div className="agent-beat working" aria-live="polite">
              <span className="dot" aria-hidden="true" />
            </div>
          )}
        </div>
      )}

      {!historyOpen && (
        <div className="agent-composer">
          {deepTalkOpen && (
            <div className="deeptalk-card">
              <div className="deeptalk-head">
                <span><Quotes size={13} weight="fill" /> 深言创作</span>
                <button type="button" onClick={() => setDeepTalkOpen(false)} aria-label="关闭深言创作"><X size={12} /></button>
              </div>
              <input
                className="deeptalk-topic"
                value={deepTalkTopic}
                onChange={(event) => setDeepTalkTopic(event.target.value)}
                placeholder="这篇文章要讲什么？"
                autoFocus
              />
              <div className="deeptalk-grid">
                <label>领域<select value={deepTalkCategory} onChange={(event) => setDeepTalkCategory(event.target.value as DeepTalkCategory)}><option value="tech">技术</option><option value="ai">AI</option><option value="freight">货代</option></select></label>
                <label>结构<select value={deepTalkTemplate} onChange={(event) => setDeepTalkTemplate(event.target.value as DeepTalkTemplate)}><option value="auto">自动判断</option><option value="tutorial">教程</option><option value="analysis">分析</option><option value="news">资讯</option><option value="story">故事</option><option value="listicle">清单</option><option value="review">评测</option></select></label>
                <label>语气<select value={deepTalkStyle} onChange={(event) => setDeepTalkStyle(event.target.value as DeepTalkStyle)}><option value="professional">专业</option><option value="casual">自然</option><option value="academic">学术</option></select></label>
                <label>篇幅<select value={deepTalkLength} onChange={(event) => setDeepTalkLength(event.target.value as DeepTalkLength)}><option value="short">短篇</option><option value="medium">中篇</option><option value="long">长篇</option></select></label>
              </div>
              <label className="deeptalk-destination">写入<select value={deepTalkDestination} onChange={(event) => setDeepTalkDestination(event.target.value as DeepTalkDestination)}><option value="new">新建文章</option>{activeId && <option value="current">改写当前文章</option>}</select></label>
              <button type="button" className="btn primary deeptalk-run" disabled={!deepTalkTopic.trim() || !apiReady || running} onClick={runDeepTalk}>生成并写入</button>
            </div>
          )}
          {activeId && (
            <div className="agent-context" title={`这轮会告诉它你正在看「${activeId}」`}>
              <Paperclip size={11} weight="bold" />
              <span>{activeId}</span>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            rows={3}
            placeholder={continuing ? '接着说…' : '让 API Agent 处理文章或主题…'}
            disabled={!apiReady}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              // WebKit fires compositionend *before* the keydown of the Enter
              // that committed the candidate, so clearing the flag on the next
              // tick is what keeps that Enter from being read as "send".
              setTimeout(() => {
                composing.current = false;
              }, 0);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              send();
            }}
          />
          <div className="agent-composer-foot">
            <button
              type="button"
              className={`agent-chip deeptalk-trigger ${deepTalkOpen ? 'on' : ''}`}
              onClick={() => setDeepTalkOpen((value) => !value)}
              disabled={!apiReady || running}
              title="按 DeepTalk 工作流生成公众号文章"
            >
              <Quotes size={11} weight="fill" /> 深言
            </button>
            <div className="agent-tune wide" ref={modelMenuRef}>
              <button
                type="button"
                className={`agent-chip ${modelMenuOpen ? 'on' : ''}`}
                onClick={() => setModelMenuOpen((value) => !value)}
                title="切换 API 模型"
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
              >
                <span className="agent-chip-text">{apiModel || '选择模型'}</span>
                <CaretDown size={9} weight="bold" />
              </button>
              {modelMenuOpen && (
                <div className="popover agent-tune-menu" role="menu">
                  {apiModels.map((model) => (
                    <button
                      key={model}
                      type="button"
                      role="menuitemradio"
                      aria-checked={model === apiModel}
                      className="menu-item agent-tune-item"
                      onClick={() => {
                        setSelectedModel(model);
                        setConfig('agent.api.model', model);
                        setModelMenuOpen(false);
                      }}
                    >
                      <span className="agent-tune-label">{model}</span>
                      <span className="menu-check" aria-hidden="true">
                        <Check size={11} weight="bold" />
                      </span>
                    </button>
                  ))}
                  {apiModels.length === 0 && (
                    <button type="button" className="menu-item agent-tune-item" onClick={onOpenSettings}>
                      <span className="agent-tune-label">尚未获取模型，打开 API 配置</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <span className="agent-foot-gap" />
            {running ? (
              <button
                type="button"
                className="agent-send stop"
                onClick={stop}
                disabled={kind === 'api'}
                title="停下"
                aria-label="停下"
              >
                <Stop size={14} weight="fill" />
              </button>
            ) : (
              <button
                type="button"
                className="agent-send"
                onClick={() => send()}
                disabled={!input.trim() || !apiReady}
                title="发送（Enter，Shift + Enter 换行）"
                aria-label="发送"
              >
                <ArrowUp size={14} weight="bold" />
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
