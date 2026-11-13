//! Unified, versioned backup and restore.
//!
//! One archive covers the writing workspace, the planner domain tables, journal
//! images (produced by the front end, which owns IndexedDB), article assets and
//! custom themes. Credentials, sync queues and runtime state are never written:
//! the section list below is an allow-list, not a filter.
//!
//! The archive is staged next to its destination and published with a
//! no-overwrite rename, so a failed export leaves no half-written backup behind
//! and can never replace an older one.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Mutex},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::write_gate::WriteGate;
use crate::workspace_backup::{
    component, open_regular, private_file, publish, snapshot, sync_dir, Entry, Stage,
};

pub(crate) const FORMAT: &str = "konh-unified-backup";
pub(crate) const FORMAT_VERSION: u32 = 1;
const MANIFEST: &str = "manifest.json";
const README: &str = "README.txt";
const WORKSPACE: &str = "workspace";
const PLANNER: &str = "planner";
const PLANNER_JSON: &str = "planner/planner.json";
const JOURNAL_IMAGES: &str = "planner/journal-images.json";
const ATTACHMENTS: &str = "planner/attachments";
const WRITING: &str = "writing";
const ARTICLE_ASSETS: &str = "writing/article-assets";
const THEMES: &str = "writing/themes";
const METADATA: &str = "writing/metadata.json";

const MAX_ENTRIES: usize = 200_000;
const MAX_DEPTH: usize = 64;
const MAX_FILE_BYTES: u64 = 1 << 30;
const MAX_TOTAL_BYTES: u64 = 8 << 30;
const MAX_MANIFEST_BYTES: u64 = 256 << 20;
const MAX_SECTION_BYTES: u64 = 512 << 20;
const MAX_JSON_BYTES: u64 = 512 << 20;
const CHUNK: usize = 3 * 1024 * 1024;

/// Domain tables that make up the planner. Everything else in the database —
/// settings, sync queues, migration copies, agent configuration — stays out.
pub(crate) const PLANNER_TABLES: &[&str] = &[
    "tasks",
    "journal_entries",
    "pomodoro_logs",
    "habits",
    "sticky_notes",
    "countdowns",
    "timeblocks",
];

static NEXT: AtomicU64 = AtomicU64::new(0);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sections {
    pub workspace: bool,
    pub planner: bool,
    pub journal_images: bool,
    pub writing_artifacts: bool,
    pub secrets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEntry {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub created_at: i64,
    pub app_version: String,
    pub sections: Sections,
    pub file_count: u64,
    pub total_size: u64,
    pub files: Vec<FileEntry>,
}

/// What the front end gets back after a successful export.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub manifest: Manifest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub path: String,
    pub format: String,
    pub format_version: u32,
    pub created_at: i64,
    pub app_version: String,
    pub sections: Sections,
    pub file_count: u64,
    pub total_size: u64,
    /// Per-file integrity. Empty when every hashed file matched.
    pub problems: Vec<String>,
    /// True only when the archive can be restored.
    pub ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadChunk {
    pub base64: String,
    pub size: u64,
    pub eof: bool,
    pub next_offset: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub target: String,
    pub files: u64,
    /// Planner rows written. Zero for file-only restores.
    pub rows: u64,
    pub rollback_dir: Option<String>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergePolicy {
    /// The destination must not exist.
    NewOnly,
    /// Keep whatever is already there; write differing backup files alongside.
    KeepCurrent,
}

impl MergePolicy {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "new-only" => Ok(Self::NewOnly),
            "keep-current" => Ok(Self::KeepCurrent),
            _ => Err("E_BACKUP_POLICY".into()),
        }
    }
}

// ---------------------------------------------------------------- paths

/// A backup-relative path: portable on every platform, no traversal, no root.
pub(crate) fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err(format!("Unsafe backup path: {path:?}"));
    }
    if path.starts_with('/') || path.starts_with('\\') || path.starts_with("//") {
        return Err(format!("Absolute backup path rejected: {path}"));
    }
    if path.contains('\\') {
        return Err(format!("Backslash in backup path rejected: {path}"));
    }
    let mut depth = 0usize;
    for part in path.split('/') {
        if part.is_empty() {
            return Err(format!("Empty segment in backup path: {path}"));
        }
        component(std::ffi::OsStr::new(part))
            .map_err(|_| format!("Unsafe backup path segment in {path}"))?;
        depth += 1;
    }
    if depth > MAX_DEPTH {
        return Err(format!("Backup path too deep: {path}"));
    }
    Ok(())
}

/// The archived workspace never carries macOS resource forks or Finder litter.
pub(crate) fn ignored_name(name: &str) -> bool {
    name == ".DS_Store" || name.starts_with("._")
}

fn filtered_snapshot(root: &Path) -> Result<Vec<Entry>, String> {
    let manifest = snapshot(root)?;
    let mut kept: Vec<Entry> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for entry in manifest.entries {
        if let Some(prefix) = skipped
            .iter()
            .find(|p| entry.path == **p || entry.path.starts_with(&format!("{p}/")))
        {
            let _ = prefix;
            continue;
        }
        let name = entry.path.rsplit('/').next().unwrap_or("");
        if ignored_name(name) {
            skipped.push(entry.path.clone());
            continue;
        }
        validate_rel_path(&entry.path)?;
        if entry.kind == "directory" && entry.path.split('/').count() > MAX_DEPTH {
            return Err("Workspace nesting limit exceeded".into());
        }
        if entry.kind == "file" && entry.size > MAX_FILE_BYTES {
            return Err(format!("File too large for a backup: {}", entry.path));
        }
        kept.push(entry);
    }
    Ok(kept)
}

fn copy_entries(source: &Path, target: &Path, entries: &[Entry]) -> Result<(), String> {
    fs::create_dir_all(target).map_err(err)?;
    for entry in entries {
        validate_rel_path(&entry.path)?;
        let from = source.join(&entry.path);
        let to = target.join(&entry.path);
        let ty = fs::symlink_metadata(&from).map_err(err)?.file_type();
        if entry.kind == "directory" && ty.is_dir() {
            fs::create_dir(&to).map_err(err)?;
        } else if entry.kind == "file" && ty.is_file() {
            let mut input = open_regular(&from)?;
            let mut output = private_file(&to)?;
            let copied = std::io::copy(&mut Read::by_ref(&mut input).take(entry.size + 1), &mut output)
                .map_err(err)?;
            if copied != entry.size {
                return Err(format!("File changed while copying: {}", entry.path));
            }
            output.sync_all().map_err(err)?;
        } else {
            return Err(format!("Source changed or contains a symlink: {}", entry.path));
        }
    }
    for entry in entries.iter().rev().filter(|e| e.kind == "directory") {
        sync_dir(&target.join(&entry.path)).or_else(|e| {
            // An empty directory was already synced; a missing one is a bug.
            Err(format!("Cannot flush {}: {e}", entry.path))
        })?;
    }
    sync_dir(target)?;
    if filtered_snapshot(target)? != entries {
        return Err("Copied data failed integrity verification".into());
    }
    if filtered_snapshot(source)? != entries {
        return Err("Source changed during copy".into());
    }
    Ok(())
}

// ------------------------------------------------------------- staging

