//! Bounded original-byte copying; no EPUB parsing or rewriting here.
use crate::save_file::{SaveFileError, SkippedBook, COPY_BUFFER_BYTES};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

pub(super) struct SourceBook {
    pub hash: String,
    pub title: String,
    pub file_name: String,
    pub path: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBook {
    pub content_hash: String,
    pub file_name: String,
}

pub(super) struct WrittenOutput {
    pub books: Vec<ExportedBook>,
    pub book_bytes: u64,
    pub skipped: Vec<SkippedBook>,
}

pub(super) fn safe_epub_name(
    raw: &str,
    title: &str,
    hash: &str,
    used: &mut BTreeSet<String>,
) -> String {
    let raw = if raw.trim().is_empty() { title } else { raw };
    let raw = if raw.to_ascii_lowercase().ends_with(".epub") {
        &raw[..raw.len() - 5]
    } else {
        raw
    };
    let stem: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(80)
        .collect();
    let stem = stem.trim_matches([' ', '.']);
    let reserved = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let numbered = reserved
        .strip_prefix("COM")
        .or_else(|| reserved.strip_prefix("LPT"));
    let reserved = matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || numbered.is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    let stem = if stem.is_empty() || reserved {
        format!("book-{}", &hash[..12])
    } else {
        stem.to_string()
    };
    let mut name = format!("{stem}.epub");
    let mut suffix = 0;
    while !used.insert(name.to_lowercase()) {
        suffix += 1;
        name = format!("{stem}-{}-{suffix}.epub", &hash[..12]);
    }
    name
}

fn copy_verified(
    source: &mut File,
    destination: &mut impl Write,
    book: &SourceBook,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(u64),
) -> Result<u64, SaveFileError> {
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(SaveFileError::cancelled());
        }
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        // A growing source must not run past the accepted space/length budget.
        if read as u64 > book.bytes.saturating_sub(copied) {
            return Err(SaveFileError::new(
                "source-changed",
                "源书籍在导出期间发生变化",
            ));
        }
        destination.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        copied += read as u64;
        progress(read as u64);
    }
    if copied != book.bytes || format!("{:x}", hasher.finalize()) != book.hash {
        return Err(SaveFileError::new(
            "source-changed",
            "源书籍与书架中的内容指纹不一致",
        ));
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }
    Ok(copied)
}

