//! MOBI/AZW3 integration for the standalone `mobi-adapter` crate.
//!
//! The adapter owns one opaque libmobi handle and writes a deterministic
//! temporary reading EPUB. This module is the only application entry to it:
//! format detection, metadata/cover projection, bounded source ownership and
//! the temporary archive lifecycle. It deliberately does not route commands,
//! persist locations or decide data versions; the linked library owns those.
//!
//! The temporary EPUB is not a converted copy of the user's book. It lives in
//! an app-owned temporary directory, is handed to the existing window-owned
//! ZIP session, and is removed when that session closes or the conversion
//! fails. No permanent conversion cache is created.

use super::ImportedMetadata;
use mobi_adapter::{CancelToken, Limits, MobiError, Source};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Synthetic binding hint for the adapter-provided cover. It is never a ZIP
/// entry in the generated reading EPUB; the cover is re-read from the original
/// source (metadata-only libmobi load) when the shelf asks for it.
pub(crate) const COVER_PATH: &str = "__reader__/mobi/cover";

/// `ImportedMetadata.spine` only proves that the source is readable enough to
/// create a shelf record. MOBI chapters do not exist until the temporary EPUB
/// is opened, so this placeholder is never persisted or used as a chapter key.
const IMPORT_SPINE: &str = "__kindle__";

const COVER_LIMIT: u64 = 32 * 1024 * 1024;

// libmobi loads the PDB records and reconstructs rawml synchronously. Keep one
// heavy Kindle parse/conversion in flight per process, matching the existing
// single-heavy-job boundary without adding a service or watch dog.
static CONVERSION_GATE: Mutex<()> = Mutex::new(());

fn conversion_guard() -> MutexGuard<'static, ()> {
    CONVERSION_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Stable native failure: the code is the adapter's machine code and is part
/// of the frozen frontend contract. The detail is diagnostic only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    code: &'static str,
    detail: String,
}

impl Failure {
    fn from_mobi(error: MobiError) -> Self {
        Self {
            code: error.code().as_str(),
            detail: error.message().to_owned(),
        }
    }

    fn io(context: &str, error: impl std::fmt::Display) -> Self {
        Self {
            code: "mobi.io",
            detail: format!("{context}: {error}"),
        }
    }

    fn budget(detail: impl Into<String>) -> Self {
        Self {
            code: "mobi.budget",
            detail: detail.into(),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    /// Per-item import errors keep the machine code as a stable ASCII prefix;
    /// the frontend maps it before showing localized text.
    pub(crate) fn import_message(&self) -> String {
        format!("{}: {}", self.code, self.detail)
    }

    /// Structured open/import errors use `code` for machine mapping; this text
    /// is only the diagnostic fallback.
    pub(crate) fn detail(&self) -> &str {
        &self.detail
    }
}

fn limits(cover_limit: u64) -> Limits {
    Limits {
        max_cover_bytes: cover_limit,
        ..Limits::default()
    }
}

/// Metadata and cover only; libmobi does not reconstruct rawml here and no
/// reading EPUB is written. This is the import/relink path.
pub(crate) fn inspect_path(path: &Path, fallback: &str) -> Result<ImportedMetadata, Failure> {
    let source = Source::from_path(path).map_err(Failure::from_mobi)?;
    inspect_source(source, fallback)
}

/// Copy exactly the declared bounded source into an anonymous file. Android
/// document readers are often passed by mutable reference and may expose a
/// `base + length` window; this never reads one byte outside that window.
fn copy_bounded<R: Read + Seek>(mut reader: R, length: u64) -> Result<File, Failure> {
    let max_source = Limits::default().max_source_bytes;
    if length == 0 {
        return Err(Failure::from_mobi(mobi_adapter::MobiError::new(
            mobi_adapter::MobiErrorCode::Source,
            "source file is empty",
        )));
    }
    if length > max_source {
        return Err(Failure::budget(format!(
            "source is {length} bytes, limit is {max_source} bytes"
        )));
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| Failure::io("回到原书开头", error))?;
    let mut temp =
        tempfile::tempfile().map_err(|error| Failure::io("创建匿名源临时文件", error))?;
    let mut remaining = length;
    let mut buffer = [0u8; 128 * 1024];
    while remaining > 0 {
        let want = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| Failure::budget("源分块长度溢出"))?;
        let read = reader
            .read(&mut buffer[..want])
            .map_err(|error| Failure::io("读取原书", error))?;
        if read == 0 {
            return Err(Failure {
                code: "mobi.source",
                detail: format!("原书在声明长度 {length} 前结束"),
            });
        }
        std::io::Write::write_all(&mut temp, &buffer[..read])
            .map_err(|error| Failure::io("写匿名源临时文件", error))?;
        remaining -= read as u64;
    }
    temp.seek(SeekFrom::Start(0))
        .map_err(|error| Failure::io("回到匿名源开头", error))?;
    Ok(temp)
}

/// Metadata-only inspect from an already-owned bounded reader.
pub(crate) fn inspect_reader<R: Read + Seek>(
    mut reader: R,
    fallback: &str,
) -> Result<ImportedMetadata, Failure> {
    let length = reader
        .seek(SeekFrom::End(0))
        .map_err(|error| Failure::io("测量原书长度", error))?;
    let file = copy_bounded(reader, length)?;
    let source = Source::from_file(file).map_err(Failure::from_mobi)?;
    inspect_source(source, fallback)
}

fn inspect_source(source: Source, fallback: &str) -> Result<ImportedMetadata, Failure> {
    let _gate = conversion_guard();
    let metadata =
        mobi_adapter::inspect(source, &limits(COVER_LIMIT)).map_err(Failure::from_mobi)?;
    let title = metadata.title.trim();
    Ok(ImportedMetadata {
        title: if title.is_empty() {
            fallback.to_owned()
        } else {
            title.to_owned()
        },
        creator: metadata.creator.trim().to_owned(),
        language: metadata.language.trim().to_owned(),
        spine: vec![IMPORT_SPINE.to_owned()],
        cover_zip_path: metadata.cover.as_ref().map(|_| COVER_PATH.to_owned()),
        cover_mime: metadata
            .cover
            .as_ref()
            .map(|cover| cover.mime.clone())
            .unwrap_or_default(),
    })
}

/// One converted temporary reading EPUB. The directory owns the path; the
/// file handle is closed before the directory is removed, including on
/// Windows, where an open handle blocks directory removal.
pub(crate) struct ReadingArchive {
    file: Option<File>,
    /// Kept only so the directory outlives the open file handle.
    _directory: tempfile::TempDir,
}

impl ReadingArchive {
    fn new(file: File, directory: tempfile::TempDir) -> Self {
        Self {
            file: Some(file),
            _directory: directory,
        }
    }
}

impl Read for ReadingArchive {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.file
            .as_mut()
            .expect("reading archive file is open")
            .read(buffer)
    }
}

