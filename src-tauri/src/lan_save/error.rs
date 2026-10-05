use crate::save_file::SaveFileError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSaveError {
    pub code: String,
    pub message: String,
}

impl LanSaveError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid-request", message)
    }

    pub(crate) fn invalid_data(message: impl Into<String>) -> Self {
        Self::new("invalid-data", message)
    }

    pub(crate) fn invalid_state(message: impl Into<String>) -> Self {
        Self::new("invalid-state", message)
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new("not-found", message)
    }

    pub(crate) fn cancelled() -> Self {
        Self::new("cancelled", "传输已取消")
    }

    pub(crate) fn expired(message: impl Into<String>) -> Self {
        Self::new("expired", message)
    }

    pub(crate) fn unreachable(message: impl Into<String>) -> Self {
        Self::new("lan-unreachable", message)
    }

    pub(crate) fn pin_mismatch() -> Self {
        Self::new("pin-mismatch", "对端证书指纹与连接信息不一致")
    }

    pub(crate) fn token_mismatch() -> Self {
        Self::new("token-mismatch", "配对令牌校验失败")
    }

    pub(crate) fn storage(message: impl Into<String>) -> Self {
        Self::new("storage-error", message)
    }

    pub(crate) fn network(message: impl Into<String>) -> Self {
        Self::new("network", message)
    }

    pub(crate) fn secure(message: impl Into<String>) -> Self {
        Self::new("secure-error", message)
    }

    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Self::new("invalid-data", message)
    }
}

impl std::fmt::Display for LanSaveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LanSaveError {}

impl From<crate::portable_state::PortableError> for LanSaveError {
    fn from(error: crate::portable_state::PortableError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<SaveFileError> for LanSaveError {
    fn from(error: SaveFileError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<std::io::Error> for LanSaveError {
    fn from(error: std::io::Error) -> Self {
        Self::storage(format!("文件读写失败：{error}"))
    }
}

impl From<serde_json::Error> for LanSaveError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid_data(format!("控制帧 JSON 失败：{error}"))
    }
}

impl From<rustls::Error> for LanSaveError {
    fn from(error: rustls::Error) -> Self {
        Self::secure(format!("TLS 握手失败：{error}"))
    }
}
