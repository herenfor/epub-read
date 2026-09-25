//! Portable favorites / single-level folder organization.
//!
//! This module is pure data plus merge, clock and command reduction: it has no
//! Tauri or filesystem dependency so the same rules can be reused by another
//! front end later.  `linked_library` owns the `library-organization.json`
//! envelope file and the write mutex; it only calls in here with inputs that
//! already came from the IPC boundary or from that file.
//!
//! A book's identity is the full EPUB content SHA-256 and each book has at most
//! one `folderId` register.  Favorites are an independent register.  Folder
//! deletion is a permanent tombstone: the raw book references are kept and the
//! view projection hides them instead of rewriting them to `null`.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

/// JS `Number.MAX_SAFE_INTEGER`; the logical clock must stay in this range.
pub const MAX_SAFE_COUNTER: u64 = 9_007_199_254_740_991;
pub const MAX_FOLDER_NAME_CODE_POINTS: usize = 40;
pub const ORGANIZATION_SCHEMA_VERSION: u8 = 1;

const STAMP_COLLISION: &str = "收藏与文件夹数据冲突：同一字段的同一事件出现不同取值";
const CLOCK_EXHAUSTED: &str = "本机逻辑时钟已达上限，无法继续保存收藏与文件夹";

/// 字段必须出现：缺字段直接报错；字段存在时按自身类型解码，所以 `Option<T>`
/// 仍能表示“明确为空”。
fn deserialize_required<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer)
}

/// 字段可以缺省（得到 `None`），但只要出现就必须解码成对应对象；显式 `null`
/// 不算缺省，否则损坏文件会被悄悄当成“没有这个字段”。
fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub counter: u64,
    /// Lowercase canonical UUID of the device that produced this event.
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    bound(deserialize = "T: serde::Deserialize<'de>")
)]
pub struct Register<T> {
    /// 必须出现；`T = Option<String>` 时 `null` 表示“明确移出到未归类”。
    #[serde(deserialize_with = "deserialize_required")]
    pub value: T,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    pub name: Register<String>,
    /// Permanent deletion marker; the same UUID can never be revived.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub deleted: Option<Stamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookOrganization {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub favorite: Option<Register<bool>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub folder_id: Option<Register<Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOrganization {
    pub schema_version: u8,
    pub folders: BTreeMap<String, FolderState>,
    pub books: BTreeMap<String, BookOrganization>,
}

/// Device-local envelope.  Only `state` is portable; the clock identity never
/// travels to another device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationEnvelope {
    pub device_id: String,
    pub counter: u64,
    pub state: LibraryOrganization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrganizationCommand {
    CreateFolder {
        folder_id: String,
        name: String,
    },
    RenameFolder {
        folder_id: String,
        name: String,
    },
    DeleteFolder {
        folder_id: String,
    },
    SetFavorite {
        content_hashes: Vec<String>,
        value: bool,
    },
    MoveBooks {
        content_hashes: Vec<String>,
        /// 必须出现：`null` 表示移出到未归类，缺字段不是同一次事件。
        #[serde(deserialize_with = "deserialize_required")]
        folder_id: Option<String>,
    },
}

pub fn empty_organization() -> LibraryOrganization {
    LibraryOrganization {
        schema_version: ORGANIZATION_SCHEMA_VERSION,
        folders: BTreeMap::new(),
        books: BTreeMap::new(),
    }
}

/// ECMAScript `String.prototype.trim` whitespace.  Rust `char::is_whitespace`
/// additionally trims U+0085 and does not trim U+FEFF, so the set is explicit.
fn is_js_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_trim_whitespace)
}

/// Number of Unicode scalar values, matching TS `[...value].length` /
/// `Array.from(value).length` rather than UTF-16 `string.length`.  The front end
/// must not use `value.length` for the 1–40 limit.
pub fn code_point_count(value: &str) -> usize {
    value.chars().count()
}

/// `8-4-4-4-12` lowercase hexadecimal.  Identity is never derived from a name.
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

fn valid_stamp(stamp: &Stamp) -> bool {
    stamp.counter >= 1
        && stamp.counter <= MAX_SAFE_COUNTER
        && valid_canonical_uuid(&stamp.device_id)
}

/// Stored and incoming names must already be trimmed: a value that carries a
/// stamp is never silently rewritten, otherwise two devices would persist
/// different content for one event.
fn valid_folder_name(name: &str) -> bool {
    js_trim(name) == name && (1..=MAX_FOLDER_NAME_CODE_POINTS).contains(&code_point_count(name))
}

/// Local creation/rename trims first and then stamps the trimmed value.
pub fn normalize_folder_name(raw: &str) -> Result<String, String> {
    let trimmed = js_trim(raw);
    let count = code_point_count(trimmed);
    if count == 0 || count > MAX_FOLDER_NAME_CODE_POINTS {
        return Err(format!(
            "文件夹名称需为 1-{MAX_FOLDER_NAME_CODE_POINTS} 个字符"
        ));
    }
    Ok(trimmed.to_string())
}

/// `(counter, deviceId ASCII)` maximum; the clock orders events only.
pub fn compare_stamp(a: &Stamp, b: &Stamp) -> Ordering {
    a.counter
        .cmp(&b.counter)
        .then_with(|| a.device_id.as_bytes().cmp(b.device_id.as_bytes()))
}

fn merge_register<T: Clone + PartialEq>(
    a: Option<&Register<T>>,
    b: Option<&Register<T>>,
) -> Result<Option<Register<T>>, String> {
    let (left, right) = match (a, b) {
        (None, None) => return Ok(None),
        (Some(left), None) => return Ok(Some(left.clone())),
        (None, Some(right)) => return Ok(Some(right.clone())),
        (Some(left), Some(right)) => (left, right),
    };
    match compare_stamp(&left.stamp, &right.stamp) {
        // Same event, different value is corrupt data; never pick by import order.
        Ordering::Equal if left.value != right.value => Err(STAMP_COLLISION.to_string()),
        Ordering::Equal | Ordering::Greater => Ok(Some(left.clone())),
        Ordering::Less => Ok(Some(right.clone())),
    }
}

