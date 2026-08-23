//! Application-level configuration — the things that belong to no workspace.
//!
//! There is one category so far: WeChat credentials (AppID / AppSecret), the
//! access_token cache, and the image-upload dedupe table. None of it can travel
//! with a vault — a vault is a directory meant to be committed to git and
//! possibly shared, and an AppSecret in there is an AppSecret leaked.
//!
//! So it lives in the app config directory instead (on macOS,
//! ~/Library/Application Support/com.mars-editor.app/settings.json).
//! The shape is a flat string → string map, matching how localStorage was used
//! before, so the front end did not have to change any call sites when it moved
//! over to this.
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";

type Settings = BTreeMap<String, String>;

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

fn read_all(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_all(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(settings_path(app)?, text).map_err(|e| format!("存不了设置：{e}"))
}

/// Read one key. For other modules (agent.rs needs the CLI path the user typed
/// in); the front end reads everything at once through config_load and never
/// comes through here.
pub fn get(app: &AppHandle, key: &str) -> Option<String> {
    read_all(app).get(key).cloned()
}

/// Read everything once at startup. The front end caches it in memory so every
/// later read is synchronous — that code came from localStorage and is used to
/// synchronous access, which is what made the switch a no-op for its callers.
#[tauri::command]
pub fn config_load(app: AppHandle) -> Settings {
    log::info!("config_load");
    read_all(&app)
}

#[tauri::command]
pub fn config_write(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let mut settings = read_all(&app);
    settings.insert(key, value);
    write_all(&app, &settings)
}

#[tauri::command]
pub fn config_remove(app: AppHandle, key: String) -> Result<(), String> {
    let mut settings = read_all(&app);
    settings.remove(&key);
    write_all(&app, &settings)
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
