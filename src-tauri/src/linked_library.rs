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

#[cfg(feature = "ai")]
pub(crate) use archive::{archive_open_blocking as open_tool_archive, close_tool_archives};

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
use serde::{
    Deserialize,
    Serialize,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{
    AppHandle,
    Manager,
    State,
};
use zip::ZipArchive;
use crate::native_zip_session::{Fault, NativeZipSession, CHUNK_BYTES};

mod epub_meta;
pub(crate) use epub_meta::{
    inspect_epub,
    inspect_epub_cover,
};
use epub_meta::read_zip_entry_bounded;

mod source;
use source::*;
pub(crate) use source::{
    snapshot,
    canonical_epub_path,
    hash_file,
};

mod binding;
use binding::*;
pub(crate) use binding::{
    make_binding,
    verify_binding_for_list_refresh,
};

mod thumbnails;
use thumbnails::*;

mod store;
use store::*;
pub(crate) use store::{
    valid_content_hash,
    library_root,
    load_bindings,
    managed_source_path,
    atomic_write_bytes,
    replace_file_atomically,
};

mod import;
use import::*;
#[allow(unused_imports)]
pub(crate) use import::{
    new_staging_path,
    stream_restricted_reader_to_staging,
    make_managed_binding,
    make_managed_record,
};

mod library_copy;
use library_copy::*;
pub(crate) use library_copy::{publish_staged_copy, library_file_name, ensure_library_space};

mod library_settings;
use library_settings::*;

mod archive;
use archive::*;
pub(crate) use archive::{
    close_native_archive_window,
    close_all_native_archives,
};

mod organization;
use organization::*;

mod commands;
pub(crate) use commands::{
    __tauri_command_name_linked_library_import_documents,
    __tauri_command_name_linked_library_cancel_document_import,
    __tauri_command_name_linked_library_list_records,
    __tauri_command_name_linked_library_import_paths,
    __tauri_command_name_linked_library_read_source_raw,
    __tauri_command_name_linked_library_read_cover_raw,
    __tauri_command_name_linked_library_archive_open,
    __tauri_command_name_linked_library_archive_directory,
    __tauri_command_name_linked_library_archive_read,
    __tauri_command_name_linked_library_archive_close,
    __tauri_command_name_linked_library_relink,
    __tauri_command_name_linked_library_reveal_source,
    __tauri_command_name_linked_library_settings_get,
    __tauri_command_name_linked_library_settings_set_copy,
    __tauri_command_name_linked_library_open_folder,
    __tauri_command_name_linked_library_update_progress,
    __tauri_command_name_linked_library_mark_opened,
    __tauri_command_name_linked_library_update_bookmarks,
    __tauri_command_name_linked_library_update_notes,
    __tauri_command_name_linked_library_replace_records,
    __tauri_command_name_linked_library_delete_record,
    __tauri_command_name_linked_library_delete_records,
    __tauri_command_name_linked_library_thumbnail_read,
    __tauri_command_name_linked_library_thumbnail_write_raw,
    __tauri_command_name_linked_library_thumbnail_delete,
    __tauri_command_name_linked_library_get_organization,
    __tauri_command_name_linked_library_apply_organization,
    __tauri_command_name_linked_library_merge_organization,
};
pub use commands::{
    linked_library_import_documents,
    linked_library_cancel_document_import,
    linked_library_list_records,
    linked_library_import_paths,
    linked_library_read_source_raw,
    linked_library_read_cover_raw,
    linked_library_archive_open,
    linked_library_archive_directory,
    linked_library_archive_read,
    linked_library_archive_close,
    linked_library_relink,
    linked_library_reveal_source,
    linked_library_settings_get,
    linked_library_settings_set_copy,
    linked_library_open_folder,
    linked_library_update_progress,
    linked_library_mark_opened,
    linked_library_update_bookmarks,
    linked_library_update_notes,
    linked_library_replace_records,
    linked_library_delete_record,
    linked_library_delete_records,
    linked_library_thumbnail_read,
    linked_library_thumbnail_write_raw,
    linked_library_thumbnail_delete,
    linked_library_get_organization,
    linked_library_apply_organization,
    linked_library_merge_organization,
};
pub(crate) use commands::{
    __cmd__linked_library_import_documents,
    __cmd__linked_library_cancel_document_import,
    __cmd__linked_library_list_records,
    __cmd__linked_library_import_paths,
    __cmd__linked_library_read_source_raw,
    __cmd__linked_library_read_cover_raw,
    __cmd__linked_library_archive_open,
    __cmd__linked_library_archive_directory,
    __cmd__linked_library_archive_read,
    __cmd__linked_library_archive_close,
    __cmd__linked_library_relink,
    __cmd__linked_library_reveal_source,
    __cmd__linked_library_settings_get,
    __cmd__linked_library_settings_set_copy,
    __cmd__linked_library_open_folder,
    __cmd__linked_library_update_progress,
    __cmd__linked_library_mark_opened,
    __cmd__linked_library_update_bookmarks,
    __cmd__linked_library_update_notes,
    __cmd__linked_library_replace_records,
    __cmd__linked_library_delete_record,
    __cmd__linked_library_delete_records,
    __cmd__linked_library_thumbnail_read,
    __cmd__linked_library_thumbnail_write_raw,
    __cmd__linked_library_thumbnail_delete,
    __cmd__linked_library_get_organization,
    __cmd__linked_library_apply_organization,
    __cmd__linked_library_merge_organization,
};

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
    pub(crate) session_id: String,
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
    /// A library copy's readable file name inside `books/` (A34). Absent on
    /// older managed bindings, whose copy is `<hash>.epub`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_file_name: Option<String>,
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
    /// Gives a managed binding its readable library file name (A34).
    pub(crate) fn with_managed_file_name(mut self, file_name: String) -> Self {
        self.managed_file_name = Some(file_name);
        self
    }

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
                Ok(BindingSource::Managed(match self.managed_file_name.as_deref() {
                    Some(name) => managed_named_path(library_root, name)?,
                    None => managed_source_path(library_root, &self.content_hash)?,
                }))
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
    pub(crate) cover_zip_path: Option<String>,
    pub(crate) cover_mime: String,
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


#[cfg(test)]
mod tests;
