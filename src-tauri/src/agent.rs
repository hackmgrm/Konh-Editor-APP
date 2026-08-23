//! Run a local command-line agent (claude / codex) inside the workspace and
//! forward its output to the front end.
//!
//! No model API is wired in here — this runs the CLI already on the user's own
//! machine, under their own account and their own configuration. The editor
//! does three things: start the process inside the workspace, emit its stdout
//! JSONL line by line, and kill it when asked.
//!
//! Edits do not come back down this path: the agent writes .md files on disk
//! and the `vault_watch` chain notices and reloads them as usual. So the worst
//! that a break in this module can cause is "the panel stopped moving" — the
//! draft still changes exactly as it would have, the same as running the CLI in
//! a terminal yourself.
//!
//! Both CLIs have a non-interactive, structured-output mode:
//!   claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
//!   codex exec --json <prompt>
//! Their event shapes have nothing in common; translating them into one
//! timeline is the front end's job (see src/store/agent.ts).
//! This side does not parse, merge or deduplicate — the same approach as
//! vault_watch: whoever needs to understand it, understands it.
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config;

const CLAUDE: &str = "claude";
const CODEX: &str = "codex";

/// Running processes live here, so "stop" can find them.
///
/// A process has exactly two ends: EOF on stdout (a natural finish) or
/// agent_stop (killed). Both are "remove from the map first, and whoever got it
/// is responsible for the wait", so nobody ever reaps twice.
#[derive(Default)]
pub struct AgentState(pub Mutex<HashMap<String, Child>>);

/// A run_id only has to be unique within this process — the front end uses it
/// to match events back to its own run
static RUN_SEQ: AtomicU64 = AtomicU64::new(1);

/* ---------------- Finding the executable ---------------- */

/// A GUI app launched from Finder gets launchd's environment, where PATH is
/// usually just /usr/bin:/bin:/usr/sbin:/sbin — none of the user's shell paths
/// (~/.local/bin, nvm, homebrew) are in it. So this borrows a login shell to
/// ask what PATH really is; the answer is used both to find the CLI and to
/// build the child process's environment (claude is a node script, and without
/// node on PATH it will not start either).
///
/// The same holds on Linux and for the same reason: an app started from a
/// .desktop entry (or from inside an AppImage or a Flatpak) gets the session's
/// environment, which is built from ~/.profile and knows nothing of the nvm or
/// mise lines the user put in .bashrc.
///
/// Asking is expensive — see `warm_path`, which is why nobody calls this
/// directly.
///
/// `-l -i -c` rather than `-l -c`: tools like nvm and mise are usually only
/// written into .zshrc / .bashrc, which a non-interactive shell does not read
/// at all. Given as three separate flags because a combined `-lic` is a bourne
/// convention, and not every login shell parses one.
///
/// Windows has no equivalent problem and no equivalent trick: there is no login
/// shell, and a process started from Explorer inherits the user's real
/// environment — including whatever npm, scoop or winget put on PATH. So the
/// process PATH is already the right answer there.
fn ask_shell() -> Option<String> {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        // fish's PATH is a *list*, not a colon-joined string: `"$PATH"` there
        // expands to the directories joined by spaces, which is not a PATH at
        // all and leaves the user looking at "没找到 claude" with claude sitting
        // on their PATH. `string join` is how fish spells the same question.
        let fish = Path::new(&shell).file_name().and_then(|n| n.to_str()) == Some("fish");
        let script = if fish {
            "string join : $PATH"
        } else {
            "printf %s \"$PATH\""
        };
        let out = Command::new(&shell)
            .args(["-l", "-i", "-c", script])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        // An rc file may print a welcome banner of its own; what we want
        // is the last segment (printf emits no trailing newline)
        text.lines()
            .rev()
            .find(|l| l.contains('/'))
            .map(|s| s.trim().to_string())
    }
    #[cfg(not(unix))]
    {
        std::env::var("PATH").ok()
    }
}

/// What `ask_shell` last answered.
///
/// Not a OnceLock, because this is filled from three directions: the copy left
/// on disk by an earlier launch (instantly), the shell itself (slowly), and
/// whoever asks first if neither has arrived yet.
static PATH_CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
/// Held while a shell is being asked. Starting a second one to learn the same
/// answer would only cost another few seconds
static ASKING: Mutex<()> = Mutex::new(());

fn path_cache() -> &'static Mutex<Option<String>> {
    PATH_CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_path() -> Option<String> {
    path_cache().lock().ok().and_then(|slot| slot.clone())
}

fn remember_path(value: &str) {
    if let Ok(mut slot) = path_cache().lock() {
        *slot = Some(value.to_string());
    }
}

/// Where the answer is kept between launches. One line of text, next to the
/// other application-level files
fn path_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("agent-path"))
}

