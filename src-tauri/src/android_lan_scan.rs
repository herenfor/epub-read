//! Minimal Android QR scanner bridge for LAN save joining.
//!
//! The Kotlin `LanScanPlugin` launches `LanScanActivity`, which owns the camera
//! and its permission request. This command returns its outcome as a status
//! (`scanned`, `cancelled`, `permission-denied`, `no-camera`, `camera-error`)
//! plus the scanned text, so the web layer can explain every case in plain
//! words. The caller must keep the paste-connection-info path available.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanScanOutcome {
    pub status: String,
    pub contents: Option<String>,
}

#[tauri::command]
pub async fn android_lan_scan_qr(app: tauri::AppHandle) -> Result<LanScanOutcome, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::scan(&app))
            .await
            .map_err(|error| format!("android_lan_scan_qr worker join failed: {error}"))?
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("android_lan_scan_qr: unsupported platform".to_string())
    }
}

/// Opens the app's system settings page (used after the camera was denied).
#[tauri::command]
pub async fn android_lan_open_app_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::open_app_settings(&app))
            .await
            .map_err(|error| format!("android_lan_open_app_settings worker join failed: {error}"))?
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("android_lan_open_app_settings: unsupported platform".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::LanScanOutcome;
    use serde::Deserialize;
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidLanScan";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "LanScanPlugin";

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScanPluginResponse {
        status: String,
        contents: Option<String>,
    }

    pub(crate) struct AndroidLanScan<R: Runtime>(PluginHandle<R>);

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidLanScan(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn scan<R: Runtime>(app: &AppHandle<R>) -> Result<LanScanOutcome, String> {
        let plugin = app.state::<AndroidLanScan<R>>();
        let response = plugin
            .0
            .run_mobile_plugin::<ScanPluginResponse>("scan", ())
            .map_err(|error| format!("android_lan_scan_qr failed: {error}"))?;
        let contents = response
            .contents
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if response.status == "scanned" && contents.is_none() {
            return Ok(LanScanOutcome { status: "cancelled".to_string(), contents: None });
        }
        Ok(LanScanOutcome { status: response.status, contents })
    }

    pub(crate) fn open_app_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let plugin = app.state::<AndroidLanScan<R>>();
        plugin
            .0
            .run_mobile_plugin::<serde_json::Value>("openAppSettings", ())
            .map(|_| ())
            .map_err(|error| format!("android_lan_open_app_settings failed: {error}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