fn merge_deletion(a: Option<&Stamp>, b: Option<&Stamp>) -> Option<Stamp> {
    match (a, b) {
        (None, None) => None,
        (Some(stamp), None) | (None, Some(stamp)) => Some(stamp.clone()),
        (Some(left), Some(right)) => Some(if compare_stamp(left, right) == Ordering::Less {
            right.clone()
        } else {
            left.clone()
        }),
    }
}

fn merge_folder(a: &FolderState, b: &FolderState) -> Result<FolderState, String> {
    Ok(FolderState {
        name: merge_register(Some(&a.name), Some(&b.name))?.expect("folder names are required"),
        deleted: merge_deletion(a.deleted.as_ref(), b.deleted.as_ref()),
    })
}

fn merge_book(a: &BookOrganization, b: &BookOrganization) -> Result<BookOrganization, String> {
    Ok(BookOrganization {
        favorite: merge_register(a.favorite.as_ref(), b.favorite.as_ref())?,
        folder_id: merge_register(a.folder_id.as_ref(), b.folder_id.as_ref())?,
    })
}

fn merge_map<T, F>(
    a: &BTreeMap<String, T>,
    b: &BTreeMap<String, T>,
    merge: F,
) -> Result<BTreeMap<String, T>, String>
where
    T: Clone,
    F: Fn(&T, &T) -> Result<T, String>,
{
    // BTreeMap keeps keys sorted, matching the TS reference and stable fixtures.
    let mut merged = a.clone();
    for (key, right) in b {
        match merged.remove(key) {
            Some(left) => {
                merged.insert(key.clone(), merge(&left, right)?);
            }
            None => {
                merged.insert(key.clone(), right.clone());
            }
        }
    }
    Ok(merged)
}

/// Commutative, associative and idempotent over valid event sets; inputs are
/// never mutated.
pub fn merge_organization(
    a: &LibraryOrganization,
    b: &LibraryOrganization,
) -> Result<LibraryOrganization, String> {
    Ok(LibraryOrganization {
        schema_version: ORGANIZATION_SCHEMA_VERSION,
        folders: merge_map(&a.folders, &b.folders, merge_folder)?,
        books: merge_map(&a.books, &b.books, merge_book)?,
    })
}

pub fn max_observed_counter(state: &LibraryOrganization) -> u64 {
    let mut maximum = 0;
    let mut observe = |stamp: Option<&Stamp>| {
        if let Some(stamp) = stamp {
            maximum = maximum.max(stamp.counter);
        }
    };
    for folder in state.folders.values() {
        observe(Some(&folder.name.stamp));
        observe(folder.deleted.as_ref());
    }
    for book in state.books.values() {
        observe(book.favorite.as_ref().map(|register| &register.stamp));
        observe(book.folder_id.as_ref().map(|register| &register.stamp));
    }
    maximum
}

/// Must run while holding the library write lock, against the latest envelope.
pub fn next_stamp(envelope: &OrganizationEnvelope) -> Result<Stamp, String> {
    let counter = envelope
        .counter
        .max(max_observed_counter(&envelope.state))
        .checked_add(1)
        .filter(|counter| *counter <= MAX_SAFE_COUNTER)
        .ok_or_else(|| CLOCK_EXHAUSTED.to_string())?;
    Ok(Stamp {
        counter,
        device_id: envelope.device_id.clone(),
    })
}

/// Import makes no new event and never takes over the remote `deviceId`.
pub fn merge_into_envelope(
    local: &OrganizationEnvelope,
    incoming: &LibraryOrganization,
) -> Result<OrganizationEnvelope, String> {
    let state = merge_organization(&local.state, incoming)?;
    Ok(OrganizationEnvelope {
        device_id: local.device_id.clone(),
        counter: local.counter.max(max_observed_counter(&state)),
        state,
    })
}

/// View projection only: unknown or deleted folders appear as unclassified,
/// while the raw reference is preserved.
///
/// The Rust commands never rewrite book references from this projection; it
/// exists to keep the projection rule identical to the TS core and is covered
/// by the shared fixtures.
#[cfg_attr(not(test), allow(dead_code))]
pub fn effective_folder_id<'a>(
    state: &'a LibraryOrganization,
    content_hash: &str,
) -> Option<&'a str> {
    let folder_id = state
        .books
        .get(content_hash)?
        .folder_id
        .as_ref()?
        .value
        .as_deref()?;
    match state.folders.get(folder_id) {
        Some(folder) if folder.deleted.is_none() => Some(folder_id),
        _ => None,
    }
}

/// Same projection rule as `effective_folder_id`: a missing register means not
/// favorited, and the stored value is never rewritten here.
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_favorite(state: &LibraryOrganization, content_hash: &str) -> bool {
    state
        .books
        .get(content_hash)
        .and_then(|book| book.favorite.as_ref())
        .map(|register| register.value)
        .unwrap_or(false)
}

