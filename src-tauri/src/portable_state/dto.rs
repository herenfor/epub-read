//! Frozen v3 wire DTOs and their explicit boundary validation.
//!
//! These types are deliberately not wired into the shelf yet.  The repository
//! stores their JSON after this module has validated it, and never lets an
//! untrusted archive bypass that parser.

use super::error::{PortableError, PortableResult};
use crate::library_organization::LibraryOrganization;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const MAX_SAFE_COUNTER: u64 = 9_007_199_254_740_991;
pub const MAX_ANCHOR_SNIPPET_CODE_POINTS: usize = 32;
pub const MAX_NOTE_SELECTED_CODE_POINTS: usize = 4096;
pub const MAX_NOTE_CONTENT_CODE_POINTS: usize = 10_000;
pub const TEXT_PROFILE: &str = "visible-codepoints-no-whitespace-v1";

/// `Option<T>` is intentionally decoded through this function when the wire
/// distinguishes a missing key (None) from an explicit `null` (invalid).
pub(crate) fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stamp {
    pub device_id: String,
    pub counter: u64,
}

/// Fields whose absence must remain distinguishable from an explicit `null`.
/// This is the opposite of `deserialize_present`: explicit null is a value and
/// a missing key is a deserialization error.
pub(crate) fn deserialize_required<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    deny_unknown_fields,
    bound(deserialize = "T: Deserialize<'de>")
)]
pub struct Version<T> {
    pub stamp: Stamp,
    pub clock: BTreeMap<String, u64>,
    #[serde(deserialize_with = "deserialize_required")]
    pub value: T,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation<T> {
    pub versions: Vec<Version<T>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub deleted: Option<Stamp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Register<T> {
    pub value: T,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    Sepia,
    Gray,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortablePreferences {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub theme: Option<Theme>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub font_size_px: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub line_height: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub font_weight: Option<u16>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub letter_spacing_px: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub word_spacing_px: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModernLocator {
    pub locator_version: u8,
    pub chapter_path: String,
    pub spine_index_hint: u64,
    pub target: LocatorTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocatorTarget {
    #[serde(rename = "chapter-start")]
    ChapterStart,
    Text {
        #[serde(rename = "textProfile")]
        text_profile: String,
        offset: u64,
        snippet: String,
    },
    Media {
        signature: String,
        #[serde(rename = "indexHint")]
        index_hint: u64,
        tag: MediaTag,
        ratio: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaTag {
    Img,
    Svg,
    Video,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMediaAnchor {
    #[serde(rename = "index")]
    pub index: u64,
    pub tag: String,
    pub signature: String,
    pub ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLocator {
    pub locator_version: u8,
    pub spine_index: u64,
    pub page_hint: u64,
    pub anchor_index: Option<u64>,
    pub anchor_ratio: Option<f64>,
    pub anchor_text_offset: Option<u64>,
    pub anchor_text_snippet: Option<String>,
    pub media_anchor: Option<LegacyMediaAnchor>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Locator {
    Modern(ModernLocator),
    Legacy(LegacyLocator),
}

impl<'de> Deserialize<'de> for Locator {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        locator_from_value(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub locator: Locator,
    pub progress_pct_hint: u64,
}

/// The frozen wire uses explicit `null` for progress reset.
pub type ProgressValue = Option<Progress>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookmarkValue {
    pub locator: Locator,
    pub text: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteValue {
    pub chapter_path: String,
    pub spine_index_hint: u64,
    pub text_profile: String,
    pub start_text_offset: u64,
    pub end_text_offset: u64,
    pub start_text_snippet: String,
    pub end_text_snippet: String,
    pub selected_text: String,
    pub content: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookMetadata {
    pub title: String,
    pub creator: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub language: Option<String>,
    pub file_name: String,
    pub added_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressState {
    pub versions: Vec<Version<ProgressValue>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableBook {
    pub metadata: Register<BookMetadata>,
    pub progress: ProgressState,
    pub bookmarks: BTreeMap<String, Annotation<BookmarkValue>>,
    pub notes: BTreeMap<String, Annotation<NoteValue>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableStateV3 {
    pub schema_version: u64,
    pub books: BTreeMap<String, PortableBook>,
    #[serde(deserialize_with = "deserialize_organization_strict")]
    pub organization: LibraryOrganization,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub preferences: Option<PortablePreferences>,
}

pub fn valid_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
        }
    })
}

pub fn valid_content_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn safe_counter(value: u64) -> bool {
    (1..=MAX_SAFE_COUNTER).contains(&value)
}

pub fn safe_time(value: u64) -> bool {
    value <= MAX_SAFE_COUNTER
}

pub fn validate_stamp(stamp: &Stamp) -> PortableResult<()> {
    if !valid_canonical_uuid(&stamp.device_id) {
        return Err(PortableError::invalid_data(
            "invalid-event-clock：设备 ID 不是规范 UUID",
        ));
    }
    if !safe_counter(stamp.counter) {
        return Err(PortableError::invalid_data(
            "invalid-event-clock：逻辑时钟必须在 1 到 MAX_SAFE_INTEGER 之间",
        ));
    }
    Ok(())
}

pub fn validate_clock(stamp: &Stamp, clock: &BTreeMap<String, u64>) -> PortableResult<()> {
    validate_stamp(stamp)?;
    if clock.get(&stamp.device_id).copied() != Some(stamp.counter) {
        return Err(PortableError::invalid_data(
            "invalid-event-clock：clock 必须包含自身 stamp",
        ));
    }
    for (device_id, counter) in clock {
        if !valid_canonical_uuid(device_id) {
            return Err(PortableError::invalid_data(
                "invalid-event-clock：clock 含有非规范设备 UUID",
            ));
        }
        if !safe_counter(*counter) {
            return Err(PortableError::invalid_data(
                "invalid-event-clock：clock 计数超出安全范围",
            ));
        }
        if device_id != &stamp.device_id && *counter >= stamp.counter {
            return Err(PortableError::invalid_data(
                "invalid-event-clock：本机事件必须晚于全部已见事件",
            ));
        }
    }
    Ok(())
}

pub fn validate_version_shape<T>(version: &Version<T>) -> PortableResult<()> {
    validate_clock(&version.stamp, &version.clock)?;
    if !safe_time(version.updated_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：updatedAtMs 必须是非负安全整数",
        ));
    }
    Ok(())
}

pub fn code_point_count(value: &str) -> usize {
    value.chars().count()
}

pub fn normalized_code_point_count(value: &str) -> usize {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
}

fn is_visible_anchor_text(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(char::is_whitespace)
}

pub fn valid_anchor_snippet(value: &str) -> bool {
    is_visible_anchor_text(value) && code_point_count(value) <= MAX_ANCHOR_SNIPPET_CODE_POINTS
}

fn valid_ratio(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn valid_safe_non_negative(value: u64) -> bool {
    value <= MAX_SAFE_COUNTER
}

fn portable_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.to_ascii_lowercase().starts_with("file:")
}

/// A decoded ZIP identity, not an href or a host filesystem path.
pub fn valid_chapter_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let drive_path =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.starts_with('/')
        || drive_path
    {
        return false;
    }
    value
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub fn validate_book_metadata(metadata: &BookMetadata) -> PortableResult<()> {
    if !portable_file_name(&metadata.file_name) {
        return Err(PortableError::invalid_data(
            "invalid-data：fileName 不能是绝对路径、file: URI 或目录路径",
        ));
    }
    if !safe_time(metadata.added_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：addedAtMs 必须是非负安全整数",
        ));
    }
    if let Some(language) = &metadata.language {
        if language.contains('\0') {
            return Err(PortableError::invalid_data(
                "invalid-data：language 含有 NUL",
            ));
        }
    }
    Ok(())
}

pub fn validate_locator(locator: &Locator) -> PortableResult<()> {
    match locator {
        Locator::Modern(modern) => {
            if modern.locator_version != 1 {
                return Err(PortableError::invalid_data(
                    "invalid-data：modern locatorVersion 必须为 1",
                ));
            }
            if !valid_chapter_path(&modern.chapter_path) {
                return Err(PortableError::invalid_data(
                    "invalid-data：chapterPath 不是 EPUB 内部相对路径",
                ));
            }
            if !valid_safe_non_negative(modern.spine_index_hint) {
                return Err(PortableError::invalid_data(
                    "invalid-data：spineIndexHint 超出安全范围",
                ));
            }
            match &modern.target {
                LocatorTarget::ChapterStart => Ok(()),
                LocatorTarget::Text {
                    text_profile,
                    offset,
                    snippet,
                } => {
                    if text_profile != TEXT_PROFILE {
                        return Err(PortableError::invalid_data(
                            "invalid-data：未知 textProfile",
                        ));
                    }
                    if !valid_safe_non_negative(*offset) {
                        return Err(PortableError::invalid_data(
                            "invalid-data：text offset 超出安全范围",
                        ));
                    }
                    if !valid_anchor_snippet(snippet) {
                        return Err(PortableError::invalid_data(
                            "invalid-data：snippet 必须是少于等于 32 个无空白码点",
                        ));
                    }
                    Ok(())
                }
                LocatorTarget::Media {
                    signature,
                    index_hint,
                    tag: _,
                    ratio,
                } => {
                    if signature.is_empty() {
                        return Err(PortableError::invalid_data(
                            "invalid-data：媒体签名不能为空",
                        ));
                    }
                    if !valid_safe_non_negative(*index_hint) {
                        return Err(PortableError::invalid_data(
                            "invalid-data：媒体 indexHint 超出安全范围",
                        ));
                    }
                    if !valid_ratio(*ratio) {
                        return Err(PortableError::invalid_data(
                            "invalid-data：媒体 ratio 必须在 0 到 1 之间",
                        ));
                    }
                    Ok(())
                }
            }
        }
        Locator::Legacy(legacy) => {
            if legacy.locator_version != 0 {
                return Err(PortableError::invalid_data(
                    "invalid-data：legacy locatorVersion 必须为 0",
                ));
            }
            if !valid_safe_non_negative(legacy.spine_index)
                || !valid_safe_non_negative(legacy.page_hint)
            {
                return Err(PortableError::invalid_data(
                    "invalid-data：legacy 定位器整数超出安全范围",
                ));
            }
            if let Some(offset) = legacy.anchor_text_offset {
                if !valid_safe_non_negative(offset) {
                    return Err(PortableError::invalid_data(
                        "invalid-data：anchorTextOffset 超出安全范围",
                    ));
                }
            }
            if let Some(snippet) = &legacy.anchor_text_snippet {
                if !valid_anchor_snippet(snippet) {
                    return Err(PortableError::invalid_data(
                        "invalid-data：anchorTextSnippet 不是合法片段",
                    ));
                }
                if legacy.anchor_text_offset.is_none() {
                    return Err(PortableError::invalid_data(
                        "invalid-data：anchorTextSnippet 缺少 anchorTextOffset",
                    ));
                }
            }
            if let Some(index) = legacy.anchor_index {
                if !valid_safe_non_negative(index) {
                    return Err(PortableError::invalid_data(
                        "invalid-data：anchorIndex 超出安全范围",
                    ));
                }
            }
            if let Some(ratio) = legacy.anchor_ratio {
                if !valid_ratio(ratio) {
                    return Err(PortableError::invalid_data(
                        "invalid-data：anchorRatio 必须在 0 到 1 之间",
                    ));
                }
            }
            if let Some(media) = &legacy.media_anchor {
                if !valid_safe_non_negative(media.index)
                    || media.tag.is_empty()
                    || media.signature.is_empty()
                    || !valid_ratio(media.ratio)
                {
                    return Err(PortableError::invalid_data(
                        "invalid-data：legacy 媒体锚点不合法",
                    ));
                }
            }
            Ok(())
        }
    }
}

pub fn validate_progress(value: &ProgressValue) -> PortableResult<()> {
    if let Some(progress) = value {
        validate_locator(&progress.locator)?;
        if !valid_safe_non_negative(progress.progress_pct_hint) {
            return Err(PortableError::invalid_data(
                "invalid-data：progressPctHint 超出安全范围",
            ));
        }
    }
    Ok(())
}

pub fn validate_progress_version(version: &Version<ProgressValue>) -> PortableResult<()> {
    validate_version_shape(version)?;
    validate_progress(&version.value)
}

pub fn validate_bookmark(value: &BookmarkValue) -> PortableResult<()> {
    validate_locator(&value.locator)?;
    if !safe_time(value.created_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：createdAtMs 必须是非负安全整数",
        ));
    }
    Ok(())
}

pub fn validate_bookmark_version(version: &Version<BookmarkValue>) -> PortableResult<()> {
    validate_version_shape(version)?;
    validate_bookmark(&version.value)
}

pub fn validate_note(value: &NoteValue) -> PortableResult<()> {
    if !valid_chapter_path(&value.chapter_path) {
        return Err(PortableError::invalid_data(
            "invalid-data：chapterPath 不是 EPUB 内部相对路径",
        ));
    }
    if !valid_safe_non_negative(value.spine_index_hint)
        || !valid_safe_non_negative(value.start_text_offset)
        || !valid_safe_non_negative(value.end_text_offset)
        || value.end_text_offset <= value.start_text_offset
    {
        return Err(PortableError::invalid_data(
            "invalid-data：笔记文本范围不合法",
        ));
    }
    if value.text_profile != TEXT_PROFILE {
        return Err(PortableError::invalid_data(
            "invalid-data：未知 textProfile",
        ));
    }
    if !valid_anchor_snippet(&value.start_text_snippet)
        || !valid_anchor_snippet(&value.end_text_snippet)
    {
        return Err(PortableError::invalid_data(
            "invalid-data：笔记片段必须是少于等于 32 个无空白码点",
        ));
    }
    if value.selected_text.is_empty()
        || code_point_count(&value.selected_text) > MAX_NOTE_SELECTED_CODE_POINTS
        || normalized_code_point_count(&value.selected_text)
            != (value.end_text_offset - value.start_text_offset) as usize
    {
        return Err(PortableError::invalid_data(
            "invalid-data：selectedText 与文本范围不一致",
        ));
    }
    if value.content.trim().is_empty()
        || code_point_count(&value.content) > MAX_NOTE_CONTENT_CODE_POINTS
    {
        return Err(PortableError::invalid_data("invalid-data：content 不合法"));
    }
    if !safe_time(value.created_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：createdAtMs 必须是非负安全整数",
        ));
    }
    Ok(())
}

pub fn validate_note_version(version: &Version<NoteValue>) -> PortableResult<()> {
    validate_version_shape(version)?;
    validate_note(&version.value)
}

pub fn validate_annotation<T>(
    annotation: &Annotation<T>,
    validate_value: impl Fn(&Version<T>) -> PortableResult<()>,
) -> PortableResult<()> {
    if let Some(deleted) = &annotation.deleted {
        validate_stamp(deleted)?;
    }
    for version in &annotation.versions {
        validate_value(version)?;
    }
    Ok(())
}

pub fn validate_organization(organization: &LibraryOrganization) -> PortableResult<()> {
    crate::library_organization::validate_organization(organization)
        .map_err(PortableError::invalid_data)
}

pub fn validate_preferences(preferences: &PortablePreferences) -> PortableResult<()> {
    if let Some(font_size) = preferences.font_size_px {
        if !font_size.is_finite() || !(12.0..=32.0).contains(&font_size) {
            return Err(PortableError::invalid_data(
                "invalid-data：fontSizePx 必须在 12 到 32 之间",
            ));
        }
    }
    if let Some(line_height) = preferences.line_height {
        if !line_height.is_finite() || !(1.2..=2.4).contains(&line_height) {
            return Err(PortableError::invalid_data(
                "invalid-data：lineHeight 必须在 1.2 到 2.4 之间",
            ));
        }
    }
    if let Some(font_weight) = preferences.font_weight {
        if !(300..=700).contains(&font_weight) || font_weight % 100 != 0 {
            return Err(PortableError::invalid_data(
                "invalid-data：fontWeight 必须是 300 到 700 的整百值",
            ));
        }
    }
    if let Some(letter_spacing) = preferences.letter_spacing_px {
        if !letter_spacing.is_finite() || !(0.0..=8.0).contains(&letter_spacing) {
            return Err(PortableError::invalid_data(
                "invalid-data：letterSpacingPx 必须在 0 到 8 之间",
            ));
        }
    }
    if let Some(word_spacing) = preferences.word_spacing_px {
        if !word_spacing.is_finite() || !(0.0..=16.0).contains(&word_spacing) {
            return Err(PortableError::invalid_data(
                "invalid-data：wordSpacingPx 必须在 0 到 16 之间",
            ));
        }
    }
    Ok(())
}

pub fn validate_portable_book(book: &PortableBook) -> PortableResult<()> {
    validate_book_metadata(&book.metadata.value)?;
    validate_stamp(&book.metadata.stamp)?;
    for version in &book.progress.versions {
        validate_progress_version(version)?;
    }
    for (id, annotation) in &book.bookmarks {
        if id.is_empty() {
            return Err(PortableError::invalid_data(
                "invalid-data：书签 ID 不能为空",
            ));
        }
        validate_annotation(annotation, validate_bookmark_version)?;
    }
    for (id, annotation) in &book.notes {
        if id.is_empty() {
            return Err(PortableError::invalid_data(
                "invalid-data：笔记 ID 不能为空",
            ));
        }
        validate_annotation(annotation, validate_note_version)?;
    }
    Ok(())
}

pub fn validate_portable_state(state: &PortableStateV3) -> PortableResult<()> {
    if state.schema_version != 3 {
        return Err(PortableError::invalid_data(
            "invalid-data：不支持的 portable schemaVersion",
        ));
    }
    for (book_hash, book) in &state.books {
        if !valid_content_hash(book_hash) {
            return Err(PortableError::invalid_data(
                "invalid-data：books 键必须是 64 位小写内容指纹",
            ));
        }
        validate_portable_book(book)?;
    }
    validate_organization(&state.organization)?;
    if let Some(preferences) = &state.preferences {
        validate_preferences(preferences)?;
    }
    Ok(())
}

pub fn parse_portable_state_json(raw: &str) -> PortableResult<PortableStateV3> {
    let state: PortableStateV3 = serde_json::from_str(raw)
        .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
    validate_portable_state(&state)?;
    Ok(state)
}

pub fn parse_portable_state_value(value: Value) -> PortableResult<PortableStateV3> {
    let state: PortableStateV3 = serde_json::from_value(value)
        .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
    validate_portable_state(&state)?;
    Ok(state)
}

fn organization_object<'a>(
    value: &'a Value,
    label: &str,
) -> PortableResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| PortableError::invalid_data(format!("invalid-data：{label} 必须是对象")))
}

fn validate_stamp_wire(value: &Value) -> PortableResult<()> {
    let object = organization_object(value, "stamp")?;
    reject_unknown_keys(object, &["counter", "deviceId"])
}

fn validate_register_wire(value: &Value, label: &str) -> PortableResult<()> {
    let object = organization_object(value, label)?;
    reject_unknown_keys(object, &["value", "stamp"])?;
    if let Some(stamp) = object.get("stamp") {
        validate_stamp_wire(stamp)?;
    }
    Ok(())
}

fn deserialize_organization_strict<'de, D>(deserializer: D) -> Result<LibraryOrganization, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    validate_organization_wire(&value).map_err(serde::de::Error::custom)?;
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

fn validate_organization_wire(value: &Value) -> PortableResult<()> {
    let object = organization_object(value, "organization")?;
    reject_unknown_keys(object, &["schemaVersion", "folders", "books"])?;
    if let Some(folders) = object.get("folders") {
        let folders = organization_object(folders, "organization.folders")?;
        for (folder_id, folder) in folders {
            let folder = organization_object(folder, &format!("folder {folder_id}"))?;
            reject_unknown_keys(folder, &["name", "deleted"])?;
            if let Some(name) = folder.get("name") {
                validate_register_wire(name, "folder.name")?;
            }
            if let Some(deleted) = folder.get("deleted") {
                if !deleted.is_null() {
                    validate_stamp_wire(deleted)?;
                }
            }
        }
    }
    if let Some(books) = object.get("books") {
        let books = organization_object(books, "organization.books")?;
        for (book_hash, book) in books {
            let book = organization_object(book, &format!("book {book_hash}"))?;
            reject_unknown_keys(book, &["favorite", "folderId"])?;
            if let Some(favorite) = book.get("favorite") {
                if !favorite.is_null() {
                    validate_register_wire(favorite, "favorite")?;
                }
            }
            if let Some(folder_id) = book.get("folderId") {
                if !folder_id.is_null() {
                    validate_register_wire(folder_id, "folderId")?;
                }
            }
        }
    }
    Ok(())
}

// ---- strict locator deserialization ----

fn expect_object<'a>(value: &'a Value, label: &str) -> PortableResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| PortableError::invalid_data(format!("invalid-data：{label} 必须是对象")))
}

