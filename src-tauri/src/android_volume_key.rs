//! Android volume-key paging bridge.
//!
//! The Kotlin `ReaderVolumeKeyPlugin` owns key interception and repeat cadence;
//! this module only forwards the reader-scoped mode and registers the plugin.
//! Every other platform reports the command as unsupported.

#[tauri::command]
pub async fn android_volume_key_set_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::set_mode(&app, &mode))
            .await
            .map_err(|error| format!("android_volume_key_set_mode worker join failed: {error}"))?
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, mode);
        Err("android_volume_key_set_mode: unsupported platform".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use serde::Serialize;
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidVolumeKey";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "ReaderVolumeKeyPlugin";

    struct AndroidVolumeKey<R: Runtime>(PluginHandle<R>);

    #[derive(Serialize)]
    struct ModeIntent {
        mode: String,
    }

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidVolumeKey(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn set_mode<R: Runtime>(app: &AppHandle<R>, mode: &str) -> Result<(), String> {
        app.state::<AndroidVolumeKey<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "setMode",
                ModeIntent {
                    mode: mode.to_string(),
                },
            )
            .map(|_| ())
            .map_err(|error| format!("android_volume_key_set_mode failed: {error}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
