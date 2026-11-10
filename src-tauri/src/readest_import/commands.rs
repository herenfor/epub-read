use super::{source, state::*, *};
use crate::{
    native_zip_session::{NativeZipSession, CHUNK_BYTES},
    portable_state::{PortableStore, ProgressProjection, ReadestBookImport, ReadestImportOutcome},
    save_file::SaveFileLocation,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::{atomic::Ordering, Arc},
};
use tauri::{Manager, WebviewWindow};

fn main_window(window: &WebviewWindow) -> PortableResult<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(error("unavailable", "请在主窗口迁入 Readest 资料"))
    }
}
pub(crate) fn scoped<T>(
    window: &WebviewWindow,
    scope: &ImportScope,
    work: impl FnOnce(&mut PortableStore, &dyn Fn() -> bool) -> PortableResult<T>,
) -> PortableResult<T> {
    match scope {
        ImportScope::Public => {
            crate::portable_state_commands::with_existing_store(window.app_handle(), |store| {
                work(store, &|| true)
            })?
            .ok_or_else(|| error("repository-unavailable", "请先完成书架资料加载"))
        }
        ImportScope::Private { session_id } => {
            crate::private_shelf::operations::with_import_store(window, session_id, work)
        }
    }
}
pub(super) fn session(window: &WebviewWindow, id: &str) -> PortableResult<Arc<Session>> {
    main_window(window)?;
    let session = window.state::<ReadestImportState>().get(id)?;
    session.check()?;
    scoped(window, &session.scope, |_, current| {
        if current() {
            Ok(())
        } else {
            Err(error("locked", "书架已锁定"))
        }
    })?;
    Ok(session)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupInfo {
    session_id: String,
    chunk_bytes: usize,
    library: JsonEntry,
    /// "zip" or "folder".
    kind: &'static str,
    /// Readest books whose original file is in the source.
    books: Vec<BookFileInfo>,
}

fn book_list(session: &Session) -> PortableResult<Vec<BookFileInfo>> {
    Ok(session
        .data
        .lock()
        .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
        .books
        .iter()
        .map(|(hash, book)| BookFileInfo {
            readest_hash: hash.clone(),
            file_name: book.name.clone(),
            bytes: book.bytes,
        })
        .collect())
}

/// Readest's library folder: same catalogue as a backup, read from disk.
pub(super) fn catalog_folder(session: &Session, books_dir: &std::path::Path) -> PortableResult<JsonEntry> {
    let scan = folder::scan(books_dir, &|| session.check())?;
    if scan.library_bytes > LIBRARY_LIMIT {
        return Err(error("too-large", "备份书目超出读取上限"));
    }
    let mut paths = std::collections::BTreeMap::new();
    paths.insert(0, scan.library.clone());
    {
        let mut data = session
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
        for (offset, (hash, path, bytes)) in scan.configs.into_iter().enumerate() {
            let descriptor = JsonEntry {
                entry_index: offset + 1,
                bytes,
            };
            paths.insert(descriptor.entry_index, path);
            data.entries
                .insert(descriptor.entry_index, (descriptor.clone(), Some(hash.clone())));
            data.configs.insert(hash, descriptor);
        }
        data.books = scan.books.into_iter().collect();
    }
    // Held now, so the size reported below is exactly what gets served.
    let held = session.hold(0, &scan.library, false)?;
    let library = JsonEntry {
        entry_index: 0,
        bytes: held.len() as u64,
    };
    let mut data = session
        .data
        .lock()
        .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
    data.entries.insert(0, (library.clone(), None));
    data.library = Some(library.clone());
    session.check()?;
    data.archive = Some(Origin::Folder(Arc::new(paths)));
    Ok(library)
}

pub(super) fn catalog(
    session: &Session,
    archive: Arc<NativeZipSession>,
) -> PortableResult<JsonEntry> {
    let mut data = session
        .data
        .lock()
        .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
    let mut offset = 0;
    let mut own_format = false;
    loop {
        session.check()?;
        let page = archive.directory_page(offset).map_err(fault)?;
        for entry in page.entries {
            own_format |= entry.name == "manifest.json" || entry.name == "state.json";
            let config_hash = entry
                .name
                .strip_suffix("/config.json")
                .filter(|hash| valid_hash(hash));
            if entry.name == "library.json" || config_hash.is_some() {
                let descriptor = JsonEntry {
                    entry_index: entry.entry_index,
                    bytes: entry.expanded_bytes,
                };
                if entry.name == "library.json" {
                    if descriptor.bytes > LIBRARY_LIMIT {
                        return Err(error("too-large", "备份书目超出读取上限"));
                    }
                    if data.library.replace(descriptor.clone()).is_some() {
                        return Err(error("invalid-backup", "备份书目条目重复"));
                    }
                } else if data
                    .configs
                    .insert(config_hash.unwrap().into(), descriptor.clone())
                    .is_some()
                {
                    return Err(error("invalid-backup", "备份配置条目重复"));
                }
                data.entries.insert(
                    descriptor.entry_index,
                    (descriptor, config_hash.map(str::to_owned)),
                );
            } else if let Some((hash, file)) = entry.name.split_once('/') {
                // `<hash>/<title>.<ext>`: the book itself. Deeper paths are audiobooks.
                if valid_hash(hash)
                    && !file.contains('/')
                    && folder::book_file_name(file)
                    && data.books.get(hash).is_none_or(|kept| file < kept.name.as_str())
                {
                    data.books.insert(
                        hash.to_owned(),
                        BookFile {
                            name: file.to_owned(),
                            bytes: entry.expanded_bytes,
                            at: BookAt::Zip(entry.entry_index),
                        },
                    );
                }
            }
        }
        match page.next {
            Some(next) => offset = next,
            None => break,
        }
    }
    if own_format {
        return Err(error("not-readest", "请使用本应用原有存档导入流程"));
    }
    let library = data
        .library
        .clone()
        .ok_or_else(|| error("not-readest", "未找到 Readest 备份书目"))?;
    session.check()?;
    data.archive = Some(Origin::Zip(archive));
    Ok(library)
}

#[tauri::command]
pub async fn readest_backup_open(
    window: WebviewWindow,
    session_id: String,
    source: SaveFileLocation,
    scope: ImportScope,
) -> PortableResult<BackupInfo> {
    main_window(&window)?;
    let active = window
        .state::<ReadestImportState>()
        .reserve(session_id, scope)?;
    let reserved = active.clone();
    let owner = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        scoped(&owner, &reserved.scope, |_, _| Ok(()))?;
        reserved.check()?;
        books::sweep(owner.app_handle());
        let picked_folder = match &source {
            SaveFileLocation::Path { path } if std::path::Path::new(path).is_dir() => {
                Some(std::path::PathBuf::from(path))
            }
            _ => None,
        };
        let (kind, library) = match picked_folder {
            Some(picked) => {
                let books_dir = folder::locate(&picked)
                    .ok_or_else(|| error("not-readest", "这个文件夹里没有 Readest 书库"))?;
                ("folder", catalog_folder(&reserved, &books_dir)?)
            }
            None => (
                "zip",
                catalog(&reserved, Arc::new(source::backup(owner.app_handle(), source)?))?,
            ),
        };
        scoped(&owner, &reserved.scope, |_, current| {
            if current() {
                Ok(())
            } else {
                Err(error("locked", "书架已锁定"))
            }
        })?;
        reserved.check()?;
        Ok(BackupInfo {
            session_id: reserved.id.clone(),
            chunk_bytes: CHUNK_BYTES,
            library,
            kind,
            books: book_list(&reserved)?,
        })
    })
    .await
    .unwrap_or_else(|_| Err(error("storage-error", "备份读取任务中断")));
    if result.is_err() {
        let _ = window.state::<ReadestImportState>().close(&active.id);
    }
    result
}

