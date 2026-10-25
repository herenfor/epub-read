//! A34 library-folder preferences, kept apart from the library's own files.
//!
//! `library-settings.json` sits in the app's local data directory, next to
//! (not inside) `linked-library/`. P1 stores only `copyOnImport`; the custom
//! location is reserved for P2 and refused until then. An unknown schema or a
//! malformed file is reported, never overwritten or read as the defaults.

use super::*;

const SETTINGS_FILE_NAME: &str = "library-settings.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibrarySettings {
    schema_version: u32,
    #[serde(default)]
    custom_base_directory: Option<String>,
    #[serde(default = "default_copy_on_import")]
    pub(super) copy_on_import: bool,
}

fn default_copy_on_import() -> bool {
    true
}

impl Default for LibrarySettings {
    fn default() -> Self {
        Self { schema_version: SCHEMA_VERSION, custom_base_directory: None, copy_on_import: true }
    }
}

pub(super) fn library_settings_path(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join(SETTINGS_FILE_NAME)
}

pub(super) fn load_library_settings(local_data_dir: &Path) -> Result<LibrarySettings, String> {
    let bytes = match fs::read(library_settings_path(local_data_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(LibrarySettings::default()),
        Err(error) => return Err(format!("无法读取书库设置：{error}")),
    };
    let settings: LibrarySettings =
        serde_json::from_slice(&bytes).map_err(|error| format!("书库设置文件已损坏：{error}"))?;
    if settings.schema_version != SCHEMA_VERSION {
        return Err(format!("书库设置来自更新的版本（{}），请先更新本应用", settings.schema_version));
    }
    if settings.custom_base_directory.is_some() {
        return Err("书库设置使用了自定义位置，此版本尚不支持，请先更新本应用".into());
    }
    Ok(settings)
}

pub(super) fn save_library_settings(local_data_dir: &Path, settings: &LibrarySettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| format!("无法序列化书库设置：{error}"))?;
    atomic_write_bytes(&library_settings_path(local_data_dir), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("library-settings-{name}-{}-{}", std::process::id(), now_ms()));
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
    fn broken_newer_or_custom_location_settings_are_reported_not_defaulted() {
        let dir = temp_dir("refuse");
        let path = library_settings_path(&dir);
        fs::write(&path, b"{not json").unwrap();
        assert!(load_library_settings(&dir).unwrap_err().contains("损坏"));
        fs::write(&path, br#"{"schemaVersion":2,"copyOnImport":false}"#).unwrap();
        assert!(load_library_settings(&dir).unwrap_err().contains("更新"));
        fs::write(&path, br#"{"schemaVersion":1,"customBaseDirectory":"D:\\Books","copyOnImport":true}"#).unwrap();
        assert!(load_library_settings(&dir).is_err());
        // Nothing was rewritten while reporting.
        assert!(fs::read_to_string(&path).unwrap().contains("D:\\\\Books"));
    }
}
