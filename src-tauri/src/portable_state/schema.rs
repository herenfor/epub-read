//! Local SQLite structure identity, independent of portable JSON/LAN versions.
use super::error::{PortableError, PortableResult};
use rusqlite::{Connection, DatabaseName, OpenFlags, TransactionBehavior};
use std::path::Path;

// Local SQLite versions (not program, portable JSON, organization or LAN versions):
// 0: known historical six/seven-table unmarked DB; recognize first, then convert.
// 1: stamped schema allowing hidden/unbound sync records. -> 2: Backup API,
//    purge unbound books in one transaction, write user_version=2 last.
// 2: local-owned book data; deletion purges all book state. Reopen is read-only
//    with respect to conversion. Future versions require a new explicit arm.
const SCHEMA_VERSION: i64 = 2;
const DIRECTORY_TABLE: &str = "directory_bindings";
const TABLES: &[(&str, &str)] = &[
    (
        "book_meta",
        "CREATE TABLE book_meta (hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL)",
    ),
    (
        "progress",
        "CREATE TABLE progress (hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL,
                 local_revision INTEGER NOT NULL)",
    ),
    (
        "annotations",
        "CREATE TABLE annotations (hash TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 id TEXT NOT NULL,
                 json TEXT NOT NULL,
                 local_revision INTEGER NOT NULL,
                 PRIMARY KEY (hash, kind, id))",
    ),
    (
        "organization",
        "CREATE TABLE organization (key TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL)",
    ),
    (
        "device_bindings",
        "CREATE TABLE device_bindings (hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL)",
    ),
    (
        "local_meta",
        "CREATE TABLE local_meta (key TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL)",
    ),
    (
        "directory_bindings",
        "CREATE TABLE directory_bindings (directory_key TEXT PRIMARY KEY NOT NULL,
                 folder_id TEXT NOT NULL)",
    ),
];

