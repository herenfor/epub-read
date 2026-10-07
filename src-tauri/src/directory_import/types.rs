//! Frozen FI native facade DTOs.
//!
//! These types intentionally mirror `contract.ts` and use camelCase on the IPC
//! wire.  They are local-job descriptions only: no EPUB bytes, absolute paths
//! or source handles may appear in an exported/portable state.

use serde::{Deserialize, Serialize};

pub const PAGE_MAX_ITEMS: usize = 128;
pub const PAGE_MAX_JSON_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRoot {
    pub source_root_key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedEpub {
    pub input_id: String,
    pub relative_parent_segments: Vec<String>,
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_hint: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub job_id: String,
    pub root: ImportRoot,
    pub input_count: usize,
    pub skipped_directory_count: usize,
    pub unreadable_directory_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryBinding {
    pub group_key: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPage {
    pub items: Vec<ScannedEpub>,
    pub bindings: Vec<DirectoryBinding>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum FolderTarget {
    Reuse {
        group_key: String,
        folder_id: String,
    },
    Create {
        group_key: String,
        folder_id: String,
        name: String,
    },
}

impl FolderTarget {
    pub fn group_key(&self) -> &str {
        match self {
            Self::Reuse { group_key, .. } | Self::Create { group_key, .. } => group_key,
        }
    }

    pub fn folder_id(&self) -> &str {
        match self {
            Self::Reuse { folder_id, .. } | Self::Create { folder_id, .. } => folder_id,
        }
    }

    pub fn create_name(&self) -> Option<&str> {
        match self {
            Self::Create { name, .. } => Some(name),
            Self::Reuse { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub grouping: GroupingMode,
    pub loose_root_books: LooseRootBooks,
    pub existing_placement: ExistingPlacement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupingMode {
    Auto,
    SingleFolder,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LooseRootBooks {
    Root,
    NamedFolder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExistingPlacement {
    FillUnclassified,
    PreserveAll,
    Replace,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub completed: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub placement_skipped: usize,
    pub created_folders: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryProgress {
    pub job_id: String,
    pub phase: ProgressPhase,
    pub scanned_inputs: usize,
    pub total_inputs: Option<usize>,
    pub counts: ImportCounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressPhase {
    Scanning,
    Preparing,
    Committing,
    Cleaning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryImportResult {
    pub job_id: String,
    pub status: ImportJobStatus,
    pub counts: ImportCounts,
    pub issue_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportJobStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssue {
    pub input_id: String,
    pub kind: ImportIssueKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportIssueKind {
    SourceFailed,
    PlacementChanged,
    TargetDeleted,
    MultipleSources,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub items: Vec<ImportIssue>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DirectoryPickResult {
    Path { path: String },
    TreeUri { uri: String },
}

/// Native-only sidecar for one scanned candidate.  It is never serialized to
/// the front end; the public page contains only [`ScannedEpub`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntrySource {
    Path(std::path::PathBuf),
    /// Android child document URI.  The tree grant itself is held by the job.
    TreeUri(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedEntry {
    pub epub: ScannedEpub,
    pub source: EntrySource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DirectorySource {
    Path { path: String },
    TreeUri { uri: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCancelReply {
    pub status: CancelStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelStatus {
    Requested,
    Settling,
    AlreadyFinished,
}

#[cfg(test)]
mod tests {
    use super::FolderTarget;

    #[test]
    fn folder_targets_use_frontend_camel_case_fields() {
        for wire in [
            serde_json::json!({"kind":"reuse", "groupKey":"group", "folderId":"folder"}),
            serde_json::json!({"kind":"create", "groupKey":"group", "folderId":"folder", "name":"分类"}),
        ] {
            let target: FolderTarget = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(target.group_key(), "group");
            assert_eq!(target.folder_id(), "folder");
            assert_eq!(serde_json::to_value(target).unwrap(), wire);
        }
    }
}
