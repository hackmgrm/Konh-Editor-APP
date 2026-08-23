//! The vault — the workspace on disk, and this application's only source of truth.
//!
//! Drafts kept inside the application — in a browser store, a database, any
//! place the user cannot open — are out of reach of every other tool and gone
//! the moment you change machines. So all of it lives in an ordinary folder,
//! and it really is **just an ordinary folder**:
//!
//! ```text
//! <vault>/
//!   anywhere-you-like.md   any .md / .markdown / .txt at any depth is editable
//!   series/part-one.md      make folders as you like; a draft's id is that relative path
//!   images/cover.png        pasted and dropped images land here by default, but an image displays from anywhere
//! ```
//!
//! It contains nothing but the user's own work: preferences like theme and
//! which draft is open live in the app config directory, so no config file is
//! ever dropped into someone's folder (see the "preferences" section at the end
//! of this file).
//!
//! Early versions recognized only a single flat level under `drafts/`, which
//! left the front end able to show two hard-coded groups and nothing else.
//! This layer no longer dictates any directory structure; it is responsible for
//! reporting the tree faithfully and for every action that lands on disk, which
//! is what lets the front end's file tree be a real tree: create, rename and
//! delete folders, drag files between them — all of that is the entry_* commands
//! here.
//!
//! The payoff is that it doubles as a workspace for other tools — `cd` into it
//! and start a claude or codex, let it edit the drafts with its own native file
//! tools, and the watcher here refreshes as it goes. The directory can also be
//! a git repository, so a draft edited badly is one `git checkout` from being
//! back.
//!
//! Path joining and containment checks are all funnelled through `resolve()`:
//! a relative path from the front end is treated as untrusted input, and the
//! joined result has to land inside the vault before anything proceeds.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Default landing place for pasted and dropped images. Only a default — an
/// image anywhere in the tree works just as well
const IMAGES_DIR: &str = "images";
/// Early versions wrote preferences to this file inside the vault. Not any
/// more — see `adopt_legacy_prefs`
const LEGACY_PREFS_FILE: &str = ".mars.json";
/// Every workspace's preferences share this one file in the app config
/// directory, indexed by absolute workspace path
const PREFS_FILE: &str = "prefs.json";
/** Remember the last vault opened; in the app config directory, not in the
    vault itself (or there would be nowhere to start reading from) */
const VAULT_POINTER: &str = "vault.txt";

/// Directories and files kept out of the tree.
///
/// `.git` and `node_modules` are purely a size problem (tens of thousands of
/// files, seconds to walk, and nobody is going to click into them in the tree);
/// the rest is pure noise — `.DS_Store` is what Finder leaves behind, and
/// `Thumbs.db` / `desktop.ini` are exactly the same thing from Explorer, which
/// writes one into any folder the user has ever looked at.
/// Everything else is shown as it is — the user's own dotfiles included.
/// "A workspace is just an ordinary folder" should not have exceptions.
const IGNORED: &[&str] = &[".git", "node_modules", ".DS_Store", "Thumbs.db", "desktop.ini"];

/// Recursion depth limit. Guards against symlink cycles, and against someone
/// picking their home directory as a workspace
const MAX_DEPTH: usize = 12;

/// Extensions the editor can open. Other files still appear in the tree; they
/// just do not open in the editor when clicked
const TEXT_EXTS: [&str; 3] = ["md", "markdown", "txt"];

/// One draft.
///
/// The id is the **workspace-relative path** (e.g. `series/part-one.md`) and
/// name is the file name without its extension.
/// Early versions used only the file name under `drafts/` as the id; moving to
/// a path is what made drafts at any depth possible.
#[derive(Serialize)]
pub struct DraftDto {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
}

/// A node in the tree. A directory's children are expanded recursively; a file's
/// are None.
#[derive(Serialize)]
pub struct EntryDto {
    pub name: String,
    /// Workspace-relative path, always `/`-separated (on Windows too)
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub size: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    pub children: Option<Vec<EntryDto>>,
}

/// Everything read back in one open
#[derive(Serialize)]
pub struct VaultData {
    /// Every editable text file in the tree, with its body read in one pass
    pub drafts: Vec<DraftDto>,
    /// Image relative path → data URI. The front end needs data URIs for
    /// rendering, copying and long-image export alike, so the encoding happens
    /// here rather than shipping binary across and converting it again in JS.
    pub images: BTreeMap<String, String>,
    pub prefs: serde_json::Value,
    /// The full directory tree, which the front end's file tree draws directly
    pub tree: Vec<EntryDto>,
}

/// Result of a write-back. A mismatched mtime means someone else changed it, so
/// the front end asks the user; nothing is overwritten unilaterally here.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteResult {
    Ok {
        #[serde(rename = "updatedAt")]
        updated_at: f64,
    },
    Conflict {
        #[serde(rename = "diskContent")]
        disk_content: String,
        #[serde(rename = "diskUpdatedAt")]
        disk_updated_at: f64,
    },
}

/// notify's watcher stops the moment it drops, so it needs somewhere to live
#[derive(Default)]
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

/* ---------- Paths ---------- */

/// Validate a single path segment. Empty segments, `.`, `..`, separators and
/// control characters are all rejected.
///
/// The Windows-only clause is not cosmetic. `PathBuf::push` treats a segment
/// with a drive prefix as absolute and *replaces the whole path with it*, so a
/// relative path of `C:/Windows/x.md` would leave `resolve` pointing at
/// `C:Windows\x.md` — outside the workspace, and past the containment check,
/// which only runs for paths that already exist. A `:` also opens an NTFS
/// alternate data stream (`draft.md:secret`) rather than naming a file.
/// None of those characters can occur in a real Windows filename, so rejecting
/// them there hides nothing; on macOS a file legitimately named `第一问?.md`
/// does exist and has to stay openable, which is why the rule is not global.
fn safe_segment(seg: &str) -> Result<(), String> {
    if seg.is_empty()
        || seg == "."
        || seg == ".."
        || seg.contains('/')
        || seg.contains('\\')
        || seg.contains('\0')
    {
        return Err(format!("非法文件名：{seg}"));
    }
    let illegal_on_windows = |c: char| {
        matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*') || (c as u32) < 0x20
    };
    if cfg!(windows) && seg.chars().any(illegal_on_windows) {
        return Err(format!("非法文件名：{seg}"));
    }
    Ok(())
}

