//! Resumable model-package downloads.
//!
//! This module is deliberately separate from the reader/index job queue.  It
//! owns one FIFO worker and treats a package as an all-or-nothing install:
//! files are downloaded below `.staging`, verified, then renamed into a new
//! package directory.  No downloaded bytes are passed through WebView IPC.

use super::models::{
    is_reparse_point, is_supported_model_file, resolve_model_file, validate_relative_path,
    ModelDownloadTaskRecord, ModelManifestFile, ModelPackageManifest, ModelPackageRecord,
};
use super::{AiState, AiStore};
use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, RANGE};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, State};

pub(crate) trait DiskSpace: Send + Sync {
    fn available_bytes(&self, path: &Path) -> Result<Option<u64>, String>;
}

pub(crate) trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }
}

pub(crate) struct FsDiskSpace;

impl DiskSpace for FsDiskSpace {
    fn available_bytes(&self, path: &Path) -> Result<Option<u64>, String> {
        fs2::available_space(path)
            .map(Some)
            .map_err(|error| format!("读取模型库剩余磁盘空间失败：{error}"))
    }
}

pub(crate) struct HttpResponse {
    pub status: u16,
    pub content_range: Option<String>,
    pub reader: Box<dyn Read + Send>,
}

pub(crate) trait HttpClient: Send + Sync {
    fn get(&self, url: &str, range_start: Option<u64>) -> Result<HttpResponse, String>;
}

pub(crate) struct ReqwestHttpClient {
    client: Client,
}

impl ReqwestHttpClient {
    pub(crate) fn new() -> Result<Self, String> {
        Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            // In reqwest 0.13 blocking mode this is an operation/read-write
            // idle timeout (reset for each Response::read), not a total
            // request deadline, so multi-GB transfers remain supported.
            .timeout(std::time::Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if redirect_is_allowed(attempt.previous().len(), attempt.url().scheme()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map(|client| Self { client })
            .map_err(|error| format!("创建模型下载 HTTP 客户端失败：{error}"))
    }
}

fn redirect_is_allowed(previous_count: usize, scheme: &str) -> bool {
    previous_count < 5 && matches!(scheme, "http" | "https")
}

impl HttpClient for ReqwestHttpClient {
    fn get(&self, url: &str, range_start: Option<u64>) -> Result<HttpResponse, String> {
        let mut request = self.client.get(url);
        if let Some(start) = range_start {
            let value = HeaderValue::from_str(&format!("bytes={start}-"))
                .map_err(|error| format!("构造 Range 请求失败：{error}"))?;
            request = request.header(RANGE, value);
        }
        let response = request
            .send()
            .map_err(|error| format!("模型文件请求失败：{error}"))?;
        let status = response.status().as_u16();
        let content_range = response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        Ok(HttpResponse {
            status,
            content_range,
            reader: Box::new(response),
        })
    }
}

#[derive(Default)]
pub(crate) struct DownloadControl {
    pause: AtomicBool,
    cancel: AtomicBool,
}

impl DownloadControl {
    fn requested(&self) -> Option<DownloadSignal> {
        if self.cancel.load(Ordering::Acquire) {
            Some(DownloadSignal::Cancel)
        } else if self.pause.load(Ordering::Acquire) {
            Some(DownloadSignal::Pause)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadSignal {
    Pause,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadEnqueueResult {
    pub task: ModelDownloadTaskRecord,
    pub existing: bool,
}

struct QueueState {
    queue: VecDeque<String>,
    controls: HashMap<String, Arc<DownloadControl>>,
    running: bool,
}

fn pop_or_stop(queue: &mut QueueState) -> Option<String> {
    match queue.queue.pop_front() {
        Some(task_id) => Some(task_id),
        None => {
            // The empty check and running=false transition are one critical
            // section so enqueue cannot slip into a lost-worker window.
            queue.running = false;
            None
        }
    }
}

pub(crate) struct DownloadManager {
    state: Arc<Mutex<QueueState>>,
    disk_space: Arc<dyn DiskSpace>,
    clock: Arc<dyn Clock>,
}

pub(crate) fn ai_model_download_enqueue_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
) -> Result<DownloadEnqueueResult, String> {
    let store = state.ensure(&app)?;
    state.downloads.enqueue(store, package_id)
}

pub(crate) fn ai_model_download_list_impl(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<ModelDownloadTaskRecord>, String> {
    state.ensure(&app)?.list_model_download_tasks()
}

pub(crate) fn ai_model_download_pause_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    task_id: String,
) -> Result<ModelDownloadTaskRecord, String> {
    let store = state.ensure(&app)?;
    state.downloads.pause(&store, &task_id)
}

pub(crate) fn ai_model_download_resume_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    task_id: String,
) -> Result<ModelDownloadTaskRecord, String> {
    let store = state.ensure(&app)?;
    state.downloads.resume(store, &task_id)
}

pub(crate) fn ai_model_download_cancel_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    task_id: String,
) -> Result<ModelDownloadTaskRecord, String> {
    let store = state.ensure(&app)?;
    state.downloads.cancel(&store, &task_id)
}

pub(crate) fn ai_model_license_accept_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
) -> Result<(), String> {
    state.ensure(&app)?.accept_model_license(&package_id)
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(QueueState {
                queue: VecDeque::new(),
                controls: HashMap::new(),
                running: false,
            })),
            disk_space: Arc::new(FsDiskSpace),
            clock: Arc::new(SystemClock),
        }
    }
}

impl DownloadManager {
    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn with_disk_space(disk_space: Arc<dyn DiskSpace>) -> Self {
        Self {
            state: Arc::new(Mutex::new(QueueState {
                queue: VecDeque::new(),
                controls: HashMap::new(),
                running: false,
            })),
            disk_space,
            clock: Arc::new(SystemClock),
        }
    }

    pub(crate) fn enqueue(
        &self,
        store: Arc<AiStore>,
        package_id: String,
    ) -> Result<DownloadEnqueueResult, String> {
        let _request_started_at = self.clock.now_ms();
        let package = store
            .get_model_package(&package_id)?
            .ok_or_else(|| "模型包不存在".to_string())?;
        if package.state == "installed" {
            return Err("模型包已经安装".into());
        }
        if package.storage_kind == "linked" {
            return Err("linked 模型包不允许由下载器写入".into());
        }
        if package.requires_acceptance && !store.is_model_license_accepted(&package_id)? {
            return Err("请先接受模型许可证".into());
        }
        let root = store
            .model_library_path()?
            .map(PathBuf::from)
            .ok_or_else(|| "尚未设置模型库目录".to_string())?;
        if !root.is_dir() {
            return Err("模型库目录不存在或不是目录".into());
        }
        if package.files.is_empty() || package.sources.is_empty() {
            return Err("模型包缺少文件或下载来源".into());
        }
        let required = required_disk_space(&package)?;
        if let Some(available) = self.disk_space.available_bytes(&root)? {
            if available < required {
                return Err("模型库所在磁盘空间不足".into());
            }
        }
        let task = store.create_or_get_model_download_task(&package_id)?;
        if task.state != "queued" {
            // Existing paused/downloading/verifying tasks are returned as-is;
            // only an explicit resume may requeue a paused task.
            return Ok(DownloadEnqueueResult {
                task,
                existing: true,
            });
        }
        if task.state == "queued" {
            store.set_model_package_state(&package_id, "queued")?;
        }
        let (existing, should_start) = {
            let control = Arc::new(DownloadControl::default());
            let mut state = self.state.lock().map_err(|_| "模型下载队列锁已损坏")?;
            let existing = state.queue.iter().any(|id| id == &task.id)
                || state.controls.contains_key(&task.id);
            if existing {
                (true, false)
            } else {
                state.queue.push_back(task.id.clone());
                state.controls.insert(task.id.clone(), control);
                let should_start = if state.running {
                    false
                } else {
                    state.running = true;
                    true
                };
                (false, should_start)
            }
        };
        if should_start {
            self.start_worker(store, Arc::clone(&self.disk_space));
        }
        Ok(DownloadEnqueueResult { task, existing })
    }