/// Boundary validation for data read from the organization file or received as
/// an archive merge input.
pub fn validate_organization(state: &LibraryOrganization) -> Result<(), String> {
    if state.schema_version != ORGANIZATION_SCHEMA_VERSION {
        return Err(format!(
            "收藏与文件夹数据版本不受支持：{}",
            state.schema_version
        ));
    }
    for (folder_id, folder) in &state.folders {
        if !valid_canonical_uuid(folder_id) {
            return Err("收藏与文件夹数据含有无效的文件夹 ID".into());
        }
        if !valid_folder_name(&folder.name.value) {
            return Err("收藏与文件夹数据含有无效的文件夹名称".into());
        }
        if !valid_stamp(&folder.name.stamp) {
            return Err("收藏与文件夹数据含有无效的逻辑时钟".into());
        }
        if let Some(deleted) = &folder.deleted {
            if !valid_stamp(deleted) {
                return Err("收藏与文件夹数据含有无效的删除标记".into());
            }
        }
    }
    for (content_hash, book) in &state.books {
        if !crate::linked_library::valid_content_hash(content_hash) {
            return Err("收藏与文件夹数据含有无效的书籍内容指纹".into());
        }
        if let Some(register) = &book.favorite {
            if !valid_stamp(&register.stamp) {
                return Err("收藏与文件夹数据含有无效的逻辑时钟".into());
            }
        }
        if let Some(register) = &book.folder_id {
            if !valid_stamp(&register.stamp) {
                return Err("收藏与文件夹数据含有无效的逻辑时钟".into());
            }
            if let Some(target) = &register.value {
                if !valid_canonical_uuid(target) {
                    return Err("收藏与文件夹数据含有无效的文件夹 ID".into());
                }
            }
        }
    }
    Ok(())
}

pub fn validate_envelope(envelope: &OrganizationEnvelope) -> Result<(), String> {
    if !valid_canonical_uuid(&envelope.device_id) {
        return Err("收藏与文件夹数据含有无效的本机设备 ID".into());
    }
    if envelope.counter > MAX_SAFE_COUNTER {
        return Err("收藏与文件夹数据的逻辑时钟超出范围".into());
    }
    validate_organization(&envelope.state)
}

enum Mutation {
    PutFolder {
        folder_id: String,
        name: String,
    },
    MarkFolderDeleted {
        folder_id: String,
    },
    SetFavorite {
        content_hash: String,
        value: bool,
    },
    SetFolder {
        content_hash: String,
        folder_id: Option<String>,
    },
}

fn dedupe_hashes(content_hashes: &[String]) -> Result<Option<Vec<String>>, String> {
    let mut unique = Vec::with_capacity(content_hashes.len());
    let mut seen = HashSet::with_capacity(content_hashes.len());
    for hash in content_hashes {
        if !crate::linked_library::valid_content_hash(hash) {
            return Err("无效的书籍内容指纹".into());
        }
        if seen.insert(hash.clone()) {
            unique.push(hash.clone());
        }
    }
    Ok((!unique.is_empty()).then_some(unique))
}

fn require_known_books(
    content_hashes: &[String],
    known_content_hashes: &HashSet<String>,
) -> Result<Vec<String>, String> {
    let Some(unique) = dedupe_hashes(content_hashes)? else {
        return Ok(Vec::new());
    };
    if unique
        .iter()
        .any(|hash| !known_content_hashes.contains(hash))
    {
        return Err("书库中没有所选书籍，请刷新后重试".into());
    }
    Ok(unique)
}

fn plan_folder_target(state: &LibraryOrganization, folder_id: &str) -> Result<(), String> {
    if !valid_canonical_uuid(folder_id) {
        return Err("无效的文件夹 ID".into());
    }
    match state.folders.get(folder_id) {
        Some(folder) if folder.deleted.is_none() => Ok(()),
        Some(_) => Err("文件夹已解散，无法移入".into()),
        None => Err("文件夹不存在".into()),
    }
}

fn plan_command(
    state: &LibraryOrganization,
    command: &OrganizationCommand,
    known_content_hashes: &HashSet<String>,
) -> Result<Vec<Mutation>, String> {
    let mut mutations = Vec::new();
    match command {
        OrganizationCommand::CreateFolder { folder_id, name } => {
            if !valid_canonical_uuid(folder_id) {
                return Err("无效的文件夹 ID".into());
            }
            // A tombstoned UUID counts as used; creating again would revive it.
            if state.folders.contains_key(folder_id) {
                return Err("该文件夹 ID 已被使用".into());
            }
            mutations.push(Mutation::PutFolder {
                folder_id: folder_id.clone(),
                name: normalize_folder_name(name)?,
            });
        }
        OrganizationCommand::RenameFolder { folder_id, name } => {
            if !valid_canonical_uuid(folder_id) {
                return Err("无效的文件夹 ID".into());
            }
            match state.folders.get(folder_id) {
                Some(folder) if folder.deleted.is_none() => {}
                Some(_) => return Err("文件夹已解散".into()),
                None => return Err("文件夹不存在".into()),
            }
            mutations.push(Mutation::PutFolder {
                folder_id: folder_id.clone(),
                name: normalize_folder_name(name)?,
            });
        }
        OrganizationCommand::DeleteFolder { folder_id } => {
            if !valid_canonical_uuid(folder_id) {
                return Err("无效的文件夹 ID".into());
            }
            match state.folders.get(folder_id) {
                Some(folder) if folder.deleted.is_some() => {
                    // Already deleted: no-op, no new event, book references stay.
                }
                Some(_) => mutations.push(Mutation::MarkFolderDeleted {
                    folder_id: folder_id.clone(),
                }),
                None => return Err("文件夹不存在".into()),
            }
        }
        OrganizationCommand::SetFavorite {
            content_hashes,
            value,
        } => {
            for content_hash in require_known_books(content_hashes, known_content_hashes)? {
                mutations.push(Mutation::SetFavorite {
                    content_hash,
                    value: *value,
                });
            }
        }
        OrganizationCommand::MoveBooks {
            content_hashes,
            folder_id,
        } => {
            let content_hashes = require_known_books(content_hashes, known_content_hashes)?;
            // An empty batch is a no-op: it neither writes nor needs a target.
            if !content_hashes.is_empty() {
                if let Some(target) = folder_id {
                    plan_folder_target(state, target)?;
                }
                for content_hash in content_hashes {
                    mutations.push(Mutation::SetFolder {
                        content_hash,
                        folder_id: folder_id.clone(),
                    });
                }
            }
        }
    }
    Ok(mutations)
}

