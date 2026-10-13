//! Device-local linked library archive operations.

use super::*;

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

pub(super) fn archive_open_blocking(
    app: AppHandle,
    owner: String,
    content_hash: String,
) -> Result<ArchiveOpenView, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    let (root, pending) = prepare_library_source_read(&app, &content_hash)?;
    let PendingSourceRead {
        identity,
        old_snapshot,
        mut file,
    } = pending;
    let (actual_hash, verified_snapshot) = hash_opened_file(&file)?;
    if !actual_hash.eq_ignore_ascii_case(&content_hash) {
        return Err(LinkedLibraryError::changed("源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("无法重新定位源 EPUB：{error}"))?;
    let stat_file = file
        .try_clone()
        .map_err(|error| format!("无法复制源 EPUB 句柄：{error}"))?;
    let expected_snapshot = verified_snapshot.clone();
    let guard = move || {
        let current = snapshot_file(&stat_file).map_err(|_| Fault::Io)?;
        if current == expected_snapshot {
            Ok(())
        } else {
            Err(Fault::SourceChanged)
        }
    };

    let session = NativeZipSession::from_verified_file(file, guard).map_err(archive_fault_error)?;
    let entry_count = session.entry_count;
    finalize_library_source_read(&app, &root, &identity, &old_snapshot, &verified_snapshot)?;

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