fn reject_unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> PortableResult<()> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(PortableError::invalid_data(format!(
                "invalid-data：未知字段 {key}"
            )));
        }
    }
    Ok(())
}

fn required_string(object: &Map<String, Value>, key: &str) -> PortableResult<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            PortableError::invalid_data(format!("invalid-data：字段 {key} 必须是字符串"))
        })
}

fn required_safe_u64(object: &Map<String, Value>, key: &str) -> PortableResult<u64> {
    let value = object.get(key).and_then(Value::as_u64).ok_or_else(|| {
        PortableError::invalid_data(format!("invalid-data：字段 {key} 必须是非负整数"))
    })?;
    if value > MAX_SAFE_COUNTER {
        return Err(PortableError::invalid_data(format!(
            "invalid-data：字段 {key} 超出安全范围"
        )));
    }
    Ok(value)
}

fn optional_safe_u64_or_null(
    object: &Map<String, Value>,
    key: &str,
) -> PortableResult<Option<u64>> {
    match object.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => {
            let number = value.as_u64().ok_or_else(|| {
                PortableError::invalid_data(format!(
                    "invalid-data：字段 {key} 必须是非负整数或 null"
                ))
            })?;
            if number > MAX_SAFE_COUNTER {
                return Err(PortableError::invalid_data(format!(
                    "invalid-data：字段 {key} 超出安全范围"
                )));
            }
            Ok(Some(number))
        }
    }
}

