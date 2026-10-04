//! AI/RAG storage and task lifecycle foundation.
//!
//! This module deliberately contains no model, embedding, network, or reader
//! code. It owns only the derived-data boundary under `<app data>/ai`.

mod cache_settings;
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
mod metadata_store;
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
use std::path::{Path, PathBuf};
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
    cache_settings: Mutex<CacheSettingsRuntime>,
    cache_settings_write: Mutex<()>,
    #[cfg(feature = "ai")]
    pub(crate) downloads: download::DownloadManager,
}

#[derive(Debug, Clone)]
struct RuntimeCacheChoice {
    directory: PathBuf,
    fallback_reason: Option<String>,
}

#[derive(Debug, Default)]
struct CacheSettingsRuntime {
    initialized: bool,
    startup_base: Option<PathBuf>,
    config_error: Option<String>,
    configured_base: Option<PathBuf>,
    active: Option<RuntimeCacheChoice>,
}

impl CacheSettingsRuntime {
    fn capture(&mut self, loaded: cache_settings::StartupCacheSettings) {
        if self.initialized {
            return;
        }
        self.initialized = true;
        self.startup_base = loaded.base_directory.clone();
        self.configured_base = loaded.base_directory;
        self.config_error = loaded.config_error;
    }

    fn resolve_once(
        &mut self,
        default_directory: &Path,
        native_identifier: &str,
    ) -> RuntimeCacheChoice {
        if let Some(active) = self.active.as_ref() {
            return active.clone();
        }
        let active = if let Some(error) = self.config_error.clone() {
            RuntimeCacheChoice {
                directory: default_directory.to_path_buf(),
                fallback_reason: Some(error),
            }
        } else if let Some(base) = self.startup_base.as_ref() {
            let requested = cache_settings::custom_cache_directory(base, native_identifier)
                .and_then(|directory| {
                    cache_settings::prepare_custom_cache_directory(&directory).map(|()| directory)
                });
            match requested {
                Ok(directory) => RuntimeCacheChoice {
                    directory,
                    fallback_reason: None,
                },
                Err(reason) => RuntimeCacheChoice {
                    directory: default_directory.to_path_buf(),
                    fallback_reason: Some(reason),
                },
            }
        } else {
            RuntimeCacheChoice {
                directory: default_directory.to_path_buf(),
                fallback_reason: None,
            }
        };
        self.active = Some(active.clone());
        active
    }

    fn restart_required(&self) -> bool {
        self.startup_base != self.configured_base
    }
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            store: Mutex::new(None),
            cache_settings: Mutex::new(CacheSettingsRuntime::default()),
            cache_settings_write: Mutex::new(()),
            #[cfg(feature = "ai")]
            downloads: download::DownloadManager::default(),
        }
    }
}

impl AiState {
    /// Capture the saved path choice before any command can save a new one.
    /// Startup must not fail because of a malformed settings file; the error
    /// is surfaced as a visible fallback reason in the cache panel instead.
    pub(crate) fn capture_startup_cache_choice(&self, app: &AppHandle) {
        let loaded = match app.path().app_data_dir() {
            Ok(app_data_dir) => cache_settings::load_startup_settings(&app_data_dir),
            Err(error) => cache_settings::StartupCacheSettings {
                base_directory: None,
                config_error: Some(format!("无法取得应用数据目录以读取缓存设置：{error}")),
            },
        };
        if let Ok(mut runtime) = self.cache_settings.lock() {
            runtime.capture(loaded);
        }
    }

    fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("无法取得应用数据目录：{error}"))
    }

    fn native_identifier(app: &AppHandle) -> String {
        app.config().identifier.clone()
    }

    fn ensure_startup_cache_captured(&self, app_data_dir: &Path) -> Result<(), String> {
        let mut runtime = self
            .cache_settings
            .lock()
            .map_err(|_| "AI 缓存设置状态锁已损坏".to_string())?;
        if !runtime.initialized {
            runtime.capture(cache_settings::load_startup_settings(app_data_dir));
        }
        Ok(())
    }

    fn resolve_active_cache(&self, app: &AppHandle) -> Result<RuntimeCacheChoice, String> {
        let app_data_dir = Self::app_data_dir(app)?;
        self.ensure_startup_cache_captured(&app_data_dir)?;
        let identifier = Self::native_identifier(app);
        let default_directory = AiStore::default_cache_directory(&app_data_dir);
        let mut runtime = self
            .cache_settings
            .lock()
            .map_err(|_| "AI 缓存设置状态锁已损坏".to_string())?;
        Ok(runtime.resolve_once(&default_directory, &identifier))
    }

    fn store_snapshot(&self) -> Result<Option<Arc<AiStore>>, String> {
        let slot = self
            .store
            .lock()
            .map_err(|_| "AI 存储状态锁已损坏".to_string())?;
        Ok(slot.as_ref().map(Arc::clone))
    }

    fn existing_cache_store(&self, app: &AppHandle) -> Result<Option<Arc<AiStore>>, String> {
        if let Some(store) = self.store_snapshot()? {
            return Ok(Some(store));
        }
        let active = self.resolve_active_cache(app)?;
        let database_path = AiStore::database_path_in(&active.directory);
        if !database_path.exists() {
            return Ok(None);
        }
        Ok(Some(self.ensure(app)?))
    }

    fn ensure(&self, app: &AppHandle) -> Result<Arc<AiStore>, String> {
        if let Some(store) = self.store_snapshot()? {
            return Ok(store);
        }
        let app_data_dir = Self::app_data_dir(app)?;
        let active = self.resolve_active_cache(app)?;
        self.ensure_store_in(&app_data_dir, &active.directory)
    }

    fn get_or_initialize_store(
        &self,
        open: impl FnOnce() -> Result<AiStore, String>,
    ) -> Result<Arc<AiStore>, String> {
        // Opening also migrates and reclaims interrupted tasks. Keep the gate
        // until publication so a second opener cannot pause new live work.
        let mut slot = self
            .store
            .lock()
            .map_err(|_| "AI 存储状态锁已损坏".to_string())?;
        if let Some(existing) = slot.as_ref() {
            return Ok(Arc::clone(existing));
        }
        let store = Arc::new(open()?);
        *slot = Some(Arc::clone(&store));
        Ok(store)
    }

    fn ensure_store_in(
        &self,
        app_data_dir: &Path,
        cache_directory: &Path,
    ) -> Result<Arc<AiStore>, String> {
        self.get_or_initialize_store(|| {
            match AiStore::open_with_cache_directory(app_data_dir, cache_directory) {
                Ok(store) => Ok(store),
                Err(open_error) => {
                    let default_directory = AiStore::default_cache_directory(app_data_dir);
                    if cache_directory == default_directory {
                        return Err(open_error);
                    }
                    // A path can disappear after the first status read. Recheck
                    // path access only; valid-path schema/metadata errors stay
                    // errors and are never disguised as a directory fallback.
                    let Err(path_error) =
                        cache_settings::prepare_custom_cache_directory(cache_directory)
                    else {
                        return Err(open_error);
                    };
                    let store =
                        AiStore::open_with_cache_directory(app_data_dir, &default_directory)?;
                    let mut runtime = self
                        .cache_settings
                        .lock()
                        .map_err(|_| "AI 缓存设置状态锁已损坏".to_string())?;
                    runtime.active = Some(RuntimeCacheChoice {
                        directory: default_directory,
                        fallback_reason: Some(path_error),
                    });
                    Ok(store)
                }
            }
        })
    }

    /// Remove book-scoped AI data only when AI storage already exists.
    /// Deleting a shelf record must not initialize an unused AI database.
    pub(crate) fn cleanup_books_if_present(
        &self,
        app: &AppHandle,
        content_hashes: &[String],
    ) -> Result<(), String> {
        let app_data_dir = Self::app_data_dir(app)?;
        let active = self.resolve_active_cache(app)?;
        self.cleanup_books_if_present_in(app_data_dir, &active.directory, content_hashes)
    }

    fn cleanup_books_if_present_in(
        &self,
        app_data_dir: impl AsRef<Path>,
        cache_directory: &Path,
        content_hashes: &[String],
    ) -> Result<(), String> {
        let app_data_dir = app_data_dir.as_ref();
        let hashes = content_hashes
            .iter()
            .map(|hash| normalize_content_hash(hash))
            .collect::<Result<Vec<_>, _>>()?;
        if hashes.is_empty() {
            return Ok(());
        }
        let store = if let Some(store) = self.store_snapshot()? {
            store
        } else {
            let database_path = AiStore::database_path_in(cache_directory);
            if !database_path.exists() {
                return Ok(());
            }
            self.ensure_store_in(app_data_dir, cache_directory)?
        };
        store.delete_books_derived_data(&hashes)
    }

    #[cfg(test)]
    fn cleanup_books_if_present_at(
        &self,
        app_data_dir: impl AsRef<Path>,
        content_hashes: &[String],
    ) -> Result<(), String> {
        let default_directory = AiStore::default_cache_directory(app_data_dir.as_ref());
        self.cleanup_books_if_present_in(app_data_dir, &default_directory, content_hashes)
    }

    fn cache_storage_status_impl(&self, app: &AppHandle) -> Result<CacheStorageStatus, String> {
        let active = self.resolve_active_cache(app)?;
        let (configured_base_directory, restart_required) = {
            let runtime = self
                .cache_settings
                .lock()
                .map_err(|_| "AI 缓存设置状态锁已损坏".to_string())?;
            (runtime.configured_base.clone(), runtime.restart_required())
        };
        let database_path = AiStore::database_path_in(&active.directory);
        let (total_size_bytes, caches) = if let Some(store) = self.store_snapshot()? {
            (store.cache_database_size()?, store.list_cache_statuses()?)
        } else if database_path.exists() {
            let store = self.ensure(app)?;
            (store.cache_database_size()?, store.list_cache_statuses()?)
        } else {
            (0, vec![AiStore::empty_full_text_cache_status()])
        };
        // The first open may have fallen back after a path went offline.
        let active = self.resolve_active_cache(app)?;
        Ok(CacheStorageStatus {
            active_directory: active.directory.to_string_lossy().into_owned(),
            configured_base_directory: configured_base_directory
                .map(|path| path.to_string_lossy().into_owned()),
            restart_required,
            fallback_reason: active.fallback_reason,
            total_size_bytes,
            caches,
        })
    }

    fn cache_storage_set_directory_impl(
        &self,
        app: &AppHandle,
        base_directory: Option<String>,
    ) -> Result<CacheStorageStatus, String> {
        if base_directory.is_some() && !cache_settings::custom_directory_supported() {
            return Err("当前平台不支持自定义缓存目录".into());
        }
        let app_data_dir = Self::app_data_dir(app)?;
        self.ensure_startup_cache_captured(&app_data_dir)?;
        let new_base = match base_directory.as_deref() {
            Some(raw) => Some(cache_settings::normalize_base_directory(raw)?),
            None => None,
        };
        if let Some(base) = new_base.as_ref() {
            let requested =
                cache_settings::custom_cache_directory(base, &Self::native_identifier(app))?;
            cache_settings::prepare_custom_cache_directory(&requested)?;
        }
        let _guard = self
            .cache_settings_write
            .lock()
            .map_err(|_| "AI 缓存设置写入锁已损坏".to_string())?;
        cache_settings::save_settings(&app_data_dir, new_base.as_deref())?;
        {
            let mut runtime = self
                .cache_settings
                .lock()
                .map_err(|_| "AI 缓存设置状态锁已损坏".to_string())?;
            runtime.configured_base = new_base;
        }
        self.cache_storage_status_impl(app)
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
pub(crate) struct CacheStorageStatus {
    pub active_directory: String,
    pub configured_base_directory: Option<String>,
    pub restart_required: bool,
    pub fallback_reason: Option<String>,
    pub total_size_bytes: u64,
    pub caches: Vec<AiCacheStatus>,
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
pub(crate) async fn ai_cache_clear(app: AppHandle, kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if kind.trim() != store::FULL_TEXT_INDEX_CACHE_KIND {
            return Err(format!("不支持清理 AI 缓存类型：{kind}"));
        }
        let state = app.state::<AiState>();
        let Some(store) = state.existing_cache_store(&app)? else {
            return Ok(());
        };
        store.clear_cache(&kind)
    })
    .await
    .map_err(|error| format!("AI 清理线程失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn cache_storage_get_status(app: AppHandle) -> Result<CacheStorageStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AiState>().cache_storage_status_impl(&app)
    })
    .await
    .map_err(|error| format!("缓存状态读取线程失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn cache_storage_set_directory(
    app: AppHandle,
    base_directory: Option<String>,
) -> Result<CacheStorageStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AiState>()
            .cache_storage_set_directory_impl(&app, base_directory)
    })
    .await
    .map_err(|error| format!("缓存设置保存线程失败：{error}"))?
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
    fn cache_settings_review_freezes_startup_and_keeps_unavailable_selection() {
        let root = test_root();
        let default_directory = root.join("default");
        let chosen_a = root.join("chosen-a");
        let chosen_b = root.join("chosen-b");
        let identifier = "dev.epubreader.test";

        let mut runtime = CacheSettingsRuntime::default();
        runtime.capture(super::cache_settings::StartupCacheSettings {
            base_directory: Some(chosen_a.clone()),
            config_error: None,
        });
        let first = runtime.resolve_once(&default_directory, identifier);
        assert_eq!(
            first.directory,
            chosen_a.join(identifier).join("reader-cache-v1")
        );
        assert!(first.fallback_reason.is_none());
        assert!(!runtime.restart_required());

        // Saving a new selection after the runtime choice was resolved only
        // updates the next-start value; this process keeps the first choice.
        runtime.configured_base = Some(chosen_b.clone());
        assert!(runtime.restart_required());
        let still_frozen = runtime.resolve_once(&default_directory, identifier);
        assert_eq!(still_frozen.directory, first.directory);

        // A new process captures the saved value and uses it.
        let mut next_process = CacheSettingsRuntime::default();
        next_process.capture(super::cache_settings::StartupCacheSettings {
            base_directory: Some(chosen_b.clone()),
            config_error: None,
        });
        let restarted = next_process.resolve_once(&default_directory, identifier);
        assert_eq!(
            restarted.directory,
            chosen_b.join(identifier).join("reader-cache-v1")
        );

        // A path that cannot host the app-owned child falls back to the
        // default for this run while retaining the saved selection for later.
        let blocker = root.join("blocker-file");
        fs::write(&blocker, b"not a directory").unwrap();
        let mut invalid = CacheSettingsRuntime::default();
        super::cache_settings::save_settings(&root, Some(&blocker)).unwrap();
        let loaded = super::cache_settings::load_startup_settings(&root);
        assert_eq!(loaded.base_directory.as_ref(), Some(&blocker));
        assert!(loaded.config_error.is_none());
        invalid.capture(loaded);
        let fallback = invalid.resolve_once(&default_directory, identifier);
        assert_eq!(fallback.directory, default_directory);
        assert!(fallback.fallback_reason.is_some());
        assert_eq!(invalid.configured_base.as_ref(), Some(&blocker));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_settings_review_concurrent_open_preserves_running_work() {
        let root = test_root();
        let state = Arc::new(AiState::default());
        let starts = Arc::new(std::sync::Barrier::new(5));
        let opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (root, state, starts, opens) = (
                    root.clone(),
                    Arc::clone(&state),
                    Arc::clone(&starts),
                    Arc::clone(&opens),
                );
                std::thread::spawn(move || {
                    starts.wait();
                    state
                        .get_or_initialize_store(|| {
                            opens.fetch_add(1, Ordering::SeqCst);
                            let store = AiStore::open(&root)?;
                            let job = store.enqueue_task("library-text-index".into(), None)?;
                            store.transition_task(&job.id, TaskTransition::Start)?;
                            Ok(store)
                        })
                        .unwrap()
                })
            })
            .collect();
        starts.wait();
        let stores: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(opens.load(Ordering::SeqCst), 1);
        assert!(stores.iter().all(|store| Arc::ptr_eq(store, &stores[0])));
        let jobs = stores[0].list_tasks().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].state, TaskState::Running);
        drop(stores);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_settings_review_cache_file_access_failure_falls_back() {
        let root = test_root();
        let custom = root.join("chosen-cache");
        fs::create_dir_all(AiStore::database_path_in(&custom)).unwrap();
        let state = AiState::default();
        let store = state.ensure_store_in(&root, &custom).unwrap();
        assert!(AiStore::database_path(&root).is_file());
        assert!(AiStore::metadata_path(&root).is_file());
        let runtime = state.cache_settings.lock().unwrap();
        assert_eq!(
            runtime.active.as_ref().unwrap().directory,
            AiStore::default_cache_directory(&root)
        );
        assert!(runtime.active.as_ref().unwrap().fallback_reason.is_some());
        drop(runtime);
        drop(store);
        drop(state);
        fs::remove_dir_all(root).unwrap();
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
