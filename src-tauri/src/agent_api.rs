//! OpenAI-compatible Agent with a deliberately small workspace tool set.
//!
//! The API key stays in the app config directory. The model never receives an
//! unrestricted shell: it can list, search, read and write only paths below the
//! workspace selected by the user.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

use crate::config;

const MAX_ROUNDS: usize = 12;
const MAX_READ: usize = 240_000;
const MAX_RESULT: usize = 80_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiHistory {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiToolBeat {
    name: String,
    target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRunResult {
    reply: String,
    tools: Vec<ApiToolBeat>,
}

fn setting(app: &AppHandle, key: &str, label: &str) -> Result<String, String> {
    config::get(app, key)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("请先在设置里填写 {label}"))
}

fn endpoint(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn models_endpoint(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if let Some(prefix) = base.strip_suffix("/chat/completions") {
        format!("{prefix}/models")
    } else {
        format!("{base}/models")
    }
}

#[tauri::command]
pub async fn agent_api_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let base = base_url.trim();
    let key = api_key.trim();
    if base.is_empty() || key.is_empty() {
        return Err("请先填写 API Base URL 和 API Key".into());
    }
    let response = reqwest::Client::new()
        .get(models_endpoint(&base))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("获取模型失败：{e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读不到模型响应：{e}"))?;
    if !status.is_success() {
        let short: String = text.chars().take(600).collect();
        return Err(format!("模型接口返回 {status}：{short}"));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("模型响应不是有效 JSON：{e}"))?;
    let mut models: Vec<String> = value.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    if models.is_empty() {
        Err("接口没有返回可用模型；请手动填写模型名".into())
    } else {
        Ok(models)
    }
}

async fn request(app: &AppHandle, body: &Value) -> Result<Value, String> {
    let base = setting(app, "agent.api.baseUrl", "API Base URL")?;
    let key = setting(app, "agent.api.key", "API Key")?;
    let response = reqwest::Client::new()
        .post(endpoint(&base))
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("API 连接失败：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读不到 API 响应：{e}"))?;
    if !status.is_success() {
        let short: String = text.chars().take(600).collect();
        return Err(format!("API 返回 {status}：{short}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("API 响应不是有效 JSON：{e}"))
}

fn model(app: &AppHandle) -> Result<String, String> {
    setting(app, "agent.api.model", "模型名")
}

#[tauri::command]
pub async fn agent_api_test(app: AppHandle) -> Result<String, String> {
    let body = json!({
        "model": model(&app)?,
        "messages": [{"role": "user", "content": "调用 ping 工具"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "ping",
                "description": "测试工具调用兼容性",
                "parameters": {"type": "object", "properties": {}}
            }
        }],
        "max_tokens": 1024,
        "temperature": 0
    });
    let value = request(&app, &body).await?;
    let name = value.pointer("/choices/0/message/tool_calls/0/function/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if name == "ping" {
        Ok("连接和工具调用正常".into())
    } else {
        Err("接口能连接，但没有返回标准 tool_calls；该模型只能聊天，不能作为工作区 Agent".into())
    }
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.as_os_str().is_empty() || rel.is_absolute() {
        return Err("路径必须是工作区内的相对路径".into());
    }
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("路径不能包含 ..、盘符或根目录".into());
    }
    let root = root.canonicalize().map_err(|e| format!("工作区不可用：{e}"))?;
    let candidate = root.join(rel);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("路径没有可用的父目录")?;
    }
    let real = existing.canonicalize().map_err(|e| format!("路径不可用：{e}"))?;
    if !real.starts_with(&root) {
        return Err("路径越出了当前工作区".into());
    }
    Ok(candidate)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn list_files(root: &Path, start: &str) -> Result<String, String> {
    let base = if start.trim().is_empty() { root.to_path_buf() } else { safe_path(root, start)? };
    if !base.is_dir() { return Err("要列出的路径不是文件夹".into()); }
    let mut out = Vec::new();
    let mut pending = vec![base];
    while let Some(dir) = pending.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)
            .map_err(|e| format!("读不了目录：{e}"))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') || name == "node_modules" { continue; }
            let path = entry.path();
            let rel = relative(root, &path);
            if path.is_dir() {
                out.push(format!("{rel}/"));
                if out.len() < 600 { pending.push(path); }
            } else {
                out.push(rel);
            }
            if out.len() >= 600 { break; }
        }
        if out.len() >= 600 { break; }
    }
    Ok(out.join("\n"))
}

fn read_file(root: &Path, path: &str) -> Result<String, String> {
    let path = safe_path(root, path)?;
    let bytes = fs::read(&path).map_err(|e| format!("读不了文件：{e}"))?;
    if bytes.len() > MAX_READ { return Err(format!("文件超过 {} KB", MAX_READ / 1000)); }
    String::from_utf8(bytes).map_err(|_| "目前只能读取 UTF-8 文本文件".into())
}

