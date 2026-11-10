//! Session-owned originals: prepared off-shelf, published with records only at commit.
use super::{
    commands::{scoped, session},
    state::*,
    *,
};
use crate::{
    linked_library as library,
    portable_state::{ProgressProjection, ReadestTarget, Stamp},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};
use tauri::{Manager, WebviewWindow};

pub(super) struct Prepared {
    pub hash: String,
    pub path: PathBuf,
    pub name: String,
    pub metadata: library::ImportedMetadata,
    pub target: ReadestTarget,
    pub token: String,
    pub source_binding: String,
    pub existing: bool,
    pub needs_copy: bool,
}
fn storage(_: impl std::fmt::Display) -> crate::portable_state::PortableError {
    error("storage-error", "无法准备原书副本")
}

pub(super) fn copy_checked(
    from: &Path,
    to: &Path,
    check: &dyn Fn() -> PortableResult<()>,
) -> PortableResult<()> {
    let mut source = File::open(from).map_err(storage)?;
    let before = library::snapshot_file(&source).map_err(storage)?;
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(storage)?;
    let mut buf = [0u8; 64 * 1024];
    let result = (|| {
        loop {
            check()?;
            let n = source.read(&mut buf).map_err(storage)?;
            if n == 0 {
                break;
            }
            target.write_all(&buf[..n]).map_err(storage)?;
        }
        target.sync_all().map_err(storage)?;
        if library::snapshot_file(&source).map_err(storage)? != before {
            return Err(error("source-changed", "原书在复制期间变化"));
        }
        check()
    })();
    if result.is_err() {
        let _ = fs::remove_file(to);
    }
    result
}

pub(super) fn prepare(
    window: &WebviewWindow,
    session: &Arc<Session>,
    readest_hash: &str,
    path: PathBuf,
    name: String,
) -> PortableResult<Arc<Prepared>> {
    let (hash, snapshot) = verify_original(&path, readest_hash, &|| {
        session.cancelled.load(Ordering::Acquire)
    })?;
    let metadata = library::epub_meta::inspect_book(&path, &name)
        .map_err(|_| error("invalid-book", "书文件无法解析"))?;
    if library::snapshot(&path).map_err(storage)? != snapshot {
        return Err(error("source-changed", "原书在准备期间变化"));
    }
    let raw = serde_json::to_string(&library::make_binding(
        hash.clone(),
        &path,
        snapshot,
        &metadata,
    ))
    .map_err(storage)?;
    let (target, existing) = scoped(window, &session.scope, |store, _| {
        let existing = store.local_visible_hashes()?.contains(&hash);
        let target = if existing && name.to_ascii_lowercase().ends_with(".epub") {
            store.readest_target(&hash)?
        } else {
            ReadestTarget {
                book_hash: hash.clone(),
                binding: if existing {
                    store.binding_raw(&hash)?.unwrap_or_else(|| raw.clone())
                } else {
                    raw.clone()
                },
                metadata_stamp: Stamp {
                    device_id: String::new(),
                    counter: 0,
                },
                progress_revision: 0,
                progress: ProgressProjection {
                    versions: vec![],
                    display: None,
                    conflict: false,
                },
                generation: store.runtime_generation().to_owned(),
            }
        };
        Ok((target, existing))
    })?;
    let needs_copy = !existing
        || source::candidate(window.app_handle(), &target.binding, &|| {
            session.cancelled.load(Ordering::Acquire)
        })
        .map(|md5| md5 != readest_hash)
        .unwrap_or(true);
    session.check()?;
    let token = crate::portable_state::random_uuid_v4().map_err(storage)?;
    let prepared = Arc::new(Prepared {
        hash: hash.clone(),
        path,
        name,
        metadata,
        target: target.clone(),
        token: token.clone(),
        source_binding: raw,
        existing,
        needs_copy,
    });
    let mut data = session.data.lock().map_err(storage)?;
    data.targets.insert(
        hash,
        StoredTarget {
            token,
            target,
            partial_md5: readest_hash.into(),
        },
    );
    data.prepared.insert(readest_hash.into(), prepared.clone());
    Ok(prepared)
}

#[tauri::command]
pub async fn readest_staged_archive_open(
    window: WebviewWindow,
    session_id: String,
    readest_hash: String,
) -> PortableResult<library::ArchiveOpenView> {
    tauri::async_runtime::spawn_blocking(move || {
        let owned = session(&window, &session_id)?;
        let prepared = owned
            .data
            .lock()
            .map_err(storage)?
            .prepared
            .get(&readest_hash)
            .cloned()
            .ok_or_else(|| error("not-ready", "原书尚未准备"))?;
        let file = File::open(&prepared.path).map_err(storage)?;
        let stat = file.try_clone().map_err(storage)?;
        let before = library::snapshot_file(&file).map_err(storage)?;
        let app = window.app_handle().clone();
        let guard_app = app.clone();
        let epoch = if matches!(owned.scope, ImportScope::Private { .. }) {
            Some(crate::private_shelf::import_epoch(&app))
        } else {
            None
        };
        let archive =
            crate::native_zip_session::NativeZipSession::from_verified_file(file, move || {
                if owned.check().is_err()
                    || epoch.is_some_and(|e| crate::private_shelf::import_epoch(&guard_app) != e)
                {
                    return Err(crate::native_zip_session::Fault::Closed);
                }
                if library::snapshot_file(&stat).ok().as_ref() != Some(&before) {
                    return Err(crate::native_zip_session::Fault::SourceChanged);
                }
                Ok(())
            })
            .map_err(fault)?;
        library::register_archive(&app, window.label().into(), archive, 0, 0, false)
            .map_err(storage)
    })
    .await
    .map_err(storage)?
}