/// The PATH of a login shell, asked at most once and then remembered.
///
/// Nobody should ever reach the slow branch here: `warm_path` runs at startup
/// and normally has the answer long before the panel is opened. It stays as
/// the fallback for the launch where someone opens the panel within the first
/// second — and even then the wait is served off the main thread, so it is a
/// spinner in the panel rather than a frozen window.
fn login_path() -> Option<String> {
    if let Some(known) = cached_path() {
        return Some(known);
    }
    let _busy = ASKING.lock().unwrap_or_else(|e| e.into_inner());
    // Whoever held the lock may have been asking this very question
    if let Some(known) = cached_path() {
        return Some(known);
    }
    let fresh = ask_shell();
    if let Some(value) = &fresh {
        remember_path(value);
    }
    fresh
}

/// Learn the login shell's PATH in the background, before anyone needs it.
///
/// Starting an interactive login shell is not cheap — it reads .zshrc and
/// everything the user has hung off it (nvm, oh-my-zsh, conda), which on a
/// well-furnished machine is measured in seconds, not milliseconds. Paying for
/// that at the moment the Agent panel opens is what made the first click feel
/// broken, so it is paid here instead: at startup, on a thread of its own,
/// while the window is still busy being drawn.
///
/// The answer also survives the launch. A PATH does not change between two
/// runs of an editor often enough to justify asking again before answering, so
/// the copy on disk is handed out straight away and the shell is asked anyway
/// — a machine that grew a new node version gets it right on the next launch.
pub fn warm_path(app: &AppHandle) {
    // Only Unix pays for this; on Windows the process environment is already
    // the right answer, and a day-old copy of it would be a worse one
    let keep = cfg!(unix);
    if keep && cached_path().is_none() {
        if let Some(saved) = path_file(app).and_then(|p| std::fs::read_to_string(p).ok()) {
            let saved = saved.trim();
            if saved.contains('/') {
                remember_path(saved);
            }
        }
    }
    let _busy = ASKING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(fresh) = ask_shell() else { return };
    if cached_path().as_deref() == Some(fresh.as_str()) {
        return;
    }
    remember_path(&fresh);
    if keep {
        if let Some(file) = path_file(app) {
            let _ = std::fs::write(file, &fresh);
        }
    }
}

/// The file names one CLI can have across install methods (npm on Windows
/// produces a .cmd, the native installer a .exe).
///
/// `.exe` is tried first on purpose. A `.cmd` is a batch file, which cannot be
/// executed directly — the standard library has to route it through cmd.exe,
/// and cmd.exe brings its own command-line limits with it (see `feed_prompt`).
/// When both exist, the one that needs no interpreter is the better handle.
fn exe_names(kind: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{kind}.exe"), format!("{kind}.cmd"), kind.to_string()]
    } else {
        vec![kind.to_string()]
    }
}

