//! Narrow Android bridge that returns one immutable LAN address snapshot.
//!
//! `LanNetworkPlugin` owns `ConnectivityManager` access and the VPN/transport
//! filtering performed in Kotlin. This Rust side only registers the plugin and
//! converts the plugin's JSON response into facts for the shared policy core;
//! the UI never defines trusted candidates itself.

#[cfg(target_os = "android")]
mod android {
    use serde::Deserialize;
    use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    const PLUGIN_NAME: &str = "androidLanNetwork";
    const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
    const PLUGIN_CLASS: &str = "LanNetworkPlugin";

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct AndroidLanAddressFact {
        pub address: String,
        pub interface_id: String,
        pub label: String,
        pub kind: String,
        pub up: bool,
        pub excluded: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SnapshotResponse {
        addresses: Vec<AndroidLanAddressFact>,
    }

    pub(crate) struct AndroidLanNetwork<R: Runtime>(PluginHandle<R>);

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        PluginBuilder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
                app.manage(AndroidLanNetwork(handle));
                Ok(())
            })
            .build()
    }

    pub(crate) fn snapshot<R: Runtime>(
        app: &AppHandle<R>,
    ) -> Result<Vec<AndroidLanAddressFact>, String> {
        let plugin = app.state::<AndroidLanNetwork<R>>();
        let response = plugin
            .0
            .run_mobile_plugin::<SnapshotResponse>("snapshot", ())
            .map_err(|error| format!("Android 本机网络地址快照失败：{error}"))?;
        Ok(response.addresses)
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::{plugin, snapshot, AndroidLanAddressFact};