struct Session {
    stage: Stage,
    owner: String,
    gate_token: u64,
    journal_bytes: u64,
    journal_chunks: u64,
    journal_sealed: bool,
}

impl Session {
    fn journal_path(&self) -> PathBuf {
        self.stage.path.join(JOURNAL_IMAGES)
    }
}

#[derive(Default)]
pub struct UnifiedBackup(Mutex<HashMap<String, Session>>);

fn unique_token() -> String {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let ms = chrono::Utc::now().timestamp_millis();
    format!("{}-{}-{}", std::process::id(), ms, n)
}

/// Stage inside the destination's parent so publication is a same-volume rename.
fn staging_next_to(destination: &Path) -> Result<Stage, String> {
    let name = destination
        .file_name()
        .ok_or("Backup destination needs a directory name")?;
    component(name)?;
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent).map_err(|e| format!("Backup destination is unusable: {e}"))?;
    let target = parent.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err("E_BACKUP_EXISTS".into());
    }
    for _ in 0..1000 {
        let path = parent.join(format!(
            ".konh-backup-staging-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {
                return Ok(Stage {
                    path,
                    target,
                    published: false,
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(err(e)),
        }
    }
    Err("Could not create the backup staging directory".into())
}

// ------------------------------------------------------- stage scan

fn scan_stage(root: &Path, rel: &Path, out: &mut Vec<FileEntry>) -> Result<(), String> {
    if rel.components().count() > MAX_DEPTH {
        return Err("Backup nesting limit exceeded".into());
    }
    let dir = if rel.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let mut children = fs::read_dir(&dir)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    children.sort_by_key(|e| e.file_name());
    for child in children {
        if out.len() >= MAX_ENTRIES {
            return Err("Backup entry limit exceeded".into());
        }
        let name = child.file_name();
        let name = component(&name)?;
        if rel.as_os_str().is_empty() && name == MANIFEST {
            continue;
        }
        let path = rel.join(name);
        let portable = path
            .iter()
            .map(component)
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        validate_rel_path(&portable)?;
        let meta = fs::symlink_metadata(child.path()).map_err(err)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(format!("Reparse point rejected: {portable}"));
            }
        }
        let ty = meta.file_type();
        if ty.is_dir() {
            out.push(FileEntry {
                path: portable,
                kind: "directory".into(),
                size: 0,
                sha256: String::new(),
            });
            scan_stage(root, &path, out)?;
        } else if ty.is_file() {
            let mut file = open_regular(&child.path())?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = file.read(&mut buf).map_err(err)?;
                if n == 0 {
                    break;
                }
                size = size.checked_add(n as u64).ok_or("Backup size limit exceeded")?;
                if size > MAX_FILE_BYTES {
                    return Err(format!("File too large: {portable}"));
                }
                hash.update(&buf[..n]);
            }
            out.push(FileEntry {
                path: portable,
                kind: "file".into(),
                size,
                sha256: format!("{:x}", hash.finalize()),
            });
        } else {
            return Err(format!("Symlink or special file in backup: {portable}"));
        }
    }
    Ok(())
}

fn audit_entries(entries: &[FileEntry]) -> Result<(u64, u64), String> {
    let mut total = 0u64;
    let mut seen = HashSet::with_capacity(entries.len() * 2);
    for entry in entries {
        validate_rel_path(&entry.path)?;
        if !seen.insert(entry.path.clone()) {
            return Err(format!("Duplicate backup path: {}", entry.path));
        }
        if !seen.insert(format!("lc:{}", entry.path.to_lowercase())) {
            return Err(format!(
                "Backup paths differ only by case: {}",
                entry.path
            ));
        }
        if entry.kind != "file" && entry.kind != "directory" {
            return Err(format!("Unknown backup entry kind: {}", entry.kind));
        }
        if entry.kind == "file" {
            if entry.sha256.len() != 64 || !entry.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("Invalid checksum for {}", entry.path));
            }
            total = total
                .checked_add(entry.size)
                .ok_or("Backup size limit exceeded")?;
            if total > MAX_TOTAL_BYTES {
                return Err("Backup size limit exceeded".into());
            }
        }
    }
    Ok((entries.len() as u64, total))
}

// --------------------------------------------------------- planner IO

fn planner_db(app_data: &Path) -> PathBuf {
    app_data.join("tongyun_planner.db")
}

fn read_planner_bytes(app_data: &Path) -> Result<Vec<u8>, String> {
    let path = planner_db(app_data);
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("Planner database is unavailable: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err("Planner database must be a real file".into());
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(10)).map_err(err)?;
    // One read transaction = one consistent snapshot across every table.
    db.execute_batch("BEGIN").map_err(err)?;
    let mut tables = Map::new();
    for table in PLANNER_TABLES {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            continue;
        }
        let mut stmt = db.prepare(&format!("SELECT * FROM \"{table}\"")).map_err(err)?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt.query([]).map_err(err)?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(err)? {
            let mut obj = Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i).map_err(err)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => v.into(),
                    ValueRef::Real(v) => serde_json::Number::from_f64(v)
                        .map(Value::Number)
                        .ok_or("Non-finite number in planner data")?,
                    ValueRef::Text(v) => String::from_utf8(v.to_vec())
                        .map_err(|_| "Non-UTF-8 text in planner data".to_string())?
                        .into(),
                    ValueRef::Blob(_) => {
                        return Err(format!("Unsupported blob column {table}.{name}"))
                    }
                };
                obj.insert(name.clone(), value);
            }
            result.push(Value::Object(obj));
        }
        tables.insert((*table).into(), Value::Array(result));
    }
    db.execute_batch("COMMIT").map_err(err)?;
    let body = serde_json::json!({
        "version": 1,
        "scope": "konh-planner",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "tables": tables,
    });
    serde_json::to_vec_pretty(&body).map_err(err)
}

struct PlannerDoc {
    tables: Map<String, Value>,
}

fn parse_planner_doc(bytes: &[u8]) -> Result<PlannerDoc, String> {
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("Planner data in this backup is too large".into());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|e| format!("Invalid planner data: {e}"))?;
    let object = value.as_object().ok_or("Invalid planner data")?;
    if object.len() != 4
        || value["version"] != 1
        || value["scope"] != "konh-planner"
        || !value["tables"].is_object()
    {
        return Err("Not a Konh planner export".into());
    }
    let tables = value["tables"].as_object().ok_or("Invalid planner tables")?.clone();
    if tables.is_empty() || tables.keys().any(|t| !PLANNER_TABLES.contains(&t.as_str())) {
        return Err("Unknown planner table in backup".into());
    }
    Ok(PlannerDoc { tables })
}