fn find_in_dirs(dirs: impl IntoIterator<Item = PathBuf>, names: &[String]) -> Option<PathBuf> {
    for dir in dirs {
        for name in names {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The fallback when PATH could not be obtained either: if it is installed in
/// one of these places, it is installed.
///
/// The two lists have nothing in common because the package managers do not:
/// on macOS it is homebrew and a handful of `~/.x/bin` conventions, on Windows
/// it is npm's global prefix under %APPDATA%, scoop's shim directory, and
/// whatever winget dropped into Programs.
fn fallback_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    #[cfg(not(windows))]
    {
        // macOS: homebrew on Apple silicon, then on Intel
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        #[cfg(target_os = "linux")]
        {
            // Linuxbrew installs to its own prefix, and a snap puts its shims
            // somewhere no shell profile mentions
            dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
            dirs.push(PathBuf::from("/snap/bin"));
        }
        if let Ok(home) = app.path().home_dir() {
            for rel in [
                ".local/bin",
                ".bun/bin",
                ".cargo/bin",
                ".npm-global/bin",
                ".volta/bin",
                ".deno/bin",
                // pnpm's global bin on Linux, and where fnm keeps its default
                // alias when it was not installed through a version manager dir
                ".local/share/pnpm",
                ".local/share/fnm/aliases/default/bin",
            ] {
                dirs.push(home.join(rel));
            }
            // nvm keeps one directory per node version, and the CLI is installed
            // under one of them; try them all
            if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
                for e in entries.flatten() {
                    dirs.push(e.path().join("bin"));
                }
            }
        }
    }

    #[cfg(windows)]
    {
        // `npm i -g` puts the shims straight in the prefix directory, not a bin/
        // subdirectory the way it does on Unix
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(&appdata).join("npm"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Programs"));
            // fnm / volta keep one directory per node version, same idea as nvm
            for mgr in ["fnm_multishells", "Volta\\bin"] {
                dirs.push(PathBuf::from(&local).join(mgr));
            }
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            dirs.push(PathBuf::from(&pf).join("nodejs"));
        }
        if let Ok(home) = app.path().home_dir() {
            // `.local\bin` is where claude's own Windows installer (the
            // `irm claude.ai/install.ps1` route) puts claude.exe — nothing to do
            // with npm, and nothing else on this list covers it
            for rel in [".local\\bin", "scoop\\shims", ".bun\\bin", ".cargo\\bin", "AppData\\Roaming\\npm"] {
                dirs.push(home.join(rel));
            }
        }
    }

    dirs
}

/* ---------------- Windows process quirks ---------------- */

/// Keep a console window from flashing up.
///
/// On Windows a GUI process that spawns a console program gets a console window
/// for it, and both CLIs are console programs — so without this, every single
/// run pops a black rectangle in front of the editor for as long as it lasts.
/// CREATE_NO_WINDOW (0x08000000) is the documented way to say "run it, but do
/// not give it a window".
#[cfg(windows)]
fn no_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_console(_cmd: &mut Command) {}

/// Put the child at the head of its own process group, so "stop" can take the
/// whole group later.
///
/// Killing the handle we hold is not killing the run. An agent's work *is*
/// subprocesses — ripgrep, git, a build, whatever its Bash tool was told to do —
/// and on Unix those are children of the CLI, not of us: kill the CLI alone and
/// they carry on, writing into the workspace, with nothing left holding a
/// handle on them. Windows already avoids that with `taskkill /T`; this is the
/// same guarantee for macOS and Linux (see `kill_tree`).
///
/// The cost is that the child no longer shares our process group, so a Ctrl+C
/// in the terminal that started `npm run app` no longer reaches it. That is the
/// dev loop only, and `agent_stop` covers it either way.
#[cfg(unix)]
fn own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn own_process_group(_cmd: &mut Command) {}

/// Kill a run and everything it started — the same promise on all three
/// platforms, reached three different ways.
///
/// **Windows.** `npm i -g` installs these CLIs as `claude.cmd`, a batch file —
/// and a batch file cannot be executed directly, so the standard library runs
/// it through cmd.exe. The handle we hold is therefore cmd.exe's, and killing
/// it leaves the node process underneath alive: still running, still holding
/// the workspace, with nothing left to stop it by. `taskkill /T` walks the
/// process tree and takes the whole thing.
///
/// **macOS and Linux.** The child leads its own process group (see
/// `own_process_group`), and a negative pid is how you address a group. `kill`
/// is used rather than libc so this stays free of another dependency; it is in
/// /bin on both, which is on the PATH of even a launchd-minimal environment.
///
/// The direct kill afterwards is belt and braces for both: the group or tree
/// call may find nothing, or the tool may be missing.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_console(&mut c);
        let _ = c.status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Settings key holding an absolute path. What the user types into the panel
/// lands here (config.rs's settings.json)
fn bin_key(kind: &str) -> String {
    format!("agent.bin.{kind}")
}

/// Find the CLI: the user's absolute path → the login shell's PATH → common
/// locations.
/// The second return value is where it was found, purely so the panel can say
/// so in plain words.
fn resolve(app: &AppHandle, kind: &str) -> Option<(PathBuf, &'static str)> {
    let names = exe_names(kind);
    if let Some(custom) = config::get(app, &bin_key(kind)) {
        let p = PathBuf::from(custom.trim());
        if p.is_file() {
            return Some((p, "设置"));
        }
    }
    if let Some(path_env) = login_path() {
        if let Some(p) = find_in_dirs(std::env::split_paths(&path_env), &names) {
            return Some((p, "PATH"));
        }
    }
    find_in_dirs(fallback_dirs(app), &names).map(|p| (p, "常见位置"))
}

/* ---------------- The child process's environment ---------------- */

/// The environment variables that can hijack a CLI wholesale onto another provider.
///
/// They exist for terminal use (routing an API key through a relay, pointing at
/// a self-hosted gateway). The problem is that a child process inherits its
/// parent's environment by default, and this parent's environment depends
/// entirely on **how the app was launched**: started from a terminal with
/// `npm run app`, it carries that terminal's exports; double-clicked from
/// Finder, launchd's environment has none of them. One panel, two behaviors,
/// and no way for the user to tell them apart — the CLI only says something
/// like "connector disabled".
///
/// So they are stripped before the process starts, and the CLI resolves its
/// identity through its own configuration (the subscription login in the
/// keychain, a key in ~/.claude/settings.json, apiKeyHelper…) — that is, the
/// identity you get typing `claude` in a terminal, which is also exactly what
/// switchers like cc-switch change. Which one it ends up using is not ours to
/// guess: it announces it in its opening event, and the panel shows what it
/// said (see src/store/agent.ts).
fn hijack_env(kind: &str) -> &'static [&'static str] {
    if kind == CLAUDE {
        &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_CUSTOM_HEADERS",
        ]
    } else {
        &["OPENAI_API_KEY", "OPENAI_BASE_URL"]
    }
}

/// The loader variables an AppImage sets for its own sake.
///
/// An AppImage runs with `LD_LIBRARY_PATH` and friends pointed inside the
/// mounted image, so the bundled GTK/WebKit stack is what gets loaded. A child
/// process inherits all of it — and then `node` resolves against the AppImage's
/// libraries rather than the system's, which ends in a version mismatch and a
/// CLI that dies before printing anything. Dropping them puts the child back on
/// the system loader, which is where it was installed to run.
///
/// Only when `APPDIR` says we are actually inside one: outside an AppImage
/// these are the user's own, and not ours to remove.
const APPIMAGE_ENV: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GTK_PATH",
    "GIO_MODULE_DIR",
    "GDK_PIXBUF_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR",
    "PYTHONPATH",
    "PERLLIB",
];

