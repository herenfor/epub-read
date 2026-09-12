//! Device-local implementation of the linked EPUB library.
//!
//! `LibraryRecord` is deliberately self-contained and safe to export.  The
//! companion `DeviceBinding` is never returned from list APIs, because it
//! contains an absolute path on this device.  The two JSON files are replaced
//! atomically one at a time under one mutex.  They cannot be a single atomic
//! filesystem transaction: imports write bindings first and records second, so
//! a crash can at worst leave an ignored orphan binding; deletion clears only
//! regenerable AI data before replacing the record files and never removes a
//! user-owned source file.

use crate::ai::AiState;
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use zip::ZipArchive;

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
    pub text: String,
    pub created_at_ms: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DeviceBinding {
    content_hash: String,
    canonical_source_path: String,
    file_size: u64,
    source_mtime_ns: u64,
    cover_zip_path: Option<String>,
    cover_mime: String,
    last_verified_at_ms: u64,
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

#[derive(Debug, Clone)]
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

fn valid_content_hash(hash: &str) -> bool {
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

fn records_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join("library-records.json"))
}

fn bindings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join("device-bindings.json"))
}

fn thumbnails_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join("thumbnails"))
}

fn thumbnails_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(thumbnails_root(app)?.join("index.json"))
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

fn load_records(app: &AppHandle) -> Result<Vec<LinkedLibraryRecord>, String> {
    load_json_or_default(&records_path(app)?, "书库记录")
}

fn load_bindings(app: &AppHandle) -> Result<Vec<DeviceBinding>, String> {
    load_json_or_default(&bindings_path(app)?, "设备绑定")
}

fn load_thumbnail_index(app: &AppHandle) -> Result<ThumbnailIndex, String> {
    load_json_or_default(&thumbnails_index_path(app)?, "缩略图索引")
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
    atomic_write_json(&records_path(app)?, records)
}

fn save_bindings(app: &AppHandle, bindings: &[DeviceBinding]) -> Result<(), String> {
    atomic_write_json(&bindings_path(app)?, bindings)
}

fn save_thumbnail_index(app: &AppHandle, index: &ThumbnailIndex) -> Result<(), String> {
    atomic_write_json(&thumbnails_index_path(app)?, index)
}

fn snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取源 EPUB 属性：{error}"))?;
    if !metadata.is_file() {
        return Err("导入目标不是普通文件".into());
    }
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    Ok(FileSnapshot {
        size: metadata.len(),
        mtime_ns,
    })
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

