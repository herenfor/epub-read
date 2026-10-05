//! SQLite repository and internal S0 method surface.
//!
//! None of these methods is registered as a Tauri command in this package.
//! The integration package is expected to register the frozen wire on top of
//! this module, after independently checking IPC and migration activation.

use super::dto::{
    self, Annotation, BookMetadata, BookmarkValue, NoteValue, PortableBook, PortableStateV3,
    ProgressState, ProgressValue, Register, Stamp, Version,
};
use super::error::{PortableError, PortableResult};
use super::legacy::{self, MigrationMarker};
use super::merge::{
    capture_read_basis, maximum_received_counter, merge_portable_states, next_local_counter,
    prepare_observed_write, AdoptSelection, BasisSelection, EntityRef, PreparedWrite, ReadBasis,
    WriteIntent,
};
use crate::library_organization::{
    apply_command, effective_folder_id, empty_organization, is_favorite, merge_into_envelope,
    LibraryOrganization, OrganizationCommand, OrganizationEnvelope,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const KEY_INSTALLATION_ID: &str = "installationId";
const KEY_COUNTER: &str = "counter";
const KEY_MIGRATION: &str = "migration";
const KEY_PREFERENCES: &str = "preferences";
const KEY_ORGANIZATION: &str = "state";
const KEY_LOCAL_VISIBLE: &str = "visibleHashes";
const KEY_LOCAL_IS_NEW: &str = "isNewHashes";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressProjection {
    pub versions: Vec<Version<ProgressValue>>,
    pub display: Option<Version<ProgressValue>>,
    pub conflict: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationProjection<T> {
    pub id: String,
    pub versions: Vec<Version<T>>,
    pub display: Version<T>,
    pub conflict: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfBookProjection {
    pub book_hash: String,
    pub metadata: BookMetadata,
    pub metadata_stamp: Stamp,
    pub progress: ProgressProjection,
    pub bookmarks: Vec<AnnotationProjection<BookmarkValue>>,
    pub notes: Vec<AnnotationProjection<NoteValue>>,
    pub favorite: bool,
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfProjection {
    pub books: Vec<ShelfBookProjection>,
    pub organization: LibraryOrganization,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteStatus {
    Written,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome<S> {
    pub status: WriteStatus,
    pub entity: EntityRef,
    pub state: S,
    pub next_basis_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationWriteOutcome<T> {
    pub status: WriteStatus,
    pub entity: EntityRef,
    pub state: Annotation<T>,
    pub next_basis_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeleteStatus {
    Deleted,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome<T> {
    pub status: DeleteStatus,
    pub entity: EntityRef,
    pub state: Annotation<T>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseTarget {
    BasisId(String),
    ReadId(String),
    BookHash(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationOutcome {
    Migrated { books: usize, annotations: usize },
    AlreadyMigrated,
}

#[derive(Debug, Clone)]
struct ReadSnapshot {
    book_hash: String,
    book: Option<PortableBook>,
    revisions: BTreeMap<String, u64>,
}

#[derive(Debug, Clone)]
enum StoredBasis {
    Progress(ReadBasis<ProgressValue>),
    Bookmark(ReadBasis<BookmarkValue>),
    Note(ReadBasis<NoteValue>),
}

pub struct PortableStore {
    connection: Connection,
    next_handle: u64,
    reads: BTreeMap<String, ReadSnapshot>,
    bases: BTreeMap<String, StoredBasis>,
    runtime_generation: String,
}

fn process_runtime_marker() -> &'static str {
    static MARKER: OnceLock<String> = OnceLock::new();
    MARKER.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        format!("runtime-{nanos}")
    })
}

fn next_store_generation() -> String {
    static INSTANCE: AtomicU64 = AtomicU64::new(0);
    let instance = INSTANCE.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{}-{}", process_runtime_marker(), instance)
}

fn parse_json<T: DeserializeOwned>(raw: &str, label: &str) -> PortableResult<T> {
    serde_json::from_str(raw)
        .map_err(|error| PortableError::storage_error(format!("{label} JSON 无法解析：{error}")))
}

fn serialize_json<T: Serialize + ?Sized>(value: &T) -> PortableResult<String> {
    serde_json::to_string(value)
        .map_err(|error| PortableError::storage_error(format!("资料 JSON 无法序列化：{error}")))
}

fn i64_to_revision(value: i64) -> PortableResult<u64> {
    u64::try_from(value).map_err(|_| PortableError::storage_error("资料库 localRevision 为负数"))
}

fn column_revision(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<i64> {
    row.get::<_, i64>(index)
}

fn load_meta_json<T: DeserializeOwned>(
    connection: &Connection,
    key: &str,
) -> PortableResult<Option<T>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT json FROM local_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| parse_json(&raw, key)).transpose()
}

fn put_meta_json<T: Serialize + ?Sized>(
    connection: &Connection,
    key: &str,
    value: &T,
) -> PortableResult<()> {
    let raw = serialize_json(value)?;
    connection.execute(
        "INSERT INTO local_meta(key, json) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json",
        params![key, raw],
    )?;
    Ok(())
}

fn remove_meta(connection: &Connection, key: &str) -> PortableResult<()> {
    connection.execute("DELETE FROM local_meta WHERE key = ?1", params![key])?;
    Ok(())
}

fn load_counter(connection: &Connection) -> PortableResult<u64> {
    Ok(load_meta_json::<u64>(connection, KEY_COUNTER)?.unwrap_or(0))
}

fn store_counter(connection: &Connection, counter: u64) -> PortableResult<()> {
    put_meta_json(connection, KEY_COUNTER, &counter)
}

fn ensure_installation_id(connection: &Connection) -> PortableResult<String> {
    if let Some(installation_id) = load_meta_json::<String>(connection, KEY_INSTALLATION_ID)? {
        if dto::valid_canonical_uuid(&installation_id) {
            return Ok(installation_id);
        }
        return Err(PortableError::storage_error(
            "资料库 installationId 不是规范 UUID",
        ));
    }
    let installation_id = legacy::random_uuid_v4()?;
    put_meta_json(connection, KEY_INSTALLATION_ID, &installation_id)?;
    Ok(installation_id)
}

fn load_organization(connection: &Connection) -> PortableResult<LibraryOrganization> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT json FROM organization WHERE key = ?1",
            params![KEY_ORGANIZATION],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        Some(raw) => parse_json(&raw, "organization"),
        None => Ok(empty_organization()),
    }
}

fn store_organization(
    connection: &Connection,
    organization: &LibraryOrganization,
) -> PortableResult<()> {
    let raw = serialize_json(organization)?;
    connection.execute(
        "INSERT INTO organization(key, json) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json",
        params![KEY_ORGANIZATION, raw],
    )?;
    Ok(())
}

fn load_book_meta_row(
    connection: &Connection,
    book_hash: &str,
) -> PortableResult<Option<Register<BookMetadata>>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT json FROM book_meta WHERE hash = ?1",
            params![book_hash],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| parse_json(&raw, "book_meta")).transpose()
}

fn load_progress_row(
    connection: &Connection,
    book_hash: &str,
) -> PortableResult<Option<(ProgressState, u64)>> {
    let row: Option<(String, i64)> = connection
        .query_row(
            "SELECT json, local_revision FROM progress WHERE hash = ?1",
            params![book_hash],
            |row| Ok((row.get(0)?, column_revision(row, 1)?)),
        )
        .optional()?;
    match row {
        Some((raw, revision)) => Ok(Some((
            parse_json(&raw, "progress")?,
            i64_to_revision(revision)?,
        ))),
        None => Ok(None),
    }
}

fn save_progress_row(
    connection: &Connection,
    book_hash: &str,
    progress: &ProgressState,
    local_revision: u64,
) -> PortableResult<()> {
    let raw = serialize_json(progress)?;
    connection.execute(
        "INSERT INTO progress(hash, json, local_revision) VALUES(?1, ?2, ?3)
         ON CONFLICT(hash) DO UPDATE SET json = excluded.json, local_revision = excluded.local_revision",
        params![book_hash, raw, local_revision as i64],
    )?;
    Ok(())
}

fn load_annotation_row<T: DeserializeOwned>(
    connection: &Connection,
    kind: &str,
    book_hash: &str,
    id: &str,
) -> PortableResult<Option<Annotation<T>>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT json FROM annotations WHERE hash = ?1 AND kind = ?2 AND id = ?3",
            params![book_hash, kind, id],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| parse_json(&raw, "annotations")).transpose()
}

fn save_annotation_row<T: Serialize + ?Sized>(
    connection: &Connection,
    kind: &str,
    book_hash: &str,
    id: &str,
    annotation: &T,
    local_revision: u64,
) -> PortableResult<()> {
    let raw = serialize_json(annotation)?;
    connection.execute(
        "INSERT INTO annotations(hash, kind, id, json, local_revision) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(hash, kind, id) DO UPDATE SET json = excluded.json, local_revision = excluded.local_revision",
        params![book_hash, kind, id, raw, local_revision as i64],
    )?;
    Ok(())
}

fn load_annotation_revision(
    connection: &Connection,
    kind: &str,
    book_hash: &str,
    id: &str,
) -> PortableResult<u64> {
    let revision: Option<i64> = connection
        .query_row(
            "SELECT local_revision FROM annotations WHERE hash = ?1 AND kind = ?2 AND id = ?3",
            params![book_hash, kind, id],
            |row| column_revision(row, 0),
        )
        .optional()?;
    match revision {
        Some(revision) => i64_to_revision(revision),
        None => Ok(0),
    }
}

fn load_progress_revision(connection: &Connection, book_hash: &str) -> PortableResult<u64> {
    let revision: Option<i64> = connection
        .query_row(
            "SELECT local_revision FROM progress WHERE hash = ?1",
            params![book_hash],
            |row| column_revision(row, 0),
        )
        .optional()?;
    match revision {
        Some(revision) => i64_to_revision(revision),
        None => Ok(0),
    }
}

fn load_bookmark_row(
    connection: &Connection,
    book_hash: &str,
    id: &str,
) -> PortableResult<Option<Annotation<BookmarkValue>>> {
    load_annotation_row(connection, "bookmark", book_hash, id)
}

fn save_bookmark_row(
    connection: &Connection,
    book_hash: &str,
    id: &str,
    annotation: &Annotation<BookmarkValue>,
    local_revision: u64,
) -> PortableResult<()> {
    save_annotation_row(
        connection,
        "bookmark",
        book_hash,
        id,
        annotation,
        local_revision,
    )
}

fn load_note_row(
    connection: &Connection,
    book_hash: &str,
    id: &str,
) -> PortableResult<Option<Annotation<NoteValue>>> {
    load_annotation_row(connection, "note", book_hash, id)
}

fn save_note_row(
    connection: &Connection,
    book_hash: &str,
    id: &str,
    annotation: &Annotation<NoteValue>,
    local_revision: u64,
) -> PortableResult<()> {
    save_annotation_row(
        connection,
        "note",
        book_hash,
        id,
        annotation,
        local_revision,
    )
}

fn load_state_at_connection(connection: &Connection) -> PortableResult<PortableStateV3> {
    let mut books: BTreeMap<String, PortableBook> = BTreeMap::new();
    {
        let mut statement = connection.prepare("SELECT hash, json FROM book_meta")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (book_hash, raw) = row?;
            let metadata: Register<BookMetadata> = parse_json(&raw, "book_meta")?;
            books.insert(
                book_hash,
                PortableBook {
                    metadata,
                    progress: ProgressState {
                        versions: Vec::new(),
                    },
                    bookmarks: BTreeMap::new(),
                    notes: BTreeMap::new(),
                },
            );
        }
    }
    {
        let mut statement = connection.prepare("SELECT hash, json FROM progress")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (book_hash, raw) = row?;
            let progress: ProgressState = parse_json(&raw, "progress")?;
            let book = books
                .get_mut(&book_hash)
                .ok_or_else(|| PortableError::storage_error("progress 行没有对应 book_meta"))?;
            book.progress = progress;
        }
    }
    {
        let mut statement = connection.prepare("SELECT hash, kind, id, json FROM annotations")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (book_hash, kind, id, raw) = row?;
            let book = books
                .get_mut(&book_hash)
                .ok_or_else(|| PortableError::storage_error("annotations 行没有对应 book_meta"))?;
            match kind.as_str() {
                "bookmark" => {
                    book.bookmarks.insert(id, parse_json(&raw, "bookmark")?);
                }
                "note" => {
                    book.notes.insert(id, parse_json(&raw, "note")?);
                }
                other => {
                    return Err(PortableError::storage_error(format!(
                        "annotations 行 kind 未知：{other}"
                    )))
                }
            }
        }
    }
    let state = PortableStateV3 {
        schema_version: 3,
        books,
        organization: load_organization(connection)?,
        preferences: load_meta_json(connection, KEY_PREFERENCES)?,
    };
    dto::validate_portable_state(&state)?;
    Ok(state)
}

