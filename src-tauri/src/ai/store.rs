#[cfg(feature = "ai")]
use super::models::{
    validate_manifest_for_registration, validate_relative_path, ModelDownloadTaskRecord,
    ModelPackageFileRecord, ModelPackageManifest, ModelPackageRecord, ModelPackageScanStatus,
    ModelPackageSourceRecord,
};
use super::{
    AiCacheStatus, AiIndexBookInput, AiIndexChunkInput, AiIndexStageAppendInput,
    AiIndexStageBeginInput, AiIndexStatus, AiJob, AiSearchHit, AiSearchInput, AiStorageStatus,
};
use crate::ai::task::{next_state, TaskState, TaskTransition};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashSet;
#[cfg(feature = "ai")]
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Core owns the FTS/task schema through v3. AI extends the same database to
/// v6 when model assets are enabled. Keep accepting v6 in Core so a stable
/// build can open a database previously touched by an AI build without
/// attempting to migrate or use model tables.
#[cfg(feature = "ai")]
pub(crate) const SCHEMA_VERSION: u32 = 6;
#[cfg(not(feature = "ai"))]
pub(crate) const SCHEMA_VERSION: u32 = 3;
pub(crate) const MAX_SUPPORTED_SCHEMA_VERSION: u32 = 6;
const ROOT_NAME: &str = "ai";
const DATABASE_NAME: &str = "ai.sqlite3";
const CHUNK_FTS_SCHEMA: &str = "CREATE VIRTUAL TABLE chunk_fts USING fts5(
    normalized_text, content_hash UNINDEXED, chunk_id UNINDEXED, tokenize='trigram'
);";
pub(crate) const MAX_STAGE_BATCH_CHUNKS: usize = 256;
pub(crate) const MAX_STAGE_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_STAGE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_STAGE_TOTAL_CHUNKS: u64 = 1_000_000;
const MAX_STAGE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const LIBRARY_TEXT_INDEX_TASK_KIND: &str = "library-text-index";
static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
#[cfg(feature = "ai")]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
#[cfg(feature = "ai")]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

pub(crate) struct AiStore {
    root: PathBuf,
    connection: Mutex<Connection>,
}

impl AiStore {
    pub(crate) fn database_path(app_data_dir: impl AsRef<Path>) -> PathBuf {
        app_data_dir.as_ref().join(ROOT_NAME).join(DATABASE_NAME)
    }

