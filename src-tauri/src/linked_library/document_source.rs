//! Streaming book sources and Android document ownership.

use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Runtime};

/// Hash the same bounded reader the caller will parse or stream. The caller
/// owns the revision check and rewinds only after the hash succeeds.
pub(crate) fn hash_original_document(
    reader: &mut impl Read,
    cancelled: impl Fn() -> bool,
) -> io::Result<(String, u64)> {
    let mut digest = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        if cancelled() {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        match reader.read(&mut buffer) {
            Ok(0) => return Ok((format!("{:x}", digest.finalize()), bytes)),
            Ok(count) => {
                digest.update(&buffer[..count]);
                bytes += count as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum BookSource {
    Path(PathBuf),
    Document(String),
}

impl BookSource {
    pub(crate) fn path(&self) -> Option<&Path> {
        match self {
            Self::Path(path) => Some(path),
            Self::Document(_) => None,
        }
    }

    pub(crate) fn open<R: Runtime>(
        &self,
        app: Option<&AppHandle<R>>,
    ) -> io::Result<(Box<dyn Read + Send>, u64)> {
        match self {
            Self::Path(path) => {
                let file = File::open(path)?;
                let metadata = file.metadata()?;
                if !metadata.is_file() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "原书不是普通文件",
                    ));
                }
                Ok((Box::new(file), metadata.len()))
            }
            Self::Document(uri) => {
                #[cfg(target_os = "android")]
                if let Some(app) = app {
                    let reader = crate::android_uri_bridge::open_persisted_document(app, uri)
                        .map_err(|_| {
                            io::Error::new(
                                io::ErrorKind::PermissionDenied,
                                "无法读取原书，请重新连接",
                            )
                        })?;
                    let length = reader.len();
                    return Ok((Box::new(reader), length));
                }
                let _ = (app, uri);
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "当前平台无法打开 Android 原书",
                ))
            }
        }
    }
}

pub(crate) fn is_document_uri(uri: &str) -> bool {
    uri.strip_prefix("content://").is_some_and(|rest| {
        !rest.is_empty() && !rest.starts_with('/') && !rest.contains(char::is_control)
    })
}

/// A provider can refresh ctime during the first read of an opened descriptor.
/// Confirm a ctime-only change with one new stable pass and the same digest.
#[cfg(any(target_os = "android", test))]
pub(super) fn read_stable_document<T, E>(
    before: crate::android_uri_bridge::DocumentRevision,
    mut pass: impl FnMut() -> Result<(T, String, crate::android_uri_bridge::DocumentRevision), E>,
) -> Result<Option<(T, String, crate::android_uri_bridge::DocumentRevision)>, E> {
    let (value, hash, after) = pass()?;
    if before == after {
        return Ok(Some((value, hash, after)));
    }
    if before.file != after.file || before.modified != after.modified {
        return Ok(None);
    }
    drop(value);
    let (value, confirmed_hash, confirmed_revision) = pass()?;
    Ok(
        (after == confirmed_revision && hash == confirmed_hash).then_some((
            value,
            confirmed_hash,
            confirmed_revision,
        )),
    )
}

#[cfg(target_os = "android")]
pub(crate) fn verified_document(
    app: &AppHandle,
    uri: &str,
    hash: &str,
) -> Result<
    (
        crate::android_uri_bridge::SeekableDocument,
        impl Fn() -> Result<(), crate::native_zip_session::Fault> + Send + 'static,
    ),
    super::LinkedLibraryError,
> {
    use crate::native_zip_session::Fault;
    use std::io::Seek;
    let mut reader =
        crate::android_uri_bridge::open_persisted_document(app, uri).map_err(|_| {
            super::LinkedLibraryError::new("source-unavailable", "无法读取原书，请重新连接")
        })?;
    let before = reader.revision().map_err(|e| e.to_string())?;
    let changed = || super::LinkedLibraryError::changed("原书内容已变化，请重新连接");
    let (_, _, expected) = read_stable_document(before, || {
        reader.rewind().map_err(|e| e.to_string())?;
        let (actual, bytes) =
            hash_original_document(&mut reader, || false).map_err(|e| e.to_string())?;
        if bytes != reader.len() || actual != hash {
            return Err(changed());
        }
        let after = reader.revision().map_err(|e| e.to_string())?;
        Ok(((), actual, after))
    })?
    .ok_or_else(changed)?;
    let stat = reader.metadata_handle().map_err(|e| e.to_string())?;
    let guard = move || {
        let current = crate::android_uri_bridge::document_revision(&stat).map_err(|_| Fault::Io)?;
        if current == expected {
            Ok(())
        } else {
            Err(Fault::SourceChanged)
        }
    };
    reader.rewind().map_err(|e| e.to_string())?;
    Ok((reader, guard))
}

