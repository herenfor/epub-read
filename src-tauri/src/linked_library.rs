//! Device-local implementation of the linked EPUB library.
//!
//! `LibraryRecord` is deliberately self-contained and safe to export.  The
//! companion `DeviceBinding` is never returned from list APIs, because it
//! contains an absolute path on this device.  The two JSON files are replaced
//! atomically one at a time under one mutex.  They cannot be a single atomic
//! filesystem transaction: imports write bindings first and records second, so
//! a crash can at worst leave an ignored orphan binding; deletion clears
//! regenerable AI data, removes only application-owned managed copies, and
//! never removes a user-owned linked source file.

use crate::ai::AiState;
use crate::linked_library_error::LinkedLibraryError;
use crate::android_uri_bridge::{RestrictedReadError, RestrictedReader};
use crate::directory_import::activity::ImportActivityGuard;
use crate::directory_import::job::DirectoryImportState;
use crate::import_gate::{CancelReply as ImportCancelReply, ImportGate};
use crate::library_organization::{
    self, LibraryOrganization, OrganizationCommand, OrganizationEnvelope,
};
use crate::portable_state::{
    Locator, LocatorTarget, MediaTag, PortableError, ShelfBookProjection, ShelfProjection,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use zip::ZipArchive;
use crate::native_zip_session::{Fault, NativeZipSession, CHUNK_BYTES};

mod epub_meta;
pub(crate) use epub_meta::{inspect_epub, inspect_epub_cover};
use epub_meta::read_zip_entry_bounded;

mod source;
use source::*;
pub(crate) use source::{snapshot, canonical_epub_path, hash_file};

mod binding;
use binding::*;
pub(crate) use binding::{make_binding, verify_binding_for_list_refresh};

mod thumbnails;
use thumbnails::*;

mod store;
use store::*;
pub(crate) use store::{valid_content_hash, library_root, managed_source_path, atomic_write_bytes, replace_file_atomically};

mod import;
use import::*;
pub(crate) use import::{new_staging_path, stream_restricted_reader_to_staging, make_managed_binding, make_managed_record};

const MAX_THUMBNAIL_CACHE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 5 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_COVER_BYTES: u64 = 32 * 1024 * 1024;
const THUMBNAIL_ACCESS_WRITE_INTERVAL_MS: u64 = 60 * 60 * 1000;
const MAX_ANCHOR_SNIPPET_CODE_POINTS: usize = 32;
const MAX_ANCHOR_TEXT_OFFSET: u64 = 9_007_199_254_740_991;
const MAX_NOTE_SELECTED_CODE_POINTS: usize = 4_096;
const MAX_NOTE_CONTENT_CODE_POINTS: usize = 10_000;
static TEMP_FILE_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct LinkedLibraryWriteState(pub Mutex<()>);

#[cfg(debug_assertions)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordsReadDiagnostic {
    source: &'static str,
    count: usize,
    target_found: Option<bool>,
}

#[cfg(debug_assertions)]
static LAST_RECORDS_READ: Mutex<Option<RecordsReadDiagnostic>> = Mutex::new(None);

fn observe_records_read(source: &'static str, count: usize) {
    #[cfg(debug_assertions)]
    if let Ok(mut last) = LAST_RECORDS_READ.lock() {
        *last = Some(RecordsReadDiagnostic { source, count, target_found: None });
    }
    #[cfg(not(debug_assertions))]
    let _ = (source, count);
}

fn observe_record_target(found: bool) {
    #[cfg(debug_assertions)]
    if let Ok(mut last) = LAST_RECORDS_READ.lock() {
        if let Some(read) = last.as_mut() { read.target_found = Some(found); }
    }
    #[cfg(not(debug_assertions))]
    let _ = found;
}

#[cfg(debug_assertions)]
pub(crate) fn records_read_diagnostic() -> Option<RecordsReadDiagnostic> {
    LAST_RECORDS_READ.lock().ok().and_then(|last| last.clone())
}

/// Window-owned registry of native ZIP sessions. The registry lock is only
/// held while looking up/inserting/removing; decoding and hashing happen on
/// blocking threads without the library write lock.
#[derive(Default)]
pub struct NativeArchiveState(Mutex<HashMap<String, NativeArchiveSession>>);

struct NativeArchiveSession {
    owner: String,
    session: Arc<NativeZipSession>,
}

/// Small open acknowledgement returned to the WebView; no book bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveOpenView {
    protocol_version: u32,
    session_id: String,
    entry_count: usize,
    chunk_bytes: usize,
}

/// One in-process managed import task. `request_id` is unique per frontend
/// invocation; the gate arbitrates the preparation/commit race.
#[derive(Debug)]
struct ImportJob {
    request_id: String,
    gate: Arc<ImportGate>,
    /// Shared activity token; keeps directory import from starting while this
    /// managed import is alive (and is released with the task guard).
    _activity: Option<ImportActivityGuard>,
}

/// Owns the active slot for the lifetime of a managed import and tracks every
/// staging file created by this batch. Drop order is explicit: staging files
/// are removed first, then the active slot is released. This also runs on a
/// worker unwind, so a panic cannot leave the batch permanently busy.
struct ImportTaskGuard {
    app: AppHandle,
    job: Arc<ImportJob>,
    staging_paths: Vec<PathBuf>,
}

impl ImportTaskGuard {
    fn new(app: AppHandle, job: Arc<ImportJob>) -> Self {
        Self {
            app,
            job,
            staging_paths: Vec::new(),
        }
    }

    fn track_staging(&mut self, path: PathBuf) {
        self.staging_paths.push(path);
    }
}

