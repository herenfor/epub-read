//! F-N archive-file backend.
//!
//! This module owns the process-local file-job slot and the `.epubsave`
//! container adapter. It reuses the already-active v3 repository for the
//! short metadata transaction; file copying, ZIP streaming and Android URI
//! bridging happen outside the repository lock.

mod archive;
pub(crate) mod commands;

pub use commands::SaveFileManager;

use crate::portable_state::{PortableError, MAX_SAFE_COUNTER};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::Manager;

pub(crate) const JSON_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const COPY_BUFFER_BYTES: usize = 64 * 1024;
pub(crate) const PROGRESS_STEP_BYTES: u64 = 256 * 1024;
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileError {
    pub code: String,
    pub message: String,
}

impl SaveFileError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid-request", message)
    }

    pub(crate) fn invalid_data(message: impl Into<String>) -> Self {
        Self::new("invalid-data", message)
    }

    pub(crate) fn invalid_entity(message: impl Into<String>) -> Self {
        Self::new("invalid-entity", message)
    }

    pub(crate) fn busy() -> Self {
        Self::new("busy", "已有存档文件任务正在运行或等待确认")
    }

    pub(crate) fn not_found() -> Self {
        Self::new("not-found", "没有该 jobId 的活动存档文件任务")
    }

    pub(crate) fn invalid_state(message: impl Into<String>) -> Self {
        Self::new("invalid-state", message)
    }

    pub(crate) fn cancelled() -> Self {
        Self::new("cancelled", "任务已取消")
    }

    pub(crate) fn too_late() -> Self {
        Self::new("too-late", "资料提交已经开始，不能再取消")
    }

    pub(crate) fn unsupported_platform(message: impl Into<String>) -> Self {
        Self::new("unsupported-platform", message)
    }

    pub(crate) fn storage_error(message: impl Into<String>) -> Self {
        Self::new("storage-error", message)
    }
}

impl From<PortableError> for SaveFileError {
    fn from(error: PortableError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<std::io::Error> for SaveFileError {
    fn from(error: std::io::Error) -> Self {
        Self::storage_error(format!("文件读写失败：{error}"))
    }
}

impl From<zip::result::ZipError> for SaveFileError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::storage_error(format!("ZIP 读写失败：{error}"))
    }
}

impl std::fmt::Display for SaveFileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SaveFileError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileProgress {
    pub phase: String,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
}

pub(crate) struct ProgressReporter {
    channel: Channel<SaveFileProgress>,
    phase: String,
    processed_bytes: u64,
    total_bytes: Option<u64>,
    last_sent_at: Instant,
    last_sent_bytes: u64,
}

impl ProgressReporter {
    pub(crate) fn new(
        channel: Channel<SaveFileProgress>,
        phase: &str,
        total_bytes: Option<u64>,
    ) -> Self {
        let mut reporter = Self {
            channel,
            phase: phase.to_string(),
            processed_bytes: 0,
            total_bytes,
            last_sent_at: Instant::now() - PROGRESS_INTERVAL,
            last_sent_bytes: 0,
        };
        reporter.force();
        reporter
    }

    pub(crate) fn set_phase(&mut self, phase: &str, total_bytes: Option<u64>) {
        self.phase = phase.to_string();
        self.processed_bytes = 0;
        self.total_bytes = total_bytes;
        self.last_sent_bytes = 0;
        self.force();
    }

    pub(crate) fn set_total(&mut self, total_bytes: Option<u64>) {
        self.total_bytes = total_bytes;
        self.force();
    }

    pub(crate) fn add(&mut self, bytes: u64) {
        self.processed_bytes = self.processed_bytes.saturating_add(bytes);
        let due = self.processed_bytes.saturating_sub(self.last_sent_bytes) >= PROGRESS_STEP_BYTES
            || self.last_sent_at.elapsed() >= PROGRESS_INTERVAL;
        if due {
            self.force();
        }
    }

