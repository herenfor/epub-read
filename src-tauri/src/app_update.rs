#[path = "app_update_contract.rs"]
mod contract;

pub(crate) use contract::InstallKind;
use contract::{InstallEvidence, Platform};

pub(crate) fn detect(identifier: &str, product_name: Option<&str>) -> InstallKind {
    let build = crate::build_info::current();
    let test_mode = option_env!("EPUB_READER_UPDATE_TEST") == Some("1");
    #[cfg(windows)]
    let (directory, uninstaller, registered) =
        contract::windows_product_name(identifier, product_name, test_mode)
            .map(windows_evidence)
            .unwrap_or((None, false, None));
    #[cfg(not(windows))]
    let (directory, uninstaller, registered): (Option<String>, bool, Option<String>) =
        (None, false, None);
    // An Android update test build keeps the Tauri identifier (it names the
    // Kotlin package the native side binds to); Gradle changes only the
    // applicationId, from the same EPUB_READER_UPDATE_TEST switch.
    #[cfg(target_os = "android")]
    let identifier = match (test_mode, build.profile == "release" && !cfg!(debug_assertions)) {
        (true, true) => "dev.herenfor.epubreader.updatetest",
        (true, false) => "dev.herenfor.epubreader.updatetest.debug",
        (false, _) => identifier,
    };
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
        product_name,
        executable_directory: directory.as_deref(),
        uninstaller_present: uninstaller,
        registered_directory: registered.as_deref(),
    })
}

#[cfg(windows)]
fn windows_evidence(product_name: &str) -> (Option<String>, bool, Option<String>) {
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
    // The pure policy supplies only the allowed name for this build's identity.
    // An isolated test build never reads or falls back to the real application's key.
    let uninstall_key =
        format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product_name}");
    let registration = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(uninstall_key, KEY_READ | KEY_WOW64_64KEY)
        .ok();
    let registered = registration.and_then(|key| {
        let name: String = key.get_value("DisplayName").ok()?;
        if name != product_name {
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
