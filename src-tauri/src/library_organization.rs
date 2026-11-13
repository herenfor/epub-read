//! Portable favorites / nested folder organization.
//!
//! This module is pure data plus merge, clock and command reduction: it has no
//! Tauri or filesystem dependency so the same rules can be reused by another
//! front end later.  `linked_library` owns the `library-organization.json`
//! envelope file and the write mutex; it only calls in here with inputs that
//! already came from the IPC boundary or from that file.
//!
//! A book's identity is the full EPUB content SHA-256 and each book has at most
//! one `folderId` register.  Favorites are an independent register.  Folders
//! form a tree through a stamped `parentId` register (max five levels).  Folder
//! deletion is a permanent tombstone: raw book/folder references are kept and
//! the view projection lifts children/books to the nearest live ancestor.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

/// JS `Number.MAX_SAFE_INTEGER`; the logical clock must stay in this range.
pub const MAX_SAFE_COUNTER: u64 = 9_007_199_254_740_991;
pub const MAX_FOLDER_NAME_CODE_POINTS: usize = 40;
pub const ORGANIZATION_SCHEMA_VERSION: u8 = 2;
pub const ORGANIZATION_LEGACY_SCHEMA_VERSION: u8 = 1;
pub const MAX_FOLDER_DEPTH: usize = 5;

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
    /// Parent relationship.  Missing means historical single-level data (root);
    /// new root events are an explicit `value: null`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub parent_id: Option<Register<Option<String>>>,
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
        /// Omitted or explicit null both mean the root for this create command.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    MoveFolder {
        folder_id: String,
        /// Must appear: null explicitly moves the folder to the root.
        #[serde(deserialize_with = "deserialize_required")]
        parent_id: Option<String>,
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
        parent_id: merge_register(a.parent_id.as_ref(), b.parent_id.as_ref())?,
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
        observe(folder.parent_id.as_ref().map(|register| &register.stamp));
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

/// Deterministic effective parent/depth/children projection shared with TS.
///
/// Missing or deleted ancestors are skipped; live cycles are broken at the
/// lexicographically smallest UUID in each cycle.  A node beyond five levels is
/// attached to its fourth-level ancestor so the node itself occupies a real
/// fifth-level slot; reported parent/depth/ancestors stay structurally
/// consistent.  Raw registers are never rewritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderTreeProjection {
    pub parent_by_id: BTreeMap<String, Option<String>>,
    pub depth_by_id: BTreeMap<String, usize>,
    pub unclamped_depth_by_id: BTreeMap<String, usize>,
    pub children_by_parent: BTreeMap<Option<String>, Vec<String>>,
}

fn parent_value(folder: &FolderState) -> Option<&str> {
    folder
        .parent_id
        .as_ref()
        .and_then(|register| register.value.as_deref())
}

fn live_ancestor_of(state: &LibraryOrganization, start: &str) -> Option<String> {
    let mut seen = std::collections::BTreeSet::new();
    seen.insert(start.to_string());
    let mut current = state.folders.get(start).and_then(parent_value).map(str::to_string);
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return (id == start).then_some(id);
        }
        let folder = state.folders.get(&id)?;
        if folder.deleted.is_none() {
            return Some(id);
        }
        current = parent_value(folder).map(str::to_string);
    }
    None
}

