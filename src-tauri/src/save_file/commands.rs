use super::archive::{
    plan_export_books, preview_missing_books, progress_conflict_hashes, scope_kind,
    select_export_state, validate_and_extract, write_export_archive,
};
use super::{
    copy_reader_with_progress, managed_book_path, new_staging_dir, new_uuid, parse_bindings,
    valid_job_id, LocalBinding, MissingBook, PreparedImport, ProgressReporter, SaveExportScope,
    SaveFileCancelResult, SaveFileCommitResult, SaveFileError, SaveFileExportResult,
    SaveFileLocation, SaveFilePrepareResult, SaveFileProgress,
};
use crate::linked_library::LinkedLibraryWriteState;
use crate::portable_state::{PortableStateV3, MAX_SAFE_COUNTER};
use crate::portable_state_commands::with_existing_store;
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct SaveFileManager {
    active: Mutex<Option<Arc<FileTask>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskPhase {
    Running,
    Prepared,
    Committing,
    Finished,
}

#[derive(Debug)]
struct FileTask {
    job_id: String,
    cancelled: AtomicBool,
    phase: Mutex<TaskPhase>,
    ready: Condvar,
    prepared: Mutex<Option<PreparedImport>>,
}

impl FileTask {
    fn new(job_id: &str) -> Self {
        Self {
            job_id: job_id.to_string(),
            cancelled: AtomicBool::new(false),
            phase: Mutex::new(TaskPhase::Running),
            ready: Condvar::new(),
            prepared: Mutex::new(None),
        }
    }
}

fn library_root(app: &AppHandle) -> Result<PathBuf, SaveFileError> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("linked-library"))
        .map_err(|error| SaveFileError::storage_error(format!("无法取得应用本地数据目录：{error}")))
}

fn cache_staging_dir(app: &AppHandle) -> Result<PathBuf, SaveFileError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| SaveFileError::storage_error(format!("无法取得应用缓存目录：{error}")))?
        .join("save-file-staging");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn lock_error() -> SaveFileError {
    SaveFileError::storage_error("存档文件任务锁已损坏")
}

fn reserve_job(app: &AppHandle, job_id: &str) -> Result<Arc<FileTask>, SaveFileError> {
    if !valid_job_id(job_id) {
        return Err(SaveFileError::invalid_request("jobId 必须是规范 UUID"));
    }
    let manager = app.state::<SaveFileManager>();
    let mut slot = manager.active.lock().map_err(|_| lock_error())?;
    if let Some(current) = slot.as_ref() {
        if current.job_id == job_id {
            return Err(SaveFileError::new(
                "conflict",
                "该 jobId 已经登记，拒绝碰撞",
            ));
        }
        return Err(SaveFileError::busy());
    }
    let task = Arc::new(FileTask::new(job_id));
    *slot = Some(task.clone());
    Ok(task)
}

fn active_task(app: &AppHandle, job_id: &str) -> Result<Arc<FileTask>, SaveFileError> {
    let manager = app.state::<SaveFileManager>();
    let slot = manager.active.lock().map_err(|_| lock_error())?;
    slot.as_ref()
        .filter(|task| task.job_id == job_id)
        .cloned()
        .ok_or_else(SaveFileError::not_found)
}

fn clear_active(app: &AppHandle, task: &Arc<FileTask>) {
    if let Some(manager) = app.try_state::<SaveFileManager>() {
        if let Ok(mut slot) = manager.active.lock() {
            if slot
                .as_ref()
                .map(|current| Arc::ptr_eq(current, task))
                .unwrap_or(false)
            {
                *slot = None;
            }
        }
    }
}

fn finish_task(app: &AppHandle, task: &Arc<FileTask>) {
    if let Ok(mut prepared) = task.prepared.lock() {
        *prepared = None;
    }
    if let Ok(mut phase) = task.phase.lock() {
        *phase = TaskPhase::Finished;
        task.ready.notify_all();
    }
    clear_active(app, task);
}

fn mark_prepared(task: &Arc<FileTask>, prepared: PreparedImport) -> bool {
    if task.cancelled.load(Ordering::Acquire) {
        return false;
    }
    let Ok(mut phase) = task.phase.lock() else {
        return false;
    };
    if *phase != TaskPhase::Running || task.cancelled.load(Ordering::Acquire) {
        return false;
    }
    let Ok(mut slot) = task.prepared.lock() else {
        return false;
    };
    *slot = Some(prepared);
    *phase = TaskPhase::Prepared;
    task.ready.notify_all();
    true
}