/// Reduces one local command against the latest envelope.  Every write in a
/// batch shares one stamp, and a rejected batch returns the input unchanged.
/// The returned envelope is identical to `envelope` when nothing was written.
pub fn apply_command(
    envelope: &OrganizationEnvelope,
    command: &OrganizationCommand,
    known_content_hashes: &HashSet<String>,
) -> Result<OrganizationEnvelope, String> {
    let mutations = plan_command(&envelope.state, command, known_content_hashes)?;
    if mutations.is_empty() {
        return Ok(envelope.clone());
    }
    let stamp = next_stamp(envelope)?;
    let mut state = envelope.state.clone();
    for mutation in mutations {
        match mutation {
            Mutation::PutFolder { folder_id, name } => {
                let deleted = state
                    .folders
                    .get(&folder_id)
                    .and_then(|folder| folder.deleted.clone());
                state.folders.insert(
                    folder_id,
                    FolderState {
                        name: Register {
                            value: name,
                            stamp: stamp.clone(),
                        },
                        deleted,
                    },
                );
            }
            Mutation::MarkFolderDeleted { folder_id } => {
                if let Some(folder) = state.folders.get_mut(&folder_id) {
                    folder.deleted = Some(stamp.clone());
                }
            }
            Mutation::SetFavorite {
                content_hash,
                value,
            } => {
                state
                    .books
                    .entry(content_hash)
                    .or_insert_with(empty_book)
                    .favorite = Some(Register {
                    value,
                    stamp: stamp.clone(),
                });
            }
            Mutation::SetFolder {
                content_hash,
                folder_id,
            } => {
                state
                    .books
                    .entry(content_hash)
                    .or_insert_with(empty_book)
                    .folder_id = Some(Register {
                    // `null` is an explicit register, never a removed field.
                    value: folder_id,
                    stamp: stamp.clone(),
                });
            }
        }
    }
    Ok(OrganizationEnvelope {
        device_id: envelope.device_id.clone(),
        counter: stamp.counter,
        state,
    })
}

