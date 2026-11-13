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
        .with_metadata_connection(|connection| table_columns(connection, "provider_models"))
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
                .with_metadata_connection(|connection| table_columns(connection, table))
                .is_ok(),
            "missing model table {table}"
        );
    }
    #[cfg(feature = "ai")]
    let package_columns = store
        .with_metadata_connection(|connection| table_columns(connection, "model_packages"))
        .unwrap();
    #[cfg(feature = "ai")]
    assert!(package_columns.contains(&"storage_kind".to_string()));
    #[cfg(feature = "ai")]
    let file_columns = store
        .with_metadata_connection(|connection| table_columns(connection, "model_package_files"))
        .unwrap();
    #[cfg(feature = "ai")]
    assert!(file_columns.contains(&"downloaded_bytes".to_string()));
    #[cfg(feature = "ai")]
    assert!(file_columns.contains(&"installed_at_ms".to_string()));
    #[cfg(feature = "ai")]
    let task_columns = store
        .with_metadata_connection(|connection| {
            table_columns(connection, "model_download_tasks")
        })
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
    assert_eq!(store.status().unwrap().schema_version, SCHEMA_VERSION);
    assert!(store
        .with_metadata_connection(|connection| table_columns(connection, "provider_models"))
        .is_ok());
    assert!(store
        .with_metadata_connection(|connection| table_columns(connection, "model_packages"))
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
fn task_exit_reason_legacy_projection_does_not_rewrite_history() {
    let (store, root) = test_store();
    let job = store.enqueue_task("index".into(), None).unwrap();
    store.with_connection(|c| c.execute("UPDATE jobs SET state='cancelled',cancel_requested=1,error=?1,updated_at_ms=123 WHERE id=?2", params![LEGACY_APP_EXIT_REASON, job.id]).map(|_| ()).map_err(|e| e.to_string())).unwrap();
    let listed = store.list_tasks().unwrap();
    assert_eq!(listed[0].error.as_deref(), Some(APP_EXIT_REASON));
    assert_eq!(listed[0].updated_at_ms, 123);
    let raw: (String, i64) = store.with_connection(|c| c.query_row("SELECT error,updated_at_ms FROM jobs WHERE id=?1", [&job.id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())).unwrap();
    assert_eq!(raw, (LEGACY_APP_EXIT_REASON.to_string(), 123));
    let wire = serde_json::to_value(&listed[0]).unwrap();
    assert_eq!(wire["error"], APP_EXIT_REASON);
    assert_eq!(wire["cancelRequested"], true);
    assert_eq!(project_task_error(TaskState::Cancelled, true, Some("应用退出：别的原因".into())).as_deref(), Some("应用退出：别的原因"));
    assert_eq!(project_task_error(TaskState::Failed, false, Some(LEGACY_APP_EXIT_REASON.into())).as_deref(), Some(LEGACY_APP_EXIT_REASON));
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn task_exit_reason_startup_reclaims_active_jobs() {
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
    assert_eq!(jobs[0].error.as_deref(), Some(APP_EXIT_REASON));
    let raw: String = reopened.with_connection(|c| c.query_row("SELECT error FROM jobs WHERE id=?1", [&job.id], |r| r.get(0)).map_err(|e| e.to_string())).unwrap();
    assert_eq!(raw, APP_EXIT_REASON);
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
        .with_metadata_connection(|connection| {
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
        .with_metadata_connection(|connection| {
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
        .with_metadata_connection(|connection| {
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
    let text_job = store
        .enqueue_task("library-text-index".into(), None)
        .unwrap();
    store
        .transition_task(&text_job.id, TaskTransition::Start)
        .unwrap();
    store
        .transition_task(&text_job.id, TaskTransition::Complete)
        .unwrap();
    store.enqueue_task("embedding".into(), None).unwrap();

    let cache = store.list_cache_statuses().unwrap();
    assert_eq!(cache.len(), 1);
    assert_eq!(cache[0].kind, FULL_TEXT_INDEX_CACHE_KIND);
    assert_eq!(cache[0].display_name, "全文索引");
    assert_eq!(cache[0].item_count, 1);
    assert_eq!(cache[0].state, "ready");
    assert_eq!(cache[0].size_bytes, None);
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
fn clearing_full_text_index_rejects_in_flight_job_without_deleting_rows() {
    let (store, root) = test_store();
    store.insert_book_for_test(&"d".repeat(64)).unwrap();
    store
        .enqueue_task(LIBRARY_TEXT_INDEX_TASK_KIND.into(), None)
        .unwrap();

    let error = store
        .clear_all_indexes()
        .expect_err("queued full-text work must block cleanup");
    assert!(error.contains("正在建立全文索引"), "{error}");
    let status = store.status().unwrap();
    assert_eq!(status.books, 1);
    assert_eq!(status.chunks, 1);
    assert_eq!(status.jobs, 1);
    assert_eq!(store.list_cache_statuses().unwrap()[0].state, "building");

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn clearing_full_text_index_reclaims_disk_space_and_can_index_again() {
    let (store, root) = test_store();
    let hash = "c".repeat(64);
    store.insert_book_for_test(&hash).unwrap();
    // A real file and trigram FTS segments: row counts alone do not prove
    // that clear reclaimed bytes or removed the old inverted index.
    let text = "cache reclamation test text ".repeat(32_768);
    store
        .with_connection(|connection| {
            connection.execute(
                "UPDATE chunks SET original_text=?1, normalized_text=?1",
                [&text],
            ).map_err(|error| error.to_string())?;
            connection.execute(
                "INSERT INTO chunk_fts(normalized_text, content_hash, chunk_id) VALUES (?1, ?2, 'chunk-1')",
                params![text, hash],
            ).map_err(|error| error.to_string())?;
            Ok(())
        })
        .unwrap();
    let unrelated = store.enqueue_task("other-job".into(), None).unwrap();
    let metadata_before = fs::read(AiStore::metadata_path(&root)).unwrap();
    // Emulate the old release: logical deletion succeeded, but FTS
    // segments and free database pages were never reclaimed.
    store
        .with_connection(|connection| {
            connection
                .execute_batch("DELETE FROM chunk_fts; DELETE FROM chunks; DELETE FROM books;")
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(store.status().unwrap().books, 0);
    let before = store.cache_database_size().unwrap();
    store.clear_cache(FULL_TEXT_INDEX_CACHE_KIND).unwrap();
    let after = store.cache_database_size().unwrap();
    assert!(
        after < before / 8,
        "cache did not shrink: {before} -> {after}"
    );
    store
        .with_connection(|connection| {
            let free: u64 = connection
                .query_row("PRAGMA freelist_count", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            let fts_bytes: u64 = connection
                .query_row(
                    "SELECT coalesce(sum(length(block)), 0) FROM chunk_fts_data",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            assert_eq!(free, 0);
            assert!(fts_bytes < 4096, "old FTS segments remain: {fts_bytes}");
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .with_connection(|connection| read_job(connection, &unrelated.id))
            .unwrap()
            .kind,
        "other-job"
    );
    assert_eq!(
        fs::read(AiStore::metadata_path(&root)).unwrap(),
        metadata_before
    );
    // Already-cleared caches from old versions can be reclaimed again.
    store.clear_cache(FULL_TEXT_INDEX_CACHE_KIND).unwrap();
    drop(store);
    let store = AiStore::open(&root).unwrap();
    store.insert_book_for_test(&hash).unwrap();
    assert_eq!(store.status().unwrap().books, 1);
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