fn apply_planner(app_data: &Path, doc: &PlannerDoc) -> Result<u64, String> {
    let path = planner_db(app_data);
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("Planner database is unavailable: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err("Planner database must be a real file".into());
    }
    let mut db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(10)).map_err(err)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut written = 0u64;
    for (table, rows) in &doc.tables {
        // The table name comes from an allow-list, never from the archive verbatim.
        if !PLANNER_TABLES.contains(&table.as_str()) {
            return Err(format!("Unknown planner table {table}"));
        }
        let rows = rows.as_array().ok_or("Invalid planner table rows")?;
        let mut info = tx
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .map_err(err)?;
        let columns: Vec<String> = info
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        drop(info);
        if columns.is_empty() {
            return Err(format!("Planner table {table} is missing from the database"));
        }
        tx.execute(&format!("DELETE FROM \"{table}\""), []).map_err(err)?;
        for row in rows {
            let row = row.as_object().ok_or("Invalid planner row")?;
            if row.is_empty() || row.keys().any(|k| !columns.contains(k)) {
                return Err(format!("Planner row has unknown columns in {table}"));
            }
            let names: Vec<&String> = row.keys().collect();
            let fields = names
                .iter()
                .map(|k| format!("\"{k}\""))
                .collect::<Vec<_>>()
                .join(",");
            let placeholders = vec!["?"; names.len()].join(",");
            let vals: Vec<rusqlite::types::Value> = names
                .iter()
                .map(|k| match &row[*k] {
                    Value::Null => Ok(rusqlite::types::Value::Null),
                    Value::String(s) => Ok(rusqlite::types::Value::Text(s.clone())),
                    Value::Bool(b) => Ok(rusqlite::types::Value::Integer(i64::from(*b))),
                    Value::Number(n) if n.is_i64() => Ok(rusqlite::types::Value::Integer(n.as_i64().unwrap())),
                    Value::Number(n) if n.is_f64() => Ok(rusqlite::types::Value::Real(n.as_f64().unwrap())),
                    _ => Err("Unsupported planner value"),
                })
                .collect::<Result<Vec<_>, &str>>()?;
            tx.execute(
                &format!("INSERT INTO \"{table}\" ({fields}) VALUES ({placeholders})"),
                rusqlite::params_from_iter(vals),
            )
            .map_err(err)?;
            written += 1;
        }
    }
    tx.commit().map_err(err)?;
    Ok(written)
}

// ------------------------------------------------------- write helpers

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(err)?;
    let mut file = private_file(path)?;
    file.write_all(&bytes).map_err(err)?;
    file.sync_all().map_err(err)
}

fn timestamped_name(prefix: &str) -> String {
    format!("{prefix}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
}

/// Copy a directory tree into `target`, rejecting links and verifying hashes.
fn copy_tree_into(source: &Path, target: &Path) -> Result<u64, String> {
    match fs::symlink_metadata(source) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err(format!("{} is not a real directory", source.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(err(e)),
    }
    let entries = filtered_snapshot(source)?;
    copy_entries(source, target, &entries)?;
    Ok(entries.iter().filter(|e| e.kind == "file").count() as u64)
}

// ------------------------------------------------------------- export

#[tauri::command]
pub fn unified_backup_begin(
    window: WebviewWindow,
    state: State<'_, UnifiedBackup>,
    gate: State<'_, WriteGate>,
    destination: String,
) -> Result<String, String> {
    let token = unique_token();
    let gate_token = gate.acquire(window.label())?;
    let stage = match staging_next_to(Path::new(&destination)) {
        Ok(stage) => stage,
        Err(e) => {
            let _ = gate.release(window.label(), gate_token);
            return Err(e);
        }
    };
    let mut map = state.0.lock().map_err(|_| "E_BACKUP_STATE".to_string())?;
    map.insert(
        token.clone(),
        Session {
            stage,
            owner: window.label().to_string(),
            gate_token,
            journal_bytes: 0,
            journal_chunks: 0,
            journal_sealed: false,
        },
    );
    Ok(token)
}

/// Append one chunk of the journal image JSON produced by the front end.
#[tauri::command]
pub fn unified_backup_put_journal_images(
    state: State<'_, UnifiedBackup>,
    token: String,
    chunk_index: u64,
    base64: String,
) -> Result<u64, String> {
    let bytes = B64.decode(base64.as_bytes()).map_err(|_| "E_BACKUP_CHUNK".to_string())?;
    if bytes.is_empty() {
        return Err("E_BACKUP_CHUNK".into());
    }
    let mut map = state.0.lock().map_err(|_| "E_BACKUP_STATE".to_string())?;
    let session = map.get_mut(&token).ok_or("E_BACKUP_TOKEN")?;
    if session.journal_sealed || chunk_index != session.journal_chunks {
        return Err("E_BACKUP_CHUNK_ORDER".into());
    }
    session.journal_bytes = session
        .journal_bytes
        .checked_add(bytes.len() as u64)
        .ok_or("E_BACKUP_SIZE")?;
    if session.journal_bytes > MAX_SECTION_BYTES {
        return Err("E_BACKUP_SIZE".into());
    }
    let path = session.journal_path();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file.write_all(&bytes).map_err(err)?;
    session.journal_chunks += 1;
    Ok(session.journal_chunks)
}

#[tauri::command]
pub fn unified_backup_abort(
    state: State<'_, UnifiedBackup>,
    gate: State<'_, WriteGate>,
    token: String,
) -> Result<(), String> {
    let session = {
        let mut map = state.0.lock().map_err(|_| "E_BACKUP_STATE".to_string())?;
        map.remove(&token).ok_or("E_BACKUP_TOKEN")?
    };
    let owner = session.owner.clone();
    let gate_token = session.gate_token;
    drop(session); // Stage::drop removes the staging directory.
    gate.release(&owner, gate_token)?;
    Ok(())
}

#[tauri::command]
pub fn unified_backup_finish(
    app: AppHandle,
    state: State<'_, UnifiedBackup>,
    gate: State<'_, WriteGate>,
    token: String,
    workspace: Option<String>,
) -> Result<ExportResult, String> {
    let session = {
        let mut map = state.0.lock().map_err(|_| "E_BACKUP_STATE".to_string())?;
        map.remove(&token).ok_or("E_BACKUP_TOKEN")?
    };
    let owner = session.owner.clone();
    let gate_token = session.gate_token;
    let result = (|| -> Result<ExportResult, String> {
        let mut session = session;
        let app_data = app.path().app_data_dir().map_err(err)?;
        let app_config = app.path().app_config_dir().map_err(err)?;
        let workspace = workspace.as_deref().map(Path::new);
        let manifest = export_into(&session.stage.path, &app_data, &app_config, workspace)?;
        // Publish atomically; never overwrite an existing backup.
        publish(&mut session.stage)?;
        Ok(ExportResult {
            path: session.stage.target.to_string_lossy().into_owned(),
            manifest,
        })
    })();
    // Release the barrier whether or not the export succeeded.
    let released = gate.release(&owner, gate_token);
    match (result, released) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(e)) => Err(format!("Backup published, but the write lock was not released: {e}")),
        (Err(e), _) => Err(e),
    }
}