    pub(crate) fn open(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let root = app_data_dir.as_ref().join(ROOT_NAME);
        std::fs::create_dir_all(&root).map_err(|error| format!("无法创建 AI 数据目录：{error}"))?;
        let database_path = Self::database_path(app_data_dir);
        let connection = Connection::open(&database_path)
            .map_err(|error| format!("无法打开 AI SQLite 数据库：{error}"))?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|error| format!("启用 AI SQLite 外键约束失败：{error}"))?;
        connection
            .busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|error| format!("设置 SQLite 等待上限失败：{error}"))?;
        migrate(&connection)?;
        let store = Self {
            root,
            connection: Mutex::new(connection),
        };
        store.reclaim_active_jobs();
        #[cfg(feature = "ai")]
        store.pause_all_model_downloads();
        store.reclaim_staging();
        Ok(store)
    }

    pub(crate) fn status(&self) -> Result<AiStorageStatus, String> {
        self.with_connection(|connection| {
            Ok(AiStorageStatus {
                root_name: ROOT_NAME.into(),
                database_name: DATABASE_NAME.into(),
                schema_version: SCHEMA_VERSION,
                books: count(connection, "books")?,
                chunks: count(connection, "chunks")?,
                jobs: count(connection, "jobs")?,
                #[cfg(feature = "ai")]
                provider_models: count(connection, "provider_models")?,
                #[cfg(not(feature = "ai"))]
                provider_models: 0,
                #[cfg(feature = "ai")]
                model_packages: count(connection, "model_packages")?,
                #[cfg(not(feature = "ai"))]
                model_packages: 0,
            })
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn model_library_path(&self) -> Result<Option<String>, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT root_path FROM model_library_config WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("读取模型库目录失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn has_active_model_downloads(&self) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM model_download_tasks
                     WHERE state IN ('queued','downloading','verifying'))",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map(|value| value != 0)
                .map_err(|error| format!("读取模型活动任务状态失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn set_model_library_path(&self, path: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("开始更新模型库目录事务失败：{error}"))?;
            let previous: Option<String> = transaction
                .query_row(
                    "SELECT root_path FROM model_library_config WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("读取旧模型库目录失败：{error}"))?;
            let changed = previous
                .as_deref()
                .is_none_or(|old| normalize_model_root(old) != normalize_model_root(path));
            // Nonblocking inside the transaction: a worker holding a file
            // guard may need this DB mutex to finish. Never wait here.
            let active: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM model_download_tasks WHERE state IN ('queued','downloading','verifying'))",
                [], |row| row.get(0),
            ).map_err(|e| format!("读取模型活动任务失败：{e}"))?;
            if changed && active { return Err("模型下载任务进行中，暂时不能更改模型库目录".into()); }
            let new_root = Path::new(path);
            let _new_guard = if new_root.is_dir() { Some(super::model_locks::ModelLock::root(new_root)?) } else { None };
            let old_root = previous.as_deref().map(Path::new).filter(|p| p.is_dir());
            let _old_guard = match old_root {
                Some(old) if old.canonicalize().ok() != new_root.canonicalize().ok() => Some(super::model_locks::ModelLock::root(old)?),
                _ => None,
            };
            transaction
                .execute(
                    "INSERT INTO model_library_config (id, root_path, updated_at_ms)
                     VALUES (1, ?1, ?2)
                     ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path,
                       updated_at_ms = excluded.updated_at_ms",
                    params![path, now_ms() as i64],
                )
                .map_err(|error| format!("保存模型库目录失败：{error}"))?;
            if changed {
                transaction
                    .execute(
                        "UPDATE model_packages SET state = 'missing', updated_at_ms = ?1
                         WHERE storage_kind = 'managed'",
                        [now_ms() as i64],
                    )
                    .map_err(|error| format!("更新旧模型包状态失败：{error}"))?;
            }
            transaction
                .commit()
                .map_err(|error| format!("提交模型库目录事务失败：{error}"))?;
            Ok(())
        })
    }

    /// Registers only a package that has already passed complete on-disk
    /// manifest and file verification. Catalog-only registration belongs to a
    /// later download task and must not reuse this method.
    #[cfg(feature = "ai")]
    pub(crate) fn register_verified_model_manifest(
        &self,
        manifest: &ModelPackageManifest,
        package_dir: &str,
    ) -> Result<(), String> {
        self.register_model_manifest_with_state(
            manifest,
            package_dir,
            "managed",
            "installed",
            true,
            None,
        )
    }

    /// Internal trusted catalog registration for a future built-in source.
    /// This is intentionally not exposed as a Tauri command: arbitrary
    /// frontend JSON must not be able to add network sources.
    #[allow(dead_code)]
    #[cfg(feature = "ai")]
    pub(crate) fn register_catalog_model_manifest(
        &self,
        manifest: &ModelPackageManifest,
        package_dir: &str,
    ) -> Result<(), String> {
        self.register_model_manifest_with_state(
            manifest,
            package_dir,
            "managed",
            "uninstalled",
            false,
            None,
        )
    }

    #[cfg(feature = "ai")]
    pub(crate) fn register_linked_model_manifest(
        &self,
        manifest: &ModelPackageManifest,
        external_path: &str,
    ) -> Result<(), String> {
        self.register_model_manifest_with_state(
            manifest,
            "linked",
            "linked",
            "installed",
            true,
            Some(external_path),
        )
    }

    #[cfg(feature = "ai")]
    fn register_model_manifest_with_state(
        &self,
        manifest: &ModelPackageManifest,
        package_dir: &str,
        storage_kind: &str,
        package_state: &str,
        verified: bool,
        linked_external_path: Option<&str>,
    ) -> Result<(), String> {
        validate_manifest_for_registration(manifest)?;
        validate_relative_path(package_dir, "模型包目录")?;
        if package_dir
            .replace('\\', "/")
            .to_ascii_lowercase()
            .starts_with(".staging")
        {
            return Err("模型包目录不能使用保留目录".into());
        }
        let now = now_ms() as i64;
        let dimensions = manifest.dimensions.map(to_i64).transpose()?;
        let max_input = manifest.max_input.map(to_i64).transpose()?;
        let min_memory = manifest.min_memory_bytes.map(to_i64).transpose()?;
        let recommended_memory = manifest.recommended_memory_bytes.map(to_i64).transpose()?;
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始注册模型包事务失败：{error}"))?;
            let existing: Option<(String, String, Option<String>)> = transaction
                .query_row(
                    "SELECT storage_kind, package_dir, linked_external_path
                     FROM model_packages WHERE package_id = ?1",
                    [&manifest.package_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| format!("读取模型包所有权失败：{error}"))?;
            if let Some((existing_kind, existing_dir, existing_external)) = existing {
                let same_location = if storage_kind == "linked" {
                    existing_kind == "linked" && existing_external.as_deref() == linked_external_path
                } else {
                    existing_kind == "managed" && existing_dir == package_dir
                };
                if !same_location {
                    return Err("模型包 ID 已被其他模型所有权或路径占用，拒绝覆盖".into());
                }
            }
            transaction
                .execute(
                    "INSERT INTO model_packages
                       (package_id, model_id, version, display_name, format, dimensions,
                        max_input, recommended_batch, min_memory_bytes, recommended_memory_bytes,
                        platform, arch, license, original_source, homepage, requires_acceptance,
                        provider_kind, package_dir, storage_kind, linked_external_path, state, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                             ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                     ON CONFLICT(package_id) DO UPDATE SET
                       model_id = excluded.model_id, version = excluded.version,
                       display_name = excluded.display_name, format = excluded.format,
                       dimensions = excluded.dimensions, max_input = excluded.max_input,
                       recommended_batch = excluded.recommended_batch,
                       min_memory_bytes = excluded.min_memory_bytes,
                       recommended_memory_bytes = excluded.recommended_memory_bytes,
                       platform = excluded.platform, arch = excluded.arch,
                       license = excluded.license, original_source = excluded.original_source,
                       homepage = excluded.homepage, requires_acceptance = excluded.requires_acceptance,
                       provider_kind = excluded.provider_kind, package_dir = excluded.package_dir,
                       storage_kind = excluded.storage_kind,
                       linked_external_path = excluded.linked_external_path,
                       state = excluded.state, updated_at_ms = excluded.updated_at_ms",
                    params![
                        manifest.package_id,
                        manifest.model_id,
                        manifest.version,
                        manifest.display_name,
                        manifest.format,
                        dimensions,
                        max_input,
                        manifest.recommended_batch.map(i64::from),
                        min_memory,
                        recommended_memory,
                        manifest.platform,
                        manifest.arch,
                        manifest.license,
                        manifest.original_source,
                        manifest.homepage,
                        manifest.requires_acceptance as i64,
                        manifest.provider_kind,
                        package_dir,
                        storage_kind,
                        linked_external_path,
                        package_state,
                        now,
                    ],
                )
                .map_err(|error| format!("写入模型包清单失败：{error}"))?;
            transaction
                .execute(
                    "DELETE FROM model_package_capabilities WHERE package_id = ?1",
                    [&manifest.package_id],
                )
                .map_err(|error| format!("更新模型能力失败：{error}"))?;
            for capability in &manifest.capabilities {
                transaction
                    .execute(
                        "INSERT INTO model_package_capabilities (package_id, capability)
                         VALUES (?1, ?2)",
                        params![manifest.package_id, capability],
                    )
                    .map_err(|error| format!("写入模型能力失败：{error}"))?;
            }
            transaction
                .execute(
                    "DELETE FROM model_package_files WHERE package_id = ?1",
                    [&manifest.package_id],
                )
                .map_err(|error| format!("更新模型文件记录失败：{error}"))?;
            for file in &manifest.files {
                transaction
                    .execute(
                        "INSERT INTO model_package_files
                           (package_id, relative_path, size_bytes, sha256, purpose,
                            verification_state, actual_size_bytes, actual_sha256,
                            downloaded_bytes, installed_at_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            manifest.package_id,
                            file.relative_path,
                            to_i64(file.size_bytes)?,
                            file.sha256.to_ascii_lowercase(),
                            file.purpose,
                            if verified { "verified" } else { "pending" },
                            if verified { Some(to_i64(file.size_bytes)?) } else { None },
                            if verified { Some(file.sha256.to_ascii_lowercase()) } else { None },
                            if verified { to_i64(file.size_bytes)? } else { 0 },
                            if verified { Some(now) } else { None },
                        ],
                    )
                    .map_err(|error| format!("写入模型文件记录失败：{error}"))?;
            }
            transaction
                .execute(
                    "DELETE FROM model_sources WHERE package_id = ?1",
                    [&manifest.package_id],
                )
                .map_err(|error| format!("更新模型来源失败：{error}"))?;
            for (priority, source) in manifest.download_mirrors.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO model_sources (package_id, url, kind, priority)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![manifest.package_id, source.url, source.kind, priority as i64],
                    )
                    .map_err(|error| format!("写入模型来源失败：{error}"))?;
            }
            transaction
                .commit()
                .map_err(|error| format!("提交模型包清单事务失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn list_model_packages(&self) -> Result<Vec<ModelPackageRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare("SELECT package_id FROM model_packages ORDER BY package_id")
                .map_err(|error| format!("读取模型包列表失败：{error}"))?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("读取模型包列表失败：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("解析模型包列表失败：{error}"))?;
            ids.into_iter()
                .map(|id| read_model_package(connection, &id))
                .collect()
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn mark_missing_managed_packages(&self, root: &Path) -> Result<(), String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT package_id, package_dir FROM model_packages
                     WHERE storage_kind = 'managed'",
                )
                .map_err(|error| format!("读取模型包目录失败：{error}"))?;
            let packages = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("读取模型包目录失败：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("解析模型包目录失败：{error}"))?;
            for (package_id, package_dir) in packages {
                let safe_relative = !Path::new(&package_dir).is_absolute()
                    && !package_dir
                        .replace('\\', "/")
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..");
                if !safe_relative || !root.join(&package_dir).is_dir() {
                    connection
                        .execute(
                            "UPDATE model_packages SET state = 'missing', updated_at_ms = ?1
                             WHERE package_id = ?2 AND storage_kind = 'managed'",
                            params![now_ms() as i64, package_id],
                        )
                        .map_err(|error| format!("更新缺失模型包状态失败：{error}"))?;
                }
            }
            Ok(())
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn mark_stale_managed_packages(
        &self,
        scan_results: &[(String, Option<String>, String)],
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始更新陈旧模型包状态失败：{error}"))?;
            for (package_dir, package_id, state) in scan_results {
                if state == "ready" {
                    continue;
                }
                let target_state = if state == "missing" {
                    "missing"
                } else {
                    "corrupt"
                };
                transaction
                    .execute(
                        "UPDATE model_packages SET state = ?1, updated_at_ms = ?2
                         WHERE storage_kind = 'managed' AND package_dir = ?3
                           AND (?4 IS NULL OR package_id != ?4 OR ?5 != 'ready')",
                        params![
                            target_state,
                            now_ms() as i64,
                            package_dir,
                            package_id,
                            state
                        ],
                    )
                    .map_err(|error| format!("更新陈旧模型包状态失败：{error}"))?;
            }
            transaction
                .commit()
                .map_err(|error| format!("提交陈旧模型包状态失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn get_model_package(
        &self,
        package_id: &str,
    ) -> Result<Option<ModelPackageRecord>, String> {
        self.with_connection(|connection| {
            let exists = connection
                .query_row(
                    "SELECT 1 FROM model_packages WHERE package_id = ?1",
                    [package_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| format!("读取模型包失败：{error}"))?;
            exists
                .map(|_| read_model_package(connection, package_id))
                .transpose()
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn update_linked_model_path(
        &self,
        package_id: &str,
        external_path: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE model_packages SET linked_external_path = ?1,
                     state = 'installed', updated_at_ms = ?2
                     WHERE package_id = ?3 AND storage_kind = 'linked'",
                    params![external_path, now_ms() as i64, package_id],
                )
                .map_err(|error| format!("更新 linked 模型路径失败：{error}"))?;
            if changed == 0 {
                return Err("模型包不存在或不是 linked 模型".into());
            }
            Ok(())
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn remove_model_package(
        &self,
        package_id: &str,
        delete_managed_files: bool,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            // Keep the write transaction open while staging is removed. This
            // makes the active-state recheck and task-ID snapshot atomic with
            // respect to enqueue/resume operations on the same store.
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("开始删除模型包事务失败：{error}"))?;
            let package: Option<(String, String)> = transaction
                .query_row(
                    "SELECT storage_kind, package_dir FROM model_packages WHERE package_id = ?1",
                    [package_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("读取模型包失败：{error}"))?;
            let (storage_kind, package_dir) = package.ok_or_else(|| "模型包不存在".to_string())?;
            let active = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM model_download_tasks
                     WHERE package_id = ?1 AND state IN ('queued','downloading','verifying'))",
                    [package_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("读取模型任务状态失败：{error}"))?
                != 0;
            if active {
                return Err("模型下载任务进行中，不能删除模型包".into());
            }
            let task_ids = transaction
                .prepare("SELECT id FROM model_download_tasks WHERE package_id = ?1 ORDER BY id")
                .map_err(|error| format!("读取模型历史任务失败：{error}"))?
                .query_map([package_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("读取模型历史任务失败：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("解析模型历史任务失败：{error}"))?;
            let root = transaction
                .query_row(
                    "SELECT root_path FROM model_library_config WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("读取模型库目录失败：{error}"))?
                .map(PathBuf::from);
            let _asset_guard = match root.as_deref() {
                Some(root)
                    if root.is_dir() && (storage_kind == "managed" || !task_ids.is_empty()) =>
                {
                    Some(super::model_locks::ModelLock::assets(
                        root,
                        &package_dir,
                        package_id,
                    )?)
                }
                _ => None,
            };
            if !task_ids.is_empty() {
                let root = root
                    .as_deref()
                    .ok_or_else(|| "模型包存在历史下载任务，但无法定位模型库目录".to_string())?;
                for task_id in &task_ids {
                    super::download::remove_staging_for_task(root, package_id, task_id)?;
                }
            }
            if storage_kind == "managed" && delete_managed_files {
                let root = root
                    .as_deref()
                    .ok_or_else(|| "尚未设置模型库目录".to_string())?;
                let components = validate_relative_path(&package_dir, "模型包目录")?;
                let target = components
                    .iter()
                    .fold(root.to_path_buf(), |path, component| path.join(component));
                Self::ensure_no_reparse_components(root, &components)?;
                let root_canonical = root
                    .canonicalize()
                    .map_err(|error| format!("解析模型库目录失败：{error}"))?;
                let target_canonical = target
                    .canonicalize()
                    .map_err(|error| format!("解析模型包目录失败：{error}"))?;
                let target_metadata = fs::symlink_metadata(&target)
                    .map_err(|error| format!("读取模型包目录失败：{error}"))?;
                if !target_canonical.starts_with(&root_canonical)
                    || target_canonical == root_canonical
                    || target_metadata.file_type().is_symlink()
                    || is_reparse_point(&target_metadata)
                {
                    return Err("模型包目录越出模型库或包含符号链接，拒绝删除".into());
                }
                fs::remove_dir_all(&target)
                    .map_err(|error| format!("删除模型包文件失败：{error}"))?;
            }
            transaction
                .execute(
                    "DELETE FROM model_packages WHERE package_id = ?1",
                    [package_id],
                )
                .map_err(|error| format!("删除模型包记录失败：{error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("提交删除模型包事务失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    fn ensure_no_reparse_components(root: &Path, components: &[String]) -> Result<(), String> {
        let mut current = root.to_path_buf();
        for component in components {
            current.push(component);
            let metadata = fs::symlink_metadata(&current)
                .map_err(|error| format!("读取模型包路径组件失败：{error}"))?;
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err("模型包路径包含符号链接或重解析点，拒绝删除".into());
            }
        }
        Ok(())
    }

    #[cfg(feature = "ai")]
    pub(crate) fn accept_model_license(&self, package_id: &str) -> Result<(), String> {
        let package = self
            .get_model_package(package_id)?
            .ok_or_else(|| "模型包不存在".to_string())?;
        if package.license.trim().is_empty() {
            return Err("模型包缺少许可证信息".into());
        }
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO model_license_acceptance (package_id, license, accepted_at_ms)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(package_id) DO UPDATE SET license = excluded.license,
                       accepted_at_ms = excluded.accepted_at_ms",
                    params![package_id, package.license, now_ms() as i64],
                )
                .map_err(|error| format!("保存模型许可证接受记录失败：{error}"))?;
            Ok(())
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn is_model_license_accepted(&self, package_id: &str) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM model_license_acceptance a
                     JOIN model_packages p ON p.package_id = a.package_id
                     WHERE a.package_id = ?1 AND a.license = p.license)",
                    [package_id],
                    |row| row.get::<_, i64>(0),
                )
                .map(|value| value != 0)
                .map_err(|error| format!("读取模型许可证接受记录失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn create_or_get_model_download_task(
        &self,
        package_id: &str,
    ) -> Result<ModelDownloadTaskRecord, String> {
        let package = self
            .get_model_package(package_id)?
            .ok_or_else(|| "模型包不存在".to_string())?;
        if package.state == "installed" {
            return Err("模型包已经安装".into());
        }
        let total = package
            .files
            .iter()
            .try_fold(0u64, |sum, file| sum.checked_add(file.size_bytes))
            .ok_or_else(|| "模型包大小溢出".to_string())?;
        if total > i64::MAX as u64 {
            return Err("模型包大小超过 SQLite 可表示范围".into());
        }
        let id = self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("开始模型下载任务事务失败：{error}"))?;
            let active = transaction
                .query_row(
                    "SELECT id FROM model_download_tasks
                     WHERE package_id = ?1 AND state IN ('queued','downloading','paused','verifying')
                     ORDER BY created_at_ms ASC LIMIT 1",
                    [package_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("读取已有模型下载任务失败：{error}"))?;
            let id = if let Some(id) = active {
                id
            } else {
                let id = format!("model_{:x}_{}_{}", now_ms(), std::process::id(), JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed));
                let now = now_ms() as i64;
                transaction
                    .execute(
                        "INSERT INTO model_download_tasks
                           (id, package_id, state, bytes_downloaded, total_bytes,
                            package_total_bytes, created_at_ms, updated_at_ms)
                         VALUES (?1, ?2, 'queued', 0, ?3, ?3, ?4, ?4)",
                        params![id, package_id, total as i64, now],
                    )
                    .map_err(|error| format!("创建模型下载任务失败：{error}"))?;
                id
            };
            transaction
                .commit()
                .map_err(|error| format!("提交模型下载任务事务失败：{error}"))?;
            Ok(id)
        })?;
        self.get_model_download_task(&id)
            .and_then(|task| task.ok_or_else(|| "模型下载任务创建后无法读取".into()))
    }

    /// Atomically claims a queued task.  The worker must use this CAS before
    /// touching the network so a queued cancellation can never be revived.
    #[cfg(feature = "ai")]
    pub(crate) fn claim_model_download_task(
        &self,
        id: &str,
    ) -> Result<Option<ModelDownloadTaskRecord>, String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE model_download_tasks SET state = 'downloading',
                     started_at_ms = COALESCE(started_at_ms, ?1), updated_at_ms = ?1
                     WHERE id = ?2 AND state = 'queued'",
                    params![now_ms() as i64, id],
                )
                .map_err(|error| format!("领取模型下载任务失败：{error}"))?;
            if changed == 0 {
                return Ok(None);
            }
            read_model_download_task(connection, id).map(Some)
        })
    }

    /// Atomically queues a paused/failed task.  Concurrent resume IPC calls
    /// therefore produce at most one in-memory queue entry.
    #[cfg(feature = "ai")]
    pub(crate) fn queue_model_download_task(
        &self,
        id: &str,
    ) -> Result<Option<ModelDownloadTaskRecord>, String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE model_download_tasks SET state = 'queued', error = NULL,
                     updated_at_ms = ?1 WHERE id = ?2 AND state IN ('paused','failed')",
                    params![now_ms() as i64, id],
                )
                .map_err(|error| format!("恢复模型下载任务失败：{error}"))?;
            if changed == 0 {
                return Ok(None);
            }
            read_model_download_task(connection, id).map(Some)
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn get_model_download_task(
        &self,
        id: &str,
    ) -> Result<Option<ModelDownloadTaskRecord>, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, package_id, state, bytes_downloaded, total_bytes,
                            current_file_path, current_file_index, package_total_bytes,
                            current_source_url, source_index, error, started_at_ms,
                            completed_at_ms, created_at_ms, updated_at_ms
                     FROM model_download_tasks WHERE id = ?1",
                    [id],
                    read_model_download_task_row,
                )
                .optional()
                .map_err(|error| format!("读取模型下载任务失败：{error}"))
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn list_model_download_tasks(&self) -> Result<Vec<ModelDownloadTaskRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, package_id, state, bytes_downloaded, total_bytes,
                            current_file_path, current_file_index, package_total_bytes,
                            current_source_url, source_index, error, started_at_ms,
                            completed_at_ms, created_at_ms, updated_at_ms
                     FROM model_download_tasks ORDER BY created_at_ms ASC, id ASC",
                )
                .map_err(|error| format!("读取模型下载任务失败：{error}"))?;
            let rows = statement
                .query_map([], read_model_download_task_row)
                .map_err(|error| format!("读取模型下载任务失败：{error}"))?;
            rows.map(|row| row.map_err(|error| format!("解析模型下载任务失败：{error}")))
                .collect()
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn update_model_download_task(
        &self,
        id: &str,
        state: &str,
        bytes_downloaded: u64,
        current_file_path: Option<&str>,
        current_file_index: Option<u32>,
        current_source_url: Option<&str>,
        source_index: Option<u32>,
        error: Option<&str>,
    ) -> Result<ModelDownloadTaskRecord, String> {
        const STATES: [&str; 7] = [
            "queued",
            "downloading",
            "paused",
            "verifying",
            "completed",
            "cancelled",
            "failed",
        ];
        if !STATES.contains(&state) {
            return Err("无效的模型下载任务状态".into());
        }
        let now = now_ms() as i64;
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE model_download_tasks SET state = ?1, bytes_downloaded = ?2,
                         current_file_path = ?3, current_file_index = ?4,
                         current_source_url = ?5, source_index = ?6, error = ?7,
                         started_at_ms = CASE WHEN ?1 = 'downloading' AND started_at_ms IS NULL THEN ?8 ELSE started_at_ms END,
                         completed_at_ms = CASE WHEN ?1 IN ('completed','cancelled','failed') THEN ?8 ELSE completed_at_ms END,
                         updated_at_ms = ?8 WHERE id = ?9",
                    params![
                        state,
                        bytes_downloaded as i64,
                        current_file_path,
                        current_file_index.map(i64::from),
                        current_source_url,
                        source_index.map(i64::from),
                        error,
                        now,
                        id
                    ],
                )
                .map_err(|error| format!("更新模型下载任务失败：{error}"))?;
            read_model_download_task(connection, id)
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn set_model_package_state(
        &self,
        package_id: &str,
        state: &str,
    ) -> Result<(), String> {
        if ![
            "uninstalled",
            "queued",
            "downloading",
            "paused",
            "verifying",
            "installed",
            "missing",
            "corrupt",
            "failed",
        ]
        .contains(&state)
        {
            return Err("无效的模型包状态".into());
        }
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE model_packages SET state = ?1, updated_at_ms = ?2 WHERE package_id = ?3",
                    params![state, now_ms() as i64, package_id],
                )
                .map_err(|error| format!("更新模型包状态失败：{error}"))?;
            Ok(())
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn pause_all_model_downloads(&self) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "UPDATE model_download_tasks SET state = 'paused', updated_at_ms = ?1
             WHERE state IN ('queued','downloading','verifying')",
            [now_ms() as i64],
        );
        let _ = connection.execute(
            "UPDATE model_packages SET state = 'paused', updated_at_ms = ?1
             WHERE state IN ('queued','downloading','verifying')",
            [now_ms() as i64],
        );
    }

    #[cfg(feature = "ai")]
    pub(crate) fn update_model_package_file_progress(
        &self,
        package_id: &str,
        relative_path: &str,
        downloaded_bytes: u64,
        verification_state: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let expected: Option<i64> = connection
                .query_row(
                    "SELECT size_bytes FROM model_package_files
                     WHERE package_id = ?1 AND relative_path = ?2",
                    params![package_id, relative_path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("读取模型文件大小失败：{error}"))?;
            if expected.is_none() || downloaded_bytes > expected.unwrap_or(0) as u64 {
                return Err("模型文件下载进度超出 manifest 大小".into());
            }
            connection
                .execute(
                    "UPDATE model_package_files SET downloaded_bytes = ?1,
                         verification_state = ?2 WHERE package_id = ?3 AND relative_path = ?4",
                    params![
                        downloaded_bytes as i64,
                        verification_state,
                        package_id,
                        relative_path
                    ],
                )
                .map_err(|error| format!("更新模型文件下载进度失败：{error}"))?;
            Ok(())
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn mark_model_package_files_installed(
        &self,
        package_id: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE model_package_files
                     SET verification_state = 'verified', actual_size_bytes = size_bytes,
                         actual_sha256 = sha256, downloaded_bytes = size_bytes,
                         installed_at_ms = ?1 WHERE package_id = ?2",
                    params![now_ms() as i64, package_id],
                )
                .map_err(|error| format!("记录模型文件安装状态失败：{error}"))?;
            Ok(())
        })
    }

    #[cfg(feature = "ai")]
    pub(crate) fn update_model_package_verification(
        &self,
        package_id: &str,
        status: &ModelPackageScanStatus,
    ) -> Result<(), String> {
        let package_state = if status.state == "ready" {
            "installed"
        } else if status
            .issues
            .iter()
            .all(|issue| issue.code == "missing-file")
        {
            "missing"
        } else {
            "corrupt"
        };
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始更新模型校验状态失败：{error}"))?;
            transaction
                .execute(
                    "UPDATE model_packages SET state = ?1, updated_at_ms = ?2 WHERE package_id = ?3",
                    params![package_state, now_ms() as i64, package_id],
                )
                .map_err(|error| format!("更新模型包校验状态失败：{error}"))?;
            if status.state == "ready" {
                transaction
                    .execute(
                        "UPDATE model_package_files
                         SET verification_state = 'verified', actual_size_bytes = size_bytes,
                             actual_sha256 = sha256, downloaded_bytes = size_bytes,
                             installed_at_ms = ?2 WHERE package_id = ?1",
                        params![package_id, now_ms() as i64],
                    )
                    .map_err(|error| format!("更新模型文件校验状态失败：{error}"))?;
            } else {
                let manifest_files = status
                    .manifest
                    .as_ref()
                    .map(|manifest| manifest.files.as_slice())
                    .unwrap_or(&[]);
                for file in manifest_files {
                    let state = status
                        .issues
                        .iter()
                        .find(|issue| issue.message.contains(&file.relative_path))
                        .map(|issue| match issue.code.as_str() {
                            "missing-file" => "missing",
                            "size-mismatch" => "size-mismatch",
                            "sha256-mismatch" => "hash-mismatch",
                            "unsafe-model-path" => "invalid-path",
                            _ => "io-error",
                        })
                        .unwrap_or("io-error");
                    transaction
                        .execute(
                            "UPDATE model_package_files SET verification_state = ?1,
                             actual_size_bytes = NULL, actual_sha256 = NULL,
                             downloaded_bytes = 0, installed_at_ms = NULL
                             WHERE package_id = ?2 AND relative_path = ?3",
                            params![state, package_id, file.relative_path],
                        )
                        .map_err(|error| format!("更新模型文件校验状态失败：{error}"))?;
                }
            }
            transaction
                .commit()
                .map_err(|error| format!("提交模型校验状态失败：{error}"))
        })
    }

    pub(crate) fn list_index_status(&self) -> Result<Vec<AiIndexStatus>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT b.content_hash, b.parser_version, b.normalizer_version,
                            b.chunker_version, COUNT(c.chunk_id), b.updated_at_ms
                     FROM books b LEFT JOIN chunks c ON c.content_hash = b.content_hash
                     GROUP BY b.content_hash, b.parser_version, b.normalizer_version,
                              b.chunker_version, b.updated_at_ms
                     ORDER BY b.content_hash",
                )
                .map_err(|error| format!("准备 AI 索引状态查询失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(AiIndexStatus {
                        content_hash: row.get(0)?,
                        parser_version: row.get(1)?,
                        normalizer_version: row.get(2)?,
                        chunker_version: row.get(3)?,
                        chunk_count: row.get::<_, i64>(4)?.max(0) as u64,
                        updated_at: row.get::<_, i64>(5)?.max(0) as u64,
                    })
                })
                .map_err(|error| format!("读取 AI 索引状态失败：{error}"))?;
            rows.map(|row| row.map_err(|error| format!("解析 AI 索引状态失败：{error}")))
                .collect()
        })
    }

    pub(crate) fn list_cache_statuses(&self) -> Result<Vec<AiCacheStatus>, String> {
        Ok(vec![self.full_text_index_cache_status()?])
    }

    pub(crate) fn clear_cache(&self, kind: &str) -> Result<(), String> {
        match kind.trim() {
            FULL_TEXT_INDEX_CACHE_KIND => self.clear_all_indexes(),
            _ => Err(format!("不支持清理 AI 缓存类型：{kind}")),
        }
    }

    fn full_text_index_cache_status(&self) -> Result<AiCacheStatus, String> {
        let (item_count, updated_at, state) = self.with_connection(|connection| {
            let item_count = count(connection, "books")?;
            let active_stages = connection
                .query_row(
                    "SELECT COUNT(*) FROM index_staging",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("读取 AI 全文索引 staging 数量失败：{error}"))?
                .max(0) as u64;
            let latest_task: Option<(String, String)> = connection
                .query_row(
                    "SELECT state, kind FROM jobs WHERE kind = 'library-text-index' ORDER BY updated_at_ms DESC, id DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("读取 AI 全文索引任务状态失败：{error}"))?;
            let updated_at = connection
                .query_row(
                    "SELECT MAX(updated_at_ms) FROM (
                       SELECT updated_at_ms FROM books
                       UNION ALL SELECT updated_at_ms FROM index_staging
                       UNION ALL SELECT updated_at_ms FROM jobs WHERE kind = 'library-text-index'
                     )",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .map_err(|error| format!("读取 AI 全文索引更新时间失败：{error}"))?
                .map(|value| value.max(0) as u64);
            let state = if active_stages > 0 {
                "building"
            } else if matches!(latest_task.as_ref().map(|(state, _)| state.as_str()), Some("failed")) {
                "error"
            } else if item_count == 0 {
                "empty"
            } else if matches!(latest_task.as_ref().map(|(state, _)| state.as_str()), Some("cancelled")) {
                "partial"
            } else {
                "ready"
            };
            Ok((item_count, updated_at, state.to_string()))
        })?;
        let size_bytes = std::fs::metadata(self.root.join(DATABASE_NAME))
            .ok()
            .map(|metadata| metadata.len());
        Ok(AiCacheStatus {
            kind: FULL_TEXT_INDEX_CACHE_KIND.into(),
            display_name: "全文索引".into(),
            item_count,
            size_bytes,
            updated_at: updated_at.unwrap_or(0),
            state,
        })
    }

    pub(crate) fn delete_book_derived_data(&self, content_hash: &str) -> Result<(), String> {
        self.delete_books_derived_data(&[content_hash.to_string()])
    }

    pub(crate) fn delete_books_derived_data(
        &self,
        content_hashes: &[String],
    ) -> Result<(), String> {
        let hashes = content_hashes
            .iter()
            .map(|hash| normalize_content_hash(hash))
            .collect::<Result<Vec<_>, _>>()?;
        if hashes.is_empty() {
            return Ok(());
        }
        self.with_connection(|connection| {
            let transaction = connection.unchecked_transaction()
                .map_err(|error| format!("开始书籍清理事务失败：{error}"))?;
            // FTS5's content_hash is UNINDEXED. Scan it once for the entire
            // selection, using a temporary key set without SQLite's bind limit.
            // This also works for old indexes whose rowids differ from chunks.
            transaction.execute_batch("CREATE TEMP TABLE reader_delete_books(content_hash TEXT PRIMARY KEY);")
                .map_err(|error| format!("创建书籍清理集合失败：{error}"))?;
            {
                let mut insert = transaction.prepare("INSERT OR IGNORE INTO reader_delete_books VALUES (?1)")
                    .map_err(|error| format!("准备书籍清理集合失败：{error}"))?;
                for hash in &hashes {
                    insert.execute([hash]).map_err(|error| format!("写入书籍清理集合失败：{error}"))?;
                }
            }
            let all_books_selected: bool = transaction.query_row(
                "SELECT NOT EXISTS (SELECT 1 FROM books WHERE content_hash NOT IN (SELECT content_hash FROM reader_delete_books))",
                [], |row| row.get(0),
            ).map_err(|error| format!("检查剩余索引书籍失败：{error}"))?;
            // Deleting the last indexed book need not tokenize every removed
            // paragraph again. Recreate the identical FTS schema in this same
            // transaction, after checking even orphan FTS rows are selected.
            let reset_fts = all_books_selected && transaction.query_row(
                "SELECT NOT EXISTS (SELECT 1 FROM chunk_fts WHERE content_hash IS NULL OR content_hash NOT IN (SELECT content_hash FROM reader_delete_books))",
                [], |row| row.get::<_, bool>(0),
            ).map_err(|error| format!("检查剩余全文索引失败：{error}"))?;
            if reset_fts {
                transaction.execute_batch(&format!("DROP TABLE chunk_fts; {CHUNK_FTS_SCHEMA}"))
                    .map_err(|error| format!("清空全文索引失败：{error}"))?;
            } else {
                transaction.execute(
                    "DELETE FROM chunk_fts WHERE content_hash IN (SELECT content_hash FROM reader_delete_books)", [],
                ).map_err(|error| format!("删除全文索引失败：{error}"))?;
            }
            for table in ["chunks", "index_staging", "jobs", "books"] {
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE content_hash IN (SELECT content_hash FROM reader_delete_books)"), [],
                ).map_err(|error| format!("删除书籍派生数据 {table} 失败：{error}"))?;
            }
            for table in ["rag_prep_staging", "rag_prep_jobs", "rag_prep_chunks", "rag_prep_indexes"] {
                let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |r| r.get(0)).map_err(|e| e.to_string())?;
                if exists { transaction.execute(&format!("DELETE FROM {table} WHERE book IN (SELECT content_hash FROM reader_delete_books)"), []).map_err(|e| e.to_string())?; }
            }
            transaction.execute_batch("DROP TABLE reader_delete_books;")
                .map_err(|error| format!("清理书籍临时集合失败：{error}"))?;
            transaction.commit().map_err(|error| format!("提交书籍清理事务失败：{error}"))
        })
    }

    pub(crate) fn clear_all_derived_data(&self) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始 AI 全量清理事务失败：{error}"))?;
            #[cfg(feature = "ai")]
            let mut tables = vec![
                "chunk_fts",
                "index_staging_chunks",
                "index_staging",
                "chunks",
                "jobs",
                "books",
            ];
            #[cfg(not(feature = "ai"))]
            let tables = vec![
                "chunk_fts",
                "index_staging_chunks",
                "index_staging",
                "chunks",
                "jobs",
                "books",
            ];
            #[cfg(feature = "ai")]
            tables.push("provider_models");
            for table in tables {
                transaction
                    .execute(&format!("DELETE FROM {table}"), [])
                    .map_err(|error| format!("清理 AI {table} 失败：{error}"))?;
            }
            for table in [
                "rag_prep_staging",
                "rag_prep_jobs",
                "rag_prep_chunks",
                "rag_prep_indexes",
            ] {
                let exists: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                        [table],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if exists {
                    transaction
                        .execute(&format!("DELETE FROM {table}"), [])
                        .map_err(|e| e.to_string())?;
                }
            }
            transaction
                .commit()
                .map_err(|error| format!("提交 AI 全量清理事务失败：{error}"))
        })
    }

    pub(crate) fn clear_all_indexes(&self) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始 AI 全文索引清理事务失败：{error}"))?;
            for table in [
                "index_staging_chunks",
                "index_staging",
                "chunk_fts",
                "chunks",
                "books",
            ] {
                transaction
                    .execute(&format!("DELETE FROM {table}"), [])
                    .map_err(|error| format!("清理 AI 全文索引 {table} 失败：{error}"))?;
            }
            transaction
                .execute("DELETE FROM jobs WHERE kind = 'library-text-index'", [])
                .map_err(|error| format!("清理 AI 全文索引任务失败：{error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("提交 AI 全文索引清理事务失败：{error}"))
        })
    }

    pub(crate) fn replace_book_index(&self, input: AiIndexBookInput) -> Result<u64, String> {
        let input = validate_index_book(input)?;
        let now = now_ms() as i64;
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始 AI 建库事务失败：{error}"))?;
            transaction
                .execute(
                    "INSERT INTO books (content_hash, title, creator, language, parser_version, normalizer_version, chunker_version, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                     ON CONFLICT(content_hash) DO UPDATE SET title=excluded.title, creator=excluded.creator,
                     language=excluded.language, parser_version=excluded.parser_version,
                     normalizer_version=excluded.normalizer_version, chunker_version=excluded.chunker_version,
                     updated_at_ms=excluded.updated_at_ms",
                    params![
                        input.content_hash,
                        input.title,
                        input.creator,
                        input.language,
                        input.parser_version,
                        input.normalizer_version,
                        input.chunker_version,
                        now
                    ],
                )
                .map_err(|error| format!("写入 AI 书籍元数据失败：{error}"))?;
            transaction
                .execute("DELETE FROM chunk_fts WHERE content_hash = ?1", [&input.content_hash])
                .map_err(|error| format!("替换 AI 全文索引失败：{error}"))?;
            transaction
                .execute("DELETE FROM chunks WHERE content_hash = ?1", [&input.content_hash])
                .map_err(|error| format!("替换 AI 正文块失败：{error}"))?;

            for chunk in &input.chunks {
                transaction
                    .execute(
                        "INSERT INTO chunks (content_hash, chunk_id, spine_index, chapter_path, chapter_title, content_type, original_text, normalized_text, anchor_json)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            input.content_hash,
                            chunk.chunk_id,
                            chunk.spine_index,
                            chunk.chapter_path,
                            chunk.chapter_title,
                            chunk.content_type,
                            chunk.original_text,
                            chunk.normalized_text,
                            chunk.anchor_json
                        ],
                    )
                    .map_err(|error| format!("写入 AI 正文块失败：{error}"))?;
                transaction
                    .execute(
                        "INSERT INTO chunk_fts (normalized_text, content_hash, chunk_id) VALUES (?1, ?2, ?3)",
                        params![chunk.normalized_text, input.content_hash, chunk.chunk_id],
                    )
                    .map_err(|error| format!("写入 AI 全文索引失败：{error}"))?;
            }
            transaction
                .commit()
                .map_err(|error| format!("提交 AI 建库事务失败：{error}"))?;
            Ok(input.chunks.len() as u64)
        })
    }

    pub(crate) fn begin_index_stage(
        &self,
        input: AiIndexStageBeginInput,
    ) -> Result<String, String> {
        let input = validate_stage_begin(input)?;
        let now = now_ms() as i64;
        let staging_id = format!(
            "stage_{now}_{}",
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始 AI staging 事务失败：{error}"))?;
            // A new build for a book supersedes an abandoned build for that book.
            transaction
                .execute(
                    "DELETE FROM index_staging WHERE content_hash = ?1",
                    [&input.content_hash],
                )
                .map_err(|error| format!("清理旧 AI staging 失败：{error}"))?;
            transaction
                .execute(
                    "INSERT INTO index_staging
                       (staging_id, content_hash, title, creator, language, parser_version,
                        normalizer_version, chunker_version, expected_chunks, chunk_count,
                        total_bytes, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, ?10)",
                    params![
                        staging_id,
                        input.content_hash,
                        input.title,
                        input.creator,
                        input.language,
                        input.parser_version,
                        input.normalizer_version,
                        input.chunker_version,
                        input.expected_chunks.map(i64::from),
                        now
                    ],
                )
                .map_err(|error| format!("创建 AI staging 失败：{error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("提交 AI staging 开始事务失败：{error}"))?;
            Ok(staging_id)
        })
    }

    pub(crate) fn append_index_stage(&self, input: AiIndexStageAppendInput) -> Result<u64, String> {
        validate_stage_id(&input.staging_id)?;
        let chunks = validate_stage_batch(input.chunks)?;
        let batch_bytes = chunks
            .iter()
            .map(chunk_wire_bytes)
            .try_fold(0usize, |total, bytes| total.checked_add(bytes))
            .ok_or_else(|| "AI staging 批次大小溢出".to_string())?;
        if chunks.len() > MAX_STAGE_BATCH_CHUNKS {
            return Err(format!(
                "AI staging 单批正文块数量不得超过 {MAX_STAGE_BATCH_CHUNKS}"
            ));
        }
        if batch_bytes > MAX_STAGE_BATCH_BYTES {
            return Err(format!(
                "AI staging 单批载荷不得超过 {} 字节",
                MAX_STAGE_BATCH_BYTES
            ));
        }
        if chunks.is_empty() {
            return Err("AI staging 批次不能为空".into());
        }
        let batch_count = chunks.len() as u64;
        let batch_bytes = batch_bytes as u64;
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始 AI staging 追加事务失败：{error}"))?;
            let (current_count, current_bytes): (i64, i64) = transaction
                .query_row(
                    "SELECT chunk_count, total_bytes FROM index_staging WHERE staging_id = ?1",
                    [&input.staging_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("读取 AI staging 状态失败：{error}"))?
                .ok_or_else(|| "AI staging 不存在或已结束".to_string())?;
            let next_count = u64::try_from(current_count.max(0))
                .unwrap_or(MAX_STAGE_TOTAL_CHUNKS)
                .checked_add(batch_count)
                .ok_or_else(|| "AI staging 正文块数量溢出".to_string())?;
            let next_bytes = u64::try_from(current_bytes.max(0))
                .unwrap_or(MAX_STAGE_TOTAL_BYTES)
                .checked_add(batch_bytes)
                .ok_or_else(|| "AI staging 总载荷大小溢出".to_string())?;
            if next_count > MAX_STAGE_TOTAL_CHUNKS {
                return Err(format!(
                    "AI staging 正文块数量不得超过 {MAX_STAGE_TOTAL_CHUNKS}"
                ));
            }
            if next_bytes > MAX_STAGE_TOTAL_BYTES {
                return Err(format!(
                    "AI staging 总载荷不得超过 {} 字节",
                    MAX_STAGE_TOTAL_BYTES
                ));
            }
            for chunk in &chunks {
                transaction
                    .execute(
                        "INSERT INTO index_staging_chunks
                           (staging_id, chunk_id, spine_index, chapter_path, chapter_title,
                            content_type, original_text, normalized_text, anchor_json)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            input.staging_id,
                            chunk.chunk_id,
                            chunk.spine_index,
                            chunk.chapter_path,
                            chunk.chapter_title,
                            chunk.content_type,
                            chunk.original_text,
                            chunk.normalized_text,
                            chunk.anchor_json
                        ],
                    )
                    .map_err(|error| format!("写入 AI staging 正文块失败：{error}"))?;
            }
            transaction
                .execute(
                    "UPDATE index_staging SET chunk_count = ?1, total_bytes = ?2, updated_at_ms = ?3
                     WHERE staging_id = ?4",
                    params![next_count as i64, next_bytes as i64, now_ms() as i64, input.staging_id],
                )
                .map_err(|error| format!("更新 AI staging 统计失败：{error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("提交 AI staging 追加事务失败：{error}"))?;
            Ok(batch_count)
        })
    }

    pub(crate) fn commit_index_stage(&self, staging_id: &str) -> Result<u64, String> {
        validate_stage_id(staging_id)?;
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("开始 AI staging 提交事务失败：{error}"))?;
            let stage = transaction
                .query_row(
                    "SELECT content_hash, title, creator, language, parser_version,
                            normalizer_version, chunker_version, expected_chunks, chunk_count,
                            total_bytes
                     FROM index_staging WHERE staging_id = ?1",
                    [staging_id],
                    |row| {
                        Ok(StageRecord {
                            content_hash: row.get(0)?,
                            title: row.get(1)?,
                            creator: row.get(2)?,
                            language: row.get(3)?,
                            parser_version: row.get(4)?,
                            normalizer_version: row.get(5)?,
                            chunker_version: row.get(6)?,
                            expected_chunks: row.get(7)?,
                            chunk_count: row.get(8)?,
                            total_bytes: row.get(9)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| format!("读取 AI staging 元数据失败：{error}"))?
                .ok_or_else(|| "AI staging 不存在或已结束".to_string())?;
            let actual_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM index_staging_chunks WHERE staging_id = ?1",
                    [staging_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("校验 AI staging 正文块失败：{error}"))?;
            if actual_count != stage.chunk_count {
                return Err("AI staging 正文块计数不一致".into());
            }
            if let Some(expected) = stage.expected_chunks {
                if expected != stage.chunk_count {
                    return Err(format!(
                        "AI staging 尚未收齐正文块：需要 {expected}，实际 {}",
                        stage.chunk_count
                    ));
                }
            }
            if stage.chunk_count < 0 || stage.total_bytes < 0 {
                return Err("AI staging 统计值无效".into());
            }
            transaction
                .execute(
                    "INSERT INTO books (content_hash, title, creator, language, parser_version, normalizer_version, chunker_version, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                     ON CONFLICT(content_hash) DO UPDATE SET title=excluded.title, creator=excluded.creator,
                     language=excluded.language, parser_version=excluded.parser_version,
                     normalizer_version=excluded.normalizer_version, chunker_version=excluded.chunker_version,
                     updated_at_ms=excluded.updated_at_ms",
                    params![
                        stage.content_hash,
                        stage.title,
                        stage.creator,
                        stage.language,
                        stage.parser_version,
                        stage.normalizer_version,
                        stage.chunker_version,
                        now_ms() as i64
                    ],
                )
                .map_err(|error| format!("写入 AI 书籍元数据失败：{error}"))?;
            transaction
                .execute("DELETE FROM chunk_fts WHERE content_hash = ?1", [&stage.content_hash])
                .map_err(|error| format!("替换 AI 全文索引失败：{error}"))?;
            transaction
                .execute("DELETE FROM chunks WHERE content_hash = ?1", [&stage.content_hash])
                .map_err(|error| format!("替换 AI 正文块失败：{error}"))?;
            transaction
                .execute(
                    "INSERT INTO chunks (content_hash, chunk_id, spine_index, chapter_path, chapter_title, content_type, original_text, normalized_text, anchor_json)
                     SELECT ?1, chunk_id, spine_index, chapter_path, chapter_title, content_type,
                            original_text, normalized_text, anchor_json
                     FROM index_staging_chunks WHERE staging_id = ?2",
                    params![stage.content_hash, staging_id],
                )
                .map_err(|error| format!("提交 AI 正文块失败：{error}"))?;
            transaction
                .execute(
                    "INSERT INTO chunk_fts (normalized_text, content_hash, chunk_id)
                     SELECT normalized_text, ?1, chunk_id FROM index_staging_chunks WHERE staging_id = ?2",
                    params![stage.content_hash, staging_id],
                )
                .map_err(|error| format!("提交 AI 全文索引失败：{error}"))?;
            transaction
                .execute("DELETE FROM index_staging WHERE staging_id = ?1", [staging_id])
                .map_err(|error| format!("清理已提交 AI staging 失败：{error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("提交 AI staging 事务失败：{error}"))?;
            Ok(stage.chunk_count as u64)
        })
    }

    pub(crate) fn abort_index_stage(&self, staging_id: &str) -> Result<(), String> {
        validate_stage_id(staging_id)?;
        self.with_connection(|connection| {
            connection
                .execute(
                    "DELETE FROM index_staging WHERE staging_id = ?1",
                    [staging_id],
                )
                .map_err(|error| format!("清理 AI staging 失败：{error}"))?;
            Ok(())
        })
    }

    pub(crate) fn search(&self, input: AiSearchInput) -> Result<Vec<AiSearchHit>, String> {
        let query = validate_search_query(&input.query)?;
        let limit = input.limit.unwrap_or(100).clamp(1, 200) as i64;
        let content_hash = input
            .content_hash
            .as_deref()
            .map(normalize_content_hash)
            .transpose()?;
        let content_type = input
            .content_type
            .as_deref()
            .map(|value| validate_text_field("内容类型", value, 64, false))
            .transpose()?;
        let title = input
            .title
            .as_deref()
            .map(|value| validate_text_field("书名过滤条件", value, 1024, false))
            .transpose()?;
        let creator = input
            .creator
            .as_deref()
            .map(|value| validate_text_field("作者过滤条件", value, 1024, false))
            .transpose()?;
        let chapter_path = input
            .chapter_path
            .as_deref()
            .map(|value| validate_text_field("章节过滤条件", value, 4096, false))
            .transpose()?;
        let parser_version = input
            .parser_version
            .as_deref()
            .map(|value| validate_text_field("解析器版本过滤条件", value, 128, false))
            .transpose()?;
        let normalizer_version = input
            .normalizer_version
            .as_deref()
            .map(|value| validate_text_field("规范化版本过滤条件", value, 128, false))
            .transpose()?;
        let chunker_version = input
            .chunker_version
            .as_deref()
            .map(|value| validate_text_field("分块器版本过滤条件", value, 128, false))
            .transpose()?;
        self.with_connection(|connection| {
            let mut hits = Vec::new();
            if query.chars().filter(|character| !character.is_whitespace()).count() >= 3 {
                let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
                let mut statement = connection
                    .prepare(
                        "SELECT c.content_hash, b.title, b.creator, b.language, c.chunk_id, c.spine_index,
                                c.chapter_path, c.chapter_title, c.content_type, c.original_text,
                                c.normalized_text, c.anchor_json
                         FROM chunk_fts f
                         JOIN chunks c ON c.content_hash=f.content_hash AND c.chunk_id=f.chunk_id
                         JOIN books b ON b.content_hash=c.content_hash
                         WHERE chunk_fts MATCH ?1
                           AND (?2 IS NULL OR c.content_hash=?2)
                           AND (?3 IS NULL OR c.content_type=?3)
                           AND (?4 IS NULL OR b.title=?4)
                           AND (?5 IS NULL OR b.creator=?5)
                           AND (?6 IS NULL OR c.chapter_path=?6)
                           AND (?7 IS NULL OR b.parser_version=?7)
                           AND (?8 IS NULL OR b.normalizer_version=?8)
                           AND (?9 IS NULL OR b.chunker_version=?9)
                         ORDER BY bm25(chunk_fts), c.content_hash, c.spine_index, c.chunk_id
                         LIMIT ?10",
                    )
                    .map_err(|error| format!("准备 AI 全文查询失败：{error}"))?;
                let rows = statement
                    .query_map(
                        params![fts_query, content_hash, content_type, title, creator, chapter_path,
                            parser_version, normalizer_version, chunker_version, limit],
                        read_search_hit,
                    )
                    .map_err(|error| format!("执行 AI 全文查询失败：{error}"))?;
                for row in rows {
                    hits.push(row.map_err(|error| format!("解析 AI 全文结果失败：{error}"))?);
                }
            } else {
                let mut statement = connection
                    .prepare(
                        "SELECT c.content_hash, b.title, b.creator, b.language, c.chunk_id, c.spine_index,
                                c.chapter_path, c.chapter_title, c.content_type, c.original_text,
                                c.normalized_text, c.anchor_json
                         FROM chunks c JOIN books b ON b.content_hash=c.content_hash
                         WHERE instr(c.normalized_text, ?1) > 0
                           AND (?2 IS NULL OR c.content_hash=?2)
                           AND (?3 IS NULL OR c.content_type=?3)
                           AND (?4 IS NULL OR b.title=?4)
                           AND (?5 IS NULL OR b.creator=?5)
                           AND (?6 IS NULL OR c.chapter_path=?6)
                           AND (?7 IS NULL OR b.parser_version=?7)
                           AND (?8 IS NULL OR b.normalizer_version=?8)
                           AND (?9 IS NULL OR b.chunker_version=?9)
                         ORDER BY c.content_hash, c.spine_index, c.chunk_id LIMIT ?10",
                    )
                    .map_err(|error| format!("准备 AI 短查询失败：{error}"))?;
                let rows = statement
                    .query_map(params![query, content_hash, content_type, title, creator, chapter_path,
                        parser_version, normalizer_version, chunker_version, limit], read_search_hit)
                    .map_err(|error| format!("执行 AI 短查询失败：{error}"))?;
                for row in rows {
                    hits.push(row.map_err(|error| format!("解析 AI 短查询结果失败：{error}"))?);
                }
            }
            Ok(hits)
        })
    }

    pub(crate) fn enqueue_task(
        &self,
        kind: String,
        content_hash: Option<String>,
    ) -> Result<AiJob, String> {
        let kind = validate_task_kind(&kind)?;
        let content_hash = content_hash
            .as_deref()
            .map(normalize_content_hash)
            .transpose()?;
        let now = now_ms();
        let id = format!("job_{now}_{}", JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed));
        self.with_connection(|connection| {
            if kind == LIBRARY_TEXT_INDEX_TASK_KIND {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| format!("开始创建 AI 全库任务事务失败：{error}"))?;
                if let Some(existing) = find_active_task(&transaction, &kind)? {
                    transaction
                        .commit()
                        .map_err(|error| format!("提交现有 AI 全库任务事务失败：{error}"))?;
                    return Ok(existing);
                }
                transaction
                    .execute(
                        "INSERT INTO jobs (id, kind, content_hash, state, progress, error, cancel_requested, created_at_ms, updated_at_ms)
                         VALUES (?1, ?2, ?3, 'queued', 0.0, NULL, 0, ?4, ?4)",
                        params![id, kind, content_hash, now as i64],
                    )
                    .map_err(|error| format!("创建 AI 全库任务失败：{error}"))?;
                transaction
                    .commit()
                    .map_err(|error| format!("提交创建 AI 全库任务事务失败：{error}"))?;
                return read_job(connection, &id);
            }
            connection
                .execute(
                    "INSERT INTO jobs (id, kind, content_hash, state, progress, error, cancel_requested, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, 'queued', 0.0, NULL, 0, ?4, ?4)",
                    params![id, kind, content_hash, now as i64],
                )
                .map_err(|error| format!("创建 AI 任务失败：{error}"))?;
            read_job(connection, &id)
        })
    }

    /// Atomically acquire the singleton library index task and start it.
    ///
    /// The task is persisted as running in the same immediate transaction that
    /// checks for an existing active task. This keeps duplicate callers from
    /// both observing an empty active set, including callers in separate
    /// processes sharing the SQLite database. An explicit acquire/start also
    /// resumes a paused singleton, while a plain enqueue still leaves it
    /// paused.
    pub(crate) fn acquire_library_index_task(&self) -> Result<AiJob, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("开始获取 AI 全库任务事务失败：{error}"))?;
            if let Some(existing) = find_active_task(&transaction, LIBRARY_TEXT_INDEX_TASK_KIND)? {
                let id = existing.id;
                if matches!(existing.state, TaskState::Queued | TaskState::Paused) {
                    transaction
                        .execute(
                            "UPDATE jobs SET state = 'running', updated_at_ms = ?1 WHERE id = ?2",
                            params![now_ms() as i64, &id],
                        )
                        .map_err(|error| format!("启动现有 AI 全库任务失败：{error}"))?;
                }
                transaction
                    .commit()
                    .map_err(|error| format!("提交获取 AI 全库任务事务失败：{error}"))?;
                return read_job(connection, &id);
            }

            let now = now_ms();
            let id = format!("job_{now}_{}", JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed));
            transaction
                .execute(
                    "INSERT INTO jobs (id, kind, content_hash, state, progress, error, cancel_requested, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, NULL, 'running', 0.0, NULL, 0, ?3, ?3)",
                    params![id, LIBRARY_TEXT_INDEX_TASK_KIND, now as i64],
                )
                .map_err(|error| format!("创建 AI 全库任务失败：{error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("提交创建 AI 全库任务事务失败：{error}"))?;
            read_job(connection, &id)
        })
    }

    pub(crate) fn transition_task(
        &self,
        id: &str,
        transition: TaskTransition,
    ) -> Result<AiJob, String> {
        validate_job_id(id)?;
        self.with_connection(|connection| {
            let current = read_job(connection, id)?;
            let next = next_state(current.state, &transition)?;
            let (error, cancel_requested, progress) = match &transition {
                TaskTransition::Fail(error) => (Some(error.as_str()), false, current.progress),
                TaskTransition::Cancel => (Some("任务已取消"), true, current.progress),
                TaskTransition::Complete => (None, false, 1.0),
                _ => (current.error.as_deref(), current.cancel_requested, current.progress),
            };
            connection
                .execute(
                    "UPDATE jobs SET state = ?1, progress = ?2, error = ?3, cancel_requested = ?4, updated_at_ms = ?5 WHERE id = ?6",
                    params![next.as_str(), progress, error, cancel_requested as i64, now_ms() as i64, id],
                )
                .map_err(|error| format!("更新 AI 任务状态失败：{error}"))?;
            read_job(connection, id)
        })
    }

    pub(crate) fn update_task_progress(&self, id: &str, progress: f64) -> Result<AiJob, String> {
        validate_job_id(id)?;
        if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
            return Err("任务进度必须是 0 到 1 之间的有限数值".into());
        }
        self.with_connection(|connection| {
            let current = read_job(connection, id)?;
            if !matches!(current.state, TaskState::Running | TaskState::Paused) {
                return Err("只有 running 或 paused 任务可以更新进度".into());
            }
            connection
                .execute(
                    "UPDATE jobs SET progress = ?1, updated_at_ms = ?2 WHERE id = ?3",
                    params![progress, now_ms() as i64, id],
                )
                .map_err(|error| format!("更新 AI 任务进度失败：{error}"))?;
            read_job(connection, id)
        })
    }

    pub(crate) fn list_tasks(&self) -> Result<Vec<AiJob>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, content_hash, state, progress, error, cancel_requested, created_at_ms, updated_at_ms
                     FROM jobs ORDER BY created_at_ms ASC, id ASC",
                )
                .map_err(|error| format!("读取 AI 任务失败：{error}"))?;
            let rows = statement
                .query_map([], read_job_row)
                .map_err(|error| format!("读取 AI 任务失败：{error}"))?;
            rows.map(|row| row.map_err(|error| format!("解析 AI 任务失败：{error}")))
                .collect()
        })
    }

    pub(crate) fn reclaim_active_jobs(&self) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "UPDATE jobs SET state = 'cancelled', error = '应用退出，未完成任务已回收', cancel_requested = 1, updated_at_ms = ?1
             WHERE state IN ('queued', 'running', 'paused')",
            [now_ms() as i64],
        );
    }

    /// Staging rows are disposable work state. A new process never resumes an
    /// old IPC session; the next explicit begin starts from an empty staging
    /// area and live rows remain untouched until commit.
    pub(crate) fn reclaim_staging(&self) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute("DELETE FROM index_staging", []);
    }

    #[cfg(test)]
    pub(crate) fn insert_book_for_test(&self, content_hash: &str) -> Result<(), String> {
        let hash = normalize_content_hash(content_hash)?;
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO books (content_hash, parser_version, normalizer_version, chunker_version, created_at_ms, updated_at_ms)
                     VALUES (?1, 'test-parser', 'test-normalizer', 'test-chunker', ?2, ?2)",
                    params![hash, now_ms() as i64],
                )
                .map_err(|error| format!("insert test book: {error}"))?;
            connection
                .execute(
                    "INSERT INTO chunks (content_hash, chunk_id, spine_index, chapter_path, chapter_title, content_type, original_text, normalized_text, anchor_json)
                     VALUES (?1, 'chunk-1', 0, 'chapter.xhtml', 'Chapter', 'body', 'text', 'text', '{}')",
                    [hash.as_str()],
                )
                .map_err(|error| format!("insert test chunk: {error}"))?;
            Ok(())
        })
    }

    pub(super) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "AI 数据库锁已损坏".to_string())?;
        operation(&mut connection)
    }
}

