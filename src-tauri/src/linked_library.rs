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
use crate::android_uri_bridge::{RestrictedReadError, RestrictedReader};
use crate::import_gate::{CancelReply as ImportCancelReply, ImportGate};
use crate::library_organization::{
    self, LibraryOrganization, OrganizationCommand, OrganizationEnvelope,
};
use crate::portable_state::{
    Locator, LocatorTarget, MediaTag, PortableError, ShelfBookProjection, ShelfProjection,
};
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
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
struct DeviceBinding {
    content_hash: String,
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
struct FileSnapshot {
    size: u64,
    mtime_ns: u64,
}

struct BindingVerification {
    available: bool,
    changed: bool,
}

#[derive(Debug)]
struct ImportedMetadata {
    title: String,
    creator: String,
    language: String,
    spine: Vec<String>,
    cover_zip_path: Option<String>,
    cover_mime: String,
}

/// OPF 中保持源顺序的 manifest。封面 fallback 必须按此顺序取首个有效候选，
/// 不能依赖 HashMap 的随机迭代顺序。
#[derive(Debug, Clone)]
struct OpfManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

#[derive(Debug)]
struct ParsedOpfMetadata {
    title: String,
    creator: String,
    language: String,
    spine: Vec<String>,
    manifest: Vec<OpfManifestItem>,
    epub2_cover_id: Option<String>,
    base: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn valid_content_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_optional_ratio(ratio: Option<f64>) -> bool {
    ratio
        .map(|value| value.is_finite() && (0.0..=1.0).contains(&value))
        .unwrap_or(true)
}

fn valid_optional_anchor_text(offset: Option<u64>, snippet: &Option<String>) -> bool {
    if offset
        .map(|value| value > MAX_ANCHOR_TEXT_OFFSET)
        .unwrap_or(false)
    {
        return false;
    }
    match (offset, snippet) {
        (None, Some(_)) => false,
        (_, None) => true,
        (_, Some(value)) => {
            !value.is_empty()
                && value.chars().count() <= MAX_ANCHOR_SNIPPET_CODE_POINTS
                && !value.chars().any(char::is_whitespace)
        }
    }
}

fn valid_optional_media_anchor(anchor: &Option<LinkedLibraryMediaAnchor>) -> bool {
    match anchor {
        None => true,
        Some(value) => {
            !value.tag.is_empty()
                && !value.signature.is_empty()
                && value.ratio.is_finite()
                && (0.0..=1.0).contains(&value.ratio)
        }
    }
}

fn valid_note_snippet(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ANCHOR_SNIPPET_CODE_POINTS
        && !value.chars().any(char::is_whitespace)
}

fn normalized_code_point_count(value: &str) -> usize {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
}

fn valid_note(note: &LinkedLibraryNote) -> bool {
    !note.id.trim().is_empty()
        && !note.chapter_path.trim().is_empty()
        && note.start_text_offset <= MAX_ANCHOR_TEXT_OFFSET
        && note.end_text_offset <= MAX_ANCHOR_TEXT_OFFSET
        && note.end_text_offset > note.start_text_offset
        && valid_note_snippet(&note.start_text_snippet)
        && valid_note_snippet(&note.end_text_snippet)
        && !note.selected_text.is_empty()
        && note.selected_text.chars().count() <= MAX_NOTE_SELECTED_CODE_POINTS
        && normalized_code_point_count(&note.selected_text)
            == (note.end_text_offset - note.start_text_offset) as usize
        && !note.content.trim().is_empty()
        && note.content.chars().count() <= MAX_NOTE_CONTENT_CODE_POINTS
        && note.updated_at_ms >= note.created_at_ms
}

fn portable_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.to_ascii_lowercase().starts_with("file:")
}

fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("linked-library"))
        .map_err(|error| format!("无法取得应用本地数据目录：{error}"))
}

/// The sole authoritative location for an application-owned EPUB.  A managed
/// binding never stores this path; callers derive it from the library root and
/// the already validated canonical hash.
fn managed_source_path(library_root: &Path, content_hash: &str) -> Result<PathBuf, String> {
    if !valid_content_hash(content_hash) {
        return Err("managed 设备绑定缺少规范小写内容指纹".into());
    }
    Ok(library_root
        .join("books")
        .join(format!("{content_hash}.epub")))
}

fn records_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(records_path_at(&library_root(app)?))
}

fn bindings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bindings_path_at(&library_root(app)?))
}

fn records_path_at(root: &Path) -> PathBuf {
    root.join("library-records.json")
}

fn bindings_path_at(root: &Path) -> PathBuf {
    root.join("device-bindings.json")
}

fn thumbnails_root_at(root: &Path) -> PathBuf {
    root.join("thumbnails")
}

fn thumbnails_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(thumbnails_root_at(&library_root(app)?))
}

/// Favorites and folders live in their own file next to the records.  It is
/// intentionally separate from `device-bindings.json` and from the reading
/// timestamps: the organization state is portable, the binding is not.
fn organization_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join("library-organization.json"))
}

fn thumbnails_index_path_at(root: &Path) -> PathBuf {
    thumbnails_root_at(root).join("index.json")
}

fn thumbnails_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(thumbnails_index_path_at(&library_root(app)?))
}

fn load_json_or_default<T: for<'de> Deserialize<'de> + Default>(
    path: &Path,
    label: &str,
) -> Result<T, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("{label}损坏：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("无法读取{label}：{error}")),
    }
}

fn portable_u64_to_usize(value: u64) -> usize {
    usize::try_from(value).unwrap_or(0)
}

fn portable_media_tag(tag: &MediaTag) -> String {
    match tag {
        MediaTag::Img => "img",
        MediaTag::Svg => "svg",
        MediaTag::Video => "video",
    }
    .to_string()
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

fn locator_reading_fields(locator: &Locator) -> LinkedReadingFields {
    match locator {
        Locator::Legacy(legacy) => (
            portable_u64_to_usize(legacy.spine_index),
            portable_u64_to_usize(legacy.page_hint),
            legacy.anchor_index.map(portable_u64_to_usize),
            legacy.anchor_ratio,
            legacy.anchor_text_offset,
            legacy.anchor_text_snippet.clone(),
            legacy.media_anchor.as_ref().map(|media| LinkedLibraryMediaAnchor {
                index: portable_u64_to_usize(media.index),
                tag: media.tag.clone(),
                signature: media.signature.clone(),
                ratio: media.ratio,
            }),
        ),
        Locator::Modern(modern) => {
            let spine = portable_u64_to_usize(modern.spine_index_hint);
            match &modern.target {
                LocatorTarget::ChapterStart => (spine, 0, None, None, None, None, None),
                LocatorTarget::Text { offset, snippet, .. } => (
                    spine,
                    0,
                    None,
                    None,
                    Some(*offset),
                    Some(snippet.clone()),
                    None,
                ),
                LocatorTarget::Media {
                    signature,
                    index_hint,
                    tag,
                    ratio,
                } => (
                    spine,
                    0,
                    None,
                    None,
                    None,
                    None,
                    Some(LinkedLibraryMediaAnchor {
                        index: portable_u64_to_usize(*index_hint),
                        tag: portable_media_tag(tag),
                        signature: signature.clone(),
                        ratio: *ratio,
                    }),
                ),
            }
        }
    }
}

fn linked_record_from_projection(book: &ShelfBookProjection, is_new: bool) -> LinkedLibraryRecord {
    let (last_read_at_ms, progress_pct, fields) = match &book.progress.display {
        Some(version) => {
            let (progress_pct, fields) = match &version.value {
                Some(progress) => (
                    u32::try_from(progress.progress_pct_hint).unwrap_or(u32::MAX),
                    locator_reading_fields(&progress.locator),
                ),
                None => (0, (0, 0, None, None, None, None, None)),
            };
            (version.updated_at_ms, progress_pct, fields)
        }
        None => (0, 0, (0, 0, None, None, None, None, None)),
    };
    let (spine_index, page, anchor_index, anchor_ratio, anchor_text_offset, anchor_text_snippet, media_anchor) = fields;
    LinkedLibraryRecord {
        content_hash: book.book_hash.clone(),
        title: book.metadata.title.clone(),
        creator: book.metadata.creator.clone(),
        language: book.metadata.language.clone().unwrap_or_default(),
        file_name: book.metadata.file_name.clone(),
        added_at_ms: book.metadata.added_at_ms,
        last_read_at_ms,
        spine_index,
        page,
        progress_pct,
        anchor_index,
        anchor_ratio,
        anchor_text_offset,
        anchor_text_snippet,
        media_anchor,
        bookmarks: book
            .bookmarks
            .iter()
            .map(|annotation| {
                let value = &annotation.display.value;
                let (spine_index, page, anchor_index, anchor_ratio, anchor_text_offset, anchor_text_snippet, media_anchor) =
                    locator_reading_fields(&value.locator);
                LinkedLibraryBookmark {
                    id: annotation.id.clone(),
                    spine_index,
                    page,
                    anchor_index,
                    anchor_ratio,
                    anchor_text_offset,
                    anchor_text_snippet,
                    media_anchor,
                    text: value.text.clone(),
                    created_at_ms: value.created_at_ms,
                }
            })
            .collect(),
        notes: book
            .notes
            .iter()
            .map(|annotation| {
                let value = &annotation.display.value;
                LinkedLibraryNote {
                    id: annotation.id.clone(),
                    spine_index: portable_u64_to_usize(value.spine_index_hint),
                    chapter_path: value.chapter_path.clone(),
                    start_text_offset: value.start_text_offset,
                    end_text_offset: value.end_text_offset,
                    start_text_snippet: value.start_text_snippet.clone(),
                    end_text_snippet: value.end_text_snippet.clone(),
                    selected_text: value.selected_text.clone(),
                    content: value.content.clone(),
                    created_at_ms: value.created_at_ms,
                    updated_at_ms: annotation.display.updated_at_ms,
                }
            })
            .collect(),
        is_new,
    }
}

fn linked_records_from_projection(
    projection: &ShelfProjection,
    visible: &HashSet<String>,
    binding_hashes: &HashSet<String>,
    is_new: &HashSet<String>,
) -> Vec<LinkedLibraryRecord> {
    projection
        .books
        .iter()
        .filter(|book| {
            visible.contains(&book.book_hash) || binding_hashes.contains(&book.book_hash)
        })
        .map(|book| {
            linked_record_from_projection(book, is_new.contains(&book.book_hash))
        })
        .collect()
}

fn portable_store_active(app: &AppHandle) -> Result<bool, String> {
    crate::portable_state_commands::with_existing_store(app, |_store| Ok(()))
        .map(|result| result.is_some())
        .map_err(|error| error.to_string())
}

fn delete_records_portable(app: &AppHandle, content_hashes: &[String]) -> Result<(), String> {
    let records = load_records(app)?;
    let mut target_hashes = Vec::new();
    let mut seen = HashSet::new();
    for hash in content_hashes {
        if records.iter().any(|record| &record.content_hash == hash) && seen.insert(hash.clone()) {
            target_hashes.push(hash.clone());
        }
    }
    if target_hashes.is_empty() {
        return Ok(());
    }

    let bindings = load_bindings(app)?;
    let root = library_root(app)?;
    let mut managed_paths = Vec::new();
    for hash in &target_hashes {
        for binding in bindings
            .iter()
            .filter(|binding| &binding.content_hash == hash)
        {
            if let BindingSource::Managed(path) = binding.resolve_source(&root)? {
                managed_paths.push(path);
            }
        }
    }

    app.state::<AiState>()
        .cleanup_books_if_present(app, &target_hashes)?;

    for path in managed_paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法删除托管书籍源文件：{error}")),
        }
    }

    let mut thumbnails = load_thumbnail_index(app)?;
    for hash in &target_hashes {
        remove_thumbnail(app, &mut thumbnails, hash)?;
    }
    save_thumbnail_index(app, &thumbnails)?;
    crate::portable_state_commands::with_existing_store(app, |store| {
        store.hide_linked_records(&target_hashes)
    })
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "可移植资料仓储未激活".to_string())
}