/// Build a complete archive inside an empty staging directory.
///
/// Split out from the command so the whole pipeline — copying, hashing, change
/// detection and manifest generation — runs in tests without a Tauri app.
pub(crate) fn export_into(
    root: &Path,
    app_data: &Path,
    app_config: &Path,
    workspace: Option<&Path>,
) -> Result<Manifest, String> {
    let mut sections = Sections {
        workspace: false,
        planner: false,
        journal_images: false,
        writing_artifacts: false,
        secrets: false,
    };

    // 1. workspace — copied, then both sides re-hashed to prove nothing moved
    if let Some(workspace) = workspace {
        let source = fs::canonicalize(workspace).map_err(|e| format!("Workspace is unavailable: {e}"))?;
        if !fs::symlink_metadata(&source).map_err(err)?.file_type().is_dir() {
            return Err("Workspace must be a real directory".into());
        }
        if root.starts_with(&source) || source.starts_with(root) {
            return Err("The backup cannot live inside the workspace it copies".into());
        }
        copy_tree_into(&source, &root.join(WORKSPACE))?;
        sections.workspace = true;
    }

    // 2. planner domain tables, written verbatim so the bytes stay reproducible
    let planner_bytes = read_planner_bytes(app_data)?;
    fs::create_dir_all(root.join(PLANNER)).map_err(err)?;
    let mut planner_file = private_file(&root.join(PLANNER_JSON))?;
    planner_file.write_all(&planner_bytes).map_err(err)?;
    planner_file.sync_all().map_err(err)?;
    drop(planner_file);
    sections.planner = true;

    // 3. journal images, streamed in by the front end before this runs
    let journal = root.join(JOURNAL_IMAGES);
    if !journal.exists() {
        write_json(&journal, &serde_json::json!({"version": 1, "images": []}))?;
    }
    let images = fs::symlink_metadata(&journal).map_err(err)?;
    if !images.file_type().is_file() || images.len() > MAX_SECTION_BYTES {
        return Err("Journal image data is missing or too large".into());
    }
    sections.journal_images = true;

    // 4. attachments and writing artifacts
    copy_tree_into(&app_data.join("attachments"), &root.join(ATTACHMENTS))?;
    let mut writing_files = copy_tree_into(&app_data.join("article-assets"), &root.join(ARTICLE_ASSETS))?;
    let themes = app_config.join("themes");
    if themes.exists() {
        writing_files += copy_tree_into(&themes, &root.join(THEMES))?;
    }
    fs::create_dir_all(root.join(WRITING)).map_err(err)?;
    write_json(
        &root.join(METADATA),
        &serde_json::json!({
            "version": 1,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "articleAssets": root.join(ARTICLE_ASSETS).exists(),
            "themes": themes.exists(),
            "writingFiles": writing_files,
        }),
    )?;
    sections.writing_artifacts = true;

    // 5. a plain-text note that travels with the archive
    let mut readme = private_file(&root.join(README))?;
    readme.write_all(README_TEXT.as_bytes()).map_err(err)?;
    readme.sync_all().map_err(err)?;
    drop(readme);

    // 6. manifest — every path is re-hashed after it lands in the staging tree
    let mut files = Vec::new();
    scan_stage(root, Path::new(""), &mut files)?;
    let (file_count, total_size) = audit_entries(&files)?;
    let manifest = Manifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        created_at: chrono::Utc::now().timestamp_millis(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        sections,
        file_count,
        total_size,
        files,
    };
    write_json(&root.join(MANIFEST), &manifest)?;
    sync_dir(root)?;
    Ok(manifest)
}

const README_TEXT: &str = "Konh unified backup\n\
\n\
This archive contains the writing workspace, planner domain data, journal images,\n\
article assets and custom themes. Credentials are NOT included: WeChat, AI,\n\
Cloudinary, Jina, WebDAV, SMTP and OAuth secrets must be entered again after a\n\
restore.\n\
\n\
Restore: Settings -> 备份同步 -> 统一备份与恢复. Inspect the folder first, then\n\
restore the planner in place and the writing files into a new directory. A failed\n\
restore keeps the current data and leaves the rollback point in place.\n";

// -------------------------------------------------------------- inspect

fn read_manifest(backup: &Path) -> Result<Manifest, String> {
    let path = backup.join(MANIFEST);
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("No manifest in this folder: {e}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("Invalid backup manifest".into());
    }
    let mut bytes = Vec::new();
    open_regular(&path)?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Invalid backup manifest".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid backup manifest: {e}"))?;
    if manifest.format != FORMAT {
        return Err("This folder is not a Konh unified backup".into());
    }
    if manifest.format_version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported backup format version {}",
            manifest.format_version
        ));
    }
    if manifest.sections.secrets {
        return Err("This backup claims to contain credentials and is refused".into());
    }
    if manifest.file_count != manifest.files.len() as u64 {
        return Err("Backup manifest file count does not match its file list".into());
    }
    let (_, total) = audit_entries(&manifest.files)?;
    if total != manifest.total_size {
        return Err("Backup manifest size does not match its file list".into());
    }
    if manifest.total_size > MAX_TOTAL_BYTES {
        return Err("Backup exceeds the size limit".into());
    }
    Ok(manifest)
}

fn verify_backup(backup: &Path, manifest: &Manifest) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();
    let mut listed = HashSet::with_capacity(manifest.files.len());
    for entry in &manifest.files {
        listed.insert(entry.path.clone());
        let path = backup.join(&entry.path);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => {
                problems.push(format!("Missing: {}", entry.path));
                continue;
            }
        };
        if entry.kind == "directory" {
            if !meta.file_type().is_dir() {
                problems.push(format!("Expected a directory: {}", entry.path));
            }
            continue;
        }
        if !meta.file_type().is_file() {
            problems.push(format!("Not a regular file: {}", entry.path));
            continue;
        }
        if meta.len() != entry.size {
            problems.push(format!("Size mismatch: {}", entry.path));
            continue;
        }
        let mut file = open_regular(&path)?;
        let mut hash = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut size = 0u64;
        loop {
            let n = file.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > entry.size {
                break;
            }
            hash.update(&buf[..n]);
        }
        if size != entry.size || format!("{:x}", hash.finalize()) != entry.sha256 {
            problems.push(format!("Checksum mismatch: {}", entry.path));
        }
    }
    // Files the manifest does not mention would be silently restored: refuse them.
    let mut actual = Vec::new();
    scan_stage(backup, Path::new(""), &mut actual)?;
    for entry in actual {
        if !listed.contains(&entry.path) {
            problems.push(format!("Unexpected file: {}", entry.path));
        }
    }
    Ok(problems)
}

#[tauri::command]
pub fn unified_backup_inspect(backup: String) -> Result<InspectResult, String> {
    let root = Path::new(&backup);
    let meta = fs::symlink_metadata(root).map_err(|e| format!("Cannot open this backup: {e}"))?;
    if !meta.file_type().is_dir() {
        return Err("A unified backup is a folder".into());
    }
    let manifest = read_manifest(root)?;
    let problems = verify_backup(root, &manifest)?;
    Ok(InspectResult {
        path: root.to_string_lossy().into_owned(),
        format: manifest.format,
        format_version: manifest.format_version,
        created_at: manifest.created_at,
        app_version: manifest.app_version,
        sections: manifest.sections.clone(),
        file_count: manifest.file_count,
        total_size: manifest.total_size,
        ok: problems.is_empty(),
        problems,
    })
}

/// Read one archived file in chunks. Only paths named by the manifest are readable.
#[tauri::command]
pub fn unified_backup_read_file(
    backup: String,
    path: String,
    offset: u64,
    limit: u64,
) -> Result<ReadChunk, String> {
    validate_rel_path(&path)?;
    let root = Path::new(&backup);
    let manifest = read_manifest(root)?;
    let entry = manifest
        .files
        .iter()
        .find(|e| e.path == path && e.kind == "file")
        .ok_or("E_BACKUP_PATH")?;
    let limit = limit.clamp(1, CHUNK as u64) as usize;
    let file_path = root.join(&entry.path);
    let mut file = open_regular(&file_path)?;
    if offset > 0 {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(offset)).map_err(err)?;
    }
    let mut buf = vec![0u8; limit];
    let mut filled = 0usize;
    while filled < limit {
        let n = file.read(&mut buf[filled..]).map_err(err)?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(ReadChunk {
        base64: B64.encode(&buf),
        size: entry.size,
        eof: offset + filled as u64 >= entry.size,
        next_offset: offset + filled as u64,
    })
}

