//! One local `.sdr/metadata.epub.lua` read and a confirmed progress commit.
//! The bytes are not executed. Paths inside them are not stored.
mod commands;
mod state;

use crate::portable_state::{PortableError, PortableResult};
pub(crate) use commands::*;
pub(crate) use state::KoreaderImportState;

pub(crate) const SIDECAR_BYTE_LIMIT: u64 = 8 * 1024 * 1024;

fn error(code: &'static str, message: &str) -> PortableError {
    PortableError {
        code: code.into(),
        message: message.into(),
        legacy_fallback_allowed: None,
    }
}

pub(super) fn map_fault(fault: crate::native_zip_session::Fault) -> PortableError {
    use crate::native_zip_session::Fault;
    match fault {
        Fault::Closed => error("cancelled", "侧车读取已关闭"),
        Fault::SourceChanged => error("source-changed", "侧车或原书在读取期间已变化"),
        Fault::InvalidRequest => error("invalid-request", "侧车读取范围无效"),
        _ => error("source-unavailable", "侧车无法读取或校验失败"),
    }
}

pub(crate) fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<KoreaderImportState>() {
        state.shutdown();
    }
}

#[cfg(test)]
mod tests;
