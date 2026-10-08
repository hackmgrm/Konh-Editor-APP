//! Independent local-first productivity storage. A revision guards main/quick-add/scheduler writes.
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::Path};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub revision: i64,
    pub data: Option<Value>,
}

pub fn connect(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS productivity (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;
    Ok(db)
}
pub fn database(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    connect(&dir.join("productivity.sqlite"))
}
pub fn read(db: &Connection) -> Result<Snapshot, String> {
    use rusqlite::OptionalExtension;
    let row: Option<(i64, String)> = db
        .query_row(
            "SELECT revision, data FROM productivity WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(Snapshot {
            revision: 0,
            data: None,
        }),
        Some((revision, text)) => Ok(Snapshot {
            revision,
            data: Some(
                serde_json::from_str(&text)
                    .map_err(|e| format!("效率数据损坏，已停止写入：{e}"))?,
            ),
        }),
    }
}
pub fn validate(data: &Value) -> Result<(), String> {
    if data["schema"] != 1 {
        return Err("不支持的效率数据版本".into());
    }
    for key in [
        "tasks",
        "labels",
        "events",
        "journals",
        "sessions",
        "completions",
    ] {
        let rows = data[key]
            .as_array()
            .ok_or_else(|| format!("缺少数据集合：{key}"))?;
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            let id = row["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("记录缺少 id")?;
            if !ids.insert(id) {
                return Err(format!("重复记录：{key}/{id}"));
            }
            if !row["updatedAt"].is_number() {
                return Err("记录缺少修改时间".into());
            }
        }
    }
    if !data["settings"].is_object() {
        return Err("缺少效率设置".into());
    }
    Ok(())
}
pub fn save(db: &mut Connection, expected: i64, data: &Value) -> Result<Snapshot, String> {
    validate(data)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if read(&tx)?.revision != expected {
        return Err("PRODUCTIVITY_CONFLICT".into());
    }
    let revision = expected + 1;
    tx.execute("INSERT INTO productivity(id, revision, data) VALUES(1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data", params![revision, data.to_string()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Snapshot {
        revision,
        data: Some(data.clone()),
    })
}
#[tauri::command]
pub fn productivity_load(app: AppHandle) -> Result<Snapshot, String> {
    read(&database(&app)?)
}
#[tauri::command]
pub fn productivity_save(app: AppHandle, expected: i64, data: Value) -> Result<Snapshot, String> {
    let result = save(&mut database(&app)?, expected, &data)?;
    let _ = app.emit("productivity-changed", result.revision);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn data() -> Value {
        serde_json::json!({"schema":1,"tasks":[],"labels":[],"events":[],"journals":[],"sessions":[],"completions":[],"settings":{}})
    }
    #[test]
    fn persists_and_rejects_stale_window_without_losing_data() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.sqlite");
        let mut a = connect(&path).unwrap();
        let mut b = connect(&path).unwrap();
        save(&mut a, 0, &data()).unwrap();
        let mut next = data();
        next["tasks"] = serde_json::json!([{"id":"a","updatedAt":42,"title":"保留我"}]);
        save(&mut b, 1, &next).unwrap();
        assert_eq!(
            save(&mut a, 1, &data()).unwrap_err(),
            "PRODUCTIVITY_CONFLICT"
        );
        drop(a);
        drop(b);
        assert_eq!(
            read(&connect(&path).unwrap()).unwrap().data.unwrap()["tasks"][0]["title"],
            "保留我"
        );
    }
    #[test]
    fn rejects_unknown_schema_and_duplicate_ids() {
        let mut v = data();
        v["schema"] = 2.into();
        assert!(validate(&v).is_err());
        v["schema"] = 1.into();
        v["tasks"] = serde_json::json!([{"id":"a","updatedAt":1},{"id":"a","updatedAt":2}]);
        assert!(validate(&v).is_err());
    }
}