/// Workspace-relative path → absolute path. An empty string means the workspace
/// root itself.
///
/// This is the single entry point for every file operation: escapes (`../`) are
/// stopped right here, and when the path already exists it is verified once
/// more with canonicalize — which is what closes the "there is a symlink inside
/// the workspace pointing out of it" route.
fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let base = Path::new(root);
    let mut path = base.to_path_buf();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        safe_segment(seg)?;
        path.push(seg);
    }
    if path.exists() {
        let real = path.canonicalize().map_err(|e| e.to_string())?;
        let real_root = base.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(&real_root) {
            return Err(format!("路径越出了工作区：{rel}"));
        }
    }
    Ok(path)
}

/// Parent directory of a relative path (empty string for a file at the root)
fn parent_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

/// Join a relative path; with an empty parent, that is just the name
fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/* ---------- Line endings ---------- */

/// The UTF-8 byte order mark, as the one character `read_to_string` decodes it
/// to. Notepad, PowerShell's `>` and half of Windows' editors put one at the
/// front of every file they save; Rust hands it back as an ordinary character,
/// so `\u{feff}# 标题` reaches the renderer and stops being a heading. It is
/// stripped on the way in and put back on the way out, for the same reason CRLF
/// is preserved: the file is the user's, not ours to reformat.
const BOM: &str = "\u{feff}";

/// Read a text file with its line endings normalized to `\n`, and without the
/// byte order mark a Windows editor may have left at the front.
///
/// Everything above this layer assumes `\n`: CodeMirror hands back `\n` no
/// matter what it was given, the markdown renderer splits on `\n`, and the
/// image-reference scanners count columns off it. Letting a CRLF file through
/// as-is means every one of those sees a stray `\r` at the end of each line.
///
/// The convention the file actually uses is not lost — it is re-derived from
/// disk at write time, see `write_text`.
fn read_text(path: &Path) -> std::io::Result<String> {
    let text = fs::read_to_string(path)?.replace("\r\n", "\n");
    Ok(text.strip_prefix(BOM).unwrap_or(&text).to_string())
}

/// Write a draft back in whatever line ending the file already used.
///
/// This matters more than it sounds. A draft written on Windows by Notepad, by
/// git with `autocrlf`, or by an agent, will be CRLF. We hand the editor `\n`
/// and get `\n` back, so a plain write would flip the entire file to LF on the
/// first keystroke — every line of `git diff` changed, for one edited word.
/// And `git diff` is what this project tells people to use as their undo key
/// (see the README), so quietly wrecking it is not a small thing.
///
/// A new file has no convention to preserve and gets `\n`.
fn write_text(path: &Path, content: &str) -> std::io::Result<()> {
    let old = fs::read_to_string(path).unwrap_or_default();
    let body = if old.contains("\r\n") {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    };
    if old.starts_with(BOM) {
        fs::write(path, format!("{BOM}{body}"))
    } else {
        fs::write(path, body)
    }
}

fn mtime_ms(p: &Path) -> Result<f64, String> {
    let modified = fs::metadata(p)
        .and_then(|m| m.modified())
        .map_err(|e| format!("读不到文件时间：{e}"))?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as f64)
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_text_file(path: &Path) -> bool {
    TEXT_EXTS.contains(&ext_of(path).as_str())
}

/// Extension → MIME. A data URI has to carry the right type or <img> refuses it.
fn mime_of(path: &Path) -> &'static str {
    match ext_of(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn is_image_file(path: &Path) -> bool {
    mime_of(path) != "application/octet-stream"
}

/* ---------- Directory tree ---------- */

/// List one directory recursively. Directories first, then by name within a kind
/// (case-insensitively), matching what Finder and VS Code do — the tree's order
/// has to be stable, or every refresh makes it jump.
fn read_tree(root: &Path, rel: &str, depth: usize) -> Vec<EntryDto> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let Ok(read) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut entries: Vec<EntryDto> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if IGNORED.contains(&name) {
            continue;
        }
        let child_rel = join_rel(rel, name);
        let is_dir = path.is_dir();
        let meta = fs::metadata(&path).ok();
        entries.push(EntryDto {
            name: name.to_string(),
            path: child_rel.clone(),
            is_dir,
            size: meta.as_ref().map(|m| m.len() as f64).unwrap_or(0.0),
            updated_at: mtime_ms(&path).unwrap_or(0.0),
            children: if is_dir {
                Some(read_tree(root, &child_rel, depth + 1))
            } else {
                None
            },
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// Flatten the tree into a file list (directories themselves excluded); used on
/// open to know what bodies and images to read
fn flatten<'a>(entries: &'a [EntryDto], out: &mut Vec<&'a EntryDto>) {
    for e in entries {
        match &e.children {
            Some(children) => flatten(children, out),
            None => out.push(e),
        }
    }
}

/// Fetch the directory tree on its own. Used to refresh after an outside
/// change, without re-reading any bodies.
#[tauri::command]
pub fn vault_tree(dir: String) -> Result<Vec<EntryDto>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    Ok(read_tree(root, "", 0))
}

/* ---------- Opening ---------- */

/// The part that can be read out of the directory (preferences are not here —
/// they no longer live in the workspace)
struct VaultContent {
    drafts: Vec<DraftDto>,
    images: BTreeMap<String, String>,
    tree: Vec<EntryDto>,
}

/// Open (and if necessary initialize) a vault, reading back drafts, images and
/// the directory tree.
///
/// A missing directory is created — so a folder the user just made in the
/// picker dialog works immediately, empty and all, with no structure to set up
/// first.
fn read_vault(dir: &str) -> Result<VaultContent, String> {
    let root = Path::new(dir);
    fs::create_dir_all(root).map_err(|e| format!("建不了工作区目录：{e}"))?;

    let tree = read_tree(root, "", 0);
    let mut files = Vec::new();
    flatten(&tree, &mut files);

    let mut drafts = Vec::new();
    let mut images = BTreeMap::new();
    for entry in files {
        let path = root.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if is_text_file(&path) {
            // One unreadable file should not stop the whole vault from opening;
            // skip it and leave a log line
            match read_text(&path) {
                Ok(content) => drafts.push(DraftDto {
                    id: entry.path.clone(),
                    name: path
                        .file_stem()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&entry.name)
                        .to_string(),
                    content,
                    updated_at: entry.updated_at,
                }),
                Err(e) => log::warn!("跳过读不了的草稿 {}：{e}", entry.path),
            }
        } else if is_image_file(&path) {
            match fs::read(&path) {
                Ok(bytes) => {
                    images.insert(
                        entry.path.clone(),
                        format!("data:{};base64,{}", mime_of(&path), STANDARD.encode(&bytes)),
                    );
                }
                Err(e) => log::warn!("跳过读不了的图片 {}：{e}", entry.path),
            }
        }
    }
    // Most recently edited first: the draft list is "what I am working on",
    // while the tree is what presents things by directory
    drafts.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));

    Ok(VaultContent {
        drafts,
        images,
        tree,
    })
}

