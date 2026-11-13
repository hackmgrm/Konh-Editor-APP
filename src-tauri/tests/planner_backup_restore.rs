#[path = "../src/workspace_backup.rs"]
mod workspace_backup;
#[path = "../src/write_gate.rs"]
mod write_gate;
#[path = "../src/planner_backup.rs"]
mod planner_backup;

use rusqlite::Connection;
use std::fs;

#[test]
fn restores_domain_without_touching_sync_and_rolls_back_on_constraint_error() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let target = dir.path().join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    for root in [&source, &target] {
        let db = Connection::open(root.join("tongyun_planner.db")).unwrap();
        db.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE sync_outbox(payload TEXT); INSERT INTO sync_outbox VALUES('secret');").unwrap();
    }
    let src = Connection::open(source.join("tongyun_planner.db")).unwrap();
    src.execute("INSERT INTO tasks VALUES ('new','restored')", []).unwrap();
    let dst = Connection::open(target.join("tongyun_planner.db")).unwrap();
    dst.execute("INSERT INTO tasks VALUES ('old','original')", []).unwrap();
    // The public export command needs an AppHandle; create the same verified archive.
    let payload = dir.path().join("payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("planner.json"), r#"{"version":1,"scope":"planner-domain-only","tables":{"tasks":[{"id":"new","title":"restored"}]}}"#).unwrap();
    let backup = dir.path().join("backup");
    workspace_backup::export(&payload, &backup).unwrap();
    planner_backup::restore(&target, &backup).unwrap();
    assert_eq!(dst.query_row("SELECT title FROM tasks", [], |r| r.get::<_, String>(0)).unwrap(), "restored");
    assert_eq!(dst.query_row("SELECT payload FROM sync_outbox", [], |r| r.get::<_, String>(0)).unwrap(), "secret");
    fs::write(payload.join("planner.json"), r#"{"version":1,"scope":"planner-domain-only","tables":{"tasks":[{"id":"bad"}]}}"#).unwrap();
    let bad = dir.path().join("bad");
    workspace_backup::export(&payload, &bad).unwrap();
    assert!(planner_backup::restore(&target, &bad).is_err());
    assert_eq!(dst.query_row("SELECT title FROM tasks", [], |r| r.get::<_, String>(0)).unwrap(), "restored");
}