#[tauri::command]
pub async fn readest_backup_config(
    window: WebviewWindow,
    session_id: String,
    readest_hash: String,
) -> PortableResult<Option<JsonEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_hash(&readest_hash) {
            return Err(error("invalid-request", "Readest 指纹格式无效"));
        }
        let session = session(&window, &session_id)?;
        let entry = session.config_entry(&readest_hash)?;
        if entry.as_ref().is_some_and(|e| e.bytes > CONFIG_LIMIT) {
            return Err(error("too-large", "单书配置超出读取上限"));
        }
        Ok(entry)
    })
    .await
    .map_err(|_| error("storage-error", "备份读取任务中断"))?
}

#[tauri::command]
pub async fn readest_backup_read(
    window: WebviewWindow,
    session_id: String,
    entry_index: usize,
    offset: u64,
) -> PortableResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = session(&window, &session_id)?;
        let bytes = session.read_json(entry_index, offset)?;
        scoped(&window, &session.scope, |_, current| {
            if current() {
                Ok(())
            } else {
                Err(error("locked", "书架已锁定"))
            }
        })?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|_| error("storage-error", "备份读取任务中断"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetCandidate {
    book_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    partial_md5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<ProgressProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[tauri::command]
pub async fn readest_import_targets(
    window: WebviewWindow,
    session_id: String,
    book_hashes: Vec<String>,
) -> PortableResult<Vec<TargetCandidate>> {
    tauri::async_runtime::spawn_blocking(move || {
        if book_hashes.len() > 128 {
            return Err(error("too-large", "每批最多查询128本书"));
        }
        let session = session(&window, &session_id)?;
        let app = window.app_handle();
        let _lease = crate::linked_library::source_lease(app)
            .map_err(|_| error("busy", "书库位置正在调整"))?;
        let mut rows = Vec::new();
        for hash in book_hashes {
            session.check()?;
            let target = scoped(&window, &session.scope, |store, _| {
                store.readest_target(&hash)
            });
            let result = target.and_then(|target| {
                let md5 = source::candidate(app, &target.binding, &|| {
                    session.cancelled.load(Ordering::Acquire)
                })?;
                scoped(&window, &session.scope, |store, _| {
                    let current = store.readest_target(&hash)?;
                    if current.binding != target.binding
                        || current.metadata_stamp != target.metadata_stamp
                        || current.generation != target.generation
                    {
                        return Err(error("stale-basis", "本机书籍已变化，请重新预览"));
                    }
                    Ok(())
                })?;
                session.check()?;
                let token = crate::portable_state::random_uuid_v4()
                    .map_err(|_| error("storage-error", "无法生成匹配令牌"))?;
                let row = TargetCandidate {
                    book_hash: hash.clone(),
                    partial_md5: Some(md5.clone()),
                    target_token: Some(token.clone()),
                    progress: Some(target.progress.clone()),
                    error_code: None,
                };
                session
                    .data
                    .lock()
                    .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
                    .targets
                    .insert(hash.clone(), StoredTarget { token, target, partial_md5: md5 });
                Ok(row)
            });
            match result {
                Ok(row) => rows.push(row),
                Err(e) if e.code == "cancelled" || e.code == "locked" => return Err(e),
                Err(e) => {
                    session
                        .data
                        .lock()
                        .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
                        .targets
                        .remove(&hash);
                    rows.push(TargetCandidate {
                        book_hash: hash,
                        partial_md5: None,
                        target_token: None,
                        progress: None,
                        error_code: Some(e.code),
                    });
                }
            }
        }
        scoped(&window, &session.scope, |_, current| {
            if current() {
                Ok(())
            } else {
                Err(error("locked", "书架已锁定"))
            }
        })?;
        session.check()?;
        Ok(rows)
    })
    .await
    .map_err(|_| error("storage-error", "书籍匹配任务中断"))?
}

#[tauri::command]
pub async fn readest_import_commit(
    window: WebviewWindow,
    session_id: String,
    books: Vec<ReadestBookImport>,
    staged_hashes: Option<Vec<String>>,
) -> PortableResult<ReadestImportOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        if (books.is_empty() && staged_hashes.as_ref().is_none_or(Vec::is_empty)) || books.len() > 10000 {
            return Err(error("too-large", "迁入批次超出限制"));
        }
        let session = session(&window, &session_id)?;
        let staged_hashes = staged_hashes.unwrap_or_default();
        if staged_hashes.len() > 10000 { return Err(error("too-large", "迁入书籍过多")); }
        let prepared = {
            let data = session.data.lock().map_err(|_| error("storage-error", "会话锁不可用"))?;
            let mut unique = BTreeSet::new();
            staged_hashes.iter().map(|h| {
                if !unique.insert(h) { return Err(error("invalid-request", "重复的来源书籍")); }
                data.prepared.get(h).cloned().ok_or_else(|| error("not-ready", "原书尚未校验"))
            }).collect::<PortableResult<Vec<_>>>()?
        };
        let plan = {
            let data = session
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            let mut seen = BTreeSet::new();
            let mut plan = Vec::new();
            for book in books {
                let folder_only = book.folder_path.is_some() && book.progress.is_none()
                    && book.bookmarks.is_empty() && book.notes.is_empty();
                if !seen.insert(book.book_hash.clone())
                    || (!folder_only && !data.configs_read.contains(&book.readest_hash))
                {
                    return Err(error("invalid-request", "请先读取所选书籍的备份配置"));
                }
                let target = matched_target(&data, &book)?;
                if data.prepared.values().any(|p| p.hash == book.book_hash)
                    && !prepared.iter().any(|p| p.hash == book.book_hash) {
                    return Err(error("invalid-request", "未选择迁入这本原书"));
                }
                plan.push((target.clone(), book));
            }
            plan
        };
        let app = window.app_handle();
        let _lease = crate::linked_library::source_lease(app)
            .map_err(|_| error("busy", "书库位置正在调整"))?;
        let cancelled = || session.cancelled.load(Ordering::Acquire);
        // Only selected books incur whole-source verification. Matching all
        // shelf candidates above reads at most 12 KiB per source.
        let mut guards = plan
            .iter()
            .map(|(target, book)| {
                let binding = prepared.iter().find(|p| p.hash == book.book_hash)
                    .map(|p| if p.existing && !p.needs_copy { p.target.binding.as_str() } else { p.source_binding.as_str() }).unwrap_or(&target.binding);
                source::verify(app, binding, &book.book_hash, &cancelled)
            })
            .collect::<PortableResult<Vec<_>>>()?;
        for original in &prepared {
            if !plan.iter().any(|(_, b)| b.book_hash == original.hash) {
                let binding = if original.existing && !original.needs_copy { &original.target.binding } else { &original.source_binding };
                guards.push(source::verify(app, binding, &original.hash, &cancelled)?);
            }
        }
        // Hold the same short publication lock as other library writers; network/JS preparation is complete.
        let lock = app.state::<crate::linked_library::LinkedLibraryWriteState>();
        let _write = lock.0.lock().map_err(|_| error("storage-error", "书库写入锁不可用"))?;
        let mut publication = super::intake::Publication::new();
        let originals = publication.originals(app, &prepared, &|| session.check())?;
        scoped(&window, &session.scope, |store, current| {
            let visible = store.local_visible_hashes()?;
            for original in &prepared {
                if original.target.generation != store.runtime_generation()
                    || (original.existing && (!visible.contains(&original.hash)
                        || store.binding_raw(&original.hash)?.as_ref() != Some(&original.target.binding))) {
                    return Err(error("stale-basis", "书籍或书架已变化，请重新迁入"));
                }
            }
            let mut outcome = store.import_readest_bundle(&plan, &originals, now_ms(), &cancelled, |transaction, fresh| {
                session.finish(transaction, current, &guards)?;
                publication.accept(fresh);
                Ok(())
            })?;
            outcome.books_already = prepared.len().saturating_sub(outcome.books_added);
            Ok(outcome)
        })
    })
    .await
    .map_err(|_| error("storage-error", "迁入提交任务中断"))?
}

#[derive(Serialize)]
pub(crate) struct CloseReply {
    status: &'static str,
}
#[tauri::command]
pub async fn readest_backup_close(
    window: WebviewWindow,
    session_id: String,
) -> PortableResult<CloseReply> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(CloseReply {
            status: window.state::<ReadestImportState>().close(&session_id)?,
        })
    })
    .await
    .map_err(|_| error("storage-error", "关闭迁入会话失败"))?
}