/// Open a vault: what is in the directory, plus this workspace's preferences
/// (which live in the app config directory)
#[tauri::command]
pub fn vault_load(app: AppHandle, dir: String) -> Result<VaultData, String> {
    log::info!("vault_load {dir}");
    let content = read_vault(&dir)?;
    Ok(VaultData {
        drafts: content.drafts,
        images: content.images,
        tree: content.tree,
        prefs: read_prefs(&app, &dir),
    })
}

/* ---------- Drafts ---------- */

/// Read one draft. Used to pick up the latest content after an outside-change
/// notification.
#[tauri::command]
pub fn draft_read(dir: String, id: String) -> Result<DraftDto, String> {
    let path = resolve(&dir, &id)?;
    let content = read_text(&path).map_err(|e| format!("读不了 {id}：{e}"))?;
    Ok(DraftDto {
        name: path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or(&id)
            .to_string(),
        updated_at: mtime_ms(&path).unwrap_or(0.0),
        id,
        content,
    })
}

/// Write one draft back.
///
/// `base_updated_at` is the mtime of the copy the front end holds. A mismatch
/// on disk means someone else (most often an agent working in the same vault)
/// changed it in the meantime — so nothing is written, and the disk version goes
/// back with the answer for the front end to ask the user about, rather than
/// silently overwriting someone's work.
#[tauri::command]
pub fn draft_write(
    dir: String,
    id: String,
    content: String,
    base_updated_at: f64,
) -> Result<WriteResult, String> {
    let path = resolve(&dir, &id)?;
    if path.exists() {
        let disk = mtime_ms(&path)?;
        // Filesystem timestamp resolution varies (HFS+ only to the second), so
        // treat anything within 1ms as equal
        if (disk - base_updated_at).abs() > 1.0 {
            return Ok(WriteResult::Conflict {
                disk_content: read_text(&path).map_err(|e| e.to_string())?,
                disk_updated_at: disk,
            });
        }
    }
    write_text(&path, &content).map_err(|e| format!("写不了 {id}：{e}"))?;
    Ok(WriteResult::Ok {
        updated_at: mtime_ms(&path)?,
    })
}

/// Create a draft under `parent`. An empty parent means the workspace root.
/// A name collision gets a numeric suffix rather than overwriting an existing file.
#[tauri::command]
pub fn draft_create(
    dir: String,
    parent: String,
    name: String,
    content: String,
) -> Result<DraftDto, String> {
    let base = sanitize_title(&name);
    let mut id = join_rel(&parent, &format!("{base}.md"));
    let mut n = 2;
    while resolve(&dir, &id)?.exists() {
        id = join_rel(&parent, &format!("{base} {n}.md"));
        n += 1;
    }
    let path = resolve(&dir, &id)?;
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| format!("建不了目录：{e}"))?;
    }
    fs::write(&path, &content).map_err(|e| format!("建不了 {id}：{e}"))?;
    Ok(DraftDto {
        name: base,
        content,
        updated_at: mtime_ms(&path).unwrap_or(0.0),
        id,
    })
}

/// Names Windows refuses no matter what you do with them.
///
/// These are DOS device names, and they are reserved with or without an
/// extension: `CON.md` fails exactly like `CON` does. Matching is
/// case-insensitive.
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Title → a legal file name. What is replaced is what some filesystem would
/// reject; non-ASCII characters are left exactly as they are.
///
/// The rules applied are the strictest of the platforms, not the current one:
/// a workspace is a folder people copy between machines, so a draft named on a
/// Mac has to still open on Windows. Trailing dots and spaces and the DOS
/// device names below are all things macOS accepts happily and Windows will
/// not create at all.
fn sanitize_title(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    // Windows silently strips trailing dots and spaces, which turns "标题 " and
    // "标题" into a collision that only appears on one platform
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "未命名".to_string();
    }
    // The stem is what the reservation applies to, so check before the extension
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    if RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return format!("_{trimmed}");
    }
    trimmed.to_string()
}

/* ---------- Files and folders ---------- */

/// Create a folder. If it already exists, return its path (the user almost
/// certainly just wants to go into that directory).
#[tauri::command]
pub fn dir_create(dir: String, parent: String, name: String) -> Result<String, String> {
    let base = sanitize_title(&name);
    let mut rel = join_rel(&parent, &base);
    let mut n = 2;
    while resolve(&dir, &rel)?.exists() {
        rel = join_rel(&parent, &format!("{base} {n}"));
        n += 1;
    }
    fs::create_dir_all(resolve(&dir, &rel)?).map_err(|e| format!("建不了文件夹：{e}"))?;
    Ok(rel)
}

/// Rename. Files and folders alike; only the last segment changes, never the
/// location.
///
/// A new name without an extension keeps the old one — what the user edits in
/// the tree is a *title*, and forgetting to type `.md` should not turn the file
/// into an unrecognized type.
#[tauri::command]
pub fn entry_rename(dir: String, path: String, name: String) -> Result<String, String> {
    let from = resolve(&dir, &path)?;
    if !from.exists() {
        return Err(format!("找不到 {path}"));
    }
    let mut base = sanitize_title(&name);
    if from.is_file() {
        let old_ext = ext_of(&from);
        let new_ext = ext_of(Path::new(&base));
        if !old_ext.is_empty() && new_ext != old_ext {
            base = format!("{base}.{old_ext}");
        }
    }
    let target = join_rel(parent_of(&path), &base);
    let to = resolve(&dir, &target)?;
    if to == from {
        return Ok(path);
    }
    // `to.exists()` is not "another file is in the way" on a case-insensitive
    // filesystem — which is Windows always, and macOS by default. Renaming
    // `readme.md` to `README.md` finds itself there and would be refused with a
    // message naming the very file being renamed. Same file = go ahead; rename
    // is what changes the case on disk.
    if to.exists() && to.canonicalize().ok() != from.canonicalize().ok() {
        return Err(format!("这个位置已经有「{base}」了"));
    }
    fs::rename(&from, &to).map_err(|e| format!("改名失败：{e}"))?;
    Ok(target)
}

