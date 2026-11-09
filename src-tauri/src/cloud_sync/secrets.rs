//! Native credential backend. No filesystem plaintext fallback in the product.
use super::model::{Failure, FailureCode, Result};

/// Whether this process can store credentials and reach a WebDAV server.
/// Android answers true only after `prepare` has found the Keystore and set
/// up the platform certificate verifier; before that nothing may connect.
pub fn available() -> bool {
    #[cfg(target_os = "android")]
    {
        android::ready()
    }
    #[cfg(windows)]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        linux::available()
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    {
        false
    }
}

/// One-time platform setup before any credential use or network request.
/// Blocking (Android calls into Kotlin, Linux probes the session D-Bus); run it
/// on a worker thread.
pub fn prepare(app: &tauri::AppHandle) -> bool {
    prepare_with_retry(app, false)
}

/// Explicit user action may retry a previously unavailable Linux keyring
/// immediately instead of waiting for the status probe cooldown.
pub fn prepare_force(app: &tauri::AppHandle) -> bool {
    prepare_with_retry(app, true)
}

fn prepare_with_retry(app: &tauri::AppHandle, force: bool) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux::prepare(force)
    }
    #[cfg(target_os = "android")]
    {
        let _ = force;
        android::prepare(app)
    }
    #[cfg(windows)]
    {
        let _ = (app, force);
        true
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    {
        let _ = (app, force);
        false
    }
}

pub fn save(app: &tauri::AppHandle, connection_id: &str, password: &str) -> Result<()> {
    #[cfg(windows)]
    {
        windows::save(&app.config().identifier, connection_id, password)
    }
    #[cfg(target_os = "android")]
    {
        android::save(app, connection_id, password)
    }
    #[cfg(target_os = "linux")]
    {
        linux::save(app, connection_id, password)
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    {
        let _ = (app, connection_id, password);
        Err(Failure::new(FailureCode::NativeBridgeUnavailable))
    }
}

pub fn load(app: &tauri::AppHandle, connection_id: &str) -> Result<String> {
    #[cfg(windows)]
    {
        windows::load(&app.config().identifier, connection_id)
    }
    #[cfg(target_os = "android")]
    {
        android::load(app, connection_id)
    }
    #[cfg(target_os = "linux")]
    {
        linux::load(app, connection_id)
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    {
        let _ = (app, connection_id);
        Err(Failure::new(FailureCode::NativeBridgeUnavailable))
    }
}

pub fn delete(app: &tauri::AppHandle, connection_id: &str) -> Result<()> {
    #[cfg(windows)]
    {
        windows::delete(&app.config().identifier, connection_id)
    }
    #[cfg(target_os = "android")]
    {
        android::delete(app, connection_id)
    }
    #[cfg(target_os = "linux")]
    {
        linux::delete(app, connection_id)
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    {
        let _ = (app, connection_id);
        Err(Failure::new(FailureCode::NativeBridgeUnavailable))
    }
}

#[cfg(windows)]
mod windows;

#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "android")]
pub(crate) use android::plugin;