fn load_portable_records(app: &AppHandle) -> Result<Option<Vec<LinkedLibraryRecord>>, String> {
    crate::portable_state_commands::with_existing_store(app, |store| {
        let projection = store.project_shelf()?;
        let visible: HashSet<String> = store.local_visible_hashes()?.into_iter().collect();
        let binding_hashes: HashSet<String> = store.bindings_raw()?.into_keys().collect();
        let is_new: HashSet<String> = store.local_is_new_hashes()?.into_iter().collect();
        Ok(linked_records_from_projection(
            &projection,
            &visible,
            &binding_hashes,
            &is_new,
        ))
    })
    .map_err(|error| error.to_string())
}

fn load_portable_bindings(app: &AppHandle) -> Result<Option<Vec<DeviceBinding>>, String> {
    crate::portable_state_commands::with_existing_store(app, |store| {
        let root = library_root(app).map_err(PortableError::storage_error)?;
        let raw_bindings = store.bindings_raw()?;
        let mut bindings = Vec::with_capacity(raw_bindings.len());
        for (hash, raw) in raw_bindings {
            let binding: DeviceBinding = serde_json::from_str(&raw).map_err(|error| {
                PortableError::storage_error(format!("设备绑定损坏：{error}"))
            })?;
            if binding.content_hash != hash {
                return Err(PortableError::storage_error(
                    "device_bindings 行内容指纹与键不一致",
                ));
            }
            bindings.push(binding);
        }
        validate_binding_sources(&bindings, &root).map_err(PortableError::storage_error)?;
        Ok(bindings)
    })
    .map_err(|error| error.to_string())
}

fn save_portable_bindings(app: &AppHandle, bindings: &[DeviceBinding]) -> Result<Option<()>, String> {
    let rows: Vec<(String, String)> = bindings
        .iter()
        .map(|binding| {
            serde_json::to_string(binding)
                .map(|raw| (binding.content_hash.clone(), raw))
                .map_err(|error| format!("无法序列化设备绑定：{error}"))
        })
        .collect::<Result<_, _>>()?;
    crate::portable_state_commands::with_existing_store(app, |store| {
        store.replace_bindings_snapshot(rows)
    })
    .map(|result| result.map(|_| ()))
    .map_err(|error| error.to_string())
}

fn save_portable_records(app: &AppHandle, records: &[LinkedLibraryRecord]) -> Result<Option<()>, String> {
    let values: Vec<serde_json::Value> = records
        .iter()
        .map(|record| serde_json::to_value(record))
        .collect::<Result<_, _>>()
        .map_err(|error| format!("无法序列化书库记录：{error}"))?;
    let visible_hashes: Vec<String> = records
        .iter()
        .map(|record| record.content_hash.clone())
        .collect();
    let is_new_hashes: Vec<String> = records
        .iter()
        .filter(|record| record.is_new)
        .map(|record| record.content_hash.clone())
        .collect();
    crate::portable_state_commands::with_existing_store(app, |store| {
        store
            .publish_linked_records_snapshot(values, visible_hashes, is_new_hashes)
            .map(|_| ())
    })
    .map(|result| result.map(|_| ()))
    .map_err(|error| error.to_string())
}

/// Import adds bindings and visibility without replacing concurrently imported
/// local rows. SQLite owns the entire metadata/binding publication transaction.
fn save_portable_import(
    app: &AppHandle,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
) -> Result<Option<()>, String> {
    let values = records
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法序列化书库记录：{error}"))?;
    let rows = bindings
        .iter()
        .map(|binding| {
            serde_json::to_string(binding).map(|raw| (binding.content_hash.clone(), raw))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法序列化设备绑定：{error}"))?;
    let visible = records
        .iter()
        .map(|record| record.content_hash.clone())
        .collect();
    let is_new = records
        .iter()
        .filter(|record| record.is_new)
        .map(|record| record.content_hash.clone())
        .collect();
    crate::portable_state_commands::with_existing_store(app, |store| {
        store
            .publish_linked_imports(values, rows, visible, is_new)
            .map(|_| ())
    })
    .map_err(|error| error.to_string())
}

fn load_records_at(root: &Path) -> Result<Vec<LinkedLibraryRecord>, String> {
    load_json_or_default(&records_path_at(root), "书库记录")
}

fn load_records(app: &AppHandle) -> Result<Vec<LinkedLibraryRecord>, String> {
    if let Some(records) = load_portable_records(app)? {
        observe_records_read("v3", records.len());
        return Ok(records);
    }
    let records: Vec<LinkedLibraryRecord> = load_json_or_default(&records_path(app)?, "书库记录")?;
    observe_records_read("legacy-json", records.len());
    Ok(records)
}

fn load_bindings_at(root: &Path) -> Result<Vec<DeviceBinding>, String> {
    let bindings = load_json_or_default::<Vec<DeviceBinding>>(&bindings_path_at(root), "设备绑定")?;
    validate_binding_sources(&bindings, root)?;
    Ok(bindings)
}

fn load_bindings(app: &AppHandle) -> Result<Vec<DeviceBinding>, String> {
    if let Some(bindings) = load_portable_bindings(app)? {
        return Ok(bindings);
    }
    let root = library_root(app)?;
    let bindings = load_json_or_default::<Vec<DeviceBinding>>(&bindings_path(app)?, "设备绑定")?;
    validate_binding_sources(&bindings, &root)?;
    Ok(bindings)
}

/// Validate every binding once at the JSON/file boundary.  Missing
/// `storageKind` is already defaulted to linked by serde; explicit null and
/// unknown values fail during deserialization.  The remaining shape checks are
/// kind-specific so a malformed binding can never be silently downgraded.
fn validate_binding_sources(bindings: &[DeviceBinding], library_root: &Path) -> Result<(), String> {
    for binding in bindings {
        binding
            .resolve_source(library_root)
            .map_err(|error| format!("设备绑定损坏：{error}"))?;
    }
    Ok(())
}

fn load_thumbnail_index_at(root: &Path) -> Result<ThumbnailIndex, String> {
    load_json_or_default(&thumbnails_index_path_at(root), "缩略图索引")
}

fn load_thumbnail_index(app: &AppHandle) -> Result<ThumbnailIndex, String> {
    load_json_or_default(&thumbnails_index_path(app)?, "缩略图索引")
}

pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "缓存路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建本地书库目录：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let nonce = TEMP_FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        now_ms(),
        nonce
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建临时索引：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法写入临时索引：{error}"))?;
    }
    // Unix rename is atomic in one directory.  Windows needs MoveFileEx with
    // REPLACE_EXISTING because std::fs::rename cannot replace an existing file.
    replace_file_atomically(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("无法原子替换索引：{error}")
    })
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
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

fn atomic_write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("无法序列化本地书库索引：{error}"))?;
    atomic_write_bytes(path, &bytes)
}

fn save_records(app: &AppHandle, records: &[LinkedLibraryRecord]) -> Result<(), String> {
    if save_portable_records(app, records)?.is_some() {
        return Ok(());
    }
    save_records_at(&library_root(app)?, records)
}

fn save_bindings(app: &AppHandle, bindings: &[DeviceBinding]) -> Result<(), String> {
    if save_portable_bindings(app, bindings)?.is_some() {
        return Ok(());
    }
    save_bindings_at(&library_root(app)?, bindings)
}

fn save_records_at(root: &Path, records: &[LinkedLibraryRecord]) -> Result<(), String> {
    atomic_write_json(&records_path_at(root), records)
}

fn save_bindings_at(root: &Path, bindings: &[DeviceBinding]) -> Result<(), String> {
    atomic_write_json(&bindings_path_at(root), bindings)
}

fn save_thumbnail_index_at(root: &Path, index: &ThumbnailIndex) -> Result<(), String> {
    atomic_write_json(&thumbnails_index_path_at(root), index)
}

fn save_thumbnail_index(app: &AppHandle, index: &ThumbnailIndex) -> Result<(), String> {
    save_thumbnail_index_at(&library_root(app)?, index)
}

fn snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取源 EPUB 属性：{error}"))?;
    if !metadata.is_file() {
        return Err("导入目标不是普通文件".into());
    }
    Ok(file_snapshot_from_metadata(&metadata))
}

fn snapshot_file(file: &File) -> Result<FileSnapshot, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取源 EPUB 属性：{error}"))?;
    if !metadata.is_file() {
        return Err("导入目标不是普通文件".into());
    }
    Ok(file_snapshot_from_metadata(&metadata))
}

fn file_snapshot_from_metadata(metadata: &std::fs::Metadata) -> FileSnapshot {
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    FileSnapshot {
        size: metadata.len(),
        mtime_ns,
    }
}

fn is_epub(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("epub"))
        .unwrap_or(false)
}

