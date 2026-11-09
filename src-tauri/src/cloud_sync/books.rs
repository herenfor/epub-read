//! Manual, streaming upload of original books to the existing WebDAV space.
//!
//! This is deliberately separate from the small metadata sync engine. A book
//! upload is one long, cancelable stream; it never enters `devices/`, the
//! portable state envelope, the main SQLite database, the save archive or LAN.
//! The normal sync round and the upload job can run independently.
//!
//! Frozen surface for ER-0151: `cloud_book_upload_preview`,
//! `cloud_book_upload`, `cloud_book_upload_cancel`, `cloud_book_upload_current`.
//! Objects live at `books/<sha[0..2]>/<sha>.<ext>` with a small `<sha>.ok`
//! marker; this job is one batch, one source stream, and one pending path.

use super::{
    commands, engine,
    model::{Failure, FailureCode, Result},
    remote::{
        Cancel, Capabilities, HashCheck, RemoteError, RemoteErrorCode, RemotePath, SyncRemote,
        WebDavRemote,
    },
    secrets,
    storage::Disk,
};
use crate::directory_import::job::DirectoryImportState;
use crate::linked_library::document_source::BookSource;
use crate::portable_state::{valid_canonical_uuid, valid_content_hash, BookMetadata};
use crate::save_file::{parse_bindings, LocalBinding};
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime};
use tokio::sync::mpsc;

