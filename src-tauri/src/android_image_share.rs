//! Android image share sheet and gallery save.
//!
//! The webview sends compressed image bytes as the invoke body. This module
//! checks the shared budget, writes one private cache file, and asks the
//! Android plugin to open the chooser or publish to MediaStore. The plugin
//! receives a path and metadata, never a second copy of the image bytes.
//! Non-Android builds register the same commands and return `unavailable`
//! before decoding the body or touching the disk.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "android")]
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};

const CODE_UNAVAILABLE: &str = "unavailable";
const CODE_IO: &str = "io";
const CODE_PERMISSION: &str = "permission";

/// Per-command ceiling for these two image commands. Book import keeps its own limit.
pub(crate) const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SHARE_TEXT_BYTES: usize = 64 * 1024;
const COPY_CHUNK: usize = 64 * 1024;
const REQUEST_ID_LEN: usize = 32;
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
#[cfg(target_os = "android")]
const IMAGE_SHARE_DIR: &str = "image-share";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageOp {
    Share,
    Save,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ImageMeta {
    mime: &'static str,
    filename: String,
    text: Option<String>,
}

#[derive(Debug)]
struct StagedImage {
    share_root: PathBuf,
    id: String,
    file: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheDisposition {
    KeepUntilExpiry,
    RemoveNow,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct PluginBody {
    ok: bool,
    #[serde(default, rename = "errorCode")]
    error_code: Option<String>,
    #[serde(default)]
    uri: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum PluginCall {
    ShareOpened,
    Saved(String),
    Failed(&'static str),
    Ambiguous,
}

#[derive(Debug, Serialize)]
pub struct GalleryUri {
    pub uri: String,
}

fn external_code(code: &str) -> &'static str {
    match code {
        CODE_PERMISSION => CODE_PERMISSION,
        CODE_UNAVAILABLE => CODE_UNAVAILABLE,
        CODE_IO => CODE_IO,
        _ => CODE_IO,
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Percent-decode UTF-8 the way `encodeURIComponent` encodes it.
/// A literal `+` stays `+`. Incomplete or non-UTF-8 sequences fail.
fn percent_decode_strict(input: &str) -> Result<String, &'static str> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(CODE_IO);
            }
            let high = hex_value(bytes[index + 1]).ok_or(CODE_IO)?;
            let low = hex_value(bytes[index + 2]).ok_or(CODE_IO)?;
            out.push((high << 4) | low);
            index += 3;
            continue;
        }
        let ch = input[index..].chars().next().ok_or(CODE_IO)?;
        let mut buf = [0u8; 4];
        let encoded = ch.encode_utf8(&mut buf);
        out.extend_from_slice(encoded.as_bytes());
        index += encoded.len();
    }
    String::from_utf8(out).map_err(|_| CODE_IO)
}

fn image_len_allowed(len: usize, max_bytes: usize) -> Result<(), &'static str> {
    if len == 0 || len > max_bytes {
        Err(CODE_IO)
    } else {
        Ok(())
    }
}

fn json_declared_len(value: &serde_json::Value) -> Option<usize> {
    value.as_array().map(Vec::len)
}

/// Raw invoke bodies ignore `decode_request_bytes`' `max_bytes`, so both shapes
/// pass through this check. JSON arrays that declare a larger length are
/// rejected before the Android decoder allocates them.
fn take_image_bytes(body: &InvokeBody, max_bytes: usize) -> Result<Vec<u8>, &'static str> {
    if let InvokeBody::Json(value) = body {
        if json_declared_len(value).is_some_and(|len| len > max_bytes) {
            return Err(CODE_IO);
        }
    }
    if let InvokeBody::Raw(bytes) = body {
        image_len_allowed(bytes.len(), max_bytes)?;
        return Ok(bytes.clone());
    }
    let decoded = crate::ipc_bytes::decode_request_bytes(body, Some(max_bytes), CODE_IO)
        .map_err(|_| CODE_IO)?;
    image_len_allowed(decoded.len(), max_bytes)?;
    Ok(decoded.into_owned())
}