pub(crate) const FULL_TEXT_INDEX_CACHE_KIND: &str = "full-text-index";

fn migrate(connection: &Connection) -> Result<(), String> {
    let mut version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取 AI schema 版本失败：{error}"))?;
    if version > MAX_SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "AI 数据库版本 {version} 高于当前支持的版本 {MAX_SUPPORTED_SCHEMA_VERSION}"
        ));
    }
    if version == 0 {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 BEGIN;
                 CREATE TABLE IF NOT EXISTS books (
                   content_hash TEXT PRIMARY KEY CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9A-Fa-f]*'),
                   parser_version TEXT NOT NULL,
                   normalizer_version TEXT NOT NULL,
                   chunker_version TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS chunks (
                   content_hash TEXT NOT NULL REFERENCES books(content_hash) ON DELETE CASCADE,
                   chunk_id TEXT NOT NULL,
                   spine_index INTEGER NOT NULL,
                   chapter_path TEXT NOT NULL,
                   chapter_title TEXT,
                   content_type TEXT NOT NULL,
                   original_text TEXT NOT NULL,
                   normalized_text TEXT NOT NULL,
                   anchor_json TEXT NOT NULL,
                   PRIMARY KEY(content_hash, chunk_id)
                 );
                 CREATE INDEX IF NOT EXISTS chunks_by_book_spine ON chunks(content_hash, spine_index);
                 CREATE TABLE IF NOT EXISTS jobs (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   content_hash TEXT CHECK(content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9A-Fa-f]*')),
                   state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','failed','cancelled')),
                   progress REAL NOT NULL DEFAULT 0.0 CHECK(progress >= 0.0 AND progress <= 1.0),
                   error TEXT,
                   cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS jobs_by_book ON jobs(content_hash);
                 CREATE INDEX IF NOT EXISTS jobs_by_state ON jobs(state);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(|error| format!("创建 AI schema 失败：{error}"))?;
        version = 1;
    }
    // Core-created v3 databases intentionally omit provider/model tables.
    // Ensure the shared provider registry exists for every AI opening path,
    // including an upgrade from Core v3 and reopening an existing v6 DB.
    #[cfg(feature = "ai")]
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS provider_models (
               provider_id TEXT NOT NULL,
               model_id TEXT NOT NULL,
               provider_version TEXT NOT NULL,
               model_digest TEXT NOT NULL,
               model_format TEXT NOT NULL,
               dimensions INTEGER CHECK(dimensions IS NULL OR dimensions > 0),
               context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
               transport TEXT NOT NULL,
               capabilities_json TEXT NOT NULL,
               is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN (0,1)),
               updated_at_ms INTEGER NOT NULL,
               PRIMARY KEY(provider_id, model_id)
             );",
        )
        .map_err(|error| format!("创建 AI provider schema 失败：{error}"))?;
    if version == 1 {
        connection
            .execute_batch(&format!(
                "BEGIN;
                 ALTER TABLE books ADD COLUMN title TEXT NOT NULL DEFAULT '';
                 ALTER TABLE books ADD COLUMN creator TEXT NOT NULL DEFAULT '';
                 ALTER TABLE books ADD COLUMN language TEXT;
                 {CHUNK_FTS_SCHEMA}
                 INSERT INTO chunk_fts (normalized_text, content_hash, chunk_id)
                   SELECT normalized_text, content_hash, chunk_id FROM chunks;
                 PRAGMA user_version = 2;
                 COMMIT;",
            ))
            .map_err(|error| format!("升级 AI schema v2 失败：{error}"))?;
        version = 2;
    }
    if version == 2 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS index_staging (
                   staging_id TEXT PRIMARY KEY,
                   content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9A-Fa-f]*'),
                   title TEXT NOT NULL,
                   creator TEXT NOT NULL,
                   language TEXT,
                   parser_version TEXT NOT NULL,
                   normalizer_version TEXT NOT NULL,
                   chunker_version TEXT NOT NULL,
                   expected_chunks INTEGER CHECK(expected_chunks IS NULL OR (expected_chunks >= 0 AND expected_chunks <= 1000000)),
                   chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0 AND chunk_count <= 1000000),
                   total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes >= 0 AND total_bytes <= 536870912),
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS index_staging_by_book ON index_staging(content_hash);
                 CREATE TABLE IF NOT EXISTS index_staging_chunks (
                   staging_id TEXT NOT NULL REFERENCES index_staging(staging_id) ON DELETE CASCADE,
                   chunk_id TEXT NOT NULL,
                   spine_index INTEGER NOT NULL,
                   chapter_path TEXT NOT NULL,
                   chapter_title TEXT,
                   content_type TEXT NOT NULL,
                   original_text TEXT NOT NULL,
                   normalized_text TEXT NOT NULL,
                   anchor_json TEXT NOT NULL,
                   PRIMARY KEY(staging_id, chunk_id)
                 );
                 CREATE INDEX IF NOT EXISTS index_staging_chunks_by_session
                   ON index_staging_chunks(staging_id, spine_index);
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(|error| format!("升级 AI schema v3 失败：{error}"))?;
        #[cfg(feature = "ai")]
        {
            version = 3;
        }
    }
    #[cfg(feature = "ai")]
    if version == 3 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS model_library_config (
                   id INTEGER PRIMARY KEY CHECK(id = 1),
                   root_path TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS model_packages (
                   package_id TEXT PRIMARY KEY,
                   model_id TEXT NOT NULL,
                   version TEXT NOT NULL,
                   display_name TEXT NOT NULL,
                   format TEXT NOT NULL,
                   dimensions INTEGER CHECK(dimensions IS NULL OR dimensions > 0),
                   max_input INTEGER CHECK(max_input IS NULL OR max_input > 0),
                   recommended_batch INTEGER CHECK(recommended_batch IS NULL OR recommended_batch > 0),
                   min_memory_bytes INTEGER CHECK(min_memory_bytes IS NULL OR min_memory_bytes > 0),
                   recommended_memory_bytes INTEGER CHECK(recommended_memory_bytes IS NULL OR recommended_memory_bytes > 0),
                   platform TEXT,
                   arch TEXT,
                   license TEXT NOT NULL,
                   original_source TEXT NOT NULL,
                   homepage TEXT,
                   requires_acceptance INTEGER NOT NULL DEFAULT 0 CHECK(requires_acceptance IN (0,1)),
                   provider_kind TEXT,
                   package_dir TEXT NOT NULL,
                   state TEXT NOT NULL CHECK(state IN ('uninstalled','queued','downloading','paused','verifying','installed','missing','corrupt','failed')),
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS model_package_capabilities (
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   capability TEXT NOT NULL,
                   PRIMARY KEY(package_id, capability)
                 );
                 CREATE TABLE IF NOT EXISTS model_package_files (
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   relative_path TEXT NOT NULL,
                   size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
                   sha256 TEXT NOT NULL,
                   purpose TEXT NOT NULL,
                   verification_state TEXT NOT NULL CHECK(verification_state IN ('pending','verified','missing','size-mismatch','hash-mismatch','invalid-path','io-error')),
                   actual_size_bytes INTEGER,
                   actual_sha256 TEXT,
                   PRIMARY KEY(package_id, relative_path)
                 );
                 CREATE TABLE IF NOT EXISTS model_sources (
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   url TEXT NOT NULL,
                   kind TEXT,
                   priority INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(package_id, url)
                 );
                 CREATE TABLE IF NOT EXISTS model_download_tasks (
                   id TEXT PRIMARY KEY,
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   state TEXT NOT NULL CHECK(state IN ('uninstalled','queued','downloading','paused','verifying','installed','missing','corrupt','failed')),
                   bytes_downloaded INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded >= 0),
                   total_bytes INTEGER,
                   error TEXT,
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS model_download_tasks_by_package ON model_download_tasks(package_id);
                 CREATE TABLE IF NOT EXISTS model_license_acceptance (
                   package_id TEXT PRIMARY KEY REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   license TEXT NOT NULL,
                   accepted_at_ms INTEGER NOT NULL
                 );
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(|error| format!("升级 AI schema v4 失败：{error}"))?;
        version = 4;
    }
    #[cfg(feature = "ai")]
    if version == 4 {
        connection
            .execute_batch(
                "BEGIN;
                 ALTER TABLE model_packages ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'managed'
                   CHECK(storage_kind IN ('managed','linked'));
                 ALTER TABLE model_package_files ADD COLUMN downloaded_bytes INTEGER NOT NULL DEFAULT 0
                   CHECK(downloaded_bytes >= 0);
                 ALTER TABLE model_package_files ADD COLUMN installed_at_ms INTEGER;
                 ALTER TABLE model_download_tasks RENAME TO model_download_tasks_v4;
                 CREATE TABLE model_download_tasks (
                   id TEXT PRIMARY KEY,
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   state TEXT NOT NULL CHECK(state IN ('queued','downloading','paused','verifying','completed','cancelled','failed')),
                   bytes_downloaded INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded >= 0),
                   total_bytes INTEGER,
                   current_file_path TEXT,
                   current_file_index INTEGER,
                   package_total_bytes INTEGER,
                   current_source_url TEXT,
                   source_index INTEGER,
                   error TEXT,
                   started_at_ms INTEGER,
                   completed_at_ms INTEGER,
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 INSERT INTO model_download_tasks
                   (id, package_id, state, bytes_downloaded, total_bytes, error,
                    created_at_ms, updated_at_ms)
                 SELECT id, package_id,
                   CASE state
                     WHEN 'installed' THEN 'completed'
                     WHEN 'uninstalled' THEN 'failed'
                     WHEN 'missing' THEN 'failed'
                     WHEN 'corrupt' THEN 'failed'
                     WHEN 'downloading' THEN 'paused'
                     WHEN 'verifying' THEN 'paused'
                     WHEN 'paused' THEN 'paused'
                     WHEN 'queued' THEN 'paused'
                     ELSE 'failed'
                   END,
                   bytes_downloaded, total_bytes, error, created_at_ms, updated_at_ms
                 FROM model_download_tasks_v4;
                 DROP TABLE model_download_tasks_v4;
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(|error| format!("升级 AI schema v5 失败：{error}"))?;
        version = 5;
    }
    #[cfg(feature = "ai")]
    if version == 5 {
        connection
            .execute_batch(
                "BEGIN;
                 ALTER TABLE model_packages ADD COLUMN linked_external_path TEXT;
                 PRAGMA user_version = 6;
                 COMMIT;",
            )
            .map_err(|error| format!("升级 AI schema v6 失败：{error}"))?;
    }
    Ok(())
}

fn validate_index_book(mut input: AiIndexBookInput) -> Result<AiIndexBookInput, String> {
    input.content_hash = normalize_content_hash(&input.content_hash)?;
    input.title = validate_text_field("书名", &input.title, 1024, true)?;
    input.creator = validate_text_field("作者", &input.creator, 1024, true)?;
    input.language = normalize_optional_text_field("语言", input.language.as_deref(), 128)?;
    input.parser_version = validate_text_field("解析器版本", &input.parser_version, 128, false)?;
    input.normalizer_version =
        validate_text_field("标准化器版本", &input.normalizer_version, 128, false)?;
    input.chunker_version = validate_text_field("切块器版本", &input.chunker_version, 128, false)?;
    if input.chunks.len() > 1_000_000 {
        return Err("单书正文块数量超过安全上限".into());
    }
    for chunk in &mut input.chunks {
        chunk.chunk_id = validate_text_field("正文块 ID", &chunk.chunk_id, 256, false)?;
        chunk.chapter_path = validate_text_field("章节路径", &chunk.chapter_path, 4096, false)?;
        chunk.chapter_title = chunk
            .chapter_title
            .as_deref()
            .map(|value| validate_text_field("章节标题", value, 4096, true))
            .transpose()?;
        chunk.content_type = validate_text_field("内容类型", &chunk.content_type, 64, false)?;
        chunk.original_text = validate_chunk_text("正文", &chunk.original_text, 1_000_000)?;
        chunk.normalized_text =
            validate_chunk_text("标准化正文", &chunk.normalized_text, 1_000_000)?;
        chunk.anchor_json = validate_text_field("文本锚点", &chunk.anchor_json, 65_536, false)?;
        serde_json::from_str::<serde_json::Value>(&chunk.anchor_json)
            .map_err(|error| format!("文本锚点不是有效 JSON：{error}"))?;
    }
    Ok(input)
}

#[derive(Debug)]
struct StageRecord {
    content_hash: String,
    title: String,
    creator: String,
    language: Option<String>,
    parser_version: String,
    normalizer_version: String,
    chunker_version: String,
    expected_chunks: Option<i64>,
    chunk_count: i64,
    total_bytes: i64,
}

fn validate_stage_begin(
    mut input: AiIndexStageBeginInput,
) -> Result<AiIndexStageBeginInput, String> {
    input.content_hash = normalize_content_hash(&input.content_hash)?;
    input.title = validate_text_field("书名", &input.title, 1024, true)?;
    input.creator = validate_text_field("作者", &input.creator, 1024, true)?;
    input.language = normalize_optional_text_field("语言", input.language.as_deref(), 128)?;
    input.parser_version = validate_text_field("解析器版本", &input.parser_version, 128, false)?;
    input.normalizer_version =
        validate_text_field("标准化器版本", &input.normalizer_version, 128, false)?;
    input.chunker_version = validate_text_field("切块器版本", &input.chunker_version, 128, false)?;
    if input
        .expected_chunks
        .is_some_and(|count| u64::from(count) > MAX_STAGE_TOTAL_CHUNKS)
    {
        return Err(format!(
            "AI staging 预期正文块数量不得超过 {MAX_STAGE_TOTAL_CHUNKS}"
        ));
    }
    Ok(input)
}

fn validate_stage_batch(
    mut chunks: Vec<AiIndexChunkInput>,
) -> Result<Vec<AiIndexChunkInput>, String> {
    if chunks.len() > MAX_STAGE_BATCH_CHUNKS {
        return Err(format!(
            "AI staging 单批正文块数量不得超过 {MAX_STAGE_BATCH_CHUNKS}"
        ));
    }
    let mut ids = HashSet::with_capacity(chunks.len());
    for chunk in &mut chunks {
        validate_index_chunk(chunk)?;
        if !ids.insert(chunk.chunk_id.as_str()) {
            return Err("AI staging 单批包含重复正文块 ID".into());
        }
        if chunk_wire_bytes(chunk) > MAX_STAGE_CHUNK_BYTES {
            return Err(format!(
                "AI staging 单个正文块载荷不得超过 {} 字节",
                MAX_STAGE_CHUNK_BYTES
            ));
        }
    }
    Ok(chunks)
}

fn validate_index_chunk(chunk: &mut AiIndexChunkInput) -> Result<(), String> {
    chunk.chunk_id = validate_text_field("正文块 ID", &chunk.chunk_id, 256, false)?;
    chunk.chapter_path = validate_text_field("章节路径", &chunk.chapter_path, 4096, false)?;
    chunk.chapter_title = chunk
        .chapter_title
        .as_deref()
        .map(|value| validate_text_field("章节标题", value, 4096, true))
        .transpose()?;
    chunk.content_type = validate_text_field("内容类型", &chunk.content_type, 64, false)?;
    chunk.original_text = validate_chunk_text("正文", &chunk.original_text, 1_000_000)?;
    chunk.normalized_text = validate_chunk_text("标准化正文", &chunk.normalized_text, 1_000_000)?;
    chunk.anchor_json = validate_text_field("文本锚点", &chunk.anchor_json, 65_536, false)?;
    serde_json::from_str::<serde_json::Value>(&chunk.anchor_json)
        .map_err(|error| format!("文本锚点不是有效 JSON：{error}"))?;
    Ok(())
}

fn chunk_wire_bytes(chunk: &AiIndexChunkInput) -> usize {
    chunk
        .chunk_id
        .len()
        .saturating_add(std::mem::size_of_val(&chunk.spine_index))
        .saturating_add(chunk.chapter_path.len())
        .saturating_add(chunk.chapter_title.as_deref().map_or(0, str::len))
        .saturating_add(chunk.content_type.len())
        .saturating_add(chunk.original_text.len())
        .saturating_add(chunk.normalized_text.len())
        .saturating_add(chunk.anchor_json.len())
}

fn validate_stage_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("无效的 AI staging ID".into());
    }
    Ok(())
}