    fn start_worker(&self, store: Arc<AiStore>, disk_space: Arc<dyn DiskSpace>) {
        let state = Arc::clone(&self.state);
        thread::spawn(move || loop {
            let task_id = {
                let Ok(mut queue) = state.lock() else { return };
                pop_or_stop(&mut queue)
            };
            let Some(task_id) = task_id else {
                return;
            };
            let Some(control) = state
                .lock()
                .ok()
                .and_then(|queue| queue.controls.get(&task_id).cloned())
            else {
                continue;
            };
            let _ = run_task(&store, &task_id, control, disk_space.as_ref());
            if let Ok(mut queue) = state.lock() {
                queue.controls.remove(&task_id);
            }
        });
    }

    /*
     * Kept as a separate helper for tests and diagnostics.  `start_worker`
     * above deliberately does not manufacture a default control when a
     * queued task was cancelled between pop and claim.
     */
    #[allow(dead_code)]
    fn worker_is_running(&self) -> bool {
        self.state
            .lock()
            .map(|queue| queue.running)
            .unwrap_or(false)
    }

    pub(crate) fn pause(
        &self,
        store: &AiStore,
        task_id: &str,
    ) -> Result<ModelDownloadTaskRecord, String> {
        if let Ok(queue) = self.state.lock() {
            if let Some(control) = queue.controls.get(task_id) {
                control.pause.store(true, Ordering::Release);
            }
        }
        let task = store
            .get_model_download_task(task_id)?
            .ok_or_else(|| "模型下载任务不存在".to_string())?;
        if task.state == "queued" {
            if let Ok(mut queue) = self.state.lock() {
                queue.queue.retain(|id| id != task_id);
            }
            store.update_model_download_task(
                task_id,
                "paused",
                task.bytes_downloaded,
                task.current_file_path.as_deref(),
                task.current_file_index,
                task.current_source_url.as_deref(),
                task.source_index,
                None,
            )
        } else {
            store
                .get_model_download_task(task_id)?
                .ok_or_else(|| "模型下载任务不存在".into())
        }
    }

    pub(crate) fn resume(
        &self,
        store: Arc<AiStore>,
        task_id: &str,
    ) -> Result<ModelDownloadTaskRecord, String> {
        let task = store
            .get_model_download_task(task_id)?
            .ok_or_else(|| "模型下载任务不存在".to_string())?;
        if !matches!(task.state.as_str(), "paused" | "failed") {
            return Ok(task);
        }
        let Some(task) = store.queue_model_download_task(task_id)? else {
            return store
                .get_model_download_task(task_id)?
                .ok_or_else(|| "模型下载任务不存在".into());
        };
        let control = Arc::new(DownloadControl::default());
        let should_start = {
            let mut queue = self.state.lock().map_err(|_| "模型下载队列锁已损坏")?;
            queue.queue.push_back(task_id.to_string());
            queue
                .controls
                .insert(task_id.to_string(), Arc::clone(&control));
            if queue.running {
                false
            } else {
                queue.running = true;
                true
            }
        };
        store.set_model_package_state(&task.package_id, "queued")?;
        if should_start {
            self.start_worker(Arc::clone(&store), Arc::clone(&self.disk_space));
        }
        store
            .get_model_download_task(task_id)?
            .ok_or_else(|| "模型下载任务不存在".into())
    }

    pub(crate) fn cancel(
        &self,
        store: &AiStore,
        task_id: &str,
    ) -> Result<ModelDownloadTaskRecord, String> {
        let task = store
            .get_model_download_task(task_id)?
            .ok_or_else(|| "模型下载任务不存在".to_string())?;
        if matches!(task.state.as_str(), "downloading" | "verifying") {
            if let Ok(queue) = self.state.lock() {
                if let Some(control) = queue.controls.get(task_id) {
                    control.cancel.store(true, Ordering::Release);
                }
            }
            // The worker owns the response/file handles.  IPC only signals it;
            // cleanup happens after the worker observes the signal.
            return Ok(task);
        }
        if let Ok(mut queue) = self.state.lock() {
            queue.queue.retain(|id| id != task_id);
            queue.controls.remove(task_id);
        }
        if matches!(task.state.as_str(), "completed" | "cancelled") {
            return Ok(task);
        }
        let result = store.update_model_download_task(
            task_id,
            "cancelled",
            task.bytes_downloaded,
            task.current_file_path.as_deref(),
            task.current_file_index,
            task.current_source_url.as_deref(),
            task.source_index,
            Some("用户取消下载"),
        )?;
        store.set_model_package_state(&task.package_id, "uninstalled")?;
        let root = store
            .model_library_path()?
            .map(PathBuf::from)
            .ok_or_else(|| "尚未设置模型库目录".to_string())?;
        if let Err(error) = remove_staging_for_task(&root, &task.package_id, task_id) {
            let _ = store.update_model_download_task(
                task_id,
                "failed",
                task.bytes_downloaded,
                task.current_file_path.as_deref(),
                task.current_file_index,
                task.current_source_url.as_deref(),
                task.source_index,
                Some(&error),
            );
            let _ = store.set_model_package_state(&task.package_id, "failed");
            return Err(error);
        }
        Ok(result)
    }

    pub(crate) fn pause_all(&self, store: &AiStore) {
        if let Ok(queue) = self.state.lock() {
            for control in queue.controls.values() {
                control.pause.store(true, Ordering::Release);
            }
        }
        store.pause_all_model_downloads();
    }
}

fn run_task(
    store: &AiStore,
    task_id: &str,
    control: Arc<DownloadControl>,
    disk_space: &dyn DiskSpace,
) -> Result<(), String> {
    let client = ReqwestHttpClient::new()?;
    run_task_with_client(store, task_id, control, disk_space, &client)
}