const MAX_BOOKS: usize = 10_000;
const MARKER_FORMAT: &str = "epub-reader-cloud-book";
const MARKER_VERSION: u64 = 1;
const MARKER_LIMIT: u64 = 4096;
const CLEANUP_FILE: &str = "book-upload-cleanup.json";
const CLEANUP_LIMIT: usize = 16;
const CLEANUP_BYTES: usize = 8192;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUploadPreview {
    pub books: Vec<BookUploadPreviewBook>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUploadPreviewBook {
    pub content_hash: String,
    pub title: String,
    pub file_name: String,
    pub bytes: u64,
    pub ready: bool,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUploadProgress {
    pub job_id: String,
    pub connection_id: String,
    pub phase: String,
    pub index: usize,
    pub count: usize,
    pub content_hash: String,
    pub book_sent: u64,
    pub book_total: u64,
    pub batch_sent: u64,
    pub batch_total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUploadItem {
    pub content_hash: String,
    pub title: String,
    pub outcome: String,
    pub code: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUploadResult {
    pub job_id: String,
    pub connection_id: String,
    pub status: String,
    pub books: Vec<BookUploadItem>,
    pub uploaded: usize,
    pub already_present: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub not_attempted: usize,
    pub cleanup_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBookUpload {
    pub job_id: String,
    pub connection_id: String,
    pub progress: Option<BookUploadProgress>,
}

pub struct CloudBookUploadManager {
    job: Mutex<Option<Arc<UploadJob>>>,
}

impl Default for CloudBookUploadManager {
    fn default() -> Self {
        Self {
            job: Mutex::new(None),
        }
    }
}

struct UploadJob {
    job_id: String,
    connection_id: String,
    cancel: Cancel,
    latest: Mutex<Option<BookUploadProgress>>,
}

impl CloudBookUploadManager {
    fn start(&self, job: Arc<UploadJob>) -> Result<()> {
        let mut slot = self
            .job
            .lock()
            .map_err(|_| Failure::new(FailureCode::StorageError))?;
        if slot.is_some() {
            return Err(Failure::new(FailureCode::Busy));
        }
        *slot = Some(job);
        Ok(())
    }

    fn clear(&self, job_id: &str) {
        if let Ok(mut slot) = self.job.lock() {
            if slot.as_ref().is_some_and(|job| job.job_id == job_id) {
                *slot = None;
            }
        }
    }

    fn cancel(&self, job_id: &str) -> bool {
        if let Ok(slot) = self.job.lock() {
            if let Some(job) = slot.as_ref().filter(|job| job.job_id == job_id) {
                job.cancel.cancel();
                return true;
            }
        }
        false
    }

    fn current(&self) -> Option<CurrentBookUpload> {
        let slot = self.job.lock().ok()?;
        let job = slot.as_ref()?;
        Some(CurrentBookUpload {
            job_id: job.job_id.clone(),
            connection_id: job.connection_id.clone(),
            progress: job.latest.lock().ok().and_then(|p| p.clone()),
        })
    }
}

struct ActiveJob<R: Runtime> {
    app: AppHandle<R>,
    job_id: String,
    cancel: Cancel,
}

impl<R: Runtime> Drop for ActiveJob<R> {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(manager) = self.app.try_state::<CloudBookUploadManager>() {
            manager.clear(&self.job_id);
        }
    }
}

pub(crate) fn cancel_active<R: Runtime>(app: &AppHandle<R>) {
    if let Some(manager) = app.try_state::<CloudBookUploadManager>() {
        if let Ok(slot) = manager.job.lock() {
            if let Some(job) = slot.as_ref() {
                job.cancel.cancel();
            }
        }
    }
}

struct UploadStart<R: Runtime> {
    job: Arc<UploadJob>,
    _active: ActiveJob<R>,
}

fn start_upload_job<R: Runtime>(
    app: &AppHandle<R>,
    job_id: String,
    connection_id: String,
    count: usize,
    epoch: u64,
) -> Result<UploadStart<R>> {
    commands::check_upload_start(app, &connection_id, epoch)?;
    let job = Arc::new(UploadJob {
        job_id: job_id.clone(),
        connection_id: connection_id.clone(),
        cancel: Cancel::default(),
        latest: Mutex::new(Some(BookUploadProgress {
            job_id: job_id.clone(),
            connection_id: connection_id.clone(),
            phase: "preparing".into(),
            index: 0,
            count,
            content_hash: String::new(),
            book_sent: 0,
            book_total: 0,
            batch_sent: 0,
            batch_total: 0,
        })),
    });
    app.state::<CloudBookUploadManager>().start(job.clone())?;
    let active = ActiveJob {
        app: app.clone(),
        job_id: job_id.clone(),
        cancel: job.cancel.clone(),
    };
    // The job is now visible to `cancel_active`. Re-check the generation so a
    // background/admin/connection transition that happened between the first
    // check and registration cannot leave this token alive.
    if job.cancel.check().is_err() {
        drop(active);
        return Err(Failure::new(FailureCode::Cancelled));
    }
    if let Err(error) = commands::check_upload_start(app, &connection_id, epoch) {
        drop(active);
        return Err(error);
    }
    Ok(UploadStart {
        job,
        _active: active,
    })
}

#[derive(Clone, Debug)]
struct ShelfSnapshot {
    root: PathBuf,
    metadata: BTreeMap<String, BookMetadata>,
    bindings: BTreeMap<String, LocalBinding>,
}

#[derive(Clone)]
pub(crate) struct BookPlan {
    content_hash: String,
    title: String,
    file_name: String,
    extension: String,
    bytes: u64,
    source: Option<BookSource>,
    ready: bool,
    code: Option<String>,
}

fn unique_hashes(raw: Vec<String>) -> Result<Vec<String>> {
    if raw.is_empty() || raw.len() > MAX_BOOKS {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(raw.len());
    for hash in raw {
        if !valid_content_hash(&hash) {
            return Err(Failure::new(FailureCode::InvalidConfig));
        }
        if seen.insert(hash.clone()) {
            result.push(hash);
        }
    }
    Ok(result)
}

async fn shelf_snapshot(app: &AppHandle) -> Result<ShelfSnapshot> {
    let app = app.clone();
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| Failure::new(FailureCode::StorageError))?
        .join("linked-library");
    let (metadata, raw_bindings) = engine::blocking(move || {
        crate::portable_state_commands::with_existing_store(&app, |store| {
            Ok((store.book_source_metadata()?, store.bindings_raw()?))
        })
        .map_err(|_| Failure::new(FailureCode::RepositoryError))?
        .ok_or_else(|| Failure::new(FailureCode::RepositoryNotReady))
    })
    .await?;
    let bindings =
        parse_bindings(raw_bindings).map_err(|_| Failure::new(FailureCode::StorageError))?;
    Ok(ShelfSnapshot {
        root,
        metadata,
        bindings,
    })
}

fn plans_from_snapshot(snapshot: &ShelfSnapshot, hashes: &[String]) -> Vec<BookPlan> {
    hashes
        .iter()
        .map(|hash| {
            let Some(metadata) = snapshot.metadata.get(hash) else {
                return BookPlan {
                    content_hash: hash.clone(),
                    title: String::new(),
                    file_name: String::new(),
                    extension: String::new(),
                    bytes: 0,
                    source: None,
                    ready: false,
                    code: Some("book-not-found".into()),
                };
            };
            let mut plan = BookPlan {
                content_hash: hash.clone(),
                title: metadata.title.clone(),
                file_name: metadata.file_name.clone(),
                extension: crate::document_formats::extension(&metadata.file_name)
                    .to_ascii_lowercase(),
                bytes: 0,
                source: None,
                ready: false,
                code: None,
            };
            let Some(binding) = snapshot.bindings.get(hash) else {
                plan.code = Some("source-unbound".into());
                return plan;
            };
            plan.bytes = binding.file_size;
            if !crate::document_formats::supported(&metadata.file_name) {
                plan.code = Some("unsupported-format".into());
                return plan;
            }
            if plan.bytes == 0 {
                plan.code = Some("source-unreadable".into());
                return plan;
            }
            match binding.book_source(&snapshot.root) {
                Ok(source) => {
                    plan.source = Some(source);
                    plan.ready = true;
                }
                Err(_) => plan.code = Some("source-unreadable".into()),
            }
            plan
        })
        .collect()
}

fn preview_from_plans(plans: &[BookPlan]) -> BookUploadPreview {
    let books = plans
        .iter()
        .map(|plan| BookUploadPreviewBook {
            content_hash: plan.content_hash.clone(),
            title: plan.title.clone(),
            file_name: plan.file_name.clone(),
            bytes: plan.bytes,
            ready: plan.ready,
            code: plan.code.clone(),
        })
        .collect();
    let total_bytes = plans
        .iter()
        .filter(|plan| plan.ready)
        .map(|plan| plan.bytes)
        .sum();
    BookUploadPreview { books, total_bytes }
}

#[tauri::command]
pub async fn cloud_book_upload_preview(
    app: AppHandle,
    book_hashes: Vec<String>,
) -> Result<BookUploadPreview> {
    let hashes = unique_hashes(book_hashes)?;
    let snapshot = shelf_snapshot(&app).await?;
    Ok(preview_from_plans(&plans_from_snapshot(&snapshot, &hashes)))
}

const CLEANUP_SCHEMA: u64 = 2;

/// Identifies the account/space that owns a pending cleanup entry. The server
/// key is a hash of the exact remote root and username; it is never used for
/// network I/O on its own and cannot be confused with another server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CleanupOwner {
    server_key: String,
    space_id: String,
}

impl CleanupOwner {
    fn new(remote: &WebDavRemote, space_id: &str) -> Self {
        Self {
            server_key: remote.cleanup_owner_key(),
            space_id: space_id.to_string(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupFile {
    schema_version: u64,
    scopes: Vec<CleanupScope>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupScope {
    server_key: String,
    space_id: String,
    entries: Vec<String>,
}

fn empty_cleanup() -> CleanupFile {
    CleanupFile {
        schema_version: CLEANUP_SCHEMA,
        scopes: Vec::new(),
    }
}

fn cleanup_root<R: Runtime>(app: &AppHandle<R>) -> std::result::Result<PathBuf, ()> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("cloud-sync"))
        .map_err(|_| ())
}

fn cleanup_file(root: &std::path::Path) -> PathBuf {
    root.join(CLEANUP_FILE)
}

fn valid_cleanup_entry(entry: &str) -> bool {
    entry.starts_with("books/.")
        && entry.ends_with(".pending")
        && !entry.contains("..")
        && RemotePath::new(entry).is_ok()
}

fn read_cleanup(path: &std::path::Path) -> (CleanupFile, bool) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return (empty_cleanup(), false),
        Err(_) => return (empty_cleanup(), true),
    };
    if bytes.len() > CLEANUP_BYTES {
        return (empty_cleanup(), true);
    }
    let Ok(file) = serde_json::from_slice::<CleanupFile>(&bytes) else {
        return (empty_cleanup(), true);
    };
    if file.schema_version != CLEANUP_SCHEMA || file.scopes.len() > CLEANUP_LIMIT {
        return (empty_cleanup(), true);
    }
    let mut total = 0usize;
    let mut seen = BTreeSet::new();
    for scope in &file.scopes {
        if !valid_content_hash(&scope.server_key)
            || !valid_canonical_uuid(&scope.space_id)
            || !seen.insert((scope.server_key.as_str(), scope.space_id.as_str()))
        {
            return (empty_cleanup(), true);
        }
        total = match total.checked_add(scope.entries.len()) {
            Some(total) if total <= CLEANUP_LIMIT => total,
            _ => return (empty_cleanup(), true),
        };
        if scope
            .entries
            .iter()
            .any(|entry| !valid_cleanup_entry(entry))
        {
            return (empty_cleanup(), true);
        }
    }
    (file, false)
}

fn save_cleanup(path: &std::path::Path, file: &CleanupFile) -> bool {
    let mut file = file.clone();
    file.schema_version = CLEANUP_SCHEMA;
    file.scopes.retain(|scope| !scope.entries.is_empty());
    if file.scopes.is_empty() {
        let _ = fs::remove_file(path);
        return true;
    }
    if file.scopes.len() > CLEANUP_LIMIT
        || file
            .scopes
            .iter()
            .map(|scope| scope.entries.len())
            .sum::<usize>()
            > CLEANUP_LIMIT
    {
        return false;
    }
    let Ok(bytes) = serde_json::to_vec(&file) else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    Disk {
        root: parent.to_path_buf(),
    }
    .atomic(CLEANUP_FILE, &bytes)
    .is_ok()
}

fn cleanup_scope_index(file: &CleanupFile, owner: &CleanupOwner) -> Option<usize> {
    file.scopes
        .iter()
        .position(|scope| scope.server_key == owner.server_key && scope.space_id == owner.space_id)
}

fn add_cleanup(path: &std::path::Path, owner: &CleanupOwner, entry: &str) -> bool {
    if !valid_cleanup_entry(entry) {
        return false;
    }
    let (mut file, invalid) = read_cleanup(path);
    if invalid {
        return false;
    }
    if let Some(index) = cleanup_scope_index(&file, owner) {
        if file.scopes[index]
            .entries
            .iter()
            .any(|value| value == entry)
        {
            return true;
        }
    }
    if file
        .scopes
        .iter()
        .map(|scope| scope.entries.len())
        .sum::<usize>()
        >= CLEANUP_LIMIT
    {
        return false;
    }
    match cleanup_scope_index(&file, owner) {
        Some(index) => file.scopes[index].entries.push(entry.to_string()),
        None => file.scopes.push(CleanupScope {
            server_key: owner.server_key.clone(),
            space_id: owner.space_id.clone(),
            entries: vec![entry.to_string()],
        }),
    }
    save_cleanup(path, &file)
}

fn remove_cleanup(path: &std::path::Path, owner: &CleanupOwner, entry: &str) -> bool {
    let (mut file, invalid) = read_cleanup(path);
    if invalid {
        return false;
    }
    let Some(index) = cleanup_scope_index(&file, owner) else {
        return false;
    };
    file.scopes[index].entries.retain(|value| value != entry);
    save_cleanup(path, &file)
}

type ProgressSink = Arc<dyn Fn(BookUploadProgress) + Send + Sync>;

#[derive(Clone)]
struct ProgressEmitter {
    sink: ProgressSink,
    job_id: String,
    connection_id: String,
    index: usize,
    count: usize,
    content_hash: String,
    book_total: u64,
    batch_base: u64,
    batch_total: u64,
    last: Arc<Mutex<Instant>>,
}

impl ProgressEmitter {
    fn new(
        sink: ProgressSink,
        job: &UploadJob,
        index: usize,
        count: usize,
        plan: &BookPlan,
        batch_base: u64,
        batch_total: u64,
    ) -> Self {
        Self {
            sink,
            job_id: job.job_id.clone(),
            connection_id: job.connection_id.clone(),
            index,
            count,
            content_hash: plan.content_hash.clone(),
            book_total: plan.bytes,
            batch_base,
            batch_total,
            last: Arc::new(Mutex::new(Instant::now() - PROGRESS_INTERVAL)),
        }
    }

    fn emit(&self, phase: &str, sent: u64, force: bool) {
        let Ok(mut last) = self.last.lock() else {
            return;
        };
        if !force && last.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        *last = Instant::now();
        (self.sink)(BookUploadProgress {
            job_id: self.job_id.clone(),
            connection_id: self.connection_id.clone(),
            phase: phase.to_string(),
            index: self.index,
            count: self.count,
            content_hash: self.content_hash.clone(),
            book_sent: sent.min(self.book_total),
            book_total: self.book_total,
            batch_sent: self.batch_base.saturating_add(sent).min(self.batch_total),
            batch_total: self.batch_total,
        });
    }
}

struct ChannelBody {
    receiver: mpsc::Receiver<std::result::Result<Bytes, io::Error>>,
    last_poll: Arc<AtomicU64>,
    started: Instant,
}

impl HttpBody for ChannelBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        this.last_poll
            .store(this.started.elapsed().as_millis() as u64, Ordering::Release);
        match this.receiver.poll_recv(cx) {
            Poll::Ready(Some(Ok(bytes))) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Poll::Ready(Some(Err(error))) => Poll::Ready(Some(Err(error))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.receiver.is_closed() && self.receiver.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceState {
    Pending,
    Verified,
    Changed,
    Missing,
    Unreadable,
    Cancelled,
    /// The HTTP consumer stopped polling before the source was fully sent.
    /// This is not a user cancellation: an early 401/403/507 response also
    /// closes the body channel.
    ConsumerGone,
}

fn set_source_state(state: &Mutex<SourceState>, value: SourceState) {
    if let Ok(mut state) = state.lock() {
        *state = value;
    }
}

fn send_body_error(
    sender: &mpsc::Sender<std::result::Result<Bytes, io::Error>>,
    state: &Mutex<SourceState>,
    value: SourceState,
    message: &'static str,
) {
    set_source_state(state, value);
    // The caller checks `SourceState` after the request, so a full channel
    // does not need a blocking send. This keeps cancellation from waiting on
    // an HTTP consumer that has already stopped polling.
    let _ = sender.try_send(Err(io::Error::new(io::ErrorKind::InvalidData, message)));
}

fn source_body<R: Runtime>(
    app: Option<AppHandle<R>>,
    plan: &BookPlan,
    cancel: Cancel,
    progress: Option<ProgressEmitter>,
) -> (reqwest::Body, Arc<Mutex<SourceState>>, Arc<AtomicU64>) {
    let (sender, receiver) = mpsc::channel::<std::result::Result<Bytes, io::Error>>(4);
    let state = Arc::new(Mutex::new(SourceState::Pending));
    let last_poll = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let body = reqwest::Body::wrap(ChannelBody {
        receiver,
        last_poll: last_poll.clone(),
        started,
    });
    let source = plan.source.clone();
    let expected_hash = plan.content_hash.clone();
    let expected_bytes = plan.bytes;
    let state_for_thread = state.clone();
    if source.is_none() {
        set_source_state(&state_for_thread, SourceState::Unreadable);
        let _ = sender.try_send(Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "source-unreadable",
        )));
        return (body, state, last_poll);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(source) = source else {
            return;
        };
        let open = source.open(app.as_ref());
        let (mut reader, length) = match open {
            Ok(value) => value,
            Err(error) => {
                let code = if error.kind() == io::ErrorKind::NotFound {
                    SourceState::Missing
                } else {
                    SourceState::Unreadable
                };
                send_body_error(&sender, &state_for_thread, code, "source-unreadable");
                return;
            }
        };
        if length != expected_bytes {
            send_body_error(
                &sender,
                &state_for_thread,
                SourceState::Changed,
                "source-changed",
            );
            return;
        }
        let mut hasher = Sha256::new();
        let mut sent = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if cancel.check().is_err() {
                send_body_error(
                    &sender,
                    &state_for_thread,
                    SourceState::Cancelled,
                    "cancelled",
                );
                return;
            }
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    send_body_error(
                        &sender,
                        &state_for_thread,
                        SourceState::Unreadable,
                        "source-unreadable",
                    );
                    return;
                }
            };
            if read as u64 > expected_bytes.saturating_sub(sent) {
                send_body_error(
                    &sender,
                    &state_for_thread,
                    SourceState::Changed,
                    "source-changed",
                );
                return;
            }
            hasher.update(&buffer[..read]);
            sent += read as u64;
            let mut data = Bytes::copy_from_slice(&buffer[..read]);
            loop {
                if cancel.check().is_err() {
                    send_body_error(
                        &sender,
                        &state_for_thread,
                        SourceState::Cancelled,
                        "cancelled",
                    );
                    return;
                }
                match sender.try_send(Ok(data)) {
                    Ok(()) => break,
                    Err(mpsc::error::TrySendError::Full(Ok(returned))) => {
                        data = returned;
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => {
                        set_source_state(&state_for_thread, SourceState::ConsumerGone);
                        return;
                    }
                }
            }
            if let Some(progress) = &progress {
                progress.emit("uploading", sent, false);
            }
        }
        if sent != expected_bytes || format!("{:x}", hasher.finalize()) != expected_hash {
            send_body_error(
                &sender,
                &state_for_thread,
                SourceState::Changed,
                "source-changed",
            );
            return;
        }
        if cancel.check().is_err() {
            send_body_error(
                &sender,
                &state_for_thread,
                SourceState::Cancelled,
                "cancelled",
            );
            return;
        }
        set_source_state(&state_for_thread, SourceState::Verified);
        // Dropping the sender ends the request body only after the full source
        // and hash have matched.
    });
    (body, state, last_poll)
}

#[derive(Debug, Clone)]
struct BookFailure {
    code: String,
    stop: bool,
}

impl BookFailure {
    fn local(code: &str) -> Self {
        Self {
            code: code.to_string(),
            stop: false,
        }
    }
}

fn remote_failure(error: RemoteError) -> BookFailure {
    let code = error.code.as_str();
    BookFailure {
        code: code.to_string(),
        stop: matches!(
            error.code,
            RemoteErrorCode::Authentication
                | RemoteErrorCode::PermissionDenied
                | RemoteErrorCode::QuotaExceeded
                | RemoteErrorCode::Unsupported
        ),
    }
}

async fn upload_stream<R: Runtime>(
    remote: &WebDavRemote,
    app: &AppHandle<R>,
    plan: &BookPlan,
    pending: &RemotePath,
    cancel: &Cancel,
    progress: &ProgressEmitter,
) -> std::result::Result<(), BookFailure> {
    let child = Cancel::default();
    let stalled = Arc::new(AtomicBool::new(false));
    let parent = cancel.clone();
    let child_watchdog = child.clone();
    let started = Instant::now();
    let (body, state, last_poll) = source_body(
        Some(app.clone()),
        plan,
        child.clone(),
        Some(progress.clone()),
    );
    let last_for_watchdog = last_poll.clone();
    let stalled_for_watchdog = stalled.clone();
    progress.emit("uploading", 0, true);
    let watchdog = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = parent.cancelled() => {
                    child_watchdog.cancel();
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    let elapsed = started.elapsed().as_millis() as u64;
                    let last = last_for_watchdog.load(Ordering::Acquire);
                    if elapsed.saturating_sub(last) >= STALL_TIMEOUT.as_millis() as u64 {
                        stalled_for_watchdog.store(true, Ordering::Release);
                        child_watchdog.cancel();
                        break;
                    }
                }
            }
        }
    });
    let result = remote.put_stream(pending, plan.bytes, body, &child).await;
    watchdog.abort();
    child.cancel();
    let state = state
        .lock()
        .map(|state| *state)
        .unwrap_or(SourceState::Unreadable);
    match result {
        Ok(()) if state == SourceState::Verified => {
            progress.emit("verifying", plan.bytes, true);
            Ok(())
        }
        Ok(()) => Err(match state {
            SourceState::Missing => BookFailure::local("source-missing"),
            SourceState::Changed => BookFailure::local("source-changed"),
            SourceState::Cancelled => BookFailure::local("cancelled"),
            _ => BookFailure::local("source-unreadable"),
        }),
        Err(error) => Err(upload_error_failure(
            error,
            state,
            cancel.check().is_err(),
            stalled.load(Ordering::Acquire),
        )),
    }
}