fn canonical_epub_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !is_epub(&path) {
        return Err("只能导入 EPUB 文件".into());
    }
    fs::canonicalize(&path).map_err(|error| format!("无法规范化源 EPUB 路径：{error}"))
}

fn hash_file(path: &Path) -> Result<(String, FileSnapshot), String> {
    let before = snapshot(path)?;
    let file = File::open(path).map_err(|error| format!("无法读取源 EPUB：{error}"))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("无法读取源 EPUB：{error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let after = snapshot(path)?;
    if before.size != after.size || before.mtime_ns != after.mtime_ns {
        return Err("源 EPUB 在计算指纹期间发生了变化，请重新导入".into());
    }
    Ok((format!("{:x}", digest.finalize()), after))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

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

fn prepare_source_read(
    library_root: &Path,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
    content_hash: &str,
) -> Result<PendingSourceRead, String> {
    let found = records
        .iter()
        .any(|record| record.content_hash == content_hash);
    observe_record_target(found);
    if !found {
        return Err("书库中没有这本书".into());
    }
    let binding = bindings
        .iter()
        .find(|binding| binding.content_hash == content_hash)
        .ok_or_else(|| "本机没有这本书的源文件绑定".to_string())?;
    let identity = SourceIdentity::from_binding(binding, library_root)
        .map_err(|_| "源 EPUB 已变化或丢失；请重新导入或重新定位".to_string())?;
    let file = File::open(&identity.path)
        .map_err(|_| "源 EPUB 已变化或丢失；请重新导入或重新定位".to_string())?;
    Ok(PendingSourceRead {
        identity,
        old_snapshot: FileSnapshot {
            size: binding.file_size,
            mtime_ns: binding.source_mtime_ns,
        },
        file,
    })
}

fn read_source_bytes_and_hash(
    file: &File,
    expected_hash: &str,
) -> Result<SourceReadResult, String> {
    let before = snapshot_file(file)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取源 EPUB：{error}"))?;
    drop(reader);
    let after = snapshot_file(file)?;
    if before.size != after.size || before.mtime_ns != after.mtime_ns {
        return Err("源 EPUB 在读取期间发生了变化；未将旧进度应用到新内容".into());
    }
    if hash_bytes(&bytes) != expected_hash {
        return Err("源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容".into());
    }
    Ok(SourceReadResult {
        bytes,
        read_snapshot: after,
    })
}

/// Streams one whole book through SHA-256 from an already-open handle.  The
/// caller must have opened the handle at offset 0.  This is only used by the
/// cover slow path after the cheap binding signature no longer matches; it
/// never materializes the book in a `Vec` and never reopens by path.
fn hash_opened_file(file: &File) -> Result<(String, FileSnapshot), String> {
    let before = snapshot_file(file)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("无法读取源 EPUB：{error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    drop(reader);
    let after = snapshot_file(file)?;
    if before.size != after.size || before.mtime_ns != after.mtime_ns {
        return Err("源 EPUB 在验证封面期间发生了变化".into());
    }
    Ok((format!("{:x}", digest.finalize()), after))
}

/// Reads exactly one cover ZIP entry.  If the opened handle still has the
/// binding signature, the existing verified signature is trusted and no
/// whole-book hash is needed.  If the signature changed, the whole book must
/// be hash-verified through this same handle before any local ZIP bytes can
/// upgrade the binding state.  The stat must remain the trusted signature
/// immediately before and after the ZIP read as well.
fn read_cover_from_opened_file(
    file: &File,
    cover_zip_path: &str,
    limit: u64,
    expected_hash: &str,
    old_snapshot: &FileSnapshot,
) -> Result<SourceReadResult, String> {
    let initial = snapshot_file(file)?;
    let trusted_snapshot = if initial == *old_snapshot {
        initial
    } else {
        let (actual_hash, verified_snapshot) = hash_opened_file(file)?;
        if actual_hash != expected_hash {
            return Err("源 EPUB 已变化或丢失；请重新导入或重新定位".into());
        }
        verified_snapshot
    };

    let before_zip = snapshot_file(file)?;
    if before_zip != trusted_snapshot {
        return Err("源 EPUB 在读取封面期间发生了变化".into());
    }
    let bytes = {
        let mut archive =
            ZipArchive::new(file).map_err(|error| format!("EPUB 不是有效 ZIP：{error}"))?;
        let mut cover_entry = archive
            .by_name(cover_zip_path)
            .map_err(|_| "EPUB 中找不到封面条目".to_string())?;
        read_zip_entry_bounded(&mut cover_entry, limit, "封面")?
    };
    let after_zip = snapshot_file(file)?;
    if after_zip != trusted_snapshot {
        return Err("源 EPUB 在读取封面期间发生了变化".into());
    }
    Ok(SourceReadResult {
        bytes,
        read_snapshot: after_zip,
    })
}


/// Opens one linked/managed source and captures the binding snapshot under the
/// short library lock.  Archive reads then continue without holding that lock.
fn prepare_library_source_read(
    app: &AppHandle,
    content_hash: &str,
) -> Result<(PathBuf, PendingSourceRead), String> {
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(app)?;
    let records = load_records(app)?;
    let bindings = load_bindings(app)?;
    let pending = prepare_source_read(&root, &records, &bindings, content_hash)?;
    Ok((root, pending))
}

/// Applies the same conditional write-back rule as the whole-book path after a
/// successful archive read.
fn finalize_library_source_read(
    app: &AppHandle,
    root: &Path,
    identity: &SourceIdentity,
    old_snapshot: &FileSnapshot,
    read_snapshot: &FileSnapshot,
) -> Result<(), String> {
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let records = load_records(app)?;
    let mut bindings = load_bindings(app)?;
    if finalize_source_read(
        root,
        &records,
        &mut bindings,
        identity,
        old_snapshot,
        read_snapshot,
    )? {
        save_bindings(app, &bindings)?;
    }
    Ok(())
}

/// Applies the BK-3 read/write-back decision table against freshly loaded
/// records and bindings.  Returns `true` when the caller must persist the
/// current binding.  The fresh snapshot is updated only for this binding; no
/// old records/bindings snapshot is copied back.
fn finalize_source_read(
    library_root: &Path,
    records: &[LinkedLibraryRecord],
    bindings: &mut [DeviceBinding],
    identity: &SourceIdentity,
    old_snapshot: &FileSnapshot,
    read_snapshot: &FileSnapshot,
) -> Result<bool, String> {
    if !records
        .iter()
        .any(|record| record.content_hash == identity.content_hash)
    {
        return Err("读取结果已过期：书库记录已变化".into());
    }
    let binding_index = bindings
        .iter()
        .position(|binding| binding.content_hash == identity.content_hash)
        .ok_or_else(|| "读取结果已过期：源文件绑定已缺失".to_string())?;
    let current_identity = SourceIdentity::from_binding(&bindings[binding_index], library_root)
        .map_err(|_| "源 EPUB 已变化或丢失；请重新导入或重新定位".to_string())?;
    if &current_identity != identity {
        return Err("读取结果已过期：源文件绑定已变化".into());
    }
    let now_snapshot = snapshot(&current_identity.path)
        .map_err(|_| "源 EPUB 已变化或丢失；请重新导入或重新定位".to_string())?;
    let binding_snapshot = FileSnapshot {
        size: bindings[binding_index].file_size,
        mtime_ns: bindings[binding_index].source_mtime_ns,
    };

    if now_snapshot == *read_snapshot {
        if binding_snapshot == *read_snapshot {
            // Signatures already agree.  Successful reads do not require a
            // verification-time update, so avoid the JSON write and sync_all.
            return Ok(false);
        }
        if binding_snapshot == *old_snapshot {
            bindings[binding_index].file_size = read_snapshot.size;
            bindings[binding_index].source_mtime_ns = read_snapshot.mtime_ns;
            bindings[binding_index].last_verified_at_ms = now_ms();
            Ok(true)
        } else {
            Err("读取结果已过期：源文件签名已变化".into())
        }
    } else if current_identity.storage_kind == StorageKind::Managed
        && binding_snapshot == now_snapshot
    {
        // A managed same-hash reimport may replace the inode while the old fd
        // is still being read.  Managed files are only published by the
        // hash-verified import pipeline, so the bytes just read remain valid;
        // never overwrite the newer binding stat with the old fd snapshot.
        Ok(false)
    } else {
        Err("读取结果已过期：源文件已变化".into())
    }
}

fn zip_path_from_relative(base: &str, href: &str) -> Option<String> {
    let href = href
        .split('#')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    let href = percent_decode_path(href);
    if href.is_empty() || href.contains('\\') || href.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in href.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None;
                }
            }
            component => parts.push(component),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// EPUB 内部 URI 使用 UTF-8 百分号编码。错误的转义保留原字节，和前端
/// `decodeURIComponent` 失败时保留原值的容错策略一致。
fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                decoded.push((hi * 16 + lo) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

fn xml_name(name: &[u8]) -> &str {
    let text = std::str::from_utf8(name).unwrap_or("");
    text.rsplit(':').next().unwrap_or(text)
}

fn xml_attr(
    reader: &Reader<&[u8]>,
    event: &quick_xml::events::BytesStart<'_>,
    wanted: &str,
) -> Option<String> {
    event.attributes().flatten().find_map(|attribute| {
        (xml_name(attribute.key.as_ref()) == wanted)
            .then(|| {
                attribute
                    // Kept for XML 1.0-compatible EPUB metadata; quick-xml's
                    // replacement additionally requires an explicit version.
                    .decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                    .ok()
                    .map(|value| value.into_owned())
            })
            .flatten()
    })
}

fn parse_container(xml: &[u8]) -> Result<String, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event))
                if xml_name(event.name().as_ref()) == "rootfile" =>
            {
                return xml_attr(&reader, &event, "full-path")
                    .ok_or_else(|| "EPUB container.xml 缺少 rootfile 路径".into())
            }
            Ok(Event::Eof) => return Err("EPUB container.xml 没有 rootfile".into()),
            Err(error) => return Err(format!("无法解析 EPUB container.xml：{error}")),
            _ => {}
        }
        buffer.clear();
    }
}

