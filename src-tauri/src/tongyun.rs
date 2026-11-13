use tauri::{AppHandle, Emitter, Manager};
use serde::{Serialize, Deserialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};



use crate::webdav_meta::build_target_url;

static QUIT_PENDING: AtomicBool = AtomicBool::new(false);
static QUIT_READY: AtomicBool = AtomicBool::new(false);

pub fn request_quit(app: &AppHandle) {
    if QUIT_READY.load(Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    if QUIT_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }

    let _ = app.emit_to("main", "tongyun-quit-requested", ());

    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        QUIT_READY.store(true, Ordering::SeqCst);
        app_handle.exit(0);
    });
}

#[tauri::command]
pub fn app_quit_ready(app: AppHandle) {
    QUIT_READY.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub fn save_local_attachment(app: AppHandle, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("E_ATTACHMENT_TOO_LARGE".to_string());
    }
    if file_name.is_empty() || file_name == "." || file_name == ".." || !file_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("E_INVALID_ATTACHMENT_NAME".to_string());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&file_name);
    let temporary = dir.join(format!("{}.tmp", file_name));
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_local_attachment(app: AppHandle, file_name: String) -> Result<(), String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    if file_name.is_empty() || file_name == "." || file_name == ".." || !file_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("E_INVALID_ATTACHMENT_NAME".to_string());
    }
    let target = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments").join(file_name);
    if target.exists() {
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 1. 定义多窗口间传递的同步状态数据结构
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct TodoSyncPayload {
    pub task_id: String,
    pub action: String,      // 例如: "complete" (完成), "snooze" (延后), "update" (修改)
    pub source_window: Option<String>,
    // title/description/notes/... 全部改为 Option<String>：
    //   None    → 表示“未提供，不要变更”
    //   Some("") → 表示“显式清空”
    // 前端收方按此语义处理。
    pub title: Option<String>,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub category: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub timestamp: u64,
}

// 2. Tauri Command: 供前端手动调用，用于跨窗口广播状态
#[tauri::command]
pub fn sync_todo_state(app: AppHandle, payload: TodoSyncPayload) -> Result<(), String> {
    app.emit("todo-sync-event", payload)
        .map_err(|e| e.to_string())
}

/// macOS Dock / Finder 再次打开时，只要主窗不可见就把主窗拉回来。
/// 不能用「有没有任何可见窗口」判断：桌面挂件单独可见时主窗仍可能是隐藏的，
/// 那样点 Dock 图标会没有任何反应。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn should_restore_main_on_reopen(main_visible: bool) -> bool {
    !main_visible
}

fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // 主窗真被销毁时（不是这次的隐藏路径），按已合并的窗口配置重建，避免进程活着却永远没窗。
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        return;
    };
    if let Ok(builder) = tauri::WebviewWindowBuilder::from_config(app, &config) {
        let _ = builder.build();
    }
}

// 3. 核心业务逻辑：切换悬浮挂件的显隐状态
fn toggle_widget(app: &AppHandle) {
    if let Some(widget_window) = app.get_webview_window("widget") {
        let is_visible = widget_window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = widget_window.hide();
        } else {
            let _ = widget_window.show();
            let _ = widget_window.set_focus(); 
        }
    }
}

// 4. 新增 Command: 供前端按钮点击调用
#[tauri::command]
pub fn toggle_widget_window(app: AppHandle) -> Result<(), String> {
    toggle_widget(&app);
    Ok(())
}

// 5. 新增 Command: 供前端控制挂件窗口鼠标穿透
#[tauri::command]
pub fn set_widget_click_through(app: AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(widget_window) = app.get_webview_window("widget") {
        widget_window.set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 6. 微休息提醒：主窗前台可见且聚焦时返回 false 由应用内浮层展示，
// 否则发系统通知（不拉起主窗、不抢焦点）。
#[tauri::command]
pub fn notify_micro_break(app: AppHandle, title: String, body: String) -> bool {
    use tauri_plugin_notification::NotificationExt;

    // 挂件或其他本应用窗口持有焦点时，主窗的 is_focused 仍可能是 false，
    // 因此按「主窗可见且未最小化 + 本应用任一窗口持有焦点」判断是否在前台。
    let main = app.get_webview_window("main");
    let main_visible = main
        .as_ref()
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let main_minimized = main
        .as_ref()
        .and_then(|window| window.is_minimized().ok())
        .unwrap_or(false);
    let app_focused = app
        .webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false));
    let inline = main_visible && !main_minimized && app_focused;

    if inline {
        return false;
    }

    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
    true
}