fn take_prepared_for_commit(task: &Arc<FileTask>) -> Result<PreparedImport, SaveFileError> {
    let mut phase = task.phase.lock().map_err(|_| lock_error())?;
    match *phase {
        TaskPhase::Prepared => {
            let prepared = task
                .prepared
                .lock()
                .map_err(|_| lock_error())?
                .take()
                .ok_or_else(|| SaveFileError::invalid_state("prepared import 资源缺失"))?;
            *phase = TaskPhase::Committing;
            Ok(prepared)
        }
        TaskPhase::Running => Err(SaveFileError::invalid_state(
            "prepare 尚未完成，不能 commit",
        )),
        TaskPhase::Committing => Err(SaveFileError::busy()),
        TaskPhase::Finished => Err(SaveFileError::not_found()),
    }
}

fn signal_android_cancel(app: &AppHandle, job_id: &str) {
    #[cfg(target_os = "android")]
    {
        let _ = crate::android_uri_bridge::cancel_write_blocking(app, job_id);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, job_id);
    }
}

fn cancel_task(
    app: &AppHandle,
    task: &Arc<FileTask>,
) -> Result<SaveFileCancelResult, SaveFileError> {
    let mut phase = task.phase.lock().map_err(|_| lock_error())?;
    match *phase {
        TaskPhase::Finished => {
            return Ok(SaveFileCancelResult {
                status: "already-finished".to_string(),
            })
        }
        TaskPhase::Committing => {
            return Ok(SaveFileCancelResult {
                status: "too-late".to_string(),
            })
        }
        TaskPhase::Prepared => {
            *phase = TaskPhase::Finished;
            let prepared = task.prepared.lock().map_err(|_| lock_error())?.take();
            task.ready.notify_all();
            drop(phase);
            drop(prepared);
            clear_active(app, task);
            return Ok(SaveFileCancelResult {
                status: "cancelled".to_string(),
            });
        }
        TaskPhase::Running => {
            task.cancelled.store(true, Ordering::Release);
            drop(phase);
            signal_android_cancel(app, &task.job_id);
            let mut phase = task.phase.lock().map_err(|_| lock_error())?;
            while *phase != TaskPhase::Finished {
                phase = task.ready.wait(phase).map_err(|_| lock_error())?;
            }
            return Ok(SaveFileCancelResult {
                status: "cancelled".to_string(),
            });
        }
    }
}

fn store_parts(
    app: &AppHandle,
) -> Result<(PortableStateV3, std::collections::BTreeMap<String, String>), SaveFileError> {
    let result = with_existing_store(app, |store| {
        let snapshot = store.snapshot()?;
        let bindings = store.bindings_raw()?;
        Ok((snapshot, bindings))
    })
    .map_err(SaveFileError::from)?;
    result.ok_or_else(|| SaveFileError::storage_error("可移植资料仓储尚未激活"))
}

fn export_temp_path(
    app: &AppHandle,
    destination: &SaveFileLocation,
    package_id: &str,
) -> Result<PathBuf, SaveFileError> {
    match destination {
        SaveFileLocation::Path { path } => {
            let destination_path = PathBuf::from(path);
            let parent = destination_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty());
            let parent =
                parent.ok_or_else(|| SaveFileError::invalid_request("目标路径缺少父目录"))?;
            if !parent.exists() {
                return Err(SaveFileError::invalid_request("目标目录不存在"));
            }
            Ok(parent.join(format!(
                ".epub-reader-{package_id}.{}.part",
                std::process::id()
            )))
        }
        SaveFileLocation::Uri { .. } => {
            let dir = cache_staging_dir(app)?;
            Ok(dir.join(format!("{package_id}.epubsave.part")))
        }
    }
}

fn destination_path(destination: &SaveFileLocation) -> Result<PathBuf, SaveFileError> {
    match destination {
        SaveFileLocation::Path { path } => {
            let path = PathBuf::from(path);
            if path.as_os_str().is_empty() {
                return Err(SaveFileError::invalid_request("目标路径不能为空"));
            }
            if path.is_dir() {
                return Err(SaveFileError::invalid_request("目标路径不能是目录"));
            }
            Ok(path)
        }
        SaveFileLocation::Uri { uri } => {
            if !uri.starts_with("content://") {
                return Err(SaveFileError::invalid_request(
                    "Android 目标必须是 content:// URI",
                ));
            }
            Ok(PathBuf::new())
        }
    }
}