    pub(crate) fn force(&mut self) {
        self.last_sent_at = Instant::now();
        self.last_sent_bytes = self.processed_bytes;
        let _ = self.channel.send(SaveFileProgress {
            phase: self.phase.clone(),
            processed_bytes: self.processed_bytes,
            total_bytes: self.total_bytes,
        });
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SaveFileLocation {
    Path { path: String },
    Uri { uri: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SaveExportScope {
    All,
    Selected {
        #[serde(rename = "bookHashes")]
        book_hashes: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedBook {
    pub content_hash: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileExportResult {
    pub status: String,
    pub job_id: String,
    pub package_id: Option<String>,
    pub written_books: usize,
    pub book_bytes: u64,
    pub archive_bytes: Option<u64>,
    pub skipped_books: Vec<SkippedBook>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingBook {
    pub content_hash: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFilePrepareResult {
    pub status: String,
    pub job_id: String,
    pub package_id: String,
    pub scope_kind: String,
    pub book_count: usize,
    pub attached_books: Vec<String>,
    pub missing_books: Vec<MissingBook>,
    pub progress_conflict_count: usize,
    pub new_book_count: usize,
    pub has_preferences: bool,
    pub source_bytes: u64,
    pub total_uncompressed_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileCommitResult {
    pub status: String,
    pub job_id: String,
    pub merged_books: usize,
    pub imported_books: Vec<String>,
    pub new_visible_books: Vec<String>,
    pub missing_books: Vec<MissingBook>,
    pub progress_conflict_books: Vec<String>,
    pub applied_preferences: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileCancelResult {
    pub status: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedAttachment {
    pub content_hash: String,
    pub staging_path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub(crate) struct PreparedImport {
    pub package_id: String,
    pub staging_dir: PathBuf,
    pub incoming: crate::portable_state::PortableStateV3,
    pub attachments: Vec<PreparedAttachment>,
    pub source_bytes: u64,
    pub total_uncompressed_bytes: u64,
    pub preview: SaveFilePrepareResult,
}

impl Drop for PreparedImport {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.staging_dir);
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(MAX_SAFE_COUNTER as u128) as u64)
        .unwrap_or(0)
}

pub(crate) fn new_uuid() -> Result<String, SaveFileError> {
    crate::portable_state::random_uuid_v4().map_err(SaveFileError::from)
}

pub(crate) fn valid_hash(value: &str) -> bool {
    crate::portable_state::valid_content_hash(value)
}

pub(crate) fn valid_job_id(value: &str) -> bool {
    crate::portable_state::valid_canonical_uuid(value)
}

pub(crate) fn managed_book_path(root: &Path, content_hash: &str) -> PathBuf {
    root.join("books").join(format!("{content_hash}.epub"))
}

pub(crate) fn staging_root(root: &Path) -> PathBuf {
    root.join("books").join(".staging")
}

pub(crate) fn new_staging_dir(root: &Path, job_id: &str) -> Result<PathBuf, SaveFileError> {
    if !valid_job_id(job_id) {
        return Err(SaveFileError::invalid_request("jobId 必须是规范 UUID"));
    }
    let dir = staging_root(root).join(format!("save-file-{job_id}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalBinding {
    pub content_hash: String,
    #[serde(default = "default_storage_kind")]
    pub storage_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_source_path: Option<String>,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub source_mtime_ns: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_zip_path: Option<String>,
    #[serde(default)]
    pub cover_mime: String,
    #[serde(default)]
    pub last_verified_at_ms: u64,
}

fn default_storage_kind() -> String {
    "linked".to_string()
}

impl LocalBinding {
    pub(crate) fn new_managed(content_hash: &str, file_size: u64, source_mtime_ns: u64) -> Self {
        Self {
            content_hash: content_hash.to_string(),
            storage_kind: "managed".to_string(),
            canonical_source_path: None,
            file_size,
            source_mtime_ns,
            cover_zip_path: None,
            cover_mime: String::new(),
            last_verified_at_ms: now_ms(),
        }
    }

    pub(crate) fn source_path(&self, root: &Path) -> Result<PathBuf, SaveFileError> {
        if !valid_hash(&self.content_hash) {
            return Err(SaveFileError::invalid_entity(
                "设备绑定 contentHash 必须是 64 位小写内容指纹",
            ));
        }
        if self.storage_kind == "managed" {
            return Ok(managed_book_path(root, &self.content_hash));
        }
        let raw = self
            .canonical_source_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                SaveFileError::invalid_entity("linked 设备绑定缺少 canonicalSourcePath")
            })?;
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err(SaveFileError::invalid_entity(
                "linked 设备绑定的 canonicalSourcePath 必须是绝对路径",
            ));
        }
        Ok(path)
    }

    pub(crate) fn is_valid(&self, root: &Path) -> bool {
        let Ok(path) = self.source_path(root) else {
            return false;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            return false;
        };
        if !metadata.is_file() || metadata.len() == 0 {
            return false;
        }
        if self.file_size != 0 && metadata.len() != self.file_size {
            return false;
        }
        sha256_file(&path)
            .map(|hash| hash == self.content_hash)
            .unwrap_or(false)
    }
}

pub(crate) fn parse_bindings(
    raw_bindings: BTreeMap<String, String>,
) -> Result<BTreeMap<String, LocalBinding>, SaveFileError> {
    let mut bindings = BTreeMap::new();
    for (hash, raw) in raw_bindings {
        let binding: LocalBinding = serde_json::from_str(&raw).map_err(|error| {
            SaveFileError::storage_error(format!("设备绑定损坏（{hash}）：{error}"))
        })?;
        if binding.content_hash != hash {
            return Err(SaveFileError::storage_error(
                "device_bindings 行内容指纹与键不一致",
            ));
        }
        if !valid_hash(&hash) {
            return Err(SaveFileError::storage_error("设备绑定内容指纹无效"));
        }
        match binding.storage_kind.as_str() {
            "managed" => {}
            "linked" => {
                binding.source_path(Path::new(""))?;
            }
            _ => return Err(SaveFileError::storage_error("设备绑定 storageKind 未知")),
        }
        bindings.insert(hash, binding);
    }
    Ok(bindings)
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, SaveFileError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub(crate) fn copy_reader_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    reporter: &mut ProgressReporter,
    cancelled: &AtomicBool,
) -> Result<u64, SaveFileError> {
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    let mut written = 0_u64;
    loop {
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(SaveFileError::cancelled());
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        written = written.saturating_add(read as u64);
        reporter.add(read as u64);
    }
    Ok(written)
}

pub(crate) fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(not(windows))]
    {
        fs::rename(source, target)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(
                existing_file_name: *const u16,
                new_file_name: *const u16,
                flags: u32,
            ) -> i32;
        }
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: both paths are NUL-terminated UTF-16 buffers alive for the call.
        let ok = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

pub(crate) fn cleanup_stale_staging(app: &tauri::AppHandle) -> Result<(), SaveFileError> {
    let root = app
        .path()
        .app_local_data_dir()
        .map(|path| path.join("linked-library"))
        .map_err(|error| {
            SaveFileError::storage_error(format!("无法取得应用本地数据目录：{error}"))
        })?;
    let dir = staging_root(&root);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(SaveFileError::storage_error(format!(
                "无法扫描存档文件临时目录：{error}"
            )))
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| {
            SaveFileError::storage_error(format!("无法扫描存档文件临时目录：{error}"))
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("save-file-") {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            SaveFileError::storage_error(format!("无法读取存档文件临时目录项：{error}"))
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let _ = fs::remove_dir_all(entry.path());
    }
    Ok(())
}

pub(crate) fn temp_file_path(parent: &Path, label: &str, extension: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    parent.join(format!(
        ".{label}.{}.{nonce}.{extension}.part",
        std::process::id()
    ))
}

pub(crate) fn open_temp_file(path: &Path) -> Result<File, SaveFileError> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(Into::into)
}