/// Move into another directory (used by dragging in the tree). An empty
/// `to_parent` means the workspace root.
#[tauri::command]
pub fn entry_move(dir: String, path: String, to_parent: String) -> Result<String, String> {
    let from = resolve(&dir, &path)?;
    if !from.exists() {
        return Err(format!("找不到 {path}"));
    }
    let dest_dir = resolve(&dir, &to_parent)?;
    if !dest_dir.is_dir() {
        return Err("目标不是文件夹".to_string());
    }
    // Dragging a folder into itself or one of its descendants = losing the
    // whole subtree; blocked
    if to_parent == path || to_parent.starts_with(&format!("{path}/")) {
        return Err("不能把文件夹移进它自己里面".to_string());
    }
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    if parent_of(&path) == to_parent {
        return Ok(path); // no-op move
    }
    let target = join_rel(&to_parent, &name);
    let to = resolve(&dir, &target)?;
    if to.exists() {
        return Err(format!("那边已经有「{name}」了"));
    }
    fs::rename(&from, &to).map_err(|e| format!("移动失败：{e}"))?;
    Ok(target)
}

/// Delete a file or folder (a folder takes its contents with it).
///
/// No second confirmation here — that was asked in the front end; this layer
/// only carries it out.
#[tauri::command]
pub fn entry_delete(dir: String, path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("不能删除工作区本身".to_string());
    }
    let target = resolve(&dir, &path)?;
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("删不掉 {path}：{e}"))
    } else {
        fs::remove_file(&target).map_err(|e| format!("删不掉 {path}：{e}"))
    }
}

/// Reveal this file in the system file manager.
///
/// The files in the tree we cannot open (pdf, psd, xlsx…) need a way out, and
/// handing them to the system is the simplest.
///
/// This used to spell out all three platforms by hand — `open -R`,
/// `explorer /select,`, `xdg-open` on the parent. Every one of those was worse
/// than what `tauri-plugin-opener` (already a dependency here, for external
/// links) does with the same call: NSWorkspace on macOS,
/// `SHOpenFolderAndSelectItems` on Windows rather than handing a path to a
/// program that parses its own command line, and on Linux an in-process D-Bus
/// call to `org.freedesktop.FileManager1` — with the XDG portal as a fallback,
/// which is what makes it work from inside a Flatpak or a Snap, where talking
/// to the host's file manager goes through a broker.
///
/// What stays ours is the line above it: the path arrives from the front end as
/// a workspace-relative string, and `resolve` is what keeps "reveal this" from
/// becoming "reveal anything on this disk".
///
/// `async`, because the Linux path waits on a D-Bus round trip and the
/// synchronous form of a command holds the main thread, which is the whole
/// window.
#[tauri::command(async)]
pub fn entry_reveal(dir: String, path: String) -> Result<(), String> {
    let target = resolve(&dir, &path)?;
    if !target.exists() {
        return Err(format!("找不到 {path}"));
    }
    tauri_plugin_opener::reveal_item_in_dir(&target)
        .map_err(|e| format!("打开文件管理器失败：{e}"))
}

/* ---------- Images ---------- */

/// Store an image. The front end supplies a data URI (the image came out of its
/// canvas processing); this decodes it back to binary and writes it as-is — what
/// lands on disk is an image file you can double-click open.
/// The destination is fixed at `images/`; returns its workspace-relative path.
#[tauri::command]
pub fn image_write(dir: String, name: String, data_url: String) -> Result<String, String> {
    let comma = data_url
        .find(',')
        .ok_or_else(|| "不是合法的 data URI".to_string())?;
    if !data_url[..comma].contains(";base64") {
        return Err("只接受 base64 编码的 data URI".to_string());
    }
    let bytes = STANDARD
        .decode(&data_url[comma + 1..])
        .map_err(|e| format!("图片解码失败：{e}"))?;
    safe_segment(&name)?;
    let rel = join_rel(IMAGES_DIR, &name);
    let path = resolve(&dir, &rel)?;
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| format!("建不了 images 目录：{e}"))?;
    }
    fs::write(&path, bytes).map_err(|e| format!("写不了图片 {name}：{e}"))?;
    Ok(rel)
}

#[tauri::command]
pub fn image_delete(dir: String, path: String) -> Result<(), String> {
    fs::remove_file(resolve(&dir, &path)?).map_err(|e| format!("删不掉图片 {path}：{e}"))
}

/// Read one image as a data URI. Used to pick up an image that changed.
#[tauri::command]
pub fn image_read(dir: String, path: String) -> Result<String, String> {
    let file = resolve(&dir, &path)?;
    let bytes = fs::read(&file).map_err(|e| format!("读不了图片 {path}：{e}"))?;
    Ok(format!(
        "data:{};base64,{}",
        mime_of(&file),
        STANDARD.encode(&bytes)
    ))
}

/* ---------- Preferences ---------- */

/// Theme, typographic density, which draft is open — these are "how I look at
/// this on this machine", not part of the draft.
///
/// Early versions wrote them to `.mars.json` inside the vault, which gave the
/// workspace a file the user never created and does not care about, and which
/// would then be committed along with everything else. Now they live in
/// `prefs.json` in the app config directory, indexed by absolute workspace path,
/// and the workspace holds nothing but the user's own work.
///
/// The cost is that preferences no longer travel with the folder: copy a
/// workspace to another machine and the typography returns to its defaults.
/// Not one byte of a draft or an image is lost — those were files all along.
type PrefsMap = BTreeMap<String, serde_json::Value>;

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(PREFS_FILE))
}

