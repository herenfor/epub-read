//! The private shelf uses the same causal repository and bounded ZIP reader
//! as the public shelf, with no route into the public app managers.
use super::{run, PrivateShelfStatus, ShelfError};
use crate::{
    library_organization::OrganizationCommand,
    linked_library::{self, DeviceBinding},
    native_zip_session::{Fault, NativeZipSession, CHUNK_BYTES},
    portable_state::{
        AdoptSelection, BookmarkValue, EntityRef, NoteValue, PortableStore, ProgressValue,
        ReleaseTarget, WriteIntent,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Seek, SeekFrom},
    path::Path,
    sync::atomic::Ordering,
    time::Instant,
};
use tauri::WebviewWindow;

pub(super) struct Session {
    pub(super) id: String,
    pub(super) epoch: u64,
    store: PortableStore,
    archives: HashMap<String, NativeZipSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockReply {
    pub(super) status: PrivateShelfStatus,
    pub(super) session_id: String,
}

impl Session {
    pub(super) fn new(store: PortableStore) -> Result<Self, ShelfError> {
        Ok(Self {
            id: new_id()?,
            epoch: 0,
            store,
            archives: HashMap::new(),
        })
    }

    fn owns(&self, session_id: &str, epoch: u64) -> bool {
        self.epoch == epoch && self.id == session_id
    }