// ------------------------------------------------------------- restore

fn require_clean_backup(backup: &Path) -> Result<Manifest, String> {
    let manifest = read_manifest(backup)?;
    let problems = verify_backup(backup, &manifest)?;
    if !problems.is_empty() {
        return Err(format!("Backup verification failed: {}", problems.join("; ")));
    }
    Ok(manifest)
}

#[tauri::command]
pub fn unified_backup_restore_workspace(
    backup: String,
    destination: String,
    policy: String,
) -> Result<RestoreResult, String> {
    let root = Path::new(&backup);
    let manifest = require_clean_backup(root)?;
    if !manifest.sections.workspace {
        return Err("This backup does not contain a writing workspace".into());
    }
    let policy = MergePolicy::parse(&policy)?;
    let source = root.join(WORKSPACE);
    let target = Path::new(&destination);
    let mut conflicts = Vec::new();
    let files = match policy {
        MergePolicy::NewOnly => {
            let entries = filtered_snapshot(&source)?;
            let mut stage = crate::workspace_backup::create_destination(&source, target)?;
            let count = entries.iter().filter(|e| e.kind == "file").count() as u64;
            copy_entries(&source, &stage.path, &entries)?;
            publish(&mut stage)?;
            count
        }
        MergePolicy::KeepCurrent => {
            let meta = fs::symlink_metadata(target).map_err(|e| format!("Restore folder is unusable: {e}"))?;
            if !meta.file_type().is_dir() {
                return Err("Restore destination must be a directory".into());
            }
            let target = fs::canonicalize(target).map_err(err)?;
            if target.starts_with(fs::canonicalize(root).map_err(err)?) {
                return Err("The restore folder cannot be inside the backup".into());
            }
            let entries = filtered_snapshot(&source)?;
            let mut count = 0u64;
            for entry in &entries {
                validate_rel_path(&entry.path)?;
                let to = target.join(&entry.path);
                if entry.kind == "directory" {
                    if !to.exists() {
                        fs::create_dir(&to).map_err(err)?;
                    }
                    continue;
                }
                if fs::symlink_metadata(&to).is_ok() {
                    let existing = fs::read(&to).map_err(err)?;
                    let mut hash = Sha256::new();
                    hash.update(&existing);
                    if format!("{:x}", hash.finalize()) == entry.sha256 {
                        continue;
                    }
                    let alt = conflict_name(&to);
                    copy_one(&source.join(&entry.path), &alt, entry)?;
                    conflicts.push(alt.strip_prefix(&target).unwrap_or(&alt).to_string_lossy().into_owned());
                } else {
                    copy_one(&source.join(&entry.path), &to, entry)?;
                }
                count += 1;
            }
            count
        }
    };
    Ok(RestoreResult {
        target: target.to_string_lossy().into_owned(),
        files,
        rows: 0,
        rollback_dir: None,
        conflicts,
    })
}

fn conflict_name(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned());
    let parent = path.parent().unwrap_or(Path::new("."));
    for n in 1..10_000u32 {
        let name = match &ext {
            Some(ext) => format!("{stem} (备份 {n}).{ext}"),
            None => format!("{stem} (备份 {n})"),
        };
        let candidate = parent.join(name);
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    parent.join(format!("{stem} (备份)"))
}

fn copy_one(from: &Path, to: &Path, entry: &Entry) -> Result<(), String> {
    let mut input = open_regular(from)?;
    let mut output = private_file(to)?;
    let copied = std::io::copy(&mut Read::by_ref(&mut input).take(entry.size + 1), &mut output).map_err(err)?;
    if copied != entry.size {
        return Err(format!("File changed while restoring: {}", entry.path));
    }
    output.sync_all().map_err(err)
}

/// Export the current planner so a failed restore can be undone.
fn write_rollback_point(app_data: &Path, label: &str) -> Result<PathBuf, String> {
    let dir = app_data.join("rollback").join(timestamped_name(label));
    fs::create_dir_all(&dir).map_err(err)?;
    let bytes = read_planner_bytes(app_data)?;
    let mut file = private_file(&dir.join("planner.json"))?;
    file.write_all(&bytes).map_err(err)?;
    file.sync_all().map_err(err)?;
    if app_data.join("attachments").exists() {
        copy_tree_into(&app_data.join("attachments"), &dir.join("attachments"))?;
    }
    write_json(
        &dir.join("rollback.json"),
        &serde_json::json!({
            "version": 1,
            "createdAt": chrono::Utc::now().timestamp_millis(),
            "kind": label,
            "note": "Pre-restore snapshot. Restoring from here uses the same planner restore path.",
        }),
    )?;
    sync_dir(&dir)?;
    Ok(dir)
}

/// Replace a directory with a staged copy, keeping the old one until the caller commits.
struct DirSwap {
    target: PathBuf,
    staging: PathBuf,
    old: PathBuf,
    committed: bool,
}