fn run_export(
    app: AppHandle,
    task: Arc<FileTask>,
    destination: SaveFileLocation,
    scope: SaveExportScope,
    include_books: bool,
    on_progress: Channel<SaveFileProgress>,
) -> Result<SaveFileExportResult, SaveFileError> {
    let root = library_root(&app)?;
    let (snapshot, raw_bindings) = store_parts(&app)?;
    let bindings = parse_bindings(raw_bindings)?;
    let (state, selected_hashes) = select_export_state(&snapshot, &scope)?;
    let scope_kind = scope_kind(&scope).to_string();
    let (plans, skipped_books) = plan_export_books(&root, &state, &bindings, include_books);
    if task.cancelled.load(Ordering::Acquire) {
        return Ok(SaveFileExportResult {
            status: "cancelled".to_string(),
            job_id: task.job_id.clone(),
            package_id: None,
            written_books: 0,
            book_bytes: 0,
            archive_bytes: None,
            skipped_books,
        });
    }

    let package_id = new_uuid()?;
    let temp_path = export_temp_path(&app, &destination, &package_id)?;
    let _temp_guard = TempPathGuard(temp_path.clone());
    let total_archive_bytes: Option<u64> = None;
    let mut reporter = ProgressReporter::new(on_progress.clone(), "preparing", None);
    let stats = match write_export_archive(
        &temp_path,
        &package_id,
        &state,
        &plans,
        &scope_kind,
        &selected_hashes,
        &mut reporter,
        &task.cancelled,
    ) {
        Ok(stats) => stats,
        Err(error) if error.code == "cancelled" => {
            return Ok(SaveFileExportResult {
                status: "cancelled".to_string(),
                job_id: task.job_id.clone(),
                package_id: Some(package_id),
                written_books: 0,
                book_bytes: 0,
                archive_bytes: total_archive_bytes,
                skipped_books,
            });
        }
        Err(error) => return Err(error),
    };

    if task.cancelled.load(Ordering::Acquire) {
        return Ok(SaveFileExportResult {
            status: "cancelled".to_string(),
            job_id: task.job_id.clone(),
            package_id: Some(package_id),
            written_books: 0,
            book_bytes: 0,
            archive_bytes: Some(stats.archive_bytes),
            skipped_books,
        });
    }

    match destination {
        SaveFileLocation::Path { path } => {
            let target = PathBuf::from(path);
            reporter.set_phase("finalizing", Some(stats.archive_bytes));
            crate::save_file::atomic_replace(&temp_path, &target).map_err(|error| {
                SaveFileError::storage_error(format!("无法替换导出目标：{error}"))
            })?;
            // Temp path no longer exists after the rename.
            std::mem::forget(_temp_guard);
        }
        SaveFileLocation::Uri { uri } => {
            #[cfg(target_os = "android")]
            {
                reporter.set_phase("copying", Some(stats.archive_bytes));
                if let Err(error) = crate::android_uri_bridge::write_staged_file_blocking(
                    &app,
                    &uri,
                    &temp_path,
                    &task.job_id,
                ) {
                    if task.cancelled.load(Ordering::Acquire) {
                        return Ok(SaveFileExportResult {
                            status: "cancelled".to_string(),
                            job_id: task.job_id.clone(),
                            package_id: Some(package_id.clone()),
                            written_books: 0,
                            book_bytes: 0,
                            archive_bytes: Some(stats.archive_bytes),
                            skipped_books,
                        });
                    }
                    return Err(SaveFileError::storage_error(error));
                }
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (&app, &uri, &temp_path);
                return Err(SaveFileError::unsupported_platform(
                    "content URI 导出只在 Android 可用",
                ));
            }
        }
    }
    reporter.force();

    Ok(SaveFileExportResult {
        status: "written".to_string(),
        job_id: task.job_id.clone(),
        package_id: Some(package_id),
        written_books: stats.written_books,
        book_bytes: stats.book_bytes,
        archive_bytes: Some(stats.archive_bytes),
        skipped_books,
    })
}

struct TempPathGuard(PathBuf);

impl Drop for TempPathGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn run_prepare(
    app: AppHandle,
    task: Arc<FileTask>,
    source: SaveFileLocation,
    on_progress: Channel<SaveFileProgress>,
) -> Result<SaveFilePrepareResult, SaveFileError> {
    let root = library_root(&app)?;
    let staging_dir = new_staging_dir(&root, &task.job_id)?;
    match prepare_into_staging(&app, &task, &source, &staging_dir, &on_progress) {
        Ok(preview) => Ok(preview),
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_dir);
            Err(error)
        }
    }
}

