//! Signed Cloudinary image uploads. Credentials stay in application config;
//! the frontend only supplies image bytes and a public id.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::config;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudinaryUpload {
    secure_url: String,
    public_id: String,
    format: String,
    width: u64,
    height: u64,
    bytes: u64,
}

fn required(app: &AppHandle, key: &str, label: &str) -> Result<String, String> {
    config::get(app, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("请先在设置里填写 {label}"))
}

fn credentials(app: &AppHandle) -> Result<(String, String, String), String> {
    Ok((
        required(app, "cloudinary.cloudName", "Cloud Name")?,
        required(app, "cloudinary.apiKey", "Cloudinary API Key")?,
        required(app, "cloudinary.apiSecret", "Cloudinary API Secret")?,
    ))
}

fn signature(params: &str, secret: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(params.as_bytes());
    hasher.update(secret.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn decode_data_url(data_url: &str) -> Result<(Vec<u8>, String), String> {
    let (header, encoded) = data_url.split_once(',').ok_or("图片数据格式不对")?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("只支持 base64 图片数据".into());
    }
    let mime = header.trim_start_matches("data:").trim_end_matches(";base64").to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "图片 base64 解码失败")?;
    if bytes.len() > 10 * 1024 * 1024 { return Err("图片超过 10MB，上传前请先压缩".into()); }
    Ok((bytes, mime))
}

#[tauri::command]
pub async fn cloudinary_test(app: AppHandle) -> Result<String, String> {
    let (cloud, key, secret) = credentials(&app)?;
    let url = format!("https://api.cloudinary.com/v1_1/{cloud}/resources/image/upload?max_results=1");
    let response = reqwest::Client::new().get(url).basic_auth(key, Some(secret)).send().await
        .map_err(|e| format!("连不上 Cloudinary：{e}"))?;
    if response.status().is_success() { Ok("Cloudinary 连接正常".into()) }
    else { Err(format!("Cloudinary 凭据无效（HTTP {}）", response.status())) }
}

#[tauri::command]
pub async fn cloudinary_upload(
    app: AppHandle,
    data_url: String,
    filename: String,
    public_id: String,
    folder: String,
) -> Result<CloudinaryUpload, String> {
    let (cloud, key, secret) = credentials(&app)?;
    let (bytes, mime) = decode_data_url(&data_url)?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let folder = folder.trim_matches('/');
    let params = if folder.is_empty() {
        format!("public_id={public_id}&timestamp={timestamp}")
    } else {
        format!("folder={folder}&public_id={public_id}&timestamp={timestamp}")
    };
    let sig = signature(&params, &secret);
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename).mime_str(&mime)
        .map_err(|e| format!("图片类型不支持：{e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("api_key", key)
        .text("timestamp", timestamp.to_string())
        .text("public_id", public_id)
        .text("signature", sig);
    if !folder.is_empty() { form = form.text("folder", folder.to_string()); }
    let url = format!("https://api.cloudinary.com/v1_1/{cloud}/image/upload");
    let response = reqwest::Client::new().post(url).multipart(form).send().await
        .map_err(|e| format!("上传失败：{e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("Cloudinary 响应无法读取：{e}"))?;
    if !status.is_success() {
        let message = value.pointer("/error/message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(format!("Cloudinary 上传失败：{message}"));
    }
    Ok(CloudinaryUpload {
        secure_url: value.get("secure_url").and_then(Value::as_str).unwrap_or("").to_string(),
        public_id: value.get("public_id").and_then(Value::as_str).unwrap_or("").to_string(),
        format: value.get("format").and_then(Value::as_str).unwrap_or("").to_string(),
        width: value.get("width").and_then(Value::as_u64).unwrap_or(0),
        height: value.get("height").and_then(Value::as_u64).unwrap_or(0),
        bytes: value.get("bytes").and_then(Value::as_u64).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloudinary_signature_matches_documented_algorithm() {
        assert_eq!(signature("public_id=sample_image&timestamp=1315060510", "abcd"), "b4ad47fb4e25c7bf5f92a20089f9db59bc302313");
    }
    #[test]
    fn refuses_non_image_data() {
        assert!(decode_data_url("data:text/plain;base64,SGk=").is_err());
    }
}