// 6. WebDAV 云备份指令 (在 Rust 端运行以规避前端浏览器的 CORS 限制)
// WebDAV 创建目录 (MKCOL)
#[tauri::command]
pub fn webdav_mkcol(
    url: String,
    username: String,
    password: Option<String>,
    dirname: String,
) -> Result<(), String> {
    let target_url = build_target_url(&url, &dirname)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &target_url);

    if let Some(pass) = password {
        req = req.basic_auth(username, Some(pass));
    } else {
        req = req.basic_auth(username, None::<String>);
    }

    let res = req.send().map_err(|e| e.to_string())?;

    // 405 = already exists, which is fine
    if res.status().is_success() || res.status().as_u16() == 405 {
        Ok(())
    } else {
        Err(format!("E_HTTP_{}: MKCOL failed - {}", res.status().as_u16(), res.status().canonical_reason().unwrap_or("")))
    }
}

#[tauri::command]
pub fn webdav_upload(
    url: String,
    username: String,
    password: Option<String>,
    filename: String,
    content: String,
) -> Result<(), String> {
    let target_url = build_target_url(&url, &filename)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.put(&target_url)
        .header("Content-Type", "application/json; charset=utf-8")
        .body(content);

    if let Some(pass) = password {
        req = req.basic_auth(username, Some(pass));
    } else {
        req = req.basic_auth(username, None::<String>);
    }

    let res = req.send().map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("E_HTTP_{}: Upload failed - {}", res.status().as_u16(), res.status().canonical_reason().unwrap_or("")));
    }

    Ok(())
}

#[tauri::command]
pub fn webdav_download(
    url: String,
    username: String,
    password: Option<String>,
    filename: String,
) -> Result<String, String> {
    let target_url = build_target_url(&url, &filename)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&target_url);

    if let Some(pass) = password {
        req = req.basic_auth(username, Some(pass));
    } else {
        req = req.basic_auth(username, None::<String>);
    }

    let res = req.send().map_err(|e| e.to_string())?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        // 使用稳定的错误标识码，前端按前缀匹配而非文案，避免本地化/大小写差异
        return Err("E_NOT_FOUND: Backup file not found on server.".to_string());
    }

    if !res.status().is_success() {
        return Err(format!("E_HTTP_{}: {}", res.status().as_u16(), res.status().canonical_reason().unwrap_or("")));
    }

    res.text().map_err(|e| e.to_string())
}

// WebDAV 二进制上传 (base64 编码): 用于图片/附件等非文本文件
#[tauri::command]
pub fn webdav_upload_binary(
    url: String,
    username: String,
    password: Option<String>,
    filename: String,
    content_base64: String,
    content_type: String,
) -> Result<(), String> {
    let target_url = build_target_url(&url, &filename)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let mut req = client.put(&target_url)
        .header("Content-Type", &content_type)
        .body(bytes);

    if let Some(pass) = password {
        req = req.basic_auth(username, Some(pass));
    } else {
        req = req.basic_auth(username, None::<String>);
    }

    let res = req.send().map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("E_HTTP_{}: Upload failed", res.status().as_u16()));
    }
    Ok(())
}

// WebDAV 二进制下载 (返回 base64)
#[tauri::command]
pub fn webdav_download_binary(
    url: String,
    username: String,
    password: Option<String>,
    filename: String,
) -> Result<String, String> {
    let target_url = build_target_url(&url, &filename)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&target_url);
    if let Some(pass) = password {
        req = req.basic_auth(username, Some(pass));
    } else {
        req = req.basic_auth(username, None::<String>);
    }

    let res = req.send().map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("E_NOT_FOUND".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("E_HTTP_{}", res.status().as_u16()));
    }

    let bytes = res.bytes().map_err(|e| e.to_string())?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// WebDAV 删除文件 (DELETE)
