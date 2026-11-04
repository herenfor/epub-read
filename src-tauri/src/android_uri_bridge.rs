//! Minimal Android content-URI bridge.
//!
//! The read path opens an `AssetFileDescriptor` in read-only mode and hands
//! back the detached raw fd together with `startOffset` and `declaredLength`;
//! Rust owns the fd and limits reads to the declared range. The text-write
//! path keeps the descriptor in Kotlin and uses `AutoCloseOutputStream` so
//! close errors are observed before the command resolves.

// The consuming import pipeline is BK-2; keep this bridge warning-free while it
// is compiled but not yet called by a product command.
#![allow(dead_code)]

use serde::Deserialize;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

#[cfg(unix)]
use std::os::fd::{FromRawFd, RawFd};

const COPY_BUFFER_SIZE: usize = 64 * 1024;

#[derive(Debug)]
pub(crate) enum RestrictedReadError {
    InvalidInput(&'static str),
    AndroidBridge(String),
    Io(io::Error),
    Cancelled,
    PrematureEof { expected: u64, actual: u64 },
}

impl fmt::Display for RestrictedReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(reason) => write!(f, "invalid Android URI reader input: {reason}"),
            Self::AndroidBridge(message) => {
                write!(f, "Android URI bridge failed: {message}")
            }
            Self::Io(error) => write!(f, "Android URI reader I/O failed: {error}"),
            Self::Cancelled => write!(f, "Android URI read cancelled"),
            Self::PrematureEof { expected, actual } => write!(
                f,
                "Android URI provider ended early: expected {expected} bytes, read {actual}"
            ),
        }
    }
}

impl std::error::Error for RestrictedReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug)]
enum LimitedReadError {
    TooLarge { max: u64 },
    Read(RestrictedReadError),
}

fn command_error(code: &str, message: impl fmt::Display) -> String {
    format!("{code}: {message}")
}

/// Vec sink that enforces the caller's byte cap before every append. The
/// overflow flag is intentionally separate from I/O errors so the command can
/// return `too_large` without matching error strings.
struct LimitedVec {
    bytes: Vec<u8>,
    max_bytes: Option<u64>,
    overflowed: bool,
}

