//! Standalone MOBI6 / KF8 (AZW3) adapter.
//!
//! Scope:
//! - read metadata and an optional cover from a bounded source;
//! - reconstruct a releasable temporary EPUB 2 reading archive that the
//!   existing EPUB loader can open;
//! - reject every encrypted file, Print Replica/AZW4, dictionaries and
//!   unsupported representation instead of falling back to MOBI6;
//! - keep the C library behind one opaque handle with RAII cleanup.
//!
//! Non-goals: application routing, database/capability versions, UI, a Kindle
//! pagination engine, DRM decryption, permanent conversion caches and
//! background conversion services. ER-0141 owns the application integration.
//!
//! ```no_run
//! use mobi_adapter::{convert, inspect, CancelToken, Limits, Source};
//! use std::path::Path;
//!
//! # fn run() -> mobi_adapter::Result<()> {
//! let metadata = inspect(Source::from_path("book.mobi")?, &Limits::default())?;
//! println!("{}", metadata.title);
//!
//! let cancel = CancelToken::new();
//! let report = convert(
//!     Source::from_path("book.mobi")?,
//!     Path::new("book.reading.epub"),
//!     &Limits::default(),
//!     &cancel,
//! )?;
//! println!("{} parts", report.markup_parts + report.flow_parts + report.resource_parts);
//! # Ok(())
//! # }
//! ```

mod epub;
mod error;
mod ffi;
mod source;

use std::path::Path;

pub use error::{MobiError, MobiErrorCode, Result};
pub use ffi::libmobi_version;
pub use source::{CancelToken, Source};

/// Per-call byte and part budget.
///
/// These are conversion-call limits, not user-facing book limits and not a
/// permanent cache policy. Callers may pass their own values; the defaults are
/// deliberately conservative for the first integration.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Maximum declared source-window size copied to the anonymous stream.
    pub max_source_bytes: u64,
    /// Maximum size of one reconstructed markup/flow/resource part.
    pub max_part_bytes: u64,
    /// Maximum sum of reconstructed part sizes.
    pub max_total_bytes: u64,
    /// Maximum final EPUB file size.
    pub max_output_bytes: u64,
    /// Maximum number of reconstructed parts.
    pub max_parts: usize,
    /// Maximum copied cover size.
    pub max_cover_bytes: u64,
    /// Maximum copied metadata string size (title/author/language each).
    pub max_metadata_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_source_bytes: 512 * 1024 * 1024,
            max_part_bytes: 256 * 1024 * 1024,
            max_total_bytes: 1024 * 1024 * 1024,
            max_output_bytes: 1024 * 1024 * 1024,
            max_parts: 4096,
            max_cover_bytes: 16 * 1024 * 1024,
            max_metadata_bytes: 64 * 1024,
        }
    }
}

/// Image cover copied out of the source record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cover {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// Metadata from the selected (KF8 for combo) representation.
#[derive(Clone, Debug, Default)]
pub struct MobiMetadata {
    pub title: String,
    pub creator: String,
    pub language: String,
    pub format_version: u32,
    pub compression: u32,
    /// Combo/hybrid file; the KF8 part was selected.
    pub hybrid: bool,
    /// Active representation is KF8.
    pub kf8: bool,
    pub cover: Option<Cover>,
}

/// Result of one successful conversion.
#[derive(Clone, Debug)]
pub struct ConversionReport {
    pub format_version: u32,
    pub compression: u32,
    pub hybrid: bool,
    pub kf8: bool,
    pub record_count: u32,
    /// PalmDOC header's declared uncompressed text length.
    pub text_length: u64,
    pub markup_parts: usize,
    pub flow_parts: usize,
    pub resource_parts: usize,
    pub uncompressed_part_bytes: u64,
    pub source_bytes: u64,
    pub epub_bytes: u64,
}

/// Read metadata and cover without reconstructing rawml or writing an EPUB.
///
/// The source is materialized only for the duration of the call and is
/// dropped afterwards. It is not a permanent cache.
pub fn inspect(source: Source, limits: &Limits) -> Result<MobiMetadata> {
    let temp = source.materialize(limits)?;
    let handle = ffi::Handle::open(temp)?;
    let info = handle.info()?;
    let title = handle.title(limits.max_metadata_bytes)?;
    let creator = handle.author(limits.max_metadata_bytes)?;
    let language = handle.language(limits.max_metadata_bytes)?;
    let cover = handle.cover(limits.max_cover_bytes)?;
    Ok(ffi::metadata_from_info(
        info, title, creator, language, cover,
    ))
}

/// Parse the selected representation and write one temporary reading EPUB.
///
/// The destination is written through a same-directory temporary file and
/// renamed only after the ZIP and all budgets pass. A cancelled or failed
/// conversion leaves no destination file. Cancellation is checked at phase
/// boundaries and before each part; libmobi's synchronous rawml parse itself
/// cannot be interrupted.
pub fn convert(
    source: Source,
    dest: &Path,
    limits: &Limits,
    cancel: &CancelToken,
) -> Result<ConversionReport> {
    cancel.check()?;
    let source_bytes = source.len();
    let temp = source.materialize(limits)?;
    cancel.check()?;
    let mut handle = ffi::Handle::open(temp)?;
    cancel.check()?;
    let info = handle.info()?;
    if info.text_length > limits.max_total_bytes {
        return Err(MobiError::budget(format!(
            "declared text is {} bytes, limit is {}",
            info.text_length, limits.max_total_bytes
        )));
    }
    handle.parse()?;
    cancel.check()?;
    let mut report = epub::write_epub(&handle, dest, limits, cancel)?;
    report.source_bytes = source_bytes;
    Ok(report)
}