fn parse_opf(xml: &[u8], opf_path: &str) -> Result<ParsedOpfMetadata, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let base = opf_path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let mut title = String::new();
    let mut creator = String::new();
    let mut language = String::new();
    let mut capture: Option<&str> = None;
    let mut manifest = Vec::new();
    let mut manifest_indexes = HashMap::new();
    let mut spine_ids = Vec::new();
    let mut epub2_cover_id: Option<String> = None;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let event_name = event.name();
                let name = xml_name(event_name.as_ref());
                capture = match name {
                    "title" if title.is_empty() => Some("title"),
                    "creator" if creator.is_empty() => Some("creator"),
                    "language" if language.is_empty() => Some("language"),
                    _ => None,
                };
                if name == "item" {
                    if let (Some(id), Some(href)) = (
                        xml_attr(&reader, &event, "id"),
                        xml_attr(&reader, &event, "href"),
                    ) {
                        let media = xml_attr(&reader, &event, "media-type").unwrap_or_default();
                        let properties =
                            xml_attr(&reader, &event, "properties").unwrap_or_default();
                        let index = manifest.len();
                        manifest.push(OpfManifestItem {
                            id: id.clone(),
                            href,
                            media_type: media,
                            properties,
                        });
                        manifest_indexes.insert(id, index);
                    }
                } else if name == "itemref" {
                    if let Some(idref) = xml_attr(&reader, &event, "idref") {
                        if xml_attr(&reader, &event, "linear").as_deref() != Some("no") {
                            spine_ids.push(idref);
                        }
                    }
                } else if name == "meta"
                    && xml_attr(&reader, &event, "name").as_deref() == Some("cover")
                {
                    epub2_cover_id = xml_attr(&reader, &event, "content");
                }
            }
            Ok(Event::Empty(event)) => {
                let event_name = event.name();
                let name = xml_name(event_name.as_ref());
                if name == "item" {
                    if let (Some(id), Some(href)) = (
                        xml_attr(&reader, &event, "id"),
                        xml_attr(&reader, &event, "href"),
                    ) {
                        let media = xml_attr(&reader, &event, "media-type").unwrap_or_default();
                        let properties =
                            xml_attr(&reader, &event, "properties").unwrap_or_default();
                        let index = manifest.len();
                        manifest.push(OpfManifestItem {
                            id: id.clone(),
                            href,
                            media_type: media,
                            properties,
                        });
                        manifest_indexes.insert(id, index);
                    }
                } else if name == "itemref" {
                    if let Some(idref) = xml_attr(&reader, &event, "idref") {
                        if xml_attr(&reader, &event, "linear").as_deref() != Some("no") {
                            spine_ids.push(idref);
                        }
                    }
                } else if name == "meta"
                    && xml_attr(&reader, &event, "name").as_deref() == Some("cover")
                {
                    epub2_cover_id = xml_attr(&reader, &event, "content");
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(kind) = capture {
                    let value = text
                        .decode()
                        .map_err(|error| format!("无法解码 OPF 元数据：{error}"))?;
                    if kind == "title" {
                        title = value.trim().to_string();
                    } else if kind == "creator" {
                        creator = value.trim().to_string();
                    } else {
                        language = value.trim().to_string();
                    }
                }
            }
            Ok(Event::End(_)) => capture = None,
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("无法解析 EPUB OPF：{error}")),
            _ => {}
        }
        buffer.clear();
    }
    let spine = spine_ids
        .into_iter()
        .filter_map(|id| {
            manifest_indexes
                .get(&id)
                .and_then(|index| manifest.get(*index))
        })
        .filter_map(|item| zip_path_from_relative(base, &item.href))
        .collect();
    Ok(ParsedOpfMetadata {
        title,
        creator,
        language,
        spine,
        manifest,
        epub2_cover_id,
        base: base.to_string(),
    })
}

fn inferred_cover_mime(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1;
    if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        Some("image/jpeg")
    } else if extension.eq_ignore_ascii_case("png") {
        Some("image/png")
    } else if extension.eq_ignore_ascii_case("webp") {
        Some("image/webp")
    } else if extension.eq_ignore_ascii_case("avif") {
        Some("image/avif")
    } else if extension.eq_ignore_ascii_case("gif") {
        Some("image/gif")
    } else if extension.eq_ignore_ascii_case("svg") {
        Some("image/svg+xml")
    } else {
        None
    }
}

fn cover_mime(item: &OpfManifestItem, zip_path: &str) -> Option<String> {
    let declared = item.media_type.trim();
    if declared
        .get(..6)
        .map(|prefix| prefix.eq_ignore_ascii_case("image/"))
        .unwrap_or(false)
    {
        return Some(declared.to_ascii_lowercase());
    }
    inferred_cover_mime(zip_path).map(str::to_string)
}

fn is_cover_filename(path: &str) -> bool {
    let Some(file_name) = path.rsplit('/').next() else {
        return false;
    };
    let Some((stem, _)) = file_name.rsplit_once('.') else {
        return false;
    };
    stem.eq_ignore_ascii_case("cover")
}

/// 产生封面候选的优先级：EPUB3 → EPUB2 → 精确的 `cover.*` 文件名。
/// `exists` 只查询 ZIP 中央目录，不读取、解压或解码图片。
fn select_cover<F>(parsed: &ParsedOpfMetadata, mut exists: F) -> (Option<String>, String)
where
    F: FnMut(&str) -> bool,
{
    let mut candidate_indexes = Vec::new();
    candidate_indexes.extend(
        parsed
            .manifest
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.properties
                    .split_ascii_whitespace()
                    .any(|property| property == "cover-image")
            })
            .map(|(index, _)| index),
    );
    if let Some(cover_id) = &parsed.epub2_cover_id {
        candidate_indexes.extend(
            parsed
                .manifest
                .iter()
                .enumerate()
                .filter(|(_, item)| item.id == *cover_id)
                .map(|(index, _)| index),
        );
    }
    candidate_indexes.extend(
        parsed
            .manifest
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                zip_path_from_relative(&parsed.base, &item.href)
                    .as_deref()
                    .map(is_cover_filename)
                    .unwrap_or(false)
            })
            .map(|(index, _)| index),
    );

    for index in candidate_indexes {
        let Some(item) = parsed.manifest.get(index) else {
            continue;
        };
        let Some(path) = zip_path_from_relative(&parsed.base, &item.href) else {
            continue;
        };
        let Some(mime) = cover_mime(item, &path) else {
            continue;
        };
        if exists(&path) {
            return (Some(path), mime);
        }
    }
    (None, String::new())
}

fn read_zip_entry_bounded<R: Read>(
    entry: &mut R,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    entry
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 EPUB {label}：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("EPUB {label} 解压后超过允许大小"));
    }
    Ok(bytes)
}