impl LimitedVec {
    fn new(max_bytes: Option<u64>) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
            overflowed: false,
        }
    }

    fn overflowed(&self) -> bool {
        self.overflowed
    }

    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for LimitedVec {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if let Some(max_bytes) = self.max_bytes {
            let current = self.bytes.len() as u64;
            if current.saturating_add(buffer.len() as u64) > max_bytes {
                self.overflowed = true;
                return Err(io::Error::new(io::ErrorKind::Other, "maxBytes exceeded"));
            }
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn read_restricted_vec(
    reader: &mut RestrictedReader,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, LimitedReadError> {
    if let Some(max_bytes) = max_bytes {
        if let Some(declared_length) = reader.declared_length() {
            if declared_length > max_bytes {
                return Err(LimitedReadError::TooLarge { max: max_bytes });
            }
        }
    }

    let mut output = LimitedVec::new(max_bytes);
    if let Err(error) = reader.copy_limited_to(&mut output, &|| false) {
        if output.overflowed() {
            return Err(LimitedReadError::TooLarge {
                max: max_bytes.unwrap_or(0),
            });
        }
        return Err(LimitedReadError::Read(error));
    }
    Ok(output.into_inner())
}

/// Response shape returned by the app-local Kotlin bridge.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenReadOnlyResponse {
    fd: Option<i32>,
    start_offset: Option<i64>,
    declared_length: Option<i64>,
    display_name: Option<String>,
}

/// A single-use, bounded adapter over a raw provider fd.
///
/// Construction only validates metadata and takes ownership. Actual seeking or
/// sequential prefix skipping is deferred to the first copy call so all
/// blocking work happens in the caller's blocking context.
pub(crate) struct RestrictedReader {
    file: File,
    start_offset: u64,
    declared_length: Option<u64>,
    prefix_skip: u64,
    prepared: bool,
    finished: bool,
    display_name: Option<String>,
}

impl RestrictedReader {
    pub(crate) fn from_file(
        file: File,
        start_offset: i64,
        declared_length: i64,
    ) -> Result<Self, RestrictedReadError> {
        if start_offset < 0 {
            return Err(RestrictedReadError::InvalidInput(
                "startOffset must be >= 0",
            ));
        }
        if declared_length < -1 {
            return Err(RestrictedReadError::InvalidInput(
                "declaredLength must be -1 or >= 0",
            ));
        }

        Ok(Self {
            file,
            start_offset: start_offset as u64,
            declared_length: if declared_length == -1 {
                None
            } else {
                Some(declared_length as u64)
            },
            prefix_skip: 0,
            prepared: false,
            finished: false,
            display_name: None,
        })
    }

    /// Takes ownership of a detached Android fd. The caller must transfer the
    /// fd exactly once; dropping the returned reader closes it.
    #[cfg(unix)]
    pub(crate) fn from_raw_fd(
        fd: RawFd,
        start_offset: i64,
        declared_length: i64,
    ) -> Result<Self, RestrictedReadError> {
        if fd < 0 {
            return Err(RestrictedReadError::InvalidInput("fd must be >= 0"));
        }
        // SAFETY: the Android bridge or a unit test transfers exactly one
        // detached descriptor and this reader owns it until drop.
        let file = unsafe { File::from_raw_fd(fd) };
        Self::from_file(file, start_offset, declared_length)
    }

    /// Provider-declared byte length, or `None` when the provider reports an
    /// unknown length (`declaredLength == -1`).
    pub(crate) fn declared_length(&self) -> Option<u64> {
        self.declared_length
    }

    pub(crate) fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    /// Open a random-access view for an original document. Copy imports keep
    /// accepting stream-only providers through `copy_limited_to`.
    pub(crate) fn into_seekable(mut self) -> Result<SeekableDocument, RestrictedReadError> {
        if self.prepared || self.finished {
            return Err(RestrictedReadError::InvalidInput("document descriptor already consumed"));
        }
        let metadata = self.file.metadata().map_err(RestrictedReadError::Io)?;
        if !metadata.is_file() {
            return Err(RestrictedReadError::InvalidInput("provider does not expose a regular file"));
        }
        let available = metadata.len().checked_sub(self.start_offset).ok_or(
            RestrictedReadError::InvalidInput("document offset exceeds file size"),
        )?;
        let length = self.declared_length.unwrap_or(available);
        if length > available {
            return Err(RestrictedReadError::InvalidInput("document range exceeds file size"));
        }
        self.file.seek(SeekFrom::Start(self.start_offset)).map_err(RestrictedReadError::Io)?;
        Ok(SeekableDocument { file: self.file, base: self.start_offset, length, position: 0 })
    }

    /// Copies exactly the declared range (or the remainder of the provider
    /// stream when `declaredLength == -1`) into `output`.
    ///
    /// The skipped prefix and the bytes after a known declared length are never
    /// written to `output`. This method performs blocking I/O and must run on a
    /// blocking worker when called from a Tauri command.
    pub(crate) fn copy_limited_to<W: Write>(
        &mut self,
        output: &mut W,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<u64, RestrictedReadError> {
        if self.finished {
            return Ok(0);
        }

        self.prepare(cancelled)?;
        let written = copy_reader_to(
            &mut self.file,
            self.prefix_skip,
            self.declared_length,
            output,
            cancelled,
        )?;
        self.finished = true;
        Ok(written)
    }

    fn prepare(&mut self, cancelled: &dyn Fn() -> bool) -> Result<(), RestrictedReadError> {
        if self.prepared {
            return Ok(());
        }
        if cancelled() {
            return Err(RestrictedReadError::Cancelled);
        }

        match self.file.seek(SeekFrom::Start(self.start_offset)) {
            Ok(_) => {
                self.prefix_skip = 0;
            }
            Err(error) if is_espipe(&error) => {
                // Non-seekable provider (pipe/socket/cloud stream). The only
                // supported fallback is sequential skipping; we never use
                // metadata/fstat size for this decision.
                self.prefix_skip = self.start_offset;
            }
            Err(error) => {
                return Err(RestrictedReadError::Io(error));
            }
        }

        self.prepared = true;
        Ok(())
    }
}

/// ZIP reads use document-relative offsets, even if the provider exports a
/// slice of a larger file. This reader exclusively owns the detached handle.
pub(crate) struct SeekableDocument {
    file: File,
    base: u64,
    length: u64,
    position: u64,
}

#[cfg(target_os = "android")]
impl SeekableDocument {
    pub(crate) fn len(&self) -> u64 { self.length }

    pub(crate) fn revision(&self) -> io::Result<DocumentRevision> {
        document_revision(&self.file)
    }

    pub(crate) fn metadata_handle(&self) -> io::Result<File> {
        self.file.try_clone()
    }
}

#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DocumentRevision {
    pub(crate) file: (u64, u64, u64),
    pub(crate) modified: (i64, i64),
    pub(crate) changed: (i64, i64),
}

#[cfg(target_os = "android")]
pub(crate) fn document_revision(file: &File) -> io::Result<DocumentRevision> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(DocumentRevision {
        file: (metadata.dev(), metadata.ino(), metadata.len()),
        modified: (metadata.mtime(), metadata.mtime_nsec()),
        changed: (metadata.ctime(), metadata.ctime_nsec()),
    })
}

impl Read for SeekableDocument {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let limit = self.length.saturating_sub(self.position).min(buffer.len() as u64) as usize;
        if limit == 0 {
            return Ok(0);
        }
        let count = self.file.read(&mut buffer[..limit])?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for SeekableDocument {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
            SeekFrom::End(delta) => self.length.checked_add_signed(delta),
        }.ok_or(io::ErrorKind::InvalidInput)?;
        let physical = self.base.checked_add(position).ok_or(io::ErrorKind::InvalidInput)?;
        self.file.seek(SeekFrom::Start(physical))?;
        self.position = position;
        Ok(position)
    }
}