fn write_file(root: &Path, path: &str, content: &str) -> Result<String, String> {
    let path = safe_path(root, path)?;
    if content.len() > MAX_READ { return Err(format!("写入内容超过 {} KB", MAX_READ / 1000)); }
    let parent = path.parent().ok_or("文件没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| format!("建不了目录：{e}"))?;
    fs::write(&path, content).map_err(|e| format!("写不了文件：{e}"))?;
    Ok(format!("已写入 {}（{} 字节）", relative(root, &path), content.len()))
}

fn search_files(root: &Path, query: &str, start: &str) -> Result<String, String> {
    if query.is_empty() { return Err("搜索词不能为空".into()); }
    let files = list_files(root, start)?;
    let mut hits = Vec::new();
    for rel in files.lines().filter(|p| !p.ends_with('/')) {
        let Ok(text) = read_file(root, rel) else { continue };
        for (line_no, line) in text.lines().enumerate() {
            if line.contains(query) {
                hits.push(format!("{rel}:{}: {}", line_no + 1, line.trim()));
                if hits.len() >= 120 { return Ok(hits.join("\n")); }
            }
        }
    }
    Ok(if hits.is_empty() { "没有找到".into() } else { hits.join("\n") })
}

fn tools() -> Value {
    json!([
      {"type":"function","function":{"name":"list_files","description":"递归列出当前工作区文件","parameters":{"type":"object","properties":{"path":{"type":"string","description":"工作区相对目录，根目录用空字符串"}},"required":["path"]}}},
      {"type":"function","function":{"name":"read_file","description":"读取工作区内一个 UTF-8 文本文件","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
      {"type":"function","function":{"name":"write_file","description":"创建或完整覆写工作区内一个文本文件","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}},
      {"type":"function","function":{"name":"search_files","description":"在工作区文本文件中搜索字符串","parameters":{"type":"object","properties":{"query":{"type":"string"},"path":{"type":"string","description":"工作区相对目录，根目录用空字符串"}},"required":["query","path"]}}}
    ])
}

fn run_tool(root: &Path, name: &str, args: &Value) -> Result<String, String> {
    let string = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let result = match name {
        "list_files" => list_files(root, string("path")),
        "read_file" => read_file(root, string("path")),
        "write_file" => write_file(root, string("path"), string("content")),
        "search_files" => search_files(root, string("query"), string("path")),
        _ => Err(format!("未知工具：{name}")),
    }?;
    Ok(result.chars().take(MAX_RESULT).collect())
}

#[tauri::command]
pub async fn agent_api_run(
    app: AppHandle,
    dir: String,
    active_id: String,
    prompt: String,
    history: Vec<ApiHistory>,
) -> Result<ApiRunResult, String> {
    let root = PathBuf::from(&dir).canonicalize().map_err(|e| format!("工作区不可用：{e}"))?;
    let mut messages = vec![json!({
        "role": "system",
        "content": format!(
            "你是空核编辑器内置 Agent。用中文简洁协作。你可以通过工具在当前工作区读写文件，禁止猜测文件内容，修改前先读取。当前文章：{}。完成实际修改后再汇报改了什么。",
            if active_id.is_empty() { "未选择" } else { &active_id }
        )
    })];
    for item in history.into_iter().rev().take(16).collect::<Vec<_>>().into_iter().rev() {
        if item.role == "user" || item.role == "assistant" {
            messages.push(json!({"role": item.role, "content": item.content}));
        }
    }
    messages.push(json!({"role":"user","content":prompt}));
    let mut beats = Vec::new();

    for _ in 0..MAX_ROUNDS {
        // Do not send tool_choice explicitly. OpenAI-compatible services default
        // to automatic tool selection, while DeepSeek thinking models reject
        // the parameter even though they can still consume tool definitions.
        let body = json!({"model": model(&app)?, "messages": messages.clone(), "tools": tools()});
        let response = request(&app, &body).await?;
        let message = response.pointer("/choices/0/message").cloned()
            .ok_or_else(|| "API 响应里没有 choices[0].message".to_string())?;
        let calls = message.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
        messages.push(message.clone());
        if calls.is_empty() {
            let reply = message.get("content").and_then(Value::as_str).unwrap_or("").trim().to_string();
            return Ok(ApiRunResult { reply: if reply.is_empty() { "已完成。".into() } else { reply }, tools: beats });
        }
        for call in calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or("tool");
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let name = function.get("name").and_then(Value::as_str).unwrap_or("");
            let raw = function.get("arguments").and_then(Value::as_str).unwrap_or("{}");
            let args: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
            let target = args.get("path").and_then(Value::as_str)
                .or_else(|| args.get("query").and_then(Value::as_str)).unwrap_or("").to_string();
            let result = run_tool(&root, name, &args).unwrap_or_else(|e| format!("错误：{e}"));
            beats.push(ApiToolBeat { name: name.to_string(), target });
            messages.push(json!({"role":"tool","tool_call_id":id,"content":result}));
        }
    }
    Err(format!("Agent 连续调用工具超过 {MAX_ROUNDS} 轮，已停止"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_cannot_escape_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(safe_path(tmp.path(), "../secret").is_err());
        assert!(safe_path(tmp.path(), "/etc/passwd").is_err());
        assert!(safe_path(tmp.path(), "articles/a.md").is_ok());
    }

    #[test]
    fn endpoint_accepts_base_or_full_path() {
        assert_eq!(endpoint("https://api.example/v1"), "https://api.example/v1/chat/completions");
        assert_eq!(endpoint("https://api.example/v1/chat/completions"), "https://api.example/v1/chat/completions");
    }
}