fn run_task_with_client(
    store: &AiStore,
    task_id: &str,
    control: Arc<DownloadControl>,
    disk_space: &dyn DiskSpace,
    client: &dyn HttpClient,
) -> Result<(), String> {
    let Some(task) = store.claim_model_download_task(task_id)? else {
        // The task may have been cancelled after leaving the queue but before
        // this worker obtained the DB lock.  Never contact the network.
        return Ok(());
    };
    let package = store
        .get_model_package(&task.package_id)?
        .ok_or_else(|| "模型包不存在".to_string())?;
    let root = store
        .model_library_path()?
        .map(PathBuf::from)
        .ok_or_else(|| "尚未设置模型库目录".to_string())?;
    let manifest = manifest_from_record(&package)?;
    if let Some(recovered) = recover_committed_package(store, &root, &package, &manifest, task_id)?
    {
        return recovered;
    }
    store.set_model_package_state(&package.package_id, "downloading")?;
    match download_package(
        store, client, &root, &package, &manifest, task_id, &control, disk_space,
    ) {
        Ok(()) => Ok(()),
        Err(error) => {
            if error == "__paused__" {
                return Ok(());
            }
            if error == "__cancelled__" {
                return Ok(());
            }
            if let Ok(Some(latest)) = store.get_model_download_task(task_id) {
                let actual_bytes = actual_task_bytes(&root, &package, &latest);
                let _ = store.update_model_download_task(
                    task_id,
                    "failed",
                    actual_bytes,
                    latest.current_file_path.as_deref(),
                    latest.current_file_index,
                    latest.current_source_url.as_deref(),
                    latest.source_index,
                    Some(&error),
                );
            }
            let _ = store.set_model_package_state(&package.package_id, "failed");
            Err(error)
        }
    }
}

fn actual_task_bytes(
    root: &Path,
    package: &ModelPackageRecord,
    task: &ModelDownloadTaskRecord,
) -> u64 {
    let completed = task.current_file_index.unwrap_or(0) as usize;
    let preceding = package
        .files
        .iter()
        .take(completed)
        .map(|file| file.size_bytes)
        .fold(0u64, u64::saturating_add);
    let current = task
        .current_file_path
        .as_deref()
        .map(|path| {
            root.join(".staging")
                .join(format!("{}-{}", package.package_id, task.id))
                .join(format!("{path}.part"))
        })
        .map(|path| file_progress_bytes(&path, u64::MAX))
        .unwrap_or(0);
    preceding.saturating_add(current).max(task.bytes_downloaded)
}

fn manifest_from_record(package: &ModelPackageRecord) -> Result<ModelPackageManifest, String> {
    Ok(ModelPackageManifest {
        schema_version: 1,
        package_id: package.package_id.clone(),
        model_id: package.model_id.clone(),
        version: package.version.clone(),
        display_name: package.display_name.clone(),
        capabilities: package.capabilities.clone(),
        format: package.format.clone(),
        files: package
            .files
            .iter()
            .map(|file| ModelManifestFile {
                relative_path: file.relative_path.clone(),
                size_bytes: file.size_bytes,
                sha256: file.sha256.clone(),
                purpose: file.purpose.clone(),
            })
            .collect(),
        dimensions: package.dimensions,
        max_input: package.max_input,
        recommended_batch: package.recommended_batch,
        min_memory_bytes: package.min_memory_bytes,
        recommended_memory_bytes: package.recommended_memory_bytes,
        platform: package.platform.clone(),
        arch: package.arch.clone(),
        license: package.license.clone(),
        original_source: package.original_source.clone(),
        homepage: package.homepage.clone(),
        requires_acceptance: package.requires_acceptance,
        download_mirrors: package
            .sources
            .iter()
            .map(|source| super::models::ModelDownloadMirror {
                url: source.url.clone(),
                kind: source.kind.clone(),
            })
            .collect(),
        provider_kind: package.provider_kind.clone(),
    })
}

fn required_disk_space(package: &ModelPackageRecord) -> Result<u64, String> {
    let remaining = package
        .files
        .iter()
        .try_fold(0u64, |sum, file| {
            sum.checked_add(file.size_bytes.saturating_sub(file.downloaded_bytes))
        })
        .ok_or_else(|| "模型包大小溢出".to_string())?;
    Ok(remaining
        .saturating_add(remaining / 10)
        .saturating_add(64 * 1024 * 1024))
}

fn check_remaining_disk_space(
    disk_space: &dyn DiskSpace,
    root: &Path,
    staging: &Path,
    manifest: &ModelPackageManifest,
) -> Result<(), String> {
    let used = manifest
        .files
        .iter()
        .map(|file| {
            file_progress_bytes(
                &staging.join(format!("{}.part", file.relative_path)),
                file.size_bytes,
            )
        })
        .collect::<Vec<_>>();
    let remaining = manifest
        .files
        .iter()
        .zip(used)
        .try_fold(0u64, |sum, (file, present)| {
            sum.checked_add(file.size_bytes.saturating_sub(present))
        })
        .ok_or_else(|| "模型包大小溢出".to_string())?;
    let required = remaining
        .saturating_add(remaining / 10)
        .saturating_add(64 * 1024 * 1024);
    if let Some(available) = disk_space.available_bytes(root)? {
        if available < required {
            return Err("模型库所在磁盘空间不足".into());
        }
    }
    Ok(())
}

fn recover_committed_package(
    store: &AiStore,
    root: &Path,
    package: &ModelPackageRecord,
    manifest: &ModelPackageManifest,
    task_id: &str,
) -> Result<Option<Result<(), String>>, String> {
    let final_dir = root.join(&package.package_dir);
    if !final_dir.exists() {
        return Ok(None);
    }
    // A completed directory may exist if the process died after the atomic
    // rename and before SQLite was committed.  Verify every byte before
    // converging the DB; an arbitrary pre-existing directory is never trusted.
    let manifest_path = final_dir.join("model.json");
    let manifest_matches = fs::read(&manifest_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ModelPackageManifest>(&bytes).ok())
        .is_some_and(|installed| installed == *manifest);
    let valid = manifest_matches
        && manifest.files.iter().all(|file| {
            resolve_model_file(root, &final_dir, &file.relative_path)
                .is_ok_and(|path| verify_file(&path, file).is_ok())
        });
    if !valid {
        return Ok(Some(Err("模型包目标目录存在但未通过完整校验".into())));
    }
    store.mark_model_package_files_installed(&package.package_id)?;
    store.set_model_package_state(&package.package_id, "installed")?;
    let task = store
        .get_model_download_task(task_id)?
        .ok_or_else(|| "模型下载任务不存在".to_string())?;
    let _ = store.update_model_download_task(
        task_id,
        "completed",
        task.total_bytes.unwrap_or(task.bytes_downloaded),
        None,
        None,
        None,
        None,
        None,
    )?;
    Ok(Some(Ok(())))
}