#[cfg(unix)]
fn restricted_reader_from_response(
    response: OpenReadOnlyResponse,
) -> Result<RestrictedReader, RestrictedReadError> {
    let fd = match response.fd {
        Some(fd) if fd >= 0 => fd,
        Some(_) => {
            return Err(RestrictedReadError::InvalidInput(
                "Android provider returned a negative fd",
            ))
        }
        None => {
            return Err(RestrictedReadError::AndroidBridge(
                "Android provider returned no file descriptor".into(),
            ))
        }
    };
    let file = unsafe { File::from_raw_fd(fd) };
    let start_offset = response.start_offset.ok_or_else(|| {
        RestrictedReadError::AndroidBridge("Android provider omitted startOffset".into())
    })?;
    let declared_length = response.declared_length.ok_or_else(|| {
        RestrictedReadError::AndroidBridge("Android provider omitted declaredLength".into())
    })?;
    let mut reader = RestrictedReader::from_file(file, start_offset, declared_length)?;
    reader.display_name = response.display_name;
    Ok(reader)
}

fn copy_reader_to<R: Read, W: Write>(
    reader: &mut R,
    mut skip: u64,
    declared_length: Option<u64>,
    output: &mut W,
    cancelled: &dyn Fn() -> bool,
) -> Result<u64, RestrictedReadError> {
    if cancelled() {
        return Err(RestrictedReadError::Cancelled);
    }

    let mut scratch = [0_u8; COPY_BUFFER_SIZE];
    let original_skip = skip;

    while skip > 0 {
        if cancelled() {
            return Err(RestrictedReadError::Cancelled);
        }
        let chunk = std::cmp::min(skip, COPY_BUFFER_SIZE as u64) as usize;
        let read = read_retry(reader, &mut scratch[..chunk])?;
        if read == 0 {
            return Err(RestrictedReadError::PrematureEof {
                expected: original_skip,
                actual: original_skip - skip,
            });
        }
        skip -= read as u64;
    }

    let mut remaining = declared_length;
    let mut written = 0_u64;

    loop {
        if remaining == Some(0) {
            break;
        }
        if cancelled() {
            return Err(RestrictedReadError::Cancelled);
        }

        let chunk = match remaining {
            Some(remaining) => std::cmp::min(remaining, COPY_BUFFER_SIZE as u64) as usize,
            None => COPY_BUFFER_SIZE,
        };
        let read = read_retry(reader, &mut scratch[..chunk])?;
        if read == 0 {
            if let Some(expected) = declared_length {
                return Err(RestrictedReadError::PrematureEof {
                    expected,
                    actual: written,
                });
            }
            break;
        }

        output
            .write_all(&scratch[..read])
            .map_err(RestrictedReadError::Io)?;
        written += read as u64;
        if let Some(remaining) = remaining.as_mut() {
            *remaining -= read as u64;
        }
    }

    Ok(written)
}

fn read_retry<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<usize, RestrictedReadError> {
    loop {
        match reader.read(buffer) {
            Ok(read) => return Ok(read),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(RestrictedReadError::Io(error)),
        }
    }
}

#[cfg(unix)]
fn is_espipe(error: &io::Error) -> bool {
    // Linux and Android both report ESPIPE as errno 29. Keep this local to the
    // bridge instead of adding libc as a direct dependency for one errno.
    error.raw_os_error() == Some(29)
}