    fn archive(&self, archive_id: &str) -> Result<&NativeZipSession, ShelfError> {
        self.archives
            .get(archive_id)
            .ok_or_else(|| ShelfError::new("archive-closed", "隐私书架的归档会话已关闭"))
    }
}

fn new_id() -> Result<String, ShelfError> {
    crate::portable_state::random_uuid_v4().map_err(ShelfError::storage)
}

pub(super) fn locked() -> ShelfError {
    ShelfError::new("locked", "隐私书架已锁定或会话已失效")
}

fn archive_error(fault: Fault) -> ShelfError {
    ShelfError::new("archive-error", format!("隐私书籍归档读取失败：{fault:?}"))
}

fn encode<T: Serialize>(value: T) -> Result<Value, ShelfError> {
    serde_json::to_value(value).map_err(ShelfError::storage)
}

fn repository<T: Serialize>(
    value: crate::portable_state::PortableResult<T>,
) -> Result<Value, ShelfError> {
    encode(value.map_err(|err| ShelfError::new(err.code, err.message))?)
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LibraryOperation {
    List,
    Import {
        source: ImportSource,
    },
    Delete {
        book_hash: String,
    },
    Organize {
        command: OrganizationCommand,
    },
    Read {
        book_hash: String,
    },
    Adopt {
        read_id: String,
        entity: EntityRef,
        selection: AdoptSelection,
    },
    WriteProgress {
        basis_id: String,
        intent: WriteIntent,
        value: ProgressValue,
        updated_at_ms: u64,
    },
    CreateBookmark {
        book_hash: String,
        id: String,
        value: BookmarkValue,
        updated_at_ms: u64,
    },
    WriteBookmark {
        basis_id: String,
        intent: WriteIntent,
        value: BookmarkValue,
        updated_at_ms: u64,
    },
    DeleteBookmark {
        book_hash: String,
        id: String,
    },
    CreateNote {
        book_hash: String,
        id: String,
        value: NoteValue,
        updated_at_ms: u64,
    },
    WriteNote {
        basis_id: String,
        intent: WriteIntent,
        value: NoteValue,
        updated_at_ms: u64,
    },
    DeleteNote {
        book_hash: String,
        id: String,
    },
    ReleaseBasis {
        basis_id: String,
    },
    ReleaseRead {
        read_id: String,
    },
    ReleaseBook {
        book_hash: String,
    },
    ArchiveOpen {
        book_hash: String,
        text_encoding: Option<String>,
    },
    ArchiveDirectory {
        archive_id: String,
        start: usize,
    },
    ArchiveClose {
        archive_id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportSource {
    Path { path: String },
    Document { uri: String },
}

fn import_book(
    store: &mut PortableStore,
    source: ImportSource,
    root: &Path,
    window: &WebviewWindow,
    current: &dyn Fn() -> bool,
) -> Result<Value, ShelfError> {
    #[cfg(not(target_os = "android"))]
    let _ = window;
    #[cfg(target_os = "android")]
    let _staging;
    let (path, file_name, hash, before) = match source {
        ImportSource::Path { path } => {
            #[cfg(not(target_os = "android"))]
            {
                let path =
                    linked_library::canonical_epub_path(&path).map_err(ShelfError::storage)?;
                let metadata = root
                    .join(super::METADATA)
                    .canonicalize()
                    .map_err(ShelfError::storage)?;
                if path.starts_with(metadata) {
                    return Err(ShelfError::new(
                        "invalid-source",
                        "请选择隐私资料目录以外的原书",
                    ));
                }
                let file_name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| ShelfError::new("invalid-source", "无法取得文件名"))?
                    .to_owned();
                let (hash, before) =
                    linked_library::hash_file(&path).map_err(ShelfError::storage)?;
                (path, file_name, hash, before)
            }
            #[cfg(target_os = "android")]
            {
                let _ = path;
                return Err(ShelfError::new("invalid-source", "请通过系统选择器导入"));
            }
        }
        ImportSource::Document { uri } => {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let mut reader =
                    crate::android_uri_bridge::open_content_uri(window.app_handle(), &uri)
                        .map_err(ShelfError::storage)?;
                let file_name = reader
                    .display_name()
                    .ok_or_else(|| ShelfError::new("invalid-source", "无法取得文件名"))?
                    .to_owned();
                let sources = root.join("sources");
                std::fs::create_dir_all(&sources).map_err(ShelfError::storage)?;
                // The temporary directory owns partial bytes. It is separate
                // from both databases and is removed on failure or cancellation.
                let temporary = tempfile::tempdir_in(&sources).map_err(ShelfError::storage)?;
                let path = temporary.path().join("incoming.part");
                let file = linked_library::stream_restricted_reader_to_staging(
                    &mut reader,
                    &path,
                    &|| !current(),
                )
                .map_err(|_| {
                    if current() {
                        ShelfError::new("import-failed", "无法读取所选文件")
                    } else {
                        locked()
                    }
                })?;
                _staging = temporary;
                let before = linked_library::snapshot(&path).map_err(ShelfError::storage)?;
                (path, file_name, file.content_hash, before)
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = uri;
                return Err(ShelfError::new("invalid-source", "请传入本机文件路径"));
            }
        }
    };
    let meta =
        linked_library::epub_meta::inspect_book(&path, &file_name).map_err(ShelfError::storage)?;
    if linked_library::snapshot(&path).map_err(ShelfError::storage)? != before {
        return Err(ShelfError::new("source-changed", "源书在导入时发生了变化"));
    }
    if !current() {
        return Err(locked());
    }
    #[cfg(target_os = "android")]
    let path = {
        let target = root.join("sources").join(format!("{hash}.book"));
        if target.exists() {
            let (actual, _) = linked_library::hash_file(&target).map_err(ShelfError::storage)?;
            if actual != hash {
                return Err(ShelfError::new(
                    "source-changed",
                    "已有私密书籍副本的内容不一致",
                ));
            }
        } else {
            std::fs::rename(&path, &target).map_err(ShelfError::storage)?;
        }
        target
    };
    publish_import(store, &path, file_name, hash, &meta, current)
}

fn publish_import(
    store: &mut PortableStore,
    path: &Path,
    file_name: String,
    hash: String,
    meta: &linked_library::ImportedMetadata,
    current: &dyn Fn() -> bool,
) -> Result<Value, ShelfError> {
    let snapshot = linked_library::snapshot(path).map_err(ShelfError::storage)?;
    let binding = linked_library::make_binding(hash.clone(), path, snapshot, meta);
    let record = linked_library::make_managed_record(hash.clone(), file_name, meta);
    let duplicate = store
        .binding_raw(&hash)
        .map_err(ShelfError::storage)?
        .is_some();
    if !current() {
        return Err(locked());
    }
    store
        .publish_linked_imports(
            vec![encode(record)?],
            vec![(
                hash.clone(),
                serde_json::to_string(&binding).map_err(ShelfError::storage)?,
            )],
            vec![hash.clone()],
            if duplicate {
                Vec::new()
            } else {
                vec![hash.clone()]
            },
        )
        .map_err(ShelfError::storage)?;
    Ok(json!({ "bookHash": hash, "duplicate": duplicate }))
}

fn open_archive(
    session: &mut Session,
    hash: &str,
    encoding: Option<&str>,
    current: &dyn Fn() -> bool,
) -> Result<Value, ShelfError> {
    let raw = session
        .store
        .binding_raw(hash)
        .map_err(ShelfError::storage)?
        .ok_or_else(|| ShelfError::new("missing-source", "隐私书架没有此书的本机来源"))?;
    let binding: DeviceBinding = serde_json::from_str(&raw).map_err(ShelfError::storage)?;
    let source = binding
        .linked_path()
        .ok_or_else(|| ShelfError::new("missing-source", "隐私书籍没有有效来源"))?;
    let start = Instant::now();
    let mut file = File::open(source).map_err(ShelfError::storage)?;
    let (actual_hash, snapshot) =
        linked_library::hash_opened_file(&file).map_err(ShelfError::storage)?;
    if actual_hash != hash {
        return Err(ShelfError::new("source-changed", "私密原书内容已变化"));
    }
    if !current() {
        return Err(locked());
    }
    let verify_ms = start.elapsed().as_millis() as u64;
    file.seek(SeekFrom::Start(0)).map_err(ShelfError::storage)?;
    let stat = file.try_clone().map_err(ShelfError::storage)?;
    let guard = move || {
        if linked_library::snapshot_file(&stat).map_err(|_| Fault::Io)? == snapshot {
            Ok(())
        } else {
            Err(Fault::SourceChanged)
        }
    };
    let (read_id, book) = session.store.read(hash).map_err(ShelfError::storage)?;
    session
        .store
        .release(ReleaseTarget::ReadId(read_id))
        .map_err(ShelfError::storage)?;
    let book = book.ok_or_else(|| ShelfError::new("missing-source", "隐私书架中没有这本书"))?;
    if crate::document_formats::text(&book.metadata.value.file_name) {
        file = crate::document_formats::text_archive(file, encoding, &book.metadata.value.title)
            .map_err(ShelfError::storage)?;
    }
    let start = Instant::now();
    let archive = NativeZipSession::from_verified_file(file, guard).map_err(archive_error)?;
    if !current() {
        return Err(locked());
    }
    let id = new_id()?;
    let entry_count = archive.entry_count;
    session.archives.insert(id.clone(), archive);
    Ok(json!({
        "protocolVersion": 1, "sessionId": id, "entryCount": entry_count, "chunkBytes": CHUNK_BYTES,
        "verifyMs": verify_ms, "directoryMs": start.elapsed().as_millis() as u64
    }))
}

#[tauri::command]
pub async fn private_shelf_library(
    window: WebviewWindow,
    session_id: String,
    operation: LibraryOperation,
) -> Result<Value, ShelfError> {
    let epoch = super::main_state(&window)?
        .lock_epoch
        .load(Ordering::Acquire);
    let invoking_window = window.clone();
    run(window, move |shelf, root, state| {
        let current = || state.lock_epoch.load(Ordering::Acquire) == epoch;
        let session = shelf
            .unlocked
            .as_mut()
            .filter(|session| session.owns(&session_id, epoch) && current())
            .ok_or_else(locked)?;
        let store = &mut session.store;
        let result = match operation {
            LibraryOperation::List => repository(store.project_shelf()),
            LibraryOperation::Import { source } => {
                import_book(store, source, root, &invoking_window, &current)
            }
            LibraryOperation::Delete { book_hash } => {
                repository(store.hide_linked_record(&book_hash))
            }
            LibraryOperation::Organize { command } => {
                repository(store.apply_organization_command(&command))
            }
            LibraryOperation::Read { book_hash } => {
                let (read_id, book) = store.read(&book_hash).map_err(ShelfError::storage)?;
                Ok(json!({ "readId": read_id, "book": book }))
            }
            LibraryOperation::Adopt {
                read_id,
                entity,
                selection,
            } => {
                let basis_id = store
                    .adopt(&read_id, entity, selection)
                    .map_err(|err| ShelfError::new(err.code, err.message))?;
                Ok(json!({ "basisId": basis_id }))
            }
            LibraryOperation::WriteProgress {
                basis_id,
                intent,
                value,
                updated_at_ms,
            } => repository(store.write_progress(&basis_id, intent, value, updated_at_ms)),
            LibraryOperation::CreateBookmark {
                book_hash,
                id,
                value,
                updated_at_ms,
            } => repository(store.create_bookmark(&book_hash, &id, value, updated_at_ms)),
            LibraryOperation::WriteBookmark {
                basis_id,
                intent,
                value,
                updated_at_ms,
            } => repository(store.write_bookmark(&basis_id, intent, value, updated_at_ms)),
            LibraryOperation::DeleteBookmark { book_hash, id } => {
                repository(store.delete_bookmark(&book_hash, &id))
            }
            LibraryOperation::CreateNote {
                book_hash,
                id,
                value,
                updated_at_ms,
            } => repository(store.create_note(&book_hash, &id, value, updated_at_ms)),
            LibraryOperation::WriteNote {
                basis_id,
                intent,
                value,
                updated_at_ms,
            } => repository(store.write_note(&basis_id, intent, value, updated_at_ms)),
            LibraryOperation::DeleteNote { book_hash, id } => {
                repository(store.delete_note(&book_hash, &id))
            }
            LibraryOperation::ReleaseBasis { basis_id } => {
                repository(store.release(ReleaseTarget::BasisId(basis_id)))
            }
            LibraryOperation::ReleaseRead { read_id } => {
                repository(store.release(ReleaseTarget::ReadId(read_id)))
            }
            LibraryOperation::ReleaseBook { book_hash } => {
                repository(store.release(ReleaseTarget::BookHash(book_hash)))
            }
            LibraryOperation::ArchiveOpen {
                book_hash,
                text_encoding,
            } => open_archive(session, &book_hash, text_encoding.as_deref(), &current),
            LibraryOperation::ArchiveDirectory { archive_id, start } => encode(
                session
                    .archive(&archive_id)?
                    .directory_page(start)
                    .map_err(archive_error)?,
            ),
            LibraryOperation::ArchiveClose { archive_id } => {
                session.archives.remove(&archive_id);
                Ok(Value::Null)
            }
        };
        if !current() {
            return Err(locked());
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn private_shelf_archive_read(
    window: WebviewWindow,
    session_id: String,
    archive_id: String,
    entry_index: usize,
    offset: u64,
) -> Result<tauri::ipc::Response, ShelfError> {
    let epoch = super::main_state(&window)?
        .lock_epoch
        .load(Ordering::Acquire);
    run(window, move |shelf, _, state| {
        let current = || state.lock_epoch.load(Ordering::Acquire) == epoch;
        let session = shelf
            .unlocked
            .as_ref()
            .filter(|session| session.owns(&session_id, epoch) && current())
            .ok_or_else(locked)?;
        let bytes = session
            .archive(&archive_id)?
            .read_chunk(entry_index, offset)
            .map_err(archive_error)?;
        if !current() {
            return Err(locked());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[tauri::command]
pub async fn private_shelf_cover(
    window: WebviewWindow,
    session_id: String,
    book_hash: String,
) -> Result<tauri::ipc::Response, ShelfError> {
    let epoch = super::main_state(&window)?
        .lock_epoch
        .load(Ordering::Acquire);
    run(window, move |shelf, _, state| {
        let current = || state.lock_epoch.load(Ordering::Acquire) == epoch;
        let session = shelf
            .unlocked
            .as_ref()
            .filter(|session| session.owns(&session_id, epoch) && current())
            .ok_or_else(locked)?;
        let raw = session
            .store
            .binding_raw(&book_hash)
            .map_err(ShelfError::storage)?
            .ok_or_else(|| ShelfError::new("missing-source", "隐私书架没有此书的本机来源"))?;
        let binding: DeviceBinding = serde_json::from_str(&raw).map_err(ShelfError::storage)?;
        let bytes = binding.read_linked_cover().map_err(ShelfError::storage)?;
        if !current() {
            return Err(locked());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_import_and_archive_never_publish_to_normal_repository() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("private-shelf");
        let normal = PortableStore::open(&sandbox.path().join("normal.sqlite3")).unwrap();
        let path = sandbox.path().join("private.txt");
        std::fs::write(&path, "第一章 私密内容").unwrap();
        let (hash, _) = linked_library::hash_file(&path).unwrap();
        let meta = linked_library::epub_meta::inspect_book(&path, "private.txt").unwrap();
        let mut private = Session::new(super::super::open_store(&root).unwrap()).unwrap();
        let old_id = private.id.clone();
        assert!(private.owns(&old_id, 0));
        assert!(!private.owns(&old_id, 1));
        assert!(!private.owns("other", 0));

        assert_eq!(
            publish_import(
                &mut private.store,
                &path,
                "private.txt".into(),
                hash.clone(),
                &meta,
                &|| false
            )
            .unwrap_err()
            .code,
            "locked"
        );
        assert!(private.store.project_shelf().unwrap().books.is_empty());
        publish_import(
            &mut private.store,
            &path,
            "private.txt".into(),
            hash.clone(),
            &meta,
            &|| true,
        )
        .unwrap();
        assert_eq!(private.store.project_shelf().unwrap().books.len(), 1);
        assert!(normal.project_shelf().unwrap().books.is_empty());
        assert!(normal.binding_raw(&hash).unwrap().is_none());

        private
            .store
            .apply_organization_command(&OrganizationCommand::SetFavorite {
                content_hashes: vec![hash.clone()],
                value: true,
            })
            .unwrap();
        assert!(private.store.project_shelf().unwrap().books[0].favorite);
        let (read_id, book) = private.store.read(&hash).unwrap();
        let stamp = book
            .unwrap()
            .progress
            .versions
            .last()
            .unwrap()
            .stamp
            .clone();
        let basis = private
            .store
            .adopt(
                &read_id,
                EntityRef::Progress {
                    book_hash: hash.clone(),
                },
                AdoptSelection::Chosen { stamp },
            )
            .unwrap();
        let value: ProgressValue = serde_json::from_value(json!({
            "locator": {
                "locatorVersion": 0, "spineIndex": 0, "pageHint": 1,
                "anchorIndex": null, "anchorRatio": null, "anchorTextOffset": null, "anchorTextSnippet": null
            }, "progressPctHint": 10
        })).unwrap();
        private
            .store
            .write_progress(&basis, WriteIntent::Auto, value, 1)
            .unwrap();
        assert!(private.store.project_shelf().unwrap().books[0]
            .progress
            .display
            .is_some());
        assert!(normal.project_shelf().unwrap().books.is_empty());

        let opened = open_archive(&mut private, &hash, Some("utf-8"), &|| true).unwrap();
        let session_id = opened["sessionId"].as_str().unwrap();
        let archive = private.archive(session_id).unwrap();
        let page = archive.directory_page(0).unwrap();
        let entry = page
            .entries
            .iter()
            .find(|entry| entry.name == "__reader__/document.json")
            .unwrap();
        assert!(!archive.read_chunk(entry.entry_index, 0).unwrap().is_empty());
        private.archives.remove(session_id);
        assert!(private.archive(session_id).is_err());

        private.store.hide_linked_record(&hash).unwrap();
        assert!(private.store.project_shelf().unwrap().books.is_empty());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "第一章 私密内容");
        drop(private);
        let reopened = Session::new(super::super::open_store(&root).unwrap()).unwrap();
        assert!(!reopened.owns(&old_id, 0));
    }
}
