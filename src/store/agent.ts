/**
 * Front-end façade for the local agent, plus a translation of two event streams.
 *
 * The Rust side only forwards the CLI's stdout line by line without parsing it —
 * because what a line of JSON *means* is only of interest to whoever displays
 * it. claude and codex each speak their own dialect (Anthropic's stream-json on
 * one side, codex's own msg events on the other), and both are translated here
 * into the same kind of timeline entry, so the panel never has to know which
 * one it is talking to.
 *
 * The translation is selective rather than exhaustive: token counts, chains of
 * thought and tool receipts churn quickly and help nobody, so they are dropped.
 * Three things survive — what it said, which file it touched, and whether
 * anything went wrong. How the draft changed is not reported down this path;
 * the disk watcher says that.
 *
 * "What it said" arrives two ways: character by character (claude's
 * text_delta), and as a whole block (the closing assistant message, or codex's
 * item.completed).
 * Both describe the same sentence, so they are not laid out as two timeline
 * entries — the increments append to the beat currently being spoken, and when
 * the whole block arrives it becomes the final word on that beat.
 * If the incremental path ever disappears (a CLI that emits no stream_event),
 * the block path still delivers the text; the worst case is falling back to
 * "spinner for a while, then a whole paragraph at once".
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type AgentKind = 'claude' | 'codex';

/**
 * Reasoning effort. Both CLIs take the same four words; claude has one more
 * above them, and calls it a flag where codex calls it a config key.
 */
export const EFFORTS: Record<AgentKind, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};

/** One entry in the model menu */
export interface ModelChoice {
  id: string;
  label: string;
}

/** What this machine's CLI can be pointed at, plus what it is pointed at now */
export interface ModelList {
  models: ModelChoice[];
  /** The model that CLI's own config names — the "default" entry says so */
  current: string | null;
}

/**
 * Ask what models this CLI offers here.
 *
 * Not a constant, because codex's list is genuinely per-machine: `model` and
 * the catalog behind it live in ~/.codex, and a switcher rewrites both to point
 * at another provider entirely.
 */
export function agentModels(kind: AgentKind): Promise<ModelList> {
  return invoke<ModelList>('agent_models', { kind });
}

/** Whether this machine has that CLI. bin === null means not found */
export interface AgentInfo {
  kind: AgentKind;
  bin: string | null;
  /** Where it was found: settings / PATH / a common location */
  source: string;
}

/**
 * One conversation.
 *
 * The key is local and exists from creation; cliId only appears once the first
 * run has started and the CLI has reported its own session id (claude's
 * session_id, codex's thread_id). "Continue" means handing that back to it.
 * lines is what we have already displayed — kept for re-reading, never sent
 * anywhere again.
 */
export interface Session {
  key: string;
  kind: AgentKind;
  cliId: string | null;
  /** The first message, used as the title */
  title: string;
  updatedAt: number;
  lines: Beat[];
}

/** Conversations held in this workspace. An empty list the first time it opens */
export async function readSessions(dir: string): Promise<Session[]> {
  const raw = await invoke<Session[] | null>('agent_sessions_read', { dir });
  return Array.isArray(raw) ? raw : [];
}

export function writeSessions(dir: string, sessions: Session[]): Promise<void> {
  return invoke('agent_sessions_write', { dir, sessions });
}

/** A raw event as it comes from the Rust side */
export interface RawEvent {
  runId: string;
  kind: AgentKind;
  stream: 'stdout' | 'stderr' | 'exit';
  line: string;
}

/**
 * What a tool call is doing, in the coarsest terms that still tell them apart.
 *
 * The panel picks an icon off this and nothing else — the exact tool name is
 * already spelled out next to it, so the icon's job is only to make a run of
 * calls scannable at a glance: shell, file, search, network.
 */
export type ToolAct = 'run' | 'read' | 'edit' | 'search' | 'web' | 'mcp' | 'task' | 'other';

/** One entry on the timeline. role decides how it looks, not where it came from */
export interface Beat {
  role: 'you' | 'agent' | 'tool' | 'note';
  /** For a tool call this is only the target — the file, the command, the
   *  query. The name of the call itself is `verb` */
  text: string;
  /** The kind of note that went wrong — a little redder */
  bad?: boolean;
  /** Tool calls only. Absent on sessions written before the split, which is
   *  why the panel still renders a tool beat that has nothing but `text` */
  act?: ToolAct;
  /** Tool calls only: what to call it. `Bash`, `Read`, or an MCP server name */
  verb?: string;
}

/** Result of translating one line: possibly entries, possibly a session id to
 *  claim, possibly the news that this run is over */