/// Strip them before starting the process; see hijack_env and APPIMAGE_ENV for why
fn scrub_env(cmd: &mut Command, kind: &str) {
    for key in hijack_env(kind) {
        cmd.env_remove(key);
    }
    if cfg!(target_os = "linux") && std::env::var_os("APPDIR").is_some() {
        for key in APPIMAGE_ENV {
            cmd.env_remove(key);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    kind: String,
    /// The absolute path found, or null
    bin: Option<String>,
    /// Where it was found (settings / PATH / a common location); empty when not found
    source: String,
}

/// Asked once when the panel opens: which of these is usable on this machine.
///
/// `async`, because on the launch where nobody warmed the PATH in time this
/// waits on a login shell — and a synchronous command holds the main thread
/// while it waits, which is the whole window, not just this panel.
#[tauri::command(async)]
pub fn agent_probe(app: AppHandle) -> Vec<AgentInfo> {
    [CLAUDE, CODEX]
        .iter()
        .map(|kind| {
            let found = resolve(&app, kind);
            AgentInfo {
                kind: kind.to_string(),
                bin: found.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
                source: found.map(|(_, s)| s.to_string()).unwrap_or_default(),
            }
        })
        .collect()
}

/* ---------------- Session history ---------------- */

/// Where the panel's conversation records live: the app config directory, kept
/// separate per workspace path.
///
/// What is stored is **what we displayed**, plus the session id the CLI gave
/// us — not the CLI's own session files (`~/.claude/projects/…`,
/// `~/.codex/sessions/…`). Those are internal formats that can change with a
/// version, and codex moving from `msg` to `item` this time is the ready-made
/// example.
/// "Continue" does not need that file either: hand the id back to the CLI and
/// it remembers the rest.
///
/// The cost is that only sessions started from the panel are visible here. Ones
/// opened in a terminal never appear in this history — and for those,
/// `claude --resume` in that same terminal is the easier route anyway.
///
/// Not kept in the workspace: this is "who I talked to about what, on this
/// machine", not part of the draft, and letting it travel with git would only
/// be awkward.
const SESSIONS_FILE: &str = "agent-sessions.json";

type SessionsMap = std::collections::BTreeMap<String, serde_json::Value>;

fn sessions_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(SESSIONS_FILE))
}

fn read_sessions_map(app: &AppHandle) -> SessionsMap {
    sessions_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Conversations held in this workspace. null when there are none, which the
/// front end treats as an empty list
#[tauri::command]
pub fn agent_sessions_read(app: AppHandle, dir: String) -> serde_json::Value {
    read_sessions_map(&app)
        .get(&dir)
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn agent_sessions_write(
    app: AppHandle,
    dir: String,
    sessions: serde_json::Value,
) -> Result<(), String> {
    let mut map = read_sessions_map(&app);
    map.insert(dir, sessions);
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    std::fs::write(sessions_path(&app)?, text).map_err(|e| format!("存不了会话记录：{e}"))
}

/* ---------------- Running ---------------- */

/// Start the CLI with nothing held back: no sandbox, no approval gate.
///
/// This is not a default that a setting can move off — the panel has no
/// permission control, and this is the whole of the policy. The reasoning is
/// that the alternatives are all worse here:
///
/// * A real "ask me first" is not on offer. `claude -p` has no channel to
///   prompt on and denies the tool call instead ("requested permissions … but
///   you haven't granted it yet"); `codex exec` has no approval channel at all,
///   its only approval-shaped flag being `--approve-for-me`, which is another
///   model reviewing rather than you. A control that cannot actually stop
///   anything is worse than no control, because it reads like one.
/// * Confining codex to the workspace means Seatbelt, and Seatbelt's
///   workspace-write profile blocks outbound traffic — not the open internet
///   specifically, DNS included. Everything that reaches a service (an MCP
///   server over HTTP, curl, an RSS fetch) then dies with a name-resolution
///   error that mentions no sandbox anywhere, which is a genuinely hard failure
///   to read.
///
/// What confines the agent instead is the working directory: `cwd` is the
/// workspace and nothing points it anywhere else. That is the same bargain as
/// running the CLI in a terminal yourself, which is what this panel is.
fn open_args(kind: &str) -> Vec<String> {
    let s = str::to_string;
    if kind == CLAUDE {
        vec![s("--permission-mode"), s("bypassPermissions")]
    } else {
        // Deliberately not `--sandbox danger-full-access`: this also drops the
        // approval prompts, which `exec` would otherwise still weigh
        vec![s("--dangerously-bypass-approvals-and-sandbox")]
    }
}

/// The two settings the composer exposes, as they arrive from the panel.
///
/// Both are "unset means leave it alone" — no flag is passed and the CLI uses
/// whatever its own config says, which is exactly what you get typing `claude`
/// or `codex` in a terminal.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunOpts {
    /// A model id that CLI understands: an alias for claude (`opus`), a catalog
    /// slug for codex (`gpt-5.6-terra`)
    pub model: Option<String>,
    /// low / medium / high / xhigh, and max on claude
    pub effort: Option<String>,
}

/// Blank strings arrive from a `<select>` that means "no opinion"; they are not
/// a model called "" and must not become one on the command line
fn some(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|t| !t.is_empty())
}

