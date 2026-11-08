//! Bounded source windows and one-shot materialization.
//!
//! The adapter never accepts a whole-book `Vec<u8>` from JavaScript. It owns a
//! byte-bounded reader (a whole regular file, an Android-style `base + length`
//! window, or a caller-provided reader) and copies exactly that window to an
//! owned anonymous temporary stream. libmobi then reads that stream through a
//! platform handle, so Windows never receives a narrow Unicode path and a
//! sliced source can never read past its explicit length.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{MobiError, Result};
use crate::Limits;

/// One-shot bounded source for `inspect` or `convert`.
///
/// Whole-file and window constructors verify the declared bounds against the
/// real file length up front. `from_reader` is for callers that already own a
/// bounded stream; it reads exactly `length` bytes and fails if the stream ends
/// early.
pub struct Source {
    reader: Box<dyn Read + Send>,
    length: u64,
    label: String,
}

impl std::fmt::Debug for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Source")
            .field("length", &self.length)
            .field("label", &self.label)
            .finish()
    }
}

impl Source {
    /// Own a whole regular file. The file is rewound before materialization.
    pub fn from_file(mut file: File) -> Result<Self> {
        let metadata = file
            .metadata()
            .map_err(|error| MobiError::io("read source metadata", error))?;
        if !metadata.is_file() {
            return Err(MobiError::source(
                "source must be a regular file (or use a bounded reader)",
            ));
        }
        let length = metadata.len();
        if length == 0 {
            return Err(MobiError::source("source file is empty"));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|error| MobiError::io("rewind source", error))?;
        Ok(Self {
            reader: Box::new(file),
            length,
            label: "regular file".to_string(),
        })
    }

    /// Open a path with Rust's Unicode-aware path handling, then treat it as a
    /// whole regular file.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let file = File::open(path)
            .map_err(|error| MobiError::io(&format!("open {}", path.display()), error))?;
        Self::from_file(file)
    }

    /// A bounded window inside an owned file, e.g. an Android SAF descriptor
    /// whose real content starts at `offset` with an explicit `length`.
    pub fn from_file_window(mut file: File, offset: u64, length: u64) -> Result<Self> {
        if length == 0 {
            return Err(MobiError::source("bounded source length is zero"));
        }
        let end = offset
            .checked_add(length)
            .ok_or_else(|| MobiError::source("source window offset/length overflow"))?;
        let file_len = file
            .metadata()
            .map_err(|error| MobiError::io("read source metadata", error))?
            .len();
        if end > file_len {
            return Err(MobiError::source(format!(
                "source window {offset}..{end} exceeds file length {file_len}"
            )));
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| MobiError::io("seek source window", error))?;
        Ok(Self {
            reader: Box::new(file),
            length,
            label: format!("file window {offset}..{end}"),
        })
    }

    /// Caller-owned bounded stream. The caller must guarantee that at least
    /// `length` bytes are available; the adapter never reads beyond it.
    pub fn from_reader(reader: Box<dyn Read + Send>, length: u64) -> Result<Self> {
        if length == 0 {
            return Err(MobiError::source("bounded reader length is zero"));
        }
        Ok(Self {
            reader,
            length,
            label: "bounded reader".to_string(),
        })
    }

    /// Declared number of bytes in this source window.
    pub fn len(&self) -> u64 {
        self.length
    }

    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    /// Copy exactly the declared window to an owned anonymous temp file.
    ///
    /// The temp file is deleted by the OS when the returned `File` is dropped.
    /// No whole-book `Vec` is created here.
    pub(crate) fn materialize(mut self, limits: &Limits) -> Result<File> {
        if self.length > limits.max_source_bytes {
            return Err(MobiError::budget(format!(
                "source is {} bytes, limit is {} bytes",
                self.length, limits.max_source_bytes
            )));
        }
        let mut temp = tempfile::tempfile()
            .map_err(|error| MobiError::io("create anonymous source stream", error))?;
        let mut remaining = self.length;
        let mut buffer = [0u8; 128 * 1024];
        while remaining > 0 {
            let want = usize::try_from(remaining.min(buffer.len() as u64))
                .map_err(|_| MobiError::internal("source chunk conversion"))?;
            let read = self
                .reader
                .read(&mut buffer[..want])
                .map_err(|error| MobiError::io("read bounded source", error))?;
            if read == 0 {
                return Err(MobiError::source(format!(
                    "{} ended before its declared {}-byte length",
                    self.label, self.length
                )));
            }
            temp.write_all(&buffer[..read])
                .map_err(|error| MobiError::io("write anonymous source stream", error))?;
            remaining -= read as u64;
        }
        temp.seek(SeekFrom::Start(0))
            .map_err(|error| MobiError::io("rewind anonymous source stream", error))?;
        Ok(temp)
    }
}

/// Checkpoints checked by the adapter around synchronous libmobi work.
///
/// `mobi_parse_rawml_opt` has no callback and cannot be interrupted. A token
/// set while it runs is observed immediately after it returns; the conversion
/// then discards the parsed data and never publishes an EPUB.
#[derive(Clone, Default)]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

impl std::fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(MobiError::cancelled())
        } else {
            Ok(())
        }
    }
}