fn normalized_ddl(sql: &str) -> String {
    sql.chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

pub(super) fn initialize(connection: &mut Connection) -> PortableResult<()> {
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    let database_path = connection
        .path()
        .filter(|path| !path.is_empty())
        .map(str::to_owned);
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(PortableError::unsupported_database_version(format!(
            "本机资料库结构版本{version}高于当前支持的{SCHEMA_VERSION}，请使用较新版本的阅读器"
        )));
    }
    let objects = {
        let mut statement = transaction.prepare(
            "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name"
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let fresh = version == 0 && objects.is_empty();
    let known = (objects.len() == TABLES.len()
        || (version == 0 && objects.len() == TABLES.len() - 1))
        && objects.iter().all(|(name, kind, sql)| {
            kind == "table"
                && TABLES.iter().any(|(expected_name, ddl)| {
                    name == expected_name && normalized_ddl(sql) == normalized_ddl(ddl)
                })
        });
    let has_directory = objects.iter().any(|(name, _, _)| name == DIRECTORY_TABLE);
    if !fresh
        && (!known
            || (objects.len() == TABLES.len() - 1 && has_directory)
            || !matches!(version, 0 | 1 | SCHEMA_VERSION))
    {
        return Err(PortableError::unrecognized_database_format(
            "本机资料库结构无法识别，原资料已保留",
        ));
    }
    if !fresh && version < SCHEMA_VERSION {
        if let Some(path) = database_path {
            backup_before_v2(Path::new(&path))?;
        }
    }
    for (name, ddl) in TABLES {
        if fresh || (!has_directory && *name == DIRECTORY_TABLE) {
            transaction.execute_batch(ddl)?;
        }
    }
    if !fresh && version < SCHEMA_VERSION {
        super::local_books::purge_unbound(&transaction)?;
    }
    if version < SCHEMA_VERSION {
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    transaction.commit()?;
    Ok(())
}

fn backup_before_v2(path: &Path) -> PortableResult<()> {
    // The caller holds BEGIN IMMEDIATE: other writers cannot change the source.
    // A separate read connection sees the last committed DB including WAL;
    // backing up the caller's write transaction itself would be SQLITE_LOCKED.
    let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(
        ".before-v2-{}.sqlite",
        super::legacy::random_uuid_v4()?
    ));
    let destination = std::path::PathBuf::from(name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| PortableError::storage_error(format!("转换前备份无法创建：{e}")))?;
    if let Err(error) = source.backup(DatabaseName::Main, &destination, None) {
        let _ = std::fs::remove_file(&destination);
        return Err(PortableError::storage_error(format!(
            "转换前 SQLite 备份失败：{error}"
        )));
    }
    // Retain the original backup even if subsequent conversion rolls back.
    Ok(())
}

#[cfg(test)]
mod schema_version_tests {
    use super::*;
    use crate::portable_state::PortableStore;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDb(PathBuf);
    impl TestDb {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            Self(std::env::temp_dir().join(format!(
                "epub-schema-{}-{}.sqlite",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            for path in backups(&self.0) {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn backups(path: &Path) -> Vec<PathBuf> {
        let prefix = format!("{}.before-v2-", path.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&prefix)
            })
            .collect()
    }

    #[test]
    fn version_one_conversion_keeps_bound_missing_book_and_backs_up_wal() {
        let db = TestDb::new();
        let connection = Connection::open(&db.0).unwrap();
        connection
            .execute_batch(include_str!("testdata/local-schema-v1.sql"))
            .unwrap();
        // Keep this connection alive: committed WAL must be in the backup.
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; UPDATE local_meta SET json='8' WHERE key='counter';",
            )
            .unwrap();
        let store = PortableStore::open(&db.0).unwrap();
        let state = store.snapshot().unwrap();
        let retained = "c".repeat(64);
        assert_eq!(state.books.keys().collect::<Vec<_>>(), vec![&retained]);
        assert!(crate::library_organization::is_favorite(
            &state.organization,
            &retained
        ));
        assert_eq!(state.organization.folders.len(), 1);
        assert_eq!(state.organization.books.len(), 1);
        assert_eq!(store.counter().unwrap(), 8);
        for table in ["book_meta", "progress", "device_bindings"] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM annotations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(store.local_is_new_hashes().unwrap(), vec![retained]);
        let paths = backups(&db.0);
        assert_eq!(paths.len(), 1);
        let backup = Connection::open(&paths[0]).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            backup
                .query_row("SELECT count(*) FROM book_meta", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            backup
                .query_row("SELECT json FROM local_meta WHERE key='counter'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "8"
        );
        drop(backup);
        drop(store);
        drop(PortableStore::open(&db.0).unwrap());
        assert_eq!(backups(&db.0), paths);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn version_one_failure_rolls_back_and_can_retry() {
        let db = TestDb::new();
        let connection = Connection::open(&db.0).unwrap();
        connection
            .execute_batch(include_str!("testdata/local-schema-v1.sql"))
            .unwrap();
        // A malformed local flag must abort conversion without changing the source.
        connection
            .execute(
                "UPDATE local_meta SET json='null' WHERE key='isNewHashes'",
                [],
            )
            .unwrap();
        let before: String = connection
            .query_row("SELECT json FROM organization", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            PortableStore::open(&db.0).err().unwrap().code,
            "storage-error"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM book_meta", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row("SELECT json FROM organization", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            before
        );
        assert_eq!(backups(&db.0).len(), 1);
        connection
            .execute(
                "UPDATE local_meta SET json='[]' WHERE key='isNewHashes'",
                [],
            )
            .unwrap();
        drop(PortableStore::open(&db.0).unwrap());
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn unmarked_legacy_is_recognized_and_marked() {
        let db = TestDb::new();
        let connection = Connection::open(&db.0).unwrap();
        connection
            .execute_batch(include_str!("testdata/legacy-schema-v0.sql"))
            .unwrap();
        drop(connection);
        drop(PortableStore::open(&db.0).unwrap());
        let connection = Connection::open(&db.0).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row("SELECT json FROM local_meta WHERE key='counter'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "7"
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM directory_bindings", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        // An unknown schema cannot be hidden by creating the known tables.
        let unknown = TestDb::new();
        let connection = Connection::open(&unknown.0).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('keep');",
            )
            .unwrap();
        assert_eq!(
            PortableStore::open(&unknown.0).err().unwrap().code,
            "unrecognized-database-format"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn marked_database_reopens_idempotently() {
        let db = TestDb::new();
        drop(PortableStore::open(&db.0).unwrap());
        let connection = Connection::open(&db.0).unwrap();
        connection
            .execute("INSERT INTO local_meta VALUES ('counter','9')", [])
            .unwrap();
        drop(connection);
        for _ in 0..2 {
            drop(PortableStore::open(&db.0).unwrap());
        }
        let connection = Connection::open(&db.0).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT json FROM local_meta WHERE key='counter'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "9"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn newer_database_is_rejected_without_changes() {
        let db = TestDb::new();
        let connection = Connection::open(&db.0).unwrap();
        connection.execute_batch("PRAGMA user_version=3; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep');").unwrap();
        assert_eq!(
            PortableStore::open(&db.0).err().unwrap().code,
            "unsupported-database-version"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row("SELECT value FROM future_data", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}