fn inspect_epub(path: &Path) -> Result<ImportedMetadata, String> {
    let file = File::open(path).map_err(|error| format!("无法打开 EPUB ZIP：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("EPUB 不是有效 ZIP：{error}"))?;
    let mut container_entry = archive
        .by_name("META-INF/container.xml")
        .map_err(|_| "EPUB 缺少 META-INF/container.xml".to_string())?;
    let container = read_zip_entry_bounded(&mut container_entry, MAX_XML_BYTES, "container.xml")?;
    drop(container_entry);
    // Touch the declaration only.  Rendering remains responsible for its DRM
    // policy; import must not unpack the book or pretend encrypted content is plain.
    if let Ok(mut encryption) = archive.by_name("META-INF/encryption.xml") {
        let _declaration = read_zip_entry_bounded(&mut encryption, MAX_XML_BYTES, "加密声明")?;
    }
    let opf_path = parse_container(&container)?;
    let mut opf_entry = archive
        .by_name(&opf_path)
        .map_err(|_| "EPUB container.xml 指向的 OPF 不存在".to_string())?;
    let opf = read_zip_entry_bounded(&mut opf_entry, MAX_XML_BYTES, "OPF")?;
    drop(opf_entry);
    let parsed = parse_opf(&opf, &opf_path)?;
    let (cover_zip_path, cover_mime) =
        select_cover(&parsed, |candidate| archive.by_name(candidate).is_ok());
    Ok(ImportedMetadata {
        title: parsed.title,
        creator: parsed.creator,
        language: parsed.language,
        spine: parsed.spine,
        cover_zip_path,
        cover_mime,
    })
}

/// Derived local cover metadata; never part of portable book identity/state.
pub(crate) fn inspect_epub_cover(path: &Path) -> Result<(Option<String>, String), String> {
    let metadata = inspect_epub(path)?;
    Ok((metadata.cover_zip_path, metadata.cover_mime))
}

fn binding_view(
    record: LinkedLibraryRecord,
    binding: Option<&DeviceBinding>,
    thumbnail_mime: String,
    library_root: &Path,
) -> LinkedLibraryRecordView {
    let (available, file_size, cover_mime) = binding
        .map(|binding| {
            let available = binding
                .resolve_source(library_root)
                .ok()
                .and_then(|source| snapshot(source.path()).ok())
                .map(|current| {
                    current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns
                })
                .unwrap_or(false);
            (available, binding.file_size, binding.cover_mime.clone())
        })
        .unwrap_or((false, 0, String::new()));
    LinkedLibraryRecordView {
        id: record.content_hash.clone(),
        content_hash: record.content_hash,
        title: record.title,
        creator: record.creator,
        language: record.language,
        file_name: record.file_name,
        added_at_ms: record.added_at_ms,
        last_read_at_ms: record.last_read_at_ms,
        spine_index: record.spine_index,
        page: record.page,
        progress_pct: record.progress_pct,
        anchor_index: record.anchor_index,
        anchor_ratio: record.anchor_ratio,
        anchor_text_offset: record.anchor_text_offset,
        anchor_text_snippet: record.anchor_text_snippet,
        media_anchor: record.media_anchor,
        bookmarks: record.bookmarks,
        notes: record.notes,
        is_new: record.is_new,
        available,
        file_size,
        cover_mime,
        thumbnail_mime,
    }
}

fn view_by_hash(
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
    thumbnails: &ThumbnailIndex,
    hash: &str,
    library_root: &Path,
) -> Option<LinkedLibraryRecordView> {
    records
        .iter()
        .find(|record| record.content_hash == hash)
        .cloned()
        .map(|record| {
            binding_view(
                record,
                bindings.iter().find(|binding| binding.content_hash == hash),
                thumbnails
                    .entries
                    .iter()
                    .find(|entry| entry.content_hash == hash)
                    .map(|entry| entry.mime.clone())
                    .unwrap_or_default(),
                library_root,
            )
        })
}

fn upsert_binding(bindings: &mut Vec<DeviceBinding>, binding: DeviceBinding) {
    bindings.retain(|existing| existing.content_hash != binding.content_hash);
    bindings.push(binding);
}

fn make_binding(
    hash: String,
    path: &Path,
    snapshot: FileSnapshot,
    metadata: &ImportedMetadata,
) -> DeviceBinding {
    DeviceBinding {
        content_hash: hash,
        storage_kind: StorageKind::Linked,
        canonical_source_path: Some(path.to_string_lossy().into_owned()),
        file_size: snapshot.size,
        source_mtime_ns: snapshot.mtime_ns,
        cover_zip_path: metadata.cover_zip_path.clone(),
        cover_mime: metadata.cover_mime.clone(),
        last_verified_at_ms: now_ms(),
    }
}

/// Verifies an already-bound source only when its cheap stat signature
/// changes.  A different hash never replaces the binding: the portable record
/// keeps its identity and is reported unavailable until the user explicitly
/// relinks.  A managed source is always resolved from root + hash, never from
/// a persisted path.
fn verify_binding(
    binding: &mut DeviceBinding,
    library_root: &Path,
) -> Result<BindingVerification, String> {
    let source = binding.resolve_source(library_root)?;
    let source_path = source.path();
    let current = snapshot(source_path)?;
    if current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns {
        return Ok(BindingVerification {
            available: true,
            changed: false,
        });
    }
    let (actual_hash, verified_snapshot) = hash_file(source_path)?;
    if actual_hash != binding.content_hash {
        return Ok(BindingVerification {
            available: false,
            changed: false,
        });
    }
    binding.file_size = verified_snapshot.size;
    binding.source_mtime_ns = verified_snapshot.mtime_ns;
    binding.last_verified_at_ms = now_ms();
    Ok(BindingVerification {
        available: true,
        changed: true,
    })
}

/// Refresh-list semantics.  Linked sources keep the existing verification
/// behavior, including a full hash after a stat change.  Managed sources are
/// application-owned and usually refreshed from `stat` only: a mismatched
/// signature is reported unavailable until the user opens the book (explicit
/// verification) or reimports it.  A managed refresh must never trigger an
/// unconditional whole-book hash or rewrite the stored signature by itself.
fn verify_binding_for_list_refresh(
    binding: &mut DeviceBinding,
    library_root: &Path,
) -> Result<BindingVerification, String> {
    if binding.storage_kind == StorageKind::Managed {
        let source = binding.resolve_source(library_root)?;
        let available = snapshot(source.path())
            .map(|current| {
                current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns
            })
            .unwrap_or(false);
        return Ok(BindingVerification {
            available,
            changed: false,
        });
    }
    verify_binding(binding, library_root)
}

fn thumbnail_path_at(root: &Path, hash: &str) -> Result<PathBuf, String> {
    if !valid_content_hash(hash) {
        return Err("无效的书籍内容指纹".into());
    }
    Ok(thumbnails_root_at(root).join(format!("{hash}.thumb")))
}

fn thumbnail_path(app: &AppHandle, hash: &str) -> Result<PathBuf, String> {
    thumbnail_path_at(&library_root(app)?, hash)
}

fn remove_thumbnail_at(root: &Path, index: &mut ThumbnailIndex, hash: &str) -> Result<(), String> {
    let path = thumbnail_path_at(root, hash)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法删除封面缓存：{error}"))?;
    }
    index.entries.retain(|entry| entry.content_hash != hash);
    Ok(())
}

fn remove_thumbnail(app: &AppHandle, index: &mut ThumbnailIndex, hash: &str) -> Result<(), String> {
    remove_thumbnail_at(&library_root(app)?, index, hash)
}

fn prune_thumbnail_cache(app: &AppHandle, index: &mut ThumbnailIndex) -> Result<(), String> {
    index.entries.sort_by_key(|entry| entry.last_accessed_at_ms);
    let mut bytes: u64 = index.entries.iter().map(|entry| entry.size).sum();
    let mut evict = Vec::new();
    for entry in &index.entries {
        if bytes <= MAX_THUMBNAIL_CACHE_BYTES {
            break;
        }
        bytes = bytes.saturating_sub(entry.size);
        evict.push(entry.content_hash.clone());
    }
    for hash in evict {
        remove_thumbnail(app, index, &hash)?;
    }
    Ok(())
}

fn thumbnail_hash_from_file_name(name: &str) -> Option<&str> {
    let hash = name.strip_suffix(".thumb")?;
    valid_content_hash(hash).then_some(hash)
}

/// Repair the regenerable cache after an interrupted file/index commit.
/// Unindexed `.thumb` files and atomic-write `.tmp` leftovers must not escape
/// the 100 MiB accounting boundary across restarts.
fn reconcile_thumbnail_cache(app: &AppHandle, index: &mut ThumbnailIndex) -> Result<bool, String> {
    let root = thumbnails_root(app)?;
    let mut changed = false;
    let mut retained = Vec::with_capacity(index.entries.len());
    let mut indexed_hashes = HashSet::new();

    for entry in std::mem::take(&mut index.entries) {
        let structurally_valid = valid_content_hash(&entry.content_hash)
            && matches!(entry.mime.as_str(), "image/jpeg" | "image/webp")
            && entry.size > 0
            && entry.size <= MAX_THUMBNAIL_BYTES as u64
            && indexed_hashes.insert(entry.content_hash.clone());
        if !structurally_valid {
            changed = true;
            continue;
        }
        let path = root.join(format!("{}.thumb", entry.content_hash));
        let valid_file = fs::symlink_metadata(&path)
            .map(|metadata| {
                metadata.file_type().is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() == entry.size
            })
            .unwrap_or(false);
        if valid_file {
            retained.push(entry);
        } else {
            indexed_hashes.remove(&entry.content_hash);
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("无法清理异常封面缓存：{error}"))?;
            }
            changed = true;
        }
    }
    index.entries = retained;

    match fs::read_dir(&root) {
        Ok(entries) => {
            for item in entries {
                let item = item.map_err(|error| format!("无法扫描封面缓存：{error}"))?;
                let file_type = item
                    .file_type()
                    .map_err(|error| format!("无法读取封面缓存类型：{error}"))?;
                if !file_type.is_file() && !file_type.is_symlink() {
                    continue;
                }
                let name = item.file_name();
                let name = name.to_string_lossy();
                if name == "index.json" {
                    continue;
                }
                let is_indexed = thumbnail_hash_from_file_name(&name)
                    .map(|hash| indexed_hashes.contains(hash))
                    .unwrap_or(false);
                if !is_indexed {
                    fs::remove_file(item.path())
                        .map_err(|error| format!("无法清理孤立封面缓存：{error}"))?;
                    changed = true;
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法扫描封面缓存：{error}")),
    }

    let before_prune = index.entries.len();
    prune_thumbnail_cache(app, index)?;
    Ok(changed || index.entries.len() != before_prune)
}

fn import_busy_message() -> String {
    "busy: 托管书籍导入进行中".to_string()
}

/// Reject conflicting library mutations while a managed import occupies the
/// active slot. Callers already hold the library write lock, giving the fixed
/// order library write lock -> active import slot.
fn ensure_import_idle(app: &AppHandle) -> Result<(), String> {
    let active = app.state::<ManagedImportState>();
    let slot = active
        .0
        .lock()
        .map_err(|_| "导入活动槽锁已损坏".to_string())?;
    if slot.is_some() {
        Err(import_busy_message())
    } else {
        Ok(())
    }
}

fn reserve_import(app: &AppHandle, request_id: &str) -> Result<Arc<ImportJob>, NativeImportError> {
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _write_guard = write_state
        .0
        .lock()
        .map_err(|_| NativeImportError::internal_error("链接书库写入锁已损坏", false))?;
    let active_state = app.state::<ManagedImportState>();
    let mut slot = active_state
        .0
        .lock()
        .map_err(|_| NativeImportError::internal_error("导入活动槽锁已损坏", false))?;
    if slot.is_some() {
        return Err(NativeImportError::busy());
    }
    let job = Arc::new(ImportJob {
        request_id: request_id.to_string(),
        gate: Arc::new(ImportGate::default()),
    });
    *slot = Some(job.clone());
    Ok(job)
}

fn validate_document_request(
    request_id: &str,
    documents: &[DocumentSelection],
) -> Result<(), NativeImportError> {
    if request_id.trim().is_empty() {
        return Err(NativeImportError::invalid_request("requestId 不能为空"));
    }
    if documents.is_empty() {
        return Err(NativeImportError::invalid_request("documents 不能为空"));
    }
    for document in documents {
        if !document.uri.starts_with("content://") {
            return Err(NativeImportError::invalid_request(
                "documents 中的 URI 必须是 Android content://",
            ));
        }
        if let Some(file_name) = &document.file_name {
            if !portable_file_name(file_name) {
                return Err(NativeImportError::invalid_request(
                    "fileName 只能是普通文件名，不能包含路径",
                ));
            }
        }
    }
    Ok(())
}

fn send_import_progress(
    channel: &Channel<ImportProgress>,
    request_id: &str,
    phase: &str,
    completed: usize,
    total: usize,
) {
    let _ = channel.send(ImportProgress {
        request_id: request_id.to_string(),
        phase: phase.to_string(),
        completed,
        total,
    });
}

fn cleanup_stale_staging(root: &Path) -> Result<(), String> {
    let dir = root.join("books").join(".staging");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法扫描导入临时目录：{error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法扫描导入临时目录：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取导入临时文件类型：{error}"))?;
        if !file_type.is_file() && !file_type.is_symlink() {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法清理导入临时文件：{error}")),
        }
    }
    Ok(())
}

fn new_staging_path(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("books").join(".staging");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建导入临时目录：{error}"))?;
    let nonce = TEMP_FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!(
        "import-{}-{}-{}.part",
        std::process::id(),
        now_ms(),
        nonce
    )))
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
struct StagedFile {
    content_hash: String,
}

#[derive(Debug)]
enum PrepareError {
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

/// Copies one single-use restricted reader into staging while hashing the
/// exact bytes that are written. The post-copy cancellation check is the
/// integration point that catches a cancel requested during the final read.
fn stream_restricted_reader_to_staging(
    reader: &mut RestrictedReader,
    staging_path: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<StagedFile, PrepareError> {
    if cancelled() {
        return Err(PrepareError::Cancelled { content_hash: None });
    }

    let file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staging_path)
    {
        Ok(file) => file,
        Err(error) => {
            return Err(PrepareError::Failed {
                content_hash: None,
                message: format!("无法创建导入临时文件：{error}"),
            })
        }
    };
    let mut writer = HashingWriter::new(file);

    match reader.copy_limited_to(&mut writer, cancelled) {
        Ok(_) => {}
        Err(RestrictedReadError::Cancelled) => {
            return Err(PrepareError::Cancelled { content_hash: None })
        }
        Err(error) => {
            return Err(PrepareError::Failed {
                content_hash: None,
                message: format!("无法读取 Android content URI：{error}"),
            })
        }
    }

    let content_hash = writer.hash_hex();
    if cancelled() {
        return Err(PrepareError::Cancelled {
            content_hash: Some(content_hash),
        });
    }
    if let Err(error) = writer.flush() {
        return Err(PrepareError::Failed {
            content_hash: Some(content_hash),
            message: format!("无法刷新导入临时文件：{error}"),
        });
    }
    if let Err(error) = writer.inner.sync_all() {
        return Err(PrepareError::Failed {
            content_hash: Some(content_hash),
            message: format!("无法同步导入临时文件：{error}"),
        });
    }
    if cancelled() {
        return Err(PrepareError::Cancelled {
            content_hash: Some(content_hash),
        });
    }

    if let Err(message) = snapshot(staging_path) {
        return Err(PrepareError::Failed {
            content_hash: Some(content_hash),
            message,
        });
    }
    Ok(StagedFile { content_hash })
}

fn prepare_document_from_reader(
    reader: &mut RestrictedReader,
    gate: &ImportGate,
    input_index: usize,
    staging_path: &Path,
    file_name: Option<String>,
) -> Result<PreparedDocument, PrepareError> {
    let staged =
        stream_restricted_reader_to_staging(reader, staging_path, &|| gate.is_cancelled())?;
    let content_hash = staged.content_hash;

    if gate.is_cancelled() {
        return Err(PrepareError::Cancelled {
            content_hash: Some(content_hash),
        });
    }
    let metadata = match inspect_epub(staging_path) {
        Ok(metadata) => metadata,
        Err(message) => {
            return Err(PrepareError::Failed {
                content_hash: Some(content_hash),
                message,
            })
        }
    };
    if metadata.spine.is_empty() {
        return Err(PrepareError::Failed {
            content_hash: Some(content_hash),
            message: "EPUB OPF 没有可阅读的 spine 条目".to_string(),
        });
    }
    if gate.is_cancelled() {
        return Err(PrepareError::Cancelled {
            content_hash: Some(content_hash),
        });
    }

    Ok(PreparedDocument {
        input_index,
        content_hash,
        staging_path: staging_path.to_path_buf(),
        file_name: file_name.unwrap_or_else(|| "book.epub".to_string()),
        metadata,
    })
}

#[cfg(target_os = "android")]
fn prepare_document(
    app: &AppHandle,
    gate: &ImportGate,
    input_index: usize,
    staging_path: &Path,
    document: &DocumentSelection,
) -> Result<PreparedDocument, PrepareError> {
    if gate.is_cancelled() {
        return Err(PrepareError::Cancelled { content_hash: None });
    }
    let mut reader =
        crate::android_uri_bridge::open_content_uri(app, &document.uri).map_err(|error| {
            PrepareError::Failed {
                content_hash: None,
                message: format!("无法打开 Android content URI：{error}"),
            }
        })?;
    prepare_document_from_reader(
        &mut reader,
        gate,
        input_index,
        staging_path,
        document.file_name.clone(),
    )
}

fn make_managed_binding(
    content_hash: String,
    file_snapshot: FileSnapshot,
    metadata: &ImportedMetadata,
) -> DeviceBinding {
    DeviceBinding {
        content_hash,
        storage_kind: StorageKind::Managed,
        canonical_source_path: None,
        file_size: file_snapshot.size,
        source_mtime_ns: file_snapshot.mtime_ns,
        cover_zip_path: metadata.cover_zip_path.clone(),
        cover_mime: metadata.cover_mime.clone(),
        last_verified_at_ms: now_ms(),
    }
}

fn make_managed_record(
    content_hash: String,
    file_name: String,
    metadata: &ImportedMetadata,
) -> LinkedLibraryRecord {
    LinkedLibraryRecord {
        content_hash,
        title: if metadata.title.trim().is_empty() {
            "未命名书籍".to_string()
        } else {
            metadata.title.clone()
        },
        creator: metadata.creator.clone(),
        language: metadata.language.clone(),
        file_name,
        added_at_ms: now_ms(),
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
    }
}

/// Publishes prepared staging files under the already-held library write lock.
/// The caller owns the commit permit and saves the indexes after this returns.
fn publish_prepared_documents(
    root: &Path,
    records: &mut Vec<LinkedLibraryRecord>,
    bindings: &mut Vec<DeviceBinding>,
    prepared: &[PreparedItem],
) -> Result<PublishOutcome, NativeImportError> {
    let preexisting_hashes: HashSet<String> = records
        .iter()
        .map(|record| record.content_hash.clone())
        .collect();
    let mut seen = HashSet::new();
    let mut unique_documents: Vec<&PreparedDocument> = Vec::new();
    for item in prepared {
        if let PreparedItem::Ready(document) = item {
            if seen.insert(document.content_hash.as_str()) {
                unique_documents.push(document);
            }
        }
    }

    let mut outcome = PublishOutcome {
        statuses: HashMap::new(),
        failures: HashMap::new(),
        bindings_changed: false,
        records_changed: false,
    };

    for document in unique_documents {
        let target = match managed_source_path(root, &document.content_hash) {
            Ok(target) => target,
            Err(message) => {
                return Err(NativeImportError::internal_error(
                    format!("无法为导入书籍推导正式路径：{message}"),
                    true,
                ))
            }
        };
        if let Err(error) = replace_file_atomically(&document.staging_path, &target) {
            outcome.failures.insert(
                document.content_hash.clone(),
                format!("无法发布正式副本：{error}"),
            );
            continue;
        }
        let final_snapshot = match snapshot(&target) {
            Ok(snapshot) => snapshot,
            Err(message) => {
                return Err(NativeImportError::commit_failed(format!(
                    "正式副本已发布但无法读取属性：{message}；可能已部分写入，请刷新后重试"
                )))
            }
        };
        upsert_binding(
            bindings,
            make_managed_binding(
                document.content_hash.clone(),
                final_snapshot,
                &document.metadata,
            ),
        );
        outcome.bindings_changed = true;

        if preexisting_hashes.contains(&document.content_hash) {
            outcome
                .statuses
                .insert(document.content_hash.clone(), "duplicate".to_string());
        } else {
            records.push(make_managed_record(
                document.content_hash.clone(),
                document.file_name.clone(),
                &document.metadata,
            ));
            outcome.records_changed = true;
            outcome
                .statuses
                .insert(document.content_hash.clone(), "saved".to_string());
        }
    }

    Ok(outcome)
}

fn persist_import_indexes_for_app(
    app: &AppHandle,
    root: &Path,
    outcome: &PublishOutcome,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
) -> Result<(), NativeImportError> {
    if !outcome.bindings_changed && !outcome.records_changed {
        return Ok(());
    }
    if save_portable_import(app, records, bindings)
        .map_err(|message| {
            NativeImportError::commit_failed(format!(
                "正式副本可能已写入，但书库资料和绑定未能提交：{message}；请刷新后重试"
            ))
        })?
        .is_some()
    {
        return Ok(());
    }
    persist_import_indexes(root, outcome, records, bindings)
}

/// Legacy fallback persists the two JSON indexes in the same order:
/// bindings first, records second. The command owns the commit permit and
/// keeps it alive across this call. This small shared boundary is also what
/// the partial-commit unit test drives; it intentionally does not claim any
/// cross-file rollback.
fn persist_import_indexes(
    root: &Path,
    outcome: &PublishOutcome,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
) -> Result<(), NativeImportError> {
    if outcome.bindings_changed {
        save_bindings_at(root, bindings).map_err(|message| {
            NativeImportError::commit_failed(format!(
                "部分正式副本或绑定可能已写入，但保存设备绑定失败：{message}；请刷新后重试"
            ))
        })?;
    }
    if outcome.records_changed {
        save_records_at(root, records).map_err(|message| {
            NativeImportError::commit_failed(format!(
                "部分正式副本或绑定可能已写入，但保存书库记录失败：{message}；请刷新后重试"
            ))
        })?;
    }
    Ok(())
}

fn build_no_commit_results(prepared: Vec<PreparedItem>) -> ImportBatchResult {
    ImportBatchResult {
        results: prepared
            .into_iter()
            .map(|item| match item {
                PreparedItem::Ready(document) => ImportItemResult {
                    input_index: document.input_index,
                    status: "cancelled".to_string(),
                    content_hash: Some(document.content_hash),
                    record: None,
                    error: None,
                },
                PreparedItem::Failed {
                    input_index,
                    content_hash,
                    message,
                } => ImportItemResult {
                    input_index,
                    status: "failed".to_string(),
                    content_hash,
                    record: None,
                    error: Some(message),
                },
                PreparedItem::Cancelled {
                    input_index,
                    content_hash,
                } => ImportItemResult {
                    input_index,
                    status: "cancelled".to_string(),
                    content_hash,
                    record: None,
                    error: None,
                },
            })
            .collect(),
    }
}

fn build_committed_results(
    prepared: Vec<PreparedItem>,
    outcome: PublishOutcome,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
    thumbnails: &ThumbnailIndex,
    root: &Path,
) -> ImportBatchResult {
    let mut reported_new_hashes = HashSet::new();
    ImportBatchResult {
        results: prepared
            .into_iter()
            .map(|item| match item {
                PreparedItem::Ready(document) => {
                    let lookup_hash = document.content_hash.clone();
                    let content_hash = document.content_hash;
                    let failure = outcome.failures.get(&content_hash).cloned();
                    let mut status = if failure.is_some() {
                        "failed".to_string()
                    } else {
                        outcome
                            .statuses
                            .get(&content_hash)
                            .cloned()
                            .unwrap_or_else(|| "failed".to_string())
                    };
                    if failure.is_none()
                        && status == "saved"
                        && !reported_new_hashes.insert(content_hash.clone())
                    {
                        status = "duplicate".to_string();
                    }
                    let record =
                        if failure.is_none() && matches!(status.as_str(), "saved" | "duplicate") {
                            view_by_hash(records, bindings, thumbnails, &content_hash, root)
                        } else {
                            None
                        };
                    ImportItemResult {
                        input_index: document.input_index,
                        status,
                        content_hash: Some(content_hash),
                        record,
                        error: failure.or_else(|| {
                            outcome
                                .statuses
                                .get(&lookup_hash)
                                .is_none()
                                .then(|| "未取得发布状态".to_string())
                        }),
                    }
                }
                PreparedItem::Failed {
                    input_index,
                    content_hash,
                    message,
                } => ImportItemResult {
                    input_index,
                    status: "failed".to_string(),
                    content_hash,
                    record: None,
                    error: Some(message),
                },
                PreparedItem::Cancelled {
                    input_index,
                    content_hash,
                } => ImportItemResult {
                    input_index,
                    status: "cancelled".to_string(),
                    content_hash,
                    record: None,
                    error: None,
                },
            })
            .collect(),
    }
}

#[cfg(target_os = "android")]
fn run_import_documents_blocking(
    app: AppHandle,
    request_id: String,
    documents: Vec<DocumentSelection>,
    on_progress: Channel<ImportProgress>,
    mut task_guard: ImportTaskGuard,
) -> Result<ImportBatchResult, NativeImportError> {
    let gate = task_guard.job.gate.clone();
    let root = library_root(&app).map_err(NativeImportError::storage_error)?;
    cleanup_stale_staging(&root).map_err(NativeImportError::storage_error)?;

    let total = documents.len();

    let mut prepared = Vec::with_capacity(total);
    let mut cancelled_remaining = false;
    for (input_index, document) in documents.iter().enumerate() {
        if cancelled_remaining || gate.is_cancelled() {
            prepared.push(PreparedItem::Cancelled {
                input_index,
                content_hash: None,
            });
            cancelled_remaining = true;
            send_import_progress(
                &on_progress,
                &request_id,
                "preparing",
                input_index + 1,
                total,
            );
            continue;
        }

        let staging_path = match new_staging_path(&root) {
            Ok(path) => path,
            Err(message) => {
                prepared.push(PreparedItem::Failed {
                    input_index,
                    content_hash: None,
                    message,
                });
                send_import_progress(
                    &on_progress,
                    &request_id,
                    "preparing",
                    input_index + 1,
                    total,
                );
                continue;
            }
        };
        task_guard.track_staging(staging_path.clone());

        match prepare_document(&app, &gate, input_index, &staging_path, document) {
            Ok(document) => prepared.push(PreparedItem::Ready(document)),
            Err(PrepareError::Cancelled { content_hash }) => {
                prepared.push(PreparedItem::Cancelled {
                    input_index,
                    content_hash,
                });
                cancelled_remaining = true;
            }
            Err(PrepareError::Failed {
                content_hash,
                message,
            }) => prepared.push(PreparedItem::Failed {
                input_index,
                content_hash,
                message,
            }),
        }
        send_import_progress(
            &on_progress,
            &request_id,
            "preparing",
            input_index + 1,
            total,
        );
    }

    let has_ready = prepared
        .iter()
        .any(|item| matches!(item, PreparedItem::Ready(_)));
    if !has_ready {
        gate.finish_preparing();
        return Ok(build_no_commit_results(prepared));
    }

    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| NativeImportError::internal_error("链接书库写入锁已损坏", false))?;
    let root = library_root(&app).map_err(NativeImportError::storage_error)?;
    let mut records = load_records(&app).map_err(NativeImportError::storage_error)?;
    let mut bindings = load_bindings(&app).map_err(NativeImportError::storage_error)?;
    let thumbnails = load_thumbnail_index(&app).map_err(NativeImportError::storage_error)?;

    let permit = match gate.begin_commit() {
        Some(permit) => permit,
        None => {
            gate.finish_preparing();
            drop(_guard);
            return Ok(build_no_commit_results(prepared));
        }
    };

    send_import_progress(&on_progress, &request_id, "committing", total, total);
    let outcome = publish_prepared_documents(&root, &mut records, &mut bindings, &prepared)?;

    persist_import_indexes_for_app(&app, &root, &outcome, &records, &bindings)?;

    let results =
        build_committed_results(prepared, outcome, &records, &bindings, &thumbnails, &root);
    drop(permit);
    drop(_guard);
    Ok(results)
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

fn list_records_blocking(app: AppHandle) -> Result<Vec<LinkedLibraryRecordView>, String> {
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(&app)?;
    let records = load_records(&app)?;
    let known_hashes: HashSet<&str> = records
        .iter()
        .map(|record| record.content_hash.as_str())
        .collect();
    let mut bindings = load_bindings(&app)?;
    let before_prune = bindings.len();
    bindings.retain(|binding| known_hashes.contains(binding.content_hash.as_str()));
    let mut bindings_changed = bindings.len() != before_prune;
    for binding in &mut bindings {
        // Managed sources stay stat-only until an explicit open verifies or
        // reimport replaces them.  Linked sources keep the existing rehash-on-
        // signature-change semantics.
        if let Ok(verification) = verify_binding_for_list_refresh(binding, &root) {
            if verification.available {
                bindings_changed |= verification.changed;
            }
        }
    }
    if bindings_changed {
        save_bindings(&app, &bindings)?;
    }
    let mut thumbnails = load_thumbnail_index(&app)?;
    if reconcile_thumbnail_cache(&app, &mut thumbnails)? {
        save_thumbnail_index(&app, &thumbnails)?;
    }
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
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_source_raw_blocking(app, content_hash))
        .await
        .map_err(|error| format!("源 EPUB 读取工作线程失败：{error}"))?
}

fn read_source_raw_blocking(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    // Short lock: capture identity, open the source handle and remember the
    // binding signature only.  Do not hash or read the book here.
    let (root, pending) = {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let root = library_root(&app)?;
        let records = load_records(&app)?;
        let bindings = load_bindings(&app)?;
        let pending = prepare_source_read(&root, &records, &bindings, &content_hash)?;
        (root, pending)
    };

    // Heavy I/O without the library write lock: progress, notes and bookmarks
    // continue to commit while the bytes and SHA-256 are read from this fd.
    let read = read_source_bytes_and_hash(&pending.file, &content_hash)?;

    // Short lock: reload the latest indexes and apply the conditional write-
    // back table.  Never save the pre-read records/bindings snapshot.
    {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let records = load_records(&app)?;
        let mut bindings = load_bindings(&app)?;
        if finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )? {
            save_bindings(&app, &bindings)?;
        }
    }
    Ok(tauri::ipc::Response::new(read.bytes))
}