fn optional_ratio_or_null(object: &Map<String, Value>, key: &str) -> PortableResult<Option<f64>> {
    match object.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => {
            let number = value.as_f64().ok_or_else(|| {
                PortableError::invalid_data(format!("invalid-data：字段 {key} 必须是数字或 null"))
            })?;
            if !valid_ratio(number) {
                return Err(PortableError::invalid_data(format!(
                    "invalid-data：字段 {key} 必须在 0 到 1 之间"
                )));
            }
            Ok(Some(number))
        }
    }
}

fn optional_snippet_or_null(
    object: &Map<String, Value>,
    key: &str,
) -> PortableResult<Option<String>> {
    match object.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => {
            let snippet = value.as_str().ok_or_else(|| {
                PortableError::invalid_data(format!("invalid-data：字段 {key} 必须是字符串或 null"))
            })?;
            if !valid_anchor_snippet(snippet) {
                return Err(PortableError::invalid_data(format!(
                    "invalid-data：字段 {key} 不是合法片段"
                )));
            }
            Ok(Some(snippet.to_string()))
        }
    }
}

fn locator_from_value(value: &Value) -> PortableResult<Locator> {
    let object = expect_object(value, "locator")?;
    let version = match object.get("locatorVersion") {
        Some(raw) => raw.as_u64().ok_or_else(|| {
            PortableError::invalid_data("invalid-data：locatorVersion 必须是整数")
        })?,
        None => {
            return Err(PortableError::invalid_data(
                "invalid-data：locator 缺少 locatorVersion",
            ))
        }
    };
    match version {
        1 => parse_modern_locator(object).map(Locator::Modern),
        0 => parse_legacy_locator(object).map(Locator::Legacy),
        _ => Err(PortableError::invalid_data(
            "invalid-data：未知 locatorVersion",
        )),
    }
}