pub fn project_folder_tree(state: &LibraryOrganization) -> FolderTreeProjection {
    let mut live_ids: Vec<String> = state
        .folders
        .iter()
        .filter(|(_, folder)| folder.deleted.is_none())
        .map(|(id, _)| id.clone())
        .collect();
    live_ids.sort();
    let live: std::collections::BTreeSet<&str> = live_ids.iter().map(String::as_str).collect();

    let next_live: BTreeMap<String, Option<String>> = live_ids
        .iter()
        .map(|id| (id.clone(), live_ancestor_of(state, id)))
        .collect();

    // Break each functional-graph cycle at its smallest UUID.
    let mut cycle_roots = std::collections::BTreeSet::new();
    let mut color: BTreeMap<String, u8> = BTreeMap::new();
    for start in &live_ids {
        if color.get(start).copied().unwrap_or(0) != 0 {
            continue;
        }
        let mut path: Vec<String> = Vec::new();
        let mut position: BTreeMap<String, usize> = BTreeMap::new();
        let mut cursor = Some(start.clone());
        while let Some(id) = cursor.clone() {
            if !live.contains(id.as_str()) {
                break;
            }
            match color.get(&id).copied().unwrap_or(0) {
                2 => break,
                1 => {
                    if let Some(index) = position.get(&id) {
                        let root = path[*index..]
                            .iter()
                            .min()
                            .expect("cycle path is non-empty")
                            .clone();
                        cycle_roots.insert(root);
                    }
                    break;
                }
                _ => {}
            }
            color.insert(id.clone(), 1);
            position.insert(id.clone(), path.len());
            path.push(id.clone());
            cursor = next_live.get(&id).cloned().flatten();
        }
        for id in path {
            color.insert(id, 2);
        }
    }

    let mut base_parent: BTreeMap<String, Option<String>> = BTreeMap::new();
    for id in &live_ids {
        let parent = if cycle_roots.contains(id) {
            None
        } else {
            next_live.get(id).cloned().flatten()
        };
        base_parent.insert(id.clone(), parent);
    }

    let mut base_depth: BTreeMap<String, usize> = BTreeMap::new();
    for id in &live_ids {
        if base_depth.contains_key(id) {
            continue;
        }
        let mut path = Vec::new();
        let mut cursor = Some(id.clone());
        while let Some(node) = cursor.clone() {
            if base_depth.contains_key(&node) {
                break;
            }
            path.push(node.clone());
            cursor = base_parent.get(&node).cloned().flatten();
        }
        let mut depth = cursor
            .as_ref()
            .and_then(|node| base_depth.get(node).copied())
            .unwrap_or(0);
        for node in path.iter().rev() {
            depth += 1;
            base_depth.insert(node.clone(), depth);
        }
    }

    let mut parent_by_id = BTreeMap::new();
    let mut depth_by_id = BTreeMap::new();
    for id in &live_ids {
        let depth = *base_depth.get(id).expect("every live folder has a depth");
        if depth <= MAX_FOLDER_DEPTH {
            parent_by_id.insert(id.clone(), base_parent.get(id).cloned().flatten());
            depth_by_id.insert(id.clone(), depth);
        } else {
            // Attach to the fourth-level ancestor so this node itself is the
            // fifth level.  Merely changing the reported depth while keeping
            // the fifth-level ancestor as parent would leave a sixth level.
            let mut cursor = id.clone();
            while base_depth.get(&cursor).copied().unwrap_or(1) > MAX_FOLDER_DEPTH - 1 {
                cursor = base_parent
                    .get(&cursor)
                    .cloned()
                    .flatten()
                    .expect("a node deeper than five has an ancestor");
            }
            parent_by_id.insert(id.clone(), Some(cursor));
            depth_by_id.insert(id.clone(), MAX_FOLDER_DEPTH);
        }
    }

    let mut children_by_parent: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for id in &live_ids {
        let parent = parent_by_id.get(id).cloned().flatten();
        children_by_parent.entry(parent).or_default().push(id.clone());
    }
    for children in children_by_parent.values_mut() {
        children.sort();
    }

    FolderTreeProjection {
        parent_by_id,
        depth_by_id,
        unclamped_depth_by_id: base_depth,
        children_by_parent,
    }
}

