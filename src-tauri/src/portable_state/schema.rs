//! Local SQLite structure identity, independent of portable JSON/LAN versions.
use super::error::{PortableError, PortableResult};
use rusqlite::{Connection, TransactionBehavior};

const SCHEMA_VERSION: i64 = 1;
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
            || !matches!(version, 0 | SCHEMA_VERSION))
    {
        return Err(PortableError::unrecognized_database_format(
            "本机资料库结构无法识别，原资料已保留",
        ));
    }
    for (name, ddl) in TABLES {
        if fresh || (!has_directory && *name == DIRECTORY_TABLE) {
            transaction.execute_batch(ddl)?;
        }
    }
    if version == 0 {
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    transaction.commit()?;
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
        }
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
            1
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
            1
        );
    }

    #[test]
    fn newer_database_is_rejected_without_changes() {
        let db = TestDb::new();
        let connection = Connection::open(&db.0).unwrap();
        connection.execute_batch("PRAGMA user_version=2; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep');").unwrap();
        assert_eq!(
            PortableStore::open(&db.0).err().unwrap().code,
            "unsupported-database-version"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            2
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