fn prepare_into_staging(
    app: &AppHandle,
    task: &Arc<FileTask>,
    source: &SaveFileLocation,
    staging_dir: &Path,
    on_progress: &Channel<SaveFileProgress>,
) -> Result<SaveFilePrepareResult, SaveFileError> {
    let source_path = staging_dir.join("source.epubsave");
    let mut reporter = ProgressReporter::new(on_progress.clone(), "reading", None);

    match source {
        SaveFileLocation::Path { path } => {
            let path = PathBuf::from(path);
            let metadata = fs::metadata(&path).map_err(|error| {
                SaveFileError::storage_error(format!("无法读取源存档属性：{error}"))
            })?;
            if !metadata.is_file() {
                return Err(SaveFileError::invalid_request("源存档不是普通文件"));
            }
            reporter.set_total(Some(metadata.len()));
            let mut reader = File::open(&path)?;
            let mut writer = File::create(&source_path)?;
            let copied = copy_reader_with_progress(
                &mut reader,
                &mut writer,
                &mut reporter,
                &task.cancelled,
            )?;
            writer.sync_all()?;
            if copied != metadata.len() {
                return Err(SaveFileError::invalid_data("源存档长度在读取期间发生变化"));
            }
        }
        SaveFileLocation::Uri { uri } => {
            #[cfg(target_os = "android")]
            {
                let mut reader = crate::android_uri_bridge::open_content_uri(app, uri)
                    .map_err(|error| SaveFileError::storage_error(error.to_string()))?;
                reporter.set_total(reader.declared_length());
                let mut writer = File::create(&source_path)?;
                let mut reporting = ReportingWriter {
                    inner: &mut writer,
                    reporter: &mut reporter,
                };
                reader
                    .copy_limited_to(&mut reporting, &|| task.cancelled.load(Ordering::Acquire))
                    .map_err(|error| SaveFileError::storage_error(error.to_string()))?;
                writer.sync_all()?;
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, uri, &mut reporter, &source_path);
                return Err(SaveFileError::unsupported_platform(
                    "content URI 导入只在 Android 可用",
                ));
            }
        }
    }

    if task.cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }

    let validated =
        validate_and_extract(&source_path, staging_dir, &mut reporter, &task.cancelled)?;
    if task.cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }

    let root = library_root(app)?;
    let (local_snapshot, raw_bindings) = store_parts(app)?;
    let local_bindings = parse_bindings(raw_bindings)?;
    let mut missing = preview_missing_books(&validated.incoming, &validated.attachments);
    missing.retain(|book| {
        !local_bindings
            .get(&book.content_hash)
            .map(|binding| binding.is_valid(&root))
            .unwrap_or(false)
    });
    let progress_conflict_count =
        super::archive::count_progress_conflicts(&local_snapshot, &validated.incoming)?;
    let local_hashes: BTreeSet<&str> = local_snapshot.books.keys().map(String::as_str).collect();
    let new_book_count = validated
        .incoming
        .books
        .keys()
        .filter(|hash| !local_hashes.contains(hash.as_str()))
        .count();
    let preview = SaveFilePrepareResult {
        status: "prepared".to_string(),
        job_id: task.job_id.clone(),
        package_id: validated.package_id.clone(),
        scope_kind: validated.scope_kind.clone(),
        book_count: validated.incoming.books.len(),
        attached_books: validated
            .attachments
            .iter()
            .map(|attachment| attachment.content_hash.clone())
            .collect(),
        missing_books: missing,
        progress_conflict_count,
        new_book_count,
        has_preferences: validated.incoming.preferences.is_some(),
        source_bytes: validated.source_bytes,
        total_uncompressed_bytes: validated.total_uncompressed_bytes,
    };

    let prepared = PreparedImport {
        package_id: validated.package_id,
        staging_dir: staging_dir.to_path_buf(),
        incoming: validated.incoming,
        attachments: validated.attachments,
        source_bytes: validated.source_bytes,
        total_uncompressed_bytes: validated.total_uncompressed_bytes,
        preview,
    };

    if !mark_prepared(task, prepared) {
        return Err(SaveFileError::cancelled());
    }
    Ok(task
        .prepared
        .lock()
        .map_err(|_| lock_error())?
        .as_ref()
        .expect("just stored")
        .preview
        .clone())
}

#[allow(dead_code)]
struct ReportingWriter<'a, W: Write> {
    inner: W,
    reporter: &'a mut ProgressReporter,
}

