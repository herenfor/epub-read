//! Migration-only readers for the existing JSON library files.
//!
//! This is intentionally a separate parser from the v3 DTO parser.  Old data
//! has no causal stamps and older note rows may contain wall-clock rollbacks;
//! converting it is a one-shot import operation, not a v3 write path.

use super::dto::{
    self, BookMetadata, BookmarkValue, LegacyLocator, Locator, NoteValue, PortableBook,
    PortableStateV3, Progress, ProgressState, ProgressValue, Register, Stamp, Version,
    MAX_SAFE_COUNTER,
};
use super::error::{PortableError, PortableResult};
use super::merge::next_local_counter;
use crate::library_organization::{
    empty_organization, max_observed_counter, validate_envelope, OrganizationEnvelope,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMediaAnchorJson {
    index: u64,
    tag: String,
    signature: String,
    ratio: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBookmark {
    id: String,
    spine_index: u64,
    page: u64,
    anchor_index: Option<u64>,
    anchor_ratio: Option<f64>,
    #[serde(default)]
    anchor_text_offset: Option<u64>,
    #[serde(default)]
    anchor_text_snippet: Option<String>,
    #[serde(default)]
    media_anchor: Option<LegacyMediaAnchorJson>,
    text: String,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyNote {
    id: String,
    spine_index: u64,
    chapter_path: String,
    start_text_offset: u64,
    end_text_offset: u64,
    start_text_snippet: String,
    end_text_snippet: String,
    selected_text: String,
    content: String,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRecord {
    content_hash: String,
    title: String,
    creator: String,
    #[serde(default)]
    language: String,
    file_name: String,
    added_at_ms: u64,
    last_read_at_ms: u64,
    spine_index: u64,
    page: u64,
    progress_pct: u64,
    anchor_index: Option<u64>,
    anchor_ratio: Option<f64>,
    #[serde(default)]
    anchor_text_offset: Option<u64>,
    #[serde(default)]
    anchor_text_snippet: Option<String>,
    #[serde(default)]
    media_anchor: Option<LegacyMediaAnchorJson>,
    #[serde(default)]
    bookmarks: Vec<LegacyBookmark>,
    #[serde(default)]
    notes: Vec<LegacyNote>,
    is_new: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct MigrationPlan {
    pub state: PortableStateV3,
    pub bindings: Vec<(String, String)>,
    pub installation_id: String,
    pub counter: u64,
    pub migrated_books: usize,
    pub migrated_annotations: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationMarker {
    pub status: String,
    pub version: u64,
}

pub(crate) fn completed_marker() -> MigrationMarker {
    MigrationMarker {
        status: "complete".to_string(),
        version: 1,
    }
}

fn path_error(path: &Path, error: std::io::Error) -> PortableError {
    PortableError::storage_error(format!("无法读取 {}：{error}", path.display()))
}

fn read_json_vec(path: &Path, label: &str) -> PortableResult<Vec<Value>> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Vec<Value>>(&text)
            .map_err(|error| PortableError::invalid_data(format!("{label}损坏：{error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(path_error(path, error)),
    }
}

fn safe_number(value: u64) -> bool {
    value <= MAX_SAFE_COUNTER
}

fn valid_old_text_anchor(offset: Option<u64>, snippet: &Option<String>) -> PortableResult<()> {
    if let Some(offset) = offset {
        if !safe_number(offset) {
            return Err(PortableError::invalid_data(
                "旧资料损坏：anchorTextOffset 超出安全范围",
            ));
        }
    }
    match (offset, snippet) {
        (None, Some(_)) => Err(PortableError::invalid_data(
            "旧资料损坏：anchorTextSnippet 缺少 offset",
        )),
        (_, None) => Ok(()),
        (Some(_), Some(value)) => {
            if dto::valid_anchor_snippet(value) {
                Ok(())
            } else {
                Err(PortableError::invalid_data(
                    "旧资料损坏：anchorTextSnippet 不合法",
                ))
            }
        }
    }
}

fn valid_ratio_option(value: Option<f64>) -> PortableResult<()> {
    if let Some(ratio) = value {
        if !ratio.is_finite() || !(0.0..=1.0).contains(&ratio) {
            return Err(PortableError::invalid_data(
                "旧资料损坏：锚点比例必须在 0 到 1 之间",
            ));
        }
    }
    Ok(())
}

fn convert_media(anchor: &LegacyMediaAnchorJson) -> PortableResult<dto::LegacyMediaAnchor> {
    if !safe_number(anchor.index)
        || anchor.tag.is_empty()
        || anchor.signature.is_empty()
        || !anchor.ratio.is_finite()
        || !(0.0..=1.0).contains(&anchor.ratio)
    {
        return Err(PortableError::invalid_data("旧资料损坏：媒体锚点不合法"));
    }
    Ok(dto::LegacyMediaAnchor {
        index: anchor.index,
        tag: anchor.tag.clone(),
        signature: anchor.signature.clone(),
        ratio: anchor.ratio,
    })
}

fn convert_legacy_locator(
    spine_index: u64,
    page_hint: u64,
    anchor_index: Option<u64>,
    anchor_ratio: Option<f64>,
    anchor_text_offset: Option<u64>,
    anchor_text_snippet: &Option<String>,
    media_anchor: Option<&LegacyMediaAnchorJson>,
) -> PortableResult<Locator> {
    if !safe_number(spine_index) || !safe_number(page_hint) {
        return Err(PortableError::invalid_data(
            "旧资料损坏：定位器超出安全范围",
        ));
    }
    if anchor_index
        .map(|value| !safe_number(value))
        .unwrap_or(false)
    {
        return Err(PortableError::invalid_data(
            "旧资料损坏：anchorIndex 超出安全范围",
        ));
    }
    valid_ratio_option(anchor_ratio)?;
    valid_old_text_anchor(anchor_text_offset, anchor_text_snippet)?;
    let media_anchor = match media_anchor {
        Some(anchor) => Some(convert_media(anchor)?),
        None => None,
    };
    Ok(Locator::Legacy(LegacyLocator {
        locator_version: 0,
        spine_index,
        page_hint,
        anchor_index,
        anchor_ratio,
        anchor_text_offset,
        anchor_text_snippet: anchor_text_snippet.clone(),
        media_anchor,
    }))
}

fn convert_bookmark(bookmark: &LegacyBookmark) -> PortableResult<BookmarkValue> {
    if bookmark.id.trim().is_empty() {
        return Err(PortableError::invalid_data("旧资料损坏：书签 ID 为空"));
    }
    if !safe_number(bookmark.created_at_ms) {
        return Err(PortableError::invalid_data(
            "旧资料损坏：书签创建时间超出安全范围",
        ));
    }
    Ok(BookmarkValue {
        locator: convert_legacy_locator(
            bookmark.spine_index,
            bookmark.page,
            bookmark.anchor_index,
            bookmark.anchor_ratio,
            bookmark.anchor_text_offset,
            &bookmark.anchor_text_snippet,
            bookmark.media_anchor.as_ref(),
        )?,
        text: bookmark.text.clone(),
        created_at_ms: bookmark.created_at_ms,
    })
}

fn convert_note(note: &LegacyNote) -> PortableResult<NoteValue> {
    let value = NoteValue {
        chapter_path: note.chapter_path.clone(),
        spine_index_hint: note.spine_index,
        text_profile: dto::TEXT_PROFILE.to_string(),
        start_text_offset: note.start_text_offset,
        end_text_offset: note.end_text_offset,
        start_text_snippet: note.start_text_snippet.clone(),
        end_text_snippet: note.end_text_snippet.clone(),
        selected_text: note.selected_text.clone(),
        content: note.content.clone(),
        created_at_ms: note.created_at_ms,
    };
    // v3 deliberately allows updatedAtMs older than createdAtMs, so the old
    // wall-clock ordering check is intentionally absent.
    dto::validate_note(&value)?;
    if !safe_number(note.updated_at_ms) {
        return Err(PortableError::invalid_data(
            "旧资料损坏：笔记修改时间超出安全范围",
        ));
    }
    Ok(value)
}

fn next_stamp(counter: &mut u64, installation_id: &str) -> PortableResult<Stamp> {
    *counter = next_local_counter(*counter, 0)?;
    Ok(Stamp {
        device_id: installation_id.to_string(),
        counter: *counter,
    })
}

fn version<T>(stamp: Stamp, value: T, updated_at_ms: u64) -> Version<T> {
    let clock = BTreeMap::from([(stamp.device_id.clone(), stamp.counter)]);
    Version {
        stamp,
        clock,
        value,
        updated_at_ms,
    }
}

fn convert_record(
    record: &LegacyRecord,
    counter: &mut u64,
    installation_id: &str,
) -> PortableResult<PortableBook> {
    if !dto::valid_content_hash(&record.content_hash) {
        return Err(PortableError::invalid_data(
            "旧资料损坏：contentHash 不是 64 位小写指纹",
        ));
    }
    if !safe_number(record.added_at_ms)
        || !safe_number(record.last_read_at_ms)
        || !safe_number(record.spine_index)
        || !safe_number(record.page)
    {
        return Err(PortableError::invalid_data("旧资料损坏：数值超出安全范围"));
    }
    if record.progress_pct > 100 {
        return Err(PortableError::invalid_data(
            "旧资料损坏：progressPct 必须在 0 到 100 之间",
        ));
    }
    if !portable_file_name(&record.file_name) {
        return Err(PortableError::invalid_data(
            "旧资料损坏：fileName 不是可移植文件名",
        ));
    }
    let metadata_stamp = next_stamp(counter, installation_id)?;
    let progress_stamp = next_stamp(counter, installation_id)?;
    let metadata = Register {
        value: BookMetadata {
            title: record.title.clone(),
            creator: record.creator.clone(),
            language: if record.language.is_empty() {
                None
            } else {
                Some(record.language.clone())
            },
            file_name: record.file_name.clone(),
            added_at_ms: record.added_at_ms,
        },
        stamp: metadata_stamp,
    };
    let locator = convert_legacy_locator(
        record.spine_index,
        record.page,
        record.anchor_index,
        record.anchor_ratio,
        record.anchor_text_offset,
        &record.anchor_text_snippet,
        record.media_anchor.as_ref(),
    )?;
    let progress_value: ProgressValue = Some(Progress {
        locator,
        progress_pct_hint: record.progress_pct,
    });
    let progress = ProgressState {
        versions: vec![version(
            progress_stamp,
            progress_value,
            record.last_read_at_ms,
        )],
    };

    let mut bookmarks = BTreeMap::new();
    let mut seen_bookmark_ids = HashSet::new();
    for bookmark in &record.bookmarks {
        if !seen_bookmark_ids.insert(bookmark.id.clone()) {
            return Err(PortableError::invalid_data(
                "旧资料损坏：同一本书存在重复书签 ID",
            ));
        }
        let value = convert_bookmark(bookmark)?;
        let stamp = next_stamp(counter, installation_id)?;
        bookmarks.insert(
            bookmark.id.clone(),
            dto::Annotation {
                versions: vec![version(stamp, value, bookmark.created_at_ms)],
                deleted: None,
            },
        );
    }

    let mut notes = BTreeMap::new();
    let mut seen_note_ids = HashSet::new();
    for note in &record.notes {
        if !seen_note_ids.insert(note.id.clone()) {
            return Err(PortableError::invalid_data(
                "旧资料损坏：同一本书存在重复笔记 ID",
            ));
        }
        let value = convert_note(note)?;
        let stamp = next_stamp(counter, installation_id)?;
        notes.insert(
            note.id.clone(),
            dto::Annotation {
                versions: vec![version(stamp, value, note.updated_at_ms)],
                deleted: None,
            },
        );
    }

    Ok(PortableBook {
        metadata,
        progress,
        bookmarks,
        notes,
    })
}

fn portable_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.to_ascii_lowercase().starts_with("file:")
}

fn parse_organization(root: &Path) -> PortableResult<OrganizationEnvelope> {
    let path = root.join("library-organization.json");
    match fs::read_to_string(&path) {
        Ok(text) => {
            let envelope: OrganizationEnvelope = serde_json::from_str(&text)
                .map_err(|error| PortableError::invalid_data(format!("旧组织数据损坏：{error}")))?;
            validate_envelope(&envelope).map_err(PortableError::invalid_data)?;
            Ok(envelope)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(OrganizationEnvelope {
            device_id: random_uuid_v4()?,
            counter: 0,
            state: empty_organization(),
        }),
        Err(error) => Err(path_error(&path, error)),
    }
}

fn parse_bindings(root: &Path) -> PortableResult<Vec<(String, String)>> {
    let path = root.join("device-bindings.json");
    let values = read_json_vec(&path, "旧设备绑定数据")?;
    let mut bindings = BTreeMap::new();
    for value in values {
        let object = value
            .as_object()
            .ok_or_else(|| PortableError::invalid_data("旧设备绑定数据损坏：条目不是对象"))?;
        let content_hash = object
            .get("contentHash")
            .and_then(Value::as_str)
            .ok_or_else(|| PortableError::invalid_data("旧设备绑定数据损坏：缺少 contentHash"))?;
        if !dto::valid_content_hash(content_hash) {
            return Err(PortableError::invalid_data(
                "旧设备绑定数据损坏：contentHash 不规范",
            ));
        }
        let encoded = serde_json::to_string(&value).map_err(|error| {
            PortableError::storage_error(format!("无法序列化旧设备绑定：{error}"))
        })?;
        match bindings.get(content_hash) {
            Some(existing) if existing == &encoded => {}
            Some(_) => {
                return Err(PortableError::invalid_data(
                    "旧设备绑定数据损坏：同一指纹出现不同绑定",
                ))
            }
            None => {
                bindings.insert(content_hash.to_string(), encoded);
            }
        }
    }
    Ok(bindings.into_iter().collect())
}

pub(crate) fn build_migration_plan(root: &Path) -> PortableResult<MigrationPlan> {
    let records_path = root.join("library-records.json");
    let records_text = match fs::read_to_string(&records_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "[]".to_string(),
        Err(error) => return Err(path_error(&records_path, error)),
    };
    let records: Vec<LegacyRecord> = serde_json::from_str(&records_text)
        .map_err(|error| PortableError::invalid_data(format!("旧书库记录损坏：{error}")))?;
    let organization = parse_organization(root)?;
    let mut counter = organization
        .counter
        .max(max_observed_counter(&organization.state));
    if counter > MAX_SAFE_COUNTER {
        return Err(PortableError::clock_exhausted(
            "clock-exhausted：旧本机时钟超出安全范围",
        ));
    }
    let installation_id = organization.device_id.clone();

    let mut books = BTreeMap::new();
    let mut migrated_annotations = 0;
    for record in &records {
        if books.contains_key(&record.content_hash) {
            return Err(PortableError::invalid_data(
                "旧书库记录损坏：同一本书重复出现",
            ));
        }
        let book = convert_record(record, &mut counter, &installation_id)?;
        migrated_annotations += book.bookmarks.len() + book.notes.len();
        books.insert(record.content_hash.clone(), book);
    }
    let bindings = parse_bindings(root)?;

    Ok(MigrationPlan {
        state: PortableStateV3 {
            schema_version: 3,
            books,
            organization: organization.state,
            preferences: None,
        },
        bindings,
        installation_id,
        counter,
        migrated_books: records.len(),
        migrated_annotations,
    })
}

pub(crate) fn random_uuid_v4() -> PortableResult<String> {
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
fn fill_random_bytes(buffer: &mut [u8]) -> PortableResult<()> {
    use std::io::Read;
    let mut source = fs::File::open("/dev/urandom")
        .map_err(|error| PortableError::storage_error(format!("无法读取系统随机数：{error}")))?;
    source
        .read_exact(buffer)
        .map_err(|error| PortableError::storage_error(format!("无法读取系统随机数：{error}")))
}

#[cfg(windows)]
fn fill_random_bytes(buffer: &mut [u8]) -> PortableResult<()> {
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
    // SAFETY: `buffer` is a valid writable slice for `length` bytes.
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
        Err(PortableError::storage_error(format!(
            "无法取得系统随机数：NTSTATUS {status:#x}"
        )))
    }
}

#[cfg(not(any(unix, windows)))]
fn fill_random_bytes(_buffer: &mut [u8]) -> PortableResult<()> {
    Err(PortableError::storage_error(
        "当前平台没有可用的系统随机数来源",
    ))
}