fn parse_modern_locator(object: &Map<String, Value>) -> PortableResult<ModernLocator> {
    reject_unknown_keys(
        object,
        &["locatorVersion", "chapterPath", "spineIndexHint", "target"],
    )?;
    let chapter_path = required_string(object, "chapterPath")?;
    if !valid_chapter_path(&chapter_path) {
        return Err(PortableError::invalid_data(
            "invalid-data：chapterPath 不是 EPUB 内部相对路径",
        ));
    }
    let spine_index_hint = required_safe_u64(object, "spineIndexHint")?;
    let target = locator_target_from_value(
        object
            .get("target")
            .ok_or_else(|| PortableError::invalid_data("invalid-data：locator 缺少 target"))?,
    )?;
    Ok(ModernLocator {
        locator_version: 1,
        chapter_path,
        spine_index_hint,
        target,
    })
}

fn parse_legacy_locator(object: &Map<String, Value>) -> PortableResult<LegacyLocator> {
    reject_unknown_keys(
        object,
        &[
            "locatorVersion",
            "spineIndex",
            "pageHint",
            "anchorIndex",
            "anchorRatio",
            "anchorTextOffset",
            "anchorTextSnippet",
            "mediaAnchor",
        ],
    )?;
    let spine_index = required_safe_u64(object, "spineIndex")?;
    let page_hint = required_safe_u64(object, "pageHint")?;
    let anchor_index = match object.get("anchorIndex") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or_else(|| {
            PortableError::invalid_data("invalid-data：anchorIndex 必须是非负整数或 null")
        })?),
        None => {
            return Err(PortableError::invalid_data(
                "invalid-data：legacy locator 缺少 anchorIndex",
            ))
        }
    };
    let anchor_ratio = match object.get("anchorRatio") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_f64().ok_or_else(|| {
            PortableError::invalid_data("invalid-data：anchorRatio 必须是数字或 null")
        })?),
        None => {
            return Err(PortableError::invalid_data(
                "invalid-data：legacy locator 缺少 anchorRatio",
            ))
        }
    };
    let anchor_text_offset = match object.get("anchorTextOffset") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or_else(|| {
            PortableError::invalid_data("invalid-data：anchorTextOffset 必须是非负整数或 null")
        })?),
        None => None,
    };
    let anchor_text_snippet = match object.get("anchorTextSnippet") {
        Some(Value::Null) => None,
        Some(value) => {
            let snippet = value.as_str().ok_or_else(|| {
                PortableError::invalid_data("invalid-data：anchorTextSnippet 必须是字符串或 null")
            })?;
            Some(snippet.to_string())
        }
        None => None,
    };
    let media_anchor = match object.get("mediaAnchor") {
        Some(Value::Null) | None => None,
        Some(value) => Some(legacy_media_anchor_from_value(value)?),
    };
    let locator = LegacyLocator {
        locator_version: 0,
        spine_index,
        page_hint,
        anchor_index,
        anchor_ratio,
        anchor_text_offset,
        anchor_text_snippet,
        media_anchor,
    };
    if let Some(index) = locator.anchor_index {
        if index > MAX_SAFE_COUNTER {
            return Err(PortableError::invalid_data(
                "invalid-data：anchorIndex 超出安全范围",
            ));
        }
    }
    if let Some(offset) = locator.anchor_text_offset {
        if offset > MAX_SAFE_COUNTER {
            return Err(PortableError::invalid_data(
                "invalid-data：anchorTextOffset 超出安全范围",
            ));
        }
    }
    if let Some(ratio) = locator.anchor_ratio {
        if !valid_ratio(ratio) {
            return Err(PortableError::invalid_data(
                "invalid-data：anchorRatio 必须在 0 到 1 之间",
            ));
        }
    }
    if let Some(snippet) = &locator.anchor_text_snippet {
        if !valid_anchor_snippet(snippet) {
            return Err(PortableError::invalid_data(
                "invalid-data：anchorTextSnippet 不是合法片段",
            ));
        }
        if locator.anchor_text_offset.is_none() {
            return Err(PortableError::invalid_data(
                "invalid-data：anchorTextSnippet 缺少 anchorTextOffset",
            ));
        }
    }
    Ok(locator)
}