#[tauri::command]
pub fn webdav_delete(
    url: String,
    username: String,
    password: Option<String>,
    filename: String,
) -> Result<(), String> {
    let target_url = build_target_url(&url, &filename)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.delete(&target_url);
    if let Some(pass) = password {
        req = req.basic_auth(username, Some(pass));
    } else {
        req = req.basic_auth(username, None::<String>);
    }

    let res = req.send().map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("E_NOT_FOUND".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("E_HTTP_{}", res.status().as_u16()));
    }
    Ok(())
}

// ── 本地文件操作 (App Data Directory) ──

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Cannot get app data dir: {}", e))
}

fn ensure_tongyun_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?;
    let tongyun = dir.join("TongYunPlanner");
    std::fs::create_dir_all(&tongyun).map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(tongyun)
}

#[tauri::command]
pub fn tongyun_file_save(app: AppHandle, path: String, data: Vec<u8>) -> Result<(), String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    let base = ensure_tongyun_dir(&app)?;
    let full = safe_path(&base, &path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    std::fs::write(&full, data).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
pub fn file_save_b64(app: AppHandle, path: String, data_b64: String) -> Result<(), String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let base = ensure_tongyun_dir(&app)?;
    let full = safe_path(&base, &path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    std::fs::write(&full, data).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
pub fn file_read(app: AppHandle, path: String) -> Result<Vec<u8>, String> {
    let base = ensure_tongyun_dir(&app)?;
    let full = safe_path(&base, &path)?;
    if !full.exists() {
        return Err("E_NOT_FOUND".to_string());
    }
    std::fs::read(&full).map_err(|e| format!("Cannot read file: {}", e))
}

#[tauri::command]
pub fn file_read_b64(app: AppHandle, path: String) -> Result<String, String> {
    use base64::Engine;
    let base = ensure_tongyun_dir(&app)?;
    let full = safe_path(&base, &path)?;
    if !full.exists() {
        return Err("E_NOT_FOUND".to_string());
    }
    let data = std::fs::read(&full).map_err(|e| format!("Cannot read file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
pub fn file_delete(app: AppHandle, path: String) -> Result<(), String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    let base = ensure_tongyun_dir(&app)?;
    let full = safe_path(&base, &path)?;
    if !full.exists() {
        return Err("E_NOT_FOUND".to_string());
    }
    std::fs::remove_file(&full).map_err(|e| format!("Cannot delete file: {}", e))
}

#[tauri::command]
pub fn file_list(app: AppHandle, prefix: String) -> Result<Vec<String>, String> {
    let base = ensure_tongyun_dir(&app)?;
    let dir = safe_path(&base, &prefix)?;
    if !dir.exists() || !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Cannot list dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Cannot read entry: {}", e))?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                let relative = if prefix.is_empty() {
                    name.to_string()
                } else {
                    format!("{}/{}", prefix, name)
                };
                result.push(relative);
            }
        }
    }
    Ok(result)
}

// 7. RSS 代理拉取命令：在 Rust 端 GET 远程 RSS/Atom XML，绕过前端 CORS 限制
#[tauri::command]
pub fn fetch_rss(url: String) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url)
        .header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|e| format!("E_NETWORK: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("E_HTTP_{}: {}", res.status().as_u16(), res.status().canonical_reason().unwrap_or("")));
    }

    res.text().map_err(|e| e.to_string())
}

// 7.1 RSS / 文章配图代理命令：支持携带目标站点 Referer 绕过防盗链，并转为 base64 data-url 返回前端
#[tauri::command]
pub fn fetch_image_base64(url: String, referer: Option<String>) -> Result<String, String> {
    use base64::Engine;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    if let Some(ref r) = referer {
        if !r.trim().is_empty() {
            req = req.header("Referer", r);
        }
    } else if let Ok(parsed) = reqwest::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            req = req.header("Referer", format!("https://{}/", host));
        }
    }

    let resp = req.send().map_err(|e| format!("E_NETWORK: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("E_HTTP_{}", resp.status().as_u16()));
    }

    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// 8. AI API 代理命令：异步 HTTP 请求到任意 AI 端点，不阻塞 UI
#[tauri::command]
pub async fn ai_proxy(url: String, method: String, headers: std::collections::HashMap<String, String>, body: Option<String>, timeout_secs: Option<u64>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs.unwrap_or(30)))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        _ => client.post(&url).header("Content-Type", "application/json"),
    };

    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }

    if let Some(b) = body {
        req = req.body(b);
    }

    let res = req.send().await.map_err(|e| format!("E_NETWORK: {}", e))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;

    if !(200..300).contains(&status) {
        return Err(format!("E_HTTP_{}: {}", status, text));
    }
    Ok(text)
}

