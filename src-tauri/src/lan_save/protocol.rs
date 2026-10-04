use super::error::LanSaveError;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) const CONTROL_MAX_BYTES: usize = 64 * 1024;
pub(crate) const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireOffer {
    pub session_id: String,
    pub transfer_id: String,
    pub archive_bytes: u64,
    pub book_count: usize,
    pub attached_book_count: usize,
    pub include_books: bool,
    pub has_preferences: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase", deny_unknown_fields)]
pub(crate) enum ControlMessage {
    Hello {
        #[serde(rename = "sessionId")]
        session_id: String,
        token: String,
    },
    Paired {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
    Offer {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(rename = "archiveBytes")]
        archive_bytes: u64,
        #[serde(rename = "bookCount")]
        book_count: usize,
        #[serde(rename = "attachedBookCount")]
        attached_book_count: usize,
        #[serde(rename = "includeBooks")]
        include_books: bool,
        #[serde(rename = "hasPreferences")]
        has_preferences: bool,
    },
    Accept {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
    Decline {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        code: String,
        message: String,
    },
    Received {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(rename = "archiveBytes")]
        archive_bytes: u64,
    },
    Result {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        status: String,
        result: Option<serde_json::Value>,
        code: Option<String>,
        message: Option<String>,
    },
    Cancel {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        reason: String,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: Option<String>,
        code: String,
        message: String,
    },
}

impl ControlMessage {
    pub(crate) fn session_id(&self) -> &str {
        match self {
            ControlMessage::Hello { session_id, .. }
            | ControlMessage::Paired { session_id, .. }
            | ControlMessage::Offer { session_id, .. }
            | ControlMessage::Accept { session_id, .. }
            | ControlMessage::Decline { session_id, .. }
            | ControlMessage::Received { session_id, .. }
            | ControlMessage::Result { session_id, .. }
            | ControlMessage::Cancel { session_id, .. }
            | ControlMessage::Error { session_id, .. } => session_id,
        }
    }

    pub(crate) fn transfer_id(&self) -> Option<&str> {
        match self {
            ControlMessage::Hello { .. } => None,
            ControlMessage::Paired { transfer_id, .. }
            | ControlMessage::Offer { transfer_id, .. }
            | ControlMessage::Accept { transfer_id, .. }
            | ControlMessage::Decline { transfer_id, .. }
            | ControlMessage::Received { transfer_id, .. }
            | ControlMessage::Result { transfer_id, .. }
            | ControlMessage::Cancel { transfer_id, .. } => Some(transfer_id),
            ControlMessage::Error { transfer_id, .. } => transfer_id.as_deref(),
        }
    }
}

pub(crate) async fn read_control_message<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<ControlMessage, LanSaveError> {
    let mut length_bytes = [0_u8; 4];
    reader
        .read_exact(&mut length_bytes)
        .await
        .map_err(|error| LanSaveError::network(format!("读取控制帧长度失败：{error}")))?;
    let length = u32::from_be_bytes(length_bytes) as usize;
    if length > CONTROL_MAX_BYTES {
        return Err(LanSaveError::protocol(format!(
            "控制帧长度 {length} 超过 64KiB"
        )));
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|error| LanSaveError::network(format!("读取控制帧内容失败：{error}")))?;
    let message: ControlMessage = serde_json::from_slice(&payload)
        .map_err(|error| LanSaveError::protocol(format!("控制帧 JSON 无法解析：{error}")))?;
    Ok(message)
}

pub(crate) async fn write_control_message<W: AsyncWrite + Unpin>(
    writer: &mut W,
    message: &ControlMessage,
) -> Result<(), LanSaveError> {
    let payload = serde_json::to_vec(message)
        .map_err(|error| LanSaveError::invalid_data(format!("控制帧无法编码：{error}")))?;
    if payload.len() > CONTROL_MAX_BYTES {
        return Err(LanSaveError::protocol("控制帧超过 64KiB"));
    }
    let length = payload.len() as u32;
    writer
        .write_all(&length.to_be_bytes())
        .await
        .map_err(|error| LanSaveError::network(format!("写入控制帧长度失败：{error}")))?;
    writer
        .write_all(&payload)
        .await
        .map_err(|error| LanSaveError::network(format!("写入控制帧内容失败：{error}")))?;
    // tokio-rustls buffers writes; flush is mandatory before waiting for a peer
    // response or beginning the raw archive stream.
    writer
        .flush()
        .await
        .map_err(|error| LanSaveError::network(format!("刷新控制帧失败：{error}")))?;
    Ok(())
}
