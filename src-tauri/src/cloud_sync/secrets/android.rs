//! Android: the WebDAV app password lives in `CloudSyncPlugin` (an AES key in
//! the Android Keystore, the sealed blob under noBackupFilesDir), and HTTPS
//! uses the system certificate verifier through rustls-platform-verifier,
//! which must be given the application context once before any request.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime, Wry};

const PLUGIN_NAME: &str = "cloudSyncSecrets";
const PLUGIN_PACKAGE: &str = "dev.herenfor.epubreader";
const PLUGIN_CLASS: &str = "CloudSyncPlugin";

static READY: AtomicBool = AtomicBool::new(false);

struct Bridge<R: Runtime>(PluginHandle<R>);

pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new(PLUGIN_NAME)
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            app.manage(Bridge(handle));
            Ok(())
        })
        .build()
}

pub fn ready() -> bool {
    READY.load(Ordering::Acquire)
}

fn call(app: &tauri::AppHandle, action: &str, args: serde_json::Value) -> Option<serde_json::Value> {
    let bridge = app.try_state::<Bridge<Wry>>()?;
    bridge
        .0
        .run_mobile_plugin::<serde_json::Value>(action, args)
        .ok()
}

/// Not cached on failure: a later status query may try again. Success is
/// final for the process, like the verifier's own one-time initialisation.
pub fn prepare(app: &tauri::AppHandle) -> bool {
    if ready() {
        return true;
    }
    let ok = call(app, "prepare", serde_json::json!({}))
        .and_then(|reply| reply.get("ready").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    if ok {
        READY.store(true, Ordering::Release);
    }
    ok
}

fn bridge_ready(app: &tauri::AppHandle) -> Result<()> {
    if prepare(app) {
        Ok(())
    } else {
        Err(Failure::new(FailureCode::NativeBridgeUnavailable))
    }
}

pub fn save(app: &tauri::AppHandle, connection_id: &str, password: &str) -> Result<()> {
    if password.is_empty() {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    bridge_ready(app)?;
    call(
        app,
        "save",
        serde_json::json!({ "connectionId": connection_id, "secret": password }),
    )
    .map(|_| ())
    .ok_or_else(|| Failure::new(FailureCode::CredentialUnavailable))
}

pub fn load(app: &tauri::AppHandle, connection_id: &str) -> Result<String> {
    bridge_ready(app)?;
    call(app, "load", serde_json::json!({ "connectionId": connection_id }))
        .and_then(|reply| reply.get("secret")?.as_str().map(str::to_owned))
        .filter(|secret| !secret.is_empty())
        .ok_or_else(|| Failure::new(FailureCode::CredentialUnavailable))
}

pub fn delete(app: &tauri::AppHandle, connection_id: &str) -> Result<()> {
    bridge_ready(app)?;
    call(app, "remove", serde_json::json!({ "connectionId": connection_id }))
        .map(|_| ())
        .ok_or_else(|| Failure::new(FailureCode::CredentialUnavailable))
}

/// Called once by `CloudSyncNative.initPlatformVerifier(applicationContext)`.
/// A failure only leaves sync unavailable; it never throws into Kotlin.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_herenfor_epubreader_CloudSyncNative_initPlatformVerifier<'caller>(
    mut env: jni::EnvUnowned<'caller>,
    _class: jni::objects::JClass<'caller>,
    context: jni::objects::JObject<'caller>,
) -> jni::sys::jboolean {
    env.with_env(|env| -> std::result::Result<bool, jni::errors::Error> {
        rustls_platform_verifier::android::init_with_env(env, context)?;
        Ok(true)
    })
    .resolve::<jni::errors::LogErrorAndDefault>()
}