/// View projection only: hidden/unknown folders lift to their nearest live
/// ancestor while the raw reference is preserved.
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
        Some(folder) if folder.deleted.is_none() => {
            state.folders.get_key_value(folder_id).map(|(id, _)| id.as_str())
        }
        Some(_) => {
            let promoted = live_ancestor_of(state, folder_id)?;
            match state.folders.get(&promoted) {
                Some(folder) if folder.deleted.is_none() => state
                    .folders
                    .get_key_value(&promoted)
                    .map(|(id, _)| id.as_str()),
                _ => None,
            }
        }
        None => None,
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn effective_folder_parent(state: &LibraryOrganization, folder_id: &str) -> Option<String> {
    if state
        .folders
        .get(folder_id)
        .is_none_or(|folder| folder.deleted.is_some())
    {
        return None;
    }
    project_folder_tree(state)
        .parent_by_id
        .get(folder_id)
        .cloned()
        .flatten()
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn effective_folder_depth(state: &LibraryOrganization, folder_id: &str) -> Option<usize> {
    if state
        .folders
        .get(folder_id)
        .is_none_or(|folder| folder.deleted.is_some())
    {
        return None;
    }
    project_folder_tree(state).depth_by_id.get(folder_id).copied()
}

/// Root-first effective ancestors, excluding the folder itself.
#[cfg_attr(not(test), allow(dead_code))]
pub fn effective_folder_ancestors(state: &LibraryOrganization, folder_id: &str) -> Vec<String> {
    let projection = project_folder_tree(state);
    if !projection.depth_by_id.contains_key(folder_id) {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut current = projection.parent_by_id.get(folder_id).cloned().flatten();
    while let Some(id) = current {
        result.push(id.clone());
        current = projection.parent_by_id.get(&id).cloned().flatten();
    }
    result.reverse();
    result
}

/// Effective direct children, ASCII sorted; deleted folders never appear.
#[cfg_attr(not(test), allow(dead_code))]
pub fn effective_folder_children(
    state: &LibraryOrganization,
    parent_id: Option<&str>,
) -> Vec<String> {
    if let Some(id) = parent_id {
        if state
            .folders
            .get(id)
            .is_none_or(|folder| folder.deleted.is_some())
        {
            return Vec::new();
        }
    }
    let key = parent_id.map(str::to_string);
    project_folder_tree(state)
        .children_by_parent
        .get(&key)
        .cloned()
        .unwrap_or_default()
}

/// All effective descendants (not including the folder), ASCII sorted.
#[cfg_attr(not(test), allow(dead_code))]
pub fn effective_folder_descendants(state: &LibraryOrganization, folder_id: &str) -> Vec<String> {
    if effective_folder_depth(state, folder_id).is_none() {
        return Vec::new();
    }
    let mut result = std::collections::BTreeSet::new();
    let mut pending = effective_folder_children(state, Some(folder_id));
    while let Some(id) = pending.pop() {
        if !result.insert(id.clone()) {
            continue;
        }
        pending.extend(effective_folder_children(state, Some(&id)));
    }
    result.into_iter().collect()
}

/// Stored lineage for export/import selection: [folder, parent, ...].  Deleted
/// ancestors are included because they are needed to preserve the placement.
#[cfg_attr(not(test), allow(dead_code))]
pub fn folder_stored_lineage(state: &LibraryOrganization, folder_id: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut current = Some(folder_id.to_string());
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            break;
        }
        let Some(folder) = state.folders.get(&id) else {
            break;
        };
        result.push(id.clone());
        current = parent_value(folder).map(str::to_string);
    }
    result
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
    if state.schema_version != ORGANIZATION_LEGACY_SCHEMA_VERSION
        && state.schema_version != ORGANIZATION_SCHEMA_VERSION
    {
        return Err(format!(
            "收藏与文件夹数据版本不受支持：{}",
            state.schema_version
        ));
    }
    let legacy = state.schema_version == ORGANIZATION_LEGACY_SCHEMA_VERSION;
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
        if legacy && folder.parent_id.is_some() {
            return Err("版本 1 的文件夹不能包含 parentId".into());
        }
        if let Some(register) = &folder.parent_id {
            if !valid_stamp(&register.stamp) {
                return Err("收藏与文件夹数据含有无效的逻辑时钟".into());
            }
            if let Some(target) = &register.value {
                if !valid_canonical_uuid(target) {
                    return Err("收藏与文件夹数据含有无效的文件夹 ID".into());
                }
            }
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

/// Validate then upgrade the in-memory shape without inventing parent events.
/// Legacy folders stay parentless (effective root); the next local write emits
/// a stamped parent register.
pub fn normalize_organization(mut state: LibraryOrganization) -> Result<LibraryOrganization, String> {
    validate_organization(&state)?;
    state.schema_version = ORGANIZATION_SCHEMA_VERSION;
    Ok(state)
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
        parent_id: Option<String>,
    },
    RenameFolder {
        folder_id: String,
        name: String,
    },
    SetFolderParent {
        folder_id: String,
        parent_id: Option<String>,
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

fn require_live_folder<'a>(
    state: &'a LibraryOrganization,
    folder_id: &str,
    missing: &str,
    deleted: &str,
) -> Result<&'a FolderState, String> {
    if !valid_canonical_uuid(folder_id) {
        return Err("无效的文件夹 ID".into());
    }
    match state.folders.get(folder_id) {
        Some(folder) if folder.deleted.is_none() => Ok(folder),
        Some(_) => Err(deleted.into()),
        None => Err(missing.into()),
    }
}

fn stored_subtree_ids(state: &LibraryOrganization, root: &str) -> std::collections::BTreeSet<String> {
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, folder) in &state.folders {
        if let Some(parent) = parent_value(folder) {
            children.entry(parent.to_string()).or_default().push(id.clone());
        }
    }
    let mut result = std::collections::BTreeSet::new();
    let mut pending = vec![root.to_string()];
    while let Some(id) = pending.pop() {
        if !result.insert(id.clone()) {
            continue;
        }
        if let Some(next) = children.get(&id) {
            pending.extend(next.iter().cloned());
        }
    }
    result
}

fn assert_no_stored_cycle(
    state: &LibraryOrganization,
    folder_id: &str,
    parent_id: &str,
) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut current = Some(parent_id.to_string());
    while let Some(id) = current {
        if id == folder_id {
            return Err("文件夹层级不能形成环".into());
        }
        if !seen.insert(id.clone()) {
            return Err("文件夹层级存在循环".into());
        }
        let Some(folder) = state.folders.get(&id) else {
            break;
        };
        current = parent_value(folder).map(str::to_string);
    }
    Ok(())
}