#[tauri::command]
pub async fn linked_library_read_cover_raw(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_cover_raw_blocking(app, content_hash))
        .await
        .map_err(|error| format!("封面读取工作线程失败：{error}"))?
}

fn read_cover_raw_blocking(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    // Short lock: record/binding identity plus the exact ZIP entry path.  The
    // selected entry is read from this handle without holding the lock.
    let (root, pending, cover_path) = {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let root = library_root(&app)?;
        let records = load_records(&app)?;
        if !records
            .iter()
            .any(|record| record.content_hash == content_hash)
        {
            return Err("书库中没有这本书".into());
        }
        let bindings = load_bindings(&app)?;
        let binding = bindings
            .iter()
            .find(|binding| binding.content_hash == content_hash)
            .ok_or_else(|| "本机没有这本书的源文件绑定".to_string())?;
        let Some(cover_path) = binding.cover_zip_path.clone() else {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        };
        let pending = prepare_source_read(&root, &records, &bindings, &content_hash)?;
        (root, pending, cover_path)
    };

    // Exact ZIP-entry read only; never inflate the whole EPUB for a cover.
    // The shared helper only trusts the old signature for the lightweight
    // path; a changed signature triggers a same-fd whole-book hash first.
    let read = read_cover_from_opened_file(
        &pending.file,
        &cover_path,
        MAX_COVER_BYTES,
        &pending.identity.content_hash,
        &pending.old_snapshot,
    )?;

    // Same identity/conditional write-back rule as the正文 path.
    {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let records = load_records(&app)?;
        let mut bindings = load_bindings(&app)?;
        if finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )? {
            save_bindings(&app, &bindings)?;
        }
    }
    Ok(tauri::ipc::Response::new(read.bytes))
}



