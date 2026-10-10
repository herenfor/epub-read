//! Temporary native window ownership; preferences and reader routing stay in the UI.

#[tauri::command]
pub async fn reader_set_keep_screen_on(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::set_enabled(&app, enabled))
            .await
            .map_err(|error| format!("reader_set_keep_screen_on worker join failed: {error}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Err("reader_set_keep_screen_on: unsupported platform".into())
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    struct ReaderScreenOn<R: Runtime>(PluginHandle<R>);

    #[derive(serde::Serialize)]
    struct ScreenOnIntent {
        enabled: bool,
    }

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new("readerKeepScreenOn")
            .setup(|app, api| {
                let handle = api.register_android_plugin(
                    "dev.herenfor.epubreader",
                    "ReaderKeepScreenOnPlugin",
                )?;
                app.manage(ReaderScreenOn(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
        app.state::<ReaderScreenOn<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>("setEnabled", ScreenOnIntent { enabled })
            .map(|_| ())
            .map_err(|error| format!("reader_set_keep_screen_on failed: {error}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