fn mime_and_extension(header: Option<&str>) -> Result<(&'static str, &'static str), &'static str> {
    let mime = match header {
        None => "image/png",
        Some(value) => {
            let decoded = percent_decode_strict(value)?;
            match decoded.trim().to_ascii_lowercase().as_str() {
                "image/png" => "image/png",
                "image/jpeg" => "image/jpeg",
                "image/webp" => "image/webp",
                "image/gif" => "image/gif",
                _ => return Err(CODE_IO),
            }
        }
    };
    let extension = match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        _ => return Err(CODE_IO),
    };
    Ok((mime, extension))
}

fn is_single_file_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.chars().any(char::is_control) {
        return false;
    }
    let mut parts = Path::new(name).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(part)), None) => part.to_str() == Some(name),
        _ => false,
    }
}

fn limit_name(stem: &str, extension: &str) -> Result<String, &'static str> {
    const MAX_NAME_BYTES: usize = 200;
    if stem.len() + extension.len() <= MAX_NAME_BYTES {
        let mut name = String::with_capacity(stem.len() + extension.len());
        name.push_str(stem);
        name.push_str(extension);
        return if is_single_file_name(&name) {
            Ok(name)
        } else {
            Err(CODE_IO)
        };
    }
    let budget = MAX_NAME_BYTES.saturating_sub(extension.len());
    let mut end = budget.min(stem.len());
    while end > 0 && !stem.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return Err(CODE_IO);
    }
    let mut name = String::with_capacity(end + extension.len());
    name.push_str(&stem[..end]);
    name.push_str(extension);
    if is_single_file_name(&name) {
        Ok(name)
    } else {
        Err(CODE_IO)
    }
}

fn safe_filename(decoded: &str, extension: &str) -> Result<String, &'static str> {
    let without_controls: String = decoded.chars().filter(|ch| !ch.is_control()).collect();
    let segment = without_controls
        .rsplit(|ch| ch == '/' || ch == '\\')
        .find(|part| !part.is_empty())
        .unwrap_or("");
    let trimmed = segment.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(CODE_IO);
    }
    let lower = trimmed.to_ascii_lowercase();
    const KNOWN: &[&str] = &[".jpeg", ".jfif", ".jpe", ".jpg", ".png", ".webp", ".gif"];
    let mut stem = trimmed;
    for suffix in KNOWN {
        if lower.ends_with(suffix) {
            stem = &trimmed[..trimmed.len() - suffix.len()];
            break;
        }
    }
    let stem = stem.trim().trim_end_matches('.').trim();
    if stem.is_empty() || stem == "." || stem == ".." {
        return Err(CODE_IO);
    }
    limit_name(stem, extension)
}

fn decode_share_text(header: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(header) = header.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let text = percent_decode_strict(header)?;
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() > MAX_SHARE_TEXT_BYTES {
        return Err(CODE_IO);
    }
    Ok(Some(text))
}

fn prepare_headers(
    filename: Option<&str>,
    mime: Option<&str>,
    text: Option<&str>,
    op: ImageOp,
) -> Result<ImageMeta, &'static str> {
    let filename_header = filename.ok_or(CODE_IO)?;
    let decoded_name = percent_decode_strict(filename_header)?;
    let (mime, extension) = mime_and_extension(mime)?;
    let filename = safe_filename(&decoded_name, extension)?;
    let text = match op {
        ImageOp::Share => decode_share_text(text)?,
        ImageOp::Save => None,
    };
    Ok(ImageMeta {
        mime,
        filename,
        text,
    })
}

#[cfg(target_os = "android")]
fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<Option<&'a str>, &'static str> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(value) => value.to_str().map(Some).map_err(|_| CODE_IO),
    }
}