export interface Interpreted {
  beats: Beat[];
  /** The sentence being spoken grew by this much (append to the end) */
  delta?: string;
  /** The sentence being spoken now reads exactly like this (a snapshot, not an
   *  increment — overwrite) */
  live?: string;
  /** That sentence is finished, and this is its final text. With nobody
   *  speaking, this is simply a new entry */
  seal?: string;
  /** claude's session_id, for --resume on the next run */
  sessionId?: string;
  /** This run is over, one way or another */
  done?: boolean;
}

const NOTHING: Interpreted = { beats: [] };

/* ---------------- Calls ---------------- */

export function probeAgents(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>('agent_probe');
}

/**
 * Start a run and return its run_id.
 *
 * Passing a conversation's session id as `resume` continues it: claude takes
 * its session_id, codex its thread_id. Both are the CLI's own, and we only hand
 * them back verbatim.
 */
export function runAgent(args: {
  dir: string;
  kind: AgentKind;
  prompt: string;
  resume?: string | null;
  /** Empty / null on either means "leave the CLI's own config alone", which is
   *  also what the composer's "默认" entries send */
  model?: string | null;
  effort?: string | null;
}): Promise<string> {
  return invoke<string>('agent_run', {
    dir: args.dir,
    kind: args.kind,
    prompt: args.prompt,
    resume: args.resume ?? null,
    opts: { model: args.model ?? null, effort: args.effort ?? null },
  });
}

export function stopAgent(runId: string): Promise<void> {
  return invoke('agent_stop', { runId });
}

export function onAgentEvent(cb: (e: RawEvent) => void): Promise<UnlistenFn> {
  return listen<RawEvent>('agent:event', (e) => cb(e.payload));
}

/* ---------------- Translation ---------------- */

/** Collapse an absolute path to a workspace-relative one — the panel is narrow,
 *  and nobody needs to read the home-directory prefix */
function rel(dir: string, path: string): string {
  if (!path) return path;
  if (dir && path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
  return path;
}

/** The long absolute workspace path in a command line is pure dead weight in a
 *  330px panel */
function shorten(dir: string, text: string): string {
  if (!dir) return text;
  // Strip "directory + slash" first, then turn whatever still points at the
  // workspace itself into .
  return text.split(`${dir}/`).join('').split(dir).join('.');
}

function clip(text: string, max = 76): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Translate claude's apiKeySource into plain words.
 *
 * "none" means no API key was used, i.e. the subscription login in the
 * keychain; everything else is a key of some sort (environment variable,
 * apiKeyHelper, or the one /login manages). Switchers like cc-switch change
 * exactly that underlying configuration, so reporting it as-is is enough — the
 * panel adds no switch of its own: whatever you are in a terminal, you are here.
 */
function whoPays(source: unknown): string {
  if (typeof source !== 'string' || !source) return '';
  if (source === 'none') return '订阅登录';
  if (source === 'ANTHROPIC_API_KEY' || source === 'ANTHROPIC_AUTH_TOKEN') return 'API key';
  if (source === 'apiKeyHelper') return 'API key · apiKeyHelper';
  return `API key · ${source}`;
}

/** claude names its tools; this is only the sorting of those names into the
 *  handful of shapes the panel draws an icon for */
const CLAUDE_ACTS: Record<string, ToolAct> = {
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'task',
  TodoWrite: 'task',
};

/** `mcp__linear__list_issues` is a wire name, not something to read. The half
 *  worth showing is which server and which call */
function mcpName(name: string): string {
  const parts = name.split('__').filter(Boolean);
  return parts.length > 1 ? `${parts[1]} · ${parts.slice(2).join(' ')}`.trim() : name;
}

/** One of claude's tool calls, split into "what it is" and "what it is on".
 *  Picks the argument that best says what is being touched */
function describeTool(dir: string, name: string, input: Record<string, unknown>): Beat {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const act: ToolAct = name.startsWith('mcp__') ? 'mcp' : CLAUDE_ACTS[name] ?? 'other';
  const verb = act === 'mcp' ? mcpName(name) : name;
  const file = pick('file_path') || pick('notebook_path') || pick('path');
  if (file) return { role: 'tool', act, verb, text: rel(dir, file) };
  const gist = pick('command') || pick('pattern') || pick('description') || pick('prompt');
  // Clipped far longer than the panel is wide: the strip trims to its own
  // width with an ellipsis, and the untrimmed text is the hover tooltip
  return { role: 'tool', act, verb, text: gist ? clip(shorten(dir, gist), 160) : '' };
}

/** claude：stream-json */
function fromClaude(dir: string, obj: Record<string, any>): Interpreted {
  // Field order on the closing line is not fixed, so is_error is a more
  // reliable signal than type
  if (obj.type === 'result' || typeof obj.is_error === 'boolean') {
    if (obj.is_error) {
      return { beats: [{ role: 'note', text: clip(String(obj.result ?? '这轮出错了'), 160), bad: true }], done: true };
    }
    return { beats: [], done: true };
  }
  if (obj.type === 'system' && obj.subtype === 'init') {
    // Whose quota it runs on is neither ours to guess nor yours to pick here:
    // the CLI says so itself in its opening line
    const about = [whoPays(obj.apiKeySource), obj.model].filter(Boolean).join(' · ');
    return {
      beats: [{ role: 'note', text: about ? `working · ${about}` : 'working' }],
      sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    };
  }
  // The incremental path. Body text only: thinking_delta is it thinking to
  // itself rather than speaking to you, and input_json_delta is a tool argument
  // being assembled one character at a time — once assembled, a tool line
  // follows anyway

  if (obj.type === 'stream_event') {
    const ev = obj.event as Record<string, any> | undefined;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const text = String(ev.delta.text ?? '');
      return text ? { beats: [], delta: text } : NOTHING;
    }
    return NOTHING;
  }
  if (obj.type === 'assistant' && obj.message?.content) {
    const beats: Beat[] = [];
    const said: string[] = [];
    for (const block of obj.message.content as Record<string, any>[]) {
      if (block.type === 'text' && block.text?.trim()) {
        said.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        beats.push(describeTool(dir, String(block.name ?? 'tool'), block.input ?? {}));
      }
    }
    // This whole block is the same sentence that just streamed past, so it is a
    // final draft, not a repeat.
    // It wins: the provisional closures made while streaming, so no half-written
    // syntax showed, are all discarded here

    return said.length ? { beats, seal: said.join('\n\n') } : { beats };
  }
  // Tool receipts, thinking, rate-limit notices: skipped
  return NOTHING;
}