impl Seek for ReadingArchive {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.file
            .as_mut()
            .expect("reading archive file is open")
            .seek(position)
    }
}

impl Drop for ReadingArchive {
    fn drop(&mut self) {
        // Close first; `_directory` is dropped immediately after this body.
        self.file.take();
    }
}

fn convert(source: Source, temp_root: &Path) -> Result<ReadingArchive, Failure> {
    let _gate = conversion_guard();
    std::fs::create_dir_all(temp_root).map_err(|error| Failure::io("创建临时阅读目录", error))?;
    let directory = tempfile::Builder::new()
        .prefix("kindle-reading-")
        .tempdir_in(temp_root)
        .map_err(|error| Failure::io("创建临时阅读目录", error))?;
    let destination = directory.path().join("reading.epub");
    let cancel = CancelToken::new();
    let report = mobi_adapter::convert(source, &destination, &limits(COVER_LIMIT), &cancel)
        .map_err(Failure::from_mobi)?;
    if report.epub_bytes == 0 {
        return Err(Failure::budget("转换结果为空"));
    }
    let file = File::open(&destination).map_err(|error| Failure::io("打开临时阅读归档", error))?;
    Ok(ReadingArchive::new(file, directory))
}

/// Convert an owned source file into one temporary reading EPUB.
pub(crate) fn reading_archive_file(
    file: File,
    temp_root: &Path,
) -> Result<ReadingArchive, Failure> {
    let source = Source::from_file(file).map_err(Failure::from_mobi)?;
    convert(source, temp_root)
}

/// Convert an already-bound bounded reader without treating an Android
/// `base + length` slice as the whole descriptor.
#[cfg(target_os = "android")]
pub(crate) fn reading_archive_reader<R: Read + Seek + Send + 'static>(
    mut reader: R,
    length: u64,
    temp_root: &Path,
) -> Result<ReadingArchive, Failure> {
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| Failure::io("回到原书开头", error))?;
    let source = Source::from_reader(Box::new(reader), length).map_err(Failure::from_mobi)?;
    convert(source, temp_root)
}

/// The adapter's cover read, from a borrowed/owned bounded reader.
pub(crate) fn cover_reader<R: Read + Seek>(
    reader: R,
    length: u64,
    limit: u64,
) -> Result<Vec<u8>, Failure> {
    let file = copy_bounded(reader, length)?;
    let source = Source::from_file(file).map_err(Failure::from_mobi)?;
    cover(source, limit)
}

/// Cover read from an already-open desktop file. The clone shares the file
/// offset with the caller, but cover reads never continue reading the source
/// afterwards; the caller's snapshot checks are metadata-only.
pub(crate) fn cover_file(file: &File, limit: u64) -> Result<Vec<u8>, Failure> {
    let clone = file
        .try_clone()
        .map_err(|error| Failure::io("复制原书句柄", error))?;
    let source = Source::from_file(clone).map_err(Failure::from_mobi)?;
    cover(source, limit)
}