fn read_prefs_map(app: &AppHandle) -> PrefsMap {
    prefs_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Read this workspace's preferences, adopting any legacy `.mars.json` left in
/// the vault along the way
fn read_prefs(app: &AppHandle, dir: &str) -> serde_json::Value {
    let mut map = read_prefs_map(app);
    let legacy = adopt_legacy_prefs(Path::new(dir));
    match map.get(dir) {
        Some(prefs) => prefs.clone(),
        None => {
            let prefs = legacy.unwrap_or(serde_json::Value::Null);
            if !prefs.is_null() {
                map.insert(dir.to_string(), prefs.clone());
                let _ = write_prefs_map(app, &map);
            }
            prefs
        }
    }
}

fn write_prefs_map(app: &AppHandle, map: &PrefsMap) -> Result<(), String> {
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(prefs_path(app)?, text).map_err(|e| format!("存不了偏好：{e}"))
}

/// Read the legacy `.mars.json` and delete it from the workspace.
///
/// Deleting is deliberate: leaving it means the user's workspace still holds a
/// file they never created, which we no longer write to, so its contents only
/// drift further from the truth. What is inside is preferences like the theme —
/// losing it costs a return to default typography, and not one word of any draft.
fn adopt_legacy_prefs(root: &Path) -> Option<serde_json::Value> {
    let path = root.join(LEGACY_PREFS_FILE);
    if !path.is_file() {
        return None;
    }
    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    match fs::remove_file(&path) {
        Ok(()) => log::info!("已把 {LEGACY_PREFS_FILE} 移出工作区"),
        Err(e) => log::warn!("删不掉 {LEGACY_PREFS_FILE}：{e}"),
    }
    parsed
}

#[tauri::command]
pub fn prefs_write(app: AppHandle, dir: String, prefs: serde_json::Value) -> Result<(), String> {
    let mut map = read_prefs_map(&app);
    map.insert(dir, prefs);
    write_prefs_map(&app, &map)
}

/* ---------- The last vault opened ---------- */

fn pointer_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(VAULT_POINTER))
}

#[tauri::command]
pub fn vault_remember(app: AppHandle, dir: String) -> Result<(), String> {
    log::info!("vault_remember {dir}");
    fs::write(pointer_file(&app)?, dir).map_err(|e| format!("记不住工作区位置：{e}"))
}

/// The last vault opened; None when there is none or it has been deleted, in
/// which case the front end opens the picker.
#[tauri::command]
pub fn vault_recall(app: AppHandle) -> Option<String> {
    log::info!("vault_recall");
    let path = pointer_file(&app).ok()?;
    let dir = fs::read_to_string(path).ok()?.trim().to_string();
    if !dir.is_empty() && Path::new(&dir).is_dir() {
        Some(dir)
    } else {
        None
    }
}

/* ---------- Watching ---------- */

/// One watch event path → the workspace-relative, `/`-separated path the front
/// end speaks. None when it does not belong to this workspace at all.
///
/// Two roots because the platforms disagree about which one they will hand
/// back; see `vault_watch`.
fn relative_to_root(p: &Path, real_root: &Path, given_root: &Path) -> Option<String> {
    p.strip_prefix(real_root)
        .or_else(|_| p.strip_prefix(given_root))
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

/// Does this workspace-relative path lie in something the tree does not show?
///
/// Matched segment by segment, the same way `read_tree` skips them — the tree
/// leaves out a `.git` at any depth, so an event from one has nothing to
/// refresh either. Only the top level used to be checked, which meant a nested
/// repository's commit, or the `.DS_Store` Finder drops into every folder you
/// so much as look at (and, on Windows, the `Thumbs.db` Explorer writes beside
/// it), each cost a full re-read of the tree for nothing.
fn is_ignored_path(rel: &str) -> bool {
    rel.split('/').any(|seg| IGNORED.contains(&seg))
}

/// Put a watch failure into words the user can act on.
///
/// One of these is not like the others. Linux watches with inotify, which has a
/// per-user quota of watched directories (`fs.inotify.max_user_watches`, still
/// 8192 on a number of distributions) — and a recursive watch takes one per
/// directory, so a workspace with a deep `node_modules` next door, or an editor
/// and two language servers already running, exhausts it. The kernel returns
/// ENOSPC and the message reads "No space left on device", which sends people
/// to `df` for a disk that is not full. notify already recognizes the case;
/// naming it here is what turns a dead-end into a one-line fix.
fn watch_error(e: notify::Error) -> String {
    if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) {
        return "监听不了工作区：系统的文件监听配额用完了（Linux 的 inotify 上限，\
                内核报的是「设备没空间」，跟磁盘无关）。\
                放开它：sudo sysctl -w fs.inotify.max_user_watches=524288。\
                在那之前编辑器照常用，只是别人（比如 agent）在外面改了文件不会自动刷新。"
            .to_string();
    }
    format!("监听不了工作区：{e}")
}