#[cfg(target_os = "android")]
fn prepare_request(
    request: &Request<'_>,
    op: ImageOp,
) -> Result<(ImageMeta, Vec<u8>), &'static str> {
    let filename = header(request, "x-share-filename")?;
    let mime = header(request, "x-share-mime")?;
    let text = match op {
        ImageOp::Share => header(request, "x-share-text")?,
        ImageOp::Save => None,
    };
    let meta = prepare_headers(filename, mime, text, op)?;
    let bytes = take_image_bytes(request.body(), MAX_IMAGE_BYTES)?;
    Ok((meta, bytes))
}

fn is_request_id(name: &str) -> bool {
    name.len() == REQUEST_ID_LEN
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(target_os = "android")]
fn new_request_id() -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| CODE_IO)?;
    let mut id = String::with_capacity(REQUEST_ID_LEN);
    for byte in bytes {
        id.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
        id.push(char::from(b"0123456789abcdef"[(byte & 0x0f) as usize]));
    }
    Ok(id)
}

fn file_in_request_dir(dir: &Path, filename: &str) -> Result<PathBuf, &'static str> {
    if !is_single_file_name(filename) {
        return Err(CODE_IO);
    }
    let file = dir.join(filename);
    match file.parent() {
        Some(parent) if parent == dir => Ok(file),
        _ => Err(CODE_IO),
    }
}

fn write_exclusive(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| CODE_IO)?;
    let mut offset = 0;
    while offset < bytes.len() {
        let end = (offset + COPY_CHUNK).min(bytes.len());
        file.write_all(&bytes[offset..end]).map_err(|_| CODE_IO)?;
        offset = end;
    }
    file.sync_all().map_err(|_| CODE_IO)?;
    Ok(())
}

fn ensure_regular_file_inside(
    share_root: &Path,
    request_dir: &Path,
    file: &Path,
) -> Result<(), &'static str> {
    let root = share_root.canonicalize().map_err(|_| CODE_IO)?;
    let dir = request_dir.canonicalize().map_err(|_| CODE_IO)?;
    let meta = fs::symlink_metadata(file).map_err(|_| CODE_IO)?;
    if !meta.file_type().is_file() {
        return Err(CODE_IO);
    }
    let canonical = file.canonicalize().map_err(|_| CODE_IO)?;
    if dir.parent() != Some(root.as_path()) || canonical.parent() != Some(dir.as_path()) {
        return Err(CODE_IO);
    }
    Ok(())
}

fn is_stale(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age > STALE_AFTER)
}

/// Removes one request directory this module created. Symlinks are unlinked
/// and never followed. Paths outside `share_root` are left untouched.
fn remove_owned_request(share_root: &Path, id: &str) -> Result<(), &'static str> {
    if !is_request_id(id) {
        return Err(CODE_IO);
    }
    let root = match share_root.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(CODE_IO),
    };
    let dir = share_root.join(id);
    let meta = match fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(CODE_IO),
    };
    if meta.file_type().is_symlink() {
        let parent = dir
            .parent()
            .ok_or(CODE_IO)?
            .canonicalize()
            .map_err(|_| CODE_IO)?;
        if parent != root {
            return Err(CODE_IO);
        }
        fs::remove_file(&dir).map_err(|_| CODE_IO)?;
        return Ok(());
    }
    if !meta.is_dir() {
        return Err(CODE_IO);
    }
    let canonical = dir.canonicalize().map_err(|_| CODE_IO)?;
    if canonical.parent() != Some(root.as_path()) {
        return Err(CODE_IO);
    }
    fs::remove_dir_all(&canonical).map_err(|_| CODE_IO)
}

fn prune_stale_requests(share_root: &Path, active: &HashSet<String>, now: SystemTime) {
    let Ok(root) = share_root.canonicalize() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_request_id(&name) || active.contains(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() && !meta.file_type().is_symlink() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if !is_stale(modified, now) {
            continue;
        }
        let _ = remove_owned_request(&root, &name);
    }
}