fn validate_search_query(query: &str) -> Result<String, String> {
    validate_text_field("搜索词", query.trim(), 512, false)
}

fn validate_text_field(
    name: &str,
    value: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<String, String> {
    let value = value.trim();
    if (!allow_empty && value.is_empty())
        || value.chars().count() > max_chars
        || value.chars().any(char::is_control)
    {
        return Err(format!("无效的{name}"));
    }
    Ok(value.to_string())
}

fn normalize_optional_text_field(
    name: &str,
    value: Option<&str>,
    max_chars: usize,
) -> Result<Option<String>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| validate_text_field(name, value, max_chars, false))
        .transpose()
}

fn validate_chunk_text(name: &str, value: &str, max_chars: usize) -> Result<String, String> {
    if value.trim().is_empty()
        || value.chars().count() > max_chars
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(format!("无效的{name}"));
    }
    Ok(value.to_string())
}

fn read_search_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiSearchHit> {
    Ok(AiSearchHit {
        content_hash: row.get(0)?,
        title: row.get(1)?,
        creator: row.get(2)?,
        language: row.get(3)?,
        chunk_id: row.get(4)?,
        spine_index: row.get::<_, i64>(5)?.max(0) as u32,
        chapter_path: row.get(6)?,
        chapter_title: row.get(7)?,
        content_type: row.get(8)?,
        original_text: row.get(9)?,
        normalized_text: row.get(10)?,
        anchor_json: row.get(11)?,
    })
}

