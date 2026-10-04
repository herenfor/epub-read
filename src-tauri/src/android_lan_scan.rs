//! Minimal Android QR scanner bridge for LAN save joining.
//!
//! The Kotlin `LanScanPlugin` owns one ZXing ScanContract request. This Rust
//! command exposes that result as a plain string (`None` means the user
//! cancelled or did not provide scanner input). The caller must keep the
//! paste-connection-info path available.

#[tauri::command]
pub async fn android_lan_scan_qr(app: tauri::AppHandle) -> Result<Option<String>, String> {
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

#[cfg(target_os = "android")]
mod android {
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

    pub(crate) fn scan<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
        let plugin = app.state::<AndroidLanScan<R>>();
        let response = plugin
            .0
            .run_mobile_plugin::<ScanPluginResponse>("scan", ())
            .map_err(|error| format!("android_lan_scan_qr failed: {error}"))?;
        if response.status != "scanned" {
            return Ok(None);
        }
        let contents = response.contents.unwrap_or_default();
        if contents.trim().is_empty() {
            return Err("扫码未返回连接信息".to_string());
        }
        Ok(Some(contents))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
