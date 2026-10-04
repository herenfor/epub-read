//! User-visible cache-directory preference and startup path freeze.
//!
//! The setting file is deliberately independent from both SQLite databases.
//! It only stores the selected base directory; the actual cache is written to
//! `<selected>/<native identifier>/reader-cache-v1/ai.sqlite3`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const SETTINGS_FILE_NAME: &str = "cache-settings.json";
pub(crate) const SETTINGS_SCHEMA_VERSION: u32 = 1;
const CACHE_CHILD_NAME: &str = "reader-cache-v1";
static PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettingsFile {
    schema_version: u32,
    custom_base_directory: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct StartupCacheSettings {
    pub(crate) base_directory: Option<PathBuf>,
    pub(crate) config_error: Option<String>,
}

pub(crate) fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SETTINGS_FILE_NAME)
}

/// Load the saved selection at process startup.  Unknown schemas, malformed
/// JSON, and invalid paths are returned as visible errors instead of being
/// overwritten or silently ignored.
pub(crate) fn load_startup_settings(app_data_dir: &Path) -> StartupCacheSettings {
    let path = settings_path(app_data_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return StartupCacheSettings::default()
        }
        Err(error) => {
            return StartupCacheSettings {
                base_directory: None,
                config_error: Some(format!("无法读取缓存设置：{error}")),
            }
        }
    };
    let parsed: CacheSettingsFile = match serde_json::from_str(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            return StartupCacheSettings {
                base_directory: None,
                config_error: Some(format!("缓存设置损坏：{error}")),
            }
        }
    };
    if parsed.schema_version != SETTINGS_SCHEMA_VERSION {
        return StartupCacheSettings {
            base_directory: None,
            config_error: Some(format!("不支持的缓存设置版本：{}", parsed.schema_version)),
        };
    }
    match parsed.custom_base_directory {
        None => StartupCacheSettings::default(),
        Some(raw) => match parse_base_directory(&raw) {
            Ok(path) => StartupCacheSettings {
                base_directory: Some(path),
                config_error: None,
            },
            Err(error) => StartupCacheSettings {
                base_directory: None,
                config_error: Some(format!("缓存目录设置无效：{error}")),
            },
        },
    }
}

/// Persist a new selection with the existing atomic-replace helper used by the
/// device-local library JSON files.  The caller probes the target first and
/// updates its in-memory configured value only after this succeeds.
pub(crate) fn save_settings(app_data_dir: &Path, base: Option<&Path>) -> Result<(), String> {
    let file = CacheSettingsFile {
        schema_version: SETTINGS_SCHEMA_VERSION,
        custom_base_directory: base.map(|path| path.to_string_lossy().into_owned()),
    };
    let bytes =
        serde_json::to_vec_pretty(&file).map_err(|error| format!("序列化缓存设置失败：{error}"))?;
    crate::linked_library::atomic_write_bytes(&settings_path(app_data_dir), &bytes)
}

pub(crate) fn custom_directory_supported() -> bool {
    cfg!(windows)
}

/// Validate path syntax without touching the selected drive at startup.
fn parse_base_directory(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("请选择有效的非空目录".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("请选择绝对目录".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("目录路径不能包含 ..".into());
    }
    Ok(path.to_path_buf())
}

/// Normalize a newly selected directory; startup retains offline selections.
pub(crate) fn normalize_base_directory(raw: &str) -> Result<PathBuf, String> {
    let path = parse_base_directory(raw)?;
    if path.exists() {
        let metadata = fs::metadata(&path).map_err(|error| format!("无法访问所选目录：{error}"))?;
        if !metadata.is_dir() {
            return Err("所选路径不是目录".into());
        }
        return fs::canonicalize(&path)
            .map(simplify_windows_verbatim_path)
            .map_err(|error| format!("无法规范化所选目录：{error}"));
    }
    Ok(path)
}

#[cfg(windows)]
fn simplify_windows_verbatim_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path;
    };
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    PathBuf::from(rest)
}

#[cfg(not(windows))]
fn simplify_windows_verbatim_path(path: PathBuf) -> PathBuf {
    path
}

/// The actual cache is always isolated below the selected root and the native
/// host identifier, so two editions sharing a folder can never merge stores.
pub(crate) fn custom_cache_directory(
    base: &Path,
    native_identifier: &str,
) -> Result<PathBuf, String> {
    if native_identifier.is_empty()
        || native_identifier == "."
        || native_identifier == ".."
        || native_identifier.contains('/')
        || native_identifier.contains('\\')
    {
        return Err("宿主标识无效，无法创建隔离的缓存目录".into());
    }
    Ok(base.join(native_identifier).join(CACHE_CHILD_NAME))
}

/// Small write probe used before a selection is saved.  It intentionally only
/// creates the app-owned child directory, checks an existing database can be
/// opened without truncation, and writes one temporary file; it never scans
/// or removes the selected root.
pub(crate) fn prepare_custom_cache_directory(requested: &Path) -> Result<(), String> {
    if requested.as_os_str().is_empty() {
        return Err("缓存目录为空".into());
    }
    fs::create_dir_all(requested).map_err(|error| format!("无法创建缓存目录：{error}"))?;
    if !requested.is_dir() {
        return Err("缓存目录不是文件夹".into());
    }
    let database = super::store::AiStore::database_path_in(requested);
    if database.exists() {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&database)
            .map_err(|error| format!("缓存数据库文件不可读写：{error}"))?;
    }
    let nonce = PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let probe_path = requested.join(format!(
        ".reader-cache-probe-{}-{nonce}.tmp",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe_path)
            .map_err(|error| format!("缓存目录不可写：{error}"))?;
        file.write_all(b"ok")
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("缓存目录写入失败：{error}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&probe_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_root_is_isolated_by_identifier() {
        let root = Path::new("/tmp/epub-reader-cache-choice");
        assert_eq!(
            custom_cache_directory(root, "dev.epubreader.ai").unwrap(),
            root.join("dev.epubreader.ai").join("reader-cache-v1")
        );
        assert!(custom_cache_directory(root, "../escape").is_err());
    }

    #[test]
    fn startup_settings_reject_unknown_schema_without_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "epub-reader-cache-settings-test-{}-{}",
            std::process::id(),
            PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = settings_path(&root);
        fs::write(&path, "{\"schemaVersion\":99,\"customBaseDirectory\":null}").unwrap();

        let loaded = load_startup_settings(&root);
        assert!(loaded.base_directory.is_none());
        assert!(loaded.config_error.is_some());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"schemaVersion\":99,\"customBaseDirectory\":null}"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
