//! Targeted fixtures and boundary tests for the standalone adapter.
//!
//! Real books are supplied through environment variables so public source
//! files and upstream libmobi test fixtures stay out of the product Git tree:
//!
//! - `MOBI_ADAPTER_MOBI6`   public MOBI6 sample
//! - `MOBI_ADAPTER_KF8`     public KF8/AZW3 sample
//! - `MOBI_ADAPTER_COMBO`   combo KF7/KF8 sample (upstream test fixture)
//! - `MOBI_ADAPTER_DRM`     encrypted sample
//! - `MOBI_ADAPTER_FONTS`   KF8 sample with an obfuscated embedded font
//!
//! Tests without the relevant variable are skipped with an explanatory line.

use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use mobi_adapter::{convert, inspect, CancelToken, Limits, MobiErrorCode, Source};
use zip::CompressionMethod;

fn fixture(name: &str) -> Option<PathBuf> {
    std::env::var_os(format!("MOBI_ADAPTER_{name}"))
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

fn temp_out(dir: &Path, name: &str) -> PathBuf {
    dir.join(name)
}

fn read_zip_text(path: &Path, entry: &str) -> String {
    let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut file = archive.by_name(entry).unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    text
}

#[test]
fn inspect_public_mobi6_and_kf8() {
    if let Some(path) = fixture("MOBI6") {
        let metadata = inspect(Source::from_path(&path).unwrap(), &Limits::default()).unwrap();
        assert_eq!(metadata.format_version, 6);
        assert!(!metadata.hybrid);
        assert!(!metadata.kf8);
        assert_eq!(metadata.title, "Alice's Adventures in Wonderland");
        assert_eq!(metadata.creator, "Lewis Carroll");
        assert_eq!(metadata.language, "en");
        assert_eq!(
            metadata.cover.as_ref().map(|cover| cover.mime.as_str()),
            Some("image/jpeg")
        );
        assert!(!metadata.cover.unwrap().bytes.is_empty());
    }

    if let Some(path) = fixture("KF8") {
        let metadata = inspect(Source::from_path(&path).unwrap(), &Limits::default()).unwrap();
        assert_eq!(metadata.format_version, 8);
        assert!(metadata.kf8);
        assert!(!metadata.hybrid);
        assert_eq!(metadata.title, "Pride and Prejudice");
        assert_eq!(metadata.creator, "Jane Austen");
    }
}

#[test]
fn convert_mobi6_to_loading_epub() {
    let Some(path) = fixture("MOBI6") else {
        eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "mobi6.epub");
    let report = convert(
        Source::from_path(&path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(report.format_version, 6);
    assert_eq!(report.markup_parts, 1);
    assert_eq!(report.flow_parts, 0);
    assert!(report.resource_parts >= 2);
    assert!(report.epub_bytes > 0);

    let mut archive = zip::ZipArchive::new(File::open(&out).unwrap()).unwrap();
    let first = archive.by_index(0).unwrap();
    assert_eq!(first.name(), "mimetype");
    assert_eq!(first.compression(), CompressionMethod::Stored);
    drop(first);
    let mut mimetype = String::new();
    archive
        .by_name("mimetype")
        .unwrap()
        .read_to_string(&mut mimetype)
        .unwrap();
    assert_eq!(mimetype, "application/epub+zip");
    assert!(archive.by_name("META-INF/container.xml").is_ok());
    assert!(archive.by_name("OEBPS/content.opf").is_ok());
    let opf = read_zip_text(&out, "OEBPS/content.opf");
    assert_eq!(opf.matches("<itemref").count(), 1);
    assert!(opf.contains("part00000.html"));
}

#[test]
fn convert_kf8_spine_and_resources() {
    let Some(path) = fixture("KF8") else {
        eprintln!("skip: MOBI_ADAPTER_KF8 is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "kf8.epub");
    let report = convert(
        Source::from_path(&path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(report.format_version, 8);
    assert!(report.kf8);
    assert_eq!(report.markup_parts, 65);
    assert!(report.flow_parts >= 1);
    assert!(report.resource_parts >= 1);

    let opf = read_zip_text(&out, "OEBPS/content.opf");
    assert_eq!(opf.matches("<itemref").count(), 65);
    // The reconstructed OPF and NCX are copied, so the loader sees its usual
    // manifest/spine metadata instead of a second parser.
    assert!(opf.contains("part00000.html"));
    assert!(opf.contains("part00064.html"));
}

#[test]
fn combo_uses_kf8_and_writes_archive() {
    let Some(path) = fixture("COMBO") else {
        eprintln!("skip: MOBI_ADAPTER_COMBO is not set");
        return;
    };
    let metadata = inspect(Source::from_path(&path).unwrap(), &Limits::default()).unwrap();
    assert!(metadata.hybrid, "combo must be detected as hybrid");
    assert!(metadata.kf8, "combo must select KF8");
    assert_eq!(metadata.format_version, 8);

    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "combo.epub");
    let report = convert(
        Source::from_path(&path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert!(report.hybrid);
    assert!(report.kf8);
    assert_eq!(report.format_version, 8);
    assert!(report.markup_parts > 0);
    assert!(read_zip_text(&out, "OEBPS/content.opf").contains("<spine"));
}

#[test]
fn encrypted_and_synthetic_nonzero_encryption_are_rejected() {
    let Some(path) = fixture("DRM") else {
        eprintln!("skip: MOBI_ADAPTER_DRM is not set");
        return;
    };
    let error = inspect(Source::from_path(&path).unwrap(), &Limits::default()).unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Encrypted);
    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "drm.epub");
    let error = convert(
        Source::from_path(&path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Encrypted);
    assert!(!out.exists(), "encrypted input must not leave an output");

    if let Some(sample) = fixture("MOBI6") {
        let bytes = fs::read(&sample).unwrap();
        let record0 = u32::from_be_bytes(bytes[78..82].try_into().unwrap()) as usize;
        let mut patched = bytes;
        patched[record0 + 12..record0 + 14].copy_from_slice(&3u16.to_be_bytes());
        let synthetic = dir.path().join("synthetic-encryption-3.mobi");
        fs::write(&synthetic, patched).unwrap();
        let error =
            inspect(Source::from_path(&synthetic).unwrap(), &Limits::default()).unwrap_err();
        assert_eq!(error.code(), MobiErrorCode::Encrypted);
    }
}

#[test]
fn bounded_window_never_reads_outside_slice() {
    let Some(path) = fixture("MOBI6") else {
        eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
        return;
    };
    let sample = fs::read(&path).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let window = dir.path().join("window.bin");
    let prefix = b"prefix-garbage-that-is-not-a-pdb";
    let suffix = b"suffix-garbage";
    {
        let mut file = File::create(&window).unwrap();
        file.write_all(prefix).unwrap();
        file.write_all(&sample).unwrap();
        file.write_all(suffix).unwrap();
    }
    let file = File::open(&window).unwrap();
    let source = Source::from_file_window(file, prefix.len() as u64, sample.len() as u64).unwrap();
    let metadata = inspect(source, &Limits::default()).unwrap();
    assert_eq!(metadata.title, "Alice's Adventures in Wonderland");

    let out = temp_out(dir.path(), "window.epub");
    let file = File::open(&window).unwrap();
    let source = Source::from_file_window(file, prefix.len() as u64, sample.len() as u64).unwrap();
    convert(source, &out, &Limits::default(), &CancelToken::new()).unwrap();
    assert!(out.is_file());
}

#[test]
fn unicode_path_and_budget_and_cancel_boundaries() {
    let Some(path) = fixture("MOBI6") else {
        eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let unicode = dir.path().join("中文 目录").join("爱丽丝.mobi");
    fs::create_dir_all(unicode.parent().unwrap()).unwrap();
    fs::copy(&path, &unicode).unwrap();
    let metadata = inspect(Source::from_path(&unicode).unwrap(), &Limits::default()).unwrap();
    assert_eq!(metadata.format_version, 6);

    let low_source = Limits {
        max_source_bytes: 10,
        ..Limits::default()
    };
    let error = inspect(Source::from_path(&unicode).unwrap(), &low_source).unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Budget);

    let out = temp_out(dir.path(), "cancel.epub");
    let cancel = CancelToken::new();
    cancel.cancel();
    let error = convert(
        Source::from_path(&unicode).unwrap(),
        &out,
        &Limits::default(),
        &cancel,
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Cancelled);
    assert!(!out.exists());

    let low_part = Limits {
        max_part_bytes: 1,
        ..Limits::default()
    };
    let error = convert(
        Source::from_path(&unicode).unwrap(),
        &out,
        &low_part,
        &CancelToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Budget);
    assert!(!out.exists());

    let low_text = Limits {
        max_total_bytes: 1000,
        ..Limits::default()
    };
    let error = convert(
        Source::from_path(&unicode).unwrap(),
        &out,
        &low_text,
        &CancelToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Budget);
    assert!(!out.exists());

    let low_output = Limits {
        max_output_bytes: 1,
        ..Limits::default()
    };
    let error = convert(
        Source::from_path(&unicode).unwrap(),
        &out,
        &low_output,
        &CancelToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Budget);
    assert!(!out.exists());
}

#[test]
fn embedded_font_is_decoded_and_preserved() {
    let Some(path) = fixture("FONTS") else {
        eprintln!("skip: MOBI_ADAPTER_FONTS is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "fonts.epub");
    let report = convert(
        Source::from_path(&path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert!(report.kf8);
    let mut archive = zip::ZipArchive::new(File::open(&out).unwrap()).unwrap();
    let mut font_size = 0;
    let mut font_name = String::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).unwrap();
        if entry.name().ends_with(".otf") || entry.name().ends_with(".ttf") {
            font_name = entry.name().to_string();
            font_size = entry.size();
        }
    }
    assert!(font_name.ends_with(".otf"), "font entry missing");
    // ER-0104's miniz probe decoded this same upstream fixture to 140,948 B.
    assert_eq!(font_size, 140_948);
    let opf = read_zip_text(&out, "OEBPS/content.opf");
    assert!(opf.contains("application/vnd.ms-opentype"));
}

struct CancelDuringRead {
    inner: Cursor<Vec<u8>>,
    token: CancelToken,
    fired: bool,
}

impl Read for CancelDuringRead {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if !self.fired {
            self.fired = true;
            self.token.cancel();
        }
        self.inner.read(buffer)
    }
}

#[test]
fn cancellation_during_source_phase_publishes_nothing() {
    let Some(path) = fixture("MOBI6") else {
        eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
        return;
    };
    let bytes = fs::read(&path).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "cancel-phase.epub");
    let cancel = CancelToken::new();
    let reader = CancelDuringRead {
        inner: Cursor::new(bytes.clone()),
        token: cancel.clone(),
        fired: false,
    };
    let source = Source::from_reader(Box::new(reader), bytes.len() as u64).unwrap();
    let error = convert(source, &out, &Limits::default(), &cancel).unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Cancelled);
    assert!(
        !out.exists(),
        "cancelled source phase must not publish an EPUB"
    );
}

#[test]
fn failed_conversion_does_not_clobber_existing_destination() {
    let Some(path) = fixture("MOBI6") else {
        eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let out = temp_out(dir.path(), "existing.epub");
    fs::write(&out, b"existing reading archive").unwrap();
    let low_part = Limits {
        max_part_bytes: 1,
        ..Limits::default()
    };
    let error = convert(
        Source::from_path(&path).unwrap(),
        &out,
        &low_part,
        &CancelToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Budget);
    assert_eq!(fs::read(&out).unwrap(), b"existing reading archive");

    // A successful retry atomically replaces the placeholder.
    convert(
        Source::from_path(&path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(&fs::read(&out).unwrap()[..2], b"PK");
}

fn pdb_records(bytes: &[u8]) -> Vec<(u32, u8, [u8; 3])> {
    let count = u16::from_be_bytes(bytes[76..78].try_into().unwrap()) as usize;
    (0..count)
        .map(|index| {
            let base = 78 + index * 8;
            let offset = u32::from_be_bytes(bytes[base..base + 4].try_into().unwrap());
            let attributes = bytes[base + 4];
            let uid = [bytes[base + 5], bytes[base + 6], bytes[base + 7]];
            (offset, attributes, uid)
        })
        .collect()
}

fn write_pdb(records: &[(u32, u8, [u8; 3])], source: &[u8], table_end: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(source.len() + 8);
    bytes.extend_from_slice(&source[..78]);
    bytes[76..78].copy_from_slice(&(records.len() as u16).to_be_bytes());
    for (offset, attributes, uid) in records {
        bytes.extend_from_slice(&offset.to_be_bytes());
        bytes.push(*attributes);
        bytes.extend_from_slice(uid);
    }
    bytes.extend_from_slice(&source[table_end..]);
    bytes
}

#[test]
fn zero_length_record_is_accepted_and_invalid_offsets_rejected() {
    let Some(path) = fixture("MOBI6") else {
        eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
        return;
    };
    let source = fs::read(&path).unwrap();
    let original = pdb_records(&source);
    let table_end = 78 + original.len() * 8;

    // Codex ER-0140 counterexample shape: shift every record by the new table
    // entry, then insert one unreferenced empty record before the last record.
    let mut shifted = original
        .iter()
        .map(|(offset, attributes, uid)| (offset + 8, *attributes, *uid))
        .collect::<Vec<_>>();
    shifted.insert(
        shifted.len() - 1,
        (shifted.last().unwrap().0, 0, [0xff, 0xfe, 0xfd]),
    );
    let zero_fixture = write_pdb(&shifted, &source, table_end);

    let dir = tempfile::tempdir().unwrap();
    let zero_path = dir.path().join("zero-length-record.mobi");
    fs::write(&zero_path, &zero_fixture).unwrap();
    let metadata = inspect(Source::from_path(&zero_path).unwrap(), &Limits::default()).unwrap();
    assert_eq!(metadata.title, "Alice's Adventures in Wonderland");
    let out = dir.path().join("zero-length.epub");
    let report = convert(
        Source::from_path(&zero_path).unwrap(),
        &out,
        &Limits::default(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(report.markup_parts, 1);
    assert!(out.is_file());

    // A true descending offset must still be rejected.
    let mut descending = original.clone();
    descending[1].0 = descending[0].0 - 1;
    let descending_fixture = write_pdb(&descending, &source, table_end);
    let descending_path = dir.path().join("descending.mobi");
    fs::write(&descending_path, descending_fixture).unwrap();
    let error = inspect(
        Source::from_path(&descending_path).unwrap(),
        &Limits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Parse);

    // A last record beyond EOF is still out of bounds. All offsets are moved
    // together so earlier records are empty and the final 64-bit check is the
    // one that rejects the file.
    let mut beyond = original.clone();
    let beyond_eof = source.len() as u32 + 8;
    for record in &mut beyond {
        record.0 = beyond_eof;
    }
    let beyond_path = dir.path().join("beyond-eof.mobi");
    fs::write(&beyond_path, write_pdb(&beyond, &source, table_end)).unwrap();
    let error = inspect(Source::from_path(&beyond_path).unwrap(), &Limits::default()).unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Parse);
}

#[test]
fn repeated_conversions_release_resources() {
    let Some(path) = fixture("COMBO") else {
        eprintln!("skip: MOBI_ADAPTER_COMBO is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    for index in 0..6 {
        let out = temp_out(dir.path(), &format!("repeat-{index}.epub"));
        let report = convert(
            Source::from_path(&path).unwrap(),
            &out,
            &Limits::default(),
            &CancelToken::new(),
        )
        .unwrap();
        assert!(report.epub_bytes > 0);
        assert!(out.is_file());
    }
    let files = fs::read_dir(dir.path()).unwrap().count();
    assert_eq!(files, 6, "only the six reading archives should remain");
}

#[test]
fn invalid_and_missing_source_are_stable_errors() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.mobi");
    let error = Source::from_path(&missing).unwrap_err();
    assert_eq!(error.code(), MobiErrorCode::Io);

    let junk = dir.path().join("junk.mobi");
    fs::write(&junk, b"not a palm database at all").unwrap();
    let error = inspect(Source::from_path(&junk).unwrap(), &Limits::default()).unwrap_err();
    assert!(matches!(
        error.code(),
        MobiErrorCode::Parse | MobiErrorCode::Unsupported
    ));
}