/// Everything the CLI is started with **except the prompt** — that goes in on
/// stdin, see `feed_prompt`.
fn build_args(
    kind: &str,
    dir: &str,
    resume: Option<&str>,
    opts: &RunOpts,
) -> Vec<String> {
    let s = str::to_string;
    if kind == CLAUDE {
        // Under -p, stream-json requires --verbose as well, or the CLI refuses
        // to start outright.
        // --include-partial-messages asks for one more channel, stream_event:
        // character-by-character text_delta, which is what lets the panel show
        // speech as it is spoken. It runs without the flag too — every message
        // just has to accumulate whole before it is emitted, which on the panel
        // reads as "spinner for a while, then a whole paragraph at once"
        let mut args = vec![
            s("-p"),
            s("--output-format"),
            s("stream-json"),
            s("--verbose"),
            s("--include-partial-messages"),
        ];
        args.extend(open_args(kind));
        if let Some(m) = some(&opts.model) {
            args.push(s("--model"));
            args.push(s(m));
        }
        if let Some(e) = some(&opts.effort) {
            args.push(s("--effort"));
            args.push(s(e));
        }
        if let Some(id) = resume {
            args.push(s("--resume"));
            args.push(s(id));
        }
        // No prompt argument: with -p and a pipe on stdin, claude takes what
        // arrives there as the prompt
        args
    } else {
        // All of codex's global options have to precede the resume subcommand
        let mut args = vec![s("exec"), s("--json"), s("--skip-git-repo-check")];
        args.extend(open_args(kind));
        if let Some(m) = some(&opts.model) {
            args.push(s("-m"));
            args.push(s(m));
        }
        // codex has no --effort; it is a config key, and -c parses its value as
        // TOML — hence the quotes, so it arrives as a string rather than a bare
        // token the parser has to guess at
        if let Some(e) = some(&opts.effort) {
            args.push(s("-c"));
            args.push(format!("model_reasoning_effort=\"{e}\""));
        }
        args.push(s("-C"));
        args.push(s(dir));
        // Resume by thread id (newer versions supply it in thread.started),
        // rather than letting --last guess at "the most recent one"
        if let Some(id) = resume {
            args.push(s("resume"));
            args.push(s(id));
        }
        // codex wants to be told: a prompt of `-` means "read it from stdin".
        // Unlike claude, leaving it out is not the same thing — under the
        // `resume` subcommand an absent prompt is an absent prompt
        args.push(s("-"));
        args
    }
}

/* ---------------- The prompt ---------------- */

/// Hand the prompt to the process on stdin, on a thread of its own.
///
/// It used to be the last element of argv, which works everywhere except the
/// place it matters most. `npm i -g` installs these CLIs as `claude.cmd`, a
/// batch file, so the standard library runs them through `cmd.exe /c` — and a
/// command line is not a place a prompt fits:
///
/// * Rust refuses outright to put a `\r` or `\n` in a batch file's argument
///   (they would truncate the command line), so **every multi-line prompt** came
///   back as "batch file arguments are invalid" before the process even started.
///   Shift+Enter in the composer is exactly how people write more than one line.
/// * cmd.exe's line is capped at 8191 characters. Paste an outline in and the
///   prompt is silently cut in half, or the spawn fails.
///
/// Neither has an escape: newlines cannot survive a Windows command line at all.
/// stdin has no such limit and both CLIs read from it — `claude -p` takes a
/// piped prompt as its prompt, and `codex exec -` says so in its own help. So
/// this is not a Windows workaround bolted onto one branch; it is the one way
/// in that is the same on every platform.
///
/// The write happens on its own thread and the handle is dropped straight after
/// (the CLI waits for EOF): a prompt longer than the pipe buffer would
/// otherwise block this thread mid-write while the child waits for us to get
/// round to reading its output.
fn feed_prompt(child: &mut Child, prompt: String) {
    let Some(mut stdin) = child.stdin.take() else { return };
    std::thread::spawn(move || {
        use std::io::Write;
        let _ = stdin.write_all(prompt.as_bytes());
        // Dropping closes it, which is the EOF the CLI is waiting for
    });
}

