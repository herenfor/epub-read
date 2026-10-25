//! Device-local linked library source operations.

use super::*;

pub(crate) fn snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取源 EPUB 属性：{error}"))?;
    if !metadata.is_file() {
        return Err("导入目标不是普通文件".into());
    }
    Ok(file_snapshot_from_metadata(&metadata))
}

pub(super) fn snapshot_file(file: &File) -> Result<FileSnapshot, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取源 EPUB 属性：{error}"))?;
    if !metadata.is_file() {
        return Err("导入目标不是普通文件".into());
    }
    Ok(file_snapshot_from_metadata(&metadata))
}

pub(super) fn file_snapshot_from_metadata(metadata: &std::fs::Metadata) -> FileSnapshot {
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    FileSnapshot {
        size: metadata.len(),
        mtime_ns,
    }
}

pub(super) fn is_epub(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("epub"))
        .unwrap_or(false)
}

pub(crate) fn canonical_epub_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !is_epub(&path) {
        return Err("只能导入 EPUB 文件".into());
    }
    fs::canonicalize(&path).map_err(|error| format!("无法规范化源 EPUB 路径：{error}"))
}

pub(crate) fn hash_file(path: &Path) -> Result<(String, FileSnapshot), String> {
    hash_source_file(path).map_err(|error| error.message)
}