fn count(connection: &Connection, table: &str) -> Result<u64, String> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    connection
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .map(|count| count as u64)
        .map_err(|error| format!("读取 AI {table} 数量失败：{error}"))
}

fn read_job(connection: &Connection, id: &str) -> Result<AiJob, String> {
    connection
        .query_row(
            "SELECT id, kind, content_hash, state, progress, error, cancel_requested, created_at_ms, updated_at_ms FROM jobs WHERE id = ?1",
            [id],
            read_job_row,
        )
        .optional()
        .map_err(|error| format!("读取 AI 任务失败：{error}"))?
        .ok_or_else(|| "AI 任务不存在".into())
}

fn find_active_task(connection: &Connection, kind: &str) -> Result<Option<AiJob>, String> {
    let id = connection
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = ?1 AND state IN ('queued', 'running', 'paused')
             ORDER BY created_at_ms ASC, id ASC LIMIT 1",
            [kind],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取 AI 活动任务失败：{error}"))?;
    id.map(|id| read_job(connection, &id)).transpose()
}

fn read_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiJob> {
    let state: String = row.get(3)?;
    let state = TaskState::parse(&state).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown task state: {state}"),
            )
            .into(),
        )
    })?;
    Ok(AiJob {
        id: row.get(0)?,
        kind: row.get(1)?,
        content_hash: row.get(2)?,
        state,
        progress: row.get(4)?,
        error: row.get(5)?,
        cancel_requested: row.get::<_, i64>(6)? != 0,
        created_at_ms: row.get::<_, i64>(7)?.max(0) as u64,
        updated_at_ms: row.get::<_, i64>(8)?.max(0) as u64,
    })
}

