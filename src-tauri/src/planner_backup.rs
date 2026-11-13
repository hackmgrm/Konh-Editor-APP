//! Isolated planner data export. Only explicitly selected domain tables are included;
//! settings, KV, sync queues, migration backups and credentials are never copied.
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Map, Value};
use std::{fs, path::Path, sync::atomic::{AtomicU64, Ordering}};
use tauri::{AppHandle, Manager};

const TABLES: &[&str] = &["tasks", "journal_entries", "pomodoro_logs", "habits", "sticky_notes", "countdowns", "timeblocks"];
static NEXT: AtomicU64 = AtomicU64::new(0);

// Domain columns only. The opaque `data` fields and agent configuration are excluded.
const COLUMNS: &[&str] = &["id", "title", "description", "notes", "category", "due_date", "due_time", "is_favorite", "is_pinned", "repeat_rule", "repeat_anchor_day", "priority", "energy_level", "estimated_pomodoros", "journal_id", "completed_at", "stamp", "time_block_start", "time_block_end", "subtasks_json", "tags_json", "depends_on_json", "attachments_json", "updated_at", "deleted_at", "link_key", "body", "entry_date", "is_daily", "mood", "ai_comment", "template_id", "washi_tape", "stickers_json", "created_at", "timestamp", "duration", "task_id", "task_title", "name", "emoji", "done_today", "streak", "last_done_date", "text", "color", "rotate", "target_date", "is_lunar", "date", "start_time", "end_time", "assignee_kind", "assignee_agent_id", "run_status"]; 