pub(super) fn hash_source_file(path: &Path) -> Result<(String, FileSnapshot), LinkedLibraryError> {
    let before = snapshot(path)?;
    let file = File::open(path).map_err(|error| format!("无法读取源 EPUB：{error}"))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("无法读取源 EPUB：{error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let after = snapshot(path)?;
    if before.size != after.size || before.mtime_ns != after.mtime_ns {
        return Err(LinkedLibraryError::changed("源 EPUB 在计算指纹期间发生了变化，请重新导入"));
    }
    Ok((format!("{:x}", digest.finalize()), after))
}

pub(super) fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn source_open_error(error: std::io::Error) -> LinkedLibraryError {
    if error.kind() == std::io::ErrorKind::NotFound {
        LinkedLibraryError::new("source-missing", "源 EPUB 已变化或丢失；请重新导入或重新定位")
    } else {
        format!("无法打开源 EPUB：{error}").into()
    }
}

pub(super) fn prepare_source_read(
    library_root: &Path,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
    content_hash: &str,
) -> Result<PendingSourceRead, LinkedLibraryError> {
    let found = records
        .iter()
        .any(|record| record.content_hash == content_hash);
    observe_record_target(found);
    if !found {
        return Err("书库中没有这本书".into());
    }
    let binding = bindings
        .iter()
        .find(|binding| binding.content_hash == content_hash)
        .ok_or_else(|| LinkedLibraryError::new("source-unbound", "本机没有这本书的源文件绑定"))?;
    let identity = SourceIdentity::from_binding(binding, library_root)?;
    let file = File::open(&identity.path).map_err(source_open_error)?;
    Ok(PendingSourceRead {
        identity,
        old_snapshot: FileSnapshot {
            size: binding.file_size,
            mtime_ns: binding.source_mtime_ns,
        },
        file,
    })
}

pub(super) fn read_source_bytes_and_hash(
    file: &File,
    expected_hash: &str,
) -> Result<SourceReadResult, LinkedLibraryError> {
    let before = snapshot_file(file)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取源 EPUB：{error}"))?;
    drop(reader);
    let after = snapshot_file(file)?;
    if before.size != after.size || before.mtime_ns != after.mtime_ns {
        return Err(LinkedLibraryError::changed("源 EPUB 在读取期间发生了变化；未将旧进度应用到新内容"));
    }
    if hash_bytes(&bytes) != expected_hash {
        return Err(LinkedLibraryError::changed("源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容"));
    }
    Ok(SourceReadResult {
        bytes,
        read_snapshot: after,
    })
}

/// Streams one whole book through SHA-256 from an already-open handle.  The
/// caller must have opened the handle at offset 0.  This is only used by the
/// cover slow path after the cheap binding signature no longer matches; it
/// never materializes the book in a `Vec` and never reopens by path.
pub(super) fn hash_opened_file(file: &File) -> Result<(String, FileSnapshot), LinkedLibraryError> {
    let before = snapshot_file(file)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("无法读取源 EPUB：{error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    drop(reader);
    let after = snapshot_file(file)?;
    if before.size != after.size || before.mtime_ns != after.mtime_ns {
        return Err(LinkedLibraryError::changed("源 EPUB 在验证封面期间发生了变化"));
    }
    Ok((format!("{:x}", digest.finalize()), after))
}

/// Reads exactly one cover ZIP entry.  If the opened handle still has the
/// binding signature, the existing verified signature is trusted and no
/// whole-book hash is needed.  If the signature changed, the whole book must
/// be hash-verified through this same handle before any local ZIP bytes can
/// upgrade the binding state.  The stat must remain the trusted signature
/// immediately before and after the ZIP read as well.
pub(super) fn read_cover_from_opened_file(
    file: &File,
    cover_zip_path: &str,
    limit: u64,
    expected_hash: &str,
    old_snapshot: &FileSnapshot,
) -> Result<SourceReadResult, LinkedLibraryError> {
    let initial = snapshot_file(file)?;
    let trusted_snapshot = if initial == *old_snapshot {
        initial
    } else {
        let (actual_hash, verified_snapshot) = hash_opened_file(file)?;
        if actual_hash != expected_hash {
            return Err(LinkedLibraryError::changed("源 EPUB 已变化或丢失；请重新导入或重新定位"));
        }
        verified_snapshot
    };

    let before_zip = snapshot_file(file)?;
    if before_zip != trusted_snapshot {
        return Err(LinkedLibraryError::changed("源 EPUB 在读取封面期间发生了变化"));
    }
    let bytes = {
        let mut archive =
            ZipArchive::new(file).map_err(|error| format!("EPUB 不是有效 ZIP：{error}"))?;
        let mut cover_entry = archive
            .by_name(cover_zip_path)
            .map_err(|_| "EPUB 中找不到封面条目".to_string())?;
        read_zip_entry_bounded(&mut cover_entry, limit, "封面")?
    };
    let after_zip = snapshot_file(file)?;
    if after_zip != trusted_snapshot {
        return Err(LinkedLibraryError::changed("源 EPUB 在读取封面期间发生了变化"));
    }
    Ok(SourceReadResult {
        bytes,
        read_snapshot: after_zip,
    })
}

/// Opens one linked/managed source and captures the binding snapshot under the
/// short library lock.  Archive reads then continue without holding that lock.
pub(super) fn prepare_library_source_read(
    app: &AppHandle,
    content_hash: &str,
) -> Result<(PathBuf, PendingSourceRead), LinkedLibraryError> {
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(app)?;
    let records = load_records(app)?;
    let bindings = load_bindings(app)?;
    let pending = prepare_source_read(&root, &records, &bindings, content_hash)?;
    Ok((root, pending))
}

/// Applies the same conditional write-back rule as the whole-book path after a
/// successful archive read.
pub(super) fn finalize_library_source_read(
    app: &AppHandle,
    root: &Path,
    identity: &SourceIdentity,
    old_snapshot: &FileSnapshot,
    read_snapshot: &FileSnapshot,
) -> Result<(), LinkedLibraryError> {
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let records = load_records(app)?;
    let mut bindings = load_bindings(app)?;
    if finalize_source_read(
        root,
        &records,
        &mut bindings,
        identity,
        old_snapshot,
        read_snapshot,
    )? {
        save_bindings(app, &bindings)?;
    }
    Ok(())
}

/// Applies the BK-3 read/write-back decision table against freshly loaded
/// records and bindings.  Returns `true` when the caller must persist the
/// current binding.  The fresh snapshot is updated only for this binding; no
/// old records/bindings snapshot is copied back.
pub(super) fn finalize_source_read(
    library_root: &Path,
    records: &[LinkedLibraryRecord],
    bindings: &mut [DeviceBinding],
    identity: &SourceIdentity,
    old_snapshot: &FileSnapshot,
    read_snapshot: &FileSnapshot,
) -> Result<bool, LinkedLibraryError> {
    if !records
        .iter()
        .any(|record| record.content_hash == identity.content_hash)
    {
        return Err("读取结果已过期：书库记录已变化".into());
    }
    let binding_index = bindings
        .iter()
        .position(|binding| binding.content_hash == identity.content_hash)
        .ok_or_else(|| "读取结果已过期：源文件绑定已缺失".to_string())?;
    let current_identity = SourceIdentity::from_binding(&bindings[binding_index], library_root)
        .map_err(|_| LinkedLibraryError::unavailable("源 EPUB 已变化或丢失；请重新导入或重新定位"))?;
    if &current_identity != identity {
        return Err("读取结果已过期：源文件绑定已变化".into());
    }
    let now_snapshot = snapshot(&current_identity.path)
        .map_err(|_| LinkedLibraryError::unavailable("源 EPUB 已变化或丢失；请重新导入或重新定位"))?;
    let binding_snapshot = FileSnapshot {
        size: bindings[binding_index].file_size,
        mtime_ns: bindings[binding_index].source_mtime_ns,
    };

    if now_snapshot == *read_snapshot {
        if binding_snapshot == *read_snapshot {
            // Signatures already agree.  Successful reads do not require a
            // verification-time update, so avoid the JSON write and sync_all.
            return Ok(false);
        }
        if binding_snapshot == *old_snapshot {
            bindings[binding_index].file_size = read_snapshot.size;
            bindings[binding_index].source_mtime_ns = read_snapshot.mtime_ns;
            bindings[binding_index].last_verified_at_ms = now_ms();
            Ok(true)
        } else {
            Err("读取结果已过期：源文件签名已变化".into())
        }
    } else if current_identity.storage_kind == StorageKind::Managed
        && binding_snapshot == now_snapshot
    {
        // A managed same-hash reimport may replace the inode while the old fd
        // is still being read.  Managed files are only published by the
        // hash-verified import pipeline, so the bytes just read remain valid;
        // never overwrite the newer binding stat with the old fd snapshot.
        Ok(false)
    } else {
        Err("读取结果已过期：源文件已变化".into())
    }
}

pub(super) fn read_source_raw_blocking(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    // Short lock: capture identity, open the source handle and remember the
    // binding signature only.  Do not hash or read the book here.
    let (root, pending) = {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let root = library_root(&app)?;
        let records = load_records(&app)?;
        let bindings = load_bindings(&app)?;
        let pending = prepare_source_read(&root, &records, &bindings, &content_hash)?;
        (root, pending)
    };

    // Heavy I/O without the library write lock: progress, notes and bookmarks
    // continue to commit while the bytes and SHA-256 are read from this fd.
    let read = read_source_bytes_and_hash(&pending.file, &content_hash)?;

    // Short lock: reload the latest indexes and apply the conditional write-
    // back table.  Never save the pre-read records/bindings snapshot.
    {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let records = load_records(&app)?;
        let mut bindings = load_bindings(&app)?;
        if finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )? {
            save_bindings(&app, &bindings)?;
        }
    }
    Ok(tauri::ipc::Response::new(read.bytes))
}

pub(super) fn read_cover_raw_blocking(
    app: AppHandle,
    content_hash: String,
) -> Result<tauri::ipc::Response, LinkedLibraryError> {
    if !valid_content_hash(&content_hash) {
        return Err("无效的书籍内容指纹".into());
    }

    // Short lock: record/binding identity plus the exact ZIP entry path.  The
    // selected entry is read from this handle without holding the lock.
    let (root, pending, cover_path) = {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let root = library_root(&app)?;
        let records = load_records(&app)?;
        if !records
            .iter()
            .any(|record| record.content_hash == content_hash)
        {
            return Err("书库中没有这本书".into());
        }
        let bindings = load_bindings(&app)?;
        let binding = bindings
            .iter()
            .find(|binding| binding.content_hash == content_hash)
            .ok_or_else(|| LinkedLibraryError::new("source-unbound", "本机没有这本书的源文件绑定"))?;
        let Some(cover_path) = binding.cover_zip_path.clone() else {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        };
        let pending = prepare_source_read(&root, &records, &bindings, &content_hash)?;
        (root, pending, cover_path)
    };

    // Exact ZIP-entry read only; never inflate the whole EPUB for a cover.
    // The shared helper only trusts the old signature for the lightweight
    // path; a changed signature triggers a same-fd whole-book hash first.
    let read = read_cover_from_opened_file(
        &pending.file,
        &cover_path,
        MAX_COVER_BYTES,
        &pending.identity.content_hash,
        &pending.old_snapshot,
    )?;

    // Same identity/conditional write-back rule as the正文 path.
    {
        let state = app.state::<LinkedLibraryWriteState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "链接书库写入锁已损坏".to_string())?;
        let records = load_records(&app)?;
        let mut bindings = load_bindings(&app)?;
        if finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )? {
            save_bindings(&app, &bindings)?;
        }
    }
    Ok(tauri::ipc::Response::new(read.bytes))
}

/// What "show in File Explorer" points at: the user's own file for a linked
/// book, the library copy for a managed one.  The path never comes from the
/// front end; a missing binding or file is reported, not guessed.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RevealTarget {
    File(PathBuf),
    Missing,
}

pub(super) fn reveal_target(root: &Path, bindings: &[DeviceBinding], content_hash: &str) -> RevealTarget {
    let Some(binding) = bindings.iter().find(|binding| binding.content_hash == content_hash) else {
        return RevealTarget::Missing;
    };
    match binding.resolve_source(root) {
        Ok(source) if source.path().is_file() => RevealTarget::File(source.path().to_path_buf()),
        _ => RevealTarget::Missing,
    }
}