fn download_package(
    store: &AiStore,
    client: &dyn HttpClient,
    root: &Path,
    package: &ModelPackageRecord,
    manifest: &ModelPackageManifest,
    task_id: &str,
    control: &DownloadControl,
    disk_space: &dyn DiskSpace,
) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("解析模型库根目录失败：{error}"))?;
    validate_relative_path(&package.package_dir, "模型包目录")?;
    let normalized_package_dir = package.package_dir.replace('\\', "/").to_ascii_lowercase();
    if normalized_package_dir == ".staging" || normalized_package_dir.starts_with(".staging/") {
        return Err("模型包目录不能使用保留目录".into());
    }
    let staging = ensure_staging_for_task(&root, &package.package_id, task_id)?;
    let persisted_bytes = store
        .get_model_download_task(task_id)?
        .map(|task| task.bytes_downloaded)
        .unwrap_or(0);
    store.update_model_download_task(
        task_id,
        "downloading",
        persisted_bytes,
        None,
        None,
        None,
        None,
        None,
    )?;
    let mut completed = 0u64;
    for (index, file) in manifest.files.iter().enumerate() {
        if let Some(signal) = control.requested() {
            return handle_signal(
                store, package, &root, task_id, completed, None, None, signal,
            );
        }
        validate_relative_path(&file.relative_path, "模型文件")?;
        check_remaining_disk_space(disk_space, &root, &staging, manifest)?;
        if !is_supported_model_file(&file.relative_path) {
            return Err("模型文件扩展名不受支持".into());
        }
        let part = staging.join(format!("{}.part", file.relative_path));
        let parent = part
            .parent()
            .ok_or_else(|| "模型 staging 路径无效".to_string())?;
        ensure_no_symlink_components(&staging, parent)?;
        fs::create_dir_all(parent).map_err(|error| format!("创建模型临时目录失败：{error}"))?;
        if let Ok(metadata) = fs::symlink_metadata(&part) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("模型临时文件不能是符号链接或特殊文件".into());
            }
        }
        let mut downloaded = fs::metadata(&part)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if downloaded > file.size_bytes {
            fs::remove_file(&part).map_err(|error| format!("清理超长模型临时文件失败：{error}"))?;
            downloaded = 0;
        }
        let local_verified = downloaded == file.size_bytes && verify_file(&part, file).is_ok();
        if !local_verified && downloaded == file.size_bytes {
            fs::remove_file(&part)
                .map_err(|error| format!("清理校验失败的模型临时文件失败：{error}"))?;
            downloaded = 0;
        }
        let mut mirror_error = None;
        if !local_verified {
            for (source_index, source) in package.sources.iter().enumerate() {
                let url = join_source_url(&source.url, &file.relative_path)?;
                store.update_model_download_task(
                    task_id,
                    "downloading",
                    completed + downloaded,
                    Some(&file.relative_path),
                    Some(index as u32),
                    Some(&url),
                    Some(source_index as u32),
                    None,
                )?;
                let mut report_progress = |current: u64| {
                    store.update_model_download_task(
                        task_id,
                        "downloading",
                        completed + current,
                        Some(&file.relative_path),
                        Some(index as u32),
                        Some(&url),
                        Some(source_index as u32),
                        None,
                    )?;
                    store.update_model_package_file_progress(
                        &package.package_id,
                        &file.relative_path,
                        current,
                        "pending",
                    )
                };
                match download_file(
                    client,
                    &url,
                    &part,
                    file,
                    downloaded,
                    control,
                    &mut report_progress,
                ) {
                    Ok(()) => {
                        // A mirror that serves the wrong bytes must not poison
                        // the package or make us wait for the final verifier;
                        // discard it and try the next source immediately.
                        match verify_file_with_control(&part, file, Some(control)) {
                            Ok(()) => {
                                mirror_error = None;
                                break;
                            }
                            Err(error) => {
                                if error == "__paused__" || error == "__cancelled__" {
                                    return handle_signal(
                                        store,
                                        package,
                                        &root,
                                        task_id,
                                        completed + file_progress_bytes(&part, file.size_bytes),
                                        Some(&file.relative_path),
                                        Some(index as u32),
                                        if error == "__paused__" {
                                            DownloadSignal::Pause
                                        } else {
                                            DownloadSignal::Cancel
                                        },
                                    );
                                }
                                let _ = fs::remove_file(&part);
                                downloaded = 0;
                                mirror_error = Some(error);
                            }
                        }
                    }
                    Err(error) if error == "__paused__" || error == "__cancelled__" => {
                        return handle_signal(
                            store,
                            package,
                            &root,
                            task_id,
                            completed + file_progress_bytes(&part, file.size_bytes),
                            Some(&file.relative_path),
                            Some(index as u32),
                            if error == "__paused__" {
                                DownloadSignal::Pause
                            } else {
                                DownloadSignal::Cancel
                            },
                        )
                    }
                    Err(error) => {
                        downloaded = file_progress_bytes(&part, file.size_bytes);
                        store.update_model_download_task(
                            task_id,
                            "downloading",
                            completed + downloaded,
                            Some(&file.relative_path),
                            Some(index as u32),
                            Some(&url),
                            Some(source_index as u32),
                            None,
                        )?;
                        mirror_error = Some(error);
                        if mirror_error.as_deref().is_some_and(|message| {
                            message.contains("拒绝 Range") || message.contains("Content-Range")
                        }) {
                            let _ = fs::remove_file(&part);
                            downloaded = 0;
                        }
                        if fs::metadata(&part).map(|m| m.len()).unwrap_or(0) != downloaded {
                            downloaded = 0;
                        }
                    }
                }
            }
        }
        if let Some(error) = mirror_error {
            return Err(error);
        }
        store.set_model_package_state(&package.package_id, "verifying")?;
        store.update_model_download_task(
            task_id,
            "verifying",
            completed + file.size_bytes,
            Some(&file.relative_path),
            Some(index as u32),
            None,
            None,
            None,
        )?;
        if let Err(error) = verify_file_with_control(&part, file, Some(control)) {
            if error == "__paused__" || error == "__cancelled__" {
                return handle_signal(
                    store,
                    package,
                    &root,
                    task_id,
                    completed + file_progress_bytes(&part, file.size_bytes),
                    Some(&file.relative_path),
                    Some(index as u32),
                    if error == "__paused__" {
                        DownloadSignal::Pause
                    } else {
                        DownloadSignal::Cancel
                    },
                );
            }
            return Err(error);
        }
        store.update_model_package_file_progress(
            &package.package_id,
            &file.relative_path,
            file.size_bytes,
            "verified",
        )?;
        completed = completed
            .checked_add(file.size_bytes)
            .ok_or_else(|| "模型下载进度溢出".to_string())?;
    }
    if let Err(error) = install_package(&root, &staging, package, manifest, Some(control)) {
        if error == "__paused__" || error == "__cancelled__" {
            return handle_signal(
                store,
                package,
                &root,
                task_id,
                completed,
                None,
                None,
                if error == "__paused__" {
                    DownloadSignal::Pause
                } else {
                    DownloadSignal::Cancel
                },
            );
        }
        return Err(error);
    }
    store.mark_model_package_files_installed(&package.package_id)?;
    store.set_model_package_state(&package.package_id, "installed")?;
    store.update_model_download_task(
        task_id,
        "completed",
        completed,
        None,
        None,
        None,
        None,
        None,
    )?;
    // Installation is already complete; a cleanup failure must not turn a
    // valid installed package back into a failed download.  The exact staging
    // directory remains diagnosable and can be cleaned by a later retry.
    let _ = remove_empty_staging_for_task(&root, &package.package_id, task_id);
    Ok(())
}

