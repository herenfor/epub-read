//! Device-local linked library archive operations.

use super::*;
use super::archive_stamp::{read_receipt, receipt_path, ArchiveStamp};

pub(super) fn kindle_open_error(failure: crate::document_formats::kindle::Failure) -> LinkedLibraryError {
    LinkedLibraryError::new(
        failure.code(),
        format!("MOBI/AZW3：{}", failure.detail()),
    )
}

pub(super) fn archive_fault_error(fault: Fault) -> LinkedLibraryError {
    match fault {
        Fault::Closed => "原生归档会话已关闭".into(),
        Fault::InvalidRequest => "原生归档请求无效".into(),
        Fault::InvalidArchive => "EPUB 归档结构无效".into(),
        Fault::CorruptEntry => "EPUB 资源校验失败".into(),
        Fault::SourceChanged => LinkedLibraryError::changed("源 EPUB 在读取期间发生了变化；请重新导入或重新定位"),
        Fault::DirectoryTooLarge => "EPUB 归档目录条目过大".into(),
        Fault::Io => "读取源 EPUB 失败".into(),
    }
}

pub(super) fn native_archive_session(
    app: &AppHandle,
    owner: &str,
    session_id: &str,
) -> Result<Arc<NativeZipSession>, String> {
    let state = app.state::<NativeArchiveState>();
    let sessions = state
        .0
        .lock()
        .map_err(|_| "原生归档会话表已损坏".to_string())?;
    let entry = sessions
        .get(session_id)
        .ok_or_else(|| "原生归档会话不存在或已关闭".to_string())?;
    if entry.owner != owner {
        return Err("原生归档会话不属于当前窗口".to_string());
    }
    Ok(Arc::clone(&entry.session))
}

pub(crate) fn archive_open_blocking(
    app: AppHandle,
    owner: String,
    content_hash: String,
    text_encoding: Option<String>,
) -> Result<ArchiveOpenView, LinkedLibraryError> {
    let _location_read = library_location::source_lease(&app)?;
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    #[cfg(target_os = "android")]
    if let Some((binding, record)) = find_document_binding(&app, &content_hash)? {
        let (session, verify_ms, directory_ms) = document_source::document_archive(
            &app, binding.document_uri().unwrap(), &content_hash, &record.file_name, &record.title,
            text_encoding.as_deref(),
        )?;
        // Recheck owner/binding after the blocking read; a removed or relinked
        // record must not publish a late session.
        if !find_document_binding(&app, &content_hash)?.is_some_and(|(current, _)| current == binding) {
            return Err(LinkedLibraryError::changed("原书绑定已变化"));
        }
        return register_archive(&app, owner, session, verify_ms, directory_ms, true);
    }

    let (root, pending) = prepare_library_source_read(&app, &content_hash)?;
    let PendingSourceRead {
        file_name,
        title,
        identity,
        old_snapshot,
        mut file,
    } = pending;
    let verify_started = std::time::Instant::now();
    // Only the default app-owned book directory qualifies. User-controlled
    // paths and custom locations retain whole-source verification.
    let managed_comic = identity.storage_kind == StorageKind::Managed
        && identity.path.starts_with(root.join("books"))
        && matches!(crate::document_formats::extension(&file_name).to_ascii_lowercase().as_str(), "zip" | "cbz");
    let receipt = receipt_path(&root, &content_hash);
    let stamp = if managed_comic { ArchiveStamp::read(&file) } else { None };
    let hit = stamp.as_ref().is_some_and(|stamp| read_receipt(&receipt).as_ref() == Some(stamp));
    let verified_snapshot = if hit {
        snapshot_file(&file)?
    } else {
        let (actual_hash, verified_snapshot) = hash_opened_file(&file)?;
        if !actual_hash.eq_ignore_ascii_case(&content_hash) {
            return Err(LinkedLibraryError::changed("源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容"));
        }
        verified_snapshot
    };
    if stamp.as_ref().is_some_and(|stamp| ArchiveStamp::read(&file).as_ref() != Some(stamp)) {
        return Err(archive_fault_error(Fault::SourceChanged));
    }
    let verify_ms = verify_started.elapsed().as_millis() as u64;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("无法重新定位源 EPUB：{error}"))?;
    let stat_file = file
        .try_clone()
        .map_err(|error| format!("无法复制源 EPUB 句柄：{error}"))?;
    let expected_snapshot = verified_snapshot.clone();
    let guard_stamp = stamp.clone();
    let guard = move || {
        let current = snapshot_file(&stat_file).map_err(|_| Fault::Io)?;
        if current == expected_snapshot && guard_stamp.as_ref().is_none_or(|stamp| ArchiveStamp::read(&stat_file).as_ref() == Some(stamp)) {
            Ok(())
        } else {
            Err(Fault::SourceChanged)
        }
    };

    if crate::document_formats::kindle(&file_name) {
        guard().map_err(archive_fault_error)?;
        let temp_root = kindle_temp_root(&app)?;
        let reading = crate::document_formats::kindle::reading_archive_file(file, &temp_root)
            .map_err(kindle_open_error)?;
        guard().map_err(archive_fault_error)?;
        let directory_started = std::time::Instant::now();
        let session = NativeZipSession::from_verified_reader(reading, guard)
            .map_err(archive_fault_error)?;
        let directory_ms = directory_started.elapsed().as_millis() as u64;
        finalize_library_source_read(&app, &root, &identity, &old_snapshot, &verified_snapshot)?;
        return register_archive(&app, owner, session, verify_ms, directory_ms, false);
    }
    if crate::document_formats::virtual_archive(&file_name) {
        guard().map_err(archive_fault_error)?;
        file = crate::document_formats::reading_archive(file, &file_name, text_encoding.as_deref(), &title)?;
        guard().map_err(archive_fault_error)?;
    }
    let directory_started = std::time::Instant::now();
    let index = stamp.as_ref().map(|_| (receipt.with_extension("zip-index-v1"), hit));
    let session = NativeZipSession::from_verified_file_indexed(file, guard, index).map_err(archive_fault_error)?;
    let directory_ms = directory_started.elapsed().as_millis() as u64;
    let entry_count = session.entry_count;
    finalize_library_source_read(&app, &root, &identity, &old_snapshot, &verified_snapshot)?;

    if !hit {
        if let Some(stamp) = stamp {
            let _ = atomic_write_json(&receipt, &stamp);
        }
    }

    register_archive(&app, owner, session, verify_ms, directory_ms, managed_comic && entry_count >= 2048)
}

