//! Command boundaries for vault mutations. Keep the permit for the entire operation.
use tauri::{AppHandle, Manager};
use crate::vault::{self, DraftDto, WriteResult};

#[tauri::command]
pub fn draft_write(app: AppHandle, dir: String, id: String, content: String, base_updated_at: f64) -> Result<WriteResult, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::draft_write(dir, id, content, base_updated_at)
}
#[tauri::command]
pub fn draft_create(app: AppHandle, dir: String, parent: String, name: String, content: String) -> Result<DraftDto, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::draft_create(dir, parent, name, content)
}
#[tauri::command]
pub fn dir_create(app: AppHandle, dir: String, parent: String, name: String) -> Result<String, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::dir_create(dir, parent, name)
}
#[tauri::command]
pub fn entry_rename(app: AppHandle, dir: String, path: String, name: String) -> Result<String, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::entry_rename(dir, path, name)
}
#[tauri::command]
pub fn entry_move(app: AppHandle, dir: String, path: String, to_parent: String) -> Result<String, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::entry_move(dir, path, to_parent)
}
#[tauri::command]
pub fn entry_delete(app: AppHandle, dir: String, path: String) -> Result<bool, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::entry_delete(dir, path)
}
#[tauri::command]
pub fn image_write(app: AppHandle, dir: String, name: String, data_url: String) -> Result<String, String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::image_write(dir, name, data_url)
}
#[tauri::command]
pub fn image_delete(app: AppHandle, dir: String, path: String) -> Result<(), String> {
    let _permit = app.state::<crate::write_gate::WriteGate>().write()?;
    vault::image_delete(dir, path)
}