/* ---------------- Which models this machine offers ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// What goes on the command line
    id: String,
    /// What the menu says
    label: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    models: Vec<ModelChoice>,
    /// The model that CLI's own configuration names, so the "default" entry in
    /// the menu can say which one that actually is rather than just "default"
    current: Option<String>,
}

/// claude names its models by alias and the aliases are stable, so unlike codex
/// there is nothing on disk worth reading. Full ids (`claude-opus-5`) work too,
/// but an alias is what survives the next release.
const CLAUDE_MODELS: &[(&str, &str)] = &[
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
    ("fable", "Fable"),
];

/// Read one top-level key out of a TOML file without a TOML parser.
///
/// Only the keys before the first `[table]` header are considered, which is
/// what makes this safe enough for the two keys wanted here: `model` must not
/// match `model_provider`, and must not pick up the `name =` inside
/// `[model_providers.custom]`. A real parser would be the honest tool, but it
/// is a whole dependency for two lines of a file we only ever read.
fn toml_top_key(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != key {
            continue;
        }
        let v = v.trim();
        // Strip an inline comment only outside the quotes
        let v = v.strip_prefix('"').and_then(|r| r.split('"').next())?;
        return Some(v.to_string());
    }
    None
}

/// The `models` array shared by codex's own `models_cache.json` and by the
/// catalog files switchers drop next to it (`model_catalog_json`). Same shape
/// either way: a slug and a display name.
fn codex_catalog(path: &Path) -> Vec<ModelChoice> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    json.get("models")
        .and_then(|m| m.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("slug")?.as_str()?.to_string();
                    let label = m
                        .get("display_name")
                        .and_then(|d| d.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(ModelChoice { id, label })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What the model menu offers for this CLI.
///
/// codex's list cannot be hard-coded: `model` and the catalog it is drawn from
/// are both per-machine, and a switcher like cc-switch rewrites them to point
/// at another provider entirely — one machine offers two DeepSeek builds where
/// another offers the stock GPT line. So the list is read from the same files
/// codex itself reads, and when neither is there the menu simply says
/// "whatever config.toml is set to" and offers nothing else, which is at least
/// true.
#[tauri::command(async)]
pub fn agent_models(app: AppHandle, kind: String) -> ModelList {
    if kind == CLAUDE {
        return ModelList {
            models: CLAUDE_MODELS
                .iter()
                .map(|(id, label)| ModelChoice {
                    id: (*id).to_string(),
                    label: (*label).to_string(),
                })
                .collect(),
            current: app
                .path()
                .home_dir()
                .ok()
                .and_then(|h| std::fs::read_to_string(h.join(".claude/settings.json")).ok())
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| v.get("model")?.as_str().map(str::to_string)),
        };
    }
    let Ok(home) = app.path().home_dir() else {
        return ModelList::default();
    };
    let dir = home.join(".codex");
    let config = std::fs::read_to_string(dir.join("config.toml")).unwrap_or_default();
    let catalog = toml_top_key(&config, "model_catalog_json")
        .map(|p| {
            let p = Path::new(&p).to_path_buf();
            if p.is_absolute() { p } else { dir.join(p) }
        })
        .filter(|p| p.exists())
        // No catalog pinned: codex keeps the list it last fetched right here
        .unwrap_or_else(|| dir.join("models_cache.json"));
    ModelList {
        models: codex_catalog(&catalog),
        current: toml_top_key(&config, "model"),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    run_id: String,
    kind: String,
    /// stdout = one line of JSON (parsed by the front end); stderr = the CLI's
    /// own words; exit = this run is over
    stream: &'static str,
    line: String,
}

fn emit(app: &AppHandle, run_id: &str, kind: &str, stream: &'static str, line: String) {
    let _ = app.emit(
        "agent:event",
        AgentEvent {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            stream,
            line,
        },
    );
}

/// Take the process out of the map and reap it, returning the exit code
/// (already taken by agent_stop means stopped)
fn reap(app: &AppHandle, run_id: &str) -> String {
    let state = app.state::<AgentState>();
    let child = state.0.lock().ok().and_then(|mut m| m.remove(run_id));
    match child {
        Some(mut c) => match c.wait() {
            Ok(s) => s.code().map(|c| c.to_string()).unwrap_or_else(|| s.to_string()),
            Err(e) => e.to_string(),
        },
        None => "stopped".to_string(),
    }
}

fn missing_hint(kind: &str) -> String {
    // `which` does not exist in cmd or PowerShell; `where` is the equivalent
    let probe = if cfg!(windows) { "where" } else { "which" };
    format!(
        "没找到 {kind} —— PATH 和常见安装位置里都没有。装过的话，在终端里跑 `{probe} {kind}`，\
         把那个路径填到面板上的输入框里。"
    )
}

/// Start a run. Returns the run_id immediately; output follows on `agent:event`.
///
/// Off the main thread for the same reason as `agent_probe`: resolving the
/// executable can end up waiting on that shell.
#[tauri::command(async)]
pub fn agent_run(
    app: AppHandle,
    state: State<'_, AgentState>,
    dir: String,
    kind: String,
    prompt: String,
    resume: Option<String>,
    opts: Option<RunOpts>,
) -> Result<String, String> {
    if kind != CLAUDE && kind != CODEX {
        return Err(format!("不认识的 agent：{kind}"));
    }
    if prompt.trim().is_empty() {
        return Err("要说点什么它才知道改哪儿".into());
    }
    if !Path::new(&dir).is_dir() {
        return Err(format!("工作区不在了：{dir}"));
    }
    let (bin, _) = resolve(&app, &kind).ok_or_else(|| missing_hint(&kind))?;

    let opts = opts.unwrap_or_default();
    let mut cmd = Command::new(&bin);
    cmd.args(build_args(&kind, &dir, resume.as_deref(), &opts))
        // cwd is the workspace, which naturally confines the agent's reach to
        // this body of work
        .current_dir(&dir)
        // The prompt goes in here rather than on the command line — see feed_prompt
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path_env) = login_path() {
        cmd.env("PATH", path_env);
    }
    // Identity is decided by the CLI's own configuration, not by where this app
    // happened to be launched from
    scrub_env(&mut cmd, &kind);
    // A .cmd shim goes through cmd.exe (the standard library arranges that for
    // batch files), and cmd.exe would otherwise arrive with a console attached
    no_console(&mut cmd);
    // Its own process group, so stopping takes the subprocesses too (see kill_tree)
    own_process_group(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("起不来 {}：{e}", bin.display()))?;

    feed_prompt(&mut child, prompt);

    let run_id = format!("run-{}", RUN_SEQ.fetch_add(1, Ordering::Relaxed));
    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let stderr = child.stderr.take().ok_or("拿不到 stderr")?;
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), child);
    log::info!("agent_run {kind} {run_id} @ {dir}");

    // stderr: the CLI's own logs and errors (a misconfiguration, not logged in),
    // carried through verbatim
    {
        let app = app.clone();
        let run_id = run_id.clone();
        let kind = kind.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    emit(&app, &run_id, &kind, "stderr", line);
                }
            }
        });
    }
    // stdout: one event per line. EOF means this run is done, and the reaping
    // happens on this thread too
    {
        let app = app.clone();
        let run_id = run_id.clone();
        let kind = kind.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    emit(&app, &run_id, &kind, "stdout", line);
                }
            }
            let code = reap(&app, &run_id);
            emit(&app, &run_id, &kind, "exit", code);
        });
    }
    Ok(run_id)
}

/// Kill a run. One that already finished counts as success — someone pressing
/// "stop" does not care that it happened to finish first
#[tauri::command]
pub fn agent_stop(state: State<AgentState>, run_id: String) -> Result<(), String> {
    let child = state.0.lock().map_err(|e| e.to_string())?.remove(&run_id);
    if let Some(mut c) = child {
        kill_tree(&mut c);
        let _ = c.wait();
        log::info!("agent_stop {run_id}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_的流式输出必须带_verbose() {
        let args = build_args(CLAUDE, "/vault", None, &RunOpts::default());
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn claude_要逐字的那路事件() {
        let args = build_args(CLAUDE, "/vault", None, &RunOpts::default());
        assert!(
            args.contains(&"--include-partial-messages".to_string()),
            "少了它就没有 text_delta，面板只能整段整段地蹦"
        );
    }

    #[test]
    fn 续接时才带_resume() {
        let fresh = build_args(CLAUDE, "/vault", None, &RunOpts::default());
        assert!(!fresh.contains(&"--resume".to_string()));
        let again = build_args(CLAUDE, "/vault", Some("sess-1"), &RunOpts::default());
        let i = again.iter().position(|a| a == "--resume").expect("要带 --resume");
        assert_eq!(again[i + 1], "sess-1");
    }

    #[test]
    fn codex_的全局选项排在_resume_子命令前面且按_id_续接() {
        let args = build_args(CODEX, "/vault", Some("01a02b73-355c-7fb2"), &RunOpts::default());
        let json = args.iter().position(|a| a == "--json").unwrap();
        let resume = args.iter().position(|a| a == "resume").unwrap();
        assert!(json < resume, "--json 落到子命令后面 codex 会不认");
        assert_eq!(args[resume + 1], "01a02b73-355c-7fb2");
        // The prompt itself is on stdin; `-` is codex being told where to look
        assert_eq!(args.last().unwrap(), "-");
    }

    #[test]
    fn codex_不再用已经被删掉的_full_auto() {
        let args = build_args(CODEX, "/vault", None, &RunOpts::default());
        assert!(!args.contains(&"--full-auto".to_string()), "新版 codex 认不出这个");
    }

    /// With the sandbox on, Seatbelt blocks DNS as well, so the machine's own
    /// MCP / curl / RSS all end in "cannot resolve host" — and nothing in that
    /// error points back at the sandbox. See open_args.
    #[test]
    fn 两边都不套沙箱() {
        let codex = build_args(CODEX, "/vault", None, &RunOpts::default());
        assert!(!codex.contains(&"--sandbox".to_string()));
        assert!(codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        let claude = build_args(CLAUDE, "/vault", None, &RunOpts::default());
        let mode = claude.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(claude[mode + 1], "bypassPermissions");
    }

    #[test]
    fn 选了模型和思考程度才带上对应的参数() {
        let bare = build_args(CODEX, "/vault", None, &RunOpts::default());
        assert!(!bare.contains(&"-m".to_string()), "没选就别替 config.toml 做主");
        let opts = RunOpts {
            model: Some("gpt-5.6-terra".into()),
            // A blank string is a menu saying "no opinion", not a model named ""
            effort: Some("  ".into()),
        };
        let args = build_args(CODEX, "/vault", None, &opts);
        let m = args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(args[m + 1], "gpt-5.6-terra");
        assert!(!args.iter().any(|a| a.starts_with("model_reasoning_effort")));

        let claude = build_args(
            CLAUDE,
            "/vault",
            None,
            &RunOpts { model: Some("opus".into()), effort: Some("xhigh".into()) },
        );
        let e = claude.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(claude[e + 1], "xhigh");
    }

    #[test]
    fn 只认第一个表头之前的顶层键() {
        let toml = "model_provider = \"custom\"\nmodel = \"deepseek-v4-flash\"\n\n\
                    [model_providers.custom]\nmodel = \"不该被读到\"\n";
        assert_eq!(toml_top_key(toml, "model").as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(toml_top_key(toml, "model_provider").as_deref(), Some("custom"));
        assert_eq!(toml_top_key(toml, "model_catalog_json"), None);
    }

    #[test]
    fn 各摘各的那几个环境变量() {
        assert!(hijack_env(CLAUDE).contains(&"ANTHROPIC_API_KEY"));
        assert!(hijack_env(CLAUDE).contains(&"ANTHROPIC_BASE_URL"));
        // Do not strip the other vendor's variables: which provider codex uses
        // is its own config.toml's business
        assert!(!hijack_env(CODEX).contains(&"ANTHROPIC_API_KEY"));
        assert!(hijack_env(CODEX).contains(&"OPENAI_API_KEY"));
    }

    /// Actually start a child process and see what it received — when this path
    /// is wrong, what the user gets is an error like "connector disabled" with
    /// no visible origin
    #[cfg(unix)]
    #[test]
    fn 启动应用那份环境里的凭据不会传给子进程() {
        const FROM_TERMINAL: &str = "sk-来自启动应用的那个终端";
        std::env::set_var("ANTHROPIC_API_KEY", FROM_TERMINAL);
        let mut cmd = Command::new("/usr/bin/env");
        scrub_env(&mut cmd, CLAUDE);
        let out = cmd.output().expect("env 跑不起来");
        let env = String::from_utf8_lossy(&out.stdout);
        assert!(!env.contains(FROM_TERMINAL), "得让 CLI 自己去解析身份，而不是捡一个");
        std::env::remove_var("ANTHROPIC_API_KEY");
    }

    /// A prompt on the command line is a prompt that cannot contain a newline
    /// on Windows (Rust refuses `\n` in a batch file's argv) and cannot exceed
    /// 8191 characters (cmd.exe's line). Both are ordinary things to type into
    /// the composer, so the prompt travels on stdin — see feed_prompt.
    #[test]
    fn 提示词一个字都不出现在命令行上() {
        for kind in [CLAUDE, CODEX] {
            let args = build_args(kind, "/vault", Some("sess-1"), &RunOpts::default());
            assert!(
                !args.iter().any(|a| a.contains("改改")),
                "{kind}: 提示词跑到 argv 上了，Windows 上换行就起不来"
            );
        }
        // claude reads a piped stdin as the prompt, so it gets no positional
        // argument at all; codex has to be told with `-`
        let claude = build_args(CLAUDE, "/vault", None, &RunOpts::default());
        assert!(!claude.contains(&"-".to_string()));
        assert_eq!(
            build_args(CODEX, "/vault", None, &RunOpts::default()).last().unwrap(),
            "-"
        );
    }

    /// Is this pid still around? `kill -0` asks without sending anything.
    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// An agent's work *is* subprocesses. Killing the handle we hold and calling
    /// that "stopped" leaves them running in the workspace — which is what
    /// `taskkill /T` has always prevented on Windows, and what the process group
    /// is for here.
    #[cfg(unix)]
    #[test]
    fn 停一次要连它起的子进程一起带走() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & echo $!; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("起不来 /bin/sh");

        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .expect("读不到孙子进程的 pid");
        let grandchild: u32 = line.trim().parse().expect("pid 不是数字");
        assert!(alive(grandchild), "孙子进程没起来，这测试就白测了");

        kill_tree(&mut child);
        let _ = child.wait();

        // The signal is delivered asynchronously; give it a moment rather than
        // racing it
        let gone = (0..40).any(|_| {
            if alive(grandchild) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                false
            } else {
                true
            }
        });
        assert!(gone, "只杀掉了直接子进程，agent 起的活儿还在跑");
    }

    #[test]
    fn codex_在工作区里干活() {
        let args = build_args(CODEX, "/vault", None, &RunOpts::default());
        let cd = args.iter().position(|a| a == "-C").unwrap();
        assert_eq!(args[cd + 1], "/vault");
    }
}