fn handle_signal(
    store: &AiStore,
    package: &ModelPackageRecord,
    root: &Path,
    task_id: &str,
    bytes: u64,
    current_file_path: Option<&str>,
    current_file_index: Option<u32>,
    signal: DownloadSignal,
) -> Result<(), String> {
    if let Some(path) = current_file_path {
        if let Some(file) = package.files.iter().find(|file| file.relative_path == path) {
            let part = root
                .join(".staging")
                .join(format!("{}-{task_id}", package.package_id))
                .join(format!("{path}.part"));
            store.update_model_package_file_progress(
                &package.package_id,
                path,
                file_progress_bytes(&part, file.size_bytes),
                "pending",
            )?;
        }
    }
    match signal {
        DownloadSignal::Pause => {
            store.set_model_package_state(&package.package_id, "paused")?;
            store.update_model_download_task(
                task_id,
                "paused",
                bytes,
                current_file_path,
                current_file_index,
                None,
                None,
                None,
            )?;
            Err("__paused__".into())
        }
        DownloadSignal::Cancel => {
            store.set_model_package_state(&package.package_id, "uninstalled")?;
            store.update_model_download_task(
                task_id,
                "cancelled",
                bytes,
                current_file_path,
                current_file_index,
                None,
                None,
                Some("用户取消下载"),
            )?;
            remove_staging_for_task(root, &package.package_id, task_id)?;
            Err("__cancelled__".into())
        }
    }
}

fn download_file(
    client: &dyn HttpClient,
    url: &str,
    part: &Path,
    expected: &ModelManifestFile,
    offset: u64,
    control: &DownloadControl,
    progress: &mut dyn FnMut(u64) -> Result<(), String>,
) -> Result<(), String> {
    let mut response = client.get(url, (offset > 0).then_some(offset))?;
    let mut start = offset;
    if offset > 0 {
        match response.status {
            206 => {
                let range = response
                    .content_range
                    .as_deref()
                    .ok_or_else(|| "206 响应缺少 Content-Range".to_string())?;
                let (range_start, range_end, range_total) = parse_content_range(range)
                    .ok_or_else(|| "206 响应 Content-Range 格式无效".to_string())?;
                if range_start != offset
                    || range_end < range_start
                    || range_end.saturating_add(1) > expected.size_bytes
                    || range_total.is_some_and(|total| total != expected.size_bytes)
                {
                    return Err("Content-Range 起点与本地临时文件不匹配".into());
                }
            }
            200 => {
                File::create(part).map_err(|error| format!("重启模型下载失败：{error}"))?;
                start = 0;
            }
            416 => {
                if offset == expected.size_bytes {
                    return verify_file(part, expected).map_err(|_| {
                        "服务器拒绝 Range，完整临时文件校验失败，需要安全重启".into()
                    });
                }
                return Err("服务器拒绝 Range 请求且临时文件未完成".into());
            }
            _ => return Err(format!("模型文件 HTTP 状态异常：{}", response.status)),
        }
    } else if response.status == 206 {
        let range = response
            .content_range
            .as_deref()
            .ok_or_else(|| "206 响应缺少 Content-Range".to_string())?;
        let (range_start, range_end, range_total) = parse_content_range(range)
            .ok_or_else(|| "206 响应 Content-Range 格式无效".to_string())?;
        if range_start != 0
            || range_end < range_start
            || range_end.saturating_add(1) > expected.size_bytes
            || range_total.is_some_and(|total| total != expected.size_bytes)
        {
            return Err("Content-Range 起点与 manifest 大小不匹配".into());
        }
    } else if response.status != 200 {
        return Err(format!("模型文件 HTTP 状态异常：{}", response.status));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(start == 0)
        .open(part)
        .map_err(|error| format!("打开模型临时文件失败：{error}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("定位模型临时文件失败：{error}"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut received = start;
    let mut last_reported = start;
    let mut last_report_at = std::time::Instant::now();
    loop {
        if let Some(signal) = control.requested() {
            file.flush()
                .map_err(|error| format!("刷新模型临时文件失败：{error}"))?;
            file.sync_all()
                .map_err(|error| format!("同步模型临时文件失败：{error}"))?;
            return Err(if signal == DownloadSignal::Pause {
                "__paused__"
            } else {
                "__cancelled__"
            }
            .into());
        }
        let count = response
            .reader
            .read(&mut buffer)
            .map_err(|error| format!("读取模型响应失败：{error}"))?;
        if count == 0 {
            break;
        }
        received = received
            .checked_add(count as u64)
            .ok_or_else(|| "模型文件大小溢出".to_string())?;
        if received > expected.size_bytes {
            return Err("模型响应超过 manifest 声明大小".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|error| format!("写入模型临时文件失败：{error}"))?;
        if received.saturating_sub(last_reported) >= 1024 * 1024
            || last_report_at.elapsed() >= std::time::Duration::from_millis(500)
        {
            progress(received)?;
            last_reported = received;
            last_report_at = std::time::Instant::now();
        }
    }
    file.flush()
        .map_err(|error| format!("刷新模型临时文件失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步模型临时文件失败：{error}"))?;
    if received != expected.size_bytes {
        return Err("模型响应未达到 manifest 声明大小".into());
    }
    if last_reported != received {
        progress(received)?;
    }
    Ok(())
}

fn file_progress_bytes(path: &Path, expected_size: u64) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len().min(expected_size))
        .unwrap_or(0)
}

fn verify_file(path: &Path, expected: &ModelManifestFile) -> Result<(), String> {
    verify_file_with_control(path, expected, None)
}

fn verify_file_with_control(
    path: &Path,
    expected: &ModelManifestFile,
    control: Option<&DownloadControl>,
) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取模型临时文件失败：{error}"))?;
    if metadata.len() != expected.size_bytes {
        return Err("模型临时文件大小校验失败".into());
    }
    let mut file = File::open(path).map_err(|error| format!("打开模型临时文件失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if let Some(control) = control {
            if let Some(signal) = control.requested() {
                return Err(if signal == DownloadSignal::Pause {
                    "__paused__"
                } else {
                    "__cancelled__"
                }
                .into());
            }
        }
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("读取模型临时文件失败：{error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(&expected.sha256) {
        return Err("模型临时文件 SHA-256 校验失败".into());
    }
    Ok(())
}

fn install_package(
    root: &Path,
    staging: &Path,
    package: &ModelPackageRecord,
    manifest: &ModelPackageManifest,
    control: Option<&DownloadControl>,
) -> Result<(), String> {
    let final_dir = root.join(&package.package_dir);
    if let Some(parent) = final_dir.parent() {
        ensure_no_symlink_components(root, parent)?;
    }
    if final_dir.exists() {
        return Err("模型包目标目录已存在，拒绝覆盖".into());
    }
    let install_dir = staging.join(".install");
    if let Ok(metadata) = fs::symlink_metadata(&install_dir) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("模型安装临时目录不能是符号链接或特殊文件".into());
        }
    }
    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("创建模型安装临时目录失败：{error}"))?;
    for file in &manifest.files {
        if let Some(control) = control {
            if let Some(signal) = control.requested() {
                return Err(if signal == DownloadSignal::Pause {
                    "__paused__"
                } else {
                    "__cancelled__"
                }
                .into());
            }
        }
        let source = staging.join(format!("{}.part", file.relative_path));
        let target = resolve_model_file(root, &install_dir, &file.relative_path)?;
        if let Some(parent) = target.parent() {
            ensure_no_symlink_components(&install_dir, parent)?;
            fs::create_dir_all(parent).map_err(|error| format!("创建模型安装目录失败：{error}"))?;
        }
        if let Ok(metadata) = fs::symlink_metadata(&source) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("模型安装临时文件不能是符号链接或特殊文件".into());
            }
        }
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("模型安装目标不能是符号链接或特殊文件".into());
            }
        }
        if source.exists() {
            if target.exists() {
                verify_file_with_control(&target, file, control)?;
                if let Some(control) = control {
                    if let Some(signal) = control.requested() {
                        return Err(if signal == DownloadSignal::Pause {
                            "__paused__"
                        } else {
                            "__cancelled__"
                        }
                        .into());
                    }
                }
                fs::remove_file(source)
                    .map_err(|error| format!("清理重复模型临时文件失败：{error}"))?;
            } else {
                if let Some(control) = control {
                    if let Some(signal) = control.requested() {
                        return Err(if signal == DownloadSignal::Pause {
                            "__paused__"
                        } else {
                            "__cancelled__"
                        }
                        .into());
                    }
                }
                fs::rename(source, &target)
                    .map_err(|error| format!("移动模型文件失败：{error}"))?;
            }
        } else if !target.is_file() {
            return Err(format!("模型安装临时文件缺失：{}", file.relative_path));
        }
    }
    let manifest_path = install_dir.join("model.json");
    if let Ok(metadata) = fs::symlink_metadata(&manifest_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("模型安装清单不能是符号链接或特殊文件".into());
        }
    }
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(manifest)
            .map_err(|error| format!("序列化模型清单失败：{error}"))?,
    )
    .map_err(|error| format!("写入模型清单失败：{error}"))?;
    let mut last_error = None;
    for attempt in 0..8 {
        if let Some(control) = control {
            if let Some(signal) = control.requested() {
                return Err(if signal == DownloadSignal::Pause {
                    "__paused__"
                } else {
                    "__cancelled__"
                }
                .into());
            }
        }
        match fs::rename(&install_dir, &final_dir) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::AlreadyExists
                ) && attempt < 7 =>
            {
                last_error = Some(error);
                thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
            }
            Err(error) => {
                last_error = Some(error);
                break;
            }
        }
    }
    Err(format!(
        "原子安装模型包失败：{}",
        last_error.expect("rename loop must record error")
    ))
}