/**
 * Strip the shell wrapper around a command line (`/bin/zsh -lc 'the real
 * thing'`).
 * The panel should show what it did, not how the process was started.
 */
function unwrapShell(command: string): string {
  const m = command.match(/^\S*(?:sh|zsh|bash)\s+-l?c\s+'([\s\S]*)'$/);
  return m ? m[1] : command;
}

/**
 * Newer codex (0.100 and after): thread / turn / item events.
 *
 * Tool lines only accept `item.completed`. `item.started` is an optional
 * streaming extra, and relying on it alone would drop the line entirely on any
 * version that stops emitting it; taking only completed costs at most showing
 * the command once it has finished, with "still working" covering the gap.
 */
function fromCodexItems(dir: string, obj: Record<string, any>): Interpreted {
  switch (obj.type) {
    case 'thread.started':
      return {
        beats: [{ role: 'note', text: 'working' }],
        // Newer versions finally supply a session id, so continuing no longer
        // gambles on "the most recent one"
        sessionId: typeof obj.thread_id === 'string' ? obj.thread_id : undefined,
      };
    case 'turn.completed':
      return { beats: [], done: true };
    case 'turn.failed':
      return {
        beats: [{ role: 'note', text: clip(String(obj.error?.message ?? '这轮失败了'), 160), bad: true }],
        done: true,
      };
    case 'error':
      return { beats: [{ role: 'note', text: clip(String(obj.message ?? '出错了'), 160), bad: true }] };
    case 'item.completed': {
      const item = obj.item as Record<string, any> | undefined;
      if (!item) return NOTHING;
      switch (item.type) {
        case 'agent_message':
          return item.text?.trim() ? { beats: [], seal: String(item.text).trim() } : NOTHING;
        case 'command_execution': {
          const cmd = clip(shorten(dir, unwrapShell(String(item.command ?? ''))), 160);
          const bad = typeof item.exit_code === 'number' && item.exit_code !== 0;
          return {
            beats: [
              { role: 'tool', act: 'run', verb: 'shell', text: bad ? `${cmd}（退出 ${item.exit_code}）` : cmd, bad },
            ],
          };
        }
        case 'file_change': {
          const files = (item.changes ?? []).map((c: Record<string, any>) => rel(dir, String(c.path ?? '')));
          return files.length
            ? { beats: [{ role: 'tool', act: 'edit', verb: 'edit', text: files.join('、') }] }
            : NOTHING;
        }
        case 'mcp_tool_call':
          return {
            beats: [
              { role: 'tool', act: 'mcp', verb: String(item.server ?? 'mcp'), text: String(item.tool ?? '') },
            ],
          };
        case 'web_search':
          return {
            beats: [{ role: 'tool', act: 'web', verb: 'search', text: clip(String(item.query ?? ''), 120) }],
          };
        case 'error':
          return { beats: [{ role: 'note', text: clip(String(item.message ?? '出错了'), 160), bad: true }] };
        default:
          // reasoning / todo_list / whatever gets added later: not on the timeline
          return NOTHING;
      }
    }
    // A half-spoken beat. 0.149's exec --json does not emit this (agent_message
    // only ever arrives as one whole item.completed); handling it means the day
    // it does emit one, it just works — and until then this case is simply never
    // reached, and nobody loses a sentence over it


    case 'item.updated': {
      const item = obj.item as Record<string, any> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        // What it gives is "the sentence so far", not the newly grown fragment,
        // so this overwrites rather than appends
        return { beats: [], live: item.text };
      }
      return NOTHING;
    }
    default:
      // turn.started / item.started: not on the timeline
      return NOTHING;
  }
}