fn validate_task_kind(kind: &str) -> Result<String, String> {
    let kind = kind.trim();
    if kind.is_empty() || kind.chars().count() > 128 || !kind.chars().all(|c| !c.is_control()) {
        return Err("无效的 AI 任务类型".into());
    }
    Ok(kind.to_string())
}

fn validate_job_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("无效的 AI 任务 ID".into());
    }
    Ok(())
}

pub(crate) fn normalize_content_hash(hash: &str) -> Result<String, String> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("内容指纹必须是 64 位十六进制 SHA-256".into());
    }
    Ok(hash.to_ascii_lowercase())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(feature = "ai")]
fn normalize_model_root(path: &str) -> PathBuf {
    Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
}

#[cfg(feature = "ai")]
fn to_i64(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "模型清单数值超过 SQLite 安全范围".into())
}

#[cfg(feature = "ai")]
fn read_model_download_task_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ModelDownloadTaskRecord> {
    Ok(ModelDownloadTaskRecord {
        id: row.get(0)?,
        package_id: row.get(1)?,
        state: row.get(2)?,
        bytes_downloaded: row.get::<_, i64>(3)?.max(0) as u64,
        total_bytes: row
            .get::<_, Option<i64>>(4)?
            .map(|value| value.max(0) as u64),
        current_file_path: row.get(5)?,
        current_file_index: row
            .get::<_, Option<i64>>(6)?
            .map(|value| value.max(0) as u32),
        package_total_bytes: row
            .get::<_, Option<i64>>(7)?
            .map(|value| value.max(0) as u64),
        current_source_url: row.get(8)?,
        source_index: row
            .get::<_, Option<i64>>(9)?
            .map(|value| value.max(0) as u32),
        error: row.get(10)?,
        started_at_ms: row
            .get::<_, Option<i64>>(11)?
            .map(|value| value.max(0) as u64),
        completed_at_ms: row
            .get::<_, Option<i64>>(12)?
            .map(|value| value.max(0) as u64),
        created_at_ms: row.get::<_, i64>(13)?.max(0) as u64,
        updated_at_ms: row.get::<_, i64>(14)?.max(0) as u64,
    })
}

#[cfg(feature = "ai")]
fn read_model_download_task(
    connection: &Connection,
    id: &str,
) -> Result<ModelDownloadTaskRecord, String> {
    connection
        .query_row(
            "SELECT id, package_id, state, bytes_downloaded, total_bytes,
                    current_file_path, current_file_index, package_total_bytes,
                    current_source_url, source_index, error, started_at_ms,
                    completed_at_ms, created_at_ms, updated_at_ms
             FROM model_download_tasks WHERE id = ?1",
            [id],
            read_model_download_task_row,
        )
        .map_err(|error| format!("读取模型下载任务失败：{error}"))
}