fn stage_image(
    share_root: &Path,
    id: &str,
    bytes: &[u8],
    filename: &str,
    active: &HashSet<String>,
) -> Result<StagedImage, &'static str> {
    image_len_allowed(bytes.len(), MAX_IMAGE_BYTES)?;
    if !is_request_id(id) {
        return Err(CODE_IO);
    }
    fs::create_dir_all(share_root).map_err(|_| CODE_IO)?;
    let dir = share_root.join(id);
    // A pre-existing directory or symlink is not this request. Never write into it.
    if fs::create_dir(&dir).is_err() {
        return Err(CODE_IO);
    }
    let mut active = active.clone();
    active.insert(id.to_string());
    prune_stale_requests(share_root, &active, SystemTime::now());
    let file = match file_in_request_dir(&dir, filename) {
        Ok(file) => file,
        Err(code) => {
            let _ = remove_owned_request(share_root, id);
            return Err(code);
        }
    };
    if let Err(code) = write_exclusive(&file, bytes) {
        let _ = remove_owned_request(share_root, id);
        return Err(code);
    }
    if let Err(code) = ensure_regular_file_inside(share_root, &dir, &file) {
        let _ = remove_owned_request(share_root, id);
        return Err(code);
    }
    Ok(StagedImage {
        share_root: share_root.to_path_buf(),
        id: id.to_string(),
        file,
    })
}

fn settle_cache(staged: &StagedImage, disposition: CacheDisposition) -> Result<(), &'static str> {
    match disposition {
        CacheDisposition::KeepUntilExpiry => Ok(()),
        CacheDisposition::RemoveNow => remove_owned_request(&staged.share_root, &staged.id),
    }
}

fn interpret(op: ImageOp, result: Result<PluginBody, ()>) -> PluginCall {
    let body = match result {
        Ok(body) => body,
        Err(()) => return PluginCall::Ambiguous,
    };
    if !body.ok {
        return PluginCall::Failed(external_code(body.error_code.as_deref().unwrap_or(CODE_IO)));
    }
    match op {
        ImageOp::Share => PluginCall::ShareOpened,
        ImageOp::Save => match body.uri.as_deref() {
            Some(uri) if uri.starts_with("content://") && !uri.contains('\0') => {
                PluginCall::Saved(uri.to_string())
            }
            _ => PluginCall::Failed(CODE_IO),
        },
    }
}

fn disposition(call: &PluginCall) -> CacheDisposition {
    match call {
        PluginCall::ShareOpened | PluginCall::Ambiguous => CacheDisposition::KeepUntilExpiry,
        PluginCall::Saved(_) | PluginCall::Failed(_) => CacheDisposition::RemoveNow,
    }
}

#[cfg(target_os = "android")]
fn active_ids() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
    &ACTIVE
}

#[cfg(target_os = "android")]
struct ActiveGuard(String);

#[cfg(target_os = "android")]
impl ActiveGuard {
    fn register(id: &str) -> Self {
        active_ids()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.to_string());
        Self(id.to_string())
    }
}

#[cfg(target_os = "android")]
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        active_ids()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.0);
    }
}

#[cfg(target_os = "android")]
fn active_snapshot() -> HashSet<String> {
    active_ids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(target_os = "android")]
fn stage_for_command(
    cache_dir: &Path,
    meta: &ImageMeta,
    bytes: &[u8],
) -> Result<(StagedImage, ActiveGuard), &'static str> {
    let share_root = cache_dir.join(IMAGE_SHARE_DIR);
    fs::create_dir_all(&share_root).map_err(|_| CODE_IO)?;
    let mut staged = Err(CODE_IO);
    let mut guard = None;
    for _ in 0..8 {
        let id = new_request_id()?;
        let registered = ActiveGuard::register(&id);
        let active = active_snapshot();
        match stage_image(&share_root, &id, bytes, &meta.filename, &active) {
            Ok(image) => {
                staged = Ok(image);
                guard = Some(registered);
                break;
            }
            Err(code) => {
                drop(registered);
                if code != CODE_IO {
                    return Err(code);
                }
                staged = Err(code);
            }
        }
    }
    Ok((staged?, guard.ok_or(CODE_IO)?))
}

