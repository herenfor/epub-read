//! Device-local linked library commands operations.

use super::*;

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

#[tauri::command]
pub async fn linked_library_import_paths(
    app: AppHandle,
    paths: Vec<String>,
    copy_to_library: Option<bool>,
) -> Result<ImportBatchResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_paths_blocking(app, paths, copy_to_library))
        .await.map_err(|error| format!("书籍导入工作线程失败：{error}"))?
}

fn import_paths_blocking(
    app: AppHandle,
    paths: Vec<String>,
    copy_to_library: Option<bool>,
) -> Result<ImportBatchResult, String> {
    let state = app.state::<LinkedLibraryWriteState>();
    // A34: Windows imports copy into the library unless the user unticked it.
    let copy_to_library = copy_to_library.unwrap_or(false);
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    ensure_import_idle(&app)?;
    let _activity = acquire_import_activity(&app, "linked-library-import-paths".to_string())?;
    let root = library_root(&app)?;
    let mut records = load_records(&app)?;
    let mut bindings = load_bindings(&app)?;
    let thumbnails = load_thumbnail_index(&app)?;
    if copy_to_library {
        let total = paths.iter().filter_map(|path| fs::metadata(path).ok()).map(|meta| meta.len()).sum();
        ensure_library_space(&root, total)?;
    }
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
                if copy_to_library {
                    // A book already on the shelf keeps a working binding; only
                    // a new or broken one gets a library copy.
                    let keeps_binding = matches!(reveal_target(&root, &bindings, &hash), RevealTarget::File(_))
                        && records.iter().any(|record| record.content_hash == hash);
                    if !keeps_binding {
                        let original = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
                        let wanted = library_file_name(original, &metadata.title);
                        match copy_into_library(&root, &path, &hash, &wanted, &bindings) {
                            Ok((name, copied)) => {
                                upsert_binding(
                                    &mut bindings,
                                    make_managed_binding(hash.clone(), copied, &metadata).with_managed_file_name(name),
                                );
                                bindings_changed = true;
                            }
                            Err(error) => {
                                results.push(ImportItemResult {
                                    input_index,
                                    status: "failed".into(),
                                    content_hash: None,
                                    record: None,
                                    error: Some(error),
                                });
                                continue;
                            }
                        }
                    }
                } else {
                    let binding = make_binding(hash.clone(), &path, file_snapshot, &metadata);
                    upsert_binding(&mut bindings, binding);
                    bindings_changed = true;
                }
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
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    tauri::async_runtime::spawn_blocking(move || read_source_raw_blocking(app, content_hash))
        .await
        .map_err(|error| format!("源 EPUB 读取工作线程失败：{error}"))?
}

#[tauri::command]
pub async fn linked_library_read_cover_raw(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    tauri::async_runtime::spawn_blocking(move || read_cover_raw_blocking(app, content_hash))
        .await
        .map_err(|error| format!("封面读取工作线程失败：{error}"))?
}