impl<W: Write> Write for ReportingWriter<'_, W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.reporter.add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn compute_missing_books(
    incoming: &PortableStateV3,
    attachments: &[super::PreparedAttachment],
    local_bindings: &std::collections::BTreeMap<String, LocalBinding>,
    root: &Path,
    published_hashes: &BTreeSet<String>,
) -> Vec<MissingBook> {
    let attached: BTreeSet<&str> = attachments
        .iter()
        .map(|attachment| attachment.content_hash.as_str())
        .collect();
    incoming
        .books
        .iter()
        .filter(|(hash, _)| {
            if attached.contains(hash.as_str()) || published_hashes.contains(hash.as_str()) {
                return false;
            }
            !local_bindings
                .get(hash.as_str())
                .map(|binding| binding.is_valid(root))
                .unwrap_or(false)
        })
        .map(|(hash, book)| MissingBook {
            content_hash: hash.clone(),
            title: book.metadata.value.title.clone(),
        })
        .collect()
}

fn cleanup_published_targets(targets: &[(PathBuf, bool)]) -> Result<(), SaveFileError> {
    let mut failures = Vec::new();
    let mut residual = Vec::new();
    for (path, existed_before) in targets {
        if *existed_before {
            residual.push(path.display().to_string());
            continue;
        }
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("{}：{error}", path.display())),
        }
    }
    if failures.is_empty() && residual.is_empty() {
        Ok(())
    } else {
        let mut parts = Vec::new();
        if !failures.is_empty() {
            parts.push(format!("无法回收本任务新建副本：{}", failures.join("；")));
        }
        if !residual.is_empty() {
            parts.push(format!("已覆盖的既有文件无法恢复：{}", residual.join("；")));
        }
        Err(SaveFileError::storage_error(parts.join("；")))
    }
}

fn run_commit(
    app: AppHandle,
    task: Arc<FileTask>,
    prepared: PreparedImport,
    apply_preferences: bool,
    on_progress: Channel<SaveFileProgress>,
) -> Result<SaveFileCommitResult, SaveFileError> {
    let root = library_root(&app)?;
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _write_guard = write_state
        .0
        .lock()
        .map_err(|_| SaveFileError::storage_error("链接书库写入锁已损坏"))?;

    let mut reporter = ProgressReporter::new(
        on_progress.clone(),
        "committing",
        Some(prepared.total_uncompressed_bytes),
    );
    let (local_snapshot, raw_bindings) = store_parts(&app)?;
    let local_bindings = parse_bindings(raw_bindings)?;
    let visible_before = with_existing_store(&app, |store| store.local_visible_hashes())
        .map_err(SaveFileError::from)?
        .ok_or_else(|| SaveFileError::storage_error("可移植资料仓储尚未激活"))?;

    let mut published_targets: Vec<(PathBuf, bool)> = Vec::new();
    let result: Result<SaveFileCommitResult, SaveFileError> = (|| {
        let mut binding_rows: Vec<(String, String)> = Vec::new();
        let mut published_hashes = BTreeSet::new();
        for attachment in &prepared.attachments {
            if task.cancelled.load(Ordering::Acquire) {
                return Err(SaveFileError::cancelled());
            }
            if local_bindings
                .get(&attachment.content_hash)
                .map(|binding| binding.is_valid(&root))
                .unwrap_or(false)
            {
                continue;
            }
            let target = managed_book_path(&root, &attachment.content_hash);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let existed_before = target.exists();
            crate::save_file::atomic_replace(&attachment.staging_path, &target).map_err(
                |error| {
                    SaveFileError::storage_error(format!(
                        "无法发布本机 managed 副本（{}）：{error}",
                        attachment.content_hash
                    ))
                },
            )?;
            published_targets.push((target.clone(), existed_before));
            published_hashes.insert(attachment.content_hash.clone());
            let metadata = fs::metadata(&target)?;
            let binding = LocalBinding::new_managed(
                &attachment.content_hash,
                metadata.len(),
                metadata_mtime_ns(&metadata),
            );
            let raw = serde_json::to_string(&binding).map_err(|error| {
                SaveFileError::storage_error(format!("设备绑定无法序列化：{error}"))
            })?;
            binding_rows.push((attachment.content_hash.clone(), raw));
        }

        let missing_books = compute_missing_books(
            &prepared.incoming,
            &prepared.attachments,
            &local_bindings,
            &root,
            &published_hashes,
        );
        let progress_conflict_books =
            progress_conflict_hashes(&local_snapshot, &prepared.incoming)?;
        let new_visible: Vec<String> = prepared
            .incoming
            .books
            .keys()
            .filter(|hash| !visible_before.contains(hash))
            .cloned()
            .collect();
        let incoming_hashes: Vec<String> = prepared.incoming.books.keys().cloned().collect();

        let merged = with_existing_store(&app, |store| {
            store.merge_validated_import(
                prepared.incoming.clone(),
                binding_rows.clone(),
                apply_preferences,
            )
        })
        .map_err(SaveFileError::from)
        .and_then(|result| {
            result.ok_or_else(|| SaveFileError::storage_error("可移植资料仓储尚未激活"))
        })?;
        reporter.force();
        let applied_preferences = apply_preferences && prepared.incoming.preferences.is_some();
        Ok(SaveFileCommitResult {
            status: "committed".to_string(),
            job_id: task.job_id.clone(),
            merged_books: merged.books.len(),
            imported_books: incoming_hashes,
            new_visible_books: new_visible,
            missing_books,
            progress_conflict_books,
            applied_preferences,
        })
    })();

    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            let cleanup = cleanup_published_targets(&published_targets);
            let message = match cleanup {
                Ok(()) => error.message,
                Err(cleanup_error) => format!("{}；{}", error.message, cleanup_error.message),
            };
            Err(SaveFileError {
                code: error.code,
                message,
            })
        }
    }
}

