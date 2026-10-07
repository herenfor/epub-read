//! Explicit reset of rebuildable caches. Durable metadata must already be safe.
use super::{metadata_store, AiStore};
use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
static RESET_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const CACHE_FILES: [&str; 4] = [
    "ai.sqlite3",
    "ai.sqlite3-wal",
    "ai.sqlite3-shm",
    "ai.sqlite3-journal",
];

pub(super) fn reset(app_data: &Path, directory: &Path) -> Result<AiStore, String> {
    reset_with(app_data, directory, || {
        AiStore::open_with_cache_directory(app_data, directory)
    })
}

fn reset_with(
    app_data: &Path,
    directory: &Path,
    open: impl FnOnce() -> Result<AiStore, String>,
) -> Result<AiStore, String> {
    // Never discard a pre-split database until its durable data was imported.
    if !metadata_store::is_ready(&AiStore::metadata_path(app_data))? {
        return Err("持久配置尚未安全迁移，不能重置索引缓存；请先完成旧库升级".into());
    }
    let database = AiStore::database_path_in(directory);
    // A corrupt file is precisely what reset repairs. A readable newer file
    // belongs to a newer application and must not be replaced by a downgrade.
    if database.exists() {
        if let Ok(connection) =
            Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            if let Ok(version) =
                connection.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            {
                if version > super::store::MAX_SUPPORTED_SCHEMA_VERSION {
                    return Err(format!(
                        "索引数据库版本 {version} 高于当前支持版本，请使用新版应用，不能重置"
                    ));
                }
            }
        }
    }
    fs::create_dir_all(directory).map_err(|error| format!("无法访问索引缓存目录：{error}"))?;
    let backup = directory.join(format!(
        ".index-reset-{}-{}",
        std::process::id(),
        RESET_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&backup).map_err(|error| format!("无法准备索引缓存恢复目录：{error}"))?;
    let mut moved = Vec::new();
    for name in CACHE_FILES {
        let source = directory.join(name);
        if !source.exists() {
            continue;
        }
        if let Err(error) = fs::rename(&source, backup.join(name)) {
            for old in moved.iter().rev() {
                fs::rename(backup.join(old), directory.join(old)).map_err(|restore| {
                    format!(
                        "重置未完成，旧库还原失败：{restore}；旧文件保留于 {}",
                        backup.display()
                    )
                })?;
            }
            let _ = fs::remove_dir(&backup);
            return Err(format!(
                "无法关闭或移动索引缓存：{error}；请停止索引任务后重试"
            ));
        }
        moved.push(name);
    }
    match open() {
        Ok(store) => {
            // Also finish leftovers from an interrupted earlier reset, but
            // only after the replacement database has opened successfully.
            finish_backups(directory)?;
            Ok(store)
        }
        Err(error) => {
            // A failed open has released its SQLite connections. Remove only
            // the failed replacement, then put the originals back.
            for name in CACHE_FILES {
                let partial = directory.join(name);
                if partial.exists() {
                    fs::remove_file(partial).map_err(|restore| {
                        format!(
                            "重置失败，无法移除未完成的新库：{restore}；原库位于 {}",
                            backup.display()
                        )
                    })?;
                }
            }
            for name in &moved {
                fs::rename(backup.join(name), directory.join(name)).map_err(|restore| {
                    format!(
                        "重置失败，旧库还原失败：{restore}；原文件位于 {}",
                        backup.display()
                    )
                })?;
            }
            let _ = fs::remove_dir(&backup);
            Err(format!("索引缓存重置失败，原库已还原：{error}"))
        }
    }
}

fn finish_backups(directory: &Path) -> Result<(), String> {
    let finish = || -> std::io::Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(suffix) = name.strip_prefix(".index-reset-") else {
                continue;
            };
            let parts: Vec<_> = suffix.split('-').collect();
            if parts.len() != 2
                || !parts
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                || !entry.file_type()?.is_dir()
            {
                continue;
            }
            for file in CACHE_FILES {
                let old = entry.path().join(file);
                if old.exists() {
                    fs::remove_file(old)?;
                }
            }
            fs::remove_dir(entry.path())?;
        }
        Ok(())
    };
    finish()
        .map_err(|error| format!("索引缓存已重置，但旧文件回收失败：{error}；请再次重置以完成清理"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "epub-index-reset-test-{}-{}",
            std::process::id(),
            RESET_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        drop(AiStore::open(&root).unwrap());
        root
    }
    #[test]
    fn index_cache_reset_repairs_corrupt_cache_without_changing_metadata() {
        let root = fixture();
        let metadata = fs::read(AiStore::metadata_path(&root)).unwrap();
        let interrupted = root.join("ai/.index-reset-111-222");
        fs::create_dir(&interrupted).unwrap();
        fs::write(interrupted.join("ai.sqlite3"), b"old reset backup").unwrap();
        fs::write(AiStore::database_path(&root), b"broken cache database").unwrap();
        let store = reset(&root, &AiStore::default_cache_directory(&root)).unwrap();
        assert_eq!(store.status().unwrap().books, 0);
        assert_eq!(metadata, fs::read(AiStore::metadata_path(&root)).unwrap());
        assert!(!fs::read_dir(root.join("ai")).unwrap().any(|item| item
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".index-reset-")));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn index_cache_reset_refuses_missing_metadata_and_future_cache() {
        let root = fixture();
        let database = AiStore::database_path(&root);
        let connection = Connection::open(&database).unwrap();
        connection.pragma_update(None, "user_version", 999).unwrap();
        drop(connection);
        let before = fs::read(&database).unwrap();
        assert!(reset(&root, &root.join("ai"))
            .err()
            .unwrap()
            .contains("版本"));
        assert_eq!(before, fs::read(&database).unwrap());
        fs::remove_file(AiStore::metadata_path(&root)).unwrap();
        assert!(reset(&root, &root.join("ai"))
            .err()
            .unwrap()
            .contains("迁移"));
        assert_eq!(before, fs::read(&database).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn index_cache_reset_restores_old_file_if_replacement_open_fails() {
        let root = fixture();
        let database = AiStore::database_path(&root);
        let before = fs::read(&database).unwrap();
        let result = reset_with(&root, &root.join("ai"), || {
            fs::write(&database, b"unfinished replacement").unwrap();
            Err("simulated open failure".into())
        });
        assert!(result.err().unwrap().contains("原库已还原"));
        assert_eq!(before, fs::read(database).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