#[cfg(not(unix))]
fn is_espipe(_: &io::Error) -> bool {
    false
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidUriBridge";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "AndroidUriBridgePlugin";

    pub(crate) struct AndroidUriBridge<R: Runtime>(PluginHandle<R>);

    #[derive(Serialize)]
    struct OpenReadOnlyRequest<'a> {
        uri: &'a str,
    }

    #[derive(Serialize)]
    struct WriteTextRequest<'a> {
        uri: &'a str,
        text: &'a str,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WriteStagedFileRequest<'a> {
        uri: &'a str,
        source_path: &'a str,
        job_id: &'a str,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CancelWriteRequest<'a> {
        job_id: &'a str,
        cancelled: bool,
    }

    #[derive(Deserialize, Serialize)]
    struct EmptyPluginResponse {}

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct TreeDirectoryResponse {
        pub parent_display_name: String,
        pub entries: Vec<TreeEntryResponse>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct TreeEntryResponse {
        pub document_id: String,
        pub uri: String,
        pub display_name: String,
        pub mime_type: String,
        #[serde(default)]
        pub size: Option<u64>,
        pub last_modified: Option<u64>,
        pub is_directory: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PickTreeResponse {
        uri: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct QueryTreeDirectoryRequest<'a> {
        tree_uri: &'a str,
        parent_document_id: Option<&'a str>,
    }

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidUriBridge(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn open_content_uri<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
    ) -> Result<RestrictedReader, RestrictedReadError> {
        if !uri.starts_with("content://") {
            return Err(RestrictedReadError::InvalidInput(
                "only content:// URIs are accepted",
            ));
        }

        let bridge = app.state::<AndroidUriBridge<R>>();
        let response = bridge
            .0
            .run_mobile_plugin::<OpenReadOnlyResponse>("openReadOnly", OpenReadOnlyRequest { uri })
            .map_err(|error| RestrictedReadError::AndroidBridge(error.to_string()))?;
        restricted_reader_from_response(response)
    }

    /// Owned by the serialized import job. Dropping a failed preparation
    /// only releases a grant that this job introduced. Existing grants may
    /// be referenced by another book or shelf.
    pub(crate) struct PendingDocumentGrant<R: Runtime> {
        app: AppHandle<R>,
        uri: String,
        rollback: bool,
    }

    impl<R: Runtime> PendingDocumentGrant<R> {
        pub(crate) fn retain(app: &AppHandle<R>, uri: &str) -> Result<Self, RestrictedReadError> {
            if !uri.starts_with("content://") {
                return Err(RestrictedReadError::InvalidInput("only content:// URIs are accepted"));
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Reply {
                newly_retained: bool,
            }
            let bridge = app.state::<AndroidUriBridge<R>>();
            let reply = bridge.0.run_mobile_plugin::<Reply>("retainDocumentRead", OpenReadOnlyRequest { uri })
                .map_err(|error| RestrictedReadError::AndroidBridge(error.to_string()))?;
            Ok(Self { app: app.clone(), uri: uri.to_owned(), rollback: reply.newly_retained })
        }

        pub(crate) fn open(&self) -> Result<SeekableDocument, RestrictedReadError> {
            open_persisted_document(&self.app, &self.uri)
        }

        pub(crate) fn commit(mut self) {
            self.rollback = false;
        }
    }

    impl<R: Runtime> Drop for PendingDocumentGrant<R> {
        fn drop(&mut self) {
            if self.rollback {
                let bridge = self.app.state::<AndroidUriBridge<R>>();
                let _ = bridge.0.run_mobile_plugin::<EmptyPluginResponse>(
                    "releaseDocumentRead", OpenReadOnlyRequest { uri: &self.uri },
                );
            }
        }
    }

    pub(crate) fn release_document_read<R: Runtime>(app: &AppHandle<R>, uri: &str) {
        let bridge = app.state::<AndroidUriBridge<R>>();
        let _ = bridge.0.run_mobile_plugin::<EmptyPluginResponse>(
            "releaseDocumentRead", OpenReadOnlyRequest { uri },
        );
    }

    pub(crate) fn open_persisted_document<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
    ) -> Result<SeekableDocument, RestrictedReadError> {
        if !uri.starts_with("content://") {
            return Err(RestrictedReadError::InvalidInput("only content:// URIs are accepted"));
        }
        let bridge = app.state::<AndroidUriBridge<R>>();
        let response = bridge.0.run_mobile_plugin::<OpenReadOnlyResponse>(
            "openPersistedDocumentRead", OpenReadOnlyRequest { uri },
        ).map_err(|error| RestrictedReadError::AndroidBridge(error.to_string()))?;
        restricted_reader_from_response(response)?.into_seekable()
    }

    pub(crate) fn read_content_uri_blocking<R: Runtime>(
        app: &AppHandle<R>,
        uri: String,
        max_bytes: Option<u64>,
    ) -> Result<Vec<u8>, String> {
        let mut reader = open_content_uri(app, &uri)
            .map_err(|error| super::command_error("open_failed", error))?;
        super::read_restricted_vec(&mut reader, max_bytes).map_err(|error| match error {
            super::LimitedReadError::TooLarge { max } => {
                super::command_error("too_large", format!("content exceeds maxBytes limit {max}"))
            }
            super::LimitedReadError::Read(error) => super::command_error("read_failed", error),
        })
    }

    pub(crate) fn write_text_content_uri_blocking<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
        text: &str,
    ) -> Result<(), String> {
        let bridge = app.state::<AndroidUriBridge<R>>();
        bridge
            .0
            .run_mobile_plugin::<EmptyPluginResponse>("writeText", WriteTextRequest { uri, text })
            .map(|_| ())
            .map_err(|error| super::command_error("write_failed", error.to_string()))
    }

    pub(crate) fn write_staged_file_blocking<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
        source_path: &std::path::Path,
        job_id: &str,
    ) -> Result<(), String> {
        if !uri.starts_with("content://") {
            return Err(super::command_error(
                "invalid_request",
                "only content:// URIs are accepted",
            ));
        }
        let source = source_path.to_string_lossy();
        let bridge = app.state::<AndroidUriBridge<R>>();
        bridge
            .0
            .run_mobile_plugin::<EmptyPluginResponse>(
                "writeStagedFile",
                WriteStagedFileRequest {
                    uri,
                    source_path: &source,
                    job_id,
                },
            )
            .map(|_| ())
            .map_err(|error| super::command_error("write_failed", error.to_string()))
    }

    /// Only called for an output the system picker declared newly created.
    pub(crate) fn delete_created_document_blocking<R: Runtime>(app: &AppHandle<R>, uri: &str) -> Result<(), String> {
        let bridge = app.state::<AndroidUriBridge<R>>();
        bridge.0.run_mobile_plugin::<EmptyPluginResponse>("deleteCreatedDocument", OpenReadOnlyRequest { uri })
            .map(|_| ()).map_err(|error| super::command_error("cleanup_failed", error.to_string()))
    }

    pub(crate) fn cancel_write_blocking<R: Runtime>(
        app: &AppHandle<R>,
        job_id: &str,
        cancelled: bool,
    ) -> Result<(), String> {
        let bridge = app.state::<AndroidUriBridge<R>>();
        bridge
            .0
            .run_mobile_plugin::<EmptyPluginResponse>(
                "cancelWrite",
                CancelWriteRequest { job_id, cancelled },
            )
            .map(|_| ())
            .map_err(|error| super::command_error("cancel_failed", error.to_string()))
    }

    pub(crate) fn pick_link_documents<R: Runtime>(
        app: &AppHandle<R>,
    ) -> Result<Vec<crate::linked_library::DocumentSelection>, String> {
        #[derive(Deserialize)]
        struct Reply {
            documents: Vec<crate::linked_library::DocumentSelection>,
        }
        app.state::<AndroidUriBridge<R>>().0
            .run_mobile_plugin::<Reply>("pickLinkDocuments", EmptyPluginResponse {})
            .map(|reply| reply.documents)
            .map_err(|error| super::command_error("pick_failed", error.to_string()))
    }

    pub(crate) fn pick_directory_tree<R: Runtime>(
        app: &AppHandle<R>,
    ) -> Result<Option<String>, String> {
        pick_tree(app, "pickDirectoryTree")
    }

    pub(crate) fn pick_watched_directory<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
        pick_tree(app, "pickWatchedDirectory")
    }

    pub(crate) fn release_watched_directory<R: Runtime>(app: &AppHandle<R>, uri: &str) {
        let bridge = app.state::<AndroidUriBridge<R>>();
        let _ = bridge.0.run_mobile_plugin::<EmptyPluginResponse>(
            "releaseWatchedDirectory", OpenReadOnlyRequest { uri }
        );
    }

    fn pick_tree<R: Runtime>(app: &AppHandle<R>, command: &str) -> Result<Option<String>, String> {
        let bridge = app.state::<AndroidUriBridge<R>>();
        let response = bridge
            .0
            .run_mobile_plugin::<PickTreeResponse>(command, EmptyPluginResponse {})
            .map_err(|error| super::command_error("pick_failed", error.to_string()))?;
        Ok(response.uri)
    }

    pub(crate) fn query_tree_directory<R: Runtime>(
        app: &AppHandle<R>,
        tree_uri: &str,
        parent_document_id: Option<&str>,
    ) -> Result<TreeDirectoryResponse, String> {
        if !tree_uri.starts_with("content://") {
            return Err(super::command_error(
                "invalid_request",
                "only content:// tree URIs are accepted",
            ));
        }
        let bridge = app.state::<AndroidUriBridge<R>>();
        bridge
            .0
            .run_mobile_plugin::<TreeDirectoryResponse>(
                "queryTreeDirectory",
                QueryTreeDirectoryRequest {
                    tree_uri,
                    parent_document_id,
                },
            )
            .map_err(|error| super::command_error("query_failed", error.to_string()))
    }
}