fn locator_target_from_value(value: &Value) -> PortableResult<LocatorTarget> {
    let object = expect_object(value, "locator.target")?;
    let kind = required_string(object, "kind")?;
    match kind.as_str() {
        "chapter-start" => {
            reject_unknown_keys(object, &["kind"])?;
            Ok(LocatorTarget::ChapterStart)
        }
        "text" => {
            reject_unknown_keys(object, &["kind", "textProfile", "offset", "snippet"])?;
            let text_profile = required_string(object, "textProfile")?;
            if text_profile != TEXT_PROFILE {
                return Err(PortableError::invalid_data(
                    "invalid-data：未知 textProfile",
                ));
            }
            let offset = required_safe_u64(object, "offset")?;
            let snippet = required_string(object, "snippet")?;
            if !valid_anchor_snippet(&snippet) {
                return Err(PortableError::invalid_data(
                    "invalid-data：snippet 必须是少于等于 32 个无空白码点",
                ));
            }
            Ok(LocatorTarget::Text {
                text_profile,
                offset,
                snippet,
            })
        }
        "media" => {
            reject_unknown_keys(object, &["kind", "signature", "indexHint", "tag", "ratio"])?;
            let signature = required_string(object, "signature")?;
            if signature.is_empty() {
                return Err(PortableError::invalid_data(
                    "invalid-data：媒体签名不能为空",
                ));
            }
            let index_hint = required_safe_u64(object, "indexHint")?;
            let tag = match required_string(object, "tag")?.as_str() {
                "img" => MediaTag::Img,
                "svg" => MediaTag::Svg,
                "video" => MediaTag::Video,
                _ => return Err(PortableError::invalid_data("invalid-data：未知媒体 tag")),
            };
            let ratio = object
                .get("ratio")
                .and_then(Value::as_f64)
                .ok_or_else(|| PortableError::invalid_data("invalid-data：ratio 必须是数字"))?;
            if !valid_ratio(ratio) {
                return Err(PortableError::invalid_data(
                    "invalid-data：ratio 必须在 0 到 1 之间",
                ));
            }
            Ok(LocatorTarget::Media {
                signature,
                index_hint,
                tag,
                ratio,
            })
        }
        _ => Err(PortableError::invalid_data(
            "invalid-data：未知 target kind",
        )),
    }
}