#[cfg(target_os = "android")]
fn finish_command(staged: &StagedImage, call: PluginCall) -> Result<Option<String>, &'static str> {
    let _ = settle_cache(staged, disposition(&call));
    match call {
        PluginCall::ShareOpened => Ok(None),
        PluginCall::Saved(uri) => Ok(Some(uri)),
        PluginCall::Failed(code) => Err(code),
        PluginCall::Ambiguous => Err(CODE_IO),
    }
}

#[tauri::command]
pub async fn share_image(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    run_image_command(app, request, ImageOp::Share)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn save_image_to_gallery(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<GalleryUri, String> {
    match run_image_command(app, request, ImageOp::Save).await? {
        Some(uri) => Ok(GalleryUri { uri }),
        None => Err(CODE_IO.to_string()),
    }
}

async fn run_image_command(
    app: tauri::AppHandle,
    request: Request<'_>,
    op: ImageOp,
) -> Result<Option<String>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request, op);
        return Err(CODE_UNAVAILABLE.to_string());
    }
    #[cfg(target_os = "android")]
    {
        let (meta, bytes) = prepare_request(&request, op).map_err(str::to_string)?;
        tauri::async_runtime::spawn_blocking(move || perform(&app, op, meta, bytes))
            .await
            .map_err(|_| CODE_IO.to_string())?
            .map_err(str::to_string)
    }
}

#[cfg(target_os = "android")]
fn perform(
    app: &tauri::AppHandle,
    op: ImageOp,
    meta: ImageMeta,
    bytes: Vec<u8>,
) -> Result<Option<String>, &'static str> {
    use tauri::Manager;

    let cache_dir = app.path().app_cache_dir().map_err(|_| CODE_IO)?;
    let (staged, _active) = stage_for_command(&cache_dir, &meta, &bytes)?;
    let call = match android::invoke(app, op, &staged, &meta) {
        Ok(body) => interpret(op, Ok(body)),
        Err(()) => PluginCall::Ambiguous,
    };
    finish_command(&staged, call)
}

#[cfg(target_os = "android")]
mod android {
    use super::{ImageMeta, ImageOp, PluginBody, StagedImage};
    use serde::Serialize;
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidImageShare";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "ImageSharePlugin";

