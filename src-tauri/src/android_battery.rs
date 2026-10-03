//! Android battery plugin preparation.
//!
//! The Kotlin `ReaderBatteryPlugin` owns the `ACTION_BATTERY_CHANGED` receiver
//! and sends every reading through the command channel created by the JS
//! service. These Rust commands only start and stop that subscription; they
//! never return a first value directly, which keeps the JS contract free of
//! the old first-read-overwrites-newer-event race.
//!
//! Registration is intentionally left to the integration owner: add this
//! module to `lib.rs`, register [`plugin`] under `target_os = "android"`, and
//! add the two commands below to both edition invoke handlers.
#![allow(dead_code)]

#[tauri::command]
pub async fn android_battery_subscribe(
    app: tauri::AppHandle,
    on_status: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::subscribe(&app, &on_status))
            .await
            .map_err(|error| format!("android_battery_subscribe worker join failed: {error}"))??;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, on_status);
        Err("android_battery_subscribe: unsupported platform".to_string())
    }
}

#[tauri::command]
pub async fn android_battery_unsubscribe(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::unsubscribe(&app))
            .await
            .map_err(|error| {
                format!("android_battery_unsubscribe worker join failed: {error}")
            })??;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("android_battery_unsubscribe: unsupported platform".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidBattery";
    const PLUGIN_PACKAGE: &str = "dev.epubreader.app";
    const PLUGIN_CLASS: &str = "ReaderBatteryPlugin";

    #[derive(Deserialize)]
    struct EmptyResponse {}

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct StartBatteryRequest<'a> {
        on_status: &'a tauri::ipc::Channel<serde_json::Value>,
    }

    pub(crate) struct AndroidBattery<R: Runtime>(PluginHandle<R>);

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidBattery(handle));
                Ok(())
            })
            .build()
    }

    fn run_plugin_command<R: Runtime, P: Serialize>(
        app: &AppHandle<R>,
        command: &'static str,
        payload: P,
    ) -> Result<(), String> {
        let battery = app.state::<AndroidBattery<R>>();
        battery
            .0
            .run_mobile_plugin::<EmptyResponse>(command, payload)
            .map(|_| ())
            .map_err(|error| format!("android_battery_{command} failed: {error}"))
    }

    pub(crate) fn subscribe<R: Runtime>(
        app: &AppHandle<R>,
        on_status: &tauri::ipc::Channel<serde_json::Value>,
    ) -> Result<(), String> {
        run_plugin_command(app, "start", StartBatteryRequest { on_status })
    }

    pub(crate) fn unsubscribe<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        run_plugin_command(app, "stop", ())
    }
}

#[cfg(target_os = "android")]
#[allow(unused_imports)]
pub(crate) use android::plugin;