#[cfg(feature = "ai")]
fn read_model_package(
    connection: &Connection,
    package_id: &str,
) -> Result<ModelPackageRecord, String> {
    let package = connection
        .query_row(
            "SELECT package_id, model_id, version, display_name, format, dimensions,
                    max_input, recommended_batch, min_memory_bytes, recommended_memory_bytes,
                    platform, arch, license, original_source, homepage, requires_acceptance,
                    provider_kind, package_dir, storage_kind, linked_external_path, state
             FROM model_packages WHERE package_id = ?1",
            [package_id],
            |row| {
                Ok(ModelPackageRecord {
                    package_id: row.get(0)?,
                    model_id: row.get(1)?,
                    version: row.get(2)?,
                    display_name: row.get(3)?,
                    capabilities: Vec::new(),
                    format: row.get(4)?,
                    dimensions: row
                        .get::<_, Option<i64>>(5)?
                        .map(|value| value.max(0) as u64),
                    max_input: row
                        .get::<_, Option<i64>>(6)?
                        .map(|value| value.max(0) as u64),
                    recommended_batch: row
                        .get::<_, Option<i64>>(7)?
                        .map(|value| value.max(0) as u32),
                    min_memory_bytes: row
                        .get::<_, Option<i64>>(8)?
                        .map(|value| value.max(0) as u64),
                    recommended_memory_bytes: row
                        .get::<_, Option<i64>>(9)?
                        .map(|value| value.max(0) as u64),
                    platform: row.get(10)?,
                    arch: row.get(11)?,
                    license: row.get(12)?,
                    original_source: row.get(13)?,
                    homepage: row.get(14)?,
                    requires_acceptance: row.get::<_, i64>(15)? != 0,
                    provider_kind: row.get(16)?,
                    package_dir: row.get(17)?,
                    storage_kind: row.get(18)?,
                    linked_external_path: row.get(19)?,
                    state: row.get(20)?,
                    files: Vec::new(),
                    sources: Vec::new(),
                })
            },
        )
        .map_err(|error| format!("解析模型包失败：{error}"))?;
    let mut package = package;
    package.capabilities = {
        let mut statement = connection
            .prepare(
                "SELECT capability FROM model_package_capabilities
                 WHERE package_id = ?1 ORDER BY capability",
            )
            .map_err(|error| format!("读取模型能力失败：{error}"))?;
        let rows = statement
            .query_map([package_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("读取模型能力失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析模型能力失败：{error}"))?;
        rows
    };
    package.files = connection
        .prepare(
            "SELECT relative_path, size_bytes, sha256, purpose, verification_state,
                    actual_size_bytes, actual_sha256, downloaded_bytes, installed_at_ms
             FROM model_package_files WHERE package_id = ?1 ORDER BY relative_path",
        )
        .map_err(|error| format!("读取模型文件记录失败：{error}"))?
        .query_map([package_id], |row| {
            Ok(ModelPackageFileRecord {
                relative_path: row.get(0)?,
                size_bytes: row.get::<_, i64>(1)?.max(0) as u64,
                sha256: row.get(2)?,
                purpose: row.get(3)?,
                verification_state: row.get(4)?,
                actual_size_bytes: row
                    .get::<_, Option<i64>>(5)?
                    .map(|value| value.max(0) as u64),
                actual_sha256: row.get(6)?,
                downloaded_bytes: row.get::<_, i64>(7)?.max(0) as u64,
                installed_at_ms: row
                    .get::<_, Option<i64>>(8)?
                    .map(|value| value.max(0) as u64),
            })
        })
        .map_err(|error| format!("读取模型文件记录失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析模型文件记录失败：{error}"))?;
    package.sources = connection
        .prepare("SELECT url, kind FROM model_sources WHERE package_id = ?1 ORDER BY priority, url")
        .map_err(|error| format!("读取模型来源失败：{error}"))?
        .query_map([package_id], |row| {
            Ok(ModelPackageSourceRecord {
                url: row.get(0)?,
                kind: row.get(1)?,
            })
        })
        .map_err(|error| format!("读取模型来源失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析模型来源失败：{error}"))?;
    Ok(package)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "ai")]
    use crate::ai::models::{ModelDownloadMirror, ModelManifestFile, ModelPackageManifest};
    #[cfg(feature = "ai")]
    use sha2::{Digest, Sha256};
    use std::fs;

    fn test_store() -> (AiStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "epub-reader-ai-test-{}-{}",
            std::process::id(),
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let store = AiStore::open(&root).unwrap();
        (store, root)
    }

    #[cfg(feature = "ai")]
    fn simple_model_manifest(package_id: &str, requires_acceptance: bool) -> ModelPackageManifest {
        let bytes = b"weights";
        ModelPackageManifest {
            schema_version: 1,
            package_id: package_id.into(),
            model_id: format!("{package_id}-model"),
            version: "1".into(),
            display_name: package_id.into(),
            capabilities: vec!["generation".into()],
            format: "gguf".into(),
            files: vec![ModelManifestFile {
                relative_path: "weights.gguf".into(),
                size_bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
                purpose: "weights".into(),
            }],
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
            requires_acceptance,
            download_mirrors: vec![ModelDownloadMirror {
                url: "https://example.invalid/models".into(),
                kind: None,
            }],
            provider_kind: None,
        }
    }

    #[cfg(feature = "ai")]
    fn task_staging(root: &Path, package_id: &str, task_id: &str) -> PathBuf {
        root.join(".staging")
            .join(format!("{package_id}-{task_id}"))
    }

    #[test]
    fn migration_creates_independent_schema() {
        let (store, root) = test_store();
        let status = store.status().unwrap();
        assert_eq!(status.root_name, "ai");
        assert_eq!(status.database_name, "ai.sqlite3");
        assert_eq!(status.schema_version, SCHEMA_VERSION);
        assert!(root.join("ai/ai.sqlite3").is_file());
        let book_columns = store
            .with_connection(|connection| table_columns(connection, "books"))
            .unwrap();
        assert!(book_columns.contains(&"normalizer_version".to_string()));
        for required in ["title", "creator", "language"] {
            assert!(book_columns.contains(&required.to_string()));
        }
        let fts_columns = store
            .with_connection(|connection| table_columns(connection, "chunk_fts"))
            .unwrap();
        assert!(fts_columns.contains(&"normalized_text".to_string()));
        #[cfg(feature = "ai")]
        let model_columns = store
            .with_connection(|connection| table_columns(connection, "provider_models"))
            .unwrap();
        #[cfg(feature = "ai")]
        for required in [
            "model_digest",
            "model_format",
            "dimensions",
            "context_window",
            "transport",
        ] {
            assert!(model_columns.contains(&required.to_string()));
        }
        #[cfg(feature = "ai")]
        for table in [
            "model_library_config",
            "model_packages",
            "model_package_capabilities",
            "model_package_files",
            "model_sources",
            "model_download_tasks",
            "model_license_acceptance",
        ] {
            assert!(
                store
                    .with_connection(|connection| table_columns(connection, table))
                    .is_ok(),
                "missing model table {table}"
            );
        }
        #[cfg(feature = "ai")]
        let package_columns = store
            .with_connection(|connection| table_columns(connection, "model_packages"))
            .unwrap();
        #[cfg(feature = "ai")]
        assert!(package_columns.contains(&"storage_kind".to_string()));
        #[cfg(feature = "ai")]
        let file_columns = store
            .with_connection(|connection| table_columns(connection, "model_package_files"))
            .unwrap();
        #[cfg(feature = "ai")]
        assert!(file_columns.contains(&"downloaded_bytes".to_string()));
        #[cfg(feature = "ai")]
        assert!(file_columns.contains(&"installed_at_ms".to_string()));
        #[cfg(feature = "ai")]
        let task_columns = store
            .with_connection(|connection| table_columns(connection, "model_download_tasks"))
            .unwrap();
        #[cfg(feature = "ai")]
        for required in [
            "current_file_path",
            "current_file_index",
            "package_total_bytes",
            "current_source_url",
            "source_index",
            "started_at_ms",
            "completed_at_ms",
        ] {
            assert!(task_columns.contains(&required.to_string()));
        }
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn ai_upgrade_from_core_v3_creates_provider_and_model_schema() {
        let root = std::env::temp_dir().join(format!(
            "epub-reader-ai-core-v3-upgrade-{}-{}",
            std::process::id(),
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("ai")).unwrap();
        let connection = Connection::open(AiStore::database_path(&root)).unwrap();
        // This is the schema produced by a Core (--no-default-features)
        // build: FTS/task/index staging only, with no provider/model tables.
        connection
            .execute_batch(
                "CREATE TABLE books (
                   content_hash TEXT PRIMARY KEY, title TEXT NOT NULL,
                   creator TEXT NOT NULL, language TEXT,
                   parser_version TEXT NOT NULL, normalizer_version TEXT NOT NULL,
                   chunker_version TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE chunks (
                   content_hash TEXT NOT NULL, chunk_id TEXT NOT NULL,
                   spine_index INTEGER NOT NULL, chapter_path TEXT NOT NULL,
                   chapter_title TEXT, content_type TEXT NOT NULL,
                   original_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
                   anchor_json TEXT NOT NULL,
                   PRIMARY KEY(content_hash, chunk_id)
                 );
                 CREATE TABLE jobs (
                   id TEXT PRIMARY KEY, kind TEXT NOT NULL, content_hash TEXT,
                   state TEXT NOT NULL, progress REAL NOT NULL, error TEXT,
                   cancel_requested INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE index_staging (
                   staging_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
                   title TEXT NOT NULL, creator TEXT NOT NULL, language TEXT,
                   parser_version TEXT NOT NULL, normalizer_version TEXT NOT NULL,
                   chunker_version TEXT NOT NULL, expected_chunks INTEGER,
                   chunk_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
                   created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE index_staging_chunks (
                   staging_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
                   spine_index INTEGER NOT NULL, chapter_path TEXT NOT NULL,
                   chapter_title TEXT, content_type TEXT NOT NULL,
                   original_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
                   anchor_json TEXT NOT NULL,
                   PRIMARY KEY(staging_id, chunk_id)
                 );
                 CREATE VIRTUAL TABLE chunk_fts USING fts5(
                   normalized_text, content_hash UNINDEXED, chunk_id UNINDEXED,
                   tokenize='trigram'
                 );
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        drop(connection);

        let store = AiStore::open(&root).unwrap();
        assert_eq!(store.status().unwrap().schema_version, 6);
        assert!(store
            .with_connection(|connection| table_columns(connection, "provider_models"))
            .is_ok());
        assert!(store
            .with_connection(|connection| table_columns(connection, "model_packages"))
            .is_ok());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn linked_ownership_is_path_bound_and_remove_keeps_external_files() {
        let (store, root) = test_store();
        let managed_dir = root.join("managed-root");
        fs::create_dir_all(&managed_dir).unwrap();
        store
            .set_model_library_path(managed_dir.to_str().unwrap())
            .unwrap();
        let external = root.join("external-model");
        fs::create_dir_all(&external).unwrap();
        let manifest = simple_model_manifest("linked-owner", false);
        store
            .register_linked_model_manifest(&manifest, external.to_str().unwrap())
            .unwrap();
        let record = store.get_model_package("linked-owner").unwrap().unwrap();
        assert_eq!(record.storage_kind, "linked");
        assert_eq!(record.linked_external_path.as_deref(), external.to_str());
        assert!(store
            .register_verified_model_manifest(&manifest, "managed-owner")
            .is_err());
        let external_relocated = root.join("external-model-relocated");
        fs::create_dir_all(&external_relocated).unwrap();
        store
            .update_linked_model_path("linked-owner", external_relocated.to_str().unwrap())
            .unwrap();
        assert_eq!(
            store
                .get_model_package("linked-owner")
                .unwrap()
                .unwrap()
                .linked_external_path
                .as_deref(),
            external_relocated.to_str()
        );
        store
            .set_model_package_state("linked-owner", "uninstalled")
            .unwrap();
        let linked_task = store
            .create_or_get_model_download_task("linked-owner")
            .unwrap();
        store
            .update_model_download_task(
                &linked_task.id,
                "failed",
                0,
                None,
                None,
                None,
                None,
                Some("test failure"),
            )
            .unwrap();
        let linked_staging = task_staging(&managed_dir, "linked-owner", &linked_task.id);
        fs::create_dir_all(&linked_staging).unwrap();
        store.remove_model_package("linked-owner", true).unwrap();
        assert!(external.is_dir());
        assert!(external_relocated.is_dir());
        assert!(!linked_staging.exists());
        assert!(store.get_model_package("linked-owner").unwrap().is_none());

        let managed_package_dir = managed_dir.join("managed-owner");
        fs::create_dir_all(&managed_package_dir).unwrap();
        let managed_manifest = simple_model_manifest("managed-owner", false);
        fs::write(managed_package_dir.join("weights.gguf"), b"weights").unwrap();
        store
            .register_verified_model_manifest(&managed_manifest, "managed-owner")
            .unwrap();
        store
            .set_model_library_path(managed_dir.to_str().unwrap())
            .unwrap();
        assert_eq!(
            store
                .get_model_package("managed-owner")
                .unwrap()
                .unwrap()
                .state,
            "installed"
        );
        store
            .set_model_package_state("managed-owner", "uninstalled")
            .unwrap();
        let task = store
            .create_or_get_model_download_task("managed-owner")
            .unwrap();
        assert!(store.remove_model_package("managed-owner", true).is_err());
        store
            .update_model_download_task(&task.id, "cancelled", 0, None, None, None, None, None)
            .unwrap();
        store.remove_model_package("managed-owner", true).unwrap();
        assert!(!managed_package_dir.exists());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn managed_remove_cleans_exact_historical_task_staging_and_keeps_staging_root() {
        let (store, root) = test_store();
        let model_root = root.join("models");
        fs::create_dir_all(model_root.join(".staging")).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        let manifest = simple_model_manifest("cleanup-owner", false);
        store
            .register_catalog_model_manifest(&manifest, "cleanup-owner")
            .unwrap();

        let mut owned = Vec::new();
        for state in ["failed", "cancelled", "completed"] {
            let task = store
                .create_or_get_model_download_task("cleanup-owner")
                .unwrap();
            store
                .update_model_download_task(
                    &task.id,
                    state,
                    0,
                    None,
                    None,
                    None,
                    None,
                    Some("historical"),
                )
                .unwrap();
            let staging = task_staging(&model_root, "cleanup-owner", &task.id);
            fs::create_dir_all(&staging).unwrap();
            owned.push(staging);
        }
        // A historical task without a directory is an idempotent no-op.
        let absent_task = store
            .create_or_get_model_download_task("cleanup-owner")
            .unwrap();
        store
            .update_model_download_task(
                &absent_task.id,
                "failed",
                0,
                None,
                None,
                None,
                None,
                Some("no staging"),
            )
            .unwrap();

        let other = model_root.join(".staging/other-package-task");
        let similar = model_root.join(".staging/cleanup-owner-similar-not-a-db-task");
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&similar).unwrap();

        store.remove_model_package("cleanup-owner", false).unwrap();
        assert!(owned.iter().all(|path| !path.exists()));
        assert!(model_root.join(".staging").is_dir());
        assert!(other.is_dir());
        assert!(similar.is_dir());
        assert!(store.get_model_package("cleanup-owner").unwrap().is_none());

        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn managed_remove_rejects_active_task_without_cleaning_staging() {
        let (store, root) = test_store();
        let model_root = root.join("models");
        fs::create_dir_all(model_root.join(".staging")).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        let manifest = simple_model_manifest("active-owner", false);
        store
            .register_catalog_model_manifest(&manifest, "active-owner")
            .unwrap();
        let task = store
            .create_or_get_model_download_task("active-owner")
            .unwrap();
        let staging = task_staging(&model_root, "active-owner", &task.id);
        fs::create_dir_all(&staging).unwrap();

        assert!(store.remove_model_package("active-owner", false).is_err());
        assert!(staging.is_dir());
        assert!(store.get_model_package("active-owner").unwrap().is_some());

        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[cfg(feature = "ai")]
    #[test]
    fn managed_remove_rejects_nested_symlink_component() {
        use std::os::unix::fs::symlink;
        let (store, root) = test_store();
        let model_root = root.join("models");
        let real = root.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::create_dir_all(&model_root).unwrap();
        symlink(&real, model_root.join("nested")).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        let manifest = simple_model_manifest("nested-owner", false);
        store
            .register_verified_model_manifest(&manifest, "nested/inner")
            .unwrap();
        assert!(store.remove_model_package("nested-owner", true).is_err());
        assert!(real.is_dir());
        assert!(store.get_model_package("nested-owner").unwrap().is_some());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn linked_verify_converges_missing_and_corrupt_states() {
        let (store, root) = test_store();
        let external = root.join("linked-verify");
        fs::create_dir_all(&external).unwrap();
        let manifest = simple_model_manifest("verify-linked", false);
        fs::write(
            external.join("model.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(external.join("weights.gguf"), b"weights").unwrap();
        store
            .register_linked_model_manifest(&manifest, external.to_str().unwrap())
            .unwrap();
        fs::remove_dir_all(&external).unwrap();
        let missing = crate::ai::models::verify_linked_package(
            &store,
            &store.get_model_package("verify-linked").unwrap().unwrap(),
        )
        .unwrap();
        assert_eq!(missing.state, "missing");
        fs::create_dir_all(&external).unwrap();
        fs::write(
            external.join("model.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(external.join("weights.gguf"), b"wrong").unwrap();
        let corrupt = crate::ai::models::verify_linked_package(
            &store,
            &store.get_model_package("verify-linked").unwrap().unwrap(),
        )
        .unwrap();
        assert_eq!(corrupt.state, "corrupt");
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_upgrades_v1_rows_into_the_fts_index() {
        let root = std::env::temp_dir().join(format!(
            "epub-reader-ai-v1-test-{}-{}",
            std::process::id(),
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("ai")).unwrap();
        let connection = Connection::open(AiStore::database_path(&root)).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE books (
                   content_hash TEXT PRIMARY KEY, parser_version TEXT NOT NULL,
                   normalizer_version TEXT NOT NULL, chunker_version TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE chunks (
                   content_hash TEXT NOT NULL, chunk_id TEXT NOT NULL, spine_index INTEGER NOT NULL,
                   chapter_path TEXT NOT NULL, chapter_title TEXT, content_type TEXT NOT NULL,
                   original_text TEXT NOT NULL, normalized_text TEXT NOT NULL, anchor_json TEXT NOT NULL,
                   PRIMARY KEY(content_hash, chunk_id)
                 );
                 CREATE TABLE jobs (
                   id TEXT PRIMARY KEY, kind TEXT NOT NULL, content_hash TEXT, state TEXT NOT NULL,
                   progress REAL NOT NULL, error TEXT, cancel_requested INTEGER NOT NULL,
                   created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE provider_models (
                   provider_id TEXT NOT NULL, model_id TEXT NOT NULL, provider_version TEXT NOT NULL,
                   model_digest TEXT NOT NULL, model_format TEXT NOT NULL, dimensions INTEGER,
                   context_window INTEGER, transport TEXT NOT NULL, capabilities_json TEXT NOT NULL,
                   is_enabled INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(provider_id, model_id)
                 );
                 INSERT INTO books VALUES (
                   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                   'p1', 'n1', 'c1', 1, 1
                 );
                 INSERT INTO chunks VALUES (
                   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                   'legacy-chunk', 0, 'legacy.xhtml', '旧章节', 'body',
                   '旧库迁移全文测试', '旧库迁移全文测试', '{\"textOffset\":0}'
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        drop(connection);

        let store = AiStore::open(&root).unwrap();
        assert_eq!(store.status().unwrap().schema_version, SCHEMA_VERSION);
        let hits = store
            .search(AiSearchInput {
                query: "迁移全文".into(),
                limit: None,
                content_hash: None,
                content_type: None,
                title: None,
                creator: None,
                chapter_path: None,
                parser_version: None,
                normalizer_version: None,
                chunker_version: None,
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk_id, "legacy-chunk");
        assert_eq!(hits[0].title, "");
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    fn table_columns(connection: &mut Connection, table: &str) -> Result<Vec<String>, String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|error| format!("prepare table info: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("query table info: {error}"))?;
        rows.map(|row| row.map_err(|error| format!("read table info: {error}")))
            .collect()
    }

    #[test]
    fn deleting_one_book_removes_only_its_derived_data() {
        let (store, root) = test_store();
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        store.insert_book_for_test(&first).unwrap();
        store.insert_book_for_test(&second).unwrap();
        store
            .enqueue_task("index".into(), Some(first.clone()))
            .unwrap();
        store
            .enqueue_task("index".into(), Some(second.clone()))
            .unwrap();
        store.delete_book_derived_data(&first).unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.books, 1);
        assert_eq!(status.chunks, 1);
        assert_eq!(status.jobs, 1);
        assert_eq!(
            store.list_tasks().unwrap()[0].content_hash.as_deref(),
            Some(second.as_str())
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_deletion_cleans_fts_staging_and_jobs_but_preserves_other_books() {
        let (store, root) = test_store();
        for letter in ['a', 'b', 'c'] {
            store
                .replace_book_index(index_input(letter, "可搜索的测试正文", "body"))
                .unwrap();
            store
                .enqueue_task("index".into(), Some(letter.to_string().repeat(64)))
                .unwrap();
            let staging_id = store
                .begin_index_stage(stage_begin_input(letter, None))
                .unwrap();
            store
                .append_index_stage(AiIndexStageAppendInput {
                    staging_id,
                    chunks: vec![stage_chunk("pending", "尚未提交的正文")],
                })
                .unwrap();
        }
        // Old indexes may have different FTS and chunks rowids.
        store
            .with_connection(|connection| {
                connection
                    .execute("UPDATE chunk_fts SET rowid = rowid + 100", [])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        store
            .delete_books_derived_data(&["a".repeat(64), "b".repeat(64), "a".repeat(64)])
            .unwrap();
        store
            .with_connection(|connection| {
                for table in [
                    "books",
                    "chunks",
                    "chunk_fts",
                    "jobs",
                    "index_staging",
                    "index_staging_chunks",
                ] {
                    assert_eq!(count(connection, table)?, 1, "{table}");
                }
                let hash: String = connection
                    .query_row(
                        "SELECT content_hash FROM chunk_fts WHERE chunk_fts MATCH '测试正文'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                assert_eq!(hash, "c".repeat(64));
                Ok(())
            })
            .unwrap();
        // Reusing the same connection must not leave a temporary key set behind.
        store.delete_books_derived_data(&["c".repeat(64)]).unwrap();
        assert_eq!(store.status().unwrap().books, 0);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_deletion_validates_all_hashes_before_deleting_anything() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('a', "必须保留的正文", "body"))
            .unwrap();
        store.delete_books_derived_data(&[]).unwrap();
        assert!(store
            .delete_books_derived_data(&["a".repeat(64), "invalid".into()])
            .is_err());
        assert_eq!(store.status().unwrap().books, 1);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_last_index_keeps_schema_reusable_and_does_not_drop_orphan_fts_rows() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('a', "最后一本书的正文", "body"))
            .unwrap();
        store.with_connection(|connection| connection.execute(
            "INSERT INTO chunk_fts(normalized_text,content_hash,chunk_id) VALUES ('旧库遗留内容',?1,'orphan')",
            ["b".repeat(64)],
        ).map(|_| ()).map_err(|e| e.to_string())).unwrap();
        store.delete_book_derived_data(&"a".repeat(64)).unwrap();
        store
            .with_connection(|connection| {
                assert_eq!(count(connection, "chunk_fts")?, 1);
                Ok(())
            })
            .unwrap();
        store.delete_book_derived_data(&"b".repeat(64)).unwrap();
        store
            .replace_book_index(index_input('c', "清空以后重建索引", "body"))
            .unwrap();
        store
            .with_connection(|connection| {
                let matched: u64 = connection
                    .query_row(
                        "SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH '重建索引'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                assert_eq!(matched, 1);
                let version: u32 = connection
                    .query_row("PRAGMA user_version", [], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                assert_eq!(version, SCHEMA_VERSION);
                Ok(())
            })
            .unwrap();
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_deletion_rolls_back_fts_if_a_later_table_fails() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('a', "必须保留的正文", "body"))
            .unwrap();
        store.with_connection(|connection| connection.execute_batch(
            "CREATE TEMP TRIGGER reject_cleanup BEFORE DELETE ON chunks BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
        ).map_err(|e| e.to_string())).unwrap();
        assert!(store.delete_books_derived_data(&["a".repeat(64)]).is_err());
        store
            .with_connection(|connection| {
                assert_eq!(count(connection, "chunk_fts")?, 1);
                assert_eq!(count(connection, "books")?, 1);
                connection
                    .execute_batch("DROP TRIGGER reject_cleanup;")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        store.delete_books_derived_data(&["a".repeat(64)]).unwrap();
        assert_eq!(store.status().unwrap().books, 0);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_reclaims_active_jobs() {
        let (store, root) = test_store();
        let job = store.enqueue_task("index".into(), None).unwrap();
        store
            .transition_task(&job.id, TaskTransition::Start)
            .unwrap();
        drop(store);
        let reopened = AiStore::open(&root).unwrap();
        let jobs = reopened.list_tasks().unwrap();
        assert_eq!(jobs[0].state, TaskState::Cancelled);
        assert!(jobs[0].cancel_requested);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hash_validation_is_strict_and_canonical() {
        assert_eq!(
            normalize_content_hash(&"A".repeat(64)).unwrap(),
            "a".repeat(64)
        );
        assert!(normalize_content_hash(&"a".repeat(63)).is_err());
        assert!(normalize_content_hash(&"g".repeat(64)).is_err());
        assert!(normalize_content_hash(&format!("{}\n", "a".repeat(63))).is_err());
    }

    #[cfg(feature = "ai")]
    #[test]
    fn model_manifest_registration_is_normalized_into_related_tables() {
        let (store, root) = test_store();
        let model_root = root.join("external-models");
        let package_dir = model_root.join("default");
        fs::create_dir_all(&package_dir).unwrap();
        let bytes = b"weights";
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        fs::write(package_dir.join("weights.gguf"), bytes).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        let manifest = ModelPackageManifest {
            schema_version: 1,
            package_id: "default".into(),
            model_id: "model".into(),
            version: "1".into(),
            display_name: "Default".into(),
            capabilities: vec!["generation".into()],
            format: "gguf".into(),
            files: vec![ModelManifestFile {
                relative_path: "weights.gguf".into(),
                size_bytes: bytes.len() as u64,
                sha256,
                purpose: "weights".into(),
            }],
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "local".into(),
            homepage: None,
            requires_acceptance: false,
            download_mirrors: Vec::new(),
            provider_kind: Some("llama.cpp".into()),
        };
        store
            .register_verified_model_manifest(&manifest, "default")
            .unwrap();
        let packages = store.list_model_packages().unwrap();
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].state, "installed");
        assert_eq!(packages[0].storage_kind, "managed");
        assert_eq!(packages[0].files[0].verification_state, "verified");
        assert_eq!(packages[0].files[0].downloaded_bytes, bytes.len() as u64);
        store
            .register_catalog_model_manifest(&manifest, "default")
            .unwrap();
        let catalog = store
            .get_model_package("default")
            .unwrap()
            .expect("catalog package");
        assert_eq!(catalog.state, "uninstalled");
        assert_eq!(
            store.model_library_path().unwrap().as_deref(),
            model_root.to_str()
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn license_acceptance_expires_when_manifest_license_changes() {
        let (store, root) = test_store();
        let bytes = b"weights";
        let manifest = ModelPackageManifest {
            schema_version: 1,
            package_id: "license-change".into(),
            model_id: "license-model".into(),
            version: "1".into(),
            display_name: "License model".into(),
            capabilities: vec!["generation".into()],
            format: "gguf".into(),
            files: vec![ModelManifestFile {
                relative_path: "weights.gguf".into(),
                size_bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
                purpose: "weights".into(),
            }],
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "trusted-catalog".into(),
            homepage: None,
            requires_acceptance: true,
            download_mirrors: vec![crate::ai::models::ModelDownloadMirror {
                url: "https://example.invalid/models".into(),
                kind: Some("official".into()),
            }],
            provider_kind: None,
        };
        store
            .register_catalog_model_manifest(&manifest, "license-change")
            .unwrap();
        assert!(!store.is_model_license_accepted("license-change").unwrap());
        store.accept_model_license("license-change").unwrap();
        assert!(store.is_model_license_accepted("license-change").unwrap());
        let task = store
            .create_or_get_model_download_task("license-change")
            .unwrap();
        store
            .update_model_download_task(&task.id, "paused", 0, None, None, None, None, None)
            .unwrap();
        assert!(store.queue_model_download_task(&task.id).unwrap().is_some());
        assert!(store.queue_model_download_task(&task.id).unwrap().is_none());
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE model_packages SET license = 'MIT' WHERE package_id = 'license-change'",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        assert!(!store.is_model_license_accepted("license-change").unwrap());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn catalog_reregistration_replaces_sources_used_by_a_failed_retry() {
        let (store, root) = test_store();
        let mut manifest = simple_model_manifest("source-refresh", false);
        store
            .register_catalog_model_manifest(&manifest, "source-refresh")
            .unwrap();
        let task = store
            .create_or_get_model_download_task("source-refresh")
            .unwrap();
        store
            .update_model_download_task(
                &task.id,
                "failed",
                0,
                None,
                None,
                Some("https://example.invalid/models"),
                Some(0),
                Some("connection failed"),
            )
            .unwrap();

        manifest.download_mirrors = vec![ModelDownloadMirror {
            url: "http://localhost:5173/c57-dev-probe".into(),
            kind: Some("development-fixture".into()),
        }];
        store
            .register_catalog_model_manifest(&manifest, "source-refresh")
            .unwrap();

        let refreshed = store
            .get_model_package("source-refresh")
            .unwrap()
            .expect("refreshed catalog package");
        assert_eq!(refreshed.sources.len(), 1);
        assert_eq!(
            refreshed.sources[0].url,
            "http://localhost:5173/c57-dev-probe"
        );
        let resumed = store
            .queue_model_download_task(&task.id)
            .unwrap()
            .expect("failed task should remain resumable");
        assert_eq!(resumed.state, "queued");

        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn missing_scan_marks_managed_only_and_preserves_linked_ownership() {
        let (store, root) = test_store();
        let model_root = root.join("external-models");
        let managed_dir = model_root.join("managed");
        let linked_dir = model_root.join("linked");
        fs::create_dir_all(&managed_dir).unwrap();
        fs::create_dir_all(&linked_dir).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        let manifest = ModelPackageManifest {
            schema_version: 1,
            package_id: "managed".into(),
            model_id: "model".into(),
            version: "1".into(),
            display_name: "Managed".into(),
            capabilities: vec!["generation".into()],
            format: "gguf".into(),
            files: vec![ModelManifestFile {
                relative_path: "weights.gguf".into(),
                size_bytes: 1,
                sha256: "a".repeat(64),
                purpose: "weights".into(),
            }],
            dimensions: None,
            max_input: None,
            recommended_batch: None,
            min_memory_bytes: None,
            recommended_memory_bytes: None,
            platform: None,
            arch: None,
            license: "Apache-2.0".into(),
            original_source: "local".into(),
            homepage: None,
            requires_acceptance: false,
            download_mirrors: Vec::new(),
            provider_kind: None,
        };
        store
            .register_verified_model_manifest(&manifest, "managed")
            .unwrap();
        let linked_manifest = ModelPackageManifest {
            package_id: "linked".into(),
            model_id: "model".into(),
            display_name: "Linked".into(),
            ..manifest
        };
        store
            .register_verified_model_manifest(&linked_manifest, "linked")
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE model_packages SET storage_kind = 'linked' WHERE package_id = 'linked'",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        fs::remove_dir_all(&managed_dir).unwrap();
        fs::remove_dir_all(&linked_dir).unwrap();
        store.mark_missing_managed_packages(&model_root).unwrap();
        let packages = store.list_model_packages().unwrap();
        let managed = packages
            .iter()
            .find(|package| package.package_id == "managed")
            .unwrap();
        let linked = packages
            .iter()
            .find(|package| package.package_id == "linked")
            .unwrap();
        assert_eq!(managed.state, "missing");
        assert_eq!(linked.state, "installed");
        assert_eq!(linked.storage_kind, "linked");
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn core_compatible_cleanup_handles_optional_mock_tables_without_initializing_them() {
        let (store, root) = test_store();
        store.with_connection(|c| {
            c.execute_batch("CREATE TABLE rag_prep_staging(book TEXT); CREATE TABLE rag_prep_jobs(book TEXT);
                CREATE TABLE rag_prep_chunks(book TEXT); CREATE TABLE rag_prep_indexes(book TEXT);").map_err(|e|e.to_string())?;
            for table in ["rag_prep_staging","rag_prep_jobs","rag_prep_chunks","rag_prep_indexes"] {
                c.execute(&format!("INSERT INTO {table} VALUES (?1)"), ["a".repeat(64)]).map_err(|e|e.to_string())?;
                c.execute(&format!("INSERT INTO {table} VALUES (?1)"), ["b".repeat(64)]).map_err(|e|e.to_string())?;
            }
            Ok(())
        }).unwrap();
        store.delete_book_derived_data(&"a".repeat(64)).unwrap();
        store
            .with_connection(|c| {
                for table in [
                    "rag_prep_staging",
                    "rag_prep_jobs",
                    "rag_prep_chunks",
                    "rag_prep_indexes",
                ] {
                    assert_eq!(count(c, table)?, 1);
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(store.status().unwrap().schema_version, SCHEMA_VERSION);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clear_all_removes_rows_but_keeps_schema_database() {
        let (store, root) = test_store();
        let hash = "c".repeat(64);
        store.insert_book_for_test(&hash).unwrap();
        store.enqueue_task("index".into(), Some(hash)).unwrap();
        store.clear_all_derived_data().unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.books, 0);
        assert_eq!(status.chunks, 0);
        assert_eq!(status.jobs, 0);
        assert_eq!(status.provider_models, 0);
        assert!(root.join("ai/ai.sqlite3").is_file());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "ai")]
    #[test]
    fn clearing_text_indexes_keeps_provider_configuration() {
        let (store, root) = test_store();
        store.insert_book_for_test(&"f".repeat(64)).unwrap();
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO provider_models
                     (provider_id, model_id, provider_version, model_digest, model_format,
                      dimensions, context_window, transport, capabilities_json, is_enabled, updated_at_ms)
                     VALUES ('provider', 'model', '1', 'digest', 'onnx', 8, NULL, 'local', '[]', 1, 1)",
                    [],
                ).map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        store.clear_all_indexes().unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.books, 0);
        assert_eq!(status.chunks, 0);
        assert_eq!(status.provider_models, 1);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_text_cache_reports_metadata_and_clear_preserves_other_jobs() {
        let (store, root) = test_store();
        store.insert_book_for_test(&"e".repeat(64)).unwrap();
        store
            .enqueue_task("library-text-index".into(), None)
            .unwrap();
        store.enqueue_task("embedding".into(), None).unwrap();

        let cache = store.list_cache_statuses().unwrap();
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[0].kind, FULL_TEXT_INDEX_CACHE_KIND);
        assert_eq!(cache[0].display_name, "全文索引");
        assert_eq!(cache[0].item_count, 1);
        assert_eq!(cache[0].state, "ready");
        assert!(cache[0].size_bytes.unwrap_or_default() > 0);
        assert!(cache[0].updated_at > 0);

        store.clear_cache(FULL_TEXT_INDEX_CACHE_KIND).unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.books, 0);
        assert_eq!(status.chunks, 0);
        assert_eq!(status.jobs, 1);
        assert_eq!(store.list_cache_statuses().unwrap()[0].state, "empty");
        assert!(store.clear_cache("vector-index").is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn library_index_task_is_acquired_idempotently_and_other_kinds_are_parallel() {
        let (store, root) = test_store();
        let queued = store
            .enqueue_task(LIBRARY_TEXT_INDEX_TASK_KIND.into(), None)
            .unwrap();
        assert_eq!(queued.state, TaskState::Queued);

        let running = store.acquire_library_index_task().unwrap();
        assert_eq!(running.id, queued.id);
        assert_eq!(running.state, TaskState::Running);

        let duplicate = store.acquire_library_index_task().unwrap();
        assert_eq!(duplicate.id, running.id);
        assert_eq!(duplicate.state, TaskState::Running);
        let legacy_enqueue = store
            .enqueue_task(LIBRARY_TEXT_INDEX_TASK_KIND.into(), None)
            .unwrap();
        assert_eq!(legacy_enqueue.id, running.id);
        assert_eq!(
            store
                .list_tasks()
                .unwrap()
                .iter()
                .filter(|task| task.kind == LIBRARY_TEXT_INDEX_TASK_KIND)
                .count(),
            1
        );

        let first_other = store.enqueue_task("embedding".into(), None).unwrap();
        let second_other = store.enqueue_task("embedding".into(), None).unwrap();
        assert_ne!(first_other.id, second_other.id);

        store
            .transition_task(&running.id, TaskTransition::Pause)
            .unwrap();
        let paused_enqueue = store
            .enqueue_task(LIBRARY_TEXT_INDEX_TASK_KIND.into(), None)
            .unwrap();
        assert_eq!(paused_enqueue.id, running.id);
        assert_eq!(paused_enqueue.state, TaskState::Paused);
        let paused = store.acquire_library_index_task().unwrap();
        assert_eq!(paused.id, running.id);
        assert_eq!(paused.state, TaskState::Running);

        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progress_updates_are_bounded_and_state_limited() {
        let (store, root) = test_store();
        let job = store.enqueue_task("index".into(), None).unwrap();
        assert!(store.update_task_progress(&job.id, 0.5).is_err());
        store
            .transition_task(&job.id, TaskTransition::Start)
            .unwrap();
        let running = store.update_task_progress(&job.id, 0.5).unwrap();
        assert_eq!(running.progress, 0.5);
        store
            .transition_task(&job.id, TaskTransition::Pause)
            .unwrap();
        let paused = store.update_task_progress(&job.id, 0.75).unwrap();
        assert_eq!(paused.progress, 0.75);
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.01, 1.01] {
            assert!(store.update_task_progress(&job.id, invalid).is_err());
        }
        store
            .transition_task(&job.id, TaskTransition::Resume)
            .unwrap();
        store
            .transition_task(&job.id, TaskTransition::Complete)
            .unwrap();
        assert!(store.update_task_progress(&job.id, 0.9).is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    fn index_input(hash_char: char, text: &str, content_type: &str) -> AiIndexBookInput {
        AiIndexBookInput {
            content_hash: hash_char.to_string().repeat(64),
            title: format!("Book {hash_char}"),
            creator: "Author".into(),
            language: Some("zh-CN".into()),
            parser_version: "parser-v1".into(),
            normalizer_version: "normalizer-v1".into(),
            chunker_version: "chunker-v1".into(),
            chunks: vec![super::super::AiIndexChunkInput {
                chunk_id: format!("chunk-{hash_char}"),
                spine_index: 1,
                chapter_path: "Text/chapter.xhtml".into(),
                chapter_title: Some("第一章".into()),
                content_type: content_type.into(),
                original_text: text.into(),
                normalized_text: text.into(),
                anchor_json: r#"{"textOffset":0,"textSnippet":"测试"}"#.into(),
            }],
        }
    }

    #[test]
    fn replaces_book_index_atomically_and_searches_long_and_short_queries() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('a', "透明度属性测试", "body"))
            .unwrap();
        store
            .replace_book_index(index_input('b', "另一本书的测试内容", "copyright"))
            .unwrap();

        let long_hits = store
            .search(AiSearchInput {
                query: "透明度".into(),
                limit: None,
                content_hash: None,
                content_type: Some("body".into()),
                title: Some("Book a".into()),
                creator: Some("Author".into()),
                chapter_path: Some("Text/chapter.xhtml".into()),
                parser_version: None,
                normalizer_version: None,
                chunker_version: None,
            })
            .unwrap();
        assert_eq!(long_hits.len(), 1);
        assert_eq!(long_hits[0].content_hash, "a".repeat(64));
        assert_eq!(long_hits[0].chapter_title.as_deref(), Some("第一章"));

        let stale_version_hits = store
            .search(AiSearchInput {
                query: "透明度".into(),
                limit: None,
                content_hash: None,
                content_type: None,
                title: None,
                creator: None,
                chapter_path: None,
                parser_version: Some("parser-v2".into()),
                normalizer_version: Some("normalizer-v1".into()),
                chunker_version: Some("chunker-v1".into()),
            })
            .unwrap();
        assert!(stale_version_hits.is_empty());

        let short_hits = store
            .search(AiSearchInput {
                query: "书".into(),
                limit: Some(10),
                content_hash: Some("b".repeat(64)),
                content_type: None,
                title: None,
                creator: None,
                chapter_path: None,
                parser_version: None,
                normalizer_version: None,
                chunker_version: None,
            })
            .unwrap();
        assert_eq!(short_hits.len(), 1);
        assert_eq!(short_hits[0].content_type, "copyright");

        store
            .replace_book_index(index_input('a', "已经替换的正文", "body"))
            .unwrap();
        assert!(store
            .search(AiSearchInput {
                query: "透明度".into(),
                limit: None,
                content_hash: None,
                content_type: None,
                title: None,
                creator: None,
                chapter_path: None,
                parser_version: None,
                normalizer_version: None,
                chunker_version: None,
            })
            .unwrap()
            .is_empty());
        assert_eq!(store.status().unwrap().chunks, 2);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn index_validation_rejects_invalid_anchor_without_replacing_existing_rows() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('c', "原始正文内容", "body"))
            .unwrap();
        let mut invalid = index_input('c', "不应写入的正文", "body");
        invalid.chunks[0].anchor_json = "{".into();
        assert!(store.replace_book_index(invalid).is_err());
        let hits = store
            .search(AiSearchInput {
                query: "原始正文".into(),
                limit: None,
                content_hash: None,
                content_type: None,
                title: None,
                creator: None,
                chapter_path: None,
                parser_version: None,
                normalizer_version: None,
                chunker_version: None,
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn index_accepts_structural_line_breaks_but_rejects_unsafe_controls() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('e', "第一段\n第二段", "body"))
            .unwrap();
        let mut invalid = index_input('f', "正文", "body");
        invalid.chunks[0].original_text = "正文\0隐藏".into();
        assert!(store.replace_book_index(invalid).is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    fn stage_begin_input(hash_char: char, expected_chunks: Option<u32>) -> AiIndexStageBeginInput {
        AiIndexStageBeginInput {
            content_hash: hash_char.to_string().repeat(64),
            title: format!("Staged book {hash_char}"),
            creator: "Author".into(),
            language: Some("zh-CN".into()),
            parser_version: "parser-v2".into(),
            normalizer_version: "normalizer-v2".into(),
            chunker_version: "chunker-v2".into(),
            expected_chunks,
        }
    }

    #[test]
    fn staging_treats_blank_legacy_language_as_unknown() {
        let (store, root) = test_store();
        let mut input = stage_begin_input('9', None);
        input.language = Some("　 ".into());
        let staging_id = store.begin_index_stage(input).unwrap();
        let language = store
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT language FROM index_staging WHERE staging_id = ?1",
                        [&staging_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(language, None);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    fn stage_chunk(id: &str, text: &str) -> AiIndexChunkInput {
        AiIndexChunkInput {
            chunk_id: id.into(),
            spine_index: 1,
            chapter_path: "Text/chapter.xhtml".into(),
            chapter_title: Some("第一章".into()),
            content_type: "body".into(),
            original_text: text.into(),
            normalized_text: text.into(),
            anchor_json: r#"{"textOffset":0}"#.into(),
        }
    }

    #[test]
    fn staged_index_keeps_live_rows_until_complete_commit() {
        let (store, root) = test_store();
        store
            .replace_book_index(index_input('a', "旧的稳定正文", "body"))
            .unwrap();
        let staging_id = store
            .begin_index_stage(stage_begin_input('a', Some(2)))
            .unwrap();
        assert_eq!(
            store
                .append_index_stage(AiIndexStageAppendInput {
                    staging_id: staging_id.clone(),
                    chunks: vec![stage_chunk("new-1", "新的第一块")],
                })
                .unwrap(),
            1
        );
        assert!(store.commit_index_stage(&staging_id).is_err());
        assert_eq!(
            store
                .search(AiSearchInput {
                    query: "稳定正文".into(),
                    limit: None,
                    content_hash: None,
                    content_type: None,
                    title: None,
                    creator: None,
                    chapter_path: None,
                    parser_version: None,
                    normalizer_version: None,
                    chunker_version: None,
                })
                .unwrap()
                .len(),
            1
        );
        store
            .append_index_stage(AiIndexStageAppendInput {
                staging_id: staging_id.clone(),
                chunks: vec![stage_chunk("new-2", "新的第二块")],
            })
            .unwrap();
        assert_eq!(store.commit_index_stage(&staging_id).unwrap(), 2);
        assert!(store
            .search(AiSearchInput {
                query: "稳定正文".into(),
                limit: None,
                content_hash: None,
                content_type: None,
                title: None,
                creator: None,
                chapter_path: None,
                parser_version: None,
                normalizer_version: None,
                chunker_version: None,
            })
            .unwrap()
            .is_empty());
        assert_eq!(store.status().unwrap().chunks, 2);
        let statuses = store.list_index_status().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].content_hash, "a".repeat(64));
        assert_eq!(statuses[0].chunk_count, 2);
        assert_eq!(statuses[0].parser_version, "parser-v2");
        assert!(statuses[0].updated_at > 0);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_rejects_oversized_batches_without_partial_rows() {
        let (store, root) = test_store();
        let staging_id = store
            .begin_index_stage(stage_begin_input('b', None))
            .unwrap();
        let too_many = (0..=MAX_STAGE_BATCH_CHUNKS)
            .map(|index| stage_chunk(&format!("chunk-{index}"), "正文"))
            .collect();
        assert!(store
            .append_index_stage(AiIndexStageAppendInput {
                staging_id: staging_id.clone(),
                chunks: too_many,
            })
            .is_err());
        let too_large = stage_chunk("large", &"正文".repeat(MAX_STAGE_CHUNK_BYTES));
        assert!(store
            .append_index_stage(AiIndexStageAppendInput {
                staging_id: staging_id.clone(),
                chunks: vec![too_large],
            })
            .is_err());
        assert!(store.commit_index_stage(&staging_id).is_ok());
        assert_eq!(store.status().unwrap().chunks, 0);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn begin_reclaims_same_book_and_open_reclaims_orphaned_staging() {
        let (store, root) = test_store();
        let first = store
            .begin_index_stage(stage_begin_input('c', None))
            .unwrap();
        let second = store
            .begin_index_stage(stage_begin_input('c', None))
            .unwrap();
        assert!(store
            .append_index_stage(AiIndexStageAppendInput {
                staging_id: first,
                chunks: vec![stage_chunk("old", "旧 staging")],
            })
            .is_err());
        store
            .append_index_stage(AiIndexStageAppendInput {
                staging_id: second.clone(),
                chunks: vec![stage_chunk("new", "新 staging")],
            })
            .unwrap();
        drop(store);
        let reopened = AiStore::open(&root).unwrap();
        assert!(reopened.commit_index_stage(&second).is_err());
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }
}
