//! Stable error shape for the unregistered portable-state repository.
//!
//! The S0 commands are not registered yet, but integration will map this to
//! the repository wire error object `{ code, message }`.

use serde::Serialize;

pub type PortableResult<T> = std::result::Result<T, PortableError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableError {
    pub code: String,
    pub message: String,
}

impl PortableError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn invalid_data(message: impl Into<String>) -> Self {
        Self::new("invalid-data", message)
    }

    pub fn invalid_entity(message: impl Into<String>) -> Self {
        Self::new("invalid-entity", message)
    }

    pub fn invalid_choice(message: impl Into<String>) -> Self {
        Self::new("invalid-choice", message)
    }

    pub fn invalid_intent(message: impl Into<String>) -> Self {
        Self::new("invalid-intent", message)
    }

    pub fn stale_basis(message: impl Into<String>) -> Self {
        Self::new("stale-basis", message)
    }

    pub fn stale_choice(message: impl Into<String>) -> Self {
        Self::new("stale-choice", message)
    }

    pub fn deleted_entity(message: impl Into<String>) -> Self {
        Self::new("deleted-entity", message)
    }

    pub fn clock_exhausted(message: impl Into<String>) -> Self {
        Self::new("clock-exhausted", message)
    }

    pub fn storage_error(message: impl Into<String>) -> Self {
        Self::new("storage-error", message)
    }
}

impl std::fmt::Display for PortableError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PortableError {}

impl From<rusqlite::Error> for PortableError {
    fn from(error: rusqlite::Error) -> Self {
        Self::storage_error(format!("资料库读写失败：{error}"))
    }
}