pub(super) fn write_output(
    file: File,
    plans: &[SourceBook],
    zip: bool,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<WrittenOutput, SaveFileError> {
    let mut output = WrittenOutput {
        books: Vec::new(),
        book_bytes: 0,
        skipped: Vec::new(),
    };
    let mut archive = if zip {
        Some(ZipWriter::new(file.try_clone()?))
    } else {
        None
    };
    let mut raw = file;
    let mut used = BTreeSet::new();
    for book in plans {
        if cancelled.load(Ordering::Acquire) {
            return Err(SaveFileError::cancelled());
        }
        // Open only one source at a time, including thousand-book batches.
        let mut source = match File::open(&book.path) {
            Ok(source) => source,
            Err(error) => {
                output.skipped.push(SkippedBook {
                    content_hash: book.hash.clone(),
                    title: book.title.clone(),
                    reason: if error.kind() == std::io::ErrorKind::NotFound {
                        "source-missing"
                    } else {
                        "source-unreadable"
                    }
                    .into(),
                });
                continue;
            }
        };
        let name = safe_epub_name(&book.file_name, &book.title, &book.hash, &mut used);
        let count = if let Some(archive) = archive.as_mut() {
            archive.start_file(
                &name,
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .large_file(book.bytes >= u32::MAX as u64),
            )?;
            // Once an entry has started, failure aborts the WHOLE unpublished
            // output: no corrupt partial entry is presented as a good ZIP.
            copy_verified(&mut source, archive, book, cancelled, &mut progress)?
        } else {
            copy_verified(&mut source, &mut raw, book, cancelled, &mut progress)?
        };
        output.book_bytes += count;
        output.books.push(ExportedBook {
            content_hash: book.hash.clone(),
            file_name: name,
        });
    }
    if output.books.is_empty() {
        return Ok(output);
    }
    if let Some(archive) = archive {
        archive.finish()?.sync_all()?;
    } else {
        raw.sync_all()?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "epub-original-export-{}",
                crate::save_file::new_uuid().unwrap()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn book(&self, name: &str, bytes: &[u8]) -> SourceBook {
            let hash = format!("{:x}", Sha256::digest(bytes));
            let path = self.0.join(&hash);
            std::fs::write(&path, bytes).unwrap();
            SourceBook {
                hash,
                path,
                title: "synthetic".into(),
                file_name: name.into(),
                bytes: bytes.len() as u64,
            }
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn raw_export_preserves_original_bytes_and_zip_has_only_portable_epubs() {
        let temp = Temp::new();
        let a = temp.book("BOOK.epub", b"original byte stream A");
        let b = temp.book("book.epub", b"original byte stream B");
        let raw = temp.0.join("raw.epub");
        let written = write_output(
            File::create(&raw).unwrap(),
            &[a],
            false,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(&raw).unwrap(), b"original byte stream A");
        assert_eq!(written.books.len(), 1);
        let a = temp.book("BOOK.epub", b"original byte stream A");
        let output = temp.0.join("many.zip");
        let written = write_output(
            File::create(&output).unwrap(),
            &[a, b],
            true,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(written.books.len(), 2);
        assert_ne!(
            written.books[0].file_name.to_lowercase(),
            written.books[1].file_name.to_lowercase()
        );
        let mut zip = zip::ZipArchive::new(File::open(output).unwrap()).unwrap();
        assert_eq!(zip.len(), 2);
        for i in 0..2 {
            let mut entry = zip.by_index(i).unwrap();
            assert_eq!(entry.compression(), CompressionMethod::Stored);
            assert!(entry.name().ends_with(".epub"));
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(bytes)),
                written.books[i].content_hash
            );
        }
    }

    #[test]
    fn portable_names_handle_device_names_paths_unicode_and_collisions() {
        let mut used = BTreeSet::new();
        let hash = "a".repeat(64);
        for name in [
            "CON.epub",
            "COM¹.epub",
            "../a:b?c|*.epub",
            ". .epub",
            "A.epub",
            "a.epub",
            "a.epub",
        ] {
            let safe = safe_epub_name(name, "", &hash, &mut used);
            assert!(!safe.chars().any(|c| "\\/:*?\"<>|".contains(c)));
            assert!(safe.ends_with(".epub"));
            assert!(!safe.starts_with('.'));
        }
        assert_eq!(used.len(), 7);
        let long = safe_epub_name(&"字".repeat(1000), "", &hash, &mut used);
        assert!(long.encode_utf16().count() < 255);
    }

    #[test]
    fn missing_sources_are_skipped_but_changed_or_cancelled_stream_aborts() {
        let temp = Temp::new();
        let a = temp.book("a.epub", b"original");
        std::fs::remove_file(&a.path).unwrap();
        let written = write_output(
            File::create(temp.0.join("empty.zip")).unwrap(),
            &[a],
            true,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(written.books.is_empty());
        assert_eq!(written.skipped[0].reason, "source-missing");
        let mut a = temp.book("a.epub", b"original");
        a.hash = "a".repeat(64);
        assert_eq!(
            write_output(
                File::create(temp.0.join("bad.zip")).unwrap(),
                &[a],
                true,
                &AtomicBool::new(false),
                |_| {}
            )
            .err()
            .unwrap()
            .code,
            "source-changed"
        );
        let a = temp.book("a.epub", b"original");
        let cancelled = AtomicBool::new(false);
        let error = write_output(
            File::create(temp.0.join("cancel.zip")).unwrap(),
            &[a],
            true,
            &cancelled,
            |_| {
                cancelled.store(true, Ordering::Release);
            },
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "cancelled");
    }
}