/// 只回传 ~/.tongyun 里和公司库 DSN 有关的字段，不把整份配置打进日志。
#[tauri::command]
pub fn read_pipeline_home_files() -> PipelineHomeFiles {
    let mut files = PipelineHomeFiles::default();
    if let Ok(value) = std::env::var("TONGYUN_REMOTE_DSN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            files.remote_dsn_from_env = Some(trimmed.to_string());
        }
    }
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return files;
    };
    let dir = PathBuf::from(home).join(".tongyun");
    if !dir.is_dir() {
        return files;
    }
    files.pipeline_dsn = read_capped(&dir.join("pipeline.dsn"));
    files.pipeline_json = read_capped(&dir.join("pipeline.json")).and_then(|text| project_pipeline_json(&text));
    files.config_json = read_capped(&dir.join("config.json")).and_then(|text| project_pipeline_json(&text));
    files.env_file = read_capped(&dir.join(".env")).and_then(|text| project_env(&text));
    if files.remote_dsn_from_env.is_none() {
        if let Some(text) = read_capped(&dir.join("planner").join("remote.env"))
            .or_else(|| read_capped(&dir.join("remote.env")))
        {
            for line in text.lines() {
                let trimmed = line.trim();
                let body = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
                if let Some((k, v)) = body.split_once('=') {
                    let k_norm = k.trim().to_ascii_uppercase();
                    if k_norm == "DATABASE_URL" || k_norm == "TONGYUN_REMOTE_DSN" {
                        let val = v.trim().trim_matches('"').trim_matches('\'').trim();
                        if !val.is_empty() {
                            files.remote_dsn_from_env = Some(val.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }
    files
}

#[derive(Serialize, Default)]
pub struct PipelineHomeFiles {
    #[serde(rename = "pipeline.dsn")]
    pipeline_dsn: Option<String>,
    #[serde(rename = "pipeline.json")]
    pipeline_json: Option<String>,
    #[serde(rename = "config.json")]
    config_json: Option<String>,
    #[serde(rename = ".env")]
    env_file: Option<String>,
    #[serde(rename = "remoteDsnFromEnv")]
    remote_dsn_from_env: Option<String>,
}

fn read_capped(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut buf = vec![0u8; 32 * 1024];
    let read = std::io::Read::read(&mut reader, &mut buf).ok()?;
    if read == 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buf[..read]);
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn project_pipeline_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    let mut out = serde_json::Map::new();
    for key in ["dsn", "pipeline_dsn", "pipelineDsn"] {
        if let Some(item) = obj.get(key) {
            out.insert(key.to_string(), item.clone());
        }
    }
    if let Some(pipeline) = obj.get("pipeline").and_then(|item| item.as_object()) {
        if let Some(dsn) = pipeline.get("dsn") {
            let mut nested = serde_json::Map::new();
            nested.insert("dsn".to_string(), dsn.clone());
            out.insert("pipeline".to_string(), serde_json::Value::Object(nested));
        }
    }
    if out.is_empty() {
        return None;
    }
    serde_json::to_string(&out).ok()
}

fn project_env(text: &str) -> Option<String> {
    let mut kept = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let body = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
        let Some((key, _)) = body.split_once('=') else {
            continue;
        };
        let key_norm = key.trim().to_ascii_uppercase();
        if key_norm == "PIPELINE_DSN"
            || key_norm == "TONGYUN_PIPELINE_DSN"
            || key_norm == "TONGYUN_REMOTE_DSN"
            || key_norm == "DATABASE_URL"
        {
            kept.push(body.to_string());
        }
    }
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("\n"))
    }
}


fn safe_path(base: &std::path::Path, path: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    if std::path::Path::new(path).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("E_INVALID_PATH".into());
    }
    Ok(base.join(path))
}
