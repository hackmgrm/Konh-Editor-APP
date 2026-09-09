//! Immutable local layout and publication assets. No credentials are accepted.
use std::{fs, path::{Path, PathBuf}, sync::Mutex, io::Write};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

static LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: usize = 100 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset { name: String, data_url: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    id: String,
    kind: String,
    article_key: String,
    title: String,
    created_at: u64,
    markdown: String,
    html: String,
    submitted_html: String,
    #[serde(default)]
    original_markdown: String,
    #[serde(default)]
    original_html: String,
    assets: Vec<Asset>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest { id: String, kind: String, article_key: String, title: String, created_at: u64, assets: Vec<(String, String)> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary { id: String, kind: String, article_key: String, title: String, created_at: u64, bytes: u64 }
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("article-assets");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') { return Err("无效快照编号".into()); }
    Ok(())
}
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() < 80 && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.') && !name.starts_with('.')
}
fn decode(asset: &Asset) -> Result<(String, Vec<u8>), String> {
    if !valid_name(&asset.name) { return Err("无效图片文件名".into()); }
    let (prefix, data) = asset.data_url.split_once(",").ok_or("无效图片数据")?;
    let mime = prefix.strip_prefix("data:").and_then(|s| s.strip_suffix(";base64")).ok_or("图片必须使用 base64")?;
    if !["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp"].contains(&mime) { return Err("不支持的图片类型".into()); }
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    Ok((mime.into(), bytes))
}
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())
}
fn save_at(root: &Path, artifact: &Artifact) -> Result<(), String> {
    valid_id(&artifact.id)?;
    if !["publish", "layout"].contains(&artifact.kind.as_str()) { return Err("无效快照类型".into()); }
    let target = root.join(&artifact.id);
    if target.exists() { return Err("快照已存在，不能覆盖".into()); }
    let mut size = artifact.markdown.len() + artifact.html.len() + artifact.submitted_html.len() + artifact.original_markdown.len() + artifact.original_html.len();
    if size > MAX_BYTES || artifact.assets.len() > 200 { return Err("快照过大".into()); }
    let mut assets = Vec::new();
    for asset in &artifact.assets {
        let (mime, bytes) = decode(asset)?;
        size += bytes.len();
        if size > MAX_BYTES { return Err("快照超过 100 MB，请减少图片后重试".into()); }
        assets.push((asset.name.clone(), mime, bytes));
    }
    let pending = root.join(format!("{}.pending", artifact.id));
    fs::create_dir(&pending).map_err(|e| e.to_string())?;
    let result = (|| {
        fs::create_dir(pending.join("assets")).map_err(|e| e.to_string())?;
        let manifest = Manifest { id: artifact.id.clone(), kind: artifact.kind.clone(), article_key: artifact.article_key.clone(), title: artifact.title.clone(), created_at: artifact.created_at, assets: assets.iter().map(|(name, mime, _)| (name.clone(), mime.clone())).collect() };
        for (name, _, bytes) in assets { write_file(&pending.join("assets").join(name), &bytes)?; }
        write_file(&pending.join("source.md"), artifact.markdown.as_bytes())?;
        write_file(&pending.join("preview.html"), artifact.html.as_bytes())?;
        write_file(&pending.join("submitted.html"), artifact.submitted_html.as_bytes())?;
        write_file(&pending.join("original.md"), artifact.original_markdown.as_bytes())?;
        write_file(&pending.join("original.html"), artifact.original_html.as_bytes())?;
        write_file(&pending.join("manifest.json"), &serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)?;
        fs::rename(&pending, &target).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&pending); }
    result
}
fn read_at(root: &Path, id: &str) -> Result<Artifact, String> {
    valid_id(id)?;
    let dir = root.join(id);
    let manifest: Manifest = serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|_| "快照不存在或已清理")?).map_err(|e| e.to_string())?;
    let mut assets = Vec::new();
    for (name, mime) in manifest.assets {
        if !valid_name(&name) { return Err("快照包含无效图片路径".into()); }
        let bytes = fs::read(dir.join("assets").join(&name)).map_err(|e| e.to_string())?;
        assets.push(Asset { name, data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)) });
    }
    let read = |name| fs::read_to_string(dir.join(name)).map_err(|e| e.to_string());
    Ok(Artifact { id: manifest.id, kind: manifest.kind, article_key: manifest.article_key, title: manifest.title, created_at: manifest.created_at, markdown: read("source.md")?, html: read("preview.html")?, submitted_html: read("submitted.html")?, original_markdown: read("original.md").unwrap_or_default(), original_html: read("original.html").unwrap_or_default(), assets })
}
#[tauri::command]
pub fn artifact_save(app: AppHandle, artifact: Artifact) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    save_at(&root(&app)?, &artifact)
}
#[tauri::command]
pub fn artifact_read(app: AppHandle, id: String) -> Result<Artifact, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    read_at(&root(&app)?, &id)
}
#[tauri::command]
pub fn artifact_list(app: AppHandle, article_key: String) -> Result<Vec<Summary>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for entry in fs::read_dir(root(&app)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if valid_id(&entry.file_name().to_string_lossy()).is_err() { continue; }
        let dir = entry.path();
        let Ok(bytes) = fs::read(dir.join("manifest.json")) else { continue };
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if manifest.article_key != article_key { continue; }
        let mut size = bytes.len() as u64;
        for name in ["source.md", "preview.html", "submitted.html", "original.md", "original.html"] { size += fs::metadata(dir.join(name)).map_err(|e| e.to_string())?.len(); }
        for (name, _) in &manifest.assets {
            if !valid_name(name) { return Err("快照图片路径无效".into()); }
            size += fs::metadata(dir.join("assets").join(name)).map_err(|e| e.to_string())?.len();
        }
        results.push(Summary { id: manifest.id, kind: manifest.kind, article_key: manifest.article_key, title: manifest.title, created_at: manifest.created_at, bytes: size });
    }
    results.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    Ok(results)
}
#[tauri::command]
pub fn artifact_delete(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    valid_id(&id)?;
    match fs::remove_dir_all(root(&app)?.join(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Artifact { Artifact { id: "11111111-1111-1111-1111-111111111111".into(), kind: "publish".into(), article_key: "stable-id".into(), title: "快照".into(), created_at: 1, markdown: "原稿".into(), html: "<img src=\"assets/1.png\">".into(), original_markdown: String::new(), original_html: String::new(), submitted_html: "<img src=\"https://example/image\">".into(), assets: vec![Asset {name: "1.png".into(), data_url: "data:image/png;base64,aGVsbG8=".into()}] } }
    #[test]
    fn snapshot_survives_source_changes_and_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap(); let mut input = sample();
        save_at(dir.path(), &input).unwrap(); input.markdown = "新稿".into();
        assert!(save_at(dir.path(), &input).is_err());
        let stored = read_at(dir.path(), &input.id).unwrap();
        assert_eq!(stored.markdown, "原稿"); assert_eq!(stored.assets[0].data_url, input.assets[0].data_url);
        assert!(stored.submitted_html.contains("https://"));
    }
    #[test]
    fn rejects_traversal_and_bad_images() {
        let dir = tempfile::tempdir().unwrap(); let mut input = sample();
        input.assets[0].name = "../escape".into(); assert!(save_at(dir.path(), &input).is_err());
        input = sample(); input.assets[0].data_url = "data:text/html;base64,aGVsbG8=".into(); assert!(save_at(dir.path(), &input).is_err());
        assert!(read_at(dir.path(), "../escape").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