fn archive_fault_message(fault: Fault) -> String {
    match fault {
        Fault::Closed => "原生归档会话已关闭".to_string(),
        Fault::InvalidRequest => "原生归档请求无效".to_string(),
        Fault::InvalidArchive => "EPUB 归档结构无效".to_string(),
        Fault::CorruptEntry => "EPUB 资源校验失败".to_string(),
        Fault::SourceChanged => "源 EPUB 在读取期间发生了变化；请重新导入或重新定位".to_string(),
        Fault::DirectoryTooLarge => "EPUB 归档目录条目过大".to_string(),
        Fault::Io => "读取源 EPUB 失败".to_string(),
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
) -> Result<ArchiveOpenView, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".to_string());
    }

    let (root, pending) = prepare_library_source_read(&app, &content_hash)?;
    let PendingSourceRead {
        identity,
        old_snapshot,
        mut file,
    } = pending;
    let (actual_hash, verified_snapshot) = hash_opened_file(&file)?;
    if !actual_hash.eq_ignore_ascii_case(&content_hash) {
        return Err("源 EPUB 已变化或丢失；请重新导入或重新定位".to_string());
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

    let session = NativeZipSession::from_verified_file(file, guard).map_err(archive_fault_message)?;
    let entry_count = session.entry_count;
    finalize_library_source_read(&app, &root, &identity, &old_snapshot, &verified_snapshot)?;

    if app.get_webview_window(&owner).is_none() {
        session.close();
        return Err("打开原生归档的窗口已关闭".to_string());
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
) -> Result<ArchiveOpenView, String> {
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
) -> Result<crate::native_zip_session::DirectoryPage, String> {
    let owner = window.label().to_string();
    let session = native_archive_session(&app, &owner, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .directory_page(start)
            .map_err(archive_fault_message)
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
) -> Result<tauri::ipc::Response, String> {
    let owner = window.label().to_string();
    let session = native_archive_session(&app, &owner, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .read_chunk(entry_index, offset)
            .map(tauri::ipc::Response::new)
            .map_err(archive_fault_message)
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
) -> Result<LinkedLibraryRecordView, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let path = canonical_epub_path(&source_path)?;
    let (actual_hash, hashed_snapshot) = hash_file(&path)?;
    if !actual_hash.eq_ignore_ascii_case(&content_hash) {
        return Err("选择的 EPUB 内容与目标书籍不一致，未重新绑定".into());
    }
    let metadata = inspect_epub(&path)?;
    if metadata.spine.is_empty() {
        return Err("EPUB OPF 没有可阅读的 spine 条目".into());
    }
    let final_snapshot = snapshot(&path)?;
    if final_snapshot.size != hashed_snapshot.size
        || final_snapshot.mtime_ns != hashed_snapshot.mtime_ns
    {
        return Err("源 EPUB 在解析期间发生了变化，请重新定位".into());
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

fn apply_progress_update(
    record: &mut LinkedLibraryRecord,
    last_read_at_ms: u64,
    spine_index: usize,
    page: usize,
    progress_pct: u32,
    anchor_index: Option<usize>,
    anchor_ratio: Option<f64>,
    anchor_text_offset: Option<u64>,
    anchor_text_snippet: Option<String>,
    media_anchor: Option<LinkedLibraryMediaAnchor>,
) {
    record.last_read_at_ms = last_read_at_ms;
    record.spine_index = spine_index;
    record.page = page;
    record.progress_pct = progress_pct.min(100);
    record.anchor_index = anchor_index;
    record.anchor_ratio = anchor_ratio;
    record.anchor_text_offset = anchor_text_offset;
    record.anchor_text_snippet = anchor_text_snippet;
    record.media_anchor = media_anchor;
    record.is_new = false;
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

fn validate_portable_records(records: &[LinkedLibraryRecord]) -> Result<(), String> {
    let mut seen = HashSet::with_capacity(records.len());
    for record in records {
        if !valid_content_hash(&record.content_hash) {
            return Err("存档含有无效的书籍内容指纹".into());
        }
        if !portable_file_name(&record.file_name) {
            return Err("存档文件名提示不得包含设备路径".into());
        }
        if !seen.insert(record.content_hash.to_ascii_lowercase()) {
            return Err("存档含有重复的书籍内容指纹".into());
        }
        if record.progress_pct > 100 {
            return Err("存档含有无效阅读百分比".into());
        }
        if !valid_optional_ratio(record.anchor_ratio) {
            return Err("存档含有无效阅读锚点比例".into());
        }
        if !valid_optional_anchor_text(record.anchor_text_offset, &record.anchor_text_snippet) {
            return Err("存档含有无效阅读文本锚点".into());
        }
        if !valid_optional_media_anchor(&record.media_anchor) {
            return Err("存档含有无效阅读媒体锚点".into());
        }
        for bookmark in &record.bookmarks {
            if !valid_optional_ratio(bookmark.anchor_ratio)
                || !valid_optional_anchor_text(
                    bookmark.anchor_text_offset,
                    &bookmark.anchor_text_snippet,
                )
                || !valid_optional_media_anchor(&bookmark.media_anchor)
            {
                return Err("存档含有无效书签锚点比例".into());
            }
        }
        let mut note_ids = HashSet::with_capacity(record.notes.len());
        for note in &record.notes {
            if !valid_note(note) {
                return Err("存档含有无效笔记".into());
            }
            if !note_ids.insert(note.id.clone()) {
                return Err("存档含有重复笔记 ID".into());
            }
        }
    }
    Ok(())
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

fn delete_records_at<F>(
    root: &Path,
    content_hashes: &[String],
    cleanup_derived_data: F,
) -> Result<(), String>
where
    F: FnOnce(&[String]) -> Result<(), String>,
{
    let records = load_records_at(root)?;

    // Deduplicate while keeping the caller's order.  It is not enough to see
    // one hash once in a HashSet: the file-deletion loop below must be
    // deterministic so a partially deleted batch can be retried predictably.
    let mut target_hashes = Vec::new();
    let mut seen = HashSet::new();
    for hash in content_hashes {
        if records.iter().any(|record| &record.content_hash == hash) && seen.insert(hash.clone()) {
            target_hashes.push(hash.clone());
        }
    }
    if target_hashes.is_empty() {
        // Every requested record is already gone.  Missing targets are a
        // no-op on retry, not a reason to reject the whole batch.
        return Ok(());
    }

    let mut bindings = load_bindings_at(root)?;

    // Resolve ownership before deleting anything.  A record without a binding
    // is still cleaned up later, but a managed path is derived only from an
    // actual managed binding; never from a bare hash and never by scanning
    // the books directory.
    let mut managed_paths = Vec::new();
    for hash in &target_hashes {
        for binding in bindings
            .iter()
            .filter(|binding| &binding.content_hash == hash)
        {
            if let BindingSource::Managed(path) = binding.resolve_source(root)? {
                managed_paths.push(path);
            }
        }
    }

    // Reuse the existing derived-data cleanup and keep the existing lock
    // order: the library write lock is already held by the caller.
    cleanup_derived_data(&target_hashes)
        .map_err(|error| format!("删除书籍前清理派生数据失败：{error}"))?;

    // Files first: remove owned copies before any index commit.  NotFound is
    // completion (a previous attempt may have deleted the file already); all
    // other I/O errors keep the indexes for a retry.
    for path in managed_paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("无法删除托管书籍源文件：{error}"));
            }
        }
    }

    let mut thumbnails = load_thumbnail_index_at(root)?;
    let target_set: HashSet<&str> = target_hashes.iter().map(String::as_str).collect();
    let mut remaining_records = records;
    remaining_records.retain(|record| !target_set.contains(record.content_hash.as_str()));
    bindings.retain(|binding| !target_set.contains(binding.content_hash.as_str()));
    for hash in &target_hashes {
        remove_thumbnail_at(root, &mut thumbnails, hash)?;
    }

    // Keep the existing commit order: bindings / thumbnail index / records.
    // A crash or I/O failure after bindings are saved leaves a record without
    // a binding; the next retry removes that record without touching a file.
    save_bindings_at(root, &bindings)?;
    save_thumbnail_index_at(root, &thumbnails)?;
    save_records_at(root, &remaining_records)
}

fn delete_records(app: &AppHandle, content_hashes: Vec<String>) -> Result<(), String> {
    if content_hashes.iter().any(|hash| !valid_content_hash(hash)) {
        return Err("无效的书籍内容指纹".into());
    }
    if content_hashes.is_empty() {
        return Ok(());
    }
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    ensure_import_idle(app)?;
    if portable_store_active(app)? {
        return delete_records_portable(app, &content_hashes);
    }
    let root = library_root(app)?;
    delete_records_at(&root, &content_hashes, |target_hashes| {
        app.state::<AiState>()
            .cleanup_books_if_present(app, target_hashes)
    })
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
    fn zip_relative_path_stays_inside_archive() {
        assert_eq!(
            zip_path_from_relative("OPS", "text/chapter.xhtml"),
            Some("OPS/text/chapter.xhtml".into())
        );
        assert_eq!(
            zip_path_from_relative("OPS", "../cover.jpg"),
            Some("cover.jpg".into())
        );
        assert_eq!(zip_path_from_relative("OPS", "../../escape.jpg"), None);
        assert_eq!(zip_path_from_relative("OPS", "/absolute.jpg"), None);
    }

    #[test]
    fn bounded_zip_reads_reject_inflated_entries() {
        assert_eq!(
            read_zip_entry_bounded(&mut std::io::Cursor::new(b"abc"), 3, "test").unwrap(),
            b"abc".to_vec()
        );
        assert!(read_zip_entry_bounded(&mut std::io::Cursor::new(b"abcd"), 3, "test").is_err());
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
    fn opf_parser_finds_metadata_spine_and_epub3_cover() {
        let opf = br#"<package><metadata><dc:title xmlns:dc='x'>Title</dc:title><dc:creator xmlns:dc='x'>Author</dc:creator><dc:language xmlns:dc='x'>zh-CN</dc:language></metadata><manifest><item id='c' href='cover.jpg' media-type='image/jpeg' properties='cover-image'/><item id='a' href='text/a.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='a'/></spine></package>"#;
        let parsed = parse_opf(opf, "OPS/book.opf").unwrap();
        assert_eq!(parsed.title, "Title");
        assert_eq!(parsed.creator, "Author");
        assert_eq!(parsed.language, "zh-CN");
        assert_eq!(parsed.spine, vec!["OPS/text/a.xhtml"]);
        let (cover_path, cover_mime) = select_cover(&parsed, |_| true);
        assert_eq!(cover_path.as_deref(), Some("OPS/cover.jpg"));
        assert_eq!(cover_mime, "image/jpeg");
    }

    #[test]
    fn opf_parser_falls_back_to_cover_filename_in_manifest_order() {
        let opf = br#"<package><metadata><dc:title xmlns:dc='x'>Title</dc:title></metadata><manifest><item id='image001' href='Images/Cover%2EWEBP?cache=1#preview' media-type=''/><item id='cover-css' href='Styles/cover.css' media-type='text/css'/></manifest><spine/></package>"#;
        let parsed = parse_opf(opf, "OPS/book.opf").unwrap();
        let (cover_path, cover_mime) =
            select_cover(&parsed, |path| path == "OPS/Images/Cover.WEBP");
        assert_eq!(cover_path.as_deref(), Some("OPS/Images/Cover.WEBP"));
        assert_eq!(cover_mime, "image/webp");
    }

    #[test]
    fn cover_selection_skips_invalid_standard_candidates_before_filename_fallback() {
        let opf = br#"<package><metadata><meta name='cover' content='cover-css'/></metadata><manifest><item id='missing' href='missing.jpg' media-type='image/jpeg' properties='cover-image'/><item id='cover-css' href='Styles/cover.css' media-type='text/css'/><item id='image001' href='Images/cover.webp' media-type='text/plain'/></manifest><spine/></package>"#;
        let parsed = parse_opf(opf, "OPS/book.opf").unwrap();
        let (cover_path, cover_mime) =
            select_cover(&parsed, |path| path == "OPS/Images/cover.webp");
        assert_eq!(cover_path.as_deref(), Some("OPS/Images/cover.webp"));
        assert_eq!(cover_mime, "image/webp");
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
        assert!(read_source_bytes_and_hash(&pending.file, &expected_hash).is_err());

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
        assert!(error.contains("超过允许大小"));

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
