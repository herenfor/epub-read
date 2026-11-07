//! Read-only Readest backup sessions and confirmed local record migration.
//! No source books, settings, external clocks or foreign tombstones are imported.
mod commands;
mod source;
mod state;

use crate::portable_state::{PortableError, PortableResult};
pub(crate) use commands::*;
pub(crate) use state::ReadestImportState;

fn error(code: &'static str, message: &str) -> PortableError {
    PortableError {
        code: code.into(),
        message: message.into(),
        legacy_fallback_allowed: None,
    }
}
fn valid_hash(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn fault(fault: crate::native_zip_session::Fault) -> PortableError {
    use crate::native_zip_session::Fault;
    match fault {
        Fault::Closed => error("cancelled", "备份读取已关闭"),
        Fault::SourceChanged => error("source-changed", "备份或原书在读取期间已变化"),
        Fault::InvalidRequest => error("invalid-request", "备份读取范围无效"),
        _ => error("invalid-backup", "备份归档无法读取或校验失败"),
    }
}

pub(crate) fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<ReadestImportState>() {
        state.shutdown();
    }
}

#[cfg(test)]
mod tests;