fn metadata_mtime_ns(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(MAX_SAFE_COUNTER as u128) as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn save_file_export(
    app: AppHandle,
    job_id: String,
    destination: SaveFileLocation,
    scope: SaveExportScope,
    include_books: bool,
    on_progress: Channel<SaveFileProgress>,
) -> Result<SaveFileExportResult, SaveFileError> {
    let _ = destination_path(&destination)?;
    let task = reserve_job(&app, &job_id)?;
    let worker_app = app.clone();
    let worker_task = task.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        let result = run_export(
            worker_app.clone(),
            worker_task.clone(),
            destination,
            scope,
            include_books,
            on_progress,
        );
        finish_task(&worker_app, &worker_task);
        result
    })
    .await;
    match join {
        Ok(result) => result,
        Err(error) => {
            finish_task(&app, &task);
            Err(SaveFileError::storage_error(format!(
                "导出工作线程失败：{error}"
            )))
        }
    }
}

#[tauri::command]
pub async fn save_file_prepare_import(
    app: AppHandle,
    job_id: String,
    source: SaveFileLocation,
    on_progress: Channel<SaveFileProgress>,
) -> Result<SaveFilePrepareResult, SaveFileError> {
    let task = reserve_job(&app, &job_id)?;
    let worker_app = app.clone();
    let worker_task = task.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        let result = run_prepare(worker_app.clone(), worker_task.clone(), source, on_progress);
        if result.is_err() {
            finish_task(&worker_app, &worker_task);
        }
        result
    })
    .await;
    match join {
        Ok(result) => result,
        Err(error) => {
            finish_task(&app, &task);
            Err(SaveFileError::storage_error(format!(
                "导入准备工作线程失败：{error}"
            )))
        }
    }
}

#[tauri::command]
pub async fn save_file_commit_import(
    app: AppHandle,
    job_id: String,
    apply_preferences: bool,
    on_progress: Channel<SaveFileProgress>,
) -> Result<SaveFileCommitResult, SaveFileError> {
    let task = active_task(&app, &job_id)?;
    let prepared = take_prepared_for_commit(&task)?;
    let worker_app = app.clone();
    let worker_task = task.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        let result = run_commit(
            worker_app.clone(),
            worker_task.clone(),
            prepared,
            apply_preferences,
            on_progress,
        );
        finish_task(&worker_app, &worker_task);
        result
    })
    .await;
    match join {
        Ok(result) => result,
        Err(error) => {
            finish_task(&app, &task);
            Err(SaveFileError::storage_error(format!(
                "导入提交工作线程失败：{error}"
            )))
        }
    }
}

#[tauri::command]
pub fn save_file_cancel(
    app: AppHandle,
    job_id: String,
) -> Result<SaveFileCancelResult, SaveFileError> {
    let task = match active_task(&app, &job_id) {
        Ok(task) => task,
        Err(error) if error.code == "not-found" => {
            return Ok(SaveFileCancelResult {
                status: "already-finished".to_string(),
            })
        }
        Err(error) => return Err(error),
    };
    cancel_task(&app, &task)
}
