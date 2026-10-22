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
    #[cfg(not(target_os = "android"))]
    {
        cfg!(windows)
    }
}

/// One-time platform setup before any credential use or network request.
/// Blocking (Android calls into Kotlin); run it on a worker thread.
pub fn prepare(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "android")]
    {
        android::prepare(app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        available()
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
    #[cfg(not(any(windows, target_os = "android")))]
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
    #[cfg(not(any(windows, target_os = "android")))]
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
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, connection_id);
        Err(Failure::new(FailureCode::NativeBridgeUnavailable))
    }
}

#[cfg(windows)]
mod windows;

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
pub(crate) use android::plugin;
