//! A34 library-folder preferences, kept apart from the library's own files.
//!
//! `library-settings.json` sits in the app's local data directory, next to
//! (not inside) `linked-library/`. It stores the copy preference and custom
//! location, cached until settings are explicitly read/written. An unknown schema or a
//! malformed file is reported, never overwritten or read as the defaults.

use super::*;

const SETTINGS_FILE_NAME: &str = "library-settings.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibrarySettings {
    schema_version: u32,
    #[serde(default)]
    pub(super) custom_base_directory: Option<String>,
    #[serde(default = "default_copy_on_import")]
    pub(super) copy_on_import: bool,
}

fn default_copy_on_import() -> bool {
    true
}

impl Default for LibrarySettings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            custom_base_directory: None,
            copy_on_import: true,
        }
    }
}

pub(super) fn library_settings_path(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join(SETTINGS_FILE_NAME)
}

pub(super) fn load_library_settings(local_data_dir: &Path) -> Result<LibrarySettings, String> {
    let mut cache = location_cache()
        .lock()
        .map_err(|_| "书库位置缓存锁已损坏")?;
    let result = read_library_settings(local_data_dir);
    cache.remove(local_data_dir);
    if let Ok(settings) = &result {
        cache.insert(local_data_dir.to_path_buf(), settings.clone());
    }
    result
}

fn read_library_settings(local_data_dir: &Path) -> Result<LibrarySettings, String> {
    let bytes = match fs::read(library_settings_path(local_data_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LibrarySettings::default())
        }
        Err(error) => return Err(format!("无法读取书库设置：{error}")),
    };
    let settings: LibrarySettings =
        serde_json::from_slice(&bytes).map_err(|error| format!("书库设置文件已损坏：{error}"))?;
    if settings.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "书库设置来自更新的版本（{}），请先更新本应用",
            settings.schema_version
        ));
    }
    if settings.custom_base_directory.is_some() {
        #[cfg(target_os = "android")]
        return Err("Android 不支持自定义书库位置".into());
        #[cfg(not(target_os = "android"))]
        if !Path::new(settings.custom_base_directory.as_deref().unwrap()).is_absolute() {
            return Err("自定义书库位置必须是绝对路径".into());
        }
    }
    Ok(settings)
}

pub(super) fn save_library_settings(
    local_data_dir: &Path,
    settings: &LibrarySettings,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("无法序列化书库设置：{error}"))?;
    // Hold the same lock across persistence and cache replacement. Readers see
    // either root, never a stale root after the persistent commit succeeded.
    let mut cache = location_cache()
        .lock()
        .map_err(|_| "书库位置缓存锁已损坏")?;
    atomic_write_bytes(&library_settings_path(local_data_dir), &bytes)?;
    cache.insert(local_data_dir.to_path_buf(), settings.clone());
    Ok(())
}

fn location_cache() -> &'static Mutex<HashMap<PathBuf, LibrarySettings>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, LibrarySettings>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

pub(super) fn books_for_settings(
    root: &Path,
    settings: &LibrarySettings,
) -> Result<PathBuf, String> {
    match settings.custom_base_directory.as_deref() {
        None => Ok(root.join("books")),
        Some(base) => {
            let namespace = root
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .ok_or("无法取得书库应用标识")?;
            if !namespace
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            {
                return Err("书库应用标识无效".into());
            }
            Ok(Path::new(base).join(namespace).join("books-v1"))
        }
    }
}

/// All managed readers and writers share this resolver. No per-book settings
/// I/O on a large shelf/import; explicit settings reads refresh the cache.
pub(crate) fn managed_books_directory(root: &Path) -> Result<PathBuf, String> {
    let local = root.parent().ok_or("无法取得书库设置目录")?;
    let mut cache = location_cache()
        .lock()
        .map_err(|_| "书库位置缓存锁已损坏")?;
    if !cache.contains_key(local) {
        cache.insert(local.to_path_buf(), read_library_settings(local)?);
    }
    books_for_settings(root, &cache[local])
}

/// Never recreate a missing custom library (e.g. a disconnected drive) or
/// silently place new books back in the default location.
pub(crate) fn writable_books_directory(root: &Path) -> Result<PathBuf, String> {
    let books = managed_books_directory(root)?;
    if books != root.join("books") && !books.is_dir() {
        return Err("library-folder-unavailable: 自定义书库位置不可用，请重新连接书库".into());
    }
    fs::create_dir_all(&books).map_err(|error| format!("无法创建书库目录：{error}"))?;
    Ok(books)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "library-settings-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_means_copy_on_import_and_round_trips() {
        let dir = temp_dir("roundtrip");
        assert!(load_library_settings(&dir).unwrap().copy_on_import);
        let mut settings = LibrarySettings::default();
        settings.copy_on_import = false;
        save_library_settings(&dir, &settings).unwrap();
        assert_eq!(load_library_settings(&dir).unwrap(), settings);
    }

    #[test]
    fn broken_newer_or_relative_location_settings_are_reported_not_defaulted() {
        let dir = temp_dir("refuse");
        let path = library_settings_path(&dir);
        fs::write(&path, b"{not json").unwrap();
        assert!(load_library_settings(&dir).unwrap_err().contains("损坏"));
        assert!(managed_books_directory(&dir.join("linked-library")).is_err());
        fs::write(&path, br#"{"schemaVersion":2,"copyOnImport":false}"#).unwrap();
        assert!(load_library_settings(&dir).unwrap_err().contains("更新"));
        fs::write(
            &path,
            br#"{"schemaVersion":1,"customBaseDirectory":"relative","copyOnImport":true}"#,
        )
        .unwrap();
        assert!(load_library_settings(&dir).is_err());
        // Nothing was rewritten while reporting.
        assert!(fs::read_to_string(&path).unwrap().contains("relative"));
    }
}
