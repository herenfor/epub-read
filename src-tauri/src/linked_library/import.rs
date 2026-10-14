//! Device-local linked library import operations.

use super::*;

pub(super) fn import_busy_message() -> String {
    "busy: 托管书籍导入进行中".to_string()
}

/// Acquire the process-wide import activity token shared with directory
/// import.  A missing `DirectoryImportState` only happens in isolated unit
/// tests that do not build the full Tauri app; production always registers it.
pub(super) fn acquire_import_activity(
    app: &AppHandle,
    owner: String,
) -> Result<Option<ImportActivityGuard>, String> {
    match app.try_state::<DirectoryImportState>() {
        Some(state) => state.try_acquire_import_activity(owner).map(Some),
        None => Ok(None),
    }
}

/// Reject conflicting library mutations while a managed/path import or a
/// directory import is active. Callers already hold the library write lock,
/// giving the fixed order library write lock -> active import slot.
pub(super) fn ensure_import_idle(app: &AppHandle) -> Result<(), String> {
    let active = app.state::<ManagedImportState>();
    let slot = active
        .0
        .lock()
        .map_err(|_| "导入活动槽锁已损坏".to_string())?;
    if slot.is_some() {
        return Err(import_busy_message());
    }
    drop(slot);
    if let Some(directory_state) = app.try_state::<DirectoryImportState>() {
        if directory_state.import_activity_busy()? {
            return Err(import_busy_message());
        }
    }
    Ok(())
}

pub(super) fn reserve_import(
    app: &AppHandle,
    request_id: &str,
) -> Result<Arc<ImportJob>, NativeImportError> {
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
    let activity = acquire_import_activity(app, format!("managed-import:{request_id}"))
        .map_err(|_| NativeImportError::busy())?;
    let job = Arc::new(ImportJob {
        request_id: request_id.to_string(),
        gate: Arc::new(ImportGate::default()),
        _activity: activity,
    });
    *slot = Some(job.clone());
    Ok(job)
}

pub(super) fn validate_document_request(
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

pub(super) fn send_import_progress(
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

pub(super) fn cleanup_stale_staging(root: &Path) -> Result<(), String> {
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

pub(crate) fn new_staging_path(root: &Path) -> Result<PathBuf, String> {
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

/// Copies one single-use restricted reader into staging while hashing the
/// exact bytes that are written. The post-copy cancellation check is the
/// integration point that catches a cancel requested during the final read.
pub(crate) fn stream_restricted_reader_to_staging(
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

pub(super) fn import_display_name(provider: Option<&str>, selected: Option<&str>) -> String {
    provider
        .into_iter()
        .chain(selected)
        .find(|name| {
            portable_file_name(name)
                && !name.trim().is_empty()
                && !name.chars().any(char::is_control)
        })
        .unwrap_or("book.epub")
        .to_string()
}

pub(super) fn prepare_document_from_reader(
    reader: &mut RestrictedReader,
    gate: &ImportGate,
    input_index: usize,
    staging_path: &Path,
    file_name: Option<String>,
) -> Result<PreparedDocument, PrepareError> {
    let file_name = import_display_name(reader.display_name(), file_name.as_deref());
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
        file_name,
        metadata,
    })
}

#[cfg(target_os = "android")]
pub(super) fn prepare_document(
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

pub(crate) fn make_managed_binding(
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

pub(crate) fn make_managed_record(
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
pub(super) fn publish_prepared_documents(
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
            // Reimport can repair a historical missing display name. Do not
            // rename genuine names or replace any reading/annotation state.
            if let Some(record) = records.iter_mut().find(|record| {
                record.content_hash == document.content_hash && record.file_name == "book.epub"
            }) {
                if document.file_name != "book.epub" {
                    record.file_name = document.file_name.clone();
                    outcome.records_changed = true;
                }
            }
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

pub(super) fn persist_import_indexes_for_app(
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
pub(super) fn persist_import_indexes(
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

pub(super) fn build_no_commit_results(prepared: Vec<PreparedItem>) -> ImportBatchResult {
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

pub(super) fn build_committed_results(
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
pub(super) fn run_import_documents_blocking(
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