fn upload_error_failure(
    error: RemoteError,
    state: SourceState,
    user_cancelled: bool,
    stalled: bool,
) -> BookFailure {
    // Only an explicit user/parent cancel or the no-progress watchdog may
    // project to cancelled/timeout. A server can answer 401/403/507 or a
    // broken connection before consuming the whole body; closing the body
    // channel then must not hide the actual remote error.
    if user_cancelled {
        return BookFailure::local("cancelled");
    }
    if stalled {
        return BookFailure::local("timeout");
    }
    if matches!(
        error.code,
        RemoteErrorCode::Authentication
            | RemoteErrorCode::PermissionDenied
            | RemoteErrorCode::QuotaExceeded
            | RemoteErrorCode::Unsupported
    ) {
        return remote_failure(error);
    }
    // No `SourceState::Cancelled` inference here. The producer may have seen
    // the child cancel while HTTP was already failing (for example an early
    // 500 or a broken connection); the actual remote error must win.
    match state {
        SourceState::Missing => BookFailure::local("source-missing"),
        SourceState::Changed => BookFailure::local("source-changed"),
        SourceState::Unreadable => BookFailure::local("source-unreadable"),
        _ => remote_failure(error),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    AlreadyPresent,
    Repair,
    Upload,
    Conflict,
}

fn shard_name(hash: &str) -> &str {
    &hash[..2]
}

fn shard_path(shard: &str) -> std::result::Result<RemotePath, RemoteError> {
    RemotePath::new("books")?.child(shard)
}

fn object_name(plan: &BookPlan) -> String {
    format!("{}.{}", plan.content_hash, plan.extension)
}

fn object_path(plan: &BookPlan) -> std::result::Result<RemotePath, RemoteError> {
    shard_path(shard_name(&plan.content_hash))?.child(&object_name(plan))
}

fn marker_path(plan: &BookPlan) -> std::result::Result<RemotePath, RemoteError> {
    shard_path(shard_name(&plan.content_hash))?.child(&format!("{}.ok", plan.content_hash))
}

fn decide(plan: &BookPlan, entries: &BTreeMap<String, Option<u64>>) -> Decision {
    let object = entries.get(&object_name(plan));
    let marker = entries.contains_key(&format!("{}.ok", plan.content_hash));
    match (object, marker) {
        (Some(Some(size)), true) if *size == plan.bytes => Decision::AlreadyPresent,
        (Some(Some(size)), false) if *size == plan.bytes => Decision::Repair,
        (None, false) => Decision::Upload,
        _ => Decision::Conflict,
    }
}

async fn list_shard(
    remote: &WebDavRemote,
    shard: &str,
    cancel: &Cancel,
) -> std::result::Result<BTreeMap<String, Option<u64>>, RemoteError> {
    let path = match shard_path(shard) {
        Ok(path) => path,
        Err(error) => return Err(error),
    };
    match remote.list(&path, cancel).await {
        Ok(entries) => Ok(entries
            .into_iter()
            .filter(|entry| !entry.is_collection)
            .map(|entry| (entry.name, entry.size))
            .collect()),
        Err(error) if error.code == RemoteErrorCode::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionMarker {
    format: String,
    version: u64,
    sha256: String,
    bytes: u64,
    extension: String,
    file_name: String,
    uploaded_at_ms: u64,
    space_id: String,
}

fn marker_bytes(plan: &BookPlan, space_id: &str) -> Option<Vec<u8>> {
    let marker = CompletionMarker {
        format: MARKER_FORMAT.to_string(),
        version: MARKER_VERSION,
        sha256: plan.content_hash.clone(),
        bytes: plan.bytes,
        extension: plan.extension.clone(),
        file_name: plan.file_name.chars().take(255).collect(),
        uploaded_at_ms: super::model::now_ms(),
        space_id: space_id.to_string(),
    };
    let bytes = serde_json::to_vec(&marker).ok()?;
    (bytes.len() as u64 <= MARKER_LIMIT).then_some(bytes)
}

async fn write_marker(
    remote: &WebDavRemote,
    plan: &BookPlan,
    space_id: &str,
    caps: Capabilities,
    cancel: &Cancel,
) -> std::result::Result<(), BookFailure> {
    let path = marker_path(plan).map_err(remote_failure)?;
    let Some(bytes) = marker_bytes(plan, space_id) else {
        return Err(BookFailure::local("remote-conflict"));
    };
    let result = if caps.conditional_create {
        remote
            .put(&path, bytes, super::remote::WriteCondition::Absent, cancel)
            .await
    } else {
        super::remote::publish(remote, &path, bytes, false, cancel).await
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.http_status, Some(409 | 412)) => {
            Err(BookFailure::local("remote-conflict"))
        }
        Err(error) => Err(remote_failure(error)),
    }
}

async fn resolve_complete(
    remote: &WebDavRemote,
    plan: &BookPlan,
    space_id: &str,
    caps: Capabilities,
    cancel: &Cancel,
) -> std::result::Result<bool, BookFailure> {
    let entries = list_shard(remote, shard_name(&plan.content_hash), cancel)
        .await
        .map_err(remote_failure)?;
    match decide(plan, &entries) {
        Decision::AlreadyPresent => Ok(true),
        Decision::Repair => {
            repair_object(remote, plan, space_id, caps, cancel).await?;
            Ok(true)
        }
        Decision::Conflict | Decision::Upload => Ok(false),
    }
}

async fn repair_object(
    remote: &WebDavRemote,
    plan: &BookPlan,
    space_id: &str,
    caps: Capabilities,
    cancel: &Cancel,
) -> std::result::Result<(), BookFailure> {
    let path = object_path(plan).map_err(remote_failure)?;
    match remote
        .hash_file(&path, &plan.content_hash, plan.bytes, cancel)
        .await
        .map_err(remote_failure)?
    {
        HashCheck::Match => {}
        HashCheck::Missing | HashCheck::Mismatch => {
            return Err(BookFailure::local("remote-conflict"))
        }
    }
    match write_marker(remote, plan, space_id, caps, cancel).await {
        Ok(()) => Ok(()),
        Err(error) if error.code == "remote-conflict" => {
            if listed_complete(remote, plan, cancel).await? {
                Ok(())
            } else {
                Err(BookFailure::local("remote-conflict"))
            }
        }
        Err(error) => Err(error),
    }
}

async fn listed_complete(
    remote: &WebDavRemote,
    plan: &BookPlan,
    cancel: &Cancel,
) -> std::result::Result<bool, BookFailure> {
    let entries = list_shard(remote, shard_name(&plan.content_hash), cancel)
        .await
        .map_err(remote_failure)?;
    Ok(decide(plan, &entries) == Decision::AlreadyPresent)
}

async fn cleanup_remote(
    cleanup_path: &std::path::Path,
    remote: &WebDavRemote,
    owner: &CleanupOwner,
    cancel: &Cancel,
) -> bool {
    let (mut file, invalid) = read_cleanup(cleanup_path);
    if invalid {
        // Never overwrite/clear an unknown or corrupt local cleanup record.
        return true;
    }
    let Some(index) = cleanup_scope_index(&file, owner) else {
        // Records from another server/space stay untouched. Reconnecting to
        // that origin is the only way they can be cleaned.
        return false;
    };
    let entries = std::mem::take(&mut file.scopes[index].entries);
    let mut cleanup_pending = false;
    let mut remaining = Vec::new();
    for entry in entries {
        let Ok(path) = RemotePath::new(&entry) else {
            cleanup_pending = true;
            remaining.push(entry);
            continue;
        };
        match remote.delete(&path, false, cancel).await {
            Ok(()) => {}
            Err(error) if error.code == RemoteErrorCode::NotFound => {}
            Err(_) => {
                cleanup_pending = true;
                remaining.push(entry);
            }
        }
    }
    file.scopes[index].entries = remaining;
    if !save_cleanup(cleanup_path, &file) {
        cleanup_pending = true;
    }
    cleanup_pending
}

fn sync_disk(app: &AppHandle) -> Result<Disk> {
    Ok(Disk {
        root: app
            .path()
            .app_local_data_dir()
            .map_err(|_| Failure::new(FailureCode::StorageError))?
            .join("cloud-sync"),
    })
}

fn item_for(plan: &BookPlan, outcome: &str, code: Option<String>) -> BookUploadItem {
    BookUploadItem {
        content_hash: plan.content_hash.clone(),
        title: plan.title.clone(),
        outcome: outcome.to_string(),
        code,
        bytes: plan.bytes,
    }
}

fn stopped_result(
    job_id: &str,
    connection_id: &str,
    plans: &[BookPlan],
    code: &str,
    cleanup_pending: bool,
) -> BookUploadResult {
    let books = plans
        .iter()
        .map(|plan| item_for(plan, "not-attempted", Some(code.to_string())))
        .collect::<Vec<_>>();
    BookUploadResult {
        job_id: job_id.to_string(),
        connection_id: connection_id.to_string(),
        status: "stopped".into(),
        not_attempted: books.len(),
        books,
        uploaded: 0,
        already_present: 0,
        failed: 0,
        cancelled: 0,
        cleanup_pending,
    }
}

fn cancelled_result(
    job_id: &str,
    connection_id: &str,
    plans: &[BookPlan],
    cleanup_pending: bool,
) -> BookUploadResult {
    let books = plans
        .iter()
        .map(|plan| item_for(plan, "not-attempted", None))
        .collect::<Vec<_>>();
    BookUploadResult {
        job_id: job_id.to_string(),
        connection_id: connection_id.to_string(),
        status: "cancelled".into(),
        not_attempted: books.len(),
        books,
        uploaded: 0,
        already_present: 0,
        failed: 0,
        cancelled: 0,
        cleanup_pending,
    }
}

async fn ensure_shard(
    remote: &WebDavRemote,
    shard: &str,
    created: &mut BTreeSet<String>,
    cancel: &Cancel,
) -> std::result::Result<(), BookFailure> {
    if created.contains(shard) {
        return Ok(());
    }
    let books = RemotePath::new("books").map_err(remote_failure)?;
    remote
        .create_collection(&books, cancel)
        .await
        .map_err(remote_failure)?;
    remote
        .create_collection(&shard_path(shard).map_err(remote_failure)?, cancel)
        .await
        .map_err(remote_failure)?;
    created.insert(shard.to_string());
    Ok(())
}

async fn delete_own_pending(remote: &WebDavRemote, pending: &RemotePath) -> bool {
    match remote.delete(pending, false, &Cancel::default()).await {
        Ok(()) => true,
        Err(error) if error.code == RemoteErrorCode::NotFound => true,
        Err(_) => false,
    }
}

async fn connection_current<R: Runtime>(app: &AppHandle<R>, connection_id: &str) -> bool {
    commands::current_connection(app)
        .ok()
        .flatten()
        .is_some_and(|connection| connection.connection_id == connection_id)
}

#[allow(clippy::too_many_arguments)]
async fn run_upload<R: Runtime>(
    app: &AppHandle<R>,
    cleanup_path: &std::path::Path,
    job: Arc<UploadJob>,
    plans: Vec<BookPlan>,
    remote: &WebDavRemote,
    connection_id: &str,
    space_id: &str,
    caps: Capabilities,
    identity: crate::cloud_sync::storage::Identity,
    sink: ProgressSink,
    cancel: &Cancel,
    mut cleanup_pending: bool,
) -> Result<BookUploadResult> {
    let cleanup_owner = CleanupOwner::new(remote, space_id);
    let count = plans.len();
    let batch_total = plans
        .iter()
        .filter(|plan| plan.ready)
        .map(|plan| plan.bytes)
        .sum::<u64>();
    sink(BookUploadProgress {
        job_id: job.job_id.clone(),
        connection_id: connection_id.to_string(),
        phase: "preparing".into(),
        index: 0,
        count,
        content_hash: String::new(),
        book_sent: 0,
        book_total: 0,
        batch_sent: 0,
        batch_total,
    });

    if !caps.move_file || !caps.move_no_replace {
        return Ok(stopped_result(
            &job.job_id,
            connection_id,
            &plans,
            "unsupported",
            cleanup_pending,
        ));
    }

    if cancel.check().is_err() {
        return Ok(cancelled_result(
            &job.job_id,
            connection_id,
            &plans,
            cleanup_pending,
        ));
    }

    match engine::read_space(remote, cancel).await {
        Ok(Some(space)) if space.space_id == space_id => {}
        Ok(_) => {
            return Ok(stopped_result(
                &job.job_id,
                connection_id,
                &plans,
                "space-mismatch",
                cleanup_pending,
            ))
        }
        Err(error) if error.code == FailureCode::Cancelled => {
            return Ok(cancelled_result(
                &job.job_id,
                connection_id,
                &plans,
                cleanup_pending,
            ))
        }
        Err(error) => return Err(error),
    }

    if !connection_current(app, connection_id).await {
        return Ok(stopped_result(
            &job.job_id,
            connection_id,
            &plans,
            "connection-changed",
            cleanup_pending,
        ));
    }

    // A failed cleanup is reported, but it does not block this new job.
    cleanup_pending =
        cleanup_remote(cleanup_path, remote, &cleanup_owner, cancel).await || cleanup_pending;

    let pending_path = RemotePath::new(&format!(
        "books/.{}.{}.pending",
        identity.installation_id, job.job_id
    ))
    .map_err(|_| Failure::new(FailureCode::InvalidConfig))?;
    let pending_entry = pending_path.as_relative();

    sink(BookUploadProgress {
        job_id: job.job_id.clone(),
        connection_id: connection_id.to_string(),
        phase: "checking".into(),
        index: 0,
        count,
        content_hash: String::new(),
        book_sent: 0,
        book_total: 0,
        batch_sent: 0,
        batch_total,
    });

    // One PROPFIND per used shard, not one per book.
    let shards = plans
        .iter()
        .filter(|plan| plan.ready)
        .map(|plan| shard_name(&plan.content_hash).to_string())
        .collect::<BTreeSet<_>>();
    let mut listings = BTreeMap::new();
    let mut shard_errors = BTreeMap::<String, String>::new();
    let mut stop_code = None;
    for shard in shards {
        if cancel.check().is_err() {
            return Ok(cancelled_result(
                &job.job_id,
                connection_id,
                &plans,
                cleanup_pending,
            ));
        }
        match list_shard(remote, &shard, cancel).await {
            Ok(entries) => {
                listings.insert(shard, entries);
            }
            Err(error) if error.code == RemoteErrorCode::Cancelled => {
                return Ok(cancelled_result(
                    &job.job_id,
                    connection_id,
                    &plans,
                    cleanup_pending,
                ))
            }
            Err(error) => {
                let failure = remote_failure(error);
                if failure.stop {
                    stop_code = Some(failure.code);
                    break;
                }
                shard_errors.insert(shard, failure.code);
            }
        }
    }
    if let Some(code) = stop_code {
        return Ok(stopped_result(
            &job.job_id,
            connection_id,
            &plans,
            &code,
            cleanup_pending,
        ));
    }

    let mut decisions = BTreeMap::<String, Decision>::new();
    for plan in plans.iter().filter(|plan| plan.ready) {
        let Some(entries) = listings.get(shard_name(&plan.content_hash)) else {
            continue;
        };
        decisions.insert(plan.content_hash.clone(), decide(plan, entries));
    }

    let mut items = Vec::with_capacity(plans.len());
    let mut processed_bytes = 0u64;
    let mut created = BTreeSet::new();
    let mut cancelled = false;

    for (index, plan) in plans.iter().enumerate() {
        if cancelled || stop_code.is_some() {
            items.push(item_for(plan, "not-attempted", stop_code.clone()));
            continue;
        }
        if cancel.check().is_err() {
            cancelled = true;
            items.push(item_for(plan, "cancelled", None));
            continue;
        }
        if !plan.ready {
            items.push(item_for(plan, "failed", plan.code.clone()));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }
        if let Some(code) = shard_errors.get(shard_name(&plan.content_hash)) {
            items.push(item_for(plan, "failed", Some(code.clone())));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }
        let progress = ProgressEmitter::new(
            sink.clone(),
            &job,
            index,
            plans.len(),
            plan,
            processed_bytes,
            batch_total,
        );
        let Some(decision) = decisions.get(&plan.content_hash).copied() else {
            items.push(item_for(plan, "failed", Some("remote-conflict".into())));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        };
        match decision {
            Decision::AlreadyPresent => {
                items.push(item_for(plan, "already-present", None));
                processed_bytes = processed_bytes.saturating_add(plan.bytes);
                continue;
            }
            Decision::Conflict => {
                items.push(item_for(plan, "failed", Some("remote-conflict".into())));
                processed_bytes = processed_bytes.saturating_add(plan.bytes);
                continue;
            }
            Decision::Repair => {
                progress.emit("verifying", plan.bytes, true);
                match repair_object(remote, plan, space_id, caps, cancel).await {
                    Ok(()) => items.push(item_for(plan, "already-present", None)),
                    Err(error) if error.code == "cancelled" => {
                        cancelled = true;
                        items.push(item_for(plan, "cancelled", None));
                    }
                    Err(error) => {
                        if error.stop {
                            stop_code = Some(error.code.clone());
                        }
                        items.push(item_for(plan, "failed", Some(error.code)));
                    }
                }
                processed_bytes = processed_bytes.saturating_add(plan.bytes);
                continue;
            }
            Decision::Upload => {}
        }

        let shard = shard_name(&plan.content_hash).to_string();
        if let Err(error) = ensure_shard(remote, &shard, &mut created, cancel).await {
            if error.stop {
                stop_code = Some(error.code.clone());
            }
            items.push(item_for(plan, "failed", Some(error.code)));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }
        if !add_cleanup(cleanup_path, &cleanup_owner, &pending_entry) {
            cleanup_pending = true;
            items.push(item_for(plan, "failed", Some("storage-error".into())));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }
        progress.emit("uploading", 0, true);
        let upload = upload_stream(remote, app, plan, &pending_path, cancel, &progress).await;
        if let Err(error) = upload {
            let deleted = delete_own_pending(remote, &pending_path).await;
            if deleted {
                if !remove_cleanup(cleanup_path, &cleanup_owner, &pending_entry) {
                    cleanup_pending = true;
                }
            } else {
                cleanup_pending = true;
            }
            if error.code == "cancelled" {
                cancelled = true;
                items.push(item_for(plan, "cancelled", None));
            } else {
                if error.stop {
                    stop_code = Some(error.code.clone());
                }
                items.push(item_for(plan, "failed", Some(error.code)));
            }
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }

        // The source and byte count are verified. Never publish if the user
        // cancelled or the connection moved to another session in the meantime.
        if cancel.check().is_err() {
            let deleted = delete_own_pending(remote, &pending_path).await;
            if deleted {
                if !remove_cleanup(cleanup_path, &cleanup_owner, &pending_entry) {
                    cleanup_pending = true;
                }
            } else {
                cleanup_pending = true;
            }
            cancelled = true;
            items.push(item_for(plan, "cancelled", None));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }
        if !connection_current(app, connection_id).await {
            stop_code = Some("connection-changed".into());
            let deleted = delete_own_pending(remote, &pending_path).await;
            if deleted {
                if !remove_cleanup(cleanup_path, &cleanup_owner, &pending_entry) {
                    cleanup_pending = true;
                }
            } else {
                cleanup_pending = true;
            }
            items.push(item_for(plan, "failed", Some("connection-changed".into())));
            processed_bytes = processed_bytes.saturating_add(plan.bytes);
            continue;
        }

        progress.emit("publishing", plan.bytes, true);
        let object = object_path(plan).map_err(|_| Failure::new(FailureCode::InvalidConfig))?;
        let moved = remote
            .move_file(&pending_path, &object, false, cancel)
            .await;
        match moved {
            Ok(()) => {
                if !remove_cleanup(cleanup_path, &cleanup_owner, &pending_entry) {
                    cleanup_pending = true;
                }
                match write_marker(remote, plan, space_id, caps, cancel).await {
                    Ok(()) => items.push(item_for(plan, "uploaded", None)),
                    Err(error) if error.code == "remote-conflict" => {
                        if resolve_complete(remote, plan, space_id, caps, cancel)
                            .await
                            .unwrap_or(false)
                        {
                            items.push(item_for(plan, "uploaded", None));
                        } else {
                            items.push(item_for(plan, "failed", Some("remote-conflict".into())));
                        }
                    }
                    Err(error) if error.code == "cancelled" => {
                        cancelled = true;
                        items.push(item_for(plan, "cancelled", None));
                    }
                    Err(error) => {
                        if error.stop {
                            stop_code = Some(error.code.clone());
                        }
                        items.push(item_for(plan, "failed", Some(error.code)));
                    }
                }
            }
            Err(error) => {
                // A failed/ambiguous MOVE is resolved by the shard listing, not
                // by a blind retry or by deleting a completed object.
                let complete = resolve_complete(remote, plan, space_id, caps, cancel)
                    .await
                    .unwrap_or(false);
                let deleted = delete_own_pending(remote, &pending_path).await;
                if deleted {
                    if !remove_cleanup(cleanup_path, &cleanup_owner, &pending_entry) {
                        cleanup_pending = true;
                    }
                } else {
                    cleanup_pending = true;
                }
                if complete {
                    items.push(item_for(plan, "already-present", None));
                } else {
                    let failure = remote_failure(error);
                    if failure.stop {
                        stop_code = Some(failure.code.clone());
                    }
                    items.push(item_for(plan, "failed", Some(failure.code)));
                }
            }
        }
        processed_bytes = processed_bytes.saturating_add(plan.bytes);
    }

    let uploaded = items
        .iter()
        .filter(|item| item.outcome == "uploaded")
        .count();
    let already_present = items
        .iter()
        .filter(|item| item.outcome == "already-present")
        .count();
    let failed = items.iter().filter(|item| item.outcome == "failed").count();
    let cancelled_count = items
        .iter()
        .filter(|item| item.outcome == "cancelled")
        .count();
    let not_attempted = items
        .iter()
        .filter(|item| item.outcome == "not-attempted")
        .count();
    let status = if cancelled {
        "cancelled"
    } else if stop_code.is_some() {
        "stopped"
    } else if failed > 0 {
        "partial"
    } else {
        "completed"
    };
    Ok(BookUploadResult {
        job_id: job.job_id.clone(),
        connection_id: connection_id.to_string(),
        status: status.into(),
        books: items,
        uploaded,
        already_present,
        failed,
        cancelled: cancelled_count,
        not_attempted,
        cleanup_pending,
    })
}

#[tauri::command]
pub async fn cloud_book_upload(
    app: AppHandle,
    job_id: String,
    book_hashes: Vec<String>,
    on_progress: Channel<BookUploadProgress>,
) -> Result<BookUploadResult> {
    if !valid_canonical_uuid(&job_id) {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let hashes = unique_hashes(book_hashes)?;
    let epoch = commands::upload_start_epoch(&app)?;
    commands::load_once(&app).await?;
    let Some(connection) = commands::current_connection(&app)? else {
        return Err(Failure::new(FailureCode::ConnectionRequired));
    };
    let connection_id = connection.connection_id.clone();
    // Register the cancel ownership before Android bridge setup, credential
    // disk access and the shelf snapshot. Backgrounding, connect/disconnect,
    // reset and broad cancel now have a token to invalidate even while this
    // invocation is still preparing.
    let start = start_upload_job(
        &app,
        job_id.clone(),
        connection_id.clone(),
        hashes.len(),
        epoch,
    )?;
    let job = start.job.clone();
    if !commands::native_ready(&app).await {
        return Err(Failure::new(FailureCode::NativeBridgeUnavailable));
    }
    let disk = sync_disk(&app)?;
    let app_for_load = app.clone();
    let expected_connection = connection_id.clone();
    let (session, identity, password) = engine::blocking(move || {
        let session = disk
            .load(&Cancel::default())?
            .ok_or_else(|| Failure::new(FailureCode::ConnectionRequired))?;
        if session.connection_id != expected_connection {
            return Err(Failure::new(FailureCode::ConnectionRequired));
        }
        let password = secrets::load(&app_for_load, &session.connection_id)?;
        let identity = disk.identity()?;
        Ok((session, identity, password))
    })
    .await?;
    let remote = WebDavRemote::new(
        &session.settings.base_url,
        &session.settings.remote_root,
        super::remote::Credentials {
            username: session.settings.username.clone(),
            app_password: password,
        },
    )?;

    let channel = on_progress.clone();
    let latest = job.clone();
    let progress_sink: ProgressSink = Arc::new(move |progress| {
        if let Ok(mut value) = latest.latest.lock() {
            *value = Some(progress.clone());
        }
        let _ = channel.send(progress);
    });
    let _activity = app
        .state::<DirectoryImportState>()
        .try_acquire_import_activity(format!("cloud-book-upload:{job_id}"))
        .map_err(|_| Failure::new(FailureCode::Busy))?;
    let cleanup_dir = cleanup_root(&app).map_err(|_| Failure::new(FailureCode::StorageError))?;
    let cleanup_path = cleanup_file(&cleanup_dir);
    let snapshot = shelf_snapshot(&app).await?;
    let plans = plans_from_snapshot(&snapshot, &hashes);
    let cancel = job.cancel.clone();
    run_upload(
        &app,
        &cleanup_path,
        job,
        plans,
        &remote,
        &connection_id,
        &session.space.space_id,
        session.capabilities,
        identity,
        progress_sink,
        &cancel,
        false,
    )
    .await
}

#[tauri::command]
pub fn cloud_book_upload_cancel(app: AppHandle, job_id: String) -> bool {
    if !valid_canonical_uuid(&job_id) {
        return false;
    }
    app.try_state::<CloudBookUploadManager>()
        .is_some_and(|manager| manager.cancel(&job_id))
}

#[tauri::command]
pub fn cloud_book_upload_current(app: AppHandle) -> Option<CurrentBookUpload> {
    app.try_state::<CloudBookUploadManager>()
        .and_then(|manager| manager.current())
}

#[cfg(test)]
pub(crate) async fn test_put_file(
    remote: &WebDavRemote,
    path: &RemotePath,
    file: std::path::PathBuf,
    hash: String,
    bytes: u64,
) -> std::result::Result<(), String> {
    let plan = BookPlan {
        content_hash: hash,
        title: "test".into(),
        file_name: "test.epub".into(),
        extension: "epub".into(),
        bytes,
        source: Some(BookSource::Path(file)),
        ready: true,
        code: None,
    };
    let cancel = Cancel::default();
    let (body, state, _) = source_body::<tauri::Wry>(None, &plan, cancel.clone(), None);
    match remote.put_stream(path, bytes, body, &cancel).await {
        Ok(()) if *state.lock().unwrap() == SourceState::Verified => Ok(()),
        Ok(()) => Err(match *state.lock().unwrap() {
            SourceState::Changed => "source-changed".into(),
            SourceState::Missing => "source-missing".into(),
            SourceState::Cancelled => "cancelled".into(),
            _ => "source-unreadable".into(),
        }),
        Err(error) => Err(error.code.as_str().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(hash: &str, bytes: u64) -> BookPlan {
        BookPlan {
            content_hash: hash.into(),
            title: "Book".into(),
            file_name: "book.epub".into(),
            extension: "epub".into(),
            bytes,
            source: None,
            ready: true,
            code: None,
        }
    }

    #[test]
    fn preview_uses_shelf_bytes_without_opening_or_removing_books() {
        let hash = "a".repeat(64);
        let mut metadata = BTreeMap::new();
        metadata.insert(
            hash.clone(),
            BookMetadata {
                title: "Synthetic".into(),
                creator: "Author".into(),
                language: None,
                file_name: "Synthetic.epub".into(),
                added_at_ms: 1,
            },
        );
        let snapshot = ShelfSnapshot {
            root: PathBuf::from("/does/not/exist"),
            metadata,
            bindings: BTreeMap::new(),
        };
        let plans = plans_from_snapshot(&snapshot, &[hash.clone()]);
        let preview = preview_from_plans(&plans);
        assert_eq!(preview.books.len(), 1);
        assert!(!preview.books[0].ready);
        assert_eq!(preview.books[0].code.as_deref(), Some("source-unbound"));
        assert_eq!(preview.total_bytes, 0);
    }

    #[test]
    fn preview_marks_a_bound_book_ready_without_opening_its_source() {
        let hash = "d".repeat(64);
        let mut metadata = BTreeMap::new();
        metadata.insert(
            hash.clone(),
            BookMetadata {
                title: "Bound".into(),
                creator: "Author".into(),
                language: None,
                file_name: "Bound.epub".into(),
                added_at_ms: 1,
            },
        );
        let mut bindings = BTreeMap::new();
        bindings.insert(
            hash.clone(),
            LocalBinding {
                content_hash: hash.clone(),
                storage_kind: "linked".into(),
                canonical_source_path: Some("/definitely/missing/Bound.epub".into()),
                document_uri: None,
                managed_file_name: None,
                file_size: 123,
                source_mtime_ns: 0,
                cover_zip_path: None,
                cover_mime: String::new(),
                last_verified_at_ms: 1,
            },
        );
        let snapshot = ShelfSnapshot {
            root: PathBuf::from("/does/not/exist"),
            metadata,
            bindings,
        };
        let plans = plans_from_snapshot(&snapshot, &[hash]);
        let preview = preview_from_plans(&plans);
        assert!(preview.books[0].ready);
        assert_eq!(preview.books[0].bytes, 123);
        assert_eq!(preview.total_bytes, 123);
    }

    #[test]
    fn decisions_require_marker_and_matching_object_size() {
        let mut book = plan(&"a".repeat(64), 100);
        let mut entries = BTreeMap::new();
        entries.insert(format!("{}.epub", book.content_hash), Some(100));
        assert_eq!(decide(&book, &entries), Decision::Repair);
        entries.insert(format!("{}.ok", book.content_hash), None);
        assert_eq!(decide(&book, &entries), Decision::AlreadyPresent);
        entries.insert(format!("{}.epub", book.content_hash), Some(101));
        assert_eq!(decide(&book, &entries), Decision::Conflict);
        book.bytes = 100;
        entries.remove(&format!("{}.ok", book.content_hash));
        entries.insert(format!("{}.epub", book.content_hash), Some(100));
        assert_eq!(decide(&book, &entries), Decision::Repair);
        assert_eq!(
            decide(&plan(&"b".repeat(64), 100), &entries),
            Decision::Upload
        );
    }

    #[test]
    fn ten_thousand_present_books_only_need_shard_listing_planning() {
        let mut shards = BTreeSet::new();
        let mut all = Vec::new();
        for index in 0..10_000u32 {
            let hash = format!("{:02x}{:062x}", index % 256, index);
            shards.insert(shard_name(&hash).to_string());
            all.push(plan(&hash, 100));
        }
        assert_eq!(shards.len(), 256);
        for book in &all {
            let mut entries = BTreeMap::new();
            entries.insert(format!("{}.epub", book.content_hash), Some(100));
            entries.insert(format!("{}.ok", book.content_hash), None);
            assert_eq!(decide(book, &entries), Decision::AlreadyPresent);
        }
    }

    #[test]
    fn producer_cleanup_cancel_does_not_override_a_remote_failure() {
        let error = RemoteError {
            code: RemoteErrorCode::ServerError,
            http_status: Some(500),
            retry_after_seconds: None,
            cleanup_failed: false,
        };
        let failure = upload_error_failure(error, SourceState::Cancelled, false, false);
        assert_eq!(failure.code, "server-error");
        assert!(!failure.stop);
        assert_eq!(
            upload_error_failure(
                RemoteError {
                    code: RemoteErrorCode::ServerError,
                    http_status: Some(500),
                    retry_after_seconds: None,
                    cleanup_failed: false,
                },
                SourceState::Cancelled,
                true,
                false,
            )
            .code,
            "cancelled"
        );
    }

    #[test]
    fn marker_is_small_and_contains_the_stable_identity() {
        let book = plan(&"c".repeat(64), 1234);
        let bytes = marker_bytes(&book, "space-id").unwrap();
        assert!(bytes.len() as u64 <= MARKER_LIMIT);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["sha256"], "c".repeat(64));
        assert_eq!(value["bytes"], 1234);
        assert_eq!(value["extension"], "epub");
        assert_eq!(value["format"], MARKER_FORMAT);
    }

    fn gate_connection<R: Runtime>(handle: &AppHandle<R>, connection_id: &str) {
        commands::test_set_connection(
            handle,
            crate::cloud_sync::model::ConnectionInfo {
                connection_id: connection_id.into(),
                settings: crate::cloud_sync::model::Settings {
                    base_url: "https://nas.invalid/dav/".into(),
                    remote_root: "test dir".into(),
                    username: "test".into(),
                },
                space_id: "00000000-0000-4000-8000-000000000103".into(),
                device_label: "Test".into(),
            },
        );
    }

    #[test]
    fn upload_job_registers_before_preparation_and_background_cancels_it() {
        let app = tauri::test::mock_builder()
            .manage(commands::CloudSyncManager::default())
            .manage(CloudBookUploadManager::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        let connection_id = "00000000-0000-4000-8000-000000000102";
        gate_connection(&handle, connection_id);
        let epoch = commands::upload_start_epoch(&handle).unwrap();
        let job_id = "00000000-0000-4000-8000-000000000101";
        let start =
            start_upload_job(&handle, job_id.into(), connection_id.into(), 1, epoch).unwrap();
        assert_eq!(
            handle
                .state::<CloudBookUploadManager>()
                .current()
                .unwrap()
                .job_id,
            job_id
        );

        // This is the same path used by cloud_sync_set_context(false): it
        // first changes activity/epoch, then calls cancel_active.
        commands::test_apply_context(
            &handle,
            crate::cloud_sync::model::Activity {
                foreground: false,
                interaction_busy: false,
            },
        )
        .unwrap();
        assert!(start.job.cancel.check().is_err());
        let error = match start_upload_job(
            &handle,
            "00000000-0000-4000-8000-000000000104".into(),
            connection_id.into(),
            1,
            epoch,
        ) {
            Ok(_) => panic!("stale startup must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, FailureCode::Cancelled);
        drop(start);
        assert!(handle.state::<CloudBookUploadManager>().current().is_none());
    }

    #[test]
    fn upload_start_gate_rejects_admin_stale_epoch_and_old_connection() {
        let app = tauri::test::mock_builder()
            .manage(commands::CloudSyncManager::default())
            .manage(CloudBookUploadManager::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        let connection_id = "00000000-0000-4000-8000-000000000202";
        gate_connection(&handle, connection_id);
        let epoch = commands::upload_start_epoch(&handle).unwrap();
        let job_id = "00000000-0000-4000-8000-000000000201";
        commands::test_set_admin_busy(&handle, true);
        let error = match start_upload_job(&handle, job_id.into(), connection_id.into(), 1, epoch) {
            Ok(_) => panic!("admin operation must reject startup"),
            Err(error) => error,
        };
        assert_eq!(error.code, FailureCode::Busy);
        commands::test_set_admin_busy(&handle, false);

        let error = match start_upload_job(
            &handle,
            job_id.into(),
            connection_id.into(),
            1,
            epoch.wrapping_add(1),
        ) {
            Ok(_) => panic!("stale generation must reject startup"),
            Err(error) => error,
        };
        assert_eq!(error.code, FailureCode::Cancelled);

        let error = match start_upload_job(
            &handle,
            job_id.into(),
            "00000000-0000-4000-8000-000000000203".into(),
            1,
            epoch,
        ) {
            Ok(_) => panic!("old connection must reject startup"),
            Err(error) => error,
        };
        assert_eq!(error.code, FailureCode::ConnectionRequired);
        assert!(handle.state::<CloudBookUploadManager>().current().is_none());
    }
}

#[cfg(test)]
pub(crate) fn test_cleanup_file(root: &std::path::Path) -> PathBuf {
    cleanup_file(root)
}

#[cfg(test)]
pub(crate) fn test_cleanup_owner(remote: &WebDavRemote, space_id: &str) -> CleanupOwner {
    CleanupOwner::new(remote, space_id)
}

#[cfg(test)]
pub(crate) fn test_add_cleanup(path: &std::path::Path, owner: &CleanupOwner, entry: &str) -> bool {
    add_cleanup(path, owner, entry)
}

#[cfg(test)]
pub(crate) fn test_cleanup_scope_entries(
    path: &std::path::Path,
    owner: &CleanupOwner,
) -> (Vec<String>, bool) {
    let (file, invalid) = read_cleanup(path);
    if invalid {
        return (Vec::new(), true);
    }
    let entries = cleanup_scope_index(&file, owner)
        .map(|index| file.scopes[index].entries.clone())
        .unwrap_or_default();
    (entries, false)
}

#[cfg(test)]
pub(crate) async fn test_cleanup_remote(
    path: &std::path::Path,
    remote: &WebDavRemote,
    owner: &CleanupOwner,
    cancel: &Cancel,
) -> bool {
    cleanup_remote(path, remote, owner, cancel).await
}

#[cfg(test)]
pub(crate) fn test_plan(hash: String, bytes: u64) -> BookPlan {
    BookPlan {
        content_hash: hash,
        title: "Synthetic".into(),
        file_name: "Synthetic.epub".into(),
        extension: "epub".into(),
        bytes,
        source: None,
        ready: true,
        code: None,
    }
}

#[cfg(test)]
pub(crate) fn test_plan_with_file(hash: String, file: std::path::PathBuf, bytes: u64) -> BookPlan {
    let mut plan = test_plan(hash, bytes);
    plan.source = Some(BookSource::Path(file));
    plan
}

#[cfg(test)]
pub(crate) async fn test_resolve_complete(
    remote: &WebDavRemote,
    plan: &BookPlan,
    space_id: &str,
    caps: Capabilities,
) -> std::result::Result<bool, String> {
    resolve_complete(remote, plan, space_id, caps, &Cancel::default())
        .await
        .map_err(|error| error.code)
}

#[cfg(test)]
pub(crate) async fn test_write_marker(
    remote: &WebDavRemote,
    plan: &BookPlan,
    space_id: &str,
    caps: Capabilities,
) -> std::result::Result<(), String> {
    write_marker(remote, plan, space_id, caps, &Cancel::default())
        .await
        .map_err(|error| error.code)
}

#[cfg(test)]
pub(crate) fn test_paths(plan: &BookPlan) -> (String, String) {
    (object_name(plan), format!("{}.ok", plan.content_hash))
}

#[cfg(test)]
pub(crate) async fn test_run_upload_plans<R: Runtime>(
    app: &AppHandle<R>,
    remote: &WebDavRemote,
    plans: Vec<BookPlan>,
    connection_id: &str,
    space_id: &str,
    caps: Capabilities,
) -> Result<BookUploadResult> {
    test_run_upload_plans_with_cancel(
        app,
        remote,
        plans,
        connection_id,
        space_id,
        caps,
        Cancel::default(),
    )
    .await
}

#[cfg(test)]
pub(crate) async fn test_run_upload_plans_with_cancel<R: Runtime>(
    app: &AppHandle<R>,
    remote: &WebDavRemote,
    plans: Vec<BookPlan>,
    connection_id: &str,
    space_id: &str,
    caps: Capabilities,
    cancel: Cancel,
) -> Result<BookUploadResult> {
    let job = Arc::new(UploadJob {
        job_id: "00000000-0000-4000-8000-000000000098".into(),
        connection_id: connection_id.into(),
        cancel: cancel.clone(),
        latest: Mutex::new(None),
    });
    let identity = super::storage::Identity {
        schema_version: 1,
        installation_id: "00000000-0000-4000-8000-000000000001".into(),
        nonce: "00000000-0000-4000-8000-000000000002".into(),
    };
    let sink: ProgressSink = Arc::new(|_| {});
    let cleanup_root = std::env::temp_dir().join(format!(
        "epub-reader-er0018-cleanup-{}",
        crate::save_file::new_uuid().unwrap()
    ));
    let cleanup_path = cleanup_file(&cleanup_root);
    let result = run_upload(
        app,
        &cleanup_path,
        job,
        plans,
        remote,
        connection_id,
        space_id,
        caps,
        identity,
        sink,
        &cancel,
        false,
    )
    .await;
    let _ = std::fs::remove_dir_all(cleanup_root);
    result
}

#[cfg(test)]
pub(crate) async fn test_run_upload<R: Runtime>(
    app: &AppHandle<R>,
    remote: &WebDavRemote,
    files: Vec<(String, std::path::PathBuf, u64)>,
    connection_id: &str,
    space_id: &str,
    caps: Capabilities,
) -> Result<BookUploadResult> {
    let plans = files
        .into_iter()
        .map(|(hash, file, bytes)| BookPlan {
            content_hash: hash,
            title: "Synthetic".into(),
            file_name: "Synthetic.epub".into(),
            extension: "epub".into(),
            bytes,
            source: Some(BookSource::Path(file)),
            ready: true,
            code: None,
        })
        .collect();
    let job = Arc::new(UploadJob {
        job_id: "00000000-0000-4000-8000-000000000099".into(),
        connection_id: connection_id.into(),
        cancel: Cancel::default(),
        latest: Mutex::new(None),
    });
    let cancel = job.cancel.clone();
    let identity = super::storage::Identity {
        schema_version: 1,
        installation_id: "00000000-0000-4000-8000-000000000001".into(),
        nonce: "00000000-0000-4000-8000-000000000002".into(),
    };
    let sink: ProgressSink = Arc::new(|_| {});
    let cleanup_root = std::env::temp_dir().join(format!(
        "epub-reader-er0018-cleanup-{}",
        crate::save_file::new_uuid().unwrap()
    ));
    let cleanup_path = cleanup_file(&cleanup_root);
    let result = run_upload(
        app,
        &cleanup_path,
        job,
        plans,
        remote,
        connection_id,
        space_id,
        caps,
        identity,
        sink,
        &cancel,
        false,
    )
    .await;
    let _ = std::fs::remove_dir_all(cleanup_root);
    result
}
