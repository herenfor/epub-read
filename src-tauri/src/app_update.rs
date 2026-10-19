#[path = "app_update_contract.rs"]
mod contract;

pub(crate) use contract::InstallKind;
use contract::{InstallEvidence, Platform};

pub(crate) fn detect(identifier: &str) -> InstallKind {
    let build = crate::build_info::current();
    let test_mode = option_env!("EPUB_READER_UPDATE_TEST") == Some("1");
    #[cfg(windows)]
    let (directory, uninstaller, registered) = windows_evidence();
    #[cfg(not(windows))]
    let (directory, uninstaller, registered): (Option<String>, bool, Option<String>) =
        (None, false, None);
    let platform = if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "android") {
        Platform::Android
    } else {
        Platform::Other
    };
    contract::classify(&InstallEvidence {
        platform,
        core: build.edition == "core",
        development: build.profile != "release"
            || cfg!(debug_assertions)
            || identifier.ends_with(".debug"),
        test_mode,
        identifier,
        executable_directory: directory.as_deref(),
        uninstaller_present: uninstaller,
        registered_directory: registered.as_deref(),
    })
}

#[cfg(windows)]
fn windows_evidence() -> (Option<String>, bool, Option<String>) {
    use std::path::Path;
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WOW64_64KEY},
        RegKey,
    };
    fn canonical(path: &Path) -> Option<String> {
        path.canonicalize()
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned))
    }
    let current = std::env::current_exe().ok();
    let directory = current.as_ref().and_then(|p| p.parent());
    let uninstaller = directory.is_some_and(|p| p.join("uninstall.exe").is_file());
    // The official current-user NSIS installer uses this exact product key.
    // Do not enumerate unrelated installed software or accept a similarly named app.
    let registration = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\EPUB Reader",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok();
    let registered = registration.and_then(|key| {
        let name: String = key.get_value("DisplayName").ok()?;
        if name != "EPUB Reader" {
            return None;
        }
        let location: String = key.get_value("InstallLocation").ok()?;
        let location = location.trim();
        let location = location
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(location);
        canonical(Path::new(location))
    });
    (directory.and_then(canonical), uninstaller, registered)
}

#[tauri::command]
pub(crate) fn app_update_install_kind(kind: tauri::State<'_, InstallKind>) -> &'static str {
    (*kind).as_str()
}