fn ensure_staging_for_task(
    root: &Path,
    package_id: &str,
    task_id: &str,
) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("解析模型库根目录失败：{error}"))?;
    if !root.is_dir() {
        return Err("模型库根目录不是目录".into());
    }
    let staging_root = root.join(".staging");
    if let Ok(metadata) = fs::symlink_metadata(&staging_root) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("模型库 .staging 必须是普通目录".into());
        }
    } else {
        fs::create_dir(&staging_root)
            .map_err(|error| format!("创建模型 staging 根目录失败：{error}"))?;
    }
    let staging = staging_root.join(format!("{}-{task_id}", package_id));
    if let Ok(metadata) = fs::symlink_metadata(&staging) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("模型任务 staging 必须是普通目录".into());
        }
    } else {
        fs::create_dir(&staging).map_err(|error| format!("创建模型下载 staging 失败：{error}"))?;
    }
    let staging_canonical = staging
        .canonicalize()
        .map_err(|error| format!("解析模型 staging 目录失败：{error}"))?;
    if !staging_canonical.starts_with(&root) {
        return Err("模型 staging 越出模型库根目录".into());
    }
    // Callers validate/strip paths against the canonical model-library root;
    // returning the lexical alias here breaks that invariant on Windows
    // short-path (8.3) temp-directory aliases.
    Ok(staging_canonical)
}

fn ensure_no_symlink_components(base: &Path, target: &Path) -> Result<(), String> {
    let base = base
        .canonicalize()
        .map_err(|error| format!("解析模型 staging 根目录失败：{error}"))?;

    // `target` may not exist yet (for example, a new package directory), and
    // Windows may spell the same root using an 8.3 alias. Find the nearest
    // existing lexical ancestor first, then compare its canonical identity.
    let mut ancestor = target.to_path_buf();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "模型临时目录越出 staging 根目录".to_string())?
            .to_path_buf();
    }
    let ancestor_canonical = ancestor
        .canonicalize()
        .map_err(|error| format!("解析模型临时目录祖先失败：{error}"))?;
    if !ancestor_canonical.starts_with(&base) {
        return Err("模型临时目录越出 staging 根目录".into());
    }

    // Validate every existing component between the lexical ancestor and the
    // canonical base as well. This catches a symlink/junction that resolves
    // back inside the root instead of relying only on starts_with().
    let mut existing = ancestor.clone();
    loop {
        let metadata = fs::symlink_metadata(&existing)
            .map_err(|error| format!("读取模型临时目录组件失败：{error}"))?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err("模型临时目录路径不能包含符号链接或 reparse 点".into());
        }
        if existing
            .canonicalize()
            .map_err(|error| format!("解析模型临时目录组件失败：{error}"))?
            == base
        {
            break;
        }
        existing = existing
            .parent()
            .ok_or_else(|| "模型临时目录越出 staging 根目录".to_string())?
            .to_path_buf();
    }

    let relative = target
        .strip_prefix(&ancestor)
        .map_err(|_| "模型临时目录祖先路径不一致".to_string())?;
    let mut current = ancestor_canonical;
    for component in relative.components() {
        if matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return Err("模型临时目录包含越界路径组件".into());
        }
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err("模型临时目录路径不能包含符号链接或 reparse 点".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn remove_staging_for_task(
    root: &Path,
    package_id: &str,
    task_id: &str,
) -> Result<(), String> {
    let staging_root = root.join(".staging");
    let staging = staging_root.join(format!("{}-{task_id}", package_id));
    if let Ok(metadata) = fs::symlink_metadata(&staging_root) {
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err("模型库 .staging 必须是普通目录".into());
        }
    }
    if let Ok(metadata) = fs::symlink_metadata(&staging) {
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err("模型任务 staging 必须是普通目录".into());
        }
    }
    if staging.exists() {
        let root_canonical = root
            .canonicalize()
            .map_err(|error| format!("解析模型库根目录失败：{error}"))?;
        let staging_canonical = staging
            .canonicalize()
            .map_err(|error| format!("解析模型 staging 目录失败：{error}"))?;
        if !staging_canonical.starts_with(root_canonical.join(".staging")) {
            return Err("模型 staging 越出模型库根目录".into());
        }
        fs::remove_dir_all(staging).map_err(|error| format!("删除模型 staging 失败：{error}"))?;
    }
    Ok(())
}