fn binding_view(
    record: LinkedLibraryRecord,
    binding: Option<&DeviceBinding>,
    thumbnail_mime: String,
) -> LinkedLibraryRecordView {
    let (available, file_size, cover_mime) = binding
        .map(|binding| {
            let available = snapshot(Path::new(&binding.canonical_source_path))
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
        canonical_source_path: path.to_string_lossy().into_owned(),
        file_size: snapshot.size,
        source_mtime_ns: snapshot.mtime_ns,
        cover_zip_path: metadata.cover_zip_path.clone(),
        cover_mime: metadata.cover_mime.clone(),
        last_verified_at_ms: now_ms(),
    }
}

/// Verifies an already-bound path only when its cheap stat signature changes.
/// A different hash never replaces the binding: the portable record keeps its
/// identity and is reported unavailable until the user explicitly relinks.
fn verify_binding(binding: &mut DeviceBinding) -> Result<BindingVerification, String> {
    let current = snapshot(Path::new(&binding.canonical_source_path))?;
    if current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns {
        return Ok(BindingVerification {
            available: true,
            changed: false,
        });
    }
    let (actual_hash, verified_snapshot) = hash_file(Path::new(&binding.canonical_source_path))?;
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

fn thumbnail_path(app: &AppHandle, hash: &str) -> Result<PathBuf, String> {
    if !valid_content_hash(hash) {
        return Err("无效的书籍内容指纹".into());
    }
    Ok(thumbnails_root(app)?.join(format!("{hash}.thumb")))
}

fn remove_thumbnail(app: &AppHandle, index: &mut ThumbnailIndex, hash: &str) -> Result<(), String> {
    let path = thumbnail_path(app, hash)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法删除封面缓存：{error}"))?;
    }
    index.entries.retain(|entry| entry.content_hash != hash);
    Ok(())
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

#[tauri::command]
pub fn linked_library_list_records(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
) -> Result<Vec<LinkedLibraryRecordView>, String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
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
        // Rehash only a changed file.  Matching bytes may simply have been
        // copied/touched; differing or unreadable bytes remain unavailable.
        if let Ok(verification) = verify_binding(binding) {
            bindings_changed |= verification.changed;
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
                        record: view_by_hash(&records, &bindings, &thumbnails, &hash),
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
                        record: view_by_hash(&records, &bindings, &thumbnails, &hash),
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
    // Safe order: a binding without a record is ignored; a visible record never
    // points at an accidentally different path after an interrupted import.
    if bindings_changed {
        save_bindings(&app, &bindings)?;
    }
    if records_changed {
        save_records(&app, &records)?;
    }
    Ok(ImportBatchResult { results })
}

#[tauri::command]
pub fn linked_library_read_source_raw(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
) -> Result<tauri::ipc::Response, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    if !load_records(&app)?
        .iter()
        .any(|record| record.content_hash == content_hash)
    {
        return Err("书库中没有这本书".into());
    }
    let mut bindings = load_bindings(&app)?;
    let binding_index = bindings
        .iter()
        .position(|binding| binding.content_hash == content_hash)
        .ok_or_else(|| "本机没有这本书的源文件绑定".to_string())?;
    let verification = verify_binding(&mut bindings[binding_index])
        .map_err(|_| "源 EPUB 已变化或丢失；请重新导入或重新定位".to_string())?;
    if !verification.available {
        return Err("源 EPUB 已变化或丢失；请重新导入或重新定位".into());
    }
    if verification.changed {
        save_bindings(&app, &bindings)?;
    }
    let source_path = bindings[binding_index].canonical_source_path.clone();
    // The current reader compatibility bridge returns the raw book in memory.
    // Random-access reading for a single extremely large EPUB is out of scope.
    let bytes = fs::read(&source_path).map_err(|error| format!("无法读取源 EPUB：{error}"))?;
    if hash_bytes(&bytes) != content_hash {
        return Err("源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn linked_library_read_cover_raw(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
) -> Result<tauri::ipc::Response, String> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    if !load_records(&app)?
        .iter()
        .any(|record| record.content_hash == content_hash)
    {
        return Err("书库中没有这本书".into());
    }
    let mut bindings = load_bindings(&app)?;
    let binding_index = bindings
        .iter()
        .position(|binding| binding.content_hash == content_hash)
        .ok_or_else(|| "本机没有这本书的源文件绑定".to_string())?;
    let Some(cover_path) = bindings[binding_index].cover_zip_path.clone() else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    let verification = verify_binding(&mut bindings[binding_index])
        .map_err(|_| "源 EPUB 已变化或丢失；请重新导入或重新定位".to_string())?;
    if !verification.available {
        return Err("源 EPUB 已变化或丢失；请重新导入或重新定位".into());
    }
    if verification.changed {
        save_bindings(&app, &bindings)?;
    }
    let source_path = bindings[binding_index].canonical_source_path.clone();
    let file = File::open(&source_path).map_err(|error| format!("无法打开源 EPUB：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("EPUB 不是有效 ZIP：{error}"))?;
    let mut cover_entry = archive
        .by_name(&cover_path)
        .map_err(|_| "EPUB 中找不到封面条目".to_string())?;
    let bytes = read_zip_entry_bounded(&mut cover_entry, MAX_COVER_BYTES, "封面")?;
    let verification = verify_binding(&mut bindings[binding_index])
        .map_err(|_| "源 EPUB 在读取封面期间发生了变化".to_string())?;
    if !verification.available {
        return Err("源 EPUB 在读取封面期间发生了变化".into());
    }
    if verification.changed {
        save_bindings(&app, &bindings)?;
    }
    Ok(tauri::ipc::Response::new(bytes))
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
    let records = load_records(&app)?;
    if !records
        .iter()
        .any(|record| record.content_hash == content_hash)
    {
        return Err("书库中没有这本书".into());
    }
    let mut bindings = load_bindings(&app)?;
    upsert_binding(
        &mut bindings,
        make_binding(content_hash.clone(), &path, final_snapshot, &metadata),
    );
    save_bindings(&app, &bindings)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash)
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
) {
    record.last_read_at_ms = last_read_at_ms;
    record.spine_index = spine_index;
    record.page = page;
    record.progress_pct = progress_pct.min(100);
    record.anchor_index = anchor_index;
    record.anchor_ratio = anchor_ratio;
    record.anchor_text_offset = anchor_text_offset;
    record.anchor_text_snippet = anchor_text_snippet;
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
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
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
    );
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash)
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
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    record.is_new = false;
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash)
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
    }) {
        return Err("书签锚点比例或文本锚点无效".into());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    record.bookmarks = bookmarks;
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash)
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
    let mut records = load_records(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.content_hash == content_hash)
        .ok_or_else(|| "书库中没有这本书".to_string())?;
    record.notes = notes;
    save_records(&app, &records)?;
    let bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    view_by_hash(&records, &bindings, &thumbnails, &content_hash)
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
        for bookmark in &record.bookmarks {
            if !valid_optional_ratio(bookmark.anchor_ratio)
                || !valid_optional_anchor_text(
                    bookmark.anchor_text_offset,
                    &bookmark.anchor_text_snippet,
                )
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

fn delete_records(app: &AppHandle, content_hashes: Vec<String>) -> Result<(), String> {
    if content_hashes.iter().any(|hash| !valid_content_hash(hash)) {
        return Err("无效的书籍内容指纹".into());
    }
    let hashes: HashSet<_> = content_hashes.into_iter().collect();
    if hashes.is_empty() {
        return Ok(());
    }
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let mut records = load_records(app)?;
    if hashes
        .iter()
        .any(|hash| !records.iter().any(|record| &record.content_hash == hash))
    {
        return Err("书库中没有所选书籍，请刷新后重试".into());
    }
    let mut bindings = load_bindings(app)?;
    let mut thumbnails = load_thumbnail_index(app)?;
    app.state::<AiState>()
        .cleanup_books_if_present(app, &hashes.iter().cloned().collect::<Vec<_>>())
        .map_err(|error| format!("删除书籍前清理派生数据失败：{error}"))?;
    // Only reader-owned records/caches are removed; source EPUBs are untouched.
    records.retain(|record| !hashes.contains(&record.content_hash));
    bindings.retain(|binding| !hashes.contains(&binding.content_hash));
    for hash in &hashes {
        remove_thumbnail(app, &mut thumbnails, hash)?;
    }
    save_bindings(app, &bindings)?;
    save_thumbnail_index(app, &thumbnails)?;
    save_records(app, &records)
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
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("缩略图写入必须使用原始二进制".into());
    };
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
    atomic_write_bytes(&thumbnail_path(&app, hash)?, bytes)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("sourcePath"));
        assert!(!json.contains("canonicalSourcePath"));
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
}