#[cfg(target_os = "android")]
#[allow(unused_imports)]
pub(crate) use android::{
    cancel_write_blocking, delete_created_document_blocking, open_content_uri, pick_directory_tree, pick_watched_directory, release_watched_directory, plugin,
    query_tree_directory, read_content_uri_blocking, write_staged_file_blocking,
    PendingDocumentGrant, open_persisted_document, release_document_read,
    write_text_content_uri_blocking,
};

#[tauri::command]
pub async fn android_pick_link_documents(
    app: tauri::AppHandle,
) -> Result<Vec<crate::linked_library::DocumentSelection>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(command_error("unsupported_platform", "document picker is only available on Android"))
    }
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::pick_link_documents(&app))
            .await
            .map_err(|error| command_error("pick_failed", error))?
    }
}

#[tauri::command]
pub async fn android_read_content_uri(
    app: tauri::AppHandle,
    uri: String,
    max_bytes: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri, max_bytes);
        return Err(command_error(
            "unsupported_platform",
            "content URI reads are only available on Android",
        ));
    }

    #[cfg(target_os = "android")]
    {
        if !uri.starts_with("content://") {
            return Err(command_error(
                "invalid_request",
                "only content:// URIs are accepted",
            ));
        }
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            android::read_content_uri_blocking(&app, uri, max_bytes)
        })
        .await
        .map_err(|error| command_error("read_failed", format!("worker join failed: {error}")))??;
        Ok(tauri::ipc::Response::new(bytes))
    }
}