fn remove_empty_staging_for_task(
    root: &Path,
    package_id: &str,
    task_id: &str,
) -> Result<(), String> {
    let staging = root
        .join(".staging")
        .join(format!("{}-{task_id}", package_id));
    remove_empty_directories(&staging)?;
    Ok(())
}

fn remove_empty_directories(path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("读取模型 staging 目录失败：{error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err("模型 staging 路径不能包含符号链接".into());
    }
    if !metadata.is_dir() {
        return Ok(false);
    }
    let entries = fs::read_dir(path)
        .map_err(|error| format!("读取模型 staging 目录失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取模型 staging 目录失败：{error}"))?;
    let mut empty = true;
    for entry in entries {
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            if !remove_empty_directories(&entry.path())? {
                empty = false;
            }
        } else {
            empty = false;
        }
    }
    if empty {
        fs::remove_dir(path).map_err(|error| format!("清理空模型 staging 目录失败：{error}"))?;
    }
    Ok(empty)
}

fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let value = value.trim();
    let rest = value.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((
        start.parse().ok()?,
        end.parse().ok()?,
        (total != "*").then(|| total.parse().ok()).flatten(),
    ))
}

fn join_source_url(base: &str, relative: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(base).map_err(|error| format!("模型来源 URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型来源必须是无查询参数的 http/https 基础地址".into());
    }
    let components = validate_relative_path(relative, "模型文件")?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "模型来源 URL 路径不可修改")?;
        segments.pop_if_empty();
        for component in components {
            segments.push(&component);
        }
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct MockClient {
        responses: Mutex<Vec<HttpResponse>>,
    }

    struct CountingClient {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl HttpClient for CountingClient {
        fn get(&self, _url: &str, _range_start: Option<u64>) -> Result<HttpResponse, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Err("network must not be called".into())
        }
    }
    impl HttpClient for MockClient {
        fn get(&self, _url: &str, _range_start: Option<u64>) -> Result<HttpResponse, String> {
            self.responses
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| "no response".into())
        }
    }
    fn response(status: u16, range: Option<&str>, data: &[u8]) -> HttpResponse {
        HttpResponse {
            status,
            content_range: range.map(str::to_string),
            reader: Box::new(Cursor::new(data.to_vec())),
        }
    }
    fn expected(data: &[u8]) -> ModelManifestFile {
        ModelManifestFile {
            relative_path: "weights.gguf".into(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
            purpose: "weights".into(),
        }
    }

    fn catalog_manifest(package_id: &str, data: &[u8]) -> ModelPackageManifest {
        ModelPackageManifest {
            schema_version: 1,
            package_id: package_id.into(),
            model_id: format!("{package_id}-model"),
            version: "1".into(),
            display_name: package_id.into(),
            capabilities: vec!["generation".into()],
            format: "gguf".into(),
            files: vec![expected(data)],
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "test".into(),
            homepage: None,
            requires_acceptance: false,
            download_mirrors: vec![super::super::models::ModelDownloadMirror {
                url: "https://example.invalid/models".into(),
                kind: None,
            }],
            provider_kind: None,
        }
    }

    fn no_progress(_: u64) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn cancelled_queued_task_is_claim_rejected_without_network() {
        let root =
            std::env::temp_dir().join(format!("epub-download-cancel-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = AiStore::open(&root).unwrap();
        let model_root = root.join("models");
        fs::create_dir_all(&model_root).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        let bytes = b"weights";
        let manifest = ModelPackageManifest {
            schema_version: 1,
            package_id: "cancel-queued".into(),
            model_id: "cancel-model".into(),
            version: "1".into(),
            display_name: "Cancel".into(),
            capabilities: vec!["generation".into()],
            format: "gguf".into(),
            files: vec![expected(bytes)],
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "test".into(),
            homepage: None,
            requires_acceptance: false,
            download_mirrors: vec![super::super::models::ModelDownloadMirror {
                url: "https://example.invalid/models".into(),
                kind: None,
            }],
            provider_kind: None,
        };
        store
            .register_catalog_model_manifest(&manifest, "cancel-queued")
            .unwrap();
        let task = store
            .create_or_get_model_download_task("cancel-queued")
            .unwrap();
        store
            .update_model_download_task(&task.id, "cancelled", 0, None, None, None, None, None)
            .unwrap();
        let client = CountingClient {
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        run_task_with_client(
            &store,
            &task.id,
            Arc::new(DownloadControl::default()),
            &FsDiskSpace,
            &client,
        )
        .unwrap();
        assert_eq!(client.calls.load(Ordering::Relaxed), 0);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_directory_recovers_database_without_network() {
        let root =
            std::env::temp_dir().join(format!("epub-download-recover-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = AiStore::open(&root).unwrap();
        let model_root = root.join("models");
        let package_id = "recover-package";
        let data = b"weights";
        let manifest = catalog_manifest(package_id, data);
        let final_dir = model_root.join(package_id);
        fs::create_dir_all(&final_dir).unwrap();
        fs::write(final_dir.join("weights.gguf"), data).unwrap();
        fs::write(
            final_dir.join("model.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        store
            .register_catalog_model_manifest(&manifest, package_id)
            .unwrap();
        let task = store.create_or_get_model_download_task(package_id).unwrap();
        let recovered = recover_committed_package(
            &store,
            &model_root,
            &store.get_model_package(package_id).unwrap().unwrap(),
            &manifest,
            &task.id,
        )
        .unwrap();
        assert!(matches!(recovered, Some(Ok(()))));
        assert_eq!(
            store.get_model_package(package_id).unwrap().unwrap().state,
            "installed"
        );
        assert_eq!(
            store
                .get_model_download_task(&task.id)
                .unwrap()
                .unwrap()
                .state,
            "completed"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn range_200_restarts_from_zero() {
        let root = std::env::temp_dir().join(format!("epub-download-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let part = root.join("x.part");
        fs::write(&part, b"old").unwrap();
        let data = b"fresh";
        let client = MockClient {
            responses: Mutex::new(vec![response(200, None, data)]),
        };
        let exp = expected(data);
        download_file(
            &client,
            "https://example.invalid/x",
            &part,
            &exp,
            3,
            &DownloadControl::default(),
            &mut no_progress,
        )
        .unwrap();
        assert_eq!(fs::read(&part).unwrap(), data);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn range_206_requires_matching_start() {
        let root = std::env::temp_dir().join(format!("epub-download-range-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let part = root.join("x.part");
        fs::write(&part, b"abc").unwrap();
        let client = MockClient {
            responses: Mutex::new(vec![response(206, Some("bytes 2-4/5"), b"de")]),
        };
        let exp = expected(b"abcde");
        assert!(download_file(
            &client,
            "https://example.invalid/x",
            &part,
            &exp,
            3,
            &DownloadControl::default(),
            &mut no_progress,
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn initial_206_requires_zero_start_and_expected_total() {
        let root = std::env::temp_dir().join(format!(
            "epub-download-initial-range-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let part = root.join("x.part");
        let data = b"fresh";
        let client = MockClient {
            responses: Mutex::new(vec![response(206, Some("bytes 1-4/5"), data)]),
        };
        assert!(download_file(
            &client,
            "https://example.invalid/x",
            &part,
            &expected(data),
            0,
            &DownloadControl::default(),
            &mut no_progress,
        )
        .is_err());
        assert!(!part.exists());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn source_url_cannot_escape_or_use_query() {
        assert!(join_source_url("https://example.invalid/models", "../x.gguf").is_err());
        assert!(join_source_url("https://example.invalid/models?x=1", "x.gguf").is_err());
        assert!(join_source_url("https://example.invalid/models", "x.gguf")
            .unwrap()
            .ends_with("/models/x.gguf"));
    }

    #[test]
    fn content_range_requires_start_and_total() {
        assert_eq!(parse_content_range("bytes 0-4/5"), Some((0, 4, Some(5))));
        assert_eq!(parse_content_range("bytes 5-9/*"), Some((5, 9, None)));
        assert_eq!(parse_content_range("bytes 0-4/6"), Some((0, 4, Some(6))));
        assert!(parse_content_range("bytes 0-4").is_none());
    }

    #[test]
    fn redirect_policy_allows_exactly_five_http_hops() {
        assert!(redirect_is_allowed(0, "https"));
        assert!(redirect_is_allowed(4, "http"));
        assert!(!redirect_is_allowed(5, "https"));
        assert!(!redirect_is_allowed(0, "file"));
    }

    #[test]
    fn queue_empty_transition_is_atomic_with_running_flag() {
        let mut queue = QueueState {
            queue: VecDeque::new(),
            controls: HashMap::new(),
            running: true,
        };
        assert!(pop_or_stop(&mut queue).is_none());
        assert!(!queue.running);
        queue.queue.push_back("next".into());
        queue.running = true;
        assert_eq!(pop_or_stop(&mut queue).as_deref(), Some("next"));
        assert!(queue.running);
    }

    #[test]
    fn real_disk_space_provider_returns_a_value_for_temp_dir() {
        let available = FsDiskSpace.available_bytes(&std::env::temp_dir()).unwrap();
        assert!(available.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn staging_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("epub-download-link-{}", std::process::id()));
        let outside = root.with_extension("outside");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&root).unwrap();
        symlink(&outside, root.join(".staging")).unwrap();
        assert!(ensure_staging_for_task(&root, "default", "task").is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn component_guard_handles_missing_targets_and_rejects_escape() {
        let root =
            std::env::temp_dir().join(format!("epub-download-components-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(ensure_no_symlink_components(&root, &root.join("new/nested")).is_ok());
        assert!(ensure_no_symlink_components(&root, &root.join("..").join("outside")).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_install_supports_multiple_files_without_overwrite() {
        let root =
            std::env::temp_dir().join(format!("epub-download-install-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let staging = ensure_staging_for_task(&root, "default", "task").unwrap();
        let first = b"weights";
        let second = b"tokenizer";
        fs::create_dir_all(staging.join("nested")).unwrap();
        fs::write(staging.join("weights.gguf.part"), first).unwrap();
        fs::write(staging.join("nested/tokenizer.json.part"), second).unwrap();
        let manifest = ModelPackageManifest {
            schema_version: 1,
            package_id: "default".into(),
            model_id: "model".into(),
            version: "1".into(),
            display_name: "Model".into(),
            capabilities: vec!["embedding".into()],
            format: "gguf".into(),
            files: vec![
                expected(first),
                ModelManifestFile {
                    relative_path: "nested/tokenizer.json".into(),
                    size_bytes: second.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(second)),
                    purpose: "tokenizer".into(),
                },
            ],
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "test".into(),
            homepage: None,
            requires_acceptance: false,
            download_mirrors: vec![],
            provider_kind: None,
        };
        let package = ModelPackageRecord {
            package_id: "default".into(),
            model_id: "model".into(),
            version: "1".into(),
            display_name: "Model".into(),
            capabilities: vec!["embedding".into()],
            format: "gguf".into(),
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "test".into(),
            homepage: None,
            requires_acceptance: false,
            provider_kind: None,
            storage_kind: "managed".into(),
            package_dir: "installed".into(),
            linked_external_path: None,
            state: "uninstalled".into(),
            files: vec![],
            sources: vec![],
        };
        install_package(&root, &staging, &package, &manifest, None).unwrap();
        assert_eq!(
            fs::read(root.join("installed/weights.gguf")).unwrap(),
            first
        );
        assert_eq!(
            fs::read(root.join("installed/nested/tokenizer.json")).unwrap(),
            second
        );
        assert!(root.join("installed/model.json").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_response_is_rejected() {
        let root = std::env::temp_dir().join(format!("epub-download-over-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let part = root.join("x.part");
        let data = b"too-long";
        let exp = expected(b"short");
        let client = MockClient {
            responses: Mutex::new(vec![response(200, None, data)]),
        };
        assert!(download_file(
            &client,
            "https://example.invalid/x",
            &part,
            &exp,
            0,
            &DownloadControl::default(),
            &mut no_progress,
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn complete_local_file_can_finish_after_416() {
        let root = std::env::temp_dir().join(format!("epub-download-416-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let part = root.join("x.part");
        let data = b"complete";
        fs::write(&part, data).unwrap();
        let client = MockClient {
            responses: Mutex::new(vec![response(416, None, &[])]),
        };
        let exp = expected(data);
        download_file(
            &client,
            "https://example.invalid/x",
            &part,
            &exp,
            data.len() as u64,
            &DownloadControl::default(),
            &mut no_progress,
        )
        .unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pause_signal_is_observed_before_writing() {
        let root = std::env::temp_dir().join(format!("epub-download-pause-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let part = root.join("x.part");
        let control = DownloadControl::default();
        control.pause.store(true, Ordering::Release);
        let data = b"data";
        let client = MockClient {
            responses: Mutex::new(vec![response(200, None, data)]),
        };
        let exp = expected(data);
        assert_eq!(
            download_file(
                &client,
                "https://example.invalid/x",
                &part,
                &exp,
                0,
                &control,
                &mut no_progress,
            )
            .unwrap_err(),
            "__paused__"
        );
        // Pausing must retain the staging file so a later resume can reuse it.
        // With no bytes received yet this is an empty `.part` file.
        assert!(part.exists());
        assert_eq!(fs::metadata(&part).unwrap().len(), 0);
        let _ = fs::remove_dir_all(root);
    }
}
