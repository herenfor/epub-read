//! AI/RAG storage and task lifecycle foundation.
//!
//! This module deliberately contains no model, embedding, network, or reader
//! code. It owns only the derived-data boundary under `<app data>/ai`.

#[cfg(feature = "ai")]
mod download;
#[cfg(feature = "ai")]
mod embedding;
#[cfg(feature = "ai")]
pub(crate) mod embedding_gateway;
#[cfg(feature = "ai")]
mod embedding_platform;
#[cfg(feature = "ai")]
pub(crate) mod hardware;
#[cfg(feature = "ai")]
mod model_locks;
#[cfg(feature = "ai")]
mod models;
#[cfg(feature = "ai")]
pub(crate) mod preparation;
#[cfg(feature = "ai")]
mod semantic_store;
mod store;
mod task;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[cfg(feature = "ai")]
pub(crate) use store::MAX_SUPPORTED_SCHEMA_VERSION;
pub(crate) use store::{normalize_content_hash, AiStore};
pub(crate) use task::{TaskState, TaskTransition};

/// Lazily initialized so command registration does not require an app path
/// during builder construction. This is never part of linked-library state.
pub(crate) struct AiState {
    store: Mutex<Option<Arc<AiStore>>>,
    #[cfg(feature = "ai")]
    pub(crate) downloads: download::DownloadManager,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            store: Mutex::new(None),
            #[cfg(feature = "ai")]
            downloads: download::DownloadManager::default(),
        }
    }
}

impl AiState {
    fn ensure(&self, app: &AppHandle) -> Result<Arc<AiStore>, String> {
        let mut slot = self
            .store
            .lock()
            .map_err(|_| "AI 存储状态锁已损坏".to_string())?;
        if let Some(store) = slot.as_ref() {
            return Ok(Arc::clone(store));
        }
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法取得应用数据目录：{error}"))?;
        let store = Arc::new(AiStore::open(app_data_dir)?);
        *slot = Some(Arc::clone(&store));
        Ok(store)
    }

    /// Remove book-scoped AI data only when AI storage already exists.
    /// Deleting a shelf record must not initialize an unused AI database.
    pub(crate) fn cleanup_books_if_present(
        &self,
        app: &AppHandle,
        content_hashes: &[String],
    ) -> Result<(), String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法取得应用数据目录：{error}"))?;
        self.cleanup_books_if_present_at(app_data_dir, content_hashes)
    }

    fn cleanup_books_if_present_at(
        &self,
        app_data_dir: impl AsRef<Path>,
        content_hashes: &[String],
    ) -> Result<(), String> {
        let hashes = content_hashes
            .iter()
            .map(|hash| normalize_content_hash(hash))
            .collect::<Result<Vec<_>, _>>()?;
        if hashes.is_empty() {
            return Ok(());
        }
        let existing_store = {
            let slot = self
                .store
                .lock()
                .map_err(|_| "AI 存储状态锁已损坏".to_string())?;
            slot.as_ref().map(Arc::clone)
        };
        let store = if let Some(store) = existing_store {
            store
        } else {
            let database_path = AiStore::database_path(app_data_dir.as_ref());
            if !database_path.exists() {
                return Ok(());
            }
            let store = Arc::new(AiStore::open(app_data_dir)?);
            let mut slot = self
                .store
                .lock()
                .map_err(|_| "AI 存储状态锁已损坏".to_string())?;
            if let Some(existing) = slot.as_ref() {
                Arc::clone(existing)
            } else {
                *slot = Some(Arc::clone(&store));
                store
            }
        };
        store.delete_books_derived_data(&hashes)
    }
}