fn legacy_media_anchor_from_value(value: &Value) -> PortableResult<LegacyMediaAnchor> {
    let object = expect_object(value, "mediaAnchor")?;
    reject_unknown_keys(object, &["index", "tag", "signature", "ratio"])?;
    let index = required_safe_u64(object, "index")?;
    let tag = required_string(object, "tag")?;
    let signature = required_string(object, "signature")?;
    let ratio = object
        .get("ratio")
        .and_then(Value::as_f64)
        .ok_or_else(|| PortableError::invalid_data("invalid-data：ratio 必须是数字"))?;
    if tag.is_empty() || signature.is_empty() || !valid_ratio(ratio) {
        return Err(PortableError::invalid_data(
            "invalid-data：legacy 媒体锚点不合法",
        ));
    }
    Ok(LegacyMediaAnchor {
        index,
        tag,
        signature,
        ratio,
    })
}

#[cfg(test)]
mod archive_identity_tests {
    use super::*;

    #[test]
    fn obfuscated_zip_keys_roundtrip_locators_and_notes() {
        for key in [
            "OEBPS/Text/a?b#c%20.xhtml",
            "Text/*?:|.xhtml",
            "Text/%2e%2e.xhtml",
            "Text/%00.xhtml",
        ] {
            assert!(valid_chapter_path(key));
            let json = serde_json::json!({
                "locatorVersion": 1, "chapterPath": key, "spineIndexHint": 0,
                "target": { "kind": "chapter-start" }
            });
            let locator: Locator = serde_json::from_value(json.clone()).unwrap();
            validate_locator(&locator).unwrap();
            assert_eq!(serde_json::to_value(locator).unwrap(), json);
            let json = serde_json::json!({
                "chapterPath": key, "spineIndexHint": 0, "textProfile": TEXT_PROFILE,
                "startTextOffset": 0, "endTextOffset": 2,
                "startTextSnippet": "正文", "endTextSnippet": "正文", "selectedText": "正文",
                "content": "note", "createdAtMs": 1
            });
            let note: NoteValue = serde_json::from_value(json.clone()).unwrap();
            validate_note(&note).unwrap();
            assert_eq!(serde_json::to_value(note).unwrap(), json);
        }
        for key in ["", "/a", "C:/a", "a\\b", "a/../b", "a//b", "a/./b", "a/\0b"] {
            assert!(!valid_chapter_path(key));
        }
    }
}
