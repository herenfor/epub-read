//! Stable book-source failures; presentation/localization belongs to the UI.
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkedLibraryError {
    pub code: String,
    pub message: String,
}

impl LinkedLibraryError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub(crate) fn changed(message: impl Into<String>) -> Self {
        Self::new("source-changed", message)
    }
    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self::new("source-unavailable", message)
    }
}
impl From<String> for LinkedLibraryError {
    fn from(message: String) -> Self {
        Self::new("failed", message)
    }
}
impl From<&str> for LinkedLibraryError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}
impl std::fmt::Display for LinkedLibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for LinkedLibraryError {}
