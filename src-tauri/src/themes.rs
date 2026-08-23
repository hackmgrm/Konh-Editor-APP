//! Custom article themes — the ones the agent writes, rather than the ones
//! shipped in theme.ts.
//!
//! They live in `themes/` inside the app config directory, one JSON file per
//! theme, named after its id. Two reasons for that address rather than the
//! workspace:
//!
//! * a workspace holds nothing but the user's own writing (that is why prefs
//!   moved out of it — see vault.rs), and a theme is a property of this
//!   editor, not of one folder of drafts;
//! * `prefs.themeId` is stored per workspace, so a theme has to resolve from
//!   every workspace or switching folders would silently drop the styling.
//!
//! Nothing here understands what a theme *is*. The file is parsed as JSON and
//! handed over as-is; validating the shape and merging it onto a preset is the
//! front end's job, because the front end is where the Theme type lives.
//!
//! The directory is watched for the same reason the vault is: the agent edits
//! the file with its own tools, and the preview should follow along while it
//! works, without anyone pressing refresh.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const THEMES_DIR: &str = "themes";
/// The format description handed to the agent. Written by the front end (which
/// owns the Theme type and therefore the only accurate description of it), read
/// by the CLI out of this directory
const GUIDE_FILE: &str = "GUIDE.md";

/// notify's watcher stops the moment it drops, so it needs somewhere to live
#[derive(Default)]
pub struct ThemeWatch(pub Mutex<Option<RecommendedWatcher>>);

/// Where the agent should write, and what it should read before writing
#[derive(Serialize)]
pub struct ThemePaths {
    pub dir: String,
    pub guide: String,
}

fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录：{e}"))?
        .join(THEMES_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("建不了主题目录：{e}"))?;
    Ok(dir)
}

/// A theme id is also a file name, so it may not carry a path in it
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Every custom theme on this machine, as raw JSON.
///
/// A file that will not parse is skipped rather than failing the whole read:
/// the agent writes these, and one truncated file should not take the other
/// themes down with it.
#[tauri::command]
pub fn themes_read(app: AppHandle) -> Vec<serde_json::Value> {
    let Ok(dir) = themes_dir(&app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()) {
            Some(value) => out.push(value),
            None => log::warn!("主题文件读不了或不是 JSON：{}", path.display()),
        }
    }
    out
}

/// Put the format guide on disk and report where the agent should work.
///
/// Rewritten every time rather than written once: the guide describes the
/// Theme type, it is generated from the front end that owns that type, and a
/// stale copy on disk would teach the agent last version's field names.
#[tauri::command]
pub fn themes_guide_write(app: AppHandle, text: String) -> Result<ThemePaths, String> {
    let dir = themes_dir(&app)?;
    let guide = dir.join(GUIDE_FILE);
    fs::write(&guide, text).map_err(|e| format!("写不了主题说明：{e}"))?;
    Ok(ThemePaths {
        dir: dir.to_string_lossy().to_string(),
        guide: guide.to_string_lossy().to_string(),
    })
}

/// Throw one away.
///
/// The file is found by the id *inside* it rather than by its name, even
/// though the guide asks for the two to match: the agent wrote these files,
/// and a theme the user can see in the list but cannot delete would be a worse
/// failure than a slow scan of a directory holding a handful of files.
#[tauri::command]
pub fn theme_delete(app: AppHandle, id: String) -> Result<(), String> {
    if !safe_id(&id) {
        return Err(format!("主题 id 不对：{id}"));
    }
    let dir = themes_dir(&app)?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("读不了主题目录：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_theme_file(&path) {
            continue;
        }
        let holds_id = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|v| v.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .is_some_and(|found| found == id);
        if holds_id {
            fs::remove_file(&path).map_err(|e| format!("删不掉主题：{e}"))?;
        }
    }
    Ok(())
}

/// Watch the themes directory and tell the front end when anything changes.
///
/// Started once at launch, and never restarted — unlike a vault, this
/// directory does not move. Events are not debounced; the front end re-reads
/// everything each time, which for a handful of small files is cheaper than
/// working out what exactly changed.
pub fn start_watch(app: &AppHandle) {
    let Ok(dir) = themes_dir(app) else { return };
    let handle = app.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.paths.iter().any(|p| is_theme_file(p)) {
            let _ = handle.emit("themes:change", ());
        }
    });
    let Ok(mut watcher) = watcher else {
        log::warn!("建不了主题监听器");
        return;
    };
    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        log::warn!("监听不了主题目录：{e}");
        return;
    }
    log::info!("themes watch 已挂上 {}", dir.display());
    if let Ok(mut slot) = app.state::<ThemeWatch>().0.lock() {
        *slot = Some(watcher);
    }
}

/// GUIDE.md changes on every launch and editor swap files churn constantly;
/// neither is a theme, and neither should make the preview re-read
fn is_theme_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_不能带路径() {
        assert!(safe_id("celadon"));
        assert!(safe_id("my_theme-2"));
        assert!(!safe_id("../settings"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id(""));
    }

    #[test]
    fn 只有_json_算主题文件() {
        assert!(is_theme_file(Path::new("/x/celadon.json")));
        assert!(!is_theme_file(Path::new("/x/GUIDE.md")));
    }
}