#[tauri::command]
pub async fn android_write_text_content_uri(
    app: tauri::AppHandle,
    uri: String,
    text: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri, text);
        return Err(command_error(
            "unsupported_platform",
            "content URI writes are only available on Android",
        ));
    }

    #[cfg(target_os = "android")]
    {
        if !uri.starts_with("content://") {
            return Err(command_error(
                "invalid_request",
                "only content:// URIs are accepted",
            ));
        }
        tauri::async_runtime::spawn_blocking(move || {
            android::write_text_content_uri_blocking(&app, &uri, &text)
        })
        .await
        .map_err(|error| command_error("write_failed", format!("worker join failed: {error}")))??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[cfg(unix)]
    use std::os::unix::io::IntoRawFd;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "epub-reader-uri-bridge-{label}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn never_cancelled() -> impl Fn() -> bool {
        || false
    }

    #[cfg(unix)]
    fn local_reader(
        bytes: &[u8],
        start_offset: i64,
        declared_length: i64,
    ) -> (PathBuf, RestrictedReader) {
        let path = temp_path("regular");
        fs::write(&path, bytes).unwrap();
        let file = File::open(&path).unwrap();
        let reader =
            RestrictedReader::from_raw_fd(file.into_raw_fd(), start_offset, declared_length)
                .unwrap();
        (path, reader)
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_reads_absolute_offset_and_known_length() {
        let path = temp_path("range");
        fs::write(&path, b"0123456789").unwrap();
        let file = File::open(&path).unwrap();
        let mut reader = RestrictedReader::from_raw_fd(file.into_raw_fd(), 3, 4).unwrap();
        let mut output = Vec::new();
        assert_eq!(
            reader
                .copy_limited_to(&mut output, &never_cancelled())
                .unwrap(),
            4
        );
        assert_eq!(output, b"3456");

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_reads_unknown_length_to_eof() {
        let (path, mut reader) = local_reader(b"0123456789", 4, -1);
        let mut output = Vec::new();
        assert_eq!(
            reader
                .copy_limited_to(&mut output, &never_cancelled())
                .unwrap(),
            6
        );
        assert_eq!(output, b"456789");

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn known_length_early_eof_is_an_error() {
        let (path, mut reader) = local_reader(b"abc", 1, 5);
        let mut output = Vec::new();
        let error = reader
            .copy_limited_to(&mut output, &never_cancelled())
            .unwrap_err();
        assert!(matches!(
            error,
            RestrictedReadError::PrematureEof {
                expected: 5,
                actual: 2
            }
        ));
        assert_eq!(output, b"bc");

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn non_seekable_stream_skips_prefix_and_limits_length() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;

        let (read_end, mut write_end) = UnixStream::pair().unwrap();
        write_end.write_all(b"prefixDATAtail").unwrap();
        drop(write_end);

        // This is a socket stream: fstat size is unrelated to the payload and
        // the reader never consults it.
        let mut reader = RestrictedReader::from_raw_fd(read_end.into_raw_fd(), 6, 4).unwrap();
        let mut output = Vec::new();
        assert_eq!(
            reader
                .copy_limited_to(&mut output, &never_cancelled())
                .unwrap(),
            4
        );
        assert_eq!(output, b"DATA");
    }

    #[cfg(unix)]
    #[test]
    fn non_seekable_stream_unknown_length_skips_prefix_and_reads_to_eof() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;

        let (read_end, mut write_end) = UnixStream::pair().unwrap();
        write_end.write_all(b"prefixDATA-tail").unwrap();
        drop(write_end);

        let mut reader = RestrictedReader::from_raw_fd(read_end.into_raw_fd(), 6, -1).unwrap();
        let mut output = Vec::new();
        assert_eq!(
            reader
                .copy_limited_to(&mut output, &never_cancelled())
                .unwrap(),
            9
        );
        assert_eq!(output, b"DATA-tail");
    }

    #[cfg(unix)]
    #[test]
    fn invalid_fd_offset_and_length_are_rejected_without_opening() {
        assert!(matches!(
            RestrictedReader::from_raw_fd(-1, 0, -1),
            Err(RestrictedReadError::InvalidInput(_))
        ));
        let (path, mut reader) = local_reader(b"abc", 0, 1);
        assert!(matches!(
            RestrictedReader::from_file(File::open(&path).unwrap(), -1, 1),
            Err(RestrictedReadError::InvalidInput(_))
        ));
        assert!(matches!(
            RestrictedReader::from_file(File::open(&path).unwrap(), 0, -2),
            Err(RestrictedReadError::InvalidInput(_))
        ));
        let mut output = Vec::new();
        assert_eq!(
            reader
                .copy_limited_to(&mut output, &never_cancelled())
                .unwrap(),
            1
        );
        assert_eq!(output, b"a");

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn c7_reader_carries_display_name_and_accepts_old_bridge_metadata() {
        let path = temp_path("c7-display-name");
        fs::write(&path, b"abc").unwrap();
        for name in [Some("繁體原名 ? #.epub"), None] {
            let fd = File::open(&path).unwrap().into_raw_fd();
            let mut payload =
                serde_json::json!({ "fd": fd, "startOffset": 0, "declaredLength": 3 });
            if let Some(name) = name {
                payload["displayName"] = name.into();
            }
            let response = serde_json::from_value(payload).unwrap();
            let mut reader = restricted_reader_from_response(response).unwrap();
            assert_eq!(reader.display_name(), name);
            let mut bytes = Vec::new();
            reader
                .copy_limited_to(&mut bytes, &never_cancelled())
                .unwrap();
            assert_eq!(bytes, b"abc");
        }
        fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn missing_response_fields_are_errors() {
        assert!(matches!(
            restricted_reader_from_response(OpenReadOnlyResponse {
                fd: None,
                start_offset: Some(0),
                declared_length: Some(0),
                display_name: None,
            }),
            Err(RestrictedReadError::AndroidBridge(_))
        ));

        let path = temp_path("missing-offset");
        fs::write(&path, b"abc").unwrap();
        let fd = File::open(&path).unwrap().into_raw_fd();
        assert!(matches!(
            restricted_reader_from_response(OpenReadOnlyResponse {
                fd: Some(fd),
                start_offset: None,
                declared_length: Some(1),
                display_name: None,
            }),
            Err(RestrictedReadError::AndroidBridge(_))
        ));
        // The helper above must have closed its owned fd on the error path.
        // Opening and removing the file succeeds independently of that fd.
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn copy_checks_cancellation_before_and_between_reads() {
        let flag = AtomicBool::new(true);
        let mut reader = Cursor::new(b"abcdef");
        let mut output = Vec::new();
        let error = copy_reader_to(&mut reader, 0, None, &mut output, &|| {
            flag.load(Ordering::SeqCst)
        })
        .unwrap_err();
        assert!(matches!(error, RestrictedReadError::Cancelled));
        assert!(output.is_empty());
    }

    #[test]
    fn copy_checks_cancellation_during_data_read() {
        struct CancelAfterRead<'a> {
            cursor: Cursor<&'a [u8]>,
            flag: &'a AtomicBool,
        }
        impl Read for CancelAfterRead<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let read = self.cursor.read(buffer)?;
                if read > 0 {
                    self.flag.store(true, Ordering::SeqCst);
                }
                Ok(read)
            }
        }

        let flag = AtomicBool::new(false);
        let mut reader = CancelAfterRead {
            cursor: Cursor::new(&b"abcdef"[..]),
            flag: &flag,
        };
        let mut output = Vec::new();
        let error = copy_reader_to(&mut reader, 0, None, &mut output, &|| {
            flag.load(Ordering::SeqCst)
        })
        .unwrap_err();
        assert!(matches!(error, RestrictedReadError::Cancelled));
        assert_eq!(output, b"abcdef");
    }

    #[test]
    fn copy_checks_cancellation_during_prefix_skip() {
        struct CancelAfterRead<'a> {
            cursor: Cursor<&'a [u8]>,
            flag: &'a AtomicBool,
        }
        impl Read for CancelAfterRead<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let read = self.cursor.read(buffer)?;
                if read > 0 {
                    self.flag.store(true, Ordering::SeqCst);
                }
                Ok(read)
            }
        }

        let flag = AtomicBool::new(false);
        let mut reader = CancelAfterRead {
            cursor: Cursor::new(&b"prefixDATA"[..]),
            flag: &flag,
        };
        let mut output = Vec::new();
        let error = copy_reader_to(&mut reader, 6, None, &mut output, &|| {
            flag.load(Ordering::SeqCst)
        })
        .unwrap_err();
        assert!(matches!(error, RestrictedReadError::Cancelled));
        assert!(output.is_empty());
    }

    #[test]
    fn copy_retries_interrupted_reads() {
        struct InterruptOnce {
            cursor: Cursor<&'static [u8]>,
            interrupted: bool,
        }
        impl Read for InterruptOnce {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "retry"));
                }
                self.cursor.read(buffer)
            }
        }

        let mut reader = InterruptOnce {
            cursor: Cursor::new(b"ok"),
            interrupted: false,
        };
        let mut output = Vec::new();
        assert_eq!(
            copy_reader_to(&mut reader, 0, None, &mut output, &never_cancelled()).unwrap(),
            2
        );
        assert_eq!(output, b"ok");
    }

    #[cfg(unix)]
    #[test]
    fn bk5_read_known_length_with_max_bytes_keeps_range() {
        let (path, mut reader) = local_reader(b"0123456789", 3, 4);
        assert_eq!(read_restricted_vec(&mut reader, Some(4)).unwrap(), b"3456");
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn bk5_read_known_length_over_max_is_rejected_before_copy() {
        let (path, mut reader) = local_reader(b"0123456789", 3, 4);
        let error = read_restricted_vec(&mut reader, Some(3)).unwrap_err();
        assert!(matches!(error, LimitedReadError::TooLarge { max: 3 }));
        // A rejected known-length read must not have consumed the range.
        assert_eq!(read_restricted_vec(&mut reader, Some(4)).unwrap(), b"3456");
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn bk5_read_unknown_length_exactly_max_succeeds() {
        let (path, mut reader) = local_reader(b"0123456789", 4, -1);
        assert_eq!(
            read_restricted_vec(&mut reader, Some(6)).unwrap(),
            b"456789"
        );
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn bk5_read_unknown_length_over_max_is_rejected_without_partial_output() {
        let (path, mut reader) = local_reader(b"0123456789", 4, -1);
        let error = read_restricted_vec(&mut reader, Some(5)).unwrap_err();
        assert!(matches!(error, LimitedReadError::TooLarge { max: 5 }));
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn bk5_read_zero_max_allows_empty_but_rejects_non_empty() {
        let (empty_path, mut empty_reader) = local_reader(b"", 0, 0);
        assert!(read_restricted_vec(&mut empty_reader, Some(0))
            .unwrap()
            .is_empty());
        let _ = fs::remove_file(empty_path);

        let (path, mut reader) = local_reader(b"x", 0, -1);
        let error = read_restricted_vec(&mut reader, Some(0)).unwrap_err();
        assert!(matches!(error, LimitedReadError::TooLarge { max: 0 }));
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn bk5_read_premature_eof_is_read_error() {
        let (path, mut reader) = local_reader(b"abc", 1, 5);
        let error = read_restricted_vec(&mut reader, Some(32)).unwrap_err();
        assert!(matches!(
            error,
            LimitedReadError::Read(RestrictedReadError::PrematureEof {
                expected: 5,
                actual: 2
            })
        ));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bk5_command_error_uses_fixed_code_prefix() {
        assert_eq!(command_error("too_large", "x"), "too_large: x");
    }
}
