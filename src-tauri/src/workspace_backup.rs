//! Manual workspace-only backup. This is not a unified backup or a sync service.
//!
//! The unified archive in `unified_backup` supersedes the commands below, so
//! only its path and hashing primitives are still called from the app. The rest
//! stays because `planner_backup` and the integration test still exercise it.
#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};

const MANIFEST: &str = "manifest.json";
const DATA: &str = "workspace";
const MAX_DEPTH: usize = 64;
const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: u64 = 10 * 1024 * 1024 * 1024;


#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub(crate) version: u32,
    pub(crate) scope: String,
    pub(crate) entries: Vec<Entry>,
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

fn err(e: impl std::fmt::Display) -> String { e.to_string() }

// Only portable UTF-8 paths are accepted; backslashes and colons are forbidden
// even on Unix, so a manifest cannot acquire new meaning on Windows.
pub(crate) fn component(name: &std::ffi::OsStr) -> Result<&str, String> {
    let s = name.to_str().ok_or("Non-UTF-8 workspace name")?;
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if s.is_empty() || s == "." || s == ".." || s.ends_with([' ', '.']) || reserved
        || s.chars().any(|c| c <= '\u{1f}' || matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*')) {
        return Err("Unsafe workspace name".into());
    }
    Ok(s)
}

fn scan(root: &Path, rel: &Path, entries: &mut Vec<Entry>) -> Result<(), String> {
    if rel.components().count() > MAX_DEPTH { return Err("Workspace nesting limit exceeded".into()); }
    let mut children = fs::read_dir(root.join(rel)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    children.sort_by_key(|e| e.file_name());
    for child in children {
        if entries.len() >= MAX_ENTRIES { return Err("Workspace entry limit exceeded".into()); }
        let name = child.file_name();
        component(&name)?;
        let path = rel.join(&name);
        let portable = path.iter().map(component).collect::<Result<Vec<_>, _>>()?.join("/");
        let meta = fs::symlink_metadata(child.path()).map_err(err)?;
        #[cfg(windows)]
        { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return Err(format!("Reparse point rejected: {}", portable)); } }
        let ty = meta.file_type();
        if ty.is_dir() {
            entries.push(Entry { path: portable, kind: "directory".into(), size: 0, sha256: String::new() });
            scan(root, &path, entries)?;
        } else if ty.is_file() {
            let mut file = open_regular(&child.path())?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            let mut buf = [0u8; 8192];
            loop {
                let n = file.read(&mut buf).map_err(err)?;
                if n == 0 { break; }
                size = size.checked_add(n as u64).ok_or("File too large")?;
                if size > MAX_BYTES { return Err("Workspace size limit exceeded".into()); }
                hash.update(&buf[..n]);
            }
            let total = entries.iter().try_fold(size, |n, e| n.checked_add(e.size)).ok_or("Workspace size limit exceeded")?;
            if total > MAX_BYTES { return Err("Workspace size limit exceeded".into()); }
            entries.push(Entry { path: portable, kind: "file".into(), size, sha256: format!("{:x}", hash.finalize()) });
        } else {
            return Err(format!("Symlink or unsupported file in workspace: {}", portable));
        }
    }
    Ok(())
}
pub(crate) fn snapshot(root: &Path) -> Result<Manifest, String> {
    let metadata = fs::symlink_metadata(root).map_err(err)?;
    if !metadata.file_type().is_dir() { return Err("Expected a real directory, not a symlink".into()); }
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("Reparse point rejected".into()); } }
    let mut entries = Vec::new();
    scan(root, Path::new(""), &mut entries)?;
    let total = entries.iter().try_fold(0u64, |n, e| n.checked_add(e.size)).ok_or("Workspace size limit exceeded")?;
    if total > MAX_BYTES { return Err("Workspace size limit exceeded".into()); }
    Ok(Manifest { version: 1, scope: "workspace-only".into(), entries })
}
#[derive(Debug)]
pub(crate) struct Stage { pub(crate) path: PathBuf, pub(crate) target: PathBuf, pub(crate) published: bool }
impl Drop for Stage { fn drop(&mut self) { if !self.published { let _ = fs::remove_dir_all(&self.path); } } }
pub(crate) fn create_destination(source: &Path, destination: &Path) -> Result<Stage, String> {
    let source = fs::canonicalize(source).map_err(err)?;
    let name = destination.file_name().ok_or("Destination must have a directory name")?;
    component(name)?;
    let parent = fs::canonicalize(destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."))).map_err(err)?;
    if parent.starts_with(&source) { return Err("Destination cannot be inside source".into()); }
    let target = parent.join(name);
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    for _ in 0..1000 {
        let path = parent.join(format!(".workspace-backup-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        match builder.create(&path) {
            Ok(()) => return Ok(Stage { path, target, published: false }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(err(e)),
        }
    }
    Err("Could not create staging directory".into())
}

// Rename with explicit no-replace semantics; unsupported platforms fail closed.
pub(crate) fn publish(stage: &mut Stage) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(stage.path.as_os_str().as_bytes()).map_err(err)?;
        let to = CString::new(stage.target.as_os_str().as_bytes()).map_err(err)?;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        unsafe { extern "C" { fn renameat2(olddir: i32, old: *const i8, newdir: i32, new: *const i8, flags: u32) -> i32; }
            if renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) != 0 { return Err(err(std::io::Error::last_os_error())); } }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        unsafe { extern "C" { fn renamex_np(old: *const i8, new: *const i8, flags: u32) -> i32; }
            if renamex_np(from.as_ptr(), to.as_ptr(), 4) != 0 { return Err(err(std::io::Error::last_os_error())); } }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn MoveFileW(from: *const u16, to: *const u16) -> i32; }
        let from: Vec<u16> = stage.path.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = stage.target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 { return Err(err(std::io::Error::last_os_error())); }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios")))]
    { return Err("Atomic no-overwrite publication unsupported on this platform".into()); }
    stage.published = true;
    // A failure here means publication succeeded but crash durability is uncertain.
    sync_dir(stage.target.parent().ok_or("Missing destination parent")?)
        .map_err(|e| format!("Backup published, but destination directory sync failed: {e}"))
}