#[tauri::command]
pub async fn linked_library_archive_open(
    app: AppHandle,
    window: tauri::Window,
    content_hash: String,
) -> Result<ArchiveOpenView, LinkedLibraryError> {
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
) -> Result<crate::native_zip_session::DirectoryPage, LinkedLibraryError> {
    let owner = window.label().to_string();
    let session = native_archive_session(&app, &owner, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .directory_page(start)
            .map_err(archive_fault_error)
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
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    let owner = window.label().to_string();
    let session = native_archive_session(&app, &owner, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .read_chunk(entry_index, offset)
            .map(tauri::ipc::Response::new)
            .map_err(archive_fault_error)
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

#[tauri::command]
pub fn linked_library_relink(
    app: AppHandle,
    state: State<'_, LinkedLibraryWriteState>,
    content_hash: String,
    source_path: String,
) -> Result<LinkedLibraryRecordView, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    let path = canonical_epub_path(&source_path)?;
    let (actual_hash, hashed_snapshot) = hash_source_file(&path)?;
    if !actual_hash.eq_ignore_ascii_case(&content_hash) {
        return Err(LinkedLibraryError::new("relink-mismatch", "选择的 EPUB 内容与目标书籍不一致，未重新绑定"));
    }
    let metadata = inspect_epub(&path)?;
    if metadata.spine.is_empty() {
        return Err("EPUB OPF 没有可阅读的 spine 条目".into());
    }
    let final_snapshot = snapshot(&path)?;
    if final_snapshot.size != hashed_snapshot.size
        || final_snapshot.mtime_ns != hashed_snapshot.mtime_ns
    {
        return Err(LinkedLibraryError::changed("源 EPUB 在解析期间发生了变化，请重新定位"));
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySettingsView {
    copy_on_import: bool,
    /// The effective managed-book directory; metadata stays in local app data.
    library_directory: String,
    custom_base_directory: Option<String>,
    available: bool,
    recovery_pending: bool,
    /// Settings corruption or an unavailable custom drive. The latter keeps
    /// the saved copy preference; the UI must not silently import as linked.
    error: Option<String>,
}

fn library_settings_view(app: &AppHandle) -> Result<LibrarySettingsView, LinkedLibraryError> {
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法取得应用本地数据目录：{error}"))?;
    let root = library_root(app)?;
    let pending = library_location::recovery_pending(&root);
    let default = root.join("books").to_string_lossy().into_owned();
    Ok(match load_library_settings(&local) {
        Ok(settings) => {
            let books = managed_books_directory(&root)?;
            let available = settings.custom_base_directory.is_none() || books.is_dir();
            LibrarySettingsView { copy_on_import: settings.copy_on_import,
                library_directory: books.to_string_lossy().into_owned(), custom_base_directory: settings.custom_base_directory,
                available, recovery_pending: pending,
                error: (!available).then(|| "自定义书库位置不可用，请重新连接书库".into()) }
        },
        Err(error) => LibrarySettingsView { copy_on_import: false, library_directory: default,
            custom_base_directory: None, available: false, recovery_pending: pending, error: Some(error) },
    })
}

#[tauri::command]
pub fn linked_library_settings_get(app: AppHandle) -> Result<LibrarySettingsView, LinkedLibraryError> {
    library_settings_view(&app)
}

#[tauri::command]
pub fn linked_library_settings_set_copy(app: AppHandle, enabled: bool) -> Result<LibrarySettingsView, LinkedLibraryError> {
    let writes = app.state::<LinkedLibraryWriteState>();
    let _guard = writes.0.try_lock().map_err(|_| LinkedLibraryError::new("busy", "书库任务进行中，请稍后再改设置"))?;
    ensure_import_idle(&app)?;
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法取得应用本地数据目录：{error}"))?;
    let mut settings = load_library_settings(&local)?;
    settings.copy_on_import = enabled;
    save_library_settings(&local, &settings)?;
    library_settings_view(&app)
}

/// Opens the library folder itself in File Explorer (created when empty).
#[tauri::command]
pub fn linked_library_open_folder(app: AppHandle) -> Result<(), LinkedLibraryError> {
    let books = writable_books_directory(&library_root(&app)?)?;
    tauri_plugin_opener::open_path(&books, None::<&str>).map_err(|error| format!("无法打开文件资源管理器：{error}"))?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealSourceResult {
    /// "revealed", or "missing" when the book's file is gone.
    status: &'static str,
}

/// Opens File Explorer with the book's file selected (Windows). Read-only:
/// no record, binding or sync state changes.
#[tauri::command]
pub async fn linked_library_reveal_source(
    app: AppHandle,
    content_hash: String,
) -> Result<RevealSourceResult, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let target = {
            let state = app.state::<LinkedLibraryWriteState>();
            let _guard = state
                .0
                .lock()
                .map_err(|_| "链接书库写入锁已损坏".to_string())?;
            let records = load_records(&app)?;
            if !records.iter().any(|record| record.content_hash == content_hash) {
                return Err(LinkedLibraryError::from("书库中没有这本书"));
            }
            reveal_target(&library_root(&app)?, &load_bindings(&app)?, &content_hash)
        };
        match target {
            RevealTarget::Missing => Ok(RevealSourceResult { status: "missing" }),
            RevealTarget::File(path) => {
                tauri_plugin_opener::reveal_item_in_dir(&path)
                    .map_err(|error| format!("无法打开文件资源管理器：{error}"))?;
                Ok(RevealSourceResult { status: "revealed" })
            }
        }
    })
    .await
    .map_err(|error| format!("文件资源管理器工作线程失败：{error}"))?
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

#[tauri::command]
pub async fn linked_library_merge_organization(
    app: AppHandle,
    incoming: LibraryOrganization,
) -> Result<LibraryOrganization, String> {
    tauri::async_runtime::spawn_blocking(move || merge_organization_command(&app, incoming))
        .await
        .map_err(|error| format!("合并收藏与文件夹任务失败：{error}"))?
}
