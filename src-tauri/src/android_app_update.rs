//! Android in-app update bridge.
//!
//! The Kotlin `AppUpdatePlugin` downloads with `DownloadManager`, checks the
//! file (SHA-256, package name, signing certificate, higher versionCode) and
//! hands it to the system installer. This side only forwards a fixed set of
//! actions and refuses download addresses outside this app's GitHub releases
//! (an update test build may add its compiled-in test base).

const ACTIONS: &[&str] = &[
    "start",
    "status",
    "cancel",
    "verify",
    "canInstall",
    "openInstallPermission",
    "install",
    "cleanup",
];

const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/herenfor/epub-read/releases/download/";

fn allowed_download(url: &str, test_base: Option<&str>) -> bool {
    if url.starts_with(RELEASE_DOWNLOAD_PREFIX) && !url.contains("..") {
        return true;
    }
    test_base.is_some_and(|base| !base.is_empty() && url.starts_with(base))
}

fn test_download_base() -> Option<&'static str> {
    (option_env!("EPUB_READER_UPDATE_TEST") == Some("1"))
        .then(|| option_env!("EPUB_READER_UPDATE_TEST_DOWNLOAD_BASE"))
        .flatten()
}

fn check_request(action: &str, args: &serde_json::Value) -> Result<(), String> {
    if !ACTIONS.contains(&action) {
        return Err(format!("android_app_update: unknown action {action}"));
    }
    if action == "start" {
        let url = args.get("url").and_then(|value| value.as_str()).unwrap_or("");
        if !allowed_download(url, test_download_base()) {
            return Err("android_app_update: download address is not a release asset".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn android_app_update(
    app: tauri::AppHandle,
    action: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    check_request(&action, &args)?;

    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::run(&app, &action, args))
            .await
            .map_err(|error| format!("android_app_update worker join failed: {error}"))?
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, args);
        Err("android_app_update: unsupported platform".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidAppUpdate";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "AppUpdatePlugin";

    pub(crate) struct AndroidAppUpdate<R: Runtime>(PluginHandle<R>);

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidAppUpdate(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn run<R: Runtime>(
        app: &AppHandle<R>,
        action: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let plugin = app.state::<AndroidAppUpdate<R>>();
        plugin
            .0
            .run_mobile_plugin::<serde_json::Value>(action, args)
            .map_err(|error| format!("android_app_update {action} failed: {error}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_only_from_release_assets() {
        let asset = "https://github.com/herenfor/epub-read/releases/download/v0.3.4/epub-reader_0.3.4_android-arm64.apk";
        assert!(allowed_download(asset, None));
        assert!(!allowed_download("https://example.com/epub-reader.apk", None));
        assert!(!allowed_download("https://github.com/someone/else/releases/download/v1/a.apk", None));
        assert!(!allowed_download("https://github.com/herenfor/epub-read/releases/download/../../x.apk", None));
        assert!(!allowed_download("", Some("")));
        let test_base = Some("http://192.168.1.5:8443/");
        assert!(allowed_download("http://192.168.1.5:8443/a.apk", test_base));
        assert!(!allowed_download("http://192.168.1.6:8443/a.apk", test_base));
    }

    #[test]
    fn only_known_actions_pass() {
        let empty = serde_json::json!({});
        assert!(check_request("status", &empty).is_ok());
        assert!(check_request("deleteEverything", &empty).is_err());
        assert!(check_request("start", &serde_json::json!({ "url": "https://example.com/a.apk" })).is_err());
    }
}