pub(crate) fn register_archive(
    app: &AppHandle, owner: String, session: NativeZipSession,
    verify_ms: u64, directory_ms: u64, compact_directory: bool,
) -> Result<ArchiveOpenView, LinkedLibraryError> {
    let entry_count = session.entry_count;
    if app.get_webview_window(&owner).is_none() {
        session.close();
        return Err("打开原生归档的窗口已关闭".into());
    }

    let session_id = random_uuid_v4()?;
    {
        let state = app.state::<NativeArchiveState>();
        let mut sessions = state
            .0
            .lock()
            .map_err(|_| "原生归档会话表已损坏".to_string())?;
        sessions.insert(
            session_id.clone(),
            NativeArchiveSession {
                owner,
                session: Arc::new(session),
            },
        );
    }
    Ok(ArchiveOpenView {
        protocol_version: 1,
        session_id,
        entry_count,
        chunk_bytes: CHUNK_BYTES,
        verify_ms,
        directory_ms,
        compact_directory: compact_directory && entry_count >= 2048,
    })
}

pub(crate) fn close_native_archive_window(app: &AppHandle, owner: &str) {
    let removed = {
        let state = app.state::<NativeArchiveState>();
        let Ok(mut sessions) = state.0.lock() else {
            return;
        };
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| sessions.remove(&id))
            .collect::<Vec<_>>()
    };
    for entry in removed {
        entry.session.close();
    }
}

pub(crate) fn close_all_native_archives(app: &AppHandle) {
    let removed = {
        let state = app.state::<NativeArchiveState>();
        let Ok(mut sessions) = state.0.lock() else {
            return;
        };
        sessions.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
    };
    for entry in removed {
        entry.session.close();
    }
}

/// Reclaim only handles owned by this capability provider, never the active reader.
#[cfg(feature = "ai")]
pub(crate) fn close_tool_archives(app: &AppHandle, ids: Vec<String>) {
    let removed = {
        let state = app.state::<NativeArchiveState>();
        let Ok(mut sessions) = state.0.lock() else { return };
        ids.into_iter().filter_map(|id| {
            if sessions.get(&id).is_some_and(|entry| entry.owner == "main") { sessions.remove(&id) } else { None }
        }).collect::<Vec<_>>()
    };
    for entry in removed { entry.session.close(); }
}