fn cover(source: Source, limit: u64) -> Result<Vec<u8>, Failure> {
    let _gate = conversion_guard();
    let metadata = mobi_adapter::inspect(source, &limits(limit)).map_err(Failure::from_mobi)?;
    Ok(metadata.cover.map(|cover| cover.bytes).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(variable: &str) -> Option<String> {
        std::env::var(variable)
            .ok()
            .filter(|value| !value.is_empty())
    }

    #[test]
    fn adapter_errors_keep_the_stable_machine_code() {
        for (raw, expected) in [
            (5, "mobi.encrypted"),
            (6, "mobi.replica"),
            (7, "mobi.dictionary"),
            (3, "mobi.parse"),
        ] {
            let error = mobi_adapter::MobiError::new(
                match raw {
                    5 => mobi_adapter::MobiErrorCode::Encrypted,
                    6 => mobi_adapter::MobiErrorCode::Replica,
                    7 => mobi_adapter::MobiErrorCode::Dictionary,
                    _ => mobi_adapter::MobiErrorCode::Parse,
                },
                "detail",
            );
            let failure = Failure::from_mobi(error);
            assert_eq!(failure.code(), expected);
            assert!(failure
                .import_message()
                .starts_with(&format!("{expected}: ")));
        }
    }

    #[test]
    fn format_router_keeps_kindle_out_of_the_text_and_epub_paths() {
        assert!(crate::document_formats::supported("book.MOBI"));
        assert!(crate::document_formats::supported("book.AZW3"));
        assert!(crate::document_formats::kindle("book.mobi"));
        assert!(!crate::document_formats::virtual_archive("book.mobi"));
        assert_eq!(
            crate::document_formats::inspect(Path::new("missing.mobi"), "book.mobi")
                .unwrap_err()
                .split(':')
                .next(),
            Some("mobi.io")
        );
    }

    #[test]
    fn imported_metadata_projects_only_fields_the_shelf_keeps() {
        let Some(path) = fixture("ER141_MOBI6") else {
            return;
        };
        let metadata = inspect_path(Path::new(&path), "fallback").unwrap();
        let routed = crate::document_formats::inspect(Path::new(&path), "original.mobi").unwrap();
        assert_eq!(routed.spine, metadata.spine);
        assert_eq!(routed.cover_zip_path, metadata.cover_zip_path);
        assert!(!metadata.title.trim().is_empty());
        assert_eq!(metadata.spine, [IMPORT_SPINE]);
        assert!(metadata
            .cover_zip_path
            .as_deref()
            .is_none_or(|path| path == COVER_PATH));
        if metadata.cover_zip_path.as_deref() == Some(COVER_PATH) {
            assert!(!metadata.cover_mime.is_empty());
            let cover = crate::document_formats::read_cover(
                File::open(&path).unwrap(),
                COVER_PATH,
                COVER_LIMIT,
            )
            .unwrap();
            assert!(!cover.is_empty());
        }
    }

    #[test]
    fn conversion_is_deterministic_across_temporary_directories() {
        let Some(path) = fixture("ER141_MOBI6") else {
            return;
        };
        let original = std::fs::read(&path).unwrap();
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let first = reading_archive_file(File::open(&path).unwrap(), first_root.path()).unwrap();
        let second = reading_archive_file(File::open(&path).unwrap(), second_root.path()).unwrap();
        let first_entries = archive_entries(first);
        let second_entries = archive_entries(second);
        assert_eq!(first_entries, second_entries);
        // Reading/converting never rewrites the user's source bytes.
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn converted_archive_opens_through_the_window_owned_zip_session() {
        let Some(path) = fixture("ER141_KF8") else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let archive = reading_archive_file(File::open(&path).unwrap(), root.path()).unwrap();
        let session =
            crate::native_zip_session::NativeZipSession::from_verified_reader(archive, || {
                Ok::<(), crate::native_zip_session::Fault>(())
            })
            .unwrap();
        let page = session.directory_page(0).unwrap();
        let opf = page
            .entries
            .iter()
            .position(|entry| entry.name == "OEBPS/content.opf")
            .expect("converted archive has its OPF");
        let bytes = session
            .read_chunk(page.entries[opf].entry_index, 0)
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("<package"));
        session.close();
    }

    fn archive_entries(mut archive: ReadingArchive) -> Vec<(String, u64, String)> {
        use sha2::{Digest, Sha256};
        let mut zip = zip::ZipArchive::new(&mut archive).unwrap();
        let mut entries = Vec::new();
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            let size = bytes.len() as u64;
            entries.push((
                entry.name().to_owned(),
                size,
                format!("{:x}", Sha256::digest(&bytes)),
            ));
        }
        entries.sort();
        entries
    }
}