/// Files are exclusively created by this guard; no existing or duplicate book is deleted.
pub(super) struct Publication {
    paths: Vec<(PathBuf, String)>,
    committed: Option<std::collections::BTreeSet<String>>,
}
impl Publication {
    pub fn new() -> Self {
        Self {
            paths: vec![],
            committed: None,
        }
    }
    pub fn accept(&mut self, hashes: &std::collections::BTreeSet<String>) {
        self.committed = Some(hashes.clone());
    }
    pub fn originals(
        &mut self,
        app: &tauri::AppHandle,
        prepared: &[Arc<Prepared>],
        check: &dyn Fn() -> PortableResult<()>,
    ) -> PortableResult<Vec<(serde_json::Value, String, String, Option<String>)>> {
        if !prepared.iter().any(|book| book.needs_copy) {
            return Ok(vec![]);
        }
        let root = library::library_root(app).map_err(storage)?;
        let books = library::writable_books_directory(&root).map_err(storage)?;
        let mut rows = vec![];
        for book in prepared {
            if !book.needs_copy {
                continue;
            }
            check()?;
            let name = format!(
                "readest-{}.{}",
                crate::portable_state::random_uuid_v4().map_err(storage)?,
                crate::document_formats::extension(&book.name)
            );
            let path = books.join(&name);
            copy_checked(&book.path, &path, check)?;
            self.paths.push((path.clone(), book.hash.clone()));
            let mut binding = library::make_managed_binding(
                book.hash.clone(),
                library::snapshot(&path).map_err(storage)?,
                &book.metadata,
            );
            binding = binding.with_managed_file_name(name);
            let record =
                library::make_managed_record(book.hash.clone(), book.name.clone(), &book.metadata);
            rows.push((
                serde_json::to_value(record).map_err(storage)?,
                book.hash.clone(),
                serde_json::to_string(&binding).map_err(storage)?,
                book.existing.then(|| book.target.binding.clone()),
            ));
        }
        Ok(rows)
    }
}
impl Drop for Publication {
    fn drop(&mut self) {
        for (path, hash) in &self.paths {
            if !self
                .committed
                .as_ref()
                .is_some_and(|set| set.contains(hash))
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Verify the Readest identity before anything can become a shelf record.
pub(super) fn verify_original(
    path: &Path,
    readest_hash: &str,
    cancelled: &dyn Fn() -> bool,
) -> PortableResult<(String, library::FileSnapshot)> {
    let mut file = File::open(path).map_err(storage)?;
    let before = library::snapshot_file(&file).map_err(storage)?;
    let bytes = file.metadata().map_err(storage)?.len();
    let partial = source::partial(&mut file, bytes, &|| cancelled())?;
    if partial != readest_hash {
        return Err(error(
            "source-mismatch",
            "书文件与 Readest 指纹不符，未加入书架",
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(storage)?;
    let mut sha = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err(error("cancelled", "迁入已取消"));
        }
        let n = file.read(&mut buffer).map_err(storage)?;
        if n == 0 {
            break;
        }
        sha.update(&buffer[..n]);
    }
    let hash = format!("{:x}", sha.finalize());
    let snapshot = library::snapshot_file(&file).map_err(storage)?;
    if before != snapshot {
        return Err(error("source-changed", "原书在校验期间变化"));
    }
    if cancelled() {
        return Err(error("cancelled", "迁入已取消"));
    }
    Ok((hash, snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_publication_cleans_only_owned_files_and_success_keeps_only_bound_copies() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("existing.epub");
        let owned = dir.path().join("owned.epub");
        fs::write(&existing, b"user-book").unwrap();
        fs::write(&owned, b"copy").unwrap();
        {
            let mut publication = Publication::new();
            publication.paths.push((owned.clone(), "a".into()));
        }
        assert!(!owned.exists());
        assert_eq!(fs::read(&existing).unwrap(), b"user-book");
        fs::write(&owned, b"copy").unwrap();
        {
            let mut publication = Publication::new();
            publication.paths.push((owned.clone(), "a".into()));
            publication.accept(&std::collections::BTreeSet::from(["a".into()]));
        }
        assert!(owned.exists());
        // A concurrent duplicate won: keep its original, clean our unused copy.
        {
            let mut publication = Publication::new();
            publication.paths.push((owned.clone(), "a".into()));
            publication.accept(&Default::default());
        }
        assert!(!owned.exists());
        assert_eq!(fs::read(&existing).unwrap(), b"user-book");
    }
}

#[cfg(test)]
mod copy_tests {
    use super::*;
    #[test]
    fn cancelled_copy_removes_its_partial_file_without_touching_original_or_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.txt");
        let target = dir.path().join("copy.txt");
        fs::write(&original, vec![42u8; 200_000]).unwrap();
        let calls = std::cell::Cell::new(0);
        let result = copy_checked(&original, &target, &|| {
            calls.set(calls.get() + 1);
            if calls.get() > 1 {
                Err(error("cancelled", "test"))
            } else {
                Ok(())
            }
        });
        assert_eq!(result.unwrap_err().code, "cancelled");
        assert!(!target.exists());
        assert_eq!(fs::metadata(&original).unwrap().len(), 200_000);
        fs::write(&target, b"existing user copy").unwrap();
        assert!(copy_checked(&original, &target, &|| Ok(())).is_err());
        assert_eq!(fs::read(target).unwrap(), b"existing user copy");
    }
}
