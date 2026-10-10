//! Activity-owned, status-bar-only reader immersion. No window fullscreen or data changes.

#[tauri::command]
pub async fn android_reader_system_bars(app: tauri::AppHandle, hidden: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::set_hidden(&app, hidden))
            .await
            .map_err(|error| format!("android_reader_system_bars worker join failed: {error}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, hidden);
        Err("android_reader_system_bars: unsupported platform".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    struct ReaderSystemBars<R: Runtime>(PluginHandle<R>);

    #[derive(serde::Serialize)]
    struct HiddenIntent {
        hidden: bool,
    }

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new("readerSystemBars")
            .setup(|app, api| {
                let handle = api
                    .register_android_plugin("dev.herenfor.epubreader", "ReaderSystemBarsPlugin")?;
                app.manage(ReaderSystemBars(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn set_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) -> Result<(), String> {
        app.state::<ReaderSystemBars<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>("setHidden", HiddenIntent { hidden })
            .map(|_| ())
            .map_err(|error| format!("android_reader_system_bars failed: {error}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