/// Validate a local create/move target: no raw cycle, and every affected live
/// folder stays within five unclamped levels.
fn assert_folder_placement(
    state: &LibraryOrganization,
    folder_id: &str,
    parent_id: Option<&str>,
    creating: bool,
) -> Result<(), String> {
    let dummy_stamp = Stamp {
        counter: 1,
        device_id: "00000000-0000-4000-8000-000000000000".into(),
    };
    let mut candidate = state.clone();
    if creating {
        candidate.folders.insert(
            folder_id.to_string(),
            FolderState {
                name: Register {
                    value: "待校验".into(),
                    stamp: dummy_stamp.clone(),
                },
                parent_id: Some(Register {
                    value: parent_id.map(str::to_string),
                    stamp: dummy_stamp,
                }),
                deleted: None,
            },
        );
    } else {
        candidate
            .folders
            .get_mut(folder_id)
            .expect("move source exists")
            .parent_id = Some(Register {
            value: parent_id.map(str::to_string),
            stamp: dummy_stamp,
        });
    }
    if let Some(parent) = parent_id {
        assert_no_stored_cycle(state, folder_id, parent)?;
    }
    let projection = project_folder_tree(&candidate);
    let affected = if creating {
        std::collections::BTreeSet::from([folder_id.to_string()])
    } else {
        stored_subtree_ids(state, folder_id)
    };
    for id in affected {
        let Some(folder) = candidate.folders.get(&id) else {
            continue;
        };
        if folder.deleted.is_some() {
            continue;
        }
        match projection.unclamped_depth_by_id.get(&id) {
            Some(depth) if *depth <= MAX_FOLDER_DEPTH => {}
            _ => return Err(format!("文件夹层级不能超过 {MAX_FOLDER_DEPTH} 层")),
        }
    }
    Ok(())
}

fn plan_command(
    state: &LibraryOrganization,
    command: &OrganizationCommand,
    known_content_hashes: &HashSet<String>,
) -> Result<Vec<Mutation>, String> {
    let mut mutations = Vec::new();
    match command {
        OrganizationCommand::CreateFolder {
            folder_id,
            name,
            parent_id,
        } => {
            if !valid_canonical_uuid(folder_id) {
                return Err("无效的文件夹 ID".into());
            }
            // A tombstoned UUID counts as used; creating again would revive it.
            if state.folders.contains_key(folder_id) {
                return Err("该文件夹 ID 已被使用".into());
            }
            if let Some(parent) = parent_id {
                require_live_folder(state, parent, "父文件夹不存在", "父文件夹已解散")?;
            }
            assert_folder_placement(state, folder_id, parent_id.as_deref(), true)?;
            mutations.push(Mutation::PutFolder {
                folder_id: folder_id.clone(),
                name: normalize_folder_name(name)?,
                parent_id: parent_id.clone(),
            });
        }
        OrganizationCommand::MoveFolder {
            folder_id,
            parent_id,
        } => {
            require_live_folder(state, folder_id, "文件夹不存在", "文件夹已解散")?;
            if parent_id.as_deref() == Some(folder_id.as_str()) {
                return Err("文件夹不能移动到自身".into());
            }
            if let Some(parent) = parent_id {
                require_live_folder(state, parent, "目标文件夹不存在", "目标文件夹已解散")?;
            }
            assert_folder_placement(state, folder_id, parent_id.as_deref(), false)?;
            mutations.push(Mutation::SetFolderParent {
                folder_id: folder_id.clone(),
                parent_id: parent_id.clone(),
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
            mutations.push(Mutation::RenameFolder {
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
            Mutation::PutFolder {
                folder_id,
                name,
                parent_id,
            } => {
                state.folders.insert(
                    folder_id,
                    FolderState {
                        name: Register {
                            value: name,
                            stamp: stamp.clone(),
                        },
                        parent_id: Some(Register {
                            // Root is an explicit stamped null.
                            value: parent_id,
                            stamp: stamp.clone(),
                        }),
                        deleted: None,
                    },
                );
            }
            Mutation::RenameFolder { folder_id, name } => {
                if let Some(folder) = state.folders.get_mut(&folder_id) {
                    folder.name = Register {
                        value: name,
                        stamp: stamp.clone(),
                    };
                }
            }
            Mutation::SetFolderParent {
                folder_id,
                parent_id,
            } => {
                if let Some(folder) = state.folders.get_mut(&folder_id) {
                    folder.parent_id = Some(Register {
                        value: parent_id,
                        stamp: stamp.clone(),
                    });
                }
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
    state.schema_version = ORGANIZATION_SCHEMA_VERSION;
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
mod tests;