/** codex: exec --json. Both event dialects are accepted — old is {id,msg},
 *  new is {type,item} */
function fromCodex(dir: string, obj: Record<string, any>): Interpreted {
  if (!obj.msg) {
    if (typeof obj.type === 'string') return fromCodexItems(dir, obj);
    // The opening line on older versions is this run's configuration: model and
    // provider (a provider of `custom` means it is not the official one)
    if (typeof obj.model === 'string') {
      const about = [obj.model, obj.provider].filter((v) => typeof v === 'string' && v).join(' · ');
      return { beats: [{ role: 'note', text: about ? `working · ${about}` : 'working' }] };
    }
    return NOTHING;
  }
  const msg = obj.msg as Record<string, any>;
  switch (msg.type) {
    case 'agent_message':
      return msg.message?.trim() ? { beats: [], seal: String(msg.message).trim() } : NOTHING;
    case 'exec_command_begin': {
      const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command ?? '');
      return { beats: [{ role: 'tool', act: 'run', verb: 'shell', text: clip(shorten(dir, cmd), 160) }] };
    }
    case 'patch_apply_begin': {
      const files = Object.keys(msg.changes ?? {}).map((p) => rel(dir, p));
      return files.length
        ? { beats: [{ role: 'tool', act: 'edit', verb: 'edit', text: files.join('、') }] }
        : NOTHING;
    }
    case 'error':
      return { beats: [{ role: 'note', text: clip(String(msg.message ?? '出错了'), 160), bad: true }] };
    case 'task_complete':
      return { beats: [], done: true };
    default:
      // token_count / output deltas / chain of thought / task_started: not on the timeline
      return NOTHING;
  }
}

/** We wire the child process's stdin to null, which is why codex mentions it
 *  every time. That is our doing, not a message */
const OUR_OWN_NOISE = /^Reading additional input from stdin/;
/** The line prefix from Rust's tracing: timestamp, level, module path. What a
 *  person wants is the half after the colon */
const TRACING_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+[\w:]+:\s*/;

/** Whether a stderr line is worth a timeline entry, and if so, how it reads */
function tidyStderr(line: string): string {
  const text = line.replace(TRACING_PREFIX, '').trim();
  return OUR_OWN_NOISE.test(text) ? '' : text;
}

/**
 * Collapse stderr that keeps reporting the same thing within one run (a dozen
 * skill files with the same defect, say) into a single line.
 *
 * Deduplication asks "is it still the same once paths and numbers are stripped"
 * — those dozen lines differ only in file name and are saying one thing, and
 * posting it a dozen times only pushes the useful line off screen.
 */
export function stderrGist(line: string): string {
  return line.replace(/\/[^\s:]+/g, '…').replace(/\d+/g, '#');
}

/**
 * Translate one raw event into timeline entries.
 *
 * Lines that are not JSON occasionally turn up in stdout (the CLI's own startup
 * notices); ignoring them is fine — if something actually goes wrong, the
 * stderr path delivers it verbatim.
 */
export function interpret(dir: string, e: RawEvent): Interpreted {
  if (e.stream === 'exit') {
    // A normal exit (0) has already been announced by result / task_complete,
    // so only the abnormal ones matter here
    if (e.line === '0') return { beats: [], done: true };
    if (e.line === 'stopped') return { beats: [{ role: 'note', text: '已停下' }], done: true };
    return { beats: [{ role: 'note', text: `进程退出（${e.line}）`, bad: true }], done: true };
  }
  if (e.stream === 'stderr') {
    const said = tidyStderr(e.line);
    return said ? { beats: [{ role: 'note', text: clip(said, 200), bad: true }] } : NOTHING;
  }
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(e.line);
  } catch {
    return NOTHING;
  }
  return e.kind === 'claude' ? fromClaude(dir, obj) : fromCodex(dir, obj);
}
