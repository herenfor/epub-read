//! Android task control used by the shelf's "back again to exit" hint.
//!
//! The shelf consumes every system Back so WebView history never decides
//! whether the app leaves. The second Back inside the hint window calls
//! `AppTaskPlugin.moveTaskToBack`, matching Android 12+ root-activity Back.

#[tauri::command]
pub async fn android_move_task_to_back(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::move_task_to_back(&app))
            .await
            .map_err(|error| format!("android_move_task_to_back worker join failed: {error}"))?
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("android_move_task_to_back: unsupported platform".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidAppTask";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "AppTaskPlugin";

    pub(crate) struct AndroidAppTask<R: Runtime>(PluginHandle<R>);

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidAppTask(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn move_task_to_back<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let plugin = app.state::<AndroidAppTask<R>>();
        plugin
            .0
            .run_mobile_plugin::<serde_json::Value>("moveTaskToBack", ())
            .map(|_| ())
            .map_err(|error| format!("android_move_task_to_back failed: {error}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
