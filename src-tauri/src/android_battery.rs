//! Android battery native bridge.
//!
//! The Kotlin `ReaderBatteryPlugin` owns the `ACTION_BATTERY_CHANGED` receiver
//! and sends every reading through one app-level plugin event. These Rust
//! commands only start and stop that subscription. They never return a first
//! value directly, which keeps the JS contract free of
//! the old first-read-overwrites-newer-event race.
//!
//! `lib.rs` registers the plugin on Android and exposes both commands for each
//! edition. The UI owns enabling and releasing the native receiver.

#[tauri::command]
pub async fn android_battery_subscribe(
    app: tauri::AppHandle,
    subscription_id: u64,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::subscribe(&app, subscription_id))
            .await
            .map_err(|error| format!("android_battery_subscribe worker join failed: {error}"))??;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, subscription_id);
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
    struct StartBatteryRequest {
        subscription_id: u64,
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
        subscription_id: u64,
    ) -> Result<(), String> {
        run_plugin_command(app, "start", StartBatteryRequest { subscription_id })
    }

    pub(crate) fn unsubscribe<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        run_plugin_command(app, "stop", ())
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