struct Scratch(std::path::PathBuf);
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn scratch() -> Result<Scratch, String> {
    for _ in 0..100 {
        let path = std::env::temp_dir().join(format!("konh-planner-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        match builder.create(&path) { Ok(()) => return Ok(Scratch(path)), Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue, Err(e) => return Err(e.to_string()) }
    }
    Err("Cannot create temporary directory".into())
}

fn export(app_data: &Path, destination: &Path) -> Result<(), String> {
    let root = fs::canonicalize(app_data).map_err(|e| e.to_string())?;
    let parent = fs::canonicalize(destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    if parent.starts_with(&root) { return Err("Destination cannot be inside app data".into()); }
    let db_path = root.join("tongyun_planner.db");
    if !fs::symlink_metadata(&db_path).map_err(|e| e.to_string())?.file_type().is_file() { return Err("Planner database must be a real file".into()); }
    let db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    db.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let mut tables = Map::new();
    for table in TABLES {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !exists { continue; }
        let mut stmt = db.prepare(&format!("SELECT * FROM \"{table}\"")).map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut obj = Map::new();
            for (i, name) in names.iter().enumerate() {
                // Opaque JSON and future columns may contain credentials or sync settings.
                if !COLUMNS.contains(&name.as_str()) { continue; }
                let value = match row.get_ref(i).map_err(|e| e.to_string())? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => v.into(),
                    ValueRef::Real(v) => serde_json::Number::from_f64(v).map(Value::Number).ok_or("Non-finite number")?,
                    ValueRef::Text(v) => String::from_utf8(v.to_vec()).map_err(|e| e.to_string())?.into(),
                    ValueRef::Blob(_) => return Err("Unsupported planner blob".into()),
                };
                obj.insert(name.clone(), value);
            }
            result.push(Value::Object(obj));
        }
        tables.insert((*table).into(), Value::Array(result));
    }
    db.execute_batch("ROLLBACK").map_err(|e| e.to_string())?;
    let temp = scratch()?;
    let data = temp.0.join("data"); fs::create_dir(&data).map_err(|e| e.to_string())?;
    fs::write(data.join("planner.json"), serde_json::to_vec_pretty(&serde_json::json!({"version":1,"scope":"planner-domain-only","tables":tables})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let attachments = root.join("attachments");
    match fs::symlink_metadata(&attachments) {
        Ok(_) => {
            let archive = temp.0.join("attachment-archive");
            crate::workspace_backup::export(&attachments, &archive)?;
            crate::workspace_backup::import(&archive, &data.join("attachments"))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    crate::workspace_backup::export(&data, destination)
}

// Import is deliberately an isolated file extraction, not an application restore.
fn import(backup: &Path, destination: &Path) -> Result<(), String> {
    let temp = scratch()?;
    let extracted = temp.0.join("extracted");
    crate::workspace_backup::import(backup, &extracted)?;
    let value: Value = serde_json::from_slice(&fs::read(extracted.join("planner.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if value["version"] != 1 || value["scope"] != "planner-domain-only" || !value["tables"].is_object() { return Err("Not a planner export".into()); }
    // Publish only the already validated extraction, never reopen an untrusted archive.
    // workspace import stages and verifies its source and refuses to overwrite.
    let validated = temp.0.join("validated");
    crate::workspace_backup::export(&extracted, &validated)?;
    crate::workspace_backup::import(&validated, destination)
}

/// Replace the exported domain tables in a single SQLite transaction. Attachments
/// cannot participate in that transaction, so archives containing them are refused.
pub fn restore(app_data: &Path, backup: &Path) -> Result<(), String> {
    let temp = scratch()?;
    let extracted = temp.0.join("extracted");
    crate::workspace_backup::import(backup, &extracted)?;
    if extracted.join("attachments").exists() { return Err("Atomic attachment restore is not supported".into()); }
    for entry in fs::read_dir(&extracted).map_err(|e| e.to_string())? {
        if entry.map_err(|e| e.to_string())?.file_name() != "planner.json" { return Err("Unexpected backup entry".into()); }
    }
    let value: Value = serde_json::from_slice(&fs::read(extracted.join("planner.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let object = value.as_object().ok_or("Invalid planner export")?;
    if object.len() != 3 || value["version"] != 1 || value["scope"] != "planner-domain-only" { return Err("Not a planner export".into()); }
    let tables = value["tables"].as_object().ok_or("Invalid tables")?;
    if tables.is_empty() || tables.keys().any(|t| !TABLES.contains(&t.as_str())) { return Err("Unknown or empty tables".into()); }
    let path = app_data.join("tongyun_planner.db");
    if !fs::symlink_metadata(&path).map_err(|e| e.to_string())?.file_type().is_file() { return Err("Planner database must be a real file".into()); }
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    // Refuse triggers and foreign keys: neither implicit sync writes nor cascades
    // into excluded tables are allowed during replacement.
    let triggers: i64 = tx.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if triggers != 0 { return Err("Restore requires a database without triggers".into()); }
    let mut stmt = tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map_err(|e| e.to_string())?;
    let names = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);
    for name in names {
        let sql = format!("PRAGMA foreign_key_list(\"{}\")", name.replace('"', "\"\""));
        let mut s = tx.prepare(&sql).map_err(|e| e.to_string())?;
        if s.query([]).map_err(|e| e.to_string())?.next().map_err(|e| e.to_string())?.is_some() { return Err("Restore requires a database without foreign keys".into()); }
    }
    for (table, rows) in tables {
        let rows = rows.as_array().ok_or("Invalid table rows")?;
        let mut s = tx.prepare(&format!("PRAGMA table_info(\"{table}\")")).map_err(|e| e.to_string())?;
        let columns = s.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        drop(s);
        if columns.is_empty() { return Err(format!("Missing table {table}")); }
        tx.execute(&format!("DELETE FROM \"{table}\""), []).map_err(|e| e.to_string())?;
        for row in rows {
            let row = row.as_object().ok_or("Invalid row")?;
            if !row.contains_key("id") || row.keys().any(|k| !COLUMNS.contains(&k.as_str()) || !columns.contains(k)) { return Err("Invalid row columns".into()); }
            let mut vals = Vec::new();
            for v in row.values() {
                vals.push(match v {
                    Value::Null => rusqlite::types::Value::Null,
                    Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                    Value::Number(n) if n.is_i64() => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
                    Value::Number(n) if n.is_f64() => rusqlite::types::Value::Real(n.as_f64().unwrap()),
                    _ => return Err("Invalid SQLite value".into()),
                });
            }
            let fields = row.keys().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(",");
            let placeholders = vec!["?"; vals.len()].join(",");
            tx.execute(&format!("INSERT INTO \"{table}\" ({fields}) VALUES ({placeholders})"), rusqlite::params_from_iter(vals)).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn planner_backup_restore(app: AppHandle, backup: String) -> Result<(), String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    restore(&app.path().app_data_dir().map_err(|e| e.to_string())?, Path::new(&backup))
}

#[tauri::command]
pub fn planner_backup_export(app: AppHandle, destination: String) -> Result<(), String> {
    export(&app.path().app_data_dir().map_err(|e| e.to_string())?, Path::new(&destination))
}
#[tauri::command]
pub fn planner_backup_import(app: AppHandle, backup: String, destination: String) -> Result<(), String> {
    let root = fs::canonicalize(app.path().app_data_dir().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let path = Path::new(&destination);
    let parent = fs::canonicalize(path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    if parent.starts_with(root) { return Err("Destination cannot be inside app data".into()); }
    import(Path::new(&backup), path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_roundtrip_excludes_configuration() {
        let t = tempfile::tempdir().unwrap(); let root = t.path().join("app"); fs::create_dir(&root).unwrap();
        let db = Connection::open(root.join("tongyun_planner.db")).unwrap();
        db.execute_batch("CREATE TABLE tasks(id TEXT, title TEXT); INSERT INTO tasks VALUES('1','hello'); CREATE TABLE kv(key TEXT, value TEXT); INSERT INTO kv VALUES('password','secret');").unwrap();
        fs::create_dir(root.join("attachments")).unwrap(); fs::write(root.join("attachments/a"), b"image").unwrap();
        let backup = t.path().join("backup"); let out = t.path().join("out");
        export(&root, &backup).unwrap(); import(&backup, &out).unwrap();
        let json = fs::read_to_string(out.join("planner.json")).unwrap();
        assert!(json.contains("hello")); assert!(!json.contains("secret"));
        assert_eq!(fs::read(out.join("attachments/a")).unwrap(), b"image");
        assert!(import(&backup, &out).is_err()); assert!(export(&root, &root.join("nested")).is_err());
    }
    #[test]
    fn exports_required_columns_and_omits_sensitive_tables_and_columns() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("app"); fs::create_dir(&root).unwrap();
        let db = Connection::open(root.join("tongyun_planner.db")).unwrap();
        db.execute_batch("CREATE TABLE sticky_notes(id TEXT, text TEXT, color TEXT, rotate REAL, data TEXT); INSERT INTO sticky_notes VALUES('s','note','blue',1.5,'secret'); CREATE TABLE countdowns(id TEXT, target_date TEXT, is_lunar INTEGER); INSERT INTO countdowns VALUES('c','2026-01-01',1); CREATE TABLE timeblocks(id TEXT, date TEXT, start_time TEXT, end_time TEXT); INSERT INTO timeblocks VALUES('t','2026-01-01','09:00','10:00'); CREATE TABLE sync_outbox(payload TEXT); INSERT INTO sync_outbox VALUES('secret');").unwrap();
        let backup = t.path().join("backup"); let out = t.path().join("out");
        export(&root, &backup).unwrap(); import(&backup, &out).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(out.join("planner.json")).unwrap()).unwrap();
        assert_eq!(v["tables"]["sticky_notes"][0]["text"], "note");
        assert_eq!(v["tables"]["countdowns"][0]["target_date"], "2026-01-01");
        assert_eq!(v["tables"]["timeblocks"][0]["start_time"], "09:00");
        assert!(!v.to_string().contains("secret"));
    }
}