impl Drop for ImportTaskGuard {
    fn drop(&mut self) {
        for path in self.staging_paths.drain(..) {
            let _ = fs::remove_file(path);
        }
        if let Some(active) = self.app.try_state::<ManagedImportState>() {
            if let Ok(mut slot) = active.0.lock() {
                if let Some(current) = slot.as_ref() {
                    if Arc::ptr_eq(current, &self.job) {
                        *slot = None;
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub struct ManagedImportState(Mutex<Option<Arc<ImportJob>>>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedLibraryRecord {
    pub content_hash: String,
    pub title: String,
    pub creator: String,
    /// The OPF `dc:language` value, when supplied by the publisher.
    ///
    /// This is optional in EPUB metadata and therefore defaults to the empty
    /// string when loading records written by older versions.
    #[serde(default)]
    pub language: String,
    pub file_name: String,
    pub added_at_ms: u64,
    pub last_read_at_ms: u64,
    pub spine_index: usize,
    pub page: usize,
    pub progress_pct: u32,
    pub anchor_index: Option<usize>,
    pub anchor_ratio: Option<f64>,
    #[serde(default)]
    pub anchor_text_offset: Option<u64>,
    #[serde(default)]
    pub anchor_text_snippet: Option<String>,
    #[serde(default)]
    pub media_anchor: Option<LinkedLibraryMediaAnchor>,
    #[serde(default)]
    pub bookmarks: Vec<LinkedLibraryBookmark>,
    #[serde(default)]
    pub notes: Vec<LinkedLibraryNote>,
    pub is_new: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedLibraryBookmark {
    pub id: String,
    pub spine_index: usize,
    pub page: usize,
    pub anchor_index: Option<usize>,
    pub anchor_ratio: Option<f64>,
    #[serde(default)]
    pub anchor_text_offset: Option<u64>,
    #[serde(default)]
    pub anchor_text_snippet: Option<String>,
    #[serde(default)]
    pub media_anchor: Option<LinkedLibraryMediaAnchor>,
    pub text: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedLibraryMediaAnchor {
    pub index: usize,
    pub tag: String,
    pub signature: String,
    pub ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedLibraryNote {
    pub id: String,
    pub spine_index: usize,
    pub chapter_path: String,
    pub start_text_offset: u64,
    pub end_text_offset: u64,
    pub start_text_snippet: String,
    pub end_text_snippet: String,
    pub selected_text: String,
    pub content: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
enum StorageKind {
    #[default]
    Linked,
    Managed,
}

impl<'de> Deserialize<'de> for StorageKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct StorageKindVisitor;

        impl<'de> serde::de::Visitor<'de> for StorageKindVisitor {
            type Value = StorageKind;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("\"linked\" 或 \"managed\"")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "linked" => Ok(StorageKind::Linked),
                    "managed" => Ok(StorageKind::Managed),
                    other => Err(E::unknown_variant(other, &["linked", "managed"])),
                }
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Err(E::invalid_type(
                    serde::de::Unexpected::Unit,
                    &"storageKind 必须是 \"linked\" 或 \"managed\"",
                ))
            }
        }

        deserializer.deserialize_any(StorageKindVisitor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceBinding {
    pub(crate) content_hash: String,
    #[serde(default)]
    storage_kind: StorageKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    canonical_source_path: Option<String>,
    file_size: u64,
    source_mtime_ns: u64,
    cover_zip_path: Option<String>,
    cover_mime: String,
    last_verified_at_ms: u64,
}

/// Where the bytes for a record currently live.  `Linked` keeps the existing
/// Windows semantics: the file is user-owned and is only read.  `Managed`
/// never trusts a persisted path; it is always derived from the library root
/// and the canonical lowercase content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BindingSource {
    Linked(PathBuf),
    Managed(PathBuf),
}

impl BindingSource {
    fn path(&self) -> &Path {
        match self {
            BindingSource::Linked(path) | BindingSource::Managed(path) => path,
        }
    }
}

impl DeviceBinding {
    fn resolve_source(&self, library_root: &Path) -> Result<BindingSource, String> {
        match self.storage_kind {
            StorageKind::Linked => {
                let raw = self
                    .canonical_source_path
                    .as_deref()
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| "linked 设备绑定缺少 canonicalSourcePath".to_string())?;
                let path = PathBuf::from(raw);
                if !path.is_absolute() {
                    return Err("linked 设备绑定的 canonicalSourcePath 必须是绝对路径".into());
                }
                Ok(BindingSource::Linked(path))
            }
            StorageKind::Managed => {
                if self.canonical_source_path.is_some() {
                    return Err("managed 设备绑定不能携带 canonicalSourcePath".into());
                }
                Ok(BindingSource::Managed(managed_source_path(
                    library_root,
                    &self.content_hash,
                )?))
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedLibraryRecordView {
    id: String,
    content_hash: String,
    title: String,
    creator: String,
    #[serde(default)]
    language: String,
    file_name: String,
    added_at_ms: u64,
    last_read_at_ms: u64,
    spine_index: usize,
    page: usize,
    progress_pct: u32,
    anchor_index: Option<usize>,
    anchor_ratio: Option<f64>,
    anchor_text_offset: Option<u64>,
    anchor_text_snippet: Option<String>,
    media_anchor: Option<LinkedLibraryMediaAnchor>,
    bookmarks: Vec<LinkedLibraryBookmark>,
    notes: Vec<LinkedLibraryNote>,
    is_new: bool,
    available: bool,
    file_size: u64,
    cover_mime: String,
    thumbnail_mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItemResult {
    input_index: usize,
    status: String,
    content_hash: Option<String>,
    record: Option<LinkedLibraryRecordView>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchResult {
    results: Vec<ImportItemResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSelection {
    pub uri: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub request_id: String,
    pub phase: String,
    pub completed: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelDocumentImportReply {
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImportError {
    pub code: String,
    pub message: String,
    pub requires_reload: bool,
}

impl NativeImportError {
    fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_request".to_string(),
            message: message.into(),
            requires_reload: false,
        }
    }

    #[cfg_attr(target_os = "android", allow(dead_code))]
    fn unsupported_platform() -> Self {
        Self {
            code: "unsupported_platform".to_string(),
            message: "托管书籍导入仅在 Android 上可用".to_string(),
            requires_reload: false,
        }
    }

    fn busy() -> Self {
        Self {
            code: "busy".to_string(),
            message: import_busy_message(),
            requires_reload: false,
        }
    }

    fn storage_error(message: impl Into<String>) -> Self {
        Self {
            code: "storage_error".to_string(),
            message: message.into(),
            requires_reload: false,
        }
    }

    fn commit_failed(message: impl Into<String>) -> Self {
        Self {
            code: "commit_failed".to_string(),
            message: message.into(),
            requires_reload: true,
        }
    }

    fn internal_error(message: impl Into<String>, requires_reload: bool) -> Self {
        Self {
            code: "internal_error".to_string(),
            message: message.into(),
            requires_reload,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ThumbnailIndex {
    #[serde(default)]
    entries: Vec<ThumbnailEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailEntry {
    content_hash: String,
    mime: String,
    size: u64,
    last_accessed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileSnapshot {
    size: u64,
    mtime_ns: u64,
}

pub(crate) struct BindingVerification {
    pub(crate) available: bool,
    changed: bool,
}

#[derive(Debug)]
pub(crate) struct ImportedMetadata {
    pub(crate) title: String,
    pub(crate) creator: String,
    pub(crate) language: String,
    pub(crate) spine: Vec<String>,
    cover_zip_path: Option<String>,
    cover_mime: String,
}
























type LinkedReadingFields = (
    usize,
    usize,
    Option<usize>,
    Option<f64>,
    Option<u64>,
    Option<String>,
    Option<LinkedLibraryMediaAnchor>,
);




































/// Identity captured while the library lock is held.  The concrete path is
/// only a comparison key: managed paths are always derived from root + hash
/// and can never be supplied by a request.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceIdentity {
    content_hash: String,
    storage_kind: StorageKind,
    path: PathBuf,
}

impl SourceIdentity {
    fn from_binding(binding: &DeviceBinding, library_root: &Path) -> Result<Self, String> {
        let source = binding.resolve_source(library_root)?;
        Ok(Self {
            content_hash: binding.content_hash.clone(),
            storage_kind: binding.storage_kind,
            path: source.path().to_path_buf(),
        })
    }
}

struct PendingSourceRead {
    identity: SourceIdentity,
    old_snapshot: FileSnapshot,
    file: File,
}

#[derive(Debug)]
struct SourceReadResult {
    bytes: Vec<u8>,
    read_snapshot: FileSnapshot,
}









struct HashingWriter<W> {
    inner: W,
    digest: Sha256,
    written: u64,
}

impl<W> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            written: 0,
        }
    }

    fn hash_hex(&self) -> String {
        format!("{:x}", self.digest.clone().finalize())
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let count = self.inner.write(buffer)?;
        self.digest.update(&buffer[..count]);
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

#[derive(Debug)]
pub(crate) struct StagedFile {
    pub(crate) content_hash: String,
}

#[derive(Debug)]
pub(crate) enum PrepareError {
    Cancelled {
        content_hash: Option<String>,
    },
    Failed {
        content_hash: Option<String>,
        message: String,
    },
}

#[derive(Debug)]
struct PreparedDocument {
    input_index: usize,
    content_hash: String,
    staging_path: PathBuf,
    file_name: String,
    metadata: ImportedMetadata,
}

#[derive(Debug)]
enum PreparedItem {
    Ready(PreparedDocument),
    Failed {
        input_index: usize,
        content_hash: Option<String>,
        message: String,
    },
    Cancelled {
        input_index: usize,
        content_hash: Option<String>,
    },
}

#[derive(Debug, Default)]
struct PublishOutcome {
    statuses: HashMap<String, String>,
    failures: HashMap<String, String>,
    bindings_changed: bool,
    records_changed: bool,
}












#[tauri::command]
pub async fn linked_library_import_documents(
    app: AppHandle,
    request_id: String,
    documents: Vec<DocumentSelection>,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportBatchResult, NativeImportError> {
    validate_document_request(&request_id, &documents)?;

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request_id, documents, on_progress);
        Err(NativeImportError::unsupported_platform())
    }

    #[cfg(target_os = "android")]
    {
        let job = reserve_import(&app, &request_id)?;
        let task_guard = ImportTaskGuard::new(app.clone(), job);
        send_import_progress(&on_progress, &request_id, "preparing", 0, documents.len());
        let join = tauri::async_runtime::spawn_blocking(move || {
            run_import_documents_blocking(app, request_id, documents, on_progress, task_guard)
        })
        .await;
        match join {
            Ok(result) => result,
            Err(error) => Err(NativeImportError::internal_error(
                format!("导入工作线程失败：{error}"),
                true,
            )),
        }
    }
}

#[tauri::command]
pub fn linked_library_cancel_document_import(
    app: AppHandle,
    request_id: String,
) -> Result<CancelDocumentImportReply, NativeImportError> {
    if request_id.trim().is_empty() {
        return Err(NativeImportError::invalid_request("requestId 不能为空"));
    }
    let active = app.state::<ManagedImportState>();
    let job = {
        let slot = active
            .0
            .lock()
            .map_err(|_| NativeImportError::internal_error("导入活动槽锁已损坏", false))?;
        slot.as_ref()
            .filter(|job| job.request_id == request_id)
            .cloned()
    };
    let Some(job) = job else {
        return Ok(CancelDocumentImportReply {
            status: "not_running".to_string(),
        });
    };
    let status = match job.gate.cancel() {
        ImportCancelReply::Requested => "requested",
        ImportCancelReply::TooLate => "too_late",
        ImportCancelReply::Finished => "not_running",
    };
    Ok(CancelDocumentImportReply {
        status: status.to_string(),
    })
}

#[tauri::command]
pub async fn linked_library_list_records(
    app: AppHandle,
) -> Result<Vec<LinkedLibraryRecordView>, String> {
    tauri::async_runtime::spawn_blocking(move || list_records_blocking(app))
        .await
        .map_err(|error| format!("书库列表工作线程失败：{error}"))?
}


#[tauri::command]
pub fn linked_library_import_paths(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    paths: Vec<String>,
) -> Result<ImportBatchResult, String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    ensure_import_idle(&app)?;
    let _activity = acquire_import_activity(&app, "linked-library-import-paths".to_string())?;
    let root = library_root(&app)?;
    let mut records = load_records(&app)?;
    let mut bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    let mut results = Vec::with_capacity(paths.len());
    let mut bindings_changed = false;
    let mut records_changed = false;
    for (input_index, raw_path) in paths.into_iter().enumerate() {
        let result = (|| -> Result<(String, ImportedMetadata, PathBuf, FileSnapshot), String> {
            let path = canonical_epub_path(&raw_path)?;
            let (hash, hashed_snapshot) = hash_file(&path)?;
            let metadata = inspect_epub(&path)?;
            if metadata.spine.is_empty() {
                return Err("EPUB OPF 没有可阅读的 spine 条目".into());
            }
            let final_snapshot = snapshot(&path)?;
            if final_snapshot.size != hashed_snapshot.size
                || final_snapshot.mtime_ns != hashed_snapshot.mtime_ns
            {
                return Err("源 EPUB 在解析元数据期间发生了变化，请重新导入".into());
            }
            Ok((hash, metadata, path, final_snapshot))
        })();
        match result {
            Ok((hash, metadata, path, file_snapshot)) => {
                let binding = make_binding(hash.clone(), &path, file_snapshot, &metadata);
                upsert_binding(&mut bindings, binding);
                bindings_changed = true;
                if records.iter().any(|record| record.content_hash == hash) {
                    results.push(ImportItemResult {
                        input_index,
                        status: "duplicate".into(),
                        content_hash: Some(hash.clone()),
                        record: view_by_hash(&records, &bindings, &thumbnails, &hash, &root),
                        error: None,
                    });
                } else {
                    let record = LinkedLibraryRecord {
                        content_hash: hash.clone(),
                        title: if metadata.title.is_empty() {
                            path.file_stem()
                                .and_then(|name| name.to_str())
                                .unwrap_or("未命名书籍")
                                .to_string()
                        } else {
                            metadata.title.clone()
                        },
                        creator: metadata.creator.clone(),
                        language: metadata.language.clone(),
                        file_name: path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("book.epub")
                            .to_string(),
                        added_at_ms: now_ms(),
                        // Import time is not a reading event.  The UI falls
                        // back to added_at_ms for recent sorting until the
                        // first stable position is saved.
                        last_read_at_ms: 0,
                        spine_index: 0,
                        page: 0,
                        progress_pct: 0,
                        anchor_index: None,
                        anchor_ratio: None,
                        anchor_text_offset: None,
                        anchor_text_snippet: None,
                        media_anchor: None,
                        bookmarks: Vec::new(),
                        notes: Vec::new(),
                        is_new: true,
                    };
                    records.push(record);
                    records_changed = true;
                    results.push(ImportItemResult {
                        input_index,
                        status: "saved".into(),
                        content_hash: Some(hash.clone()),
                        record: view_by_hash(&records, &bindings, &thumbnails, &hash, &root),
                        error: None,
                    });
                }
            }
            Err(error) => results.push(ImportItemResult {
                input_index,
                status: "failed".into(),
                content_hash: None,
                record: None,
                error: Some(error),
            }),
        }
    }
    persist_import_indexes_for_app(
        &app,
        &root,
        &PublishOutcome {
            bindings_changed,
            records_changed,
            ..Default::default()
        },
        &records,
        &bindings,
    )
    .map_err(|error| error.message)?;
    Ok(ImportBatchResult { results })
}

#[tauri::command]
pub async fn linked_library_read_source_raw(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    tauri::async_runtime::spawn_blocking(move || read_source_raw_blocking(app, content_hash))
        .await
        .map_err(|error| format!("源 EPUB 读取工作线程失败：{error}"))?
}


#[tauri::command]
pub async fn linked_library_read_cover_raw(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    tauri::async_runtime::spawn_blocking(move || read_cover_raw_blocking(app, content_hash))
        .await
        .map_err(|error| format!("封面读取工作线程失败：{error}"))?
}




fn archive_fault_error(fault: Fault) -> LinkedLibraryError {
    match fault {
        Fault::Closed => "原生归档会话已关闭".into(),
        Fault::InvalidRequest => "原生归档请求无效".into(),
        Fault::InvalidArchive => "EPUB 归档结构无效".into(),
        Fault::CorruptEntry => "EPUB 资源校验失败".into(),
        Fault::SourceChanged => LinkedLibraryError::changed("源 EPUB 在读取期间发生了变化；请重新导入或重新定位"),
        Fault::DirectoryTooLarge => "EPUB 归档目录条目过大".into(),
        Fault::Io => "读取源 EPUB 失败".into(),
    }
}

fn native_archive_session(
    app: &AppHandle,
    owner: &str,
    session_id: &str,
) -> Result<Arc<NativeZipSession>, String> {
    let state = app.state::<NativeArchiveState>();
    let sessions = state
        .0
        .lock()
        .map_err(|_| "原生归档会话表已损坏".to_string())?;
    let entry = sessions
        .get(session_id)
        .ok_or_else(|| "原生归档会话不存在或已关闭".to_string())?;
    if entry.owner != owner {
        return Err("原生归档会话不属于当前窗口".to_string());
    }
    Ok(Arc::clone(&entry.session))
}

fn archive_open_blocking(
    app: AppHandle,
    owner: String,
    content_hash: String,
) -> Result<ArchiveOpenView, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    let (root, pending) = prepare_library_source_read(&app, &content_hash)?;
    let PendingSourceRead {
        identity,
        old_snapshot,
        mut file,
    } = pending;
    let (actual_hash, verified_snapshot) = hash_opened_file(&file)?;
    if !actual_hash.eq_ignore_ascii_case(&content_hash) {
        return Err(LinkedLibraryError::changed("源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("无法重新定位源 EPUB：{error}"))?;
    let stat_file = file
        .try_clone()
        .map_err(|error| format!("无法复制源 EPUB 句柄：{error}"))?;
    let expected_snapshot = verified_snapshot.clone();
    let guard = move || {
        let current = snapshot_file(&stat_file).map_err(|_| Fault::Io)?;
        if current == expected_snapshot {
            Ok(())
        } else {
            Err(Fault::SourceChanged)
        }
    };

    let session = NativeZipSession::from_verified_file(file, guard).map_err(archive_fault_error)?;
    let entry_count = session.entry_count;
    finalize_library_source_read(&app, &root, &identity, &old_snapshot, &verified_snapshot)?;

    if app.get_webview_window(&owner).is_none() {
        session.close();
        return Err("打开原生归档的窗口已关闭".into());
    }

    let session_id = random_uuid_v4()?;
    {
        let state = app.state::<NativeArchiveState>();
        let mut sessions = state
            .0
            .lock()
            .map_err(|_| "原生归档会话表已损坏".to_string())?;
        sessions.insert(
            session_id.clone(),
            NativeArchiveSession {
                owner,
                session: Arc::new(session),
            },
        );
    }
    Ok(ArchiveOpenView {
        protocol_version: 1,
        session_id,
        entry_count,
        chunk_bytes: CHUNK_BYTES,
    })
}

#[tauri::command]
pub async fn linked_library_archive_open(
    app: AppHandle,
    window: tauri::Window,
    content_hash: String,
) -> Result<ArchiveOpenView, LinkedLibraryError> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || archive_open_blocking(app, owner, content_hash))
        .await
        .map_err(|error| format!("原生归档打开工作线程失败：{error}"))?
}

#[tauri::command]
pub async fn linked_library_archive_directory(
    app: AppHandle,
    window: tauri::Window,
    session_id: String,
    start: usize,
) -> Result<crate::native_zip_session::DirectoryPage, LinkedLibraryError> {
    let owner = window.label().to_string();
    let session = native_archive_session(&app, &owner, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .directory_page(start)
            .map_err(archive_fault_error)
    })
    .await
    .map_err(|error| format!("原生归档目录工作线程失败：{error}"))?
}

#[tauri::command]
pub async fn linked_library_archive_read(
    app: AppHandle,
    window: tauri::Window,
    session_id: String,
    entry_index: usize,
    offset: u64,
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    let owner = window.label().to_string();
    let session = native_archive_session(&app, &owner, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .read_chunk(entry_index, offset)
            .map(tauri::ipc::Response::new)
            .map_err(archive_fault_error)
    })
    .await
    .map_err(|error| format!("原生归档读取工作线程失败：{error}"))?
}

#[tauri::command]
pub async fn linked_library_archive_close(
    app: AppHandle,
    window: tauri::Window,
    session_id: String,
) -> Result<(), String> {
    let owner = window.label();
    let removed = {
        let state = app.state::<NativeArchiveState>();
        let mut sessions = state
            .0
            .lock()
            .map_err(|_| "原生归档会话表已损坏".to_string())?;
        match sessions.get(&session_id) {
            Some(entry) if entry.owner == owner => sessions.remove(&session_id),
            Some(_) => return Err("原生归档会话不属于当前窗口".to_string()),
            None => None,
        }
    };
    if let Some(entry) = removed {
        entry.session.close();
    }
    Ok(())
}

pub(crate) fn close_native_archive_window(app: &AppHandle, owner: &str) {
    let removed = {
        let state = app.state::<NativeArchiveState>();
        let Ok(mut sessions) = state.0.lock() else {
            return;
        };
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| sessions.remove(&id))
            .collect::<Vec<_>>()
    };
    for entry in removed {
        entry.session.close();
    }
}

pub(crate) fn close_all_native_archives(app: &AppHandle) {
    let removed = {
        let state = app.state::<NativeArchiveState>();
        let Ok(mut sessions) = state.0.lock() else {
            return;
        };
        sessions.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
    };
    for entry in removed {
        entry.session.close();
    }
}

#[tauri::command]
pub fn linked_library_relink(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
    source_path: String,
) -> Result<LinkedLibraryRecordView, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let path = canonical_epub_path(&source_path)?;
    let (actual_hash, hashed_snapshot) = hash_source_file(&path)?;
    if !actual_hash.eq_ignore_ascii_case(&content_hash) {
        return Err(LinkedLibraryError::new("relink-mismatch", "选择的 EPUB 内容与目标书籍不一致，未重新绑定"));
    }
    let metadata = inspect_epub(&path)?;
    if metadata.spine.is_empty() {
        return Err("EPUB OPF 没有可阅读的 spine 条目".into());
    }
    let final_snapshot = snapshot(&path)?;
    if final_snapshot.size != hashed_snapshot.size
        || final_snapshot.mtime_ns != hashed_snapshot.mtime_ns
    {
        return Err(LinkedLibraryError::changed("源 EPUB 在解析期间发生了变化，请重新定位"));
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    ensure_import_idle(&app)?;
    let root = library_root(&app)?;
    let records = load_records(&app)?;
    if !records
        .iter()
        .any(|record| record.content_hash == content_hash)
    {
        return Err("书库中没有这本书".into());
    }
    let mut bindings = load_bindings(&app)?;
    if let Some(existing) = bindings
        .iter()
        .find(|binding| binding.content_hash == content_hash)
    {
        if existing.storage_kind == StorageKind::Managed {
            return Err("managed 来源不能重新定位；请在 Android 上重新导入书籍".into());
        }
    }
    upsert_binding(
        &mut bindings,
        make_binding(content_hash.clone(), &path, final_snapshot, &metadata),
    );
    save_bindings(&app, &bindings)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash, &root)
        .ok_or_else(|| "重新定位后无法读取书籍记录".into())
}


#[tauri::command]
pub fn linked_library_update_progress(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
    last_read_at_ms: u64,
    spine_index: usize,
    page: usize,
    progress_pct: u32,
    anchor_index: Option<usize>,
    anchor_ratio: Option<f64>,
    anchor_text_offset: Option<u64>,
    anchor_text_snippet: Option<String>,
    media_anchor: Option<LinkedLibraryMediaAnchor>,
) -> Result<LinkedLibraryRecordView, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    if !valid_optional_ratio(anchor_ratio) {
        return Err("阅读锚点比例必须在 0 到 1 之间".into());
    }
    if !valid_optional_anchor_text(anchor_text_offset, &anchor_text_snippet) {
        return Err("阅读文本锚点无效".into());
    }
    if !valid_optional_media_anchor(&media_anchor) {
        return Err("阅读媒体锚点无效".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(&app)?;
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    apply_progress_update(
        record,
        last_read_at_ms,
        spine_index,
        page,
        progress_pct,
        anchor_index,
        anchor_ratio,
        anchor_text_offset,
        anchor_text_snippet,
        media_anchor,
    );
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash, &root)
        .ok_or_else(|| "更新进度后无法读取书籍记录".into())
}

#[tauri::command]
pub fn linked_library_mark_opened(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
) -> Result<LinkedLibraryRecordView, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(&app)?;
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    record.is_new = false;
    if crate::portable_state_commands::with_existing_store(&app, |store| {
        store.set_local_is_new(&content_hash, false)
    })
    .map_err(|error| error.to_string())?
    .is_none()
    {
        save_records_at(&root, &records)?;
    }
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash, &root)
        .ok_or_else(|| "更新打开状态后无法读取书籍记录".into())
}

#[tauri::command]
pub fn linked_library_update_bookmarks(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
    bookmarks: Vec<LinkedLibraryBookmark>,
) -> Result<LinkedLibraryRecordView, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    if bookmarks.iter().any(|bookmark| {
        !valid_optional_ratio(bookmark.anchor_ratio)
            || !valid_optional_anchor_text(
                bookmark.anchor_text_offset,
                &bookmark.anchor_text_snippet,
            )
            || !valid_optional_media_anchor(&bookmark.media_anchor)
    }) {
        return Err("书签锚点比例、文本锚点或媒体锚点无效".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(&app)?;
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    record.bookmarks = bookmarks;
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash, &root)
        .ok_or_else(|| "更新书签后无法读取书籍记录".into())
}

#[tauri::command]
pub fn linked_library_update_notes(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
    notes: Vec<LinkedLibraryNote>,
) -> Result<LinkedLibraryRecordView, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let mut ids = HashSet::with_capacity(notes.len());
    if notes
        .iter()
        .any(|note| !valid_note(note) || !ids.insert(note.id.clone()))
    {
        return Err("笔记数据无效或包含重复 ID".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(&app)?;
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    record.notes = notes;
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash, &root)
        .ok_or_else(|| "更新笔记后无法读取书籍记录".into())
}


/// Replaces only the portable state after the frontend has completed its
/// explicit archive merge. Bindings remain device-private and untouched.
#[tauri::command]
pub fn linked_library_replace_records(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    records: Vec<LinkedLibraryRecord>,
) -> Result<Vec<LinkedLibraryRecordView>, String> {
    validate_portable_records(&records)?;
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    ensure_import_idle(&app)?;
    let root = library_root(&app)?;
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    Ok(records
        .into_iter()
        .map(|record| {
            let hash = record.content_hash.clone();
            binding_view(
                record,
                bindings.iter().find(|binding| binding.content_hash == hash),
                thumbnails
                    .entries
                    .iter()
                    .find(|entry| entry.content_hash == hash)
                    .map(|entry| entry.mime.clone())
                    .unwrap_or_default(),
                &root,
            )
        })
        .collect())
}

#[tauri::command]
pub async fn linked_library_delete_record(
    app: AppHandle,
    content_hash: String,
) -> Result<(), String> {
    linked_library_delete_records(app, vec![content_hash]).await
}

#[tauri::command]
pub async fn linked_library_delete_records(
    app: AppHandle,
    content_hashes: Vec<String>,
) -> Result<(), String> {
    // SQLite FTS deletion and file writes must not run on the UI thread.
    tauri::async_runtime::spawn_blocking(move || delete_records(&app, content_hashes))
        .await
        .map_err(|error| format!("删除书籍任务失败：{error}"))?
}



#[tauri::command]
pub fn linked_library_thumbnail_read(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
) -> Result<tauri::ipc::Response, String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let path = thumbnail_path(&app, &content_hash)?;
    let mut index = load_thumbnail_index(&app)?;
    let Some(index_entry) = index
        .entries
        .iter()
        .find(|entry| entry.content_hash == content_hash)
    else {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| format!("无法清理孤立封面缓存：{error}"))?;
        }
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    if !matches!(index_entry.mime.as_str(), "image/jpeg" | "image/webp") {
        remove_thumbnail(&app, &mut index, &content_hash)?;
        save_thumbnail_index(&app, &index)?;
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            index
                .entries
                .retain(|entry| entry.content_hash != content_hash);
            save_thumbnail_index(&app, &index)?;
            return Ok(tauri::ipc::Response::new(Vec::new()));
        }
        Err(error) => return Err(format!("无法读取封面缓存属性：{error}")),
    };
    if size > MAX_THUMBNAIL_BYTES as u64 || size != index_entry.size {
        remove_thumbnail(&app, &mut index, &content_hash)?;
        save_thumbnail_index(&app, &index)?;
        return Err("封面缓存大小异常，已删除".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取封面缓存：{error}"))?;
    if let Some(entry) = index
        .entries
        .iter_mut()
        .find(|entry| entry.content_hash == content_hash)
    {
        let now = now_ms();
        if now.saturating_sub(entry.last_accessed_at_ms) >= THUMBNAIL_ACCESS_WRITE_INTERVAL_MS {
            entry.last_accessed_at_ms = now;
            save_thumbnail_index(&app, &index)?;
        }
    };
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn linked_library_thumbnail_write_raw(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let hash = request
        .headers()
        .get("x-content-hash")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !valid_content_hash(hash) {
        return Err("缺少或无效的 x-content-hash".into());
    }
    let mime = request
        .headers()
        .get("x-thumbnail-mime")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !matches!(mime, "image/jpeg" | "image/webp") {
        return Err("x-thumbnail-mime 必须是受支持的图片类型".into());
    }
    let bytes = crate::ipc_bytes::decode_request_bytes(
        request.body(),
        Some(MAX_THUMBNAIL_BYTES),
        "缩略图写入必须使用原始二进制",
    )?;
    if bytes.is_empty() || bytes.len() > MAX_THUMBNAIL_BYTES {
        return Err("缩略图大小无效".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    if !load_records(&app)?
        .iter()
        .any(|record| record.content_hash == hash)
    {
        return Err("书库中没有这本书，拒绝写入缓存".into());
    }
    let mut index = load_thumbnail_index(&app)?;
    if reconcile_thumbnail_cache(&app, &mut index)? {
        save_thumbnail_index(&app, &index)?;
    }
    atomic_write_bytes(&thumbnail_path(&app, hash)?, bytes.as_ref())?;
    index.entries.retain(|entry| entry.content_hash != hash);
    index.entries.push(ThumbnailEntry {
        content_hash: hash.into(),
        mime: mime.into(),
        size: bytes.len() as u64,
        last_accessed_at_ms: now_ms(),
    });
    prune_thumbnail_cache(&app, &mut index)?;
    save_thumbnail_index(&app, &index)
}

#[tauri::command]
pub fn linked_library_thumbnail_delete(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
) -> Result<(), String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let mut index = load_thumbnail_index(&app)?;
    remove_thumbnail(&app, &mut index, &content_hash)?;
    save_thumbnail_index(&app, &index)
}

// ---- 收藏与文件夹 ----
// 组织数据是独立 JSON（`library-organization.json`）：字段级逻辑时钟、文件夹
// 永久删除标记和原始归属都在同一个 envelope 里，读写沿用书库写互斥与原子替换。

/// `None` 表示还没有文件（新用户）；JSON 损坏或数据无效都是错误，绝不用空对象
/// 覆盖已有内容。
fn load_organization_file(path: &Path) -> Result<Option<OrganizationEnvelope>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let envelope: OrganizationEnvelope = serde_json::from_str(&text)
                .map_err(|error| format!("收藏与文件夹数据损坏：{error}"))?;
            library_organization::validate_envelope(&envelope)?;
            Ok(Some(envelope))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取收藏与文件夹数据：{error}")),
    }
}

fn save_organization_file(path: &Path, envelope: &OrganizationEnvelope) -> Result<(), String> {
    atomic_write_json(path, envelope)
}

/// 调用方必须持有书库写锁；新用户在同一把锁内只生成一次本机身份。
fn load_or_init_organization(app: &AppHandle) -> Result<OrganizationEnvelope, String> {
    load_or_init_organization_at(&organization_path(app)?)
}

fn load_or_init_organization_at(path: &Path) -> Result<OrganizationEnvelope, String> {
    match load_organization_file(path)? {
        Some(envelope) => Ok(envelope),
        None => {
            let envelope = OrganizationEnvelope {
                device_id: random_uuid_v4()?,
                counter: 0,
                state: library_organization::empty_organization(),
            };
            save_organization_file(path, &envelope)?;
            Ok(envelope)
        }
    }
}

/// 16 字节系统随机数的 UUID v4 小写规范形式；本机身份只在这里产生。
fn random_uuid_v4() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random_bytes(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut value = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            value.push('-');
        }
        value.push_str(&format!("{byte:02x}"));
    }
    Ok(value)
}

#[cfg(unix)]
fn fill_random_bytes(buffer: &mut [u8]) -> Result<(), String> {
    let mut source =
        File::open("/dev/urandom").map_err(|error| format!("无法读取系统随机数：{error}"))?;
    source
        .read_exact(buffer)
        .map_err(|error| format!("无法读取系统随机数：{error}"))
}

#[cfg(windows)]
fn fill_random_bytes(buffer: &mut [u8]) -> Result<(), String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut core::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    // SAFETY: the buffer is a valid writable slice for `length` bytes.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("无法取得系统随机数：NTSTATUS {status:#x}"))
    }
}

#[cfg(not(any(unix, windows)))]
fn fill_random_bytes(_buffer: &mut [u8]) -> Result<(), String> {
    Err("当前平台没有可用的系统随机数来源".into())
}

/// 返回最新完整 portable state：不含 envelope 顶层的 `deviceId`/`counter`（事件
/// stamp 里仍带这些字段）。首次调用会在写锁内初始化本机身份，因此和相邻命令一
/// 样放到阻塞池，避免等待书库写锁或磁盘时卡住调用线程。
#[tauri::command]
pub async fn linked_library_get_organization(
    app: AppHandle,
) -> Result<LibraryOrganization, String> {
    tauri::async_runtime::spawn_blocking(move || get_organization_state(&app))
        .await
        .map_err(|error| format!("读取收藏与文件夹任务失败：{error}"))?
}

fn get_organization_state(app: &AppHandle) -> Result<LibraryOrganization, String> {
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    Ok(load_or_init_organization(app)?.state)
}

#[tauri::command]
pub async fn linked_library_apply_organization(
    app: AppHandle,
    command: OrganizationCommand,
) -> Result<LibraryOrganization, String> {
    // File reads/writes stay off the UI thread, matching the delete commands.
    tauri::async_runtime::spawn_blocking(move || apply_organization_command(&app, command))
        .await
        .map_err(|error| format!("保存收藏与文件夹任务失败：{error}"))?
}

fn apply_organization_command(
    app: &AppHandle,
    command: OrganizationCommand,
) -> Result<LibraryOrganization, String> {
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let envelope = load_or_init_organization(app)?;
    // One batch reads the book records once and commits all hashes or none.
    let known_hashes: HashSet<String> = load_records(app)?
        .into_iter()
        .map(|record| record.content_hash)
        .collect();
    let updated = library_organization::apply_command(&envelope, &command, &known_hashes)?;
    if updated != envelope {
        save_organization_file(&organization_path(app)?, &updated)?;
    }
    Ok(updated.state)
}

#[tauri::command]
pub async fn linked_library_merge_organization(
    app: AppHandle,
    incoming: LibraryOrganization,
) -> Result<LibraryOrganization, String> {
    tauri::async_runtime::spawn_blocking(move || merge_organization_command(&app, incoming))
        .await
        .map_err(|error| format!("合并收藏与文件夹任务失败：{error}"))?
}

fn merge_organization_command(
    app: &AppHandle,
    incoming: LibraryOrganization,
) -> Result<LibraryOrganization, String> {
    library_organization::validate_organization(&incoming)?;
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    // Re-read the latest state under the lock: records may have been imported
    // before this second step and the local clock must not go backwards.
    let local = load_or_init_organization(app)?;
    let merged = library_organization::merge_into_envelope(&local, &incoming)?;
    if merged != local {
        save_organization_file(&organization_path(app)?, &merged)?;
    }
    Ok(merged.state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_error_wire_keeps_codes_separate_from_message_text() {
        let error = archive_fault_error(Fault::SourceChanged);
        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire["code"], "source-changed");
        assert!(wire["message"].as_str().unwrap().contains("源 EPUB"));
        let generic: LinkedLibraryError = "源 EPUB 在一条未知外部信息里发生了变化".into();
        assert_eq!(generic.code, "failed");
        assert_eq!(source_open_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).code, "failed");
    }

    #[test]
    fn source_error_missing_binding_is_proven_at_lookup() {
        let root = organization_temp_dir("source-error-unbound");
        let hash = "a".repeat(64);
        let records = vec![bk2_record(&hash, 77)];
        assert_eq!(prepare_source_read(&root, &records, &[], &hash).err().unwrap().code, "source-unbound");
        assert_eq!(prepare_source_read(&root, &[], &[], &hash).err().unwrap().code, "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn source_protection_open_distinguishes_missing_and_permission_failures() {
        use std::os::unix::fs::PermissionsExt;

        let root = organization_temp_dir("source-protection-open");
        let path = root.join("book.epub");
        fs::write(&path, b"source-protection").unwrap();
        let hash = hash_bytes(b"source-protection");
        let records = vec![bk2_record(&hash, 77)];
        let bindings = vec![sample_linked_binding(&hash, &path, snapshot(&path).unwrap())];
        assert!(prepare_source_read(&root, &records, &bindings, &hash).is_ok());

        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let denied = prepare_source_read(&root, &records, &bindings, &hash).err();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let denied = denied.expect("unreadable source must fail");
        assert_eq!(denied.code, "failed");
        assert!(denied.message.starts_with("无法打开源 EPUB："));
        assert!(!denied.message.contains("变化或丢失"));

        fs::remove_file(&path).unwrap();
        let missing = prepare_source_read(&root, &records, &bindings, &hash).err().unwrap();
        assert_eq!(missing.code, "source-missing");
        assert_eq!(missing.message, "源 EPUB 已变化或丢失；请重新导入或重新定位");
        assert_eq!(records[0].progress_pct, 77);
        fs::remove_dir_all(root).unwrap();
    }

    fn binding_json_value() -> serde_json::Value {
        let source = std::env::temp_dir().join("legacy-linked.epub");
        serde_json::json!({
            "contentHash": "a".repeat(64),
            "canonicalSourcePath": source.to_string_lossy(),
            "fileSize": 12,
            "sourceMtimeNs": 34,
            "coverZipPath": null,
            "coverMime": "image/jpeg",
            "lastVerifiedAtMs": 56,
        })
    }

    fn sample_managed_binding(hash: &str, snapshot: FileSnapshot) -> DeviceBinding {
        DeviceBinding {
            content_hash: hash.into(),
            storage_kind: StorageKind::Managed,
            canonical_source_path: None,
            file_size: snapshot.size,
            source_mtime_ns: snapshot.mtime_ns,
            cover_zip_path: None,
            cover_mime: "image/jpeg".into(),
            last_verified_at_ms: 0,
        }
    }

    fn sample_linked_binding(hash: &str, path: &Path, snapshot: FileSnapshot) -> DeviceBinding {
        DeviceBinding {
            content_hash: hash.into(),
            storage_kind: StorageKind::Linked,
            canonical_source_path: Some(path.to_string_lossy().into_owned()),
            file_size: snapshot.size,
            source_mtime_ns: snapshot.mtime_ns,
            cover_zip_path: None,
            cover_mime: String::new(),
            last_verified_at_ms: 0,
        }
    }

    fn write_test_cover_zip(path: &Path, cover: &[u8]) {
        use std::io::Write as _;

        let file = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("OPS/cover.jpg", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(cover).unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn bk1_legacy_binding_without_storage_kind_is_linked_and_keeps_path() {
        let expected_path = std::env::temp_dir().join("legacy-linked.epub");
        let value = binding_json_value();
        let binding: DeviceBinding = serde_json::from_value(value).unwrap();
        assert_eq!(binding.storage_kind, StorageKind::Linked);
        assert_eq!(
            binding.resolve_source(&std::env::temp_dir()).unwrap(),
            BindingSource::Linked(expected_path)
        );

        let serialized = serde_json::to_value(&binding).unwrap();
        assert_eq!(serialized["storageKind"], "linked");
        assert!(serialized.get("canonicalSourcePath").is_some());
    }

    #[test]
    fn bk1_explicit_null_or_unknown_storage_kind_is_rejected() {
        let mut explicit_null = binding_json_value();
        explicit_null["storageKind"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<DeviceBinding>(explicit_null).is_err());

        let mut unknown = binding_json_value();
        unknown["storageKind"] = serde_json::json!("cloud");
        assert!(serde_json::from_value::<DeviceBinding>(unknown).is_err());
    }

    #[test]
    fn bk1_binding_source_shape_is_validated_by_storage_kind() {
        let root = std::env::temp_dir();

        let mut linked_missing_path = binding_json_value();
        linked_missing_path["storageKind"] = serde_json::json!("linked");
        linked_missing_path
            .as_object_mut()
            .unwrap()
            .remove("canonicalSourcePath");
        let linked_missing_path: DeviceBinding =
            serde_json::from_value(linked_missing_path).unwrap();
        assert!(linked_missing_path.resolve_source(&root).is_err());

        let mut linked_relative_path = binding_json_value();
        linked_relative_path["storageKind"] = serde_json::json!("linked");
        linked_relative_path["canonicalSourcePath"] = serde_json::json!("books/relative.epub");
        let linked_relative_path: DeviceBinding =
            serde_json::from_value(linked_relative_path).unwrap();
        assert!(linked_relative_path.resolve_source(&root).is_err());

        let hash = "a".repeat(64);
        let mut managed_with_path = binding_json_value();
        managed_with_path["storageKind"] = serde_json::json!("managed");
        let managed_with_path: DeviceBinding = serde_json::from_value(managed_with_path).unwrap();
        assert!(managed_with_path.resolve_source(&root).is_err());

        let mut managed_without_path = binding_json_value();
        managed_without_path["storageKind"] = serde_json::json!("managed");
        managed_without_path
            .as_object_mut()
            .unwrap()
            .remove("canonicalSourcePath");
        let managed_without_path: DeviceBinding =
            serde_json::from_value(managed_without_path).unwrap();
        assert_eq!(
            managed_without_path.resolve_source(&root).unwrap(),
            BindingSource::Managed(root.join("books").join(format!("{hash}.epub")))
        );

        let mut managed_bad_hash = binding_json_value();
        managed_bad_hash["storageKind"] = serde_json::json!("managed");
        managed_bad_hash["contentHash"] = serde_json::json!("A".repeat(64));
        managed_bad_hash
            .as_object_mut()
            .unwrap()
            .remove("canonicalSourcePath");
        let managed_bad_hash: DeviceBinding = serde_json::from_value(managed_bad_hash).unwrap();
        assert!(managed_bad_hash.resolve_source(&root).is_err());
    }

    #[test]
    fn bk1_managed_binding_serializes_without_a_persisted_path_and_round_trips() {
        let root = std::env::temp_dir();
        let hash = "b".repeat(64);
        let binding = DeviceBinding {
            content_hash: hash.clone(),
            storage_kind: StorageKind::Managed,
            canonical_source_path: None,
            file_size: 1,
            source_mtime_ns: 2,
            cover_zip_path: None,
            cover_mime: "image/jpeg".into(),
            last_verified_at_ms: 3,
        };
        let serialized = serde_json::to_value(&binding).unwrap();
        assert_eq!(serialized["storageKind"], "managed");
        assert!(serialized.get("canonicalSourcePath").is_none());
        assert_eq!(
            binding.resolve_source(&root).unwrap(),
            BindingSource::Managed(root.join("books").join(format!("{hash}.epub")))
        );
        let round_trip: DeviceBinding = serde_json::from_value(serialized).unwrap();
        assert_eq!(round_trip, binding);
    }

    #[test]
    fn bk1_managed_verify_reads_only_the_derived_library_path() {
        let root = organization_temp_dir("managed-source");
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let hash = "c".repeat(64);
        let path = books.join(format!("{hash}.epub"));
        fs::write(&path, b"epub-bytes").unwrap();
        let snapshot = snapshot(&path).unwrap();
        let mut binding = sample_managed_binding(&hash, snapshot);
        let verification = verify_binding(&mut binding, &root).unwrap();
        assert!(verification.available);
        assert!(!verification.changed);
        assert_eq!(
            binding.resolve_source(&root).unwrap().path(),
            path.as_path()
        );
        let _ = fs::remove_dir_all(&root);
    }





    #[test]
    fn linked_library_hashes_are_lowercase_only() {
        assert!(valid_content_hash(&"a".repeat(64)));
        assert!(!valid_content_hash(&"A".repeat(64)));
        assert!(!valid_content_hash(&"g".repeat(64)));
    }

    #[test]
    fn portable_text_anchors_are_bounded_unicode_code_points() {
        assert!(valid_optional_anchor_text(Some(7), &Some("😀正文".into())));
        assert!(valid_optional_anchor_text(None, &None));
        assert!(!valid_optional_anchor_text(None, &Some("正文".into())));
        assert!(!valid_optional_anchor_text(
            Some(1),
            &Some("has space".into())
        ));
        assert!(!valid_optional_anchor_text(
            Some(1),
            &Some("😀".repeat(MAX_ANCHOR_SNIPPET_CODE_POINTS + 1)),
        ));
        assert!(!valid_optional_anchor_text(
            MAX_ANCHOR_TEXT_OFFSET.checked_add(1),
            &None
        ));
    }







    #[test]
    fn records_do_not_serialize_device_path() {
        let record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: "zh-CN".into(),
            file_name: "book.epub".into(),
            added_at_ms: 1,
            last_read_at_ms: 1,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("sourcePath"));
        assert!(!json.contains("canonicalSourcePath"));
    }

    #[test]
    fn media_anchor_roundtrips_through_record_dto() {
        let mut record = bk2_record(&"a".repeat(64), 0);
        record.media_anchor = Some(LinkedLibraryMediaAnchor {
            index: 1,
            tag: "img".to_string(),
            signature: "img|cover".to_string(),
            ratio: 0.25,
        });
        record.bookmarks[0].media_anchor = Some(LinkedLibraryMediaAnchor {
            index: 2,
            tag: "svg".to_string(),
            signature: "svg|figure".to_string(),
            ratio: 0.75,
        });
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("\"mediaAnchor\""));
        let restored: LinkedLibraryRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.media_anchor, record.media_anchor);
        assert_eq!(
            restored.bookmarks[0].media_anchor,
            record.bookmarks[0].media_anchor
        );
    }

    #[test]
    fn old_records_without_language_default_to_empty_string() {
        let json = format!(
            r#"{{"contentHash":"{}","title":"T","creator":"C","fileName":"book.epub","addedAtMs":1,"lastReadAtMs":1,"spineIndex":0,"page":0,"progressPct":0,"anchorIndex":null,"anchorRatio":null,"isNew":true}}"#,
            "a".repeat(64)
        );
        let record: LinkedLibraryRecord = serde_json::from_str(&json).unwrap();
        assert!(record.language.is_empty());
    }

    #[test]
    fn progress_update_clears_new_mark_and_preserves_position() {
        let mut record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: String::new(),
            file_name: "book.epub".into(),
            added_at_ms: 10,
            last_read_at_ms: 0,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        apply_progress_update(
            &mut record,
            20,
            2,
            3,
            101,
            Some(4),
            Some(0.5),
            Some(7),
            Some("正文".into()),
            None,
        );
        assert_eq!(record.last_read_at_ms, 20);
        assert_eq!(record.spine_index, 2);
        assert_eq!(record.page, 3);
        assert_eq!(record.progress_pct, 100);
        assert_eq!(record.anchor_index, Some(4));
        assert!(!record.is_new);
    }

    #[test]
    fn notes_validate_unicode_range_and_limits() {
        let valid = LinkedLibraryNote {
            id: "note-1".into(),
            spine_index: 2,
            chapter_path: "Text/chapter.xhtml".into(),
            start_text_offset: 10,
            end_text_offset: 14,
            start_text_snippet: "开始文字".into(),
            end_text_snippet: "结束文字".into(),
            selected_text: "开始 文字".into(),
            content: "值得回看".into(),
            created_at_ms: 100,
            updated_at_ms: 100,
        };
        assert!(valid_note(&valid));
        let mut invalid = valid.clone();
        invalid.end_text_offset = 13;
        assert!(!valid_note(&invalid));
        invalid = valid.clone();
        invalid.end_text_snippet = "有 空格".into();
        assert!(!valid_note(&invalid));
        invalid = valid;
        invalid.content = "x".repeat(MAX_NOTE_CONTENT_CODE_POINTS + 1);
        assert!(!valid_note(&invalid));
        invalid = LinkedLibraryNote {
            id: " \t".into(),
            spine_index: 2,
            chapter_path: "Text/chapter.xhtml".into(),
            start_text_offset: 10,
            end_text_offset: 14,
            start_text_snippet: "开始文字".into(),
            end_text_snippet: "结束文字".into(),
            selected_text: "开始 文字".into(),
            content: "值得回看".into(),
            created_at_ms: 100,
            updated_at_ms: 100,
        };
        assert!(!valid_note(&invalid));
        invalid.id = "note-1".into();
        invalid.chapter_path = " \n".into();
        assert!(!valid_note(&invalid));
        invalid.chapter_path = "Text/chapter.xhtml".into();
        invalid.content = " \n".into();
        assert!(!valid_note(&invalid));
    }

    #[test]
    fn portable_replace_rejects_duplicate_or_invalid_progress() {
        let mut record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: String::new(),
            file_name: "book.epub".into(),
            added_at_ms: 1,
            last_read_at_ms: 1,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        assert!(validate_portable_records(&[record.clone()]).is_ok());
        assert!(validate_portable_records(&[record.clone(), record.clone()]).is_err());
        record.progress_pct = 101;
        assert!(validate_portable_records(&[record]).is_err());
    }

    #[test]
    fn portable_records_reject_device_paths_and_invalid_ratios() {
        let mut record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: String::new(),
            file_name: "C:\\Books\\book.epub".into(),
            added_at_ms: 1,
            last_read_at_ms: 1,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        assert!(validate_portable_records(&[record.clone()]).is_err());
        record.file_name = "book.epub".into();
        record.anchor_ratio = Some(1.5);
        assert!(validate_portable_records(&[record]).is_err());
    }

    #[test]
    fn thumbnail_cache_only_recognizes_valid_hash_files() {
        let hash = "a".repeat(64);
        assert_eq!(
            thumbnail_hash_from_file_name(&format!("{hash}.thumb")),
            Some(hash.as_str())
        );
        assert_eq!(thumbnail_hash_from_file_name(&format!("{hash}.tmp")), None);
        assert_eq!(thumbnail_hash_from_file_name("index.json"), None);
        assert_eq!(thumbnail_hash_from_file_name("AA.thumb"), None);
    }

    const TEST_DEVICE_ID: &str = "0a0a0a0a-0000-4000-8000-00000000000a";

    /// 每个用例自己的临时目录，避免和真实书库文件或并发用例互相影响。
    fn organization_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "epub-reader-organization-{label}-{}-{}",
            std::process::id(),
            TEMP_FILE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_organization(counter: u64, content_hash: &str, value: bool) -> OrganizationEnvelope {
        let mut state = library_organization::empty_organization();
        state.books.insert(
            content_hash.to_string(),
            library_organization::BookOrganization {
                favorite: Some(library_organization::Register {
                    value,
                    stamp: library_organization::Stamp {
                        counter: 1,
                        device_id: TEST_DEVICE_ID.into(),
                    },
                }),
                folder_id: None,
            },
        );
        OrganizationEnvelope {
            device_id: TEST_DEVICE_ID.into(),
            counter,
            state,
        }
    }

    #[test]
    fn organization_file_missing_reads_none_and_round_trips() {
        let dir = organization_temp_dir("round-trip");
        let path = dir.join("library-organization.json");
        assert!(load_organization_file(&path).unwrap().is_none());
        let envelope = sample_organization(4, &"a".repeat(64), true);
        save_organization_file(&path, &envelope).unwrap();
        assert_eq!(load_organization_file(&path).unwrap(), Some(envelope));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_or_invalid_organization_file_is_an_error_and_is_not_replaced() {
        let dir = organization_temp_dir("corrupt");
        let path = dir.join("library-organization.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(load_organization_file(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        // An unknown schema version is corrupt data, not an empty organization.
        let wrong_version = format!(
            r#"{{"deviceId":"{TEST_DEVICE_ID}","counter":0,"state":{{"schemaVersion":2,"folders":{{}},"books":{{}}}}}}"#
        );
        fs::write(&path, &wrong_version).unwrap();
        assert!(load_organization_file(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), wrong_version);
        // A zero clock in a register is rejected at the storage boundary.
        let bad_stamp = format!(
            r#"{{"deviceId":"{TEST_DEVICE_ID}","counter":0,"state":{{"schemaVersion":1,"folders":{{}},"books":{{"{}":{{"favorite":{{"value":true,"stamp":{{"counter":0,"deviceId":"{TEST_DEVICE_ID}"}}}}}}}}}}}}"#,
            "a".repeat(64)
        );
        fs::write(&path, &bad_stamp).unwrap();
        assert!(load_organization_file(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 缺失的字段和显式 `null` 不是同一种数据：坏文件必须报错并保持逐字节不变，
    /// 只有内层 `folderId.value:null`（明确移出到未归类）和字段省略才合法。
    #[test]
    fn organization_file_rejects_json_null_optional_objects_byte_for_byte() {
        const FOLDER_ID: &str = "00000000-0000-4000-8000-0000000000f0";
        let dir = organization_temp_dir("null-optional");
        let path = dir.join("library-organization.json");
        let hash = "a".repeat(64);
        let empty_state = serde_json::json!({
            "schemaVersion": 1,
            "folders": {},
            "books": {},
        });
        let book_slot = |book: serde_json::Value| {
            let mut envelope = serde_json::json!({
                "deviceId": TEST_DEVICE_ID,
                "counter": 9,
                "state": empty_state.clone(),
            });
            envelope["state"]["books"][hash.as_str()] = book;
            envelope
        };
        // A newer register with no value must not update the stored ownership.
        let missing_value = book_slot(
            serde_json::json!({"folderId": {"stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}}}),
        );
        let favorite_null = book_slot(serde_json::json!({"favorite": null}));
        let folder_id_null = book_slot(serde_json::json!({"folderId": null}));
        let deleted_null = serde_json::json!({
            "deviceId": TEST_DEVICE_ID,
            "counter": 1,
            "state": {
                "schemaVersion": 1,
                "folders": {
                    "00000000-0000-4000-8000-0000000000f0": {
                        "name": {"value": "科幻", "stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}},
                        "deleted": null,
                    }
                },
                "books": {},
            },
        });
        let cases = [
            missing_value.to_string(),
            favorite_null.to_string(),
            folder_id_null.to_string(),
            deleted_null.to_string(),
        ];
        for case in cases {
            fs::write(&path, &case).unwrap();
            assert!(load_organization_file(&path).is_err(), "应当拒绝：{case}");
            assert_eq!(fs::read_to_string(&path).unwrap(), case);
        }
        // Omitted optional objects and an explicit inner null stay valid.
        let mut valid = serde_json::json!({
            "deviceId": TEST_DEVICE_ID,
            "counter": 9,
            "state": empty_state.clone(),
        });
        valid["state"]["folders"][FOLDER_ID] = serde_json::json!({
            "name": {"value": "科幻", "stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}}
        });
        valid["state"]["books"][hash.as_str()] = serde_json::json!({
            "folderId": {"value": null, "stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}}
        });
        let valid = valid.to_string();
        fs::write(&path, &valid).unwrap();
        let loaded = load_organization_file(&path).unwrap().unwrap();
        assert_eq!(loaded.state.folders[FOLDER_ID].deleted, None);
        assert_eq!(loaded.state.books[&hash].favorite, None);
        assert_eq!(
            loaded.state.books[&hash].folder_id.as_ref().unwrap().value,
            None
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 首次调用创建身份并落盘，之后每次调用都复用同一个身份，不重新生成也不改写文件。
    #[test]
    fn organization_is_initialized_once_and_never_regenerated() {
        let dir = organization_temp_dir("init-once");
        let path = dir.join("library-organization.json");
        let first = load_or_init_organization_at(&path).unwrap();
        assert!(library_organization::valid_canonical_uuid(&first.device_id));
        assert_eq!(first.counter, 0);
        assert_eq!(first.state, library_organization::empty_organization());
        let written = fs::read_to_string(&path).unwrap();
        let second = load_or_init_organization_at(&path).unwrap();
        assert_eq!(second, first);
        assert_eq!(fs::read_to_string(&path).unwrap(), written);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn failed_organization_write_keeps_the_previous_file() {
        use std::os::unix::fs::PermissionsExt;

        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            if fs::metadata("/proc/self")
                .map(|meta| meta.uid())
                .unwrap_or(1)
                == 0
            {
                // Root ignores the read-only directory, so the failure cannot be provoked.
                return;
            }
        }
        let dir = organization_temp_dir("write-failure");
        let path = dir.join("library-organization.json");
        let hash = "a".repeat(64);
        let original = sample_organization(2, &hash, true);
        save_organization_file(&path, &original).unwrap();
        let mut permissions = fs::metadata(&dir).unwrap().permissions();
        let original_mode = permissions.mode();
        permissions.set_mode(0o555);
        fs::set_permissions(&dir, permissions.clone()).unwrap();
        let failed = save_organization_file(&path, &sample_organization(9, &hash, false));
        permissions.set_mode(original_mode);
        fs::set_permissions(&dir, permissions).unwrap();
        assert!(failed.is_err());
        assert_eq!(load_organization_file(&path).unwrap(), Some(original));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn organization_counter_continues_after_reload() {
        let dir = organization_temp_dir("reload");
        let path = dir.join("library-organization.json");
        let hash = "a".repeat(64);
        save_organization_file(&path, &sample_organization(0, &hash, true)).unwrap();
        let first = {
            let loaded = load_organization_file(&path).unwrap().unwrap();
            let updated = library_organization::apply_command(
                &loaded,
                &OrganizationCommand::SetFavorite {
                    content_hashes: vec![hash.clone()],
                    value: false,
                },
                &HashSet::from([hash.clone()]),
            )
            .unwrap();
            save_organization_file(&path, &updated).unwrap();
            updated
        };
        // A restart reloads the file and must continue the clock, not reset it.
        let second = {
            let reloaded = load_organization_file(&path).unwrap().unwrap();
            library_organization::apply_command(
                &reloaded,
                &OrganizationCommand::SetFavorite {
                    content_hashes: vec![hash.clone()],
                    value: true,
                },
                &HashSet::from([hash.clone()]),
            )
            .unwrap()
        };
        assert_eq!(second.counter, first.counter + 1);
        assert_eq!(second.device_id, TEST_DEVICE_ID);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn device_identity_is_a_fresh_canonical_uuid_v4() {
        let first = random_uuid_v4().unwrap();
        let second = random_uuid_v4().unwrap();
        assert!(library_organization::valid_canonical_uuid(&first));
        assert_eq!(first.as_bytes()[14], b'4');
        assert_ne!(first, second);
    }
    #[test]
    fn bk2_document_request_validation_rejects_invalid_whole_requests() {
        assert!(validate_document_request(
            "req-1",
            &[DocumentSelection {
                uri: "content://provider/book.epub".into(),
                file_name: Some("book.epub".into()),
            }],
        )
        .is_ok());

        let missing_id = validate_document_request(
            " ",
            &[DocumentSelection {
                uri: "content://provider/book.epub".into(),
                file_name: None,
            }],
        )
        .unwrap_err();
        assert_eq!(missing_id.code, "invalid_request");

        let empty = validate_document_request("req-1", &[]).unwrap_err();
        assert_eq!(empty.code, "invalid_request");

        let non_content = validate_document_request(
            "req-1",
            &[DocumentSelection {
                uri: "/sdcard/book.epub".into(),
                file_name: None,
            }],
        )
        .unwrap_err();
        assert_eq!(non_content.code, "invalid_request");

        let path_name = validate_document_request(
            "req-1",
            &[DocumentSelection {
                uri: "content://provider/book.epub".into(),
                file_name: Some("../book.epub".into()),
            }],
        )
        .unwrap_err();
        assert_eq!(path_name.code, "invalid_request");
    }

    #[cfg(unix)]
    #[test]
    fn bk2_streaming_reader_hashes_only_the_declared_range() {
        use std::os::unix::io::IntoRawFd;

        let root = organization_temp_dir("bk2-stream-range");
        let source = root.join("source.bin");
        fs::write(&source, b"0123456789").unwrap();
        let staging = root.join("staged-range.part");
        let file = File::open(&source).unwrap();
        let mut reader = RestrictedReader::from_raw_fd(file.into_raw_fd(), 3, 4).unwrap();

        let staged = stream_restricted_reader_to_staging(&mut reader, &staging, &|| false).unwrap();
        assert_eq!(staged.content_hash, hash_bytes(b"3456"));
        assert_eq!(fs::read(&staging).unwrap(), b"3456");
        let file_snapshot = snapshot(&staging).unwrap();
        assert_eq!(file_snapshot.size, 4);
        assert_eq!(file_snapshot.mtime_ns, snapshot(&staging).unwrap().mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn bk2_cancel_after_final_read_prevents_staging_success() {
        use std::os::unix::io::IntoRawFd;
        use std::sync::atomic::AtomicUsize;

        let root = organization_temp_dir("bk2-final-cancel");
        let source = root.join("one-byte.bin");
        fs::write(&source, b"x").unwrap();
        let staging = root.join("staged-cancel.part");
        let file = File::open(&source).unwrap();
        let mut reader = RestrictedReader::from_raw_fd(file.into_raw_fd(), 0, 1).unwrap();

        // `copy_limited_to` checks cancellation before the single read; the
        // import layer must check once more after a successful copy to catch a
        // cancel requested during the final read. Returning false only on the
        // first call models exactly that race.
        let calls = AtomicUsize::new(0);
        let error = stream_restricted_reader_to_staging(&mut reader, &staging, &|| {
            calls.fetch_add(1, Ordering::SeqCst) >= 4
        })
        .unwrap_err();
        match error {
            PrepareError::Cancelled { content_hash } => {
                assert_eq!(content_hash.as_deref(), Some(hash_bytes(b"x").as_str()));
            }
            other => panic!("unexpected prepare error: {other:?}"),
        }
        assert!(staging.exists());

        let _ = fs::remove_dir_all(&root);
    }

    fn bk2_prepared_document(
        root: &Path,
        content_hash: &str,
        input_index: usize,
        bytes: &[u8],
        title: &str,
    ) -> PreparedDocument {
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let staging_path = books.join(format!("{content_hash}.{input_index}.part"));
        fs::write(&staging_path, bytes).unwrap();
        PreparedDocument {
            input_index,
            content_hash: content_hash.to_string(),
            staging_path,
            file_name: "book.epub".to_string(),
            metadata: ImportedMetadata {
                title: title.to_string(),
                creator: "Author".to_string(),
                language: "zh-CN".to_string(),
                spine: vec!["Text/chapter.xhtml".to_string()],
                cover_zip_path: None,
                cover_mime: String::new(),
            },
        }
    }

    fn bk2_record(hash: &str, progress: u32) -> LinkedLibraryRecord {
        LinkedLibraryRecord {
            content_hash: hash.to_string(),
            title: "Latest title".to_string(),
            creator: "Latest author".to_string(),
            language: "zh".to_string(),
            file_name: "latest.epub".to_string(),
            added_at_ms: 10,
            last_read_at_ms: 20,
            spine_index: 2,
            page: 3,
            progress_pct: progress,
            anchor_index: Some(4),
            anchor_ratio: Some(0.5),
            anchor_text_offset: Some(7),
            anchor_text_snippet: Some("正文".to_string()),
            media_anchor: None,
            bookmarks: vec![LinkedLibraryBookmark {
                id: "bookmark-1".to_string(),
                spine_index: 2,
                page: 3,
                anchor_index: None,
                anchor_ratio: None,
                anchor_text_offset: None,
                anchor_text_snippet: None,
                media_anchor: None,
                text: "mark".to_string(),
                created_at_ms: 11,
            }],
            notes: vec![LinkedLibraryNote {
                id: "note-1".to_string(),
                spine_index: 2,
                chapter_path: "Text/chapter.xhtml".to_string(),
                start_text_offset: 10,
                end_text_offset: 11,
                start_text_snippet: "a".to_string(),
                end_text_snippet: "b".to_string(),
                selected_text: "a".to_string(),
                content: "note".to_string(),
                created_at_ms: 11,
                updated_at_ms: 11,
            }],
            is_new: false,
        }
    }

    #[test]
    fn bk2_publish_duplicate_keeps_latest_record_and_replaces_managed_file() {
        let root = organization_temp_dir("bk2-publish-duplicate");
        let hash = "b".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, b"old-bytes").unwrap();
        let old_snapshot = snapshot(&target).unwrap();

        let mut records = vec![bk2_record(&hash, 77)];
        let mut bindings = vec![DeviceBinding {
            content_hash: hash.clone(),
            storage_kind: StorageKind::Managed,
            canonical_source_path: None,
            file_size: old_snapshot.size,
            source_mtime_ns: old_snapshot.mtime_ns,
            cover_zip_path: None,
            cover_mime: "image/jpeg".to_string(),
            last_verified_at_ms: 1,
        }];
        let document = bk2_prepared_document(&root, &hash, 0, b"new-bytes", "New title");

        let outcome = publish_prepared_documents(
            &root,
            &mut records,
            &mut bindings,
            &[PreparedItem::Ready(document)],
        )
        .unwrap();

        assert_eq!(
            outcome.statuses.get(&hash).map(String::as_str),
            Some("duplicate")
        );
        assert!(outcome.failures.is_empty());
        assert!(!outcome.records_changed);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].progress_pct, 77);
        assert_eq!(records[0].title, "Latest title");
        assert_eq!(records[0].bookmarks.len(), 1);
        assert_eq!(records[0].notes.len(), 1);
        assert_eq!(records[0].notes[0].content, "note");
        assert_eq!(fs::read(&target).unwrap(), b"new-bytes");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].storage_kind, StorageKind::Managed);
        assert!(bindings[0].canonical_source_path.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_publish_same_batch_hash_once_and_marks_duplicates() {
        let root = organization_temp_dir("bk2-publish-same-batch");
        let bytes = b"same bytes";
        let hash = hash_bytes(bytes);
        let mut records = Vec::new();
        let mut bindings = Vec::new();
        let prepared = vec![
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 0, bytes, "First")),
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, bytes, "Second")),
        ];
        let second_staging = match &prepared[1] {
            PreparedItem::Ready(document) => document.staging_path.clone(),
            _ => unreachable!(),
        };

        let outcome =
            publish_prepared_documents(&root, &mut records, &mut bindings, &prepared).unwrap();
        let result = build_committed_results(
            prepared,
            outcome,
            &records,
            &bindings,
            &ThumbnailIndex::default(),
            &root,
        );

        assert_eq!(result.results.len(), 2);
        assert_eq!(result.results[0].input_index, 0);
        assert_eq!(result.results[0].status, "saved");
        assert_eq!(
            result.results[0].content_hash.as_deref(),
            Some(hash.as_str())
        );
        assert!(result.results[0].record.is_some());
        assert_eq!(result.results[1].input_index, 1);
        assert_eq!(result.results[1].status, "duplicate");
        assert_eq!(
            result.results[1].content_hash.as_deref(),
            Some(hash.as_str())
        );
        assert!(result.results[1].record.is_some());

        assert_eq!(records.len(), 1);
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            fs::read(root.join("books").join(format!("{hash}.epub")))
                .unwrap()
                .as_slice(),
            bytes.as_slice()
        );
        // The duplicate input's staging is intentionally still present; the
        // task guard owns its cleanup in the real pipeline.
        assert!(second_staging.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_committed_results_existing_hash_returns_duplicate_for_each_input() {
        let root = organization_temp_dir("bk2-existing-hash-duplicates");
        let bytes = b"existing bytes";
        let hash = hash_bytes(bytes);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, bytes).unwrap();
        let target_snapshot = snapshot(&target).unwrap();

        let mut records = vec![bk2_record(&hash, 66)];
        let mut bindings = vec![sample_managed_binding(&hash, target_snapshot)];
        let prepared = vec![
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 0, bytes, "Existing A")),
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, bytes, "Existing B")),
        ];

        let outcome =
            publish_prepared_documents(&root, &mut records, &mut bindings, &prepared).unwrap();
        let result = build_committed_results(
            prepared,
            outcome,
            &records,
            &bindings,
            &ThumbnailIndex::default(),
            &root,
        );

        assert_eq!(result.results.len(), 2);
        assert_eq!(result.results[0].status, "duplicate");
        assert_eq!(result.results[1].status, "duplicate");
        assert!(result.results[0].record.is_some());
        assert!(result.results[1].record.is_some());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].progress_pct, 66);
        assert_eq!(bindings.len(), 1);
        assert_eq!(fs::read(&target).unwrap().as_slice(), bytes.as_slice());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_committed_results_same_hash_publish_failure_returns_failed_for_each_input() {
        let root = organization_temp_dir("bk2-same-hash-publish-failure");
        let bytes = b"failure bytes";
        let hash = hash_bytes(bytes);
        let mut records = Vec::new();
        let mut bindings = Vec::new();
        let prepared = vec![
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 0, bytes, "First")),
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, bytes, "Second")),
        ];
        let first_staging = match &prepared[0] {
            PreparedItem::Ready(document) => document.staging_path.clone(),
            _ => unreachable!(),
        };
        fs::remove_file(&first_staging).unwrap();

        let outcome =
            publish_prepared_documents(&root, &mut records, &mut bindings, &prepared).unwrap();
        let result = build_committed_results(
            prepared,
            outcome,
            &records,
            &bindings,
            &ThumbnailIndex::default(),
            &root,
        );

        assert_eq!(result.results.len(), 2);
        for item in &result.results {
            assert_eq!(item.status, "failed");
            assert_eq!(item.content_hash.as_deref(), Some(hash.as_str()));
            assert!(item.record.is_none());
            assert!(item
                .error
                .as_deref()
                .unwrap_or("")
                .contains("无法发布正式副本"));
        }
        assert!(records.is_empty());
        assert!(bindings.is_empty());
        assert!(!root.join("books").join(format!("{hash}.epub")).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_persist_import_indexes_reports_records_failure_without_rollback() {
        let root = organization_temp_dir("bk2-record-write-failure");
        let hash = "a".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, b"published book").unwrap();
        // Make the second atomic replace fail after bindings have been written.
        fs::create_dir_all(records_path_at(&root)).unwrap();

        let target_snapshot = snapshot(&target).unwrap();
        let outcome = PublishOutcome {
            statuses: HashMap::from([(hash.clone(), "saved".to_string())]),
            failures: HashMap::new(),
            bindings_changed: true,
            records_changed: true,
        };
        let records = vec![bk2_record(&hash, 0)];
        let bindings = vec![sample_managed_binding(&hash, target_snapshot)];

        let error = persist_import_indexes(&root, &outcome, &records, &bindings).unwrap_err();
        assert_eq!(error.code, "commit_failed");
        assert!(error.requires_reload);
        assert!(
            error.message.contains("保存书库记录失败"),
            "{}",
            error.message
        );

        assert!(target.exists());
        assert!(bindings_path_at(&root).is_file());
        let persisted_bindings: Vec<DeviceBinding> =
            serde_json::from_slice(&fs::read(bindings_path_at(&root)).unwrap()).unwrap();
        assert_eq!(persisted_bindings.len(), 1);
        assert_eq!(persisted_bindings[0].content_hash, hash);
        assert!(fs::metadata(records_path_at(&root)).unwrap().is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_publish_rename_failure_is_per_hash_and_other_input_continues() {
        let root = organization_temp_dir("bk2-publish-rename-failure");
        let good_hash = "d".repeat(64);
        let bad_hash = "e".repeat(64);
        let mut records = Vec::new();
        let mut bindings = Vec::new();
        let good = bk2_prepared_document(&root, &good_hash, 0, b"good", "Good");
        let mut bad = bk2_prepared_document(&root, &bad_hash, 1, b"bad", "Bad");
        fs::remove_file(&bad.staging_path).unwrap();

        let outcome = publish_prepared_documents(
            &root,
            &mut records,
            &mut bindings,
            &[PreparedItem::Ready(good), PreparedItem::Ready(bad)],
        )
        .unwrap();

        assert_eq!(
            outcome.statuses.get(&good_hash).map(String::as_str),
            Some("saved")
        );
        assert!(outcome.failures.contains_key(&bad_hash));
        assert_eq!(records.len(), 1);
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            fs::read(root.join("books").join(format!("{good_hash}.epub"))).unwrap(),
            b"good"
        );
        assert!(!root.join("books").join(format!("{bad_hash}.epub")).exists());

        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn bk2_no_commit_results_cover_failed_prepared_and_unprocessed_cancel() {
        let root = organization_temp_dir("bk2-no-commit");
        let hash = "f".repeat(64);
        let prepared = vec![
            PreparedItem::Failed {
                input_index: 0,
                content_hash: None,
                message: "bad".to_string(),
            },
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, b"bytes", "Title")),
            PreparedItem::Cancelled {
                input_index: 2,
                content_hash: None,
            },
        ];

        let result = build_no_commit_results(prepared);
        let statuses: Vec<&str> = result
            .results
            .iter()
            .map(|item| item.status.as_str())
            .collect();
        assert_eq!(statuses, vec!["failed", "cancelled", "cancelled"]);
        assert_eq!(result.results[0].error.as_deref(), Some("bad"));
        assert_eq!(
            result.results[1].content_hash.as_deref(),
            Some(hash.as_str())
        );
        assert!(result.results[1].record.is_none());
        assert!(result.results[2].content_hash.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_read_finalize_preserves_concurrent_progress_and_updates_binding() {
        let root = organization_temp_dir("bk3-read-finalize");
        let bytes = b"epub-bytes";
        let hash = hash_bytes(bytes);
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let actual_snapshot = snapshot(&path).unwrap();
        let mut bindings = vec![sample_linked_binding(
            &hash,
            &path,
            FileSnapshot {
                size: 1,
                mtime_ns: 1,
            },
        )];
        let mut records = vec![bk2_record(&hash, 77)];

        let pending = prepare_source_read(&root, &records, &bindings, &hash).unwrap();
        // This models a progress save that commits after the short lock is
        // released and before the read result is finalized.
        records[0].progress_pct = 88;
        records[0].last_read_at_ms = 123;
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        let changed = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(read.bytes, bytes.to_vec());
        assert_eq!(records[0].progress_pct, 88);
        assert_eq!(records[0].last_read_at_ms, 123);
        assert_eq!(bindings[0].file_size, actual_snapshot.size);
        assert_eq!(bindings[0].source_mtime_ns, actual_snapshot.mtime_ns);
        assert!(bindings[0].last_verified_at_ms > 0);

        // The next unchanged read sees the same signatures and must not write
        // or refresh the verification timestamp again.
        let verified_at = bindings[0].last_verified_at_ms;
        let changed_again = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(!changed_again);
        assert_eq!(bindings[0].last_verified_at_ms, verified_at);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_finalize_unchanged_signature_does_not_write_or_update_time() {
        let root = organization_temp_dir("bk3-finalize-unchanged");
        let bytes = b"epub-bytes";
        let hash = hash_bytes(bytes);
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let snapshot = snapshot(&path).unwrap();
        let records = vec![bk2_record(&hash, 1)];
        let mut bindings = vec![sample_linked_binding(&hash, &path, snapshot.clone())];
        let pending = prepare_source_read(&root, &records, &bindings, &hash).unwrap();
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        let changed = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(bindings[0].file_size, snapshot.size);
        assert_eq!(bindings[0].source_mtime_ns, snapshot.mtime_ns);
        assert_eq!(bindings[0].last_verified_at_ms, 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_stale_read_result_is_rejected_after_delete_change_or_relink() {
        let root = organization_temp_dir("bk3-read-stale");
        let bytes = b"epub-bytes";
        let hash = hash_bytes(bytes);
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let records = vec![bk2_record(&hash, 77)];
        let bindings = vec![sample_linked_binding(
            &hash,
            &path,
            snapshot(&path).unwrap(),
        )];
        let pending = prepare_source_read(&root, &records, &bindings, &hash).unwrap();
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        let mut after_delete = bindings.clone();
        assert!(finalize_source_read(
            &root,
            &[],
            &mut after_delete,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        fs::write(&path, b"changed-after-read").unwrap();
        let mut after_change = bindings.clone();
        assert!(finalize_source_read(
            &root,
            &records,
            &mut after_change,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        let other = root.join("relinked.epub");
        fs::write(&other, bytes).unwrap();
        let mut after_relink = bindings.clone();
        after_relink[0].canonical_source_path = Some(other.to_string_lossy().into_owned());
        assert!(finalize_source_read(
            &root,
            &records,
            &mut after_relink,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        fs::remove_file(&path).unwrap();
        let mut after_missing = bindings.clone();
        assert!(finalize_source_read(
            &root,
            &records,
            &mut after_missing,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_managed_same_hash_reimport_keeps_new_binding_stat() {
        use std::io::Write as _;

        let root = organization_temp_dir("bk3-managed-reimport");
        let bytes = b"managed-epub-bytes";
        let hash = hash_bytes(bytes);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, bytes).unwrap();
        let old_snapshot = snapshot(&target).unwrap();
        let records = vec![bk2_record(&hash, 42)];
        let old_bindings = vec![sample_managed_binding(&hash, old_snapshot.clone())];
        let pending = prepare_source_read(&root, &records, &old_bindings, &hash).unwrap();
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        // Same-hash reimport atomically replaces the managed file and publishes
        // a newer binding signature while the old fd read is still finishing.
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&target)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let new_snapshot = snapshot(&target).unwrap();
        assert_ne!(new_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let mut fresh_bindings = vec![sample_managed_binding(&hash, new_snapshot.clone())];
        let changed = finalize_source_read(
            &root,
            &records,
            &mut fresh_bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(read.bytes, bytes.to_vec());
        assert_eq!(fresh_bindings[0].file_size, new_snapshot.size);
        assert_eq!(fresh_bindings[0].source_mtime_ns, new_snapshot.mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_managed_list_refresh_is_stat_only_and_leaves_binding_unchanged() {
        let root = organization_temp_dir("bk3-managed-list-stat");
        let hash = "c".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        let bytes = b"managed-bytes";
        fs::write(&target, bytes).unwrap();
        let old_snapshot = snapshot(&target).unwrap();
        let mut binding = sample_managed_binding(&hash, old_snapshot.clone());

        // The file has the same valid bytes but a newer stat signature.  The
        // old explicit-verify path would hash and rewrite the binding; list
        // refresh must neither hash nor rewrite it.
        let file = OpenOptions::new().write(true).open(&target).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let touched_snapshot = snapshot(&target).unwrap();
        assert_ne!(touched_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let verification = verify_binding_for_list_refresh(&mut binding, &root).unwrap();
        assert!(!verification.available);
        assert!(!verification.changed);
        assert_eq!(binding.file_size, old_snapshot.size);
        assert_eq!(binding.source_mtime_ns, old_snapshot.mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_read_rejects_hash_mismatch_on_opened_handle() {
        let root = organization_temp_dir("bk3-read-hash-mismatch");
        let bytes = b"epub-bytes";
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let expected_hash = "a".repeat(64);
        let records = vec![bk2_record(&expected_hash, 77)];
        let bindings = vec![sample_linked_binding(
            &expected_hash,
            &path,
            snapshot(&path).unwrap(),
        )];
        let pending = prepare_source_read(&root, &records, &bindings, &expected_hash).unwrap();
        assert_eq!(read_source_bytes_and_hash(&pending.file, &expected_hash).err().unwrap().code, "source-changed");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_cover_reader_reads_exact_entry_and_enforces_limit() {
        let root = organization_temp_dir("bk3-cover-read");
        let archive_path = root.join("book.epub");
        write_test_cover_zip(&archive_path, b"cover-bytes");
        let (hash, snapshot) = hash_file(&archive_path).unwrap();

        let file = File::open(&archive_path).unwrap();
        let read =
            read_cover_from_opened_file(&file, "OPS/cover.jpg", MAX_COVER_BYTES, &hash, &snapshot)
                .unwrap();
        assert_eq!(read.bytes, b"cover-bytes".to_vec());

        let file = File::open(&archive_path).unwrap();
        let error =
            read_cover_from_opened_file(&file, "OPS/cover.jpg", 4, &hash, &snapshot).unwrap_err();
        assert_eq!(error.code, "failed");
        assert!(error.message.contains("超过允许大小"));

        let file = File::open(&archive_path).unwrap();
        assert!(read_cover_from_opened_file(
            &file,
            "OPS/missing.jpg",
            MAX_COVER_BYTES,
            &hash,
            &snapshot,
        )
        .is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_cover_signature_change_requires_same_handle_whole_book_hash() {
        let root = organization_temp_dir("bk3-cover-verify");
        let path = root.join("book.epub");
        write_test_cover_zip(&path, b"cover-a");
        let (old_hash, old_snapshot) = hash_file(&path).unwrap();

        // Same cover entry name, different whole book.  The stat changed, so
        // the cover slow path must hash this exact handle and reject before
        // any local ZIP success can update the binding.
        write_test_cover_zip(&path, b"cover-b-different");
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let replacement_snapshot = snapshot(&path).unwrap();
        assert_ne!(replacement_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let file = File::open(&path).unwrap();
        assert!(read_cover_from_opened_file(
            &file,
            "OPS/cover.jpg",
            MAX_COVER_BYTES,
            &old_hash,
            &old_snapshot,
        )
        .is_err());

        let mut binding = sample_linked_binding(&old_hash, &path, old_snapshot.clone());
        let verification = verify_binding_for_list_refresh(&mut binding, &root).unwrap();
        assert!(!verification.available);
        assert!(!verification.changed);
        assert_eq!(binding.file_size, old_snapshot.size);
        assert_eq!(binding.source_mtime_ns, old_snapshot.mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_cover_same_bytes_stat_change_verifies_once_and_updates_binding() {
        let root = organization_temp_dir("bk3-cover-same-bytes");
        let path = root.join("book.epub");
        write_test_cover_zip(&path, b"cover-a");
        let (hash, old_snapshot) = hash_file(&path).unwrap();

        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let touched_snapshot = snapshot(&path).unwrap();
        assert_ne!(touched_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let file = File::open(&path).unwrap();
        let read = read_cover_from_opened_file(
            &file,
            "OPS/cover.jpg",
            MAX_COVER_BYTES,
            &hash,
            &old_snapshot,
        )
        .unwrap();
        assert_eq!(read.bytes, b"cover-a".to_vec());
        assert_eq!(read.read_snapshot, touched_snapshot);

        let records = vec![bk2_record(&hash, 1)];
        let mut bindings = vec![sample_linked_binding(&hash, &path, old_snapshot.clone())];
        let identity = SourceIdentity::from_binding(&bindings[0], &root).unwrap();
        let changed = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &identity,
            &old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(bindings[0].file_size, touched_snapshot.size);
        assert_eq!(bindings[0].source_mtime_ns, touched_snapshot.mtime_ns);
        assert!(bindings[0].last_verified_at_ms > 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_managed_delete_removes_file_then_indexes_and_missing_targets_are_noop() {
        let root = organization_temp_dir("bk4-managed-delete");
        let hash = "1".repeat(64);
        let missing_hash = "f".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let source = books.join(format!("{hash}.epub"));
        fs::write(&source, b"managed-bytes").unwrap();
        let source_snapshot = snapshot(&source).unwrap();
        save_records_at(&root, &[bk2_record(&hash, 5)]).unwrap();
        save_bindings_at(&root, &[sample_managed_binding(&hash, source_snapshot)]).unwrap();

        // The already-missing target is a no-op; the remaining record must
        // still be deleted instead of rejecting the whole batch.
        delete_records_at(&root, &[missing_hash.clone(), hash.clone()], |_| Ok(())).unwrap();
        assert!(!source.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());

        // All requested records are gone now. Retrying the command is a
        // successful no-op, not the old "书库中没有所选书籍" error.
        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(!source.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_managed_delete_treats_not_found_as_complete() {
        let root = organization_temp_dir("bk4-managed-not-found");
        let hash = "2".repeat(64);
        save_records_at(&root, &[bk2_record(&hash, 1)]).unwrap();
        save_bindings_at(
            &root,
            &[sample_managed_binding(
                &hash,
                FileSnapshot {
                    size: 12,
                    mtime_ns: 34,
                },
            )],
        )
        .unwrap();

        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(!managed_source_path(&root, &hash).unwrap().exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_linked_source_file_is_never_deleted() {
        let root = organization_temp_dir("bk4-linked-source");
        let hash = "3".repeat(64);
        let source = root.join("user-book.epub");
        fs::write(&source, b"linked-bytes").unwrap();
        let source_snapshot = snapshot(&source).unwrap();
        save_records_at(&root, &[bk2_record(&hash, 1)]).unwrap();
        save_bindings_at(
            &root,
            &[sample_linked_binding(&hash, &source, source_snapshot)],
        )
        .unwrap();

        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(source.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_record_without_binding_does_not_delete_bare_hash_file() {
        let root = organization_temp_dir("bk4-record-without-binding");
        let hash = "4".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let bare_hash_file = books.join(format!("{hash}.epub"));
        fs::write(&bare_hash_file, b"not-owned-without-binding").unwrap();
        save_records_at(&root, &[bk2_record(&hash, 1)]).unwrap();

        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(bare_hash_file.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_batch_file_failure_keeps_indexes_for_retry() {
        let root = organization_temp_dir("bk4-batch-file-failure");
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let source_a = books.join(format!("{hash_a}.epub"));
        fs::write(&source_a, b"managed-a").unwrap();
        let source_b = books.join(format!("{hash_b}.epub"));
        fs::create_dir_all(&source_b).unwrap();

        let snapshot_a = snapshot(&source_a).unwrap();
        save_records_at(&root, &[bk2_record(&hash_a, 1), bk2_record(&hash_b, 2)]).unwrap();
        save_bindings_at(
            &root,
            &[
                sample_managed_binding(&hash_a, snapshot_a),
                sample_managed_binding(
                    &hash_b,
                    FileSnapshot {
                        size: 7,
                        mtime_ns: 8,
                    },
                ),
            ],
        )
        .unwrap();

        let error =
            delete_records_at(&root, &[hash_a.clone(), hash_b.clone()], |_| Ok(())).unwrap_err();
        assert!(
            error.contains("无法删除托管书籍源文件"),
            "unexpected error: {error}"
        );
        assert!(!source_a.exists());
        assert!(source_b.exists());
        assert_eq!(load_records_at(&root).unwrap().len(), 2);
        assert_eq!(load_bindings_at(&root).unwrap().len(), 2);

        // Fix the second target and retry: the first missing file is now
        // NotFound (accepted), and the batch converges without stale indexes.
        fs::remove_dir(&source_b).unwrap();
        fs::write(&source_b, b"managed-b").unwrap();
        delete_records_at(&root, &[hash_a.clone(), hash_b.clone()], |_| Ok(())).unwrap();
        assert!(!source_a.exists());
        assert!(!source_b.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_partial_index_commit_retry_removes_record_and_keeps_organization() {
        let root = organization_temp_dir("bk4-partial-index-retry");
        let hash = "5".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let source = books.join(format!("{hash}.epub"));
        fs::write(&source, b"managed-bytes").unwrap();
        let source_snapshot = snapshot(&source).unwrap();
        save_records_at(&root, &[bk2_record(&hash, 9)]).unwrap();
        save_bindings_at(&root, &[sample_managed_binding(&hash, source_snapshot)]).unwrap();

        let folder_id = "11111111-1111-4111-8111-111111111111";
        let mut organization = sample_organization(7, &hash, true);
        organization.state.folders.insert(
            folder_id.to_string(),
            library_organization::FolderState {
                name: library_organization::Register {
                    value: "收藏夹".to_string(),
                    stamp: library_organization::Stamp {
                        counter: 2,
                        device_id: TEST_DEVICE_ID.to_string(),
                    },
                },
                deleted: None,
            },
        );
        organization.state.books.get_mut(&hash).unwrap().folder_id =
            Some(library_organization::Register {
                value: Some(folder_id.to_string()),
                stamp: library_organization::Stamp {
                    counter: 3,
                    device_id: TEST_DEVICE_ID.to_string(),
                },
            });
        let organization_path = root.join("library-organization.json");
        save_organization_file(&organization_path, &organization).unwrap();
        let organization_before = fs::read(&organization_path).unwrap();

        let records_path = records_path_at(&root);
        let records_backup = root.join("library-records.json.bak");
        let error = delete_records_at(&root, &[hash.clone()], |_| {
            // The callback runs after records/bindings are loaded but before
            // the source file and index commits.  Make the records atomic
            // replacement fail exactly at the final commit step.
            fs::rename(&records_path, &records_backup)
                .map_err(|error| format!("无法备份测试 records：{error}"))?;
            fs::create_dir(&records_path)
                .map_err(|error| format!("无法创建测试 records 故障目录：{error}"))?;
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("原子替换"), "unexpected error: {error}");
        assert!(!source.exists());
        assert!(records_path.is_dir());
        let backup_records =
            load_json_or_default::<Vec<LinkedLibraryRecord>>(&records_backup, "测试记录备份")
                .unwrap();
        assert_eq!(backup_records.len(), 1);
        assert_eq!(backup_records[0].content_hash, hash);
        assert!(load_bindings_at(&root).unwrap().is_empty());
        assert_eq!(fs::read(&organization_path).unwrap(), organization_before);
        assert_eq!(
            load_organization_file(&organization_path).unwrap(),
            Some(organization.clone())
        );

        // Undo only the test fault injection, then run the same production
        // deletion path again.  The already-committed bindings are gone, so
        // the retry removes the remaining record without touching any file.
        fs::remove_dir(&records_path).unwrap();
        fs::rename(&records_backup, &records_path).unwrap();
        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();

        assert!(!source.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        assert_eq!(fs::read(&organization_path).unwrap(), organization_before);
        assert_eq!(
            load_organization_file(&organization_path).unwrap(),
            Some(organization)
        );
        let _ = fs::remove_dir_all(&root);
    }
}