fn load_read_snapshot(connection: &Connection, book_hash: &str) -> PortableResult<ReadSnapshot> {
    let metadata = load_book_meta_row(connection, book_hash)?;
    let mut revisions = BTreeMap::new();
    let Some(metadata) = metadata else {
        let has_orphan: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM progress WHERE hash = ?1
                 UNION ALL SELECT 1 FROM annotations WHERE hash = ?1 LIMIT 1",
                params![book_hash],
                |row| row.get(0),
            )
            .optional()?;
        if has_orphan.is_some() {
            return Err(PortableError::storage_error("资料行没有对应的 book_meta"));
        }
        return Ok(ReadSnapshot {
            book_hash: book_hash.to_string(),
            book: None,
            revisions,
        });
    };

    let (progress, progress_revision) = load_progress_row(connection, book_hash)?.unwrap_or((
        ProgressState {
            versions: Vec::new(),
        },
        0,
    ));
    revisions.insert("progress".to_string(), progress_revision);
    let mut bookmarks = BTreeMap::new();
    let mut notes = BTreeMap::new();
    {
        let mut statement = connection
            .prepare("SELECT kind, id, json, local_revision FROM annotations WHERE hash = ?1")?;
        let rows = statement.query_map(params![book_hash], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                column_revision(row, 3)?,
            ))
        })?;
        for row in rows {
            let (kind, id, raw, revision) = row?;
            let revision = i64_to_revision(revision)?;
            match kind.as_str() {
                "bookmark" => {
                    revisions.insert(format!("bookmark:{id}"), revision);
                    bookmarks.insert(id, parse_json(&raw, "bookmark")?);
                }
                "note" => {
                    revisions.insert(format!("note:{id}"), revision);
                    notes.insert(id, parse_json(&raw, "note")?);
                }
                other => {
                    return Err(PortableError::storage_error(format!(
                        "annotations 行 kind 未知：{other}"
                    )))
                }
            }
        }
    }
    let book = PortableBook {
        metadata,
        progress,
        bookmarks,
        notes,
    };
    dto::validate_portable_book(&book)?;
    Ok(ReadSnapshot {
        book_hash: book_hash.to_string(),
        book: Some(book),
        revisions,
    })
}

fn has_portable_rows(connection: &Connection) -> PortableResult<bool> {
    let count: i64 = connection.query_row(
        "SELECT
             (SELECT COUNT(*) FROM book_meta)
           + (SELECT COUNT(*) FROM progress)
           + (SELECT COUNT(*) FROM annotations)
           + (SELECT COUNT(*) FROM organization)",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn migration_marker(connection: &Connection) -> PortableResult<Option<MigrationMarker>> {
    load_meta_json(connection, KEY_MIGRATION)
}

fn store_book_shape(
    connection: &Connection,
    book_hash: &str,
    book: &PortableBook,
    local_revisions: &BTreeMap<String, u64>,
) -> PortableResult<()> {
    let metadata_raw = serialize_json(&book.metadata)?;
    connection.execute(
        "INSERT INTO book_meta(hash, json) VALUES(?1, ?2)
         ON CONFLICT(hash) DO UPDATE SET json = excluded.json",
        params![book_hash, metadata_raw],
    )?;
    let progress_revision = local_revisions
        .get(&format!("progress"))
        .copied()
        .unwrap_or(0);
    save_progress_row(connection, book_hash, &book.progress, progress_revision)?;
    for (id, annotation) in &book.bookmarks {
        let revision = local_revisions
            .get(&format!("bookmark:{id}"))
            .copied()
            .unwrap_or(0);
        save_annotation_row(connection, "bookmark", book_hash, id, annotation, revision)?;
    }
    for (id, annotation) in &book.notes {
        let revision = local_revisions
            .get(&format!("note:{id}"))
            .copied()
            .unwrap_or(0);
        save_annotation_row(connection, "note", book_hash, id, annotation, revision)?;
    }
    Ok(())
}

fn read_local_revisions(connection: &Connection) -> PortableResult<BTreeMap<String, u64>> {
    let mut revisions = BTreeMap::new();
    {
        let mut statement = connection.prepare("SELECT hash, local_revision FROM progress")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, column_revision(row, 1)?))
        })?;
        for row in rows {
            let (book_hash, revision) = row?;
            revisions.insert(format!("{book_hash}:progress"), i64_to_revision(revision)?);
        }
    }
    {
        let mut statement =
            connection.prepare("SELECT hash, kind, id, local_revision FROM annotations")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                column_revision(row, 3)?,
            ))
        })?;
        for row in rows {
            let (book_hash, kind, id, revision) = row?;
            revisions.insert(
                format!("{book_hash}:{kind}:{id}"),
                i64_to_revision(revision)?,
            );
        }
    }
    Ok(revisions)
}

