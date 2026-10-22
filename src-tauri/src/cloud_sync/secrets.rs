//! Native credential backend. No filesystem plaintext fallback in the product.
use super::model::{Failure, FailureCode, Result};

pub fn available() -> bool {
    cfg!(windows)
}

pub fn save(app: &tauri::AppHandle, connection_id: &str, password: &str) -> Result<()> {
    #[cfg(windows)]
    {
        windows::save(&app.config().identifier, connection_id, password)
    }
    #[cfg(not(windows))]
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
    #[cfg(not(windows))]
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
    #[cfg(not(windows))]
    {
        let _ = (app, connection_id);
        Err(Failure::new(FailureCode::NativeBridgeUnavailable))
    }
}

#[cfg(windows)]
mod windows;