/// Watch the whole vault and emit relative paths to the front end on change.
///
/// This is the line that makes "an agent edits alongside you and you see it
/// live" work. Events are neither deduplicated nor debounced — one save can make
/// notify report several times, and merging is the front end's job; it also has
/// to compare mtimes against what it holds in memory to filter out the write it
/// just made itself.
#[tauri::command]
pub fn vault_watch(app: AppHandle, state: State<WatchState>, dir: String) -> Result<(), String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    // The root as the OS will name it back to us.
    //
    // macOS answers through FSEvents, and FSEvents reports the *resolved* path
    // — the workspace at /tmp/vault comes back as /private/tmp/vault, because
    // /tmp is a symlink. Strip the path the user gave us off that and it does
    // not match, every event is dropped, and live sync is silently dead for
    // anyone whose workspace sits under a symlink anywhere in its path (on
    // macOS that includes all of /tmp and /var). Linux and Windows both echo
    // the path they were handed, so neither ever showed this.
    //
    // Both forms are kept and tried in turn: canonicalize can fail, and it is
    // not this function's business to decide which one the platform will use.
    let real_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let given_root = root.clone();
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter_map(|p| relative_to_root(p, &real_root, &given_root))
            .filter(|p| !is_ignored_path(p))
            .collect();
        if !paths.is_empty() {
            let _ = handle.emit("vault:change", paths);
        }
    })
    .map_err(|e| format!("建不了监听器：{e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(watch_error)?;

    log::info!("vault_watch 已挂上 {dir}");
    // Switching vaults replaces the old watcher here (dropping it stops it)
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Open a temporary vault, returning (guard, path string). Dropping the
    /// guard deletes the directory, so do not drop it early.
    fn temp_vault() -> (TempDir, String) {
        let tmp = TempDir::new().expect("建不了临时目录");
        let dir = tmp.path().to_string_lossy().to_string();
        read_vault(&dir).expect("开库失败");
        (tmp, dir)
    }

    /// Every path in the tree, flattened for easy assertions
    fn paths(entries: &[EntryDto]) -> Vec<String> {
        let mut out = Vec::new();
        fn walk(entries: &[EntryDto], out: &mut Vec<String>) {
            for e in entries {
                out.push(e.path.clone());
                if let Some(c) = &e.children {
                    walk(c, out);
                }
            }
        }
        walk(entries, &mut out);
        out
    }

    #[test]
    fn 空目录也能直接当工作区() {
        let (_tmp, dir) = temp_vault();
        // No drafts/ or images/ are presumed any more: a workspace is an
        // ordinary folder and an empty one works fine
        let data = read_vault(&dir).unwrap();
        assert!(data.drafts.is_empty());
        assert!(data.images.is_empty());
        assert!(data.tree.is_empty());
    }

    #[test]
    fn 建了能读回来() {
        let (_tmp, dir) = temp_vault();
        let created = draft_create(dir.clone(), "".into(), "我的第一篇".into(), "# 标题".into()).unwrap();
        assert_eq!(created.id, "我的第一篇.md");
        assert_eq!(created.name, "我的第一篇");

        let data = read_vault(&dir).unwrap();
        assert_eq!(data.drafts.len(), 1);
        assert_eq!(data.drafts[0].content, "# 标题");
    }

    #[test]
    fn 子目录里的草稿一样能读能写() {
        let (_tmp, dir) = temp_vault();
        dir_create(dir.clone(), "".into(), "系列".into()).unwrap();
        let d = draft_create(dir.clone(), "系列".into(), "第一篇".into(), "正文".into()).unwrap();
        assert_eq!(d.id, "系列/第一篇.md");

        let data = read_vault(&dir).unwrap();
        assert_eq!(data.drafts.len(), 1);
        assert_eq!(data.drafts[0].id, "系列/第一篇.md");
        // The tree is nested, not flattened to one level
        assert_eq!(paths(&data.tree), vec!["系列", "系列/第一篇.md"]);

        let res = draft_write(dir.clone(), d.id.clone(), "改过的".into(), d.updated_at).unwrap();
        assert!(matches!(res, WriteResult::Ok { .. }));
        assert_eq!(draft_read(dir, d.id).unwrap().content, "改过的");
    }

    #[test]
    fn 树按目录在前名字在后排序且跳过噪音目录() {
        let (tmp, dir) = temp_vault();
        fs::create_dir_all(tmp.path().join(".git/objects")).unwrap();
        fs::write(tmp.path().join(".git/HEAD"), "x").unwrap();
        fs::write(tmp.path().join(".DS_Store"), "x").unwrap();
        fs::write(tmp.path().join("b.md"), "").unwrap();
        fs::write(tmp.path().join("a.md"), "").unwrap();
        fs::create_dir_all(tmp.path().join("z目录")).unwrap();
        // Dotfiles show up too: a workspace is an ordinary folder, no exceptions
        fs::write(tmp.path().join(".keep.json"), "{}").unwrap();

        assert_eq!(
            paths(&vault_tree(dir).unwrap()),
            vec!["z目录", ".keep.json", "a.md", "b.md"]
        );
    }

    #[test]
    fn 重名会自动加序号而不是覆盖() {
        let (_tmp, dir) = temp_vault();
        let a = draft_create(dir.clone(), "".into(), "稿".into(), "第一份".into()).unwrap();
        let b = draft_create(dir.clone(), "".into(), "稿".into(), "第二份".into()).unwrap();
        assert_eq!(a.id, "稿.md");
        assert_eq!(b.id, "稿 2.md");
        // The first copy was never touched
        assert_eq!(draft_read(dir, a.id).unwrap().content, "第一份");
    }

    #[test]
    fn 基准过期时拒绝写入并把磁盘内容带回来() {
        let (_tmp, dir) = temp_vault();
        let d = draft_create(dir.clone(), "".into(), "稿".into(), "原文".into()).unwrap();

        // Simulate someone else (an agent) changing this file behind our back
        let path = resolve(&dir, &d.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, "agent 改过的").unwrap();

        // We still hold the mtime from when the vault opened, so this write-back
        // must be refused
        let res = draft_write(dir.clone(), d.id.clone(), "我改的".into(), d.updated_at).unwrap();
        match res {
            WriteResult::Conflict { disk_content, .. } => assert_eq!(disk_content, "agent 改过的"),
            WriteResult::Ok { .. } => panic!("基准过期了还写进去了，会吃掉别人的修改"),
        }
        // After the refusal the disk must still hold their version, uncontaminated
        assert_eq!(fs::read_to_string(&path).unwrap(), "agent 改过的");

        // This is what the front end's "keep mine" does: swap the baseline for
        // the disk mtime and write again
        let disk_mtime = mtime_ms(&path).unwrap();
        let res = draft_write(dir.clone(), d.id.clone(), "我改的".into(), disk_mtime).unwrap();
        assert!(matches!(res, WriteResult::Ok { .. }));
        assert_eq!(draft_read(dir, d.id).unwrap().content, "我改的");
    }

    #[test]
    fn 改名只动最后一段且沿用原扩展名() {
        let (_tmp, dir) = temp_vault();
        dir_create(dir.clone(), "".into(), "系列".into()).unwrap();
        let d = draft_create(dir.clone(), "系列".into(), "旧名".into(), "正文".into()).unwrap();

        // What the user types in the tree is a title; forgetting .md should not
        // turn the file into something extensionless
        let renamed = entry_rename(dir.clone(), d.id, "新名".into()).unwrap();
        assert_eq!(renamed, "系列/新名.md");
        assert_eq!(draft_read(dir.clone(), renamed).unwrap().content, "正文");

        // Renaming a folder takes its contents with it
        let moved = entry_rename(dir.clone(), "系列".into(), "合集".into()).unwrap();
        assert_eq!(moved, "合集");
        assert_eq!(paths(&vault_tree(dir).unwrap()), vec!["合集", "合集/新名.md"]);
    }

    #[test]
    fn 改名撞上已有文件时拒绝() {
        let (_tmp, dir) = temp_vault();
        draft_create(dir.clone(), "".into(), "占位".into(), String::new()).unwrap();
        let d = draft_create(dir.clone(), "".into(), "另一篇".into(), String::new()).unwrap();
        assert!(entry_rename(dir, d.id, "占位".into()).is_err());
    }

    #[test]
    fn 拖拽移动() {
        let (_tmp, dir) = temp_vault();
        dir_create(dir.clone(), "".into(), "系列".into()).unwrap();
        let d = draft_create(dir.clone(), "".into(), "稿".into(), "正文".into()).unwrap();

        let moved = entry_move(dir.clone(), d.id, "系列".into()).unwrap();
        assert_eq!(moved, "系列/稿.md");
        assert_eq!(draft_read(dir.clone(), moved.clone()).unwrap().content, "正文");

        // Drag back to the root
        assert_eq!(entry_move(dir.clone(), moved, "".into()).unwrap(), "稿.md");
        // A folder cannot be dragged into itself (it would take the subtree with it)
        dir_create(dir.clone(), "系列".into(), "子".into()).unwrap();
        assert!(entry_move(dir.clone(), "系列".into(), "系列/子".into()).is_err());
        assert!(entry_move(dir, "系列".into(), "系列".into()).is_err());
    }

    #[test]
    fn 删除文件夹连里面一起删() {
        let (_tmp, dir) = temp_vault();
        dir_create(dir.clone(), "".into(), "系列".into()).unwrap();
        draft_create(dir.clone(), "系列".into(), "稿".into(), String::new()).unwrap();
        entry_delete(dir.clone(), "系列".into()).unwrap();
        assert!(vault_tree(dir.clone()).unwrap().is_empty());
        // The workspace itself must not be deletable
        assert!(entry_delete(dir, "".into()).is_err());
    }

    #[test]
    fn 越界的路径一律拒绝() {
        let (_tmp, dir) = temp_vault();
        for bad in ["../逃逸.md", "..", "sub\\x.md", "a/../../b.md", "./../x"] {
            assert!(
                draft_read(dir.clone(), bad.into()).is_err(),
                "{bad} 应该被挡下来"
            );
            assert!(
                draft_write(dir.clone(), bad.into(), "x".into(), 0.0).is_err(),
                "{bad} 应该被挡下来"
            );
            assert!(
                entry_delete(dir.clone(), bad.into()).is_err(),
                "{bad} 应该被挡下来"
            );
        }
    }

    #[test]
    fn 树里不显示的东西_监听也不该为它刷新() {
        assert!(is_ignored_path(".DS_Store"));
        assert!(is_ignored_path("Thumbs.db"));
        assert!(is_ignored_path(".git/objects/ab/cdef"));
        // At any depth — a nested repository and a folder Finder or Explorer
        // has been into count the same as one at the root
        assert!(is_ignored_path("素材/.DS_Store"));
        assert!(is_ignored_path("子仓库/.git/HEAD"));
        assert!(is_ignored_path("前端/node_modules/react/index.js"));
        // And nothing else: a dotfile the user wrote is theirs and shows
        assert!(!is_ignored_path("稿.md"));
        assert!(!is_ignored_path(".keep.json"));
        assert!(!is_ignored_path("git/说明.md"));
        assert!(!is_ignored_path("素材/Thumbs.db.md"));
    }

    /// The watcher's path arithmetic, run against the actual OS rather than
    /// assumed.
    ///
    /// macOS answers through FSEvents, which reports the *resolved* path: a
    /// workspace under /tmp or /var (which is where TempDir puts this one) comes
    /// back as /private/... Stripping the path the user gave us off that fails,
    /// every event is dropped, and "an agent edits alongside you and you see it
    /// live" is silently dead — no error anywhere, it simply never updates.
    /// Linux and Windows echo back the path they were handed, so neither of them
    /// ever showed this.
    #[test]
    fn 监听事件的路径认得出自己的工作区_哪怕根目录经过符号链接() {
        use std::sync::mpsc;

        let (tmp, _dir) = temp_vault();
        let given_root = tmp.path().to_path_buf();
        let real_root = given_root.canonicalize().unwrap_or_else(|_| given_root.clone());

        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(e) = res {
                let _ = tx.send(e.paths);
            }
        })
        .unwrap();
        watcher.watch(&given_root, RecursiveMode::Recursive).unwrap();
        // FSEvents needs a moment before it is actually listening
        std::thread::sleep(std::time::Duration::from_millis(300));
        fs::write(given_root.join("稿.md"), "x").unwrap();

        let paths = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("5 秒内一个监听事件都没收到");
        let relative: Vec<String> = paths
            .iter()
            .filter_map(|p| relative_to_root(p, &real_root, &given_root))
            .collect();
        assert!(
            relative.iter().any(|p| p == "稿.md"),
            "监听事件认不出自己的工作区，前端一个事件都收不到。事件路径 {paths:?}，工作区 {}",
            given_root.display()
        );
    }

    /// `PathBuf::push("C:")` replaces the whole path on Windows, and a `:` in a
    /// name opens an NTFS alternate data stream. Both are ways out of the vault
    /// that no amount of `../` filtering catches, and neither exists on macOS —
    /// which is why the invariant, not the platform, is what gets asserted.
    #[test]
    fn 带盘符或数据流的路径段逃不出工作区() {
        let (_tmp, dir) = temp_vault();
        for bad in ["C:/Windows/x.md", "C:x.md", "images/C:x.png", "稿.md:藏起来"] {
            match resolve(&dir, bad) {
                // Windows: refused outright, the name could not exist there anyway
                Err(_) => {}
                // Elsewhere `:` is an ordinary character and stays a file name
                Ok(p) => assert!(
                    p.starts_with(&dir),
                    "{bad} 逃出了工作区：{}",
                    p.display()
                ),
            }
        }
    }

    /// Windows always, and macOS by default, cannot tell `readme.md` from
    /// `README.md` — so "is something already there?" answers yes about the very
    /// file being renamed.
    #[test]
    fn 只改大小写的改名不算撞名() {
        let (_tmp, dir) = temp_vault();
        let d = draft_create(dir.clone(), "".into(), "readme".into(), "正文".into()).unwrap();
        let renamed = entry_rename(dir.clone(), d.id, "README".into()).unwrap();
        assert_eq!(renamed, "README.md");
        assert_eq!(draft_read(dir, renamed).unwrap().content, "正文");
    }

    /// Notepad, PowerShell and most Windows editors put a BOM at the front of
    /// what they save. Left in, the first line stops being a heading.
    #[test]
    fn bom_读的时候摘掉写回去还在() {
        let (tmp, dir) = temp_vault();
        let path = tmp.path().join("bom.md");
        fs::write(&path, "\u{feff}# 标题\r\n正文\r\n").unwrap();

        let d = draft_read(dir.clone(), "bom.md".into()).unwrap();
        assert_eq!(d.content, "# 标题\n正文\n", "BOM 混进正文，第一行就不是标题了");

        // Writing back preserves what the file was: BOM and CRLF both
        draft_write(dir, "bom.md".into(), "# 新标题\n正文\n".into(), d.updated_at).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "\u{feff}# 新标题\r\n正文\r\n");

        // And a file without one never grows one
        let plain = tmp.path().join("plain.md");
        fs::write(&plain, "# 标题\n").unwrap();
        assert!(!fs::read_to_string(&plain).unwrap().starts_with(BOM));
    }

    #[test]
    fn 标题里的非法字符换成连字符中文原样保留() {
        assert_eq!(sanitize_title("正常标题"), "正常标题");
        assert_eq!(sanitize_title("a/b:c*d"), "a-b-c-d");
        assert_eq!(sanitize_title("  "), "未命名");
        assert_eq!(sanitize_title("..."), "未命名");
        // Backslash is a separator on Windows, so it can never survive as a name
        assert_eq!(sanitize_title("系列\\第一篇"), "系列-第一篇");
    }

    /// A CRLF draft is what git with `autocrlf`, Notepad, or an agent on Windows
    /// leaves behind. Reading it has to hide that from everything above, and
    /// writing it back has to not destroy it.
    #[test]
    fn crlf的文件读成lf写回还是crlf() {
        let (tmp, dir) = temp_vault();
        let path = tmp.path().join("crlf.md");
        fs::write(&path, "第一行\r\n第二行\r\n").unwrap();

        // What the editor sees never contains \r
        let d = draft_read(dir.clone(), "crlf.md".into()).unwrap();
        assert_eq!(d.content, "第一行\n第二行\n");

        // Writing LF back leaves the file's own convention intact
        draft_write(dir.clone(), "crlf.md".into(), "第一行\n改过的第二行\n".into(), d.updated_at)
            .unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "第一行\r\n改过的第二行\r\n");
        assert!(!raw.contains("\r\r"));

        // An LF file stays LF — nothing is converted in the other direction
        let lf = tmp.path().join("lf.md");
        fs::write(&lf, "一行\n").unwrap();
        let d2 = draft_read(dir.clone(), "lf.md".into()).unwrap();
        draft_write(dir, "lf.md".into(), "改过一行\n".into(), d2.updated_at).unwrap();
        assert_eq!(fs::read_to_string(&lf).unwrap(), "改过一行\n");
    }

    /// These pass on macOS and fail on Windows, which is exactly why the rule is
    /// unconditional: a vault is a folder people copy between machines.
    #[test]
    fn windows用不了的名字在哪台机器上都不产生() {
        // DOS device names are reserved with or without an extension
        assert_eq!(sanitize_title("CON"), "_CON");
        assert_eq!(sanitize_title("con.md"), "_con.md");
        assert_eq!(sanitize_title("COM1"), "_COM1");
        assert_eq!(sanitize_title("lpt9.txt"), "_lpt9.txt");
        // But only the whole stem, not a name that merely starts with one
        assert_eq!(sanitize_title("console"), "console");
        assert_eq!(sanitize_title("CONTENT.md"), "CONTENT.md");
        // Windows strips trailing dots and spaces, silently colliding two names
        assert_eq!(sanitize_title("草稿 "), "草稿");
        assert_eq!(sanitize_title("草稿."), "草稿");
    }

    #[test]
    fn 图片按原字节落盘再读回来还是同一张() {
        let (tmp, dir) = temp_vault();
        // A 1x1 transparent PNG
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let rel = image_write(dir.clone(), "封面.png".into(), png.into()).unwrap();
        assert_eq!(rel, "images/封面.png");

        // On disk it is a real PNG file, not base64 text
        let raw = fs::read(tmp.path().join(IMAGES_DIR).join("封面.png")).unwrap();
        assert_eq!(&raw[..8], b"\x89PNG\r\n\x1a\n");

        assert_eq!(image_read(dir.clone(), rel.clone()).unwrap(), png);
        assert_eq!(read_vault(&dir).unwrap().images.get(&rel).unwrap(), png);
    }

    #[test]
    fn 图片放在哪一层都算图片() {
        let (tmp, dir) = temp_vault();
        fs::create_dir_all(tmp.path().join("素材/2026")).unwrap();
        fs::write(tmp.path().join("素材/2026/图.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        // A file that is neither image nor text: in the tree, but in neither the
        // image library nor the drafts
        fs::write(tmp.path().join("素材/说明.pdf"), "x").unwrap();

        let data = read_vault(&dir).unwrap();
        assert!(data.images.contains_key("素材/2026/图.png"));
        assert!(data.drafts.is_empty());
        assert!(paths(&data.tree).contains(&"素材/说明.pdf".to_string()));
    }

    #[test]
    fn 旧版的偏好文件会被读走并移出工作区() {
        let (tmp, _dir) = temp_vault();
        let prefs = serde_json::json!({ "themeId": "dark", "linkFootnotes": true });
        fs::write(tmp.path().join(LEGACY_PREFS_FILE), prefs.to_string()).unwrap();

        assert_eq!(adopt_legacy_prefs(tmp.path()), Some(prefs));
        // Once adopted, it must no longer be sitting in the workspace
        assert!(!tmp.path().join(LEGACY_PREFS_FILE).exists());
        assert_eq!(adopt_legacy_prefs(tmp.path()), None);
    }

    #[test]
    fn 偏好文件读坏了也照样把它移出去() {
        let (tmp, _dir) = temp_vault();
        fs::write(tmp.path().join(LEGACY_PREFS_FILE), "{ 这不是 json").unwrap();
        // Unparseable means no preferences — but the file still must not be left
        // squatting in the workspace
        assert_eq!(adopt_legacy_prefs(tmp.path()), None);
        assert!(!tmp.path().join(LEGACY_PREFS_FILE).exists());
    }
}
