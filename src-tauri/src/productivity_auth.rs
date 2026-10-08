use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
fn entry(window: &WebviewWindow, key: &str) -> Result<keyring::Entry, String> {
    if window.label() != "main" || !key.starts_with("konh-productivity-") || key.len() > 240 {
        return Err("无权访问账号凭据".into());
    }
    keyring::Entry::new("com.konheditor.productivity", key).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn productivity_secret_read(
    window: WebviewWindow,
    key: String,
) -> Result<Option<String>, String> {
    match entry(&window, &key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("系统密钥存储不可用：{e}")),
    }
}
#[tauri::command]
pub fn productivity_secret_write(
    window: WebviewWindow,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let entry = entry(&window, &key)?;
    match value {
        Some(value) => entry.set_password(&value).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}
/// PKCE authorization returns only a one-time code through a loopback listener.
#[tauri::command]
pub async fn productivity_oauth(
    window: WebviewWindow,
    app: AppHandle,
    url: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("只能从主窗口登录".into());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || !parsed.path().ends_with("/auth/v1/authorize") {
        return Err("登录地址无效，请使用 HTTPS 账号服务".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind("127.0.0.1:42819").map_err(|e| format!("登录回调端口 42819 不可用：{e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(180) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
                    let mut request = [0u8; 8192]; let length = match stream.read(&mut request) { Ok(n) => n, Err(_) => continue };
                    let line = String::from_utf8_lossy(&request[..length]);
                    let target = line.lines().next().and_then(|s| s.strip_prefix("GET ")).and_then(|s| s.split_whitespace().next()).unwrap_or("");
                    let callback = reqwest::Url::parse(&format!("http://127.0.0.1:42819{target}")).map_err(|e| e.to_string())?;
                    if callback.path() != "/callback" { let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); continue; }
                    let code = callback.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned());
                    let body = "<!doctype html><meta charset=utf-8><title>空核登录</title><p>已收到登录回调，请返回空核查看登录结果。此窗口可以关闭。</p>";
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes());
                    return code.ok_or_else(|| "登录被取消或服务未返回授权码".into());
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("登录等待超时，请重新登录".into())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "requires an unlocked OS key store"]
    fn os_key_store_round_trip() {
        let key = format!("konh-productivity-verification-{}-{}", std::process::id(), chrono::Utc::now().timestamp_millis());
        let entry = keyring::Entry::new("com.konheditor.productivity", &key).unwrap();
        entry.set_password("temporary-verification-value").unwrap();
        let stored = entry.get_password().unwrap();
        entry.delete_credential().unwrap();
        assert_eq!(stored, "temporary-verification-value");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