pub(crate) fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)] { fs::File::open(path).and_then(|f| f.sync_all()).map_err(err) }
    #[cfg(not(unix))] { let _ = path; Ok(()) }
}

// Do not follow a final-component symlink even if it is swapped after inspection.
pub(crate) fn open_regular(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(0x100); }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(0x20000 | 0x800); }
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000); }
    let file = options.open(path).map_err(err)?;
    let metadata = file.metadata().map_err(err)?;
    if !metadata.file_type().is_file() { return Err("Expected a regular file".into()); }
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("Reparse point rejected".into()); } }
    Ok(file)
}
pub(crate) fn private_file(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    options.open(path).map_err(err)
}
pub(crate) fn copy_entries(source: &Path, target: &Path, manifest: &Manifest) -> Result<(), String> {
    for entry in &manifest.entries {
        // Paths come from a freshly scanned tree, never directly from an untrusted manifest.
        let path = Path::new(&entry.path);
        let from = source.join(path);
        let to = target.join(path);
        let ty = fs::symlink_metadata(&from).map_err(err)?.file_type();
        if entry.kind == "directory" && ty.is_dir() { fs::create_dir(&to).map_err(err)?; }
        else if entry.kind == "file" && ty.is_file() {
            let mut input = open_regular(&from)?;
            let mut output = private_file(&to)?;
            let copied = std::io::copy(&mut Read::by_ref(&mut input).take(entry.size + 1), &mut output).map_err(err)?;
            if copied != entry.size { return Err("Source changed during copy".into()); }
            output.sync_all().map_err(err)?;
        } else { return Err("Source changed or contains a symlink".into()); }
    }
    // Flush child directories before their parents, including empty ones.
    for entry in manifest.entries.iter().rev().filter(|e| e.kind == "directory") {
        sync_dir(&target.join(&entry.path))?;
    }
    sync_dir(target)?;
    if snapshot(target)? != *manifest { return Err("Copied data failed integrity verification".into()); }
    if snapshot(source)? != *manifest { return Err("Source changed during copy".into()); }
    Ok(())
}
pub(crate) fn export(source: &Path, destination: &Path) -> Result<(), String> {
    let manifest = snapshot(source)?;
    let mut dest = create_destination(source, destination)?;
    let data = dest.path.join(DATA);
    fs::create_dir(&data).map_err(err)?;
    copy_entries(source, &data, &manifest)?;
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(err)?;
    let mut file = private_file(&dest.path.join(MANIFEST))?;
    file.write_all(&bytes).map_err(err)?;
    file.sync_all().map_err(err)?;
    sync_dir(&dest.path)?;
    publish(&mut dest)
}
pub(crate) fn import(backup: &Path, destination: &Path) -> Result<(), String> {
    if !fs::symlink_metadata(backup).map_err(err)?.file_type().is_dir() { return Err("Backup must be a real directory".into()); }
    let manifest_path = backup.join(MANIFEST);
    let metadata = fs::symlink_metadata(&manifest_path).map_err(err)?;
    if !metadata.file_type().is_file() || metadata.len() > 16 * 1024 * 1024 { return Err("Invalid manifest file".into()); }
    let mut bytes = Vec::new();
    open_regular(&manifest_path)?.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() > 16 * 1024 * 1024 { return Err("Invalid manifest file".into()); }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(err)?;
    if manifest.version != 1 || manifest.scope != "workspace-only" { return Err("Unsupported backup version or scope".into()); }
    let data = backup.join(DATA);
    let actual = snapshot(&data)?;
    if actual != manifest { return Err("Backup integrity verification failed".into()); }
    // Reject destinations inside the whole backup, not only the data directory.
    let mut dest = create_destination(backup, destination)?;
    copy_entries(&data, &dest.path, &actual)?;
    publish(&mut dest)
}