#[cfg(target_os = "android")]
pub(crate) fn document_archive(
    app: &AppHandle,
    uri: &str,
    hash: &str,
    file_name: &str,
    title: &str,
    encoding: Option<&str>,
) -> Result<(crate::native_zip_session::NativeZipSession, u64, u64), super::LinkedLibraryError> {
    use super::archive::archive_fault_error;
    use crate::native_zip_session::NativeZipSession;
    let started = std::time::Instant::now();
    let (reader, guard) = verified_document(app, uri, hash)?;
    let verify_ms = started.elapsed().as_millis() as u64;
    let started = std::time::Instant::now();
    let archive = if crate::document_formats::text(file_name) {
        let file = crate::document_formats::text_archive(reader, encoding, title)?;
        NativeZipSession::from_verified_file(file, guard)
    } else {
        NativeZipSession::from_verified_reader(reader, guard)
    }
    .map_err(archive_fault_error)?;
    Ok((archive, verify_ms, started.elapsed().as_millis() as u64))
}

#[cfg(target_os = "android")]
pub(crate) fn document_cover(
    app: &AppHandle,
    binding: &super::DeviceBinding,
) -> Result<Vec<u8>, super::LinkedLibraryError> {
    let Some(path) = binding.cover_zip_path.as_deref() else {
        return Ok(Vec::new());
    };
    let uri = binding.document_uri().ok_or("缺少文档绑定")?;
    let (reader, guard) = verified_document(app, uri, &binding.content_hash)?;
    let mut zip = zip::ZipArchive::new(reader).map_err(|_| "原书不是有效 ZIP")?;
    let mut entry = zip.by_name(path).map_err(|_| "找不到封面")?;
    let bytes = super::read_zip_entry_bounded(&mut entry, super::MAX_COVER_BYTES, "封面")?;
    guard().map_err(super::archive::archive_fault_error)?;
    Ok(bytes)
}

/// Read local ownership without unlocking the private shelf or changing its DB.
#[cfg(target_os = "android")]
pub(crate) fn private_document_uris(
    root: &Path,
) -> Result<std::collections::HashSet<String>, String> {
    let path = root.join("metadata/library.sqlite3");
    match path.try_exists() {
        Ok(false) => return Ok(Default::default()),
        Ok(true) => {}
        Err(error) => return Err(error.to_string()),
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;
    let mut query = db
        .prepare("SELECT json FROM device_bindings")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut uris = std::collections::HashSet::new();
    for raw in rows {
        let binding: super::DeviceBinding =
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(uri) = binding.document_uri() {
            uris.insert(uri.to_owned());
        }
    }
    Ok(uris)
}

/// Must be called after commit under the public binding write lock. If the
/// other shelf cannot be inspected, keep the grant rather than breaking it.
#[cfg(target_os = "android")]
pub(crate) fn release_unreferenced_documents<R: Runtime>(
    app: &AppHandle<R>,
    bindings: &[super::DeviceBinding],
    candidates: impl IntoIterator<Item = String>,
) {
    release_documents_except(
        app,
        bindings
            .iter()
            .filter_map(super::DeviceBinding::document_uri),
        candidates,
    );
}

#[cfg(target_os = "android")]
pub(crate) fn release_documents_except<'a, R: Runtime>(
    app: &AppHandle<R>,
    retained: impl IntoIterator<Item = &'a str>,
    candidates: impl IntoIterator<Item = String>,
) {
    use tauri::Manager;
    let retained: std::collections::HashSet<_> = retained.into_iter().collect();
    let mut candidates = candidates.into_iter().peekable();
    if candidates.peek().is_none() {
        return;
    }
    let Ok(root) = app.path().app_local_data_dir() else {
        return;
    };
    let Ok(private_uris) = private_document_uris(&root.join("private-shelf")) else {
        return;
    };
    for uri in candidates.collect::<std::collections::HashSet<_>>() {
        if !private_uris.contains(&uri) && !retained.contains(uri.as_str()) {
            crate::android_uri_bridge::release_document_read(app, &uri);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::read_stable_document;
    use crate::android_uri_bridge::DocumentRevision;

    const FIRST: DocumentRevision = DocumentRevision {
        file: (1, 2, 4096),
        modified: (3, 4),
        changed: (5, 6),
    };
    const REFRESHED: DocumentRevision = DocumentRevision {
        changed: (5, 7),
        ..FIRST
    };

    #[test]
    fn saf_revision_confirmation_requires_stable_metadata_and_identical_bytes() {
        for (after, second, expected_passes, accepted) in [
            (FIRST, None, 1, true),
            (REFRESHED, Some(("same", REFRESHED)), 2, true),
            (REFRESHED, Some(("edited", REFRESHED)), 2, false),
            (REFRESHED, Some(("same", FIRST)), 2, false),
            (
                DocumentRevision {
                    modified: (3, 5),
                    ..FIRST
                },
                None,
                1,
                false,
            ),
            (
                DocumentRevision {
                    file: (1, 2, 8192),
                    ..FIRST
                },
                None,
                1,
                false,
            ),
        ] {
            let mut passes = 0;
            let outcome = read_stable_document(FIRST, || {
                passes += 1;
                let (hash, stamp) = if passes == 1 {
                    ("same", after)
                } else {
                    second.unwrap()
                };
                Ok::<_, ()>((passes, hash.to_owned(), stamp))
            })
            .unwrap();
            assert_eq!(passes, expected_passes);
            assert_eq!(
                outcome.map(|(pass, _, _)| pass),
                accepted.then_some(expected_passes)
            );
        }
    }
}
