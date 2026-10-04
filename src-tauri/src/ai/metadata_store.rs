//! Persistent AI metadata database (model registry, licenses, download records).
//!
//! C1-N keeps rebuildable indexes in `ai/ai.sqlite3` and moves durable model
//! configuration/history to `ai/metadata.sqlite3`.  This module is intentionally
//! compiled for both Core and AI builds: Core may open a database written by an
//! AI build and must preserve the durable records without compiling model
//! inference or download code.

use rusqlite::{
    params_from_iter, types::Value, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use std::path::{Path, PathBuf};

pub(crate) const METADATA_DATABASE_NAME: &str = "metadata.sqlite3";
pub(crate) const METADATA_SCHEMA_VERSION: u32 = 1;
const LEGACY_METADATA_MARKER: &str = "legacy-ai-metadata";
const LEGACY_METADATA_MARKER_VERSION: u32 = 1;

pub(crate) const METADATA_TABLES: &[&str] = &[
    "provider_models",
    "model_library_config",
    "model_packages",
    "model_package_capabilities",
    "model_package_files",
    "model_sources",
    "model_download_tasks",
    "model_license_acceptance",
];

const METADATA_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS store_components (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_models (
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
);
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
    storage_kind TEXT NOT NULL DEFAULT 'managed' CHECK(storage_kind IN ('managed','linked')),
    linked_external_path TEXT,
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
    downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK(downloaded_bytes >= 0),
    installed_at_ms INTEGER,
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
CREATE INDEX IF NOT EXISTS model_download_tasks_by_package ON model_download_tasks(package_id);
CREATE TABLE IF NOT EXISTS model_license_acceptance (
    package_id TEXT PRIMARY KEY REFERENCES model_packages(package_id) ON DELETE CASCADE,
    license TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL
);
";

pub(crate) fn database_path(app_data_dir: impl AsRef<Path>) -> PathBuf {
    app_data_dir
        .as_ref()
        .join("ai")
        .join(METADATA_DATABASE_NAME)
}

/// Open the metadata database and, when a pre-split cache database is present,
/// import the legacy model tables once.  `legacy_available` is true only while
/// the cache database is still at an old schema that can be used as a source.
/// Inspect whether a metadata database is already initialized and carries the
/// completion marker, without importing from a legacy cache.  A missing file or
/// `user_version = 0` is simply not ready; a future/corrupt schema is an error
/// so callers do not silently rebuild over it.
pub(crate) fn is_ready(metadata_path: &Path) -> Result<bool, String> {
    if !metadata_path.exists() {
        return Ok(false);
    }
    let metadata = Connection::open(metadata_path)
        .map_err(|error| format!("无法打开 AI 持久配置数据库：{error}"))?;
    let version = user_version(&metadata)?;
    if version > METADATA_SCHEMA_VERSION {
        return Err(format!(
            "AI metadata 数据库版本 {version} 高于当前支持的版本 {METADATA_SCHEMA_VERSION}"
        ));
    }
    if version == 0 {
        return Ok(false);
    }
    let marker: Option<u32> = metadata
        .query_row(
            "SELECT version FROM store_components WHERE id = ?1",
            [LEGACY_METADATA_MARKER],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取 AI metadata 完成标记失败：{error}"))?;
    match marker {
        Some(LEGACY_METADATA_MARKER_VERSION) => Ok(true),
        Some(other) => Err(format!("不支持的 AI metadata 完成标记版本：{other}")),
        None => Err("AI metadata 数据库缺少完成标记，拒绝从缓存库重新导入".into()),
    }
}

pub(crate) fn open(
    metadata_path: &Path,
    legacy: &mut Connection,
    legacy_available: bool,
) -> Result<Connection, String> {
    if !metadata_path.exists() && !legacy_available {
        return Err(
            "AI 缓存库已是新版，但缺少持久配置库 metadata.sqlite3；为避免丢失模型/许可/下载资料，拒绝重建空库"
                .into(),
        );
    }
    let mut metadata = Connection::open(metadata_path)
        .map_err(|error| format!("无法打开 AI 持久配置数据库：{error}"))?;
    metadata
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("启用 AI metadata 外键约束失败：{error}"))?;
    metadata
        .busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|error| format!("设置 AI metadata 等待上限失败：{error}"))?;

    let version = user_version(&metadata)?;
    if version > METADATA_SCHEMA_VERSION {
        return Err(format!(
            "AI metadata 数据库版本 {version} 高于当前支持的版本 {METADATA_SCHEMA_VERSION}"
        ));
    }
    if version == 0 {
        if !legacy_available {
            return Err(
                "AI 缓存库已是新版，但 metadata.sqlite3 为空；为避免丢失持久资料，拒绝从缓存库重建空模型库"
                    .into(),
            );
        }
        import_legacy_metadata(&mut metadata, legacy)?;
        return Ok(metadata);
    }

    // Version 1 is current.  The completion marker is written in the same
    // transaction as the import, so it is the authoritative ownership signal.
    let marker: Option<u32> = metadata
        .query_row(
            "SELECT version FROM store_components WHERE id = ?1",
            [LEGACY_METADATA_MARKER],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取 AI metadata 完成标记失败：{error}"))?;
    match marker {
        Some(LEGACY_METADATA_MARKER_VERSION) => Ok(metadata),
        Some(other) => Err(format!("不支持的 AI metadata 完成标记版本：{other}")),
        None => Err("AI metadata 数据库缺少完成标记，拒绝从缓存库重新导入".into()),
    }
}

fn import_legacy_metadata(
    metadata: &mut Connection,
    legacy: &mut Connection,
) -> Result<(), String> {
    let target = metadata
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("开始 AI metadata 导入事务失败：{error}"))?;
    create_schema(&target)?;
    copy_legacy_metadata(&target, legacy)?;
    target
        .execute(
            "INSERT INTO store_components (id, version) VALUES (?1, ?2)",
            [LEGACY_METADATA_MARKER, "1"],
        )
        .map_err(|error| format!("写入 AI metadata 完成标记失败：{error}"))?;
    target
        .execute_batch(&format!("PRAGMA user_version = {METADATA_SCHEMA_VERSION};"))
        .map_err(|error| format!("写入 AI metadata schema 版本失败：{error}"))?;
    target
        .commit()
        .map_err(|error| format!("提交 AI metadata 导入事务失败：{error}"))
}

fn create_schema(target: &Transaction<'_>) -> Result<(), String> {
    target
        .execute_batch(METADATA_SCHEMA_SQL)
        .map_err(|error| format!("创建 AI metadata schema 失败：{error}"))
}

/// Copy the durable legacy tables in parent-first order.  All source names are
/// taken from the source cursor and inserted explicitly so ALTER TABLE history
/// cannot make positional order significant.
fn copy_legacy_metadata(target: &Transaction<'_>, legacy: &mut Connection) -> Result<(), String> {
    let source = legacy
        .transaction()
        .map_err(|error| format!("开始读取旧 AI 持久表事务失败：{error}"))?;
    for table in METADATA_TABLES {
        let exists: bool = source
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| format!("检查旧 AI 持久表失败：{error}"))?;
        if !exists {
            continue;
        }
        let mut select = source
            .prepare(&format!("SELECT * FROM {table}"))
            .map_err(|error| format!("读取旧 AI 持久表 {table} 失败：{error}"))?;
        let count = select.column_count();
        let columns = select
            .column_names()
            .iter()
            .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        let slots = vec!["?"; count].join(",");
        let mut insert = target
            .prepare(&format!("INSERT INTO {table} ({columns}) VALUES ({slots})"))
            .map_err(|error| format!("准备写入 AI metadata {table} 失败：{error}"))?;
        let mut rows = select
            .query([])
            .map_err(|error| format!("查询旧 AI 持久表 {table} 失败：{error}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("读取旧 AI 持久表 {table} 失败：{error}"))?
        {
            let values = (0..count)
                .map(|column| row.get::<_, Value>(column))
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("解析旧 AI 持久表 {table} 失败：{error}"))?;
            insert
                .execute(params_from_iter(values))
                .map_err(|error| format!("导入旧 AI 持久表 {table} 失败：{error}"))?;
        }
    }
    Ok(())
}

fn user_version(connection: &Connection) -> Result<u32, String> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取 AI metadata schema 版本失败：{error}"))
}