impl Drop for AiState {
    fn drop(&mut self) {
        let Some(store) = self.store.get_mut().ok().and_then(Option::take) else {
            return;
        };
        #[cfg(feature = "ai")]
        self.downloads.pause_all(&store);
        store.reclaim_active_jobs();
    }
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_lock_probe(app: AppHandle, state: State<'_, AiState>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("模型锁自检仅在 AI 调试版可用".into());
    }
    let root = state
        .ensure(&app)?
        .model_library_path()?
        .ok_or_else(|| "请先选择模型库目录".to_string())?;
    model_locks::ModelLock::probe(Path::new(&root))
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_library_path_get(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<models::ModelLibraryPathSetting, String> {
    models::ai_model_library_path_get_impl(app, state)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_library_path_set(
    app: AppHandle,
    state: State<'_, AiState>,
    path: String,
) -> Result<models::ModelLibraryPathSetting, String> {
    models::ai_model_library_path_set_impl(app, state, path)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_scan(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<models::ModelPackageScanResult, String> {
    models::ai_model_scan_impl(app, state)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_packages(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<models::ModelPackageRecord>, String> {
    models::ai_model_packages_impl(app, state)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_package_register(
    app: AppHandle,
    state: State<'_, AiState>,
    package_dir: String,
) -> Result<models::ModelPackageRecord, String> {
    models::ai_model_package_register_impl(app, state, package_dir)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_package_verify(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
) -> Result<models::ModelPackageRecord, String> {
    models::ai_model_package_verify_impl(app, state, package_id)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_package_register_linked(
    app: AppHandle,
    state: State<'_, AiState>,
    external_path: String,
) -> Result<models::ModelPackageRecord, String> {
    models::ai_model_package_register_linked_impl(app, state, external_path)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_package_relocate(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
    external_path: String,
) -> Result<models::ModelPackageRecord, String> {
    models::ai_model_package_relocate_impl(app, state, package_id, external_path)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_package_remove(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
    delete_managed_files: bool,
) -> Result<(), String> {
    models::ai_model_package_remove_impl(app, state, package_id, delete_managed_files)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_dev_catalog_register(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<models::ModelPackageRecord, String> {
    models::ai_model_dev_catalog_register_impl(app, state)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_download_enqueue(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
) -> Result<download::DownloadEnqueueResult, String> {
    download::ai_model_download_enqueue_impl(app, state, package_id)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_download_list(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<models::ModelDownloadTaskRecord>, String> {
    download::ai_model_download_list_impl(app, state)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_download_pause(
    app: AppHandle,
    state: State<'_, AiState>,
    task_id: String,
) -> Result<models::ModelDownloadTaskRecord, String> {
    download::ai_model_download_pause_impl(app, state, task_id)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_download_resume(
    app: AppHandle,
    state: State<'_, AiState>,
    task_id: String,
) -> Result<models::ModelDownloadTaskRecord, String> {
    download::ai_model_download_resume_impl(app, state, task_id)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_download_cancel(
    app: AppHandle,
    state: State<'_, AiState>,
    task_id: String,
) -> Result<models::ModelDownloadTaskRecord, String> {
    download::ai_model_download_cancel_impl(app, state, task_id)
}

#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) fn ai_model_license_accept(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
) -> Result<(), String> {
    download::ai_model_license_accept_impl(app, state, package_id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiStorageStatus {
    pub root_name: String,
    pub database_name: String,
    pub schema_version: u32,
    pub books: u64,
    pub chunks: u64,
    pub jobs: u64,
    pub provider_models: u64,
    pub model_packages: u64,
}

/// Rebuildable AI/derived data exposed to future cache management UI.
///
/// This boundary deliberately excludes shelf records, source EPUBs, reading
/// state, bookmarks, notes, settings, fonts, and provider configuration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiCacheStatus {
    pub kind: String,
    pub display_name: String,
    pub item_count: u64,
    pub size_bytes: Option<u64>,
    pub updated_at: u64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiIndexStatus {
    pub content_hash: String,
    pub parser_version: String,
    pub normalizer_version: String,
    pub chunker_version: String,
    pub chunk_count: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiJob {
    pub id: String,
    pub kind: String,
    pub content_hash: Option<String>,
    pub state: TaskState,
    pub progress: f64,
    pub error: Option<String>,
    pub cancel_requested: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiIndexBookInput {
    pub content_hash: String,
    pub title: String,
    pub creator: String,
    pub language: Option<String>,
    pub parser_version: String,
    pub normalizer_version: String,
    pub chunker_version: String,
    pub chunks: Vec<AiIndexChunkInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiIndexChunkInput {
    pub chunk_id: String,
    pub spine_index: u32,
    pub chapter_path: String,
    pub chapter_title: Option<String>,
    pub content_type: String,
    pub original_text: String,
    pub normalized_text: String,
    pub anchor_json: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiIndexStageBeginInput {
    pub content_hash: String,
    pub title: String,
    pub creator: String,
    pub language: Option<String>,
    pub parser_version: String,
    pub normalizer_version: String,
    pub chunker_version: String,
    pub expected_chunks: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiIndexStageAppendInput {
    pub staging_id: String,
    pub chunks: Vec<AiIndexChunkInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSearchInput {
    pub query: String,
    pub limit: Option<u32>,
    pub content_hash: Option<String>,
    pub content_type: Option<String>,
    pub title: Option<String>,
    pub creator: Option<String>,
    pub chapter_path: Option<String>,
    pub parser_version: Option<String>,
    pub normalizer_version: Option<String>,
    pub chunker_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSearchHit {
    pub content_hash: String,
    pub title: String,
    pub creator: String,
    pub language: Option<String>,
    pub chunk_id: String,
    pub spine_index: u32,
    pub chapter_path: String,
    pub chapter_title: Option<String>,
    pub content_type: String,
    pub original_text: String,
    pub normalized_text: String,
    pub anchor_json: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnqueueTaskInput {
    pub kind: String,
    pub content_hash: Option<String>,
}

#[tauri::command]
pub(crate) fn ai_initialize(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<AiStorageStatus, String> {
    state.ensure(&app)?.status()
}

#[tauri::command]
pub(crate) fn ai_cleanup_book(
    app: AppHandle,
    state: State<'_, AiState>,
    content_hash: String,
) -> Result<(), String> {
    let hash = normalize_content_hash(&content_hash)?;
    state.ensure(&app)?.delete_book_derived_data(&hash)
}

#[tauri::command]
pub(crate) fn ai_cleanup_all(app: AppHandle, state: State<'_, AiState>) -> Result<(), String> {
    state.ensure(&app)?.clear_all_derived_data()
}

#[tauri::command]
pub(crate) fn ai_index_clear_all(app: AppHandle, state: State<'_, AiState>) -> Result<(), String> {
    state.ensure(&app)?.clear_all_indexes()
}

#[tauri::command]
pub(crate) fn ai_index_replace(
    app: AppHandle,
    state: State<'_, AiState>,
    input: AiIndexBookInput,
) -> Result<u64, String> {
    state.ensure(&app)?.replace_book_index(input)
}

#[tauri::command]
pub(crate) fn ai_index_begin(
    app: AppHandle,
    state: State<'_, AiState>,
    input: AiIndexStageBeginInput,
) -> Result<String, String> {
    state.ensure(&app)?.begin_index_stage(input)
}

#[tauri::command]
pub(crate) fn ai_index_append(
    app: AppHandle,
    state: State<'_, AiState>,
    input: AiIndexStageAppendInput,
) -> Result<u64, String> {
    state.ensure(&app)?.append_index_stage(input)
}

#[tauri::command]
pub(crate) fn ai_index_commit(
    app: AppHandle,
    state: State<'_, AiState>,
    staging_id: String,
) -> Result<u64, String> {
    state.ensure(&app)?.commit_index_stage(&staging_id)
}

#[tauri::command]
pub(crate) fn ai_index_abort(
    app: AppHandle,
    state: State<'_, AiState>,
    staging_id: String,
) -> Result<(), String> {
    state.ensure(&app)?.abort_index_stage(&staging_id)
}

#[tauri::command]
pub(crate) fn ai_index_status(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<AiIndexStatus>, String> {
    state.ensure(&app)?.list_index_status()
}

#[tauri::command]
pub(crate) fn ai_cache_status(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<AiCacheStatus>, String> {
    state.ensure(&app)?.list_cache_statuses()
}

#[tauri::command]
pub(crate) fn ai_cache_clear(
    app: AppHandle,
    state: State<'_, AiState>,
    kind: String,
) -> Result<(), String> {
    state.ensure(&app)?.clear_cache(&kind)
}

#[tauri::command]
pub(crate) fn ai_search(
    app: AppHandle,
    state: State<'_, AiState>,
    input: AiSearchInput,
) -> Result<Vec<AiSearchHit>, String> {
    state.ensure(&app)?.search(input)
}

#[tauri::command]
pub(crate) fn ai_task_enqueue(
    app: AppHandle,
    state: State<'_, AiState>,
    input: EnqueueTaskInput,
) -> Result<AiJob, String> {
    state
        .ensure(&app)?
        .enqueue_task(input.kind, input.content_hash)
}

#[tauri::command]
pub(crate) fn ai_task_acquire_library_index(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<AiJob, String> {
    state.ensure(&app)?.acquire_library_index_task()
}

fn transition(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
    transition: TaskTransition,
) -> Result<AiJob, String> {
    state.ensure(&app)?.transition_task(&id, transition)
}

#[tauri::command]
pub(crate) fn ai_task_start(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
) -> Result<AiJob, String> {
    transition(app, state, id, TaskTransition::Start)
}

#[tauri::command]
pub(crate) fn ai_task_pause(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
) -> Result<AiJob, String> {
    transition(app, state, id, TaskTransition::Pause)
}

#[tauri::command]
pub(crate) fn ai_task_resume(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
) -> Result<AiJob, String> {
    transition(app, state, id, TaskTransition::Resume)
}

#[tauri::command]
pub(crate) fn ai_task_complete(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
) -> Result<AiJob, String> {
    transition(app, state, id, TaskTransition::Complete)
}

#[tauri::command]
pub(crate) fn ai_task_fail(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
    error: String,
) -> Result<AiJob, String> {
    if error.trim().is_empty() || error.chars().count() > 4096 {
        return Err("任务错误信息必须非空且不超过 4096 个字符".into());
    }
    state
        .ensure(&app)?
        .transition_task(&id, TaskTransition::Fail(error))
}

#[tauri::command]
pub(crate) fn ai_task_cancel(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
) -> Result<AiJob, String> {
    transition(app, state, id, TaskTransition::Cancel)
}

#[tauri::command]
pub(crate) fn ai_task_update_progress(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
    progress: f64,
) -> Result<AiJob, String> {
    state.ensure(&app)?.update_task_progress(&id, progress)
}

#[tauri::command]
pub(crate) fn ai_task_list(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<AiJob>, String> {
    state.ensure(&app)?.list_tasks()
}

/// Real semantic index storage.  Building and querying additionally require a
/// native embedding session; this command only owns the derived-data boundary.
#[cfg(feature = "ai")]
#[tauri::command]
pub(crate) async fn ai_semantic(
    app: AppHandle,
    state: State<'_, AiState>,
    input: semantic_store::Request,
) -> Result<semantic_store::Reply, String> {
    let store = state.ensure(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.semantic(input))
        .await
        .map_err(|e| format!("语义索引存储线程失败：{e}"))?
}

#[cfg(all(test, windows, feature = "ai"))]
#[path = "c58b_probe_tests.rs"]
mod c58b_probe_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "epub-reader-ai-state-test-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn cleanup_if_present_does_not_create_unused_database() {
        let root = test_root();
        let state = AiState::default();
        state
            .cleanup_books_if_present_at(&root, &["a".repeat(64)])
            .unwrap();
        assert!(!AiStore::database_path(&root).exists());
        assert!(!root.exists());
        drop(state);
    }

    #[test]
    fn cleanup_if_present_deletes_existing_book_rows() {
        let root = test_root();
        let hash = "a".repeat(64);
        let store = AiStore::open(&root).unwrap();
        store.insert_book_for_test(&hash).unwrap();
        store
            .enqueue_task("index".into(), Some(hash.clone()))
            .unwrap();
        drop(store);

        let state = AiState::default();
        state.cleanup_books_if_present_at(&root, &[hash]).unwrap();
        let store = AiStore::open(&root).unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.books, 0);
        assert_eq!(status.chunks, 0);
        assert_eq!(status.jobs, 0);
        drop(store);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
