//! Application-level configuration — the things that belong to no workspace.
//!
//! There is one category so far: WeChat credentials (AppID / AppSecret), the
//! access_token cache, and the image-upload dedupe table. None of it can travel
//! with a vault — a vault is a directory meant to be committed to git and
//! possibly shared, and an AppSecret in there is an AppSecret leaked.
//!
//! So it lives in the app config directory instead (on macOS,
//! ~/Library/Application Support/com.konheditor.app/settings.json).
//! The shape is a flat string → string map, matching how localStorage was used
//! before, so the front end did not have to change any call sites when it moved
//! over to this.
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

type Settings = BTreeMap<String, String>;

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

fn read_settings(path: &Path) -> Result<Settings, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("配置文件损坏，已停止写入：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::new()),
        Err(e) => Err(format!("读取设置失败：{e}")),
    }
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.pending");
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&text)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result.map_err(|e| format!("存不了设置：{e}"))
}

/// Read one key. For other modules (agent.rs needs the CLI path the user typed
/// in); the front end reads everything at once through config_load and never
/// comes through here.
pub fn get(app: &AppHandle, key: &str) -> Option<String> {
    let _guard = SETTINGS_LOCK.lock().ok()?;
    read_settings(&settings_path(app).ok()?).ok()?.get(key).cloned()
}

/// Read everything once at startup. The front end caches it in memory so every
/// later read is synchronous — that code came from localStorage and is used to
/// synchronous access, which is what made the switch a no-op for its callers.
#[tauri::command]
pub fn config_load(app: AppHandle) -> Result<Settings, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    read_settings(&settings_path(&app)?)
}

#[tauri::command]
pub fn config_write(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = settings_path(&app)?;
    let mut settings = read_settings(&path)?;
    settings.insert(key, value);
    write_settings(&path, &settings)
}

#[tauri::command]
pub fn config_remove(app: AppHandle, key: String) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = settings_path(&app)?;
    let mut settings = read_settings(&path)?;
    settings.remove(&key);
    write_settings(&path, &settings)
}

/// Write a run of bytes to a path the user chose.
///
/// Exporting a long image has to land a file somewhere. An `<a download>`
/// barely works inside WKWebView, and a desktop app should go through the
/// native "Save to…" dialog anyway: the front end gets a path from the dialog
/// and hands the bytes here.
///
/// The path was chosen by the user in a system dialog, so no further scope
/// restriction is imposed here.
#[tauri::command]
pub fn file_save(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, bytes).map_err(|e| format!("存不了 {path}：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_replace_preserves_existing_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut settings = read_settings(&path).unwrap();
        settings.insert("account".into(), "wx-a".into());
        write_settings(&path, &settings).unwrap();
        let mut settings = read_settings(&path).unwrap();
        settings.insert("publish-journal.v1".into(), "submitting".into());
        write_settings(&path, &settings).unwrap();
        assert_eq!(read_settings(&path).unwrap(), settings);
        assert!(!path.with_extension("json.pending").exists());
    }

    #[test]
    fn damaged_settings_do_not_become_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{broken").unwrap();
        assert!(read_settings(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
    }
}
