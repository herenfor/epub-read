//! Shared S3 wire types. Credentials deliberately have no Serialize/Debug.
use super::{remote::RemoteError, SyncError};
use crate::portable_state::{PortableError, PortableStateV3};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureCode {
    Remote,
    InvalidConfig,
    StorageError,
    UnsupportedLocalVersion,
    LocalStateInvalid,
    RepositoryNotReady,
    RepositoryError,
    CredentialUnavailable,
    CredentialCleanupFailed,
    NativeBridgeUnavailable,
    SpaceChanged,
    UnsupportedSyncVersion,
    WriterIdentityConflict,
    InvalidData,
    EventCollision,
    OwnFileUnread,
    ProbeExpired,
    ConfirmationRequired,
    Busy,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: FailureCode,
    pub remote: Option<RemoteError>,
    pub repository_code: Option<String>,
}

impl Failure {
    pub fn new(code: FailureCode) -> Self {
        Self {
            code,
            remote: None,
            repository_code: None,
        }
    }

    pub fn retryable(&self) -> bool {
        if self.code == FailureCode::RepositoryNotReady {
            return true;
        }
        self.remote.as_ref().is_some_and(|e| {
            matches!(
                e.code,
                super::remote::RemoteErrorCode::Network
                    | super::remote::RemoteErrorCode::Timeout
                    | super::remote::RemoteErrorCode::RateLimited
                    | super::remote::RemoteErrorCode::Locked
                    | super::remote::RemoteErrorCode::ServerError
            ) && (e.code != super::remote::RemoteErrorCode::ServerError
                || e.http_status.is_none_or(|s| s >= 500))
        })
    }
}

impl From<RemoteError> for Failure {
    fn from(error: RemoteError) -> Self {
        let mut result = Self::new(if error.code == super::remote::RemoteErrorCode::Cancelled {
            FailureCode::Cancelled
        } else {
            FailureCode::Remote
        });
        result.remote = Some(error);
        result
    }
}

impl From<PortableError> for Failure {
    fn from(error: PortableError) -> Self {
        let mut result = Self::new(FailureCode::RepositoryError);
        result.repository_code = Some(error.code);
        result
    }
}

impl From<SyncError> for Failure {
    fn from(error: SyncError) -> Self {
        Self::new(match error {
            SyncError::InvalidData => FailureCode::InvalidData,
            SyncError::EventCollision => FailureCode::EventCollision,
            SyncError::UnsupportedSyncVersion => FailureCode::UnsupportedSyncVersion,
            SyncError::WriterIdentityConflict => FailureCode::WriterIdentityConflict,
            SyncError::OwnFileUnread => FailureCode::OwnFileUnread,
            SyncError::LocalStateInvalid => FailureCode::LocalStateInvalid,
        })
    }
}

pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub base_url: String,
    pub remote_root: String,
    pub username: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput {
    pub base_url: String,
    pub remote_root: String,
    pub username: String,
    pub app_password: String,
}

pub use super::DeviceInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPreview {
    pub probe_id: String,
    pub existing_space_id: Option<String>,
    pub cloud_book_count: usize,
    pub devices: Vec<DeviceInfo>,
    pub issues: Vec<super::FileIssue>,
    pub capabilities: super::remote::Capabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub connection_id: String,
    #[serde(flatten)]
    pub settings: Settings,
    pub space_id: String,
    pub device_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Disconnected,
    Idle,
    Queued,
    Syncing,
    Waiting,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub native_ready: bool,
    pub connection: Option<ConnectionInfo>,
    pub phase: Phase,
    pub last_success_at_ms: Option<u64>,
    pub retry_at_ms: Option<u64>,
    pub last_error: Option<Failure>,
    pub pending: bool,
    pub local_changed: bool,
    pub issues: Vec<super::FileIssue>,
    pub device_count: usize,
    pub cloud_only_book_count: usize,
    pub local_recovery_saved: bool,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            native_ready: super::secrets::available(),
            connection: None,
            phase: Phase::Disconnected,
            last_success_at_ms: None,
            retry_at_ms: None,
            last_error: None,
            pending: false,
            local_changed: false,
            issues: Vec::new(),
            device_count: 0,
            cloud_only_book_count: 0,
            local_recovery_saved: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Trigger {
    Manual,
    Startup,
    Foreground,
    ReaderClosed,
    DataChanged,
    ProgressChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub foreground: bool,
    pub interaction_busy: bool,
}

impl Default for Activity {
    fn default() -> Self {
        Self {
            foreground: true,
            interaction_busy: false,
        }
    }
}

pub struct LocalSnapshot {
    pub state: PortableStateV3,
    pub bound: BTreeSet<String>,
}

pub struct Applied {
    pub snapshot: LocalSnapshot,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBook {
    pub content_hash: String,
    pub title: String,
    pub creator: String,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn uuid() -> Result<String> {
    crate::portable_state::random_uuid_v4().map_err(|_| Failure::new(FailureCode::StorageError))
}