pub(crate) fn group_import_revisions(
    revisions: BTreeMap<String, u64>,
    imported_hashes: &BTreeSet<String>,
) -> PortableResult<BTreeMap<String, BTreeMap<String, u64>>> {
    let mut grouped = BTreeMap::<String, BTreeMap<String, u64>>::new();
    for (key, revision) in revisions {
        let (hash, scoped_key) = key
            .split_once(':')
            .ok_or_else(|| PortableError::storage_error("本机 revision key 格式非法"))?;
        if imported_hashes.contains(hash) {
            grouped
                .entry(hash.to_owned())
                .or_default()
                .insert(scoped_key.to_owned(), revision);
        }
    }
    Ok(grouped)
}

fn load_local_visible_hashes(connection: &Connection) -> PortableResult<BTreeSet<String>> {
    let values: Vec<String> = load_meta_json(connection, KEY_LOCAL_VISIBLE)?.unwrap_or_default();
    let mut result = BTreeSet::new();
    for value in values {
        if !dto::valid_content_hash(&value) {
            return Err(PortableError::storage_error(
                "本机可见性数据含有不规范 contentHash",
            ));
        }
        result.insert(value);
    }
    Ok(result)
}

fn save_local_visible_hashes(
    connection: &Connection,
    hashes: &BTreeSet<String>,
) -> PortableResult<()> {
    let values: Vec<&str> = hashes.iter().map(String::as_str).collect();
    put_meta_json(connection, KEY_LOCAL_VISIBLE, &values)
}

fn load_local_is_new_hashes(connection: &Connection) -> PortableResult<BTreeSet<String>> {
    let values: Vec<String> = load_meta_json(connection, KEY_LOCAL_IS_NEW)?.unwrap_or_default();
    let mut result = BTreeSet::new();
    for value in values {
        if !dto::valid_content_hash(&value) {
            return Err(PortableError::storage_error(
                "本机新书标记含有不规范 contentHash",
            ));
        }
        result.insert(value);
    }
    Ok(result)
}

fn save_local_is_new_hashes(
    connection: &Connection,
    hashes: &BTreeSet<String>,
) -> PortableResult<()> {
    let values: Vec<&str> = hashes.iter().map(String::as_str).collect();
    put_meta_json(connection, KEY_LOCAL_IS_NEW, &values)
}