#[cfg(all(test, feature = "ai"))]
mod tests {
    // The C1-N cache-split lifecycle tests live here because the import
    // transaction and completion marker are this module's responsibility.
    use super::*;
    use crate::ai::store::AiStore;
    use crate::ai::AiSearchInput;
    use rusqlite::Connection;

    static TEST_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn temp_root(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "epub-reader-{prefix}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    fn legacy_ai_v6_fixture(root: &Path) -> Connection {
        std::fs::create_dir_all(root.join("ai")).unwrap();
        let connection = Connection::open(AiStore::database_path(root)).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 CREATE TABLE books (
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
                 CREATE TABLE provider_models (
                   provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
                   provider_version TEXT NOT NULL, model_digest TEXT NOT NULL,
                   model_format TEXT NOT NULL, dimensions INTEGER,
                   context_window INTEGER, transport TEXT NOT NULL,
                   capabilities_json TEXT NOT NULL, is_enabled INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(provider_id, model_id)
                 );
                 CREATE TABLE model_library_config (
                   id INTEGER PRIMARY KEY CHECK(id = 1),
                   root_path TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE model_packages (
                   package_id TEXT PRIMARY KEY, model_id TEXT NOT NULL,
                   version TEXT NOT NULL, display_name TEXT NOT NULL,
                   format TEXT NOT NULL, dimensions INTEGER, max_input INTEGER,
                   recommended_batch INTEGER, min_memory_bytes INTEGER,
                   recommended_memory_bytes INTEGER, platform TEXT, arch TEXT,
                   license TEXT NOT NULL, original_source TEXT NOT NULL,
                   homepage TEXT, requires_acceptance INTEGER NOT NULL DEFAULT 0,
                   provider_kind TEXT, package_dir TEXT NOT NULL,
                   storage_kind TEXT NOT NULL DEFAULT 'managed',
                   state TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                   linked_external_path TEXT
                 );
                 CREATE TABLE model_package_capabilities (
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   capability TEXT NOT NULL,
                   PRIMARY KEY(package_id, capability)
                 );
                 CREATE TABLE model_package_files (
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   relative_path TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
                   sha256 TEXT NOT NULL, purpose TEXT NOT NULL,
                   verification_state TEXT NOT NULL, actual_size_bytes INTEGER,
                   actual_sha256 TEXT, downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                   installed_at_ms INTEGER,
                   PRIMARY KEY(package_id, relative_path)
                 );
                 CREATE TABLE model_sources (
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   url TEXT NOT NULL, kind TEXT, priority INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(package_id, url)
                 );
                 CREATE TABLE model_download_tasks (
                   id TEXT PRIMARY KEY,
                   package_id TEXT NOT NULL REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   state TEXT NOT NULL, bytes_downloaded INTEGER NOT NULL DEFAULT 0,
                   total_bytes INTEGER, current_file_path TEXT, current_file_index INTEGER,
                   package_total_bytes INTEGER, current_source_url TEXT, source_index INTEGER,
                   error TEXT, started_at_ms INTEGER, completed_at_ms INTEGER,
                   created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE model_license_acceptance (
                   package_id TEXT PRIMARY KEY REFERENCES model_packages(package_id) ON DELETE CASCADE,
                   license TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL
                 );
                 INSERT INTO provider_models VALUES ('provider','model','1','digest','onnx',8,NULL,'local','[]',1,11);
                 INSERT INTO model_library_config VALUES (1,'legacy-models',12);
                 INSERT INTO model_packages (
                   package_id, model_id, version, display_name, format, dimensions, max_input,
                   recommended_batch, min_memory_bytes, recommended_memory_bytes, platform, arch,
                   license, original_source, homepage, requires_acceptance, provider_kind,
                   package_dir, storage_kind, state, updated_at_ms, linked_external_path
                 ) VALUES (
                   'legacy-package','legacy-model','1','Legacy','gguf',NULL,NULL,NULL,NULL,NULL,
                   NULL,NULL,'Apache-2.0','legacy-source',NULL,0,NULL,'legacy-dir','managed',
                   'installed',13,NULL
                 );
                 INSERT INTO model_package_capabilities VALUES ('legacy-package','generation');
                 INSERT INTO model_package_files (
                   package_id, relative_path, size_bytes, sha256, purpose, verification_state,
                   actual_size_bytes, actual_sha256, downloaded_bytes, installed_at_ms
                 ) VALUES ('legacy-package','weights.gguf',5,'abc','weights','verified',5,'abc',5,14);
                 INSERT INTO model_sources VALUES ('legacy-package','https://example.invalid/legacy',NULL,0);
                 INSERT INTO model_download_tasks (
                   id, package_id, state, bytes_downloaded, total_bytes, current_file_path,
                   current_file_index, package_total_bytes, current_source_url, source_index,
                   error, started_at_ms, completed_at_ms, created_at_ms, updated_at_ms
                 ) VALUES (
                   'legacy-task','legacy-package','completed',5,5,NULL,NULL,5,NULL,NULL,NULL,15,16,17,18
                 );
                 INSERT INTO model_license_acceptance VALUES ('legacy-package','Apache-2.0',19);
                 INSERT INTO books VALUES (
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   'Legacy Book','Author','zh','p1','n1','c1',1,1
                 );
                 INSERT INTO chunks VALUES (
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   'legacy-chunk',0,'legacy.xhtml','Legacy','body',
                   '旧库全文仍可查询','旧库全文仍可查询','{}'
                 );
                 INSERT INTO chunk_fts(normalized_text, content_hash, chunk_id)
                   SELECT normalized_text, content_hash, chunk_id FROM chunks;
                 PRAGMA user_version = 6;",
            )
            .unwrap();
        connection
    }

    fn table_exists(connection: &Connection, table: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .unwrap_or(false)
    }

    #[test]
    fn cache_split_migrates_legacy_metadata_and_fts_once() {
        let root = temp_root("cache-split-once");
        drop(legacy_ai_v6_fixture(&root));

        let store = AiStore::open(&root).unwrap();
        assert_eq!(store.status().unwrap().schema_version, 7);
        assert_eq!(store.status().unwrap().provider_models, 1);
        assert_eq!(store.status().unwrap().model_packages, 1);
        let cache = Connection::open(AiStore::database_path(&root)).unwrap();
        assert!(!table_exists(&cache, "provider_models"));
        assert!(!table_exists(&cache, "model_packages"));
        drop(cache);
        let hits = store
            .search(AiSearchInput {
                query: "旧库全文".into(),
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
        assert_eq!(
            store.model_library_path().unwrap().as_deref(),
            Some("legacy-models")
        );
        let package = store.get_model_package("legacy-package").unwrap().unwrap();
        assert_eq!(package.license, "Apache-2.0");
        assert_eq!(package.storage_kind, "managed");
        assert_eq!(package.files[0].downloaded_bytes, 5);
        let task = store
            .get_model_download_task("legacy-task")
            .unwrap()
            .unwrap();
        assert_eq!(task.state, "completed");
        assert_eq!(task.package_total_bytes, Some(5));

        // A later metadata write must survive a restart even if an old cache
        // table is still present for inspection.
        store.set_model_library_path("new-models").unwrap();
        drop(store);
        let store = AiStore::open(&root).unwrap();
        assert_eq!(
            store.model_library_path().unwrap().as_deref(),
            Some("new-models")
        );
        assert_eq!(store.status().unwrap().model_packages, 1);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_cache_open_bootstraps_old_default_metadata_before_new_cache() {
        let root = temp_root("cache-settings-custom-open");
        drop(legacy_ai_v6_fixture(&root));
        let custom = root
            .join("chosen-root")
            .join("dev.epubreader.ai")
            .join("reader-cache-v1");

        let store = AiStore::open_with_cache_directory(&root, &custom).unwrap();
        assert!(custom.join("ai.sqlite3").is_file());
        assert!(database_path(&root).is_file());
        assert_eq!(store.status().unwrap().provider_models, 1);
        assert_eq!(store.status().unwrap().model_packages, 1);

        let old_cache = Connection::open(AiStore::database_path(&root)).unwrap();
        assert!(!table_exists(&old_cache, "provider_models"));
        assert!(!table_exists(&old_cache, "model_packages"));
        drop(old_cache);

        store.insert_book_for_test(&"b".repeat(64)).unwrap();
        store.clear_all_indexes().unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.books, 0);
        assert_eq!(status.provider_models, 1);
        assert_eq!(status.model_packages, 1);

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_cache_fresh_install_creates_both_databases() {
        let root = temp_root("cache-settings-fresh-custom");
        let custom = root
            .join("chosen-root")
            .join("dev.epubreader.ai")
            .join("reader-cache-v1");

        let store = AiStore::open_with_cache_directory(&root, &custom).unwrap();
        assert!(custom.join("ai.sqlite3").is_file());
        assert!(database_path(&root).is_file());
        assert_eq!(store.status().unwrap().provider_models, 0);
        assert_eq!(store.status().unwrap().model_packages, 0);

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_split_copy_failure_rolls_back_target_and_keeps_legacy_source() {
        let root = temp_root("cache-split-failure");
        let connection = legacy_ai_v6_fixture(&root);
        connection
            .execute(
                "INSERT INTO model_package_capabilities (package_id, capability)
                 VALUES ('orphan-package', 'generation')",
                [],
            )
            .unwrap();
        drop(connection);

        let error = AiStore::open(&root)
            .err()
            .expect("split must fail while importing an orphan row");
        assert!(error.contains("导入旧 AI 持久表"), "{error}");
        let cache = Connection::open(AiStore::database_path(&root)).unwrap();
        assert!(table_exists(&cache, "model_packages"));
        assert!(table_exists(&cache, "model_package_capabilities"));
        let packages: i64 = cache
            .query_row("SELECT COUNT(*) FROM model_packages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(packages, 1);
        let metadata = Connection::open(database_path(&root)).unwrap();
        let metadata_schema: u32 = metadata
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(metadata_schema, 0);
        assert!(!table_exists(&metadata, "store_components"));
        drop(metadata);
        drop(cache);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_split_target_marker_wins_and_finishes_source_cleanup() {
        let root = temp_root("cache-split-cleanup");
        drop(legacy_ai_v6_fixture(&root));
        let store = AiStore::open(&root).unwrap();
        store.set_model_library_path("target-wins").unwrap();
        drop(store);

        // Put a stale, fully normalized legacy copy back into cache and leave
        // metadata marker in place.  Reopening must not re-import the old path.
        let legacy = Connection::open(AiStore::database_path(&root)).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE provider_models (
                   provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
                   provider_version TEXT NOT NULL, model_digest TEXT NOT NULL,
                   model_format TEXT NOT NULL, dimensions INTEGER,
                   context_window INTEGER, transport TEXT NOT NULL,
                   capabilities_json TEXT NOT NULL, is_enabled INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(provider_id, model_id)
                 );
                 CREATE TABLE model_library_config (
                   id INTEGER PRIMARY KEY CHECK(id = 1),
                   root_path TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE model_packages (
                   package_id TEXT PRIMARY KEY, model_id TEXT NOT NULL,
                   version TEXT NOT NULL, display_name TEXT NOT NULL,
                   format TEXT NOT NULL, dimensions INTEGER, max_input INTEGER,
                   recommended_batch INTEGER, min_memory_bytes INTEGER,
                   recommended_memory_bytes INTEGER, platform TEXT, arch TEXT,
                   license TEXT NOT NULL, original_source TEXT NOT NULL,
                   homepage TEXT, requires_acceptance INTEGER NOT NULL DEFAULT 0,
                   provider_kind TEXT, package_dir TEXT NOT NULL,
                   storage_kind TEXT NOT NULL DEFAULT 'managed',
                   state TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                   linked_external_path TEXT
                 );
                 INSERT INTO model_library_config VALUES (1,'stale-source',99);
                 PRAGMA user_version = 6;",
            )
            .unwrap();
        drop(legacy);

        let store = AiStore::open(&root).unwrap();
        assert_eq!(
            store.model_library_path().unwrap().as_deref(),
            Some("target-wins")
        );
        let cache = Connection::open(AiStore::database_path(&root)).unwrap();
        assert!(!table_exists(&cache, "model_library_config"));
        let version: u32 = cache
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
        drop(cache);

        // Derived-cache clearing must not reach the metadata database or the
        // model-package records preserved there.
        store.clear_all_derived_data().unwrap();
        assert_eq!(store.status().unwrap().model_packages, 1);
        assert!(store.get_model_package("legacy-package").unwrap().is_some());
        assert!(AiStore::metadata_path(&root).is_file());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