    #[derive(Serialize)]
    struct PluginRequest<'a> {
        path: &'a str,
        mime: &'a str,
        filename: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<&'a str>,
    }

    pub(crate) struct ImageShare<R: Runtime>(PluginHandle<R>);

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(ImageShare(handle));
                Ok(())
            })
            .build()
    }

    fn owned_cache_path(staged: &StagedImage) -> Result<String, ()> {
        let root = staged.share_root.canonicalize().map_err(|_| ())?;
        let file = staged.file.canonicalize().map_err(|_| ())?;
        let dir = file.parent().ok_or(())?;
        if dir.parent() != Some(root.as_path()) {
            return Err(());
        }
        let meta = std::fs::symlink_metadata(&file).map_err(|_| ())?;
        if !meta.file_type().is_file() {
            return Err(());
        }
        file.to_str()
            .filter(|value| !value.is_empty() && !value.contains('\0'))
            .map(str::to_string)
            .ok_or(())
    }

    pub(super) fn invoke<R: Runtime>(
        app: &AppHandle<R>,
        op: ImageOp,
        staged: &StagedImage,
        meta: &ImageMeta,
    ) -> Result<PluginBody, ()> {
        let path = owned_cache_path(staged)?;
        let payload = PluginRequest {
            path: &path,
            mime: meta.mime,
            filename: &meta.filename,
            text: meta.text.as_deref(),
        };
        let command = match op {
            ImageOp::Share => "share",
            ImageOp::Save => "save",
        };
        let plugin = app.state::<ImageShare<R>>();
        plugin
            .0
            .run_mobile_plugin::<PluginBody>(command, payload)
            .map_err(|_| ())
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;

#[cfg(test)]
mod image_share_contract {
    use super::*;
    use std::fs::File;

    fn hex_id(seed: u8) -> String {
        format!("{seed:02x}").repeat(16)
    }

    fn ago(seconds: u64) -> SystemTime {
        SystemTime::now()
            .checked_sub(Duration::from_secs(seconds))
            .expect("clock")
    }

    fn set_mtime(path: &Path, when: SystemTime) {
        let file = File::open(path).expect("open");
        file.set_modified(when).expect("mtime");
    }

    #[test]
    fn mime_suffix_and_filename_encoding() {
        let chinese =
            prepare_headers(Some("%E5%9B%BE%E7%89%87.png"), None, None, ImageOp::Share).unwrap();
        assert_eq!(chinese.mime, "image/png");
        assert_eq!(chinese.filename, "图片.png");
        assert!(chinese.text.is_none());

        let plus = prepare_headers(
            Some("a+b.png"),
            Some("image%2Fjpeg"),
            Some("hello+world"),
            ImageOp::Share,
        )
        .unwrap();
        assert_eq!(plus.mime, "image/jpeg");
        assert_eq!(plus.filename, "a+b.jpg");
        assert_eq!(plus.text.as_deref(), Some("hello+world"));

        let encoded_plus = prepare_headers(
            Some("a%2Bb.webp"),
            Some("image/webp"),
            Some("caf%C3%A9"),
            ImageOp::Share,
        )
        .unwrap();
        assert_eq!(encoded_plus.filename, "a+b.webp");
        assert_eq!(encoded_plus.text.as_deref(), Some("café"));

        let gif =
            prepare_headers(Some("动画.GIF"), Some("image/gif"), None, ImageOp::Save).unwrap();
        assert_eq!(gif.filename, "动画.gif");
        assert_eq!(gif.mime, "image/gif");

        let jpeg_suffix =
            prepare_headers(Some("photo.jpeg"), Some("image/jpeg"), None, ImageOp::Save).unwrap();
        assert_eq!(jpeg_suffix.filename, "photo.jpg");

        let card = prepare_headers(Some("SeLis-card"), None, None, ImageOp::Share).unwrap();
        assert_eq!(card.filename, "SeLis-card.png");

        let traversal =
            prepare_headers(Some("%2E%2E%2Fsecret.png"), None, None, ImageOp::Share).unwrap();
        assert_eq!(traversal.filename, "secret.png");
        assert!(!traversal.filename.contains('/'));
        assert!(prepare_headers(Some("%2e%2e"), None, None, ImageOp::Share).is_err());
        assert!(prepare_headers(Some("%2Epng"), None, None, ImageOp::Share).is_err());
    }

    #[test]
    fn invalid_encoding_mime_and_empty_name_are_io() {
        for bad in ["%", "%2", "%ZZ.png", "%E5.png", "%FF.png", "%80.png"] {
            assert_eq!(
                prepare_headers(Some(bad), None, None, ImageOp::Share).unwrap_err(),
                "io"
            );
        }
        assert!(prepare_headers(None, None, None, ImageOp::Share).is_err());
        assert!(prepare_headers(Some(""), None, None, ImageOp::Share).is_err());
        assert!(prepare_headers(Some("a.png"), Some("image/jpg"), None, ImageOp::Share).is_err());
        assert!(
            prepare_headers(Some("a.png"), Some("image/svg+xml"), None, ImageOp::Share).is_err()
        );
        assert!(prepare_headers(Some("a.png"), Some(""), None, ImageOp::Share).is_err());
        assert!(prepare_headers(Some("a.png"), None, Some("%"), ImageOp::Share).is_err());
        let save_ignores_bad_text =
            prepare_headers(Some("a.png"), None, Some("%"), ImageOp::Save).unwrap();
        assert!(save_ignores_bad_text.text.is_none());
        let controls = prepare_headers(Some("a%00b.png"), None, None, ImageOp::Share).unwrap();
        assert_eq!(controls.filename, "ab.png");
    }

    #[test]
    fn json_and_raw_budgets_share_the_same_limit() {
        assert_eq!(MAX_IMAGE_BYTES, 64 * 1024 * 1024);
        assert!(image_len_allowed(0, MAX_IMAGE_BYTES).is_err());
        assert!(image_len_allowed(1, MAX_IMAGE_BYTES).is_ok());
        assert!(image_len_allowed(MAX_IMAGE_BYTES, MAX_IMAGE_BYTES).is_ok());
        assert!(image_len_allowed(MAX_IMAGE_BYTES + 1, MAX_IMAGE_BYTES).is_err());

        let raw = InvokeBody::Raw(vec![9, 8, 7, 6]);
        assert_eq!(take_image_bytes(&raw, 4).unwrap(), vec![9, 8, 7, 6]);
        assert!(take_image_bytes(&InvokeBody::Raw(vec![1, 2, 3, 4, 5]), 4).is_err());
        assert!(take_image_bytes(&InvokeBody::Raw(vec![]), 4).is_err());

        assert_eq!(json_declared_len(&serde_json::json!([1, 2, 3])), Some(3));
        assert!(json_declared_len(&serde_json::json!([1, 2, 3])).unwrap() > 2);
        assert!(json_declared_len(&serde_json::json!([1, 2])).unwrap() <= 2);
        assert!(take_image_bytes(&InvokeBody::Json(serde_json::json!([1, 2, 3])), 2).is_err());
        assert!(take_image_bytes(&InvokeBody::Json(serde_json::json!([])), 4).is_err());
    }

    #[test]
    fn bridge_outcomes_keep_or_remove_only_owned_cache() {
        let opened = interpret(
            ImageOp::Share,
            Ok(PluginBody {
                ok: true,
                error_code: None,
                uri: None,
            }),
        );
        assert_eq!(opened, PluginCall::ShareOpened);
        assert_eq!(disposition(&opened), CacheDisposition::KeepUntilExpiry);

        let ambiguous = interpret(ImageOp::Share, Err(()));
        assert_eq!(ambiguous, PluginCall::Ambiguous);
        assert_eq!(disposition(&ambiguous), CacheDisposition::KeepUntilExpiry);
        assert_eq!(
            disposition(&interpret(ImageOp::Save, Err(()))),
            CacheDisposition::KeepUntilExpiry
        );

        let denied = interpret(
            ImageOp::Save,
            Ok(PluginBody {
                ok: false,
                error_code: Some("permission".into()),
                uri: None,
            }),
        );
        assert_eq!(denied, PluginCall::Failed("permission"));
        assert_eq!(disposition(&denied), CacheDisposition::RemoveNow);

        let leaked = interpret(
            ImageOp::Save,
            Ok(PluginBody {
                ok: false,
                error_code: Some("MediaStore exploded".into()),
                uri: None,
            }),
        );
        assert_eq!(leaked, PluginCall::Failed("io"));

        let saved = interpret(
            ImageOp::Save,
            Ok(PluginBody {
                ok: true,
                error_code: None,
                uri: Some("content://media/external/images/media/7".into()),
            }),
        );
        assert_eq!(disposition(&saved), CacheDisposition::RemoveNow);
        assert!(
            interpret(
                ImageOp::Save,
                Ok(PluginBody {
                    ok: true,
                    error_code: None,
                    uri: Some("/storage/pictures/a.jpg".into()),
                }),
            ) == PluginCall::Failed("io")
        );

        let root =
            std::env::temp_dir().join(format!("image-share-contract-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let share_root = root.join("image-share");
        let outside = root.join("secret.txt");
        fs::create_dir_all(&share_root).unwrap();
        fs::write(&outside, b"keep").unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nnot-recompressed";
        let id = hex_id(0x11);
        let mut active = HashSet::new();
        active.insert(id.clone());
        let staged = stage_image(&share_root, &id, bytes, "图片.png", &active).unwrap();
        assert_eq!(fs::read(&staged.file).unwrap(), bytes);
        assert!(staged.file.starts_with(&share_root));
        settle_cache(&staged, CacheDisposition::KeepUntilExpiry).unwrap();
        assert_eq!(fs::read(&staged.file).unwrap(), bytes);

        let failed = stage_image(
            &share_root,
            &hex_id(0x22),
            b"gif89a",
            "anim.gif",
            &HashSet::new(),
        )
        .unwrap();
        settle_cache(&failed, CacheDisposition::RemoveNow).unwrap();
        assert!(!failed.file.exists());
        assert!(staged.file.exists());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");

        let escaped = stage_image(
            &share_root,
            &hex_id(0x33),
            b"nope",
            "../secret.png",
            &HashSet::new(),
        );
        assert!(escaped.is_err());
        assert!(!root.join("secret.png").exists());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        assert!(!share_root.join(hex_id(0x33)).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_removes_only_stale_inactive_owned_requests() {
        let root = std::env::temp_dir().join(format!("image-share-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let share_root = root.join("image-share");
        fs::create_dir_all(&share_root).unwrap();
        let outside = root.join("library.bin");
        fs::write(&outside, b"book").unwrap();

        let stale_id = hex_id(0x41);
        let fresh_id = hex_id(0x42);
        let active_id = hex_id(0x43);
        let stale_dir = share_root.join(&stale_id);
        let fresh_dir = share_root.join(&fresh_id);
        let active_dir = share_root.join(&active_id);
        fs::create_dir(&stale_dir).unwrap();
        fs::create_dir(&fresh_dir).unwrap();
        fs::create_dir(&active_dir).unwrap();
        fs::write(stale_dir.join("a.png"), b"old").unwrap();
        fs::write(fresh_dir.join("b.png"), b"new").unwrap();
        fs::write(active_dir.join("c.png"), b"busy").unwrap();
        set_mtime(&stale_dir, ago(25 * 60 * 60));
        set_mtime(&active_dir, ago(25 * 60 * 60));
        set_mtime(&fresh_dir, ago(23 * 60 * 60));

        let foreign = share_root.join("notes");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("keep.txt"), b"x").unwrap();
        set_mtime(&foreign, ago(48 * 60 * 60));

        let stray_file = share_root.join(hex_id(0x44));
        fs::write(&stray_file, b"not-a-dir").unwrap();
        set_mtime(&stray_file, ago(48 * 60 * 60));

        let mut active = HashSet::new();
        active.insert(active_id.clone());
        prune_stale_requests(&share_root, &active, SystemTime::now());

        assert!(!stale_dir.exists());
        assert!(fresh_dir.join("b.png").is_file());
        assert_eq!(fs::read(active_dir.join("c.png")).unwrap(), b"busy");
        assert_eq!(fs::read(foreign.join("keep.txt")).unwrap(), b"x");
        assert_eq!(fs::read(&stray_file).unwrap(), b"not-a-dir");
        assert_eq!(fs::read(&outside).unwrap(), b"book");

        #[cfg(unix)]
        {
            let target = root.join("outside-target");
            fs::create_dir(&target).unwrap();
            fs::write(target.join("secret"), b"secret").unwrap();
            let link_id = hex_id(0x45);
            let link = share_root.join(&link_id);
            std::os::unix::fs::symlink(&target, &link).unwrap();
            remove_owned_request(&share_root, &link_id).unwrap();
            assert!(!link.exists());
            assert_eq!(fs::read(target.join("secret")).unwrap(), b"secret");
            assert!(remove_owned_request(&share_root, "../library").is_err());
            assert_eq!(fs::read(&outside).unwrap(), b"book");
        }

        let _ = fs::remove_dir_all(&root);
    }
}