impl PortableStore {
    pub fn open(path: &Path) -> PortableResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                PortableError::storage_error(format!("无法创建资料库目录：{error}"))
            })?;
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> PortableResult<Self> {
        let connection = Connection::open_in_memory()?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> PortableResult<Self> {
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS book_meta (
                 hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS progress (
                 hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL,
                 local_revision INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS annotations (
                 hash TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 id TEXT NOT NULL,
                 json TEXT NOT NULL,
                 local_revision INTEGER NOT NULL,
                 PRIMARY KEY (hash, kind, id)
             );
             CREATE TABLE IF NOT EXISTS organization (
                 key TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS device_bindings (
                 hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS local_meta (
                 key TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL
             );",
        )?;
        Ok(Self {
            connection,
            next_handle: 0,
            reads: BTreeMap::new(),
            bases: BTreeMap::new(),
            runtime_generation: next_store_generation(),
        })
    }

    pub fn runtime_generation(&self) -> &str {
        &self.runtime_generation
    }

    fn new_handle(&mut self, prefix: &str) -> String {
        self.next_handle = self.next_handle.saturating_add(1);
        // Include the in-memory store generation so a handle from a replaced
        // repository can never collide with a new store's same sequence number.
        format!("{}:{prefix}:{}", self.runtime_generation, self.next_handle)
    }

    pub fn installation_id(&self) -> PortableResult<Option<String>> {
        load_meta_json(&self.connection, KEY_INSTALLATION_ID)
    }

    pub fn counter(&self) -> PortableResult<u64> {
        load_counter(&self.connection)
    }

    pub fn migration_completed(&self) -> PortableResult<bool> {
        Ok(migration_marker(&self.connection)?
            .map(|marker| marker.status == "complete")
            .unwrap_or(false))
    }

    /// Raw device-binding JSON is intentionally kept as an opaque local row:
    /// it contains absolute paths and must never leak into the portable state.
    pub fn binding_raw(&self, content_hash: &str) -> PortableResult<Option<String>> {
        if !dto::valid_content_hash(content_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：contentHash 必须是 64 位小写内容指纹",
            ));
        }
        Ok(self
            .connection
            .query_row(
                "SELECT json FROM device_bindings WHERE hash = ?1",
                params![content_hash],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn bindings_raw(&self) -> PortableResult<BTreeMap<String, String>> {
        let mut bindings = BTreeMap::new();
        let mut statement = self
            .connection
            .prepare("SELECT hash, json FROM device_bindings")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (content_hash, raw) = row?;
            if !dto::valid_content_hash(&content_hash) {
                return Err(PortableError::storage_error(
                    "device_bindings 行含有不规范 contentHash",
                ));
            }
            bindings.insert(content_hash, raw);
        }
        Ok(bindings)
    }

    pub fn snapshot(&self) -> PortableResult<PortableStateV3> {
        let transaction = self.connection.unchecked_transaction()?;
        let state = load_state_at_connection(&transaction)?;
        Ok(state)
    }

    pub fn merge_validated_state(
        &mut self,
        incoming: PortableStateV3,
    ) -> PortableResult<PortableStateV3> {
        dto::validate_portable_state(&incoming)?;
        let incoming_max = super::merge::maximum_received_counter_from_state(&incoming)?;
        let transaction = self.connection.unchecked_transaction()?;
        let local = load_state_at_connection(&transaction)?;
        let local_max = super::merge::maximum_received_counter_from_state(&local)?;
        let merged = merge_portable_states(&local, &incoming)?;
        let merged_max = super::merge::maximum_received_counter_from_state(&merged)?;
        let next_counter = load_counter(&transaction)?
            .max(local_max)
            .max(incoming_max)
            .max(merged_max);
        let _installation_id = ensure_installation_id(&transaction)?;
        let local_revisions = read_local_revisions(&transaction)?;
        for (book_hash, book) in &merged.books {
            let scoped: BTreeMap<String, u64> = local_revisions
                .iter()
                .filter_map(|(key, revision)| {
                    key.strip_prefix(&format!("{book_hash}:"))
                        .map(|suffix| (suffix.to_string(), *revision))
                })
                .collect();
            store_book_shape(&transaction, book_hash, book, &scoped)?;
        }
        store_organization(&transaction, &merged.organization)?;
        match &merged.preferences {
            Some(preferences) => put_meta_json(&transaction, KEY_PREFERENCES, preferences)?,
            None => remove_meta(&transaction, KEY_PREFERENCES)?,
        }
        store_counter(&transaction, next_counter)?;
        transaction.commit()?;
        Ok(merged)
    }

    /// Merge one validated `.epubsave` incoming state and persist the
    /// verified managed bindings in the same SQLite transaction.
    ///
    /// This is the F-N file-import entry point. It intentionally mirrors
    /// `merge_validated_state` but also writes only the binding rows for
    /// managed copies published by the file job; it never touches existing
    /// valid local bindings. Visible hashes are extended with every incoming
    /// book, and `isNew` is only added for hashes that were not visible before
    /// this transaction.
    pub fn merge_validated_import(
        &mut self,
        incoming: PortableStateV3,
        bindings: Vec<(String, String)>,
        apply_preferences: bool,
    ) -> PortableResult<PortableStateV3> {
        self.merge_validated_import_ref(&incoming, bindings, apply_preferences)
    }

    /// Reference-taking form used by the LAN commit path so the full incoming
    /// DTO is not cloned just before merge.
    pub fn merge_validated_import_ref(
        &mut self,
        incoming: &PortableStateV3,
        bindings: Vec<(String, String)>,
        apply_preferences: bool,
    ) -> PortableResult<PortableStateV3> {
        dto::validate_portable_state(incoming)?;
        for (content_hash, raw) in &bindings {
            if !dto::valid_content_hash(content_hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：binding contentHash 必须是 64 位小写内容指纹",
                ));
            }
            if !incoming.books.contains_key(content_hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：managed binding 必须对应本次导入的书籍",
                ));
            }
            serde_json::from_str::<serde_json::Value>(raw).map_err(|error| {
                PortableError::invalid_data(format!("invalid-data：设备绑定不是合法 JSON：{error}"))
            })?;
        }

        let imported_hashes: BTreeSet<String> = incoming.books.keys().cloned().collect();
        let incoming_max = super::merge::maximum_received_counter_from_state(&incoming)?;
        let transaction = self.connection.unchecked_transaction()?;
        let local = load_state_at_connection(&transaction)?;
        let local_preferences = local.preferences.clone();
        let visible_before = load_local_visible_hashes(&transaction)?;
        let mut visible = visible_before.clone();
        let mut is_new = load_local_is_new_hashes(&transaction)?;
        let local_max = super::merge::maximum_received_counter_from_state(&local)?;
        let mut merged = merge_portable_states(&local, &incoming)?;
        // Preferences are never applied implicitly: the file commit must opt
        // in explicitly, and an absent incoming preference set keeps the local
        // choice rather than erasing it.
        merged.preferences = if apply_preferences {
            incoming
                .preferences
                .clone()
                .or_else(|| local_preferences.clone())
        } else {
            local_preferences
        };
        dto::validate_portable_state(&merged)?;
        let merged_max = super::merge::maximum_received_counter_from_state(&merged)?;
        let next_counter = load_counter(&transaction)?
            .max(local_max)
            .max(incoming_max)
            .max(merged_max);
        let _installation_id = ensure_installation_id(&transaction)?;
        let local_revisions = read_local_revisions(&transaction)?;
        let grouped_revisions = group_import_revisions(local_revisions, &imported_hashes)?;
        for book_hash in &imported_hashes {
            let Some(book) = merged.books.get(book_hash) else {
                continue;
            };
            let scoped = grouped_revisions
                .get(book_hash)
                .cloned()
                .unwrap_or_default();
            store_book_shape(&transaction, book_hash, book, &scoped)?;
        }
        store_organization(&transaction, &merged.organization)?;
        match &merged.preferences {
            Some(preferences) => put_meta_json(&transaction, KEY_PREFERENCES, preferences)?,
            None => remove_meta(&transaction, KEY_PREFERENCES)?,
        }

        for (hash, raw) in &bindings {
            transaction.execute(
                "INSERT INTO device_bindings(hash, json) VALUES(?1, ?2)
                 ON CONFLICT(hash) DO UPDATE SET json = excluded.json",
                params![hash, raw],
            )?;
        }

        for hash in incoming.books.keys() {
            visible.insert(hash.clone());
            if !visible_before.contains(hash) {
                is_new.insert(hash.clone());
            }
        }
        save_local_visible_hashes(&transaction, &visible)?;
        save_local_is_new_hashes(&transaction, &is_new)?;
        store_counter(&transaction, next_counter)?;
        transaction.commit()?;
        Ok(merged)
    }

    /// R3: merge old archive records into the current v3 state in one SQLite
    /// transaction. Existing v3 progress and annotation IDs (including
    /// tombstones) stay local; only missing entities are initialized.
    pub fn import_legacy_records(
        &mut self,
        records: Vec<legacy::LegacyRecord>,
        organization: LibraryOrganization,
    ) -> PortableResult<PortableStateV3> {
        crate::library_organization::validate_organization(&organization)
            .map_err(PortableError::invalid_data)?;
        let imported_hashes: BTreeSet<String> = records
            .iter()
            .map(|record| record.content_hash().to_string())
            .collect();
        let transaction = self.connection.unchecked_transaction()?;
        let local = load_state_at_connection(&transaction)?;
        let installation_id = ensure_installation_id(&transaction)?;
        let mut counter = load_counter(&transaction)?
            .max(super::merge::maximum_received_counter_from_state(&local)?);
        let incoming = legacy::build_import_state(
            &local,
            &records,
            &organization,
            &mut counter,
            &installation_id,
        )?;
        let merged = merge_portable_states(&local, &incoming)?;
        dto::validate_portable_state(&merged)?;
        counter = counter.max(super::merge::maximum_received_counter_from_state(&merged)?);
        let local_revisions = read_local_revisions(&transaction)?;
        for (book_hash, book) in &merged.books {
            let scoped: BTreeMap<String, u64> = local_revisions
                .iter()
                .filter_map(|(key, revision)| {
                    key.strip_prefix(&format!("{book_hash}:"))
                        .map(|suffix| (suffix.to_string(), *revision))
                })
                .collect();
            store_book_shape(&transaction, book_hash, book, &scoped)?;
        }
        store_organization(&transaction, &merged.organization)?;
        store_counter(&transaction, counter)?;
        if !imported_hashes.is_empty() {
            let mut visible = load_local_visible_hashes(&transaction)?;
            visible.extend(imported_hashes);
            save_local_visible_hashes(&transaction, &visible)?;
        }
        transaction.commit()?;
        Ok(merged)
    }

    /// JSON boundary used by the Tauri command; validation/conversion stays in
    /// the migration module and the actual merge stays in one transaction.
    pub fn import_legacy_records_json(
        &mut self,
        records: Vec<serde_json::Value>,
        organization: LibraryOrganization,
    ) -> PortableResult<PortableStateV3> {
        let parsed = legacy::parse_legacy_records(records)?;
        self.import_legacy_records(parsed, organization)
    }

    /// Local visibility hashes created by an archive import without bytes.
    pub fn local_visible_hashes(&self) -> PortableResult<Vec<String>> {
        Ok(load_local_visible_hashes(&self.connection)?
            .into_iter()
            .collect())
    }

    pub fn set_local_visible(
        &mut self,
        content_hash: &str,
        visible: bool,
    ) -> PortableResult<()> {
        if !dto::valid_content_hash(content_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：contentHash 必须是 64 位小写内容指纹",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let mut hashes = load_local_visible_hashes(&transaction)?;
        if visible {
            hashes.insert(content_hash.to_string());
        } else {
            hashes.remove(content_hash);
        }
        save_local_visible_hashes(&transaction, &hashes)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn local_is_new_hashes(&self) -> PortableResult<Vec<String>> {
        Ok(load_local_is_new_hashes(&self.connection)?
            .into_iter()
            .collect())
    }

    pub fn set_local_is_new(
        &mut self,
        content_hash: &str,
        is_new: bool,
    ) -> PortableResult<()> {
        if !dto::valid_content_hash(content_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：contentHash 必须是 64 位小写内容指纹",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let mut hashes = load_local_is_new_hashes(&transaction)?;
        if is_new {
            hashes.insert(content_hash.to_string());
        } else {
            hashes.remove(content_hash);
        }
        save_local_is_new_hashes(&transaction, &hashes)?;
        transaction.commit()?;
        Ok(())
    }

    /// Persist one device binding as an opaque local row.
    pub fn save_binding_raw(&mut self, content_hash: &str, raw: &str) -> PortableResult<()> {
        if !dto::valid_content_hash(content_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：contentHash 必须是 64 位小写内容指纹",
            ));
        }
        serde_json::from_str::<serde_json::Value>(raw)
            .map_err(|error| PortableError::invalid_data(format!("invalid-data：设备绑定不是合法 JSON：{error}")))?;
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO device_bindings(hash, json) VALUES(?1, ?2)
             ON CONFLICT(hash) DO UPDATE SET json = excluded.json",
            params![content_hash, raw],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_binding(&mut self, content_hash: &str) -> PortableResult<()> {
        if !dto::valid_content_hash(content_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：contentHash 必须是 64 位小写内容指纹",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM device_bindings WHERE hash = ?1",
            params![content_hash],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Persist the complete device-binding set in one transaction.
    pub fn replace_bindings_snapshot(
        &mut self,
        bindings: Vec<(String, String)>,
    ) -> PortableResult<()> {
        for (hash, raw) in &bindings {
            if !dto::valid_content_hash(hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：binding contentHash 必须是 64 位小写内容指纹",
                ));
            }
            serde_json::from_str::<serde_json::Value>(raw).map_err(|error| {
                PortableError::invalid_data(format!("invalid-data：设备绑定不是合法 JSON：{error}"))
            })?;
        }
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM device_bindings", [])?;
        for (hash, raw) in &bindings {
            transaction.execute(
                "INSERT INTO device_bindings(hash, json) VALUES(?1, ?2)",
                params![hash, raw],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Persist a full linked records snapshot: initialize missing portable
    /// books, set exact local visibility, and update the local isNew set while
    /// preserving existing v3 metadata/progress/annotations.
    pub fn publish_linked_records_snapshot(
        &mut self,
        records: Vec<serde_json::Value>,
        visible_hashes: Vec<String>,
        is_new_hashes: Vec<String>,
    ) -> PortableResult<PortableStateV3> {
        let parsed = legacy::parse_legacy_records(records)?;
        for hash in visible_hashes.iter().chain(is_new_hashes.iter()) {
            if !dto::valid_content_hash(hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：本机标记 contentHash 必须是 64 位小写内容指纹",
                ));
            }
        }
        let transaction = self.connection.unchecked_transaction()?;
        let local = load_state_at_connection(&transaction)?;
        let installation_id = ensure_installation_id(&transaction)?;
        let mut counter = load_counter(&transaction)?
            .max(super::merge::maximum_received_counter_from_state(&local)?);
        let incoming = legacy::build_import_state(
            &local,
            &parsed,
            &local.organization,
            &mut counter,
            &installation_id,
        )?;
        let merged = merge_portable_states(&local, &incoming)?;
        dto::validate_portable_state(&merged)?;
        counter = counter.max(super::merge::maximum_received_counter_from_state(&merged)?);
        let local_revisions = read_local_revisions(&transaction)?;
        for (book_hash, book) in &merged.books {
            let scoped: BTreeMap<String, u64> = local_revisions
                .iter()
                .filter_map(|(key, revision)| {
                    key.strip_prefix(&format!("{book_hash}:"))
                        .map(|suffix| (suffix.to_string(), *revision))
                })
                .collect();
            store_book_shape(&transaction, book_hash, book, &scoped)?;
        }
        let visible: BTreeSet<String> = visible_hashes.into_iter().collect();
        let is_new: BTreeSet<String> = is_new_hashes.into_iter().collect();
        save_local_visible_hashes(&transaction, &visible)?;
        save_local_is_new_hashes(&transaction, &is_new)?;
        store_counter(&transaction, counter)?;
        transaction.commit()?;
        Ok(merged)
    }

    /// One transaction for a linked/managed import batch: initialize missing
    /// portable books, upsert bindings, and publish visibility/isNew flags.
    pub fn publish_linked_imports(
        &mut self,
        records: Vec<serde_json::Value>,
        bindings: Vec<(String, String)>,
        visible_hashes: Vec<String>,
        is_new_hashes: Vec<String>,
    ) -> PortableResult<PortableStateV3> {
        let parsed = legacy::parse_legacy_records(records)?;
        for (hash, raw) in &bindings {
            if !dto::valid_content_hash(hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：binding contentHash 必须是 64 位小写内容指纹",
                ));
            }
            serde_json::from_str::<serde_json::Value>(raw).map_err(|error| {
                PortableError::invalid_data(format!("invalid-data：设备绑定不是合法 JSON：{error}"))
            })?;
        }
        for hash in visible_hashes.iter().chain(is_new_hashes.iter()) {
            if !dto::valid_content_hash(hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：本机标记 contentHash 必须是 64 位小写内容指纹",
                ));
            }
        }

        let transaction = self.connection.unchecked_transaction()?;
        let local = load_state_at_connection(&transaction)?;
        let installation_id = ensure_installation_id(&transaction)?;
        let mut counter = load_counter(&transaction)?
            .max(super::merge::maximum_received_counter_from_state(&local)?);
        let incoming = legacy::build_import_state(
            &local,
            &parsed,
            &local.organization,
            &mut counter,
            &installation_id,
        )?;
        let merged = merge_portable_states(&local, &incoming)?;
        dto::validate_portable_state(&merged)?;
        counter = counter.max(super::merge::maximum_received_counter_from_state(&merged)?);
        let local_revisions = read_local_revisions(&transaction)?;
        for (book_hash, book) in &merged.books {
            let scoped: BTreeMap<String, u64> = local_revisions
                .iter()
                .filter_map(|(key, revision)| {
                    key.strip_prefix(&format!("{book_hash}:"))
                        .map(|suffix| (suffix.to_string(), *revision))
                })
                .collect();
            store_book_shape(&transaction, book_hash, book, &scoped)?;
        }
        for (hash, raw) in &bindings {
            transaction.execute(
                "INSERT INTO device_bindings(hash, json) VALUES(?1, ?2)
                 ON CONFLICT(hash) DO UPDATE SET json = excluded.json",
                params![hash, raw],
            )?;
        }
        if !visible_hashes.is_empty() {
            let mut visible = load_local_visible_hashes(&transaction)?;
            visible.extend(visible_hashes);
            save_local_visible_hashes(&transaction, &visible)?;
        }
        if !is_new_hashes.is_empty() {
            let mut is_new = load_local_is_new_hashes(&transaction)?;
            is_new.extend(is_new_hashes);
            save_local_is_new_hashes(&transaction, &is_new)?;
        }
        store_counter(&transaction, counter)?;
        transaction.commit()?;
        Ok(merged)
    }

    /// Local removal of a linked/managed row: drop binding and visibility while
    /// preserving the portable book and its tombstones for future sync.
    pub fn hide_linked_record(&mut self, content_hash: &str) -> PortableResult<()> {
        self.hide_linked_records(&[content_hash.to_string()])
    }

    pub fn hide_linked_records(&mut self, content_hashes: &[String]) -> PortableResult<()> {
        for hash in content_hashes {
            if !dto::valid_content_hash(hash) {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：contentHash 必须是 64 位小写内容指纹",
                ));
            }
        }
        let transaction = self.connection.unchecked_transaction()?;
        let mut visible = load_local_visible_hashes(&transaction)?;
        let mut is_new = load_local_is_new_hashes(&transaction)?;
        for hash in content_hashes {
            transaction.execute("DELETE FROM device_bindings WHERE hash = ?1", params![hash])?;
            visible.remove(hash);
            is_new.remove(hash);
        }
        save_local_visible_hashes(&transaction, &visible)?;
        save_local_is_new_hashes(&transaction, &is_new)?;
        transaction.commit()?;
        Ok(())
    }

    /// Atomically reserve a contiguous execution counter range for migration
    /// adapters. The returned stamp is the first reserved counter.
    pub fn reserve_stamps(&mut self, count: u64) -> PortableResult<Stamp> {
        if count == 0 {
            return Err(PortableError::invalid_data(
                "invalid-data：reserve_stamps count 必须为正",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let installation_id = ensure_installation_id(&transaction)?;
        let state = load_state_at_connection(&transaction)?;
        let counter = load_counter(&transaction)?;
        let base = counter.max(super::merge::maximum_received_counter_from_state(&state)?);
        let start = base
            .checked_add(1)
            .ok_or_else(|| PortableError::clock_exhausted("clock-exhausted：本机计数器已耗尽"))?;
        let end = start
            .checked_add(count - 1)
            .ok_or_else(|| PortableError::clock_exhausted("clock-exhausted：本机计数器已耗尽"))?;
        if end > dto::MAX_SAFE_COUNTER {
            return Err(PortableError::clock_exhausted(
                "clock-exhausted：本机计数器超出安全范围",
            ));
        }
        store_counter(&transaction, end)?;
        transaction.commit()?;
        Ok(Stamp {
            device_id: installation_id,
            counter: start,
        })
    }

    pub fn basis_entity(&self, basis_id: &str) -> PortableResult<EntityRef> {
        match self.bases.get(basis_id) {
            Some(StoredBasis::Progress(basis)) => Ok(basis.entity.clone()),
            Some(StoredBasis::Bookmark(basis)) => Ok(basis.entity.clone()),
            Some(StoredBasis::Note(basis)) => Ok(basis.entity.clone()),
            None => Err(PortableError::stale_basis("stale-basis")),
        }
    }

    pub fn apply_organization_command(
        &mut self,
        command: &OrganizationCommand,
    ) -> PortableResult<LibraryOrganization> {
        let transaction = self.connection.unchecked_transaction()?;
        let installation_id = ensure_installation_id(&transaction)?;
        let counter = load_counter(&transaction)?;
        let state = load_organization(&transaction)?;
        let mut known_hashes = std::collections::HashSet::new();
        {
            let mut statement = transaction.prepare("SELECT hash FROM book_meta")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                known_hashes.insert(row?);
            }
        }
        let envelope = OrganizationEnvelope {
            device_id: installation_id,
            counter,
            state,
        };
        let next = apply_command(&envelope, command, &known_hashes)
            .map_err(PortableError::invalid_data)?;
        store_organization(&transaction, &next.state)?;
        store_counter(&transaction, next.counter)?;
        transaction.commit()?;
        Ok(next.state)
    }

    pub fn merge_organization_state(
        &mut self,
        incoming: &LibraryOrganization,
    ) -> PortableResult<LibraryOrganization> {
        let transaction = self.connection.unchecked_transaction()?;
        let installation_id = ensure_installation_id(&transaction)?;
        let counter = load_counter(&transaction)?;
        let state = load_organization(&transaction)?;
        let envelope = OrganizationEnvelope {
            device_id: installation_id,
            counter,
            state,
        };
        let next = merge_into_envelope(&envelope, incoming)
            .map_err(PortableError::invalid_data)?;
        store_organization(&transaction, &next.state)?;
        store_counter(&transaction, next.counter)?;
        transaction.commit()?;
        Ok(next.state)
    }

    pub fn project_shelf(&self) -> PortableResult<ShelfProjection> {
        let state = self.snapshot()?;
        let mut books = Vec::with_capacity(state.books.len());
        for (book_hash, book) in &state.books {
            let progress_versions = super::merge::merge_versions(&[&book.progress.versions])?;
            let progress_display = progress_versions.last().cloned();
            let progress_conflict = progress_versions.len() > 1;
            let mut bookmarks = Vec::new();
            for (id, annotation) in &book.bookmarks {
                if annotation.deleted.is_some() {
                    continue;
                }
                let versions = super::merge::merge_versions(&[&annotation.versions])?;
                if let Some(display) = versions.last().cloned() {
                    bookmarks.push(AnnotationProjection {
                        id: id.clone(),
                        conflict: versions.len() > 1,
                        versions,
                        display,
                    });
                }
            }
            let mut notes = Vec::new();
            for (id, annotation) in &book.notes {
                if annotation.deleted.is_some() {
                    continue;
                }
                let versions = super::merge::merge_versions(&[&annotation.versions])?;
                if let Some(display) = versions.last().cloned() {
                    notes.push(AnnotationProjection {
                        id: id.clone(),
                        conflict: versions.len() > 1,
                        versions,
                        display,
                    });
                }
            }
            books.push(ShelfBookProjection {
                book_hash: book_hash.clone(),
                metadata: book.metadata.value.clone(),
                metadata_stamp: book.metadata.stamp.clone(),
                progress: ProgressProjection {
                    versions: progress_versions,
                    display: progress_display,
                    conflict: progress_conflict,
                },
                bookmarks,
                notes,
                favorite: is_favorite(&state.organization, book_hash),
                folder_id: effective_folder_id(&state.organization, book_hash).map(str::to_string),
            });
        }
        books.sort_by(|left, right| left.book_hash.cmp(&right.book_hash));
        Ok(ShelfProjection {
            books,
            organization: state.organization,
        })
    }

    pub fn migrate_legacy(&mut self, library_root: &Path) -> PortableResult<MigrationOutcome> {
        if self.migration_completed()? {
            return Ok(MigrationOutcome::AlreadyMigrated);
        }
        // All old-file I/O and conversion happen before the write transaction.
        let plan = legacy::build_migration_plan(library_root)?;
        dto::validate_portable_state(&plan.state)?;
        let transaction = self.connection.unchecked_transaction()?;
        if migration_marker(&transaction)?.is_some() || has_portable_rows(&transaction)? {
            return Err(PortableError::storage_error(
                "资料库已有数据，旧资料迁移未执行",
            ));
        }
        for (book_hash, book) in &plan.state.books {
            let mut revisions = BTreeMap::new();
            if let Some(version) = book.progress.versions.last() {
                revisions.insert("progress".to_string(), version.stamp.counter);
            }
            for (id, annotation) in &book.bookmarks {
                if let Some(version) = annotation.versions.last() {
                    revisions.insert(format!("bookmark:{id}"), version.stamp.counter);
                }
            }
            for (id, annotation) in &book.notes {
                if let Some(version) = annotation.versions.last() {
                    revisions.insert(format!("note:{id}"), version.stamp.counter);
                }
            }
            store_book_shape(&transaction, book_hash, book, &revisions)?;
        }
        for (content_hash, raw) in &plan.bindings {
            transaction.execute(
                "INSERT INTO device_bindings(hash, json) VALUES(?1, ?2)",
                params![content_hash, raw],
            )?;
        }
        store_organization(&transaction, &plan.state.organization)?;
        let migrated_visible: BTreeSet<String> = plan.state.books.keys().cloned().collect();
        save_local_visible_hashes(&transaction, &migrated_visible)?;
        put_meta_json(&transaction, KEY_INSTALLATION_ID, &plan.installation_id)?;
        store_counter(&transaction, plan.counter)?;
        put_meta_json(&transaction, KEY_MIGRATION, &legacy::completed_marker())?;
        remove_meta(&transaction, KEY_PREFERENCES)?;
        transaction.commit()?;
        Ok(MigrationOutcome::Migrated {
            books: plan.migrated_books,
            annotations: plan.migrated_annotations,
        })
    }
}

fn basis_revision_key(entity: &EntityRef) -> String {
    match entity {
        EntityRef::Progress { .. } => "progress".to_string(),
        EntityRef::Bookmark { id, .. } => format!("bookmark:{id}"),
        EntityRef::Note { id, .. } => format!("note:{id}"),
    }
}

impl PortableStore {
    fn insert_stored_basis(&mut self, basis: StoredBasis) -> String {
        let basis_id = self.new_handle("basis");
        self.bases.insert(basis_id.clone(), basis);
        basis_id
    }

    fn remove_bases_for_entity(&mut self, entity: &EntityRef) {
        let book_hash = entity.book_hash().to_string();
        let kind = entity.kind().to_string();
        let id = entity.annotation_id().map(str::to_string);
        self.bases.retain(|_, basis| {
            let candidate = match basis {
                StoredBasis::Progress(read_basis) => read_basis.entity.clone(),
                StoredBasis::Bookmark(read_basis) => read_basis.entity.clone(),
                StoredBasis::Note(read_basis) => read_basis.entity.clone(),
            };
            !(candidate.book_hash() == book_hash
                && candidate.kind() == kind
                && candidate.annotation_id().map(str::to_string) == id)
        });
    }

    pub fn read(&mut self, book_hash: &str) -> PortableResult<(String, Option<PortableBook>)> {
        if !dto::valid_content_hash(book_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：bookHash 必须是 64 位小写内容指纹",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let snapshot = load_read_snapshot(&transaction, book_hash)?;
        drop(transaction);
        let read_id = self.new_handle("read");
        let book = snapshot.book.clone();
        self.reads.insert(read_id.clone(), snapshot);
        Ok((read_id, book))
    }

    pub fn adopt(
        &mut self,
        read_id: &str,
        entity: EntityRef,
        selection: AdoptSelection,
    ) -> PortableResult<String> {
        let snapshot = self
            .reads
            .get(read_id)
            .cloned()
            .ok_or_else(|| PortableError::stale_basis("stale-basis：readId 已释放或不存在"))?;
        if snapshot.book_hash != entity.book_hash() {
            return Err(PortableError::invalid_entity(
                "invalid-entity：readId 与实体书不同",
            ));
        }
        if snapshot.book.is_none() {
            return Err(PortableError::invalid_entity(
                "invalid-entity：书籍不存在",
            ));
        }
        let revision_key = basis_revision_key(&entity);
        let local_revision = snapshot.revisions.get(&revision_key).copied().unwrap_or(0);
        let stored = match entity.clone() {
            EntityRef::Progress { .. } => {
                let current = snapshot
                    .book
                    .as_ref()
                    .map(|book| book.progress.versions.clone())
                    .unwrap_or_default();
                let basis = capture_read_basis(entity, &current, local_revision, selection)?;
                StoredBasis::Progress(basis)
            }
            EntityRef::Bookmark { id, .. } => {
                let current = snapshot
                    .book
                    .as_ref()
                    .and_then(|book| book.bookmarks.get(&id))
                    .map(|annotation| annotation.versions.clone())
                    .unwrap_or_default();
                let basis = capture_read_basis(entity, &current, local_revision, selection)?;
                StoredBasis::Bookmark(basis)
            }
            EntityRef::Note { id, .. } => {
                let current = snapshot
                    .book
                    .as_ref()
                    .and_then(|book| book.notes.get(&id))
                    .map(|annotation| annotation.versions.clone())
                    .unwrap_or_default();
                let basis = capture_read_basis(entity, &current, local_revision, selection)?;
                StoredBasis::Note(basis)
            }
        };
        Ok(self.insert_stored_basis(stored))
    }

    pub fn write_progress(
        &mut self,
        basis_id: &str,
        intent: WriteIntent,
        value: ProgressValue,
        updated_at_ms: u64,
    ) -> PortableResult<WriteOutcome<ProgressState>> {
        let basis = match self.bases.get(basis_id) {
            Some(StoredBasis::Progress(basis)) => basis.clone(),
            Some(_) => {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：本机基线不是进度实体",
                ))
            }
            None => return Err(PortableError::stale_basis("stale-basis")),
        };
        dto::validate_progress(&value)?;
        let book_hash = basis.entity.book_hash().to_string();
        let transaction = self.connection.unchecked_transaction()?;
        let _installation_id = ensure_installation_id(&transaction)?;
        if load_book_meta_row(&transaction, &book_hash)?.is_none() {
            return Err(PortableError::invalid_entity("invalid-entity：书籍不存在"));
        }
        let (current, local_revision) = load_progress_row(&transaction, &book_hash)?.unwrap_or((
            ProgressState {
                versions: Vec::new(),
            },
            0,
        ));
        let received = maximum_received_counter(&current.versions, &[], &[])?;
        let base = load_counter(&transaction)?
            .max(received)
            .max(basis.local_revision);
        let next_counter = next_local_counter(base, 0)?;
        let stamp = Stamp {
            device_id: _installation_id,
            counter: next_counter,
        };
        match prepare_observed_write(
            basis.entity.clone(),
            &current.versions,
            local_revision,
            &basis,
            intent,
            stamp.clone(),
            value,
            updated_at_ms,
        )? {
            PreparedWrite::Unchanged => Ok(WriteOutcome {
                status: WriteStatus::Unchanged,
                entity: basis.entity,
                state: current,
                next_basis_id: basis_id.to_string(),
            }),
            PreparedWrite::Write {
                versions,
                next_basis,
            } => {
                let state = ProgressState {
                    versions: versions.clone(),
                };
                save_progress_row(&transaction, &book_hash, &state, stamp.counter)?;
                store_counter(&transaction, stamp.counter)?;
                transaction.commit()?;
                self.bases.remove(basis_id);
                let next_basis_id = self.insert_stored_basis(StoredBasis::Progress(next_basis));
                Ok(WriteOutcome {
                    status: WriteStatus::Written,
                    entity: basis.entity,
                    state,
                    next_basis_id,
                })
            }
        }
    }

    fn write_annotation_impl<T, FLoad, FSave, FWrap>(
        &mut self,
        basis_id: &str,
        basis: ReadBasis<T>,
        intent: WriteIntent,
        value: T,
        updated_at_ms: u64,
        kind: &'static str,
        load: FLoad,
        save: FSave,
        wrap: FWrap,
    ) -> PortableResult<AnnotationWriteOutcome<T>>
    where
        T: Clone + PartialEq + Serialize,
        FLoad: Fn(&Connection, &str, &str) -> PortableResult<Option<Annotation<T>>>,
        FSave: Fn(&Connection, &str, &str, &Annotation<T>, u64) -> PortableResult<()>,
        FWrap: FnOnce(ReadBasis<T>) -> StoredBasis,
    {
        if basis.entity.kind() != kind {
            return Err(PortableError::invalid_entity(
                "invalid-entity：基线与注释类型不匹配",
            ));
        }
        let book_hash = basis.entity.book_hash().to_string();
        let id = basis
            .entity
            .annotation_id()
            .ok_or_else(|| PortableError::invalid_entity("invalid-entity：缺少注释 ID"))?
            .to_string();
        let transaction = self.connection.unchecked_transaction()?;
        let installation_id = ensure_installation_id(&transaction)?;
        let current = load(&transaction, &book_hash, &id)?
            .ok_or_else(|| PortableError::invalid_entity("invalid-entity：注释不存在"))?;
        if current.deleted.is_some() {
            return Err(PortableError::deleted_entity(
                "deleted-entity：已删除的注释不能继续编辑",
            ));
        }
        let local_revision = load_annotation_revision(&transaction, kind, &book_hash, &id)?;
        let received = maximum_received_counter(&current.versions, &[], &[])?;
        let base = load_counter(&transaction)?
            .max(received)
            .max(basis.local_revision);
        let next_counter = next_local_counter(base, 0)?;
        let stamp = Stamp {
            device_id: installation_id,
            counter: next_counter,
        };
        match prepare_observed_write(
            basis.entity.clone(),
            &current.versions,
            local_revision,
            &basis,
            intent,
            stamp.clone(),
            value,
            updated_at_ms,
        )? {
            PreparedWrite::Unchanged => Ok(AnnotationWriteOutcome {
                status: WriteStatus::Unchanged,
                entity: basis.entity,
                state: current,
                next_basis_id: basis_id.to_string(),
            }),
            PreparedWrite::Write {
                versions,
                next_basis,
            } => {
                let updated = Annotation {
                    versions,
                    deleted: None,
                };
                save(&transaction, &book_hash, &id, &updated, stamp.counter)?;
                store_counter(&transaction, stamp.counter)?;
                transaction.commit()?;
                self.bases.remove(basis_id);
                let next_basis_id = self.insert_stored_basis(wrap(next_basis));
                Ok(AnnotationWriteOutcome {
                    status: WriteStatus::Written,
                    entity: basis.entity,
                    state: updated,
                    next_basis_id,
                })
            }
        }
    }

    pub fn write_bookmark(
        &mut self,
        basis_id: &str,
        intent: WriteIntent,
        value: BookmarkValue,
        updated_at_ms: u64,
    ) -> PortableResult<AnnotationWriteOutcome<BookmarkValue>> {
        let basis = match self.bases.get(basis_id) {
            Some(StoredBasis::Bookmark(basis)) => basis.clone(),
            Some(_) => {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：本机基线不是书签实体",
                ))
            }
            None => return Err(PortableError::stale_basis("stale-basis")),
        };
        dto::validate_bookmark(&value)?;
        self.write_annotation_impl(
            basis_id,
            basis,
            intent,
            value,
            updated_at_ms,
            "bookmark",
            load_bookmark_row,
            save_bookmark_row,
            StoredBasis::Bookmark,
        )
    }

    pub fn write_note(
        &mut self,
        basis_id: &str,
        intent: WriteIntent,
        value: NoteValue,
        updated_at_ms: u64,
    ) -> PortableResult<AnnotationWriteOutcome<NoteValue>> {
        let basis = match self.bases.get(basis_id) {
            Some(StoredBasis::Note(basis)) => basis.clone(),
            Some(_) => {
                return Err(PortableError::invalid_entity(
                    "invalid-entity：本机基线不是笔记实体",
                ))
            }
            None => return Err(PortableError::stale_basis("stale-basis")),
        };
        dto::validate_note(&value)?;
        self.write_annotation_impl(
            basis_id,
            basis,
            intent,
            value,
            updated_at_ms,
            "note",
            load_note_row,
            save_note_row,
            StoredBasis::Note,
        )
    }

    fn create_annotation_impl<T, FLoad, FSave, FWrap>(
        &mut self,
        book_hash: &str,
        id: &str,
        value: T,
        updated_at_ms: u64,
        kind: &'static str,
        load: FLoad,
        save: FSave,
        wrap: FWrap,
    ) -> PortableResult<AnnotationWriteOutcome<T>>
    where
        T: Clone + PartialEq + Serialize,
        FLoad: Fn(&Connection, &str, &str) -> PortableResult<Option<Annotation<T>>>,
        FSave: Fn(&Connection, &str, &str, &Annotation<T>, u64) -> PortableResult<()>,
        FWrap: FnOnce(ReadBasis<T>) -> StoredBasis,
    {
        if !dto::valid_content_hash(book_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：bookHash 必须是 64 位小写内容指纹",
            ));
        }
        if !dto::valid_canonical_uuid(id) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：新注释 ID 必须是 UUID",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let installation_id = ensure_installation_id(&transaction)?;
        if load_book_meta_row(&transaction, book_hash)?.is_none() {
            return Err(PortableError::invalid_entity("invalid-entity：书籍不存在"));
        }
        if load(&transaction, book_hash, id)?.is_some() {
            return Err(PortableError::invalid_entity(
                "invalid-entity：该注释 ID 已被使用",
            ));
        }
        let next_counter = next_local_counter(load_counter(&transaction)?, 0)?;
        let stamp = Stamp {
            device_id: installation_id,
            counter: next_counter,
        };
        let versions = super::merge::write_observed(&[], &[], stamp.clone(), value, updated_at_ms)?;
        let written = versions
            .iter()
            .find(|version| version.stamp == stamp)
            .cloned()
            .ok_or_else(|| PortableError::invalid_data("invalid-data：无法分配注释事件"))?;
        let state = Annotation {
            versions,
            deleted: None,
        };
        save(&transaction, book_hash, id, &state, stamp.counter)?;
        store_counter(&transaction, stamp.counter)?;
        transaction.commit()?;
        let entity = match kind {
            "bookmark" => EntityRef::Bookmark {
                book_hash: book_hash.to_string(),
                id: id.to_string(),
            },
            _ => EntityRef::Note {
                book_hash: book_hash.to_string(),
                id: id.to_string(),
            },
        };
        let next_basis = ReadBasis {
            entity: entity.clone(),
            local_revision: stamp.counter,
            selection: BasisSelection::Chosen,
            observed: vec![written],
        };
        let next_basis_id = self.insert_stored_basis(wrap(next_basis));
        Ok(AnnotationWriteOutcome {
            status: WriteStatus::Written,
            entity,
            state,
            next_basis_id,
        })
    }

    pub fn create_bookmark(
        &mut self,
        book_hash: &str,
        id: &str,
        value: BookmarkValue,
        updated_at_ms: u64,
    ) -> PortableResult<AnnotationWriteOutcome<BookmarkValue>> {
        dto::validate_bookmark(&value)?;
        self.create_annotation_impl(
            book_hash,
            id,
            value,
            updated_at_ms,
            "bookmark",
            load_bookmark_row,
            save_bookmark_row,
            StoredBasis::Bookmark,
        )
    }

    pub fn create_note(
        &mut self,
        book_hash: &str,
        id: &str,
        value: NoteValue,
        updated_at_ms: u64,
    ) -> PortableResult<AnnotationWriteOutcome<NoteValue>> {
        dto::validate_note(&value)?;
        self.create_annotation_impl(
            book_hash,
            id,
            value,
            updated_at_ms,
            "note",
            load_note_row,
            save_note_row,
            StoredBasis::Note,
        )
    }

    fn delete_annotation_impl<T, FLoad, FSave>(
        &mut self,
        book_hash: &str,
        id: &str,
        _kind: &'static str,
        entity: EntityRef,
        load: FLoad,
        save: FSave,
    ) -> PortableResult<DeleteOutcome<T>>
    where
        T: DeserializeOwned + Serialize,
        FLoad: Fn(&Connection, &str, &str) -> PortableResult<Option<Annotation<T>>>,
        FSave: Fn(&Connection, &str, &str, &Annotation<T>, u64) -> PortableResult<()>,
    {
        if !dto::valid_content_hash(book_hash) {
            return Err(PortableError::invalid_entity(
                "invalid-entity：bookHash 必须是 64 位小写内容指纹",
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let installation_id = ensure_installation_id(&transaction)?;
        let current = load(&transaction, book_hash, id)?
            .ok_or_else(|| PortableError::invalid_entity("invalid-entity：注释不存在"))?;
        if current.deleted.is_some() {
            return Ok(DeleteOutcome {
                status: DeleteStatus::Unchanged,
                entity,
                state: current,
            });
        }
        let received = maximum_received_counter(&current.versions, &[], &[])?;
        let next_counter = next_local_counter(load_counter(&transaction)?.max(received), 0)?;
        let state = Annotation {
            versions: Vec::new(),
            deleted: Some(Stamp {
                device_id: installation_id,
                counter: next_counter,
            }),
        };
        save(&transaction, book_hash, id, &state, next_counter)?;
        store_counter(&transaction, next_counter)?;
        transaction.commit()?;
        self.remove_bases_for_entity(&entity);
        Ok(DeleteOutcome {
            status: DeleteStatus::Deleted,
            entity,
            state,
        })
    }

    pub fn delete_bookmark(
        &mut self,
        book_hash: &str,
        id: &str,
    ) -> PortableResult<DeleteOutcome<BookmarkValue>> {
        let entity = EntityRef::Bookmark {
            book_hash: book_hash.to_string(),
            id: id.to_string(),
        };
        self.delete_annotation_impl(
            book_hash,
            id,
            "bookmark",
            entity,
            load_bookmark_row,
            save_bookmark_row,
        )
    }

    pub fn delete_note(
        &mut self,
        book_hash: &str,
        id: &str,
    ) -> PortableResult<DeleteOutcome<NoteValue>> {
        let entity = EntityRef::Note {
            book_hash: book_hash.to_string(),
            id: id.to_string(),
        };
        self.delete_annotation_impl(book_hash, id, "note", entity, load_note_row, save_note_row)
    }

    pub fn release(&mut self, target: ReleaseTarget) -> PortableResult<()> {
        match target {
            ReleaseTarget::BasisId(basis_id) => {
                self.bases.remove(&basis_id);
            }
            ReleaseTarget::ReadId(read_id) => {
                self.reads.remove(&read_id);
            }
            ReleaseTarget::BookHash(book_hash) => {
                if !dto::valid_content_hash(&book_hash) {
                    return Err(PortableError::invalid_entity(
                        "invalid-entity：bookHash 不合法",
                    ));
                }
                self.reads
                    .retain(|_, snapshot| snapshot.book_hash != book_hash);
                self.bases.retain(|_, basis| {
                    let stored_hash = match basis {
                        StoredBasis::Progress(basis) => basis.entity.book_hash(),
                        StoredBasis::Bookmark(basis) => basis.entity.book_hash(),
                        StoredBasis::Note(basis) => basis.entity.book_hash(),
                    };
                    stored_hash != book_hash
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod file_import_tests {
    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const A: &str = "00000000-0000-4000-8000-000000000001";

    fn state_at(counter: u64) -> PortableStateV3 {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 3,
            "books": {
                HASH: {
                    "metadata": {
                        "value": {
                            "title": "书",
                            "creator": "作者",
                            "fileName": "book.epub",
                            "addedAtMs": 1000
                        },
                        "stamp": { "deviceId": A, "counter": 1 }
                    },
                    "progress": {
                        "versions": [{
                            "stamp": { "deviceId": A, "counter": counter },
                            "clock": { A: counter },
                            "value": {
                                "locator": {
                                    "locatorVersion": 1,
                                    "chapterPath": "Text/chapter.xhtml",
                                    "spineIndexHint": 0,
                                    "target": { "kind": "chapter-start" }
                                },
                                "progressPctHint": 10
                            },
                            "updatedAtMs": 1000 + counter
                        }]
                    },
                    "bookmarks": {},
                    "notes": {}
                }
            },
            "organization": { "schemaVersion": 1, "folders": {}, "books": {} }
        }))
        .unwrap()
    }

    #[test]
    fn file_import_uses_current_state_and_binding_failure_rolls_back_all_markers() {
        let mut store = PortableStore::open_in_memory().unwrap();
        store
            .merge_validated_import(state_at(1), Vec::new(), false)
            .unwrap();
        store
            .merge_validated_import(state_at(2), Vec::new(), false)
            .unwrap();
        let before = store.snapshot().unwrap();
        let visible_before = store.local_visible_hashes().unwrap();
        let is_new_before = store.local_is_new_hashes().unwrap();
        let counter_before = store.counter().unwrap();

        // Re-importing the older package must not move progress backwards.
        store
            .merge_validated_import(state_at(1), Vec::new(), false)
            .unwrap();
        let preserved = store.snapshot().unwrap();
        let versions = &preserved.books[HASH].progress.versions;
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].stamp.device_id, A);
        assert_eq!(versions[0].stamp.counter, 2);

        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_binding
                 BEFORE INSERT ON device_bindings
                 BEGIN
                     SELECT RAISE(ABORT, 'forced binding failure');
                 END;",
            )
            .unwrap();
        let incoming = state_at(3);
        let binding = serde_json::json!({
            "contentHash": HASH,
            "storageKind": "managed",
            "fileSize": 10,
            "sourceMtimeNs": 1,
            "coverMime": "image/jpeg",
            "lastVerifiedAtMs": 1
        })
        .to_string();
        let error = store
            .merge_validated_import(incoming, vec![(HASH.to_string(), binding)], false)
            .unwrap_err();
        assert_eq!(error.code, "storage-error");

        let after = store.snapshot().unwrap();
        assert_eq!(after, before);
        assert_eq!(store.local_visible_hashes().unwrap(), visible_before);
        assert_eq!(store.local_is_new_hashes().unwrap(), is_new_before);
        assert_eq!(store.counter().unwrap(), counter_before);
        assert!(store.binding_raw(HASH).unwrap().is_none());
    }
}

#[cfg(test)]
mod grouping_tests {
    use super::*;

    #[test]
    fn import_revision_grouping_keeps_full_scoped_annotation_ids() {
        let imported_hash = "a".repeat(64);
        let other_hash = "b".repeat(64);
        let mut revisions = BTreeMap::new();
        revisions.insert(format!("{imported_hash}:progress"), 7_u64);
        revisions.insert(format!("{imported_hash}:bookmark:id:with:colons"), 8_u64);
        revisions.insert(format!("{imported_hash}:note:note-1"), 9_u64);
        revisions.insert(format!("{other_hash}:progress"), 10_u64);
        let imported: BTreeSet<String> = std::iter::once(imported_hash.clone()).collect();

        let grouped = group_import_revisions(revisions, &imported).unwrap();
        let scoped = grouped.get(&imported_hash).unwrap();
        assert_eq!(scoped.get("progress"), Some(&7));
        assert_eq!(scoped.get("bookmark:id:with:colons"), Some(&8));
        assert_eq!(scoped.get("note:note-1"), Some(&9));
        assert!(!grouped.contains_key(&other_hash));
    }
}

#[cfg(test)]
mod runtime_handle_tests {
    use super::*;

    const HASH: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    #[test]
    fn opaque_handles_are_generation_scoped() {
        let mut first = PortableStore::open_in_memory().unwrap();
        let mut replacement = PortableStore::open_in_memory().unwrap();
        let (first_read, _) = first.read(HASH).unwrap();
        let (replacement_read, _) = replacement.read(HASH).unwrap();

        assert_ne!(first_read, replacement_read);
        assert!(first_read.starts_with(first.runtime_generation()));
        assert!(replacement_read.starts_with(replacement.runtime_generation()));

        // A late handle from the replaced store cannot address the new store.
        let error = replacement
            .adopt(
                &first_read,
                EntityRef::Progress { book_hash: HASH.to_string() },
                AdoptSelection::Empty,
            )
            .unwrap_err();
        assert_eq!(error.code, "stale-basis");
    }
}
