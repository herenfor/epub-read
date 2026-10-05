use serde::{Deserialize, Serialize};

pub(crate) const CONTROL_MAX_BYTES: usize = super::bulk_policy::CONTROL_LIMIT;
pub(crate) const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireOffer {
    pub session_id: String,
    pub transfer_id: String,
    pub archive_bytes: u64,
    pub book_bytes: u64,
    pub book_count: usize,
    pub attached_book_count: usize,
    pub reused_book_count: usize,
    pub skipped_book_count: usize,
    pub include_books: bool,
    pub has_preferences: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProcessingPhase {
    PreparingSend,
    Checking,
    Receiving,
    Preparing,
    Preview,
    Committing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LanCommitSummary {
    pub imported_book_count: u64,
    pub new_visible_book_count: u64,
    pub missing_book_count: u64,
    pub progress_conflict_book_count: u64,
    pub applied_preferences: bool,
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
        #[serde(rename = "bookBytes")]
        book_bytes: u64,
        #[serde(rename = "bookCount")]
        book_count: usize,
        #[serde(rename = "attachedBookCount")]
        attached_book_count: usize,
        #[serde(rename = "reusedBookCount")]
        reused_book_count: usize,
        #[serde(rename = "skippedBookCount")]
        skipped_book_count: usize,
        #[serde(rename = "includeBooks")]
        include_books: bool,
        #[serde(rename = "hasPreferences")]
        has_preferences: bool,
    },
    InventoryQuery {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(rename = "queryIndex")]
        query_index: u64,
        hashes: Vec<String>,
        last: bool,
    },
    InventoryReply {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(rename = "queryIndex")]
        query_index: u64,
        present: Vec<bool>,
    },
    Processing {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        sequence: u64,
        phase: ProcessingPhase,
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
        result: Option<LanCommitSummary>,
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
            | ControlMessage::InventoryQuery { session_id, .. }
            | ControlMessage::InventoryReply { session_id, .. }
            | ControlMessage::Processing { session_id, .. }
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
            | ControlMessage::InventoryQuery { transfer_id, .. }
            | ControlMessage::InventoryReply { transfer_id, .. }
            | ControlMessage::Processing { transfer_id, .. }
            | ControlMessage::Accept { transfer_id, .. }
            | ControlMessage::Decline { transfer_id, .. }
            | ControlMessage::Received { transfer_id, .. }
            | ControlMessage::Result { transfer_id, .. }
            | ControlMessage::Cancel { transfer_id, .. } => Some(transfer_id),
            ControlMessage::Error { transfer_id, .. } => transfer_id.as_deref(),
        }
    }
}