impl DirSwap {
    fn begin(target: PathBuf, staging: PathBuf) -> Result<Self, String> {
        let old = target.with_file_name(format!(
            ".{}-old-{}",
            target.file_name().unwrap_or_default().to_string_lossy(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        Ok(Self {
            target,
            staging,
            old,
            committed: false,
        })
    }
    fn swap(&mut self) -> Result<(), String> {
        if fs::symlink_metadata(&self.target).is_ok() {
            fs::rename(&self.target, &self.old).map_err(err)?;
        }
        if let Err(e) = fs::rename(&self.staging, &self.target) {
            // Put the original back before reporting the failure.
            if fs::symlink_metadata(&self.old).is_ok() {
                let _ = fs::rename(&self.old, &self.target);
            }
            return Err(err(e));
        }
        Ok(())
    }
    fn commit(&mut self) -> Result<(), String> {
        self.committed = true;
        if fs::symlink_metadata(&self.old).is_ok() {
            fs::remove_dir_all(&self.old).map_err(err)?;
        }
        Ok(())
    }
    fn rollback(&mut self) {
        if self.committed {
            return;
        }
        if fs::symlink_metadata(&self.old).is_ok() {
            let _ = fs::remove_dir_all(&self.target);
            let _ = fs::rename(&self.old, &self.target);
        }
    }
}

impl Drop for DirSwap {
    fn drop(&mut self) {
        if !self.committed {
            self.rollback();
        }
    }
}

#[tauri::command]
pub fn unified_backup_restore_planner(app: AppHandle, backup: String) -> Result<RestoreResult, String> {
    let app_data = app.path().app_data_dir().map_err(err)?;
    let root = Path::new(&backup);
    let manifest = require_clean_backup(root)?;
    if !manifest.sections.planner {
        return Err("This backup does not contain planner data".into());
    }
    let planner_bytes = read_section_file(root, PLANNER_JSON, MAX_JSON_BYTES)?;
    let doc = parse_planner_doc(&planner_bytes)?;
    if !planner_db(&app_data).exists() {
        return Err("Open the planner once before restoring into it".into());
    }

    // 1. rollback point first — nothing changes if this fails
    let rollback = write_rollback_point(&app_data, "konh-rollback")?;

    // 2. attachments: staged copy, swap, then the database transaction
    let mut swap = if manifest.sections.planner && root.join(ATTACHMENTS).exists() {
        let staging = app_data.join(format!(
            ".attachments-staging-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        copy_tree_into(&root.join(ATTACHMENTS), &staging)?;
        let mut swap = DirSwap::begin(app_data.join("attachments"), staging)?;
        swap.swap()?;
        Some(swap)
    } else {
        None
    };

    // 3. the tables, in one transaction
    match apply_planner(&app_data, &doc) {
        Ok(rows) => {
            if let Some(swap) = swap.as_mut() {
                swap.commit()?;
            }
            let file_count = manifest.files.iter().filter(|e| e.kind == "file").count() as u64;
            Ok(RestoreResult {
                target: planner_db(&app_data).to_string_lossy().into_owned(),
                files: file_count,
                rows,
                rollback_dir: Some(rollback.to_string_lossy().into_owned()),
                conflicts: Vec::new(),
            })
        }
        Err(e) => {
            if let Some(swap) = swap.as_mut() {
                swap.rollback();
            }
            Err(format!("Planner restore failed and current data was kept: {e}"))
        }
    }
}

#[tauri::command]
pub fn unified_backup_restore_writing(app: AppHandle, backup: String) -> Result<RestoreResult, String> {
    let app_data = app.path().app_data_dir().map_err(err)?;
    let app_config = app.path().app_config_dir().map_err(err)?;
    let root = Path::new(&backup);
    let manifest = require_clean_backup(root)?;
    if !manifest.sections.writing_artifacts {
        return Err("This backup does not contain writing assets".into());
    }
    let rollback = write_rollback_point(&app_data, "konh-writing-rollback")?;
    let mut restored = 0u64;
    for (section, target) in [
        (ARTICLE_ASSETS, app_data.join("article-assets")),
        (THEMES, app_config.join("themes")),
    ] {
        let source = root.join(section);
        if !source.exists() {
            continue;
        }
        let staging = target.with_file_name(format!(
            ".{}-staging-{}",
            target.file_name().unwrap_or_default().to_string_lossy(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        restored += copy_tree_into(&source, &staging)?;
        let mut swap = DirSwap::begin(target, staging)?;
        swap.swap()?;
        swap.commit()?;
    }
    Ok(RestoreResult {
        target: app_data.to_string_lossy().into_owned(),
        files: restored,
        rows: 0,
        rollback_dir: Some(rollback.to_string_lossy().into_owned()),
        conflicts: Vec::new(),
    })
}

fn read_section_file(root: &Path, path: &str, limit: u64) -> Result<Vec<u8>, String> {
    validate_rel_path(path)?;
    let file_path = root.join(path);
    let meta = fs::symlink_metadata(&file_path).map_err(|e| format!("Missing {path}: {e}"))?;
    if !meta.file_type().is_file() || meta.len() > limit {
        return Err(format!("Invalid {path}"));
    }
    let mut bytes = Vec::new();
    open_regular(&file_path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err(format!("{path} is too large"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn seed_planner_db(app_data: &Path) -> PathBuf {
        fs::create_dir_all(app_data).unwrap();
        let path = planner_db(app_data);
        let db = Connection::open(&path).unwrap();
        for table in PLANNER_TABLES {
            db.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS \"{table}\" (id TEXT PRIMARY KEY, title TEXT, data TEXT);"
            ))
            .unwrap();
        }
        // Configuration and the sync queue must never reach the archive.
        db.execute_batch(
            "CREATE TABLE user_prefs(key TEXT PRIMARY KEY, value TEXT);\
             CREATE TABLE sync_outbox(id TEXT PRIMARY KEY, payload TEXT);\
             INSERT INTO user_prefs VALUES('wechat_secret','SECRET-WECHAT-APPSECRET');\
             INSERT INTO sync_outbox VALUES('1','SECRET-SYNC-PAYLOAD');",
        )
        .unwrap();
        db.execute(
            "INSERT INTO tasks VALUES('t1','买牛奶','{\"id\":\"t1\",\"title\":\"买牛奶\"}')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO journal_entries VALUES('j1','今天的日记','{\"id\":\"j1\",\"body\":\"空核域界\"}')",
            [],
        )
        .unwrap();
        drop(db);
        path
    }

    fn seed_workspace(dir: &Path) {
        fs::create_dir_all(dir.join("笔记/深层")).unwrap();
        fs::write(dir.join("文章.md"), "---\ntitle: 空核域界\n---\n正文").unwrap();
        fs::write(dir.join("笔记/深层/中文 文件名.md"), "# 标题").unwrap();
        fs::create_dir(dir.join("空目录")).unwrap();
        fs::write(dir.join("图片.png"), [0x89u8, 0x50, 0x4e, 0x47, 0, 1, 2, 3]).unwrap();
        fs::write(dir.join("._文章.md"), "resource fork").unwrap();
        fs::write(dir.join(".DS_Store"), "junk").unwrap();
    }

    struct Fixture {
        _root: TempDir,
        app_data: PathBuf,
        app_config: PathBuf,
        workspace: PathBuf,
        backup: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = TempDir::new().unwrap();
        let app_data = root.path().join("appdata");
        let app_config = root.path().join("appconfig");
        let workspace = root.path().join("workspace");
        let backup = root.path().join("backup");
        seed_planner_db(&app_data);
        fs::create_dir_all(app_config.join("themes")).unwrap();
        fs::write(app_config.join("themes/olive-journal.css"), ":root{--ink:#333}").unwrap();
        fs::create_dir_all(app_data.join("article-assets")).unwrap();
        fs::write(app_data.join("article-assets/cover.png"), [1u8, 2, 3]).unwrap();
        seed_workspace(&workspace);
        Fixture {
            _root: root,
            app_data,
            app_config,
            workspace,
            backup,
        }
    }

    fn export_fixture(fx: &Fixture) -> Manifest {
        let mut stage = staging_next_to(&fx.backup).unwrap();
        let manifest =
            export_into(&stage.path, &fx.app_data, &fx.app_config, Some(&fx.workspace)).unwrap();
        publish(&mut stage).unwrap();
        manifest
    }

    fn inspect(path: &Path) -> InspectResult {
        unified_backup_inspect(path.to_string_lossy().into_owned()).unwrap()
    }

    #[test]
    fn export_archives_both_sides_and_restores_the_workspace() {
        let fx = fixture();
        let manifest = export_fixture(&fx);

        assert!(manifest.sections.workspace);
        assert!(manifest.sections.planner);
        assert!(manifest.sections.journal_images);
        assert!(manifest.sections.writing_artifacts);
        assert!(!manifest.sections.secrets);
        assert_eq!(manifest.format, FORMAT);
        assert_eq!(manifest.format_version, FORMAT_VERSION);
        assert_eq!(manifest.file_count, manifest.files.len() as u64);

        let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"workspace/文章.md"));
        assert!(paths.contains(&"workspace/笔记/深层/中文 文件名.md"));
        assert!(paths.contains(&"workspace/空目录"), "empty directories are archived");
        assert!(paths.contains(&PLANNER_JSON));
        assert!(paths.contains(&JOURNAL_IMAGES));
        assert!(paths.contains(&README));
        assert!(
            paths.iter().all(|p| !p.contains("._") && !p.contains(".DS_Store")),
            "macOS resource forks must not be archived: {paths:?}"
        );
        assert!(manifest.files.iter().any(|f| f.kind == "directory" && f.path == "workspace/空目录"));

        let report = inspect(&fx.backup);
        assert!(report.ok, "{:?}", report.problems);
        assert_eq!(report.format_version, FORMAT_VERSION);

        let restored = fx.backup.parent().unwrap().join("restored");
        let result = unified_backup_restore_workspace(
            fx.backup.to_string_lossy().into_owned(),
            restored.to_string_lossy().into_owned(),
            "new-only".into(),
        )
        .unwrap();
        assert!(result.conflicts.is_empty());
        assert_eq!(
            fs::read(restored.join("文章.md")).unwrap(),
            fs::read(fx.workspace.join("文章.md")).unwrap()
        );
        assert_eq!(
            fs::read(restored.join("图片.png")).unwrap(),
            fs::read(fx.workspace.join("图片.png")).unwrap()
        );
        assert!(restored.join("笔记/深层/中文 文件名.md").exists());
        assert!(restored.join("空目录").is_dir());
        assert!(!restored.join("._文章.md").exists());
    }

    #[test]
    fn archive_never_contains_credentials_or_the_sync_queue() {
        let fx = fixture();
        let manifest = export_fixture(&fx);
        let mut scanned = 0usize;
        for entry in manifest.files.iter().filter(|e| e.kind == "file") {
            let bytes = fs::read(fx.backup.join(&entry.path)).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("SECRET-WECHAT-APPSECRET"), "{}", entry.path);
            assert!(!text.contains("SECRET-SYNC-PAYLOAD"), "{}", entry.path);
            scanned += 1;
        }
        assert!(scanned > 5);

        let planner = fs::read_to_string(fx.backup.join(PLANNER_JSON)).unwrap();
        assert!(planner.contains("konh-planner"));
        assert!(planner.contains("买牛奶"));
        assert!(!planner.contains("user_prefs"));
        assert!(!planner.contains("sync_outbox"));
    }

    #[test]
    fn tampering_and_unlisted_files_are_reported() {
        let fx = fixture();
        export_fixture(&fx);

        let planner = fx.backup.join(PLANNER_JSON);
        let mut bytes = fs::read(&planner).unwrap();
        bytes[0] ^= 0xff;
        fs::write(&planner, &bytes).unwrap();

        let report = inspect(&fx.backup);
        assert!(!report.ok);
        assert!(report.problems.iter().any(|p| p.contains("Checksum mismatch")));
        assert!(require_clean_backup(&fx.backup).is_err());
        assert!(unified_backup_restore_workspace(
            fx.backup.to_string_lossy().into_owned(),
            fx.backup.parent().unwrap().join("nope").to_string_lossy().into_owned(),
            "new-only".into(),
        )
        .is_err());

        // A file the manifest does not mention would be restored silently.
        let fx2 = fixture();
        export_fixture(&fx2);
        fs::write(fx2.backup.join("planner/extra.sh"), b"#!/bin/sh\n").unwrap();
        let report = inspect(&fx2.backup);
        assert!(!report.ok);
        assert!(report.problems.iter().any(|p| p.contains("Unexpected file")));
    }

    #[test]
    fn unsafe_and_colliding_paths_are_rejected() {
        for bad in [
            "",
            "../x",
            "a/../b",
            "/abs",
            "//srv/share",
            "C:\\temp\\x",
            "a/b\\c",
            "a//b",
            "con/x.md",
            "a/.",
            "nul",
        ] {
            assert!(validate_rel_path(bad).is_err(), "{bad:?} must be rejected");
        }
        for good in ["a.md", "笔记/深层/x.md", "a/b/c.png"] {
            assert!(validate_rel_path(good).is_ok(), "{good:?} must pass");
        }

        let file = |path: &str| FileEntry {
            path: path.into(),
            kind: "file".into(),
            size: 1,
            sha256: "a".repeat(64),
        };
        assert!(audit_entries(&[file("a.md"), file("a.md")]).is_err());
        assert!(audit_entries(&[file("a.md"), file("A.md")]).is_err());
        assert!(audit_entries(&[file("a.md"), file("b.md")]).is_ok());
        assert!(audit_entries(&[FileEntry {
            path: "a.md".into(),
            kind: "file".into(),
            size: 1,
            sha256: "zz".into(),
        }])
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_stop_the_export_before_it_publishes() {
        use std::os::unix::fs::symlink;
        let fx = fixture();
        symlink("/etc/passwd", fx.workspace.join("link.md")).unwrap();
        let stage = staging_next_to(&fx.backup).unwrap();
        let error = export_into(&stage.path, &fx.app_data, &fx.app_config, Some(&fx.workspace));
        assert!(error.is_err(), "a symlink must fail the export");
        drop(stage);
        assert!(!fx.backup.exists(), "nothing is published after a failure");
    }

    #[test]
    fn copy_detects_a_file_that_changed_after_the_scan() {
        let root = TempDir::new().unwrap();
        let source = root.path().join("src");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("a.md"), "one").unwrap();
        let entries = filtered_snapshot(&source).unwrap();
        fs::write(source.join("a.md"), "one and a lot more text").unwrap();
        let error = copy_entries(&source, &root.path().join("dst"), &entries).unwrap_err();
        assert!(error.contains("changed"), "{error}");
    }

    #[test]
    fn an_existing_destination_is_never_overwritten() {
        let root = TempDir::new().unwrap();
        let target = root.path().join("backup");
        fs::create_dir(&target).unwrap();
        assert_eq!(staging_next_to(&target).unwrap_err(), "E_BACKUP_EXISTS");
    }

    #[test]
    fn workspace_restore_keeps_existing_files_and_renames_conflicts() {
        let fx = fixture();
        export_fixture(&fx);
        let target = fx.backup.parent().unwrap().join("existing");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("文章.md"), "本机的新版本").unwrap();

        let result = unified_backup_restore_workspace(
            fx.backup.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
            "keep-current".into(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(target.join("文章.md")).unwrap(), "本机的新版本");
        assert_eq!(result.conflicts.len(), 1);
        let alternative = target.join(&result.conflicts[0]);
        assert!(alternative.exists(), "the backup copy is stored beside it");
        assert!(fs::read_to_string(&alternative).unwrap().contains("空核域界"));
        assert!(target.join("图片.png").exists(), "missing files are still restored");
    }

    #[test]
    fn planner_restore_replaces_rows_and_keeps_a_usable_rollback_point() {
        let fx = fixture();
        export_fixture(&fx);

        // Work done after the backup was taken.
        {
            let db = Connection::open(planner_db(&fx.app_data)).unwrap();
            db.execute("INSERT INTO tasks VALUES('t2','备份之后的新任务','{}')", [])
                .unwrap();
        }

        let rollback = write_rollback_point(&fx.app_data, "unit-rollback").unwrap();
        assert!(rollback.join("planner.json").exists());
        assert!(rollback.join("rollback.json").exists());

        let bytes = read_section_file(&fx.backup, PLANNER_JSON, MAX_JSON_BYTES).unwrap();
        let doc = parse_planner_doc(&bytes).unwrap();
        let rows = apply_planner(&fx.app_data, &doc).unwrap();
        assert!(rows >= 2, "tasks + journal entries");

        {
            let db = Connection::open(planner_db(&fx.app_data)).unwrap();
            let count: i64 = db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
            assert_eq!(count, 1, "the archive replaces the table, it does not merge");
            let data: String = db
                .query_row("SELECT data FROM tasks WHERE id='t1'", [], |r| r.get(0))
                .unwrap();
            assert!(data.contains("买牛奶"), "the data column survives the round trip");
            let secrets: i64 = db
                .query_row("SELECT COUNT(*) FROM user_prefs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(secrets, 1, "settings are untouched by a planner restore");
        }

        let rollback_doc = parse_planner_doc(&fs::read(rollback.join("planner.json")).unwrap()).unwrap();
        assert_eq!(rollback_doc.tables["tasks"].as_array().unwrap().len(), 2);
        apply_planner(&fx.app_data, &rollback_doc).unwrap();
        let db = Connection::open(planner_db(&fx.app_data)).unwrap();
        let count: i64 = db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2, "the rollback point really restores the previous state");
    }

    #[test]
    fn export_reads_rows_that_only_live_in_the_wal() {
        // The planner database runs in WAL mode, so a row can sit in the
        // -wal file while another connection is still writing. The export
        // must see it instead of archiving a stale snapshot.
        let fx = fixture();
        let path = planner_db(&fx.app_data);
        let writer = Connection::open(&path).unwrap();
        let mode: String = writer
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        writer
            .execute(
                "INSERT INTO tasks VALUES('t2','写在 WAL 里','{\"id\":\"t2\"}')",
                [],
            )
            .unwrap();
        let wal = path.with_extension("db-wal");
        assert!(wal.exists(), "the row should still be in the write-ahead log");

        let bytes = read_planner_bytes(&fx.app_data).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("写在 WAL 里"), "WAL rows must be exported: {text}");
        assert!(text.contains("买牛奶"));

        let manifest = export_into(&fx.backup, &fx.app_data, &fx.app_config, None).unwrap();
        assert!(manifest.sections.planner);
        drop(writer);
    }

    #[test]
    fn journal_images_are_streamed_and_archived_verbatim() {
        let fx = fixture();
        let token = unique_token();
        let mut stage = staging_next_to(&fx.backup).unwrap();
        fs::create_dir_all(stage.path.join(PLANNER)).unwrap();
        let json = serde_json::json!({
            "version": 1,
            "images": [{"id": "img-1", "type": "image/png", "size": 3, "base64": "AQID"}],
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        fs::write(stage.path.join(JOURNAL_IMAGES), &bytes).unwrap();

        let manifest = export_into(&stage.path, &fx.app_data, &fx.app_config, None).unwrap();
        publish(&mut stage).unwrap();
        assert!(manifest.sections.journal_images);
        assert!(!manifest.sections.workspace);
        assert_eq!(fs::read(fx.backup.join(JOURNAL_IMAGES)).unwrap(), bytes);
        assert!(inspect(&fx.backup).ok);
        assert!(token.starts_with(&std::process::id().to_string()));

        let entry = manifest
            .files
            .iter()
            .find(|e| e.path == JOURNAL_IMAGES)
            .unwrap();
        let chunk = unified_backup_read_file(
            fx.backup.to_string_lossy().into_owned(),
            JOURNAL_IMAGES.into(),
            0,
            4,
        )
        .unwrap();
        assert_eq!(B64.decode(chunk.base64).unwrap().len(), 4);
        assert!(!chunk.eof);
        assert_eq!(chunk.size, entry.size);
    }

    #[test]
    fn a_backup_without_a_workspace_refuses_a_workspace_restore() {
        let fx = fixture();
        {
            let mut stage = staging_next_to(&fx.backup).unwrap();
            export_into(&stage.path, &fx.app_data, &fx.app_config, None).unwrap();
            publish(&mut stage).unwrap();
        }
        let error = unified_backup_restore_workspace(
            fx.backup.to_string_lossy().into_owned(),
            fx.backup.parent().unwrap().join("x").to_string_lossy().into_owned(),
            "new-only".into(),
        )
        .unwrap_err();
        assert!(error.contains("workspace"), "{error}");
    }

    #[test]
    fn a_foreign_folder_is_not_accepted_as_a_backup() {
        let root = TempDir::new().unwrap();
        let other = root.path().join("not-a-backup");
        fs::create_dir(&other).unwrap();
        fs::write(other.join(MANIFEST), "{\"format\":\"other\"}").unwrap();
        assert!(unified_backup_inspect(other.to_string_lossy().into_owned()).is_err());
        assert!(unified_backup_inspect(root.path().join("missing").to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn the_documented_isolated_scenario_runs_end_to_end() {
        // The layout the hand-off document asks for: one throwaway tree with
        // workspace/, planner/, backup/ and restore/ side by side.
        let base = std::env::temp_dir().join("konh-unified-backup-test");
        let _ = fs::remove_dir_all(&base);
        let workspace = base.join("workspace");
        let app_data = base.join("planner");
        let app_config = base.join("config");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(base.join("backup")).unwrap();
        fs::create_dir_all(base.join("restore")).unwrap();

        seed_planner_db(&app_data);
        fs::create_dir_all(app_config.join("themes")).unwrap();
        fs::write(app_config.join("themes/olive-journal.css"), ":root{}").unwrap();
        fs::create_dir_all(workspace.join("草稿/第二层/第三层")).unwrap();
        fs::write(workspace.join("草稿/第二层/第三层/空核 笔记.md"), "空核域界").unwrap();
        fs::write(workspace.join("封面.png"), [0xffu8, 0xd8, 0xff, 0xe0]).unwrap();
        fs::create_dir(workspace.join("空的子目录")).unwrap();

        let backup = base.join("backup/konh-backup");
        let mut stage = staging_next_to(&backup).unwrap();
        let manifest = export_into(&stage.path, &app_data, &app_config, Some(&workspace)).unwrap();
        publish(&mut stage).unwrap();
        assert!(manifest.sections.workspace);

        let report = inspect(&backup);
        assert!(report.ok, "{:?}", report.problems);

        let restored = base.join("restore/Konh恢复-20261113-1130");
        unified_backup_restore_workspace(
            backup.to_string_lossy().into_owned(),
            restored.to_string_lossy().into_owned(),
            "new-only".into(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(restored.join("草稿/第二层/第三层/空核 笔记.md")).unwrap(),
            "空核域界"
        );
        assert!(restored.join("空的子目录").is_dir());

        // Restoring twice into the same place is refused, not merged.
        assert!(unified_backup_restore_workspace(
            backup.to_string_lossy().into_owned(),
            restored.to_string_lossy().into_owned(),
            "new-only".into(),
        )
        .is_err());

        let bytes = read_section_file(&backup, PLANNER_JSON, MAX_JSON_BYTES).unwrap();
        apply_planner(&app_data, &parse_planner_doc(&bytes).unwrap()).unwrap();
        let db = Connection::open(planner_db(&app_data)).unwrap();
        let count: i64 = db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
}