#[tauri::command]
pub fn workspace_backup_export(workspace: String, destination: String) -> Result<(), String> {
    export(Path::new(&workspace), Path::new(&destination))
}
#[tauri::command]
pub fn workspace_backup_import(backup: String, destination: String) -> Result<(), String> {
    import(Path::new(&backup), Path::new(&destination))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_no_overwrite() {
        let t = tempfile::tempdir().unwrap(); let root = t.path();
        let src = root.join("src"); fs::create_dir(&src).unwrap();
        fs::create_dir(src.join("empty")).unwrap(); fs::write(src.join("文.md"), b"hello").unwrap();
        let backup = root.join("backup"); let restored = root.join("restored");
        export(&src, &backup).unwrap(); import(&backup, &restored).unwrap();
        assert_eq!(snapshot(&src).unwrap(), snapshot(&restored).unwrap());
        assert!(export(&src, &backup).is_err()); assert!(import(&backup, &restored).is_err());
        assert!(export(&src, &src.join("nested")).is_err());
    }
    #[test]
    fn rejects_corruption_and_untrusted_manifest() {
        let t = tempfile::tempdir().unwrap(); let root = t.path();
        let src = root.join("src"); fs::create_dir(&src).unwrap(); fs::write(src.join("a"), b"a").unwrap();
        let backup = root.join("backup"); export(&src, &backup).unwrap();
        fs::write(backup.join(DATA).join("a"), b"b").unwrap();
        assert!(import(&backup, &root.join("out")).is_err()); assert!(!root.join("out").exists());
        fs::write(backup.join(MANIFEST), r#"{"version":1,"scope":"workspace-only","entries":[{"path":"../escape","kind":"file","size":1,"sha256":"x"}]}"#).unwrap();
        assert!(import(&backup, &root.join("out")).is_err());
    }
    #[test]
    fn failed_publish_cleans_stage_and_preserves_destination() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src"); fs::create_dir(&src).unwrap();
        fs::write(src.join("a"), b"data").unwrap();
        let dest = t.path().join("dest"); fs::create_dir(&dest).unwrap();
        fs::write(dest.join("keep"), b"keep").unwrap();
        assert!(export(&src, &dest).is_err());
        assert_eq!(fs::read(dest.join("keep")).unwrap(), b"keep");
        assert!(!fs::read_dir(t.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".workspace-backup-")));
    }
    #[test]
    fn rejects_nonportable_names() {
        for name in ["CON", "lpt1.txt", "trailing.", "x ", "a?b", "a\u{1f}b"] {
            assert!(component(std::ffi::OsStr::new(name)).is_err(), "{name}");
        }
        assert!(component(std::ffi::OsStr::new("文.md")).is_ok());
    }
    #[test]
    fn rejects_excessive_depth() {
        let t = tempfile::tempdir().unwrap();
        let mut dir = t.path().join("src"); fs::create_dir(&dir).unwrap();
        for _ in 0..=MAX_DEPTH { dir.push("d"); fs::create_dir(&dir).unwrap(); }
        assert!(export(&t.path().join("src"), &t.path().join("out")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        let t = tempfile::tempdir().unwrap(); let src = t.path().join("src"); fs::create_dir(&src).unwrap();
        std::os::unix::fs::symlink("/etc", src.join("link")).unwrap();
        assert!(export(&src, &t.path().join("out")).is_err());
    }
}