fn empty_book() -> BookOrganization {
    BookOrganization {
        favorite: None,
        folder_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE_A: &str = "0a0a0a0a-0000-4000-8000-00000000000a";
    const DEVICE_B: &str = "0b0b0b0b-0000-4000-8000-00000000000b";
    const DEVICE_C: &str = "0c0c0c0c-0000-4000-8000-00000000000c";
    const FOLDER_F: &str = "00000000-0000-4000-8000-0000000000f0";
    const FOLDER_G: &str = "00000000-0000-4000-8000-0000000000f1";
    const FOLDER_X: &str = "00000000-0000-4000-8000-0000000000f2";
    const HASH_H1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_H2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn stamp(counter: u64, device_id: &str) -> Stamp {
        Stamp {
            counter,
            device_id: device_id.into(),
        }
    }

    fn reg<T>(value: T, counter: u64, device_id: &str) -> Register<T> {
        Register {
            value,
            stamp: stamp(counter, device_id),
        }
    }

    fn envelope(device_id: &str, counter: u64, state: LibraryOrganization) -> OrganizationEnvelope {
        OrganizationEnvelope {
            device_id: device_id.into(),
            counter,
            state,
        }
    }

    fn folder(name: &str, counter: u64, device_id: &str) -> FolderState {
        FolderState {
            name: reg(name.to_string(), counter, device_id),
            deleted: None,
        }
    }

    fn state(
        folders: Vec<(&str, FolderState)>,
        books: Vec<(&str, BookOrganization)>,
    ) -> LibraryOrganization {
        LibraryOrganization {
            schema_version: ORGANIZATION_SCHEMA_VERSION,
            folders: folders
                .into_iter()
                .map(|(id, value)| (id.to_string(), value))
                .collect(),
            books: books
                .into_iter()
                .map(|(hash, value)| (hash.to_string(), value))
                .collect(),
        }
    }

    fn book_favorite(value: bool, counter: u64, device_id: &str) -> BookOrganization {
        BookOrganization {
            favorite: Some(reg(value, counter, device_id)),
            folder_id: None,
        }
    }

    fn book_folder(target: Option<&str>, counter: u64, device_id: &str) -> BookOrganization {
        BookOrganization {
            favorite: None,
            folder_id: Some(reg(target.map(str::to_string), counter, device_id)),
        }
    }

    fn known(hashes: &[&str]) -> HashSet<String> {
        hashes.iter().map(|hash| hash.to_string()).collect()
    }

    #[test]
    fn command_json_requires_an_explicit_folder_id_field() {
        let with_target = format!(
            r#"{{"type":"moveBooks","contentHashes":["{HASH_H1}"],"folderId":"{FOLDER_F}"}}"#
        );
        assert_eq!(
            serde_json::from_str::<OrganizationCommand>(&with_target).unwrap(),
            OrganizationCommand::MoveBooks {
                content_hashes: vec![HASH_H1.into()],
                folder_id: Some(FOLDER_F.into()),
            }
        );
        let explicit_null =
            format!(r#"{{"type":"moveBooks","contentHashes":["{HASH_H1}"],"folderId":null}}"#);
        assert_eq!(
            serde_json::from_str::<OrganizationCommand>(&explicit_null).unwrap(),
            OrganizationCommand::MoveBooks {
                content_hashes: vec![HASH_H1.into()],
                folder_id: None,
            }
        );
        // A missing field is not the same event as an explicit move to the root.
        let missing = format!(r#"{{"type":"moveBooks","contentHashes":["{HASH_H1}"]}}"#);
        assert!(serde_json::from_str::<OrganizationCommand>(&missing).is_err());
    }

    #[test]
    fn register_json_requires_a_value_but_keeps_an_explicit_null() {
        let explicit_null =
            format!(r#"{{"value":null,"stamp":{{"counter":4,"deviceId":"{DEVICE_A}"}}}}"#);
        let register: Register<Option<String>> = serde_json::from_str(&explicit_null).unwrap();
        assert_eq!(register.value, None);
        assert_eq!(register.stamp, stamp(4, DEVICE_A));
        // A stamped register without a value must never act as an event.
        let missing = format!(r#"{{"stamp":{{"counter":4,"deviceId":"{DEVICE_A}"}}}}"#);
        assert!(serde_json::from_str::<Register<Option<String>>>(&missing).is_err());
        assert!(serde_json::from_str::<Register<bool>>(&missing).is_err());
    }

    #[test]
    fn optional_objects_reject_json_null_and_still_allow_omission() {
        let name = format!(r#"{{"value":"科幻","stamp":{{"counter":1,"deviceId":"{DEVICE_A}"}}}}"#);
        // Outer null would silently drop a deletion marker, favorite or folder.
        assert!(serde_json::from_str::<FolderState>(&format!(
            r#"{{"name":{name},"deleted":null}}"#
        ))
        .is_err());
        let folder: FolderState = serde_json::from_str(&format!(r#"{{"name":{name}}}"#)).unwrap();
        assert_eq!(folder.deleted, None);
        assert!(serde_json::from_str::<BookOrganization>(r#"{"favorite":null}"#).is_err());
        assert!(serde_json::from_str::<BookOrganization>(r#"{"folderId":null}"#).is_err());
        let empty: BookOrganization = serde_json::from_str("{}").unwrap();
        assert_eq!(
            empty,
            BookOrganization {
                favorite: None,
                folder_id: None,
            }
        );
        // The inner register value may still be an explicit null (move to root).
        let root = format!(
            r#"{{"folderId":{{"value":null,"stamp":{{"counter":7,"deviceId":"{DEVICE_A}"}}}}}}"#
        );
        let book: BookOrganization = serde_json::from_str(&root).unwrap();
        assert_eq!(book.folder_id.unwrap().value, None);
        // ... and `false` is a real value, not an omitted field.
        let unfavorite = format!(
            r#"{{"favorite":{{"value":false,"stamp":{{"counter":2,"deviceId":"{DEVICE_A}"}}}}}}"#
        );
        let book: BookOrganization = serde_json::from_str(&unfavorite).unwrap();
        assert_eq!(book.favorite.unwrap().value, false);
    }

    #[test]
    fn merge_keeps_favorite_and_folder_as_independent_fields() {
        let favorite = state(vec![], vec![(HASH_H1, book_favorite(true, 2, DEVICE_A))]);
        let moved = state(
            vec![(FOLDER_F, folder("F", 1, DEVICE_B))],
            vec![(HASH_H1, book_folder(Some(FOLDER_F), 2, DEVICE_B))],
        );
        let forward = merge_organization(&favorite, &moved).unwrap();
        let backward = merge_organization(&moved, &favorite).unwrap();
        assert_eq!(forward, backward);
        assert!(is_favorite(&forward, HASH_H1));
        assert_eq!(effective_folder_id(&forward, HASH_H1), Some(FOLDER_F));
    }

    #[test]
    fn simultaneous_favorite_events_resolve_by_device_and_old_import_cannot_return() {
        let older = state(vec![], vec![(HASH_H1, book_favorite(false, 5, DEVICE_B))]);
        let newer = state(vec![], vec![(HASH_H1, book_favorite(true, 5, DEVICE_A))]);
        let merged = merge_organization(&newer, &older).unwrap();
        assert!(!is_favorite(&merged, HASH_H1));
        // A stale snapshot from another device must not restore the old value.
        let stale = state(vec![], vec![(HASH_H1, book_favorite(true, 4, DEVICE_B))]);
        let merged_again = merge_organization(&merged, &stale).unwrap();
        assert!(!is_favorite(&merged_again, HASH_H1));
    }

    #[test]
    fn deleted_folder_is_hidden_but_keeps_raw_reference_and_later_moves_work() {
        let renamed = state(vec![(FOLDER_F, folder("新名", 8, DEVICE_A))], vec![]);
        let mut tombstoned = folder("旧名", 2, DEVICE_B);
        tombstoned.deleted = Some(stamp(3, DEVICE_B));
        let deleted = state(vec![(FOLDER_F, tombstoned)], vec![]);
        let moved = state(
            vec![],
            vec![(HASH_H1, book_folder(Some(FOLDER_F), 10, DEVICE_A))],
        );
        let merged =
            merge_organization(&merge_organization(&renamed, &deleted).unwrap(), &moved).unwrap();
        let stored = &merged.folders[FOLDER_F];
        assert_eq!(stored.name.value, "新名");
        assert_eq!(stored.deleted, Some(stamp(3, DEVICE_B)));
        // Projection hides it, but the raw reference stays for the merge.
        assert_eq!(effective_folder_id(&merged, HASH_H1), None);
        assert_eq!(
            merged.books[HASH_H1].folder_id.as_ref().unwrap().value,
            Some(FOLDER_F.to_string())
        );
        // Moving to a live folder afterwards still succeeds.
        let with_target = state(vec![(FOLDER_G, folder("G", 1, DEVICE_A))], vec![]);
        let merged = merge_organization(&merged, &with_target).unwrap();
        let moved = apply_command(
            &envelope(DEVICE_A, 10, merged),
            &OrganizationCommand::MoveBooks {
                content_hashes: vec![HASH_H1.into()],
                folder_id: Some(FOLDER_G.into()),
            },
            &known(&[HASH_H1]),
        )
        .unwrap();
        assert_eq!(
            moved.state.books[HASH_H1].folder_id.as_ref().unwrap().stamp,
            stamp(11, DEVICE_A)
        );
        assert_eq!(effective_folder_id(&moved.state, HASH_H1), Some(FOLDER_G));
    }

    #[test]
    fn unknown_folder_reference_projects_to_root_and_converges_either_order() {
        let moved_first = state(
            vec![],
            vec![(HASH_H1, book_folder(Some(FOLDER_F), 3, DEVICE_A))],
        );
        assert_eq!(effective_folder_id(&moved_first, HASH_H1), None);
        let folder_later = state(vec![(FOLDER_F, folder("F", 5, DEVICE_A))], vec![]);
        let forward = merge_organization(&moved_first, &folder_later).unwrap();
        let backward = merge_organization(&folder_later, &moved_first).unwrap();
        assert_eq!(forward, backward);
        assert_eq!(effective_folder_id(&forward, HASH_H1), Some(FOLDER_F));
    }

    #[test]
    fn import_advances_local_counter_without_taking_over_device_id() {
        let local = envelope(
            DEVICE_A,
            3,
            state(vec![], vec![(HASH_H1, book_favorite(false, 2, DEVICE_A))]),
        );
        let incoming = state(vec![], vec![(HASH_H1, book_favorite(true, 9, DEVICE_B))]);
        let merged = merge_into_envelope(&local, &incoming).unwrap();
        assert_eq!(merged.device_id, DEVICE_A);
        assert_eq!(merged.counter, 9);
        assert!(is_favorite(&merged.state, HASH_H1));
        // Import itself makes no event.
        assert_eq!(merge_into_envelope(&merged, &incoming).unwrap(), merged);
        let next = apply_command(
            &merged,
            &OrganizationCommand::SetFavorite {
                content_hashes: vec![HASH_H1.into()],
                value: false,
            },
            &known(&[HASH_H1]),
        )
        .unwrap();
        let register = next.state.books[HASH_H1].favorite.as_ref().unwrap();
        assert_eq!(register.value, false);
        assert_eq!(register.stamp, stamp(10, DEVICE_A));
    }

    #[test]
    fn same_stamp_different_value_is_a_collision_while_shared_stamps_across_fields_are_legal() {
        let favorite_true = state(vec![], vec![(HASH_H1, book_favorite(true, 5, DEVICE_A))]);
        let favorite_false = state(vec![], vec![(HASH_H1, book_favorite(false, 5, DEVICE_A))]);
        assert!(merge_organization(&favorite_true, &favorite_false).is_err());
        assert!(merge_organization(&favorite_false, &favorite_true).is_err());
        // Sharing one stamp across favorite and folderId is not a conflict, and a
        // different value on a different field must not be treated as one either.
        let folder_f = state(
            vec![],
            vec![(HASH_H1, book_folder(Some(FOLDER_F), 5, DEVICE_A))],
        );
        let folder_null = state(vec![], vec![(HASH_H1, book_folder(None, 5, DEVICE_A))]);
        let shared = merge_organization(&favorite_true, &folder_f).unwrap();
        assert_eq!(
            shared.books[HASH_H1].favorite.as_ref().unwrap().stamp,
            shared.books[HASH_H1].folder_id.as_ref().unwrap().stamp
        );
        assert!(merge_organization(&favorite_false, &folder_null).is_ok());
    }

    #[test]
    fn three_snapshots_merge_commutatively_associatively_and_idempotently() {
        let a = state(
            vec![(FOLDER_F, folder("F", 1, DEVICE_A))],
            vec![(HASH_H1, book_favorite(true, 2, DEVICE_A))],
        );
        let b = state(
            vec![(FOLDER_F, folder("F-重命名", 5, DEVICE_B))],
            vec![
                (HASH_H1, book_folder(Some(FOLDER_F), 3, DEVICE_B)),
                (HASH_H2, book_favorite(true, 4, DEVICE_B)),
            ],
        );
        let c = state(
            vec![(FOLDER_G, folder("G", 2, DEVICE_C))],
            vec![
                (HASH_H1, book_favorite(false, 1, DEVICE_C)),
                (HASH_H2, book_folder(Some(FOLDER_G), 6, DEVICE_C)),
            ],
        );
        let ab = merge_organization(&a, &b).unwrap();
        let forward = merge_organization(&ab, &c).unwrap();
        let middle = merge_organization(&merge_organization(&a, &c).unwrap(), &b).unwrap();
        let backward = merge_organization(&a, &merge_organization(&b, &c).unwrap()).unwrap();
        assert_eq!(forward, middle);
        assert_eq!(middle, backward);
        assert_eq!(
            merge_organization(&a, &b).unwrap(),
            merge_organization(&b, &a).unwrap()
        );
        assert_eq!(merge_organization(&a, &a).unwrap(), a);
        // Repeated imports neither add folders nor duplicate events.
        let again = merge_organization(&forward, &forward).unwrap();
        assert_eq!(again, forward);
        assert_eq!(again.folders.len(), 2);
        assert_eq!(again.books.len(), 2);
    }

    #[test]
    fn batch_commands_share_one_stamp_and_keep_explicit_false_and_null() {
        let state = state(vec![(FOLDER_F, folder("F", 1, DEVICE_A))], vec![]);
        let start = envelope(DEVICE_A, 1, state);
        let favorited = apply_command(
            &start,
            &OrganizationCommand::SetFavorite {
                content_hashes: vec![HASH_H1.into(), HASH_H2.into(), HASH_H1.into()],
                value: true,
            },
            &known(&[HASH_H1, HASH_H2]),
        )
        .unwrap();
        assert_eq!(favorited.counter, 2);
        for hash in [HASH_H1, HASH_H2] {
            let register = favorited.state.books[hash].favorite.as_ref().unwrap();
            assert!(register.value);
            assert_eq!(register.stamp, stamp(2, DEVICE_A));
        }
        // Explicit "取消收藏" persists a false register instead of dropping it.
        let unfavorited = apply_command(
            &favorited,
            &OrganizationCommand::SetFavorite {
                content_hashes: vec![HASH_H1.into()],
                value: false,
            },
            &known(&[HASH_H1, HASH_H2]),
        )
        .unwrap();
        let register = unfavorited.state.books[HASH_H1].favorite.as_ref().unwrap();
        assert!(!register.value);
        assert_eq!(register.stamp, stamp(3, DEVICE_A));
        // Explicit "移出到未归类" persists a null register.
        let unclassified = apply_command(
            &unfavorited,
            &OrganizationCommand::MoveBooks {
                content_hashes: vec![HASH_H2.into()],
                folder_id: None,
            },
            &known(&[HASH_H1, HASH_H2]),
        )
        .unwrap();
        let register = unclassified.state.books[HASH_H2]
            .folder_id
            .as_ref()
            .unwrap();
        assert_eq!(register.value, None);
        assert_eq!(register.stamp, stamp(4, DEVICE_A));
        let json = serde_json::to_string(&unclassified.state).unwrap();
        assert!(json.contains(r#""value":false"#));
        assert!(json.contains(r#""value":null"#));
    }

    #[test]
    fn rejected_batches_leave_the_previous_envelope_untouched() {
        let state = state(
            vec![(FOLDER_F, folder("F", 1, DEVICE_A))],
            vec![(HASH_H1, book_favorite(true, 2, DEVICE_A))],
        );
        let start = envelope(DEVICE_A, 2, state);
        let before = start.clone();
        let missing_book = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        assert!(apply_command(
            &start,
            &OrganizationCommand::SetFavorite {
                content_hashes: vec![HASH_H1.into(), missing_book.into()],
                value: false,
            },
            &known(&[HASH_H1]),
        )
        .is_err());
        assert!(apply_command(
            &start,
            &OrganizationCommand::MoveBooks {
                content_hashes: vec![HASH_H1.into()],
                folder_id: Some(FOLDER_X.into()),
            },
            &known(&[HASH_H1]),
        )
        .is_err());
        // Other commands do not depend on book records and still work.
        assert!(apply_command(
            &start,
            &OrganizationCommand::MoveBooks {
                content_hashes: vec![HASH_H1.into()],
                folder_id: Some(FOLDER_F.into()),
            },
            &known(&[HASH_H1]),
        )
        .is_ok());
        // Empty array is an explicit no-op with no new stamp, even when the
        // (unused) target is unknown.
        let noop = apply_command(
            &start,
            &OrganizationCommand::SetFavorite {
                content_hashes: vec![],
                value: true,
            },
            &known(&[HASH_H1]),
        )
        .unwrap();
        assert_eq!(noop, before);
        let noop_move = apply_command(
            &start,
            &OrganizationCommand::MoveBooks {
                content_hashes: vec![],
                folder_id: Some(FOLDER_X.into()),
            },
            &known(&[HASH_H1]),
        )
        .unwrap();
        assert_eq!(noop_move, before);
        assert_eq!(start, before);
    }

    #[test]
    fn folder_lifecycle_trims_names_and_keeps_permanent_tombstones() {
        let created = apply_command(
            &envelope(DEVICE_A, 0, empty_organization()),
            &OrganizationCommand::CreateFolder {
                folder_id: FOLDER_F.into(),
                name: "  科幻  ".into(),
            },
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(created.state.folders[FOLDER_F].name.value, "科幻");
        assert_eq!(
            created.state.folders[FOLDER_F].name.stamp,
            stamp(1, DEVICE_A)
        );
        assert_eq!(created.counter, 1);
        // A used UUID cannot be created again, live or tombstoned.
        assert!(apply_command(
            &created,
            &OrganizationCommand::CreateFolder {
                folder_id: FOLDER_F.into(),
                name: "另一个".into(),
            },
            &HashSet::new(),
        )
        .is_err());
        let renamed = apply_command(
            &created,
            &OrganizationCommand::RenameFolder {
                folder_id: FOLDER_F.into(),
                name: "改名".into(),
            },
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(renamed.state.folders[FOLDER_F].name.value, "改名");
        let deleted = apply_command(
            &renamed,
            &OrganizationCommand::DeleteFolder {
                folder_id: FOLDER_F.into(),
            },
            &HashSet::new(),
        )
        .unwrap();
        // Deleting keeps the name register and only adds the tombstone.
        assert_eq!(deleted.state.folders[FOLDER_F].name.value, "改名");
        assert_eq!(
            deleted.state.folders[FOLDER_F].name.stamp,
            renamed.state.folders[FOLDER_F].name.stamp
        );
        assert_eq!(
            deleted.state.folders[FOLDER_F].deleted,
            Some(stamp(3, DEVICE_A))
        );
        // Deleting again is a no-op; creating or renaming the tombstoned UUID fails.
        let deleted_again = apply_command(
            &deleted,
            &OrganizationCommand::DeleteFolder {
                folder_id: FOLDER_F.into(),
            },
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(deleted_again, deleted);
        assert!(apply_command(
            &deleted,
            &OrganizationCommand::CreateFolder {
                folder_id: FOLDER_F.into(),
                name: "复活".into(),
            },
            &HashSet::new(),
        )
        .is_err());
        assert!(apply_command(
            &deleted,
            &OrganizationCommand::RenameFolder {
                folder_id: FOLDER_F.into(),
                name: "复活".into(),
            },
            &HashSet::new(),
        )
        .is_err());
        assert!(apply_command(
            &deleted,
            &OrganizationCommand::DeleteFolder {
                folder_id: FOLDER_X.into(),
            },
            &HashSet::new(),
        )
        .is_err());
    }

    #[test]
    fn folder_name_validation_uses_javascript_trim_and_code_points() {
        assert_eq!(js_trim("\u{FEFF}名\u{FEFF}"), "名");
        assert_eq!(js_trim("\u{0085}名\u{0085}"), "\u{0085}名\u{0085}");
        assert_eq!(js_trim("\t\r\n 名 \u{3000}\u{00A0}"), "名");
        assert_eq!(normalize_folder_name("  科幻  "), Ok("科幻".to_string()));
        assert!(normalize_folder_name("").is_err());
        assert!(normalize_folder_name(" \u{FEFF}\t").is_err());
        let forty = "😀".repeat(40);
        assert_eq!(normalize_folder_name(&forty), Ok(forty.clone()));
        assert!(normalize_folder_name(&"😀".repeat(41)).is_err());
        assert!(valid_folder_name(&forty));
        assert!(!valid_folder_name(" 名"));
        assert!(!valid_folder_name("名 "));
    }

    #[test]
    fn command_and_state_json_are_camel_case_and_tagged() {
        let command = OrganizationCommand::MoveBooks {
            content_hashes: vec![HASH_H1.into()],
            folder_id: None,
        };
        assert_eq!(
            serde_json::to_string(&command).unwrap(),
            format!(r#"{{"type":"moveBooks","contentHashes":["{HASH_H1}"],"folderId":null}}"#)
        );
        assert_eq!(
            serde_json::from_str::<OrganizationCommand>(&serde_json::to_string(&command).unwrap())
                .unwrap(),
            command
        );
        assert_eq!(
            serde_json::to_string(&OrganizationCommand::CreateFolder {
                folder_id: FOLDER_F.into(),
                name: "科幻".into(),
            })
            .unwrap(),
            format!(r#"{{"type":"createFolder","folderId":"{FOLDER_F}","name":"科幻"}}"#)
        );
        assert_eq!(
            serde_json::to_string(&OrganizationCommand::SetFavorite {
                content_hashes: vec![HASH_H1.into()],
                value: true,
            })
            .unwrap(),
            format!(r#"{{"type":"setFavorite","contentHashes":["{HASH_H1}"],"value":true}}"#)
        );
        assert_eq!(
            serde_json::to_string(&OrganizationCommand::DeleteFolder {
                folder_id: FOLDER_F.into(),
            })
            .unwrap(),
            format!(r#"{{"type":"deleteFolder","folderId":"{FOLDER_F}"}}"#)
        );
        let envelope = envelope(
            DEVICE_A,
            4,
            state(
                vec![(FOLDER_F, folder("科幻", 1, DEVICE_A))],
                vec![(
                    HASH_H1,
                    BookOrganization {
                        favorite: Some(reg(false, 2, DEVICE_A)),
                        folder_id: Some(reg(None, 3, DEVICE_A)),
                    },
                )],
            ),
        );
        let json = serde_json::to_string(&envelope).unwrap();
        assert_eq!(
            json,
            format!(
                r#"{{"deviceId":"{DEVICE_A}","counter":4,"state":{{"schemaVersion":1,"folders":{{"{FOLDER_F}":{{"name":{{"value":"科幻","stamp":{{"counter":1,"deviceId":"{DEVICE_A}"}}}}}}}},"books":{{"{HASH_H1}":{{"favorite":{{"value":false,"stamp":{{"counter":2,"deviceId":"{DEVICE_A}"}}}},"folderId":{{"value":null,"stamp":{{"counter":3,"deviceId":"{DEVICE_A}"}}}}}}}}}}}}"#
            )
        );
        assert_eq!(
            serde_json::from_str::<OrganizationEnvelope>(&json).unwrap(),
            envelope
        );
        // Deleted markers are optional on the wire and omitted when absent.
        assert!(!json.contains("deleted"));
    }

    #[test]
    fn validation_rejects_invalid_identity_hash_clock_and_names() {
        let valid = state(
            vec![(FOLDER_F, folder("科幻", 1, DEVICE_A))],
            vec![(
                HASH_H1,
                BookOrganization {
                    favorite: Some(reg(true, 2, DEVICE_A)),
                    folder_id: Some(reg(Some(FOLDER_F.to_string()), 3, DEVICE_A)),
                },
            )],
        );
        assert!(validate_organization(&valid).is_ok());
        assert!(validate_envelope(&envelope(DEVICE_A, 3, valid.clone())).is_ok());

        let mut wrong_version = valid.clone();
        wrong_version.schema_version = 2;
        assert!(validate_organization(&wrong_version).is_err());

        let uppercase_folder = state(
            vec![(FOLDER_F.to_uppercase().as_str(), folder("F", 1, DEVICE_A))],
            vec![],
        );
        assert!(validate_organization(&uppercase_folder).is_err());

        let bad_hash = state(
            vec![],
            vec![("not-a-hash", book_favorite(true, 1, DEVICE_A))],
        );
        assert!(validate_organization(&bad_hash).is_err());

        let zero_clock = state(vec![], vec![(HASH_H1, book_favorite(true, 0, DEVICE_A))]);
        assert!(validate_organization(&zero_clock).is_err());

        let untrimmed = state(vec![(FOLDER_F, folder(" F", 1, DEVICE_A))], vec![]);
        assert!(validate_organization(&untrimmed).is_err());

        let bad_target = state(
            vec![],
            vec![(HASH_H1, book_folder(Some("not-a-uuid"), 1, DEVICE_A))],
        );
        assert!(validate_organization(&bad_target).is_err());

        assert!(validate_envelope(&envelope("NOT-A-UUID", 0, empty_organization())).is_err());
        assert!(validate_envelope(&envelope(
            DEVICE_A,
            MAX_SAFE_COUNTER + 1,
            empty_organization()
        ))
        .is_err());
    }

    #[test]
    fn clock_exhaustion_is_reported_without_overflow() {
        assert!(next_stamp(&envelope(DEVICE_A, MAX_SAFE_COUNTER, empty_organization())).is_err());
        let observed_at_limit = state(
            vec![],
            vec![(HASH_H1, book_favorite(true, MAX_SAFE_COUNTER, DEVICE_B))],
        );
        assert!(next_stamp(&envelope(DEVICE_A, 0, observed_at_limit)).is_err());
    }
}
