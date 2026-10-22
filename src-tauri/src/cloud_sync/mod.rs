//! Cloud state planning and remote storage. No automatic jobs or database writes.
pub mod codec;
mod dav_xml;
pub mod remote;
use crate::portable_state::{
    merge_portable_states, select_local_import, valid_canonical_uuid, validate_portable_state,
    PortableStateV3,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const SPACE_FORMAT: &str = "epub-reader-sync-space";
pub const DEVICE_FORMAT: &str = "epub-reader-sync-device";
pub const FORMAT_VERSION: u64 = 1;
pub const STATE_VERSION: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncError {
    InvalidData,
    EventCollision,
    UnsupportedSyncVersion,
    WriterIdentityConflict,
    OwnFileUnread,
    LocalStateInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Space {
    pub format: String,
    pub format_version: u64,
    pub space_id: String,
    pub created_at_ms: u64,
}

fn future_version(value: Option<&serde_json::Value>, supported: u64) -> bool {
    value
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|v| v > supported)
}

/// Inspect version headers before strict DTO decoding so a new schema is never
/// treated as an empty/corrupt file that an old writer may overwrite.
pub fn parse_space(json: &[u8]) -> Result<Space, SyncError> {
    let value = bounded_json(json)?;
    if value.get("format").and_then(|v| v.as_str()) != Some(SPACE_FORMAT) {
        return Err(SyncError::InvalidData);
    }
    if future_version(value.get("formatVersion"), FORMAT_VERSION) {
        return Err(SyncError::UnsupportedSyncVersion);
    }
    let space: Space = serde_json::from_value(value).map_err(|_| SyncError::InvalidData)?;
    if space.format_version != FORMAT_VERSION
        || !valid_canonical_uuid(&space.space_id)
        || !crate::portable_state::safe_time(space.created_at_ms)
    {
        return Err(SyncError::InvalidData);
    }
    Ok(space)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceFile {
    pub format: String,
    pub format_version: u64,
    pub state_schema_version: u64,
    pub space_id: String,
    pub installation_id: String,
    pub writer_nonce: String,
    pub device_label: String,
    pub app_version: String,
    pub published_at_ms: u64,
    pub state: PortableStateV3,
}

fn bounded_json(json: &[u8]) -> Result<serde_json::Value, SyncError> {
    if json.len() as u64 > crate::transfer_policy::STATE_JSON_LIMIT {
        return Err(SyncError::InvalidData);
    }
    serde_json::from_slice(json).map_err(|_| SyncError::InvalidData)
}

fn normalized(mut state: PortableStateV3) -> Result<PortableStateV3, SyncError> {
    // v3 preferences have no causal clock. They must neither be published nor
    // applied. Absence, rather than explicit null, follows the strict v3 DTO.
    state.preferences = None;
    validate_portable_state(&state).map_err(|_| SyncError::InvalidData)?;
    merge_portable_states(&state, &state).map_err(|_| SyncError::InvalidData)
}

pub fn parse_device(
    json: &[u8],
    space_id: &str,
    installation_id: &str,
) -> Result<DeviceFile, SyncError> {
    let value = bounded_json(json)?;
    if value.get("format").and_then(|v| v.as_str()) != Some(DEVICE_FORMAT)
        || value.get("spaceId").and_then(|v| v.as_str()) != Some(space_id)
        || value.get("installationId").and_then(|v| v.as_str()) != Some(installation_id)
    {
        return Err(SyncError::InvalidData);
    }
    if future_version(value.get("formatVersion"), FORMAT_VERSION)
        || future_version(value.get("stateSchemaVersion"), STATE_VERSION)
        || future_version(
            value.get("state").and_then(|v| v.get("schemaVersion")),
            STATE_VERSION,
        )
    {
        return Err(SyncError::UnsupportedSyncVersion);
    }
    let mut file: DeviceFile = serde_json::from_value(value).map_err(|_| SyncError::InvalidData)?;
    if file.format_version != FORMAT_VERSION
        || file.state_schema_version != STATE_VERSION
        || !valid_canonical_uuid(&file.space_id)
        || !valid_canonical_uuid(&file.installation_id)
        || !valid_canonical_uuid(&file.writer_nonce)
        || file.device_label.trim().is_empty()
        || file.device_label.chars().count() > 128
        || file.app_version.is_empty()
        || file.app_version.len() > 128
        || !crate::portable_state::safe_time(file.published_at_ms)
    {
        return Err(SyncError::InvalidData);
    }
    file.state = normalized(file.state)?;
    Ok(file)
}

pub struct Writer<'a> {
    pub space_id: &'a str,
    pub installation_id: &'a str,
    pub nonce: &'a str,
    pub label: &'a str,
    pub app_version: &'a str,
    pub now_ms: u64,
}

/// Only a verified listing/404 may produce Absent. A network failure is Unread.
pub enum OwnRemote<'a> {
    Absent,
    Present(&'a [u8]),
    Unread,
}

/// S2 supplies all listed files, reusing validated cached bytes where unchanged.
/// JSON here is already decompressed; S2 must bound decompression too.
pub struct RemoteFile<'a> {
    pub installation_id: &'a str,
    pub json: &'a [u8],
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIssue {
    pub installation_id: String,
    pub code: SyncError,
}

pub struct RoundPlan {
    /// Full cloud history, including books absent locally. Persist separately.
    pub full: PortableStateV3,
    pub state_digest: String,
    /// JSON envelope only. S2 owns compression and safe publication.
    pub publication: Option<Vec<u8>>,
    pub issues: Vec<FileIssue>,
    /// Only these remote files may advance S3's successful seen-file cache.
    pub accepted_devices: Vec<String>,
    /// Hint only: S3 must pass `full` to merge_local_import_ref, which checks
    /// current bindings and local events again inside its transaction.
    pub apply_to_local: bool,
}

fn digest(state: &PortableStateV3) -> Result<String, SyncError> {
    let json = serde_json::to_vec(state).map_err(|_| SyncError::InvalidData)?;
    Ok(crate::save_file::hex_digest(&json))
}

pub fn plan_round(
    writer: &Writer<'_>,
    previous_view: Option<&PortableStateV3>,
    local: &PortableStateV3,
    locally_bound: &BTreeSet<String>,
    own: OwnRemote<'_>,
    remotes: &[RemoteFile<'_>],
) -> Result<RoundPlan, SyncError> {
    if !valid_canonical_uuid(writer.space_id)
        || !valid_canonical_uuid(writer.installation_id)
        || !valid_canonical_uuid(writer.nonce)
    {
        return Err(SyncError::WriterIdentityConflict);
    }
    let local_state = normalized(local.clone()).map_err(|_| SyncError::LocalStateInvalid)?;
    let mut full = normalized(
        previous_view
            .unwrap_or(&PortableStateV3 {
                schema_version: STATE_VERSION,
                books: BTreeMap::new(),
                organization: crate::library_organization::LibraryOrganization {
                    schema_version: 1,
                    folders: BTreeMap::new(),
                    books: BTreeMap::new(),
                },
                preferences: None,
            })
            .clone(),
    )
    .map_err(|_| SyncError::LocalStateInvalid)?;
    let mut accepted_devices = Vec::new();
    let own_digest = match own {
        OwnRemote::Unread => return Err(SyncError::OwnFileUnread),
        OwnRemote::Absent => None,
        OwnRemote::Present(json) => {
            let file = parse_device(json, writer.space_id, writer.installation_id)?;
            if file.writer_nonce != writer.nonce {
                return Err(SyncError::WriterIdentityConflict);
            }
            let checksum = digest(&file.state)?;
            full = merge_portable_states(&full, &file.state)
                .map_err(|_| SyncError::LocalStateInvalid)?;
            accepted_devices.push(file.installation_id);
            Some(checksum)
        }
    };
    // Check each incoming device against local events too. Otherwise an event
    // collision with local data would be discovered only after all files had
    // been accepted, preventing us from isolating just the offending file.
    full = merge_portable_states(&full, &local_state).map_err(|_| SyncError::LocalStateInvalid)?;
    let mut files = remotes.iter().collect::<Vec<_>>();
    files.sort_by_key(|f| f.installation_id);
    let mut issues = Vec::new();
    for remote in files {
        if remote.installation_id == writer.installation_id {
            return Err(SyncError::WriterIdentityConflict);
        }
        let result =
            parse_device(remote.json, writer.space_id, remote.installation_id).and_then(|file| {
                merge_portable_states(&full, &file.state).map_err(|_| SyncError::EventCollision)
            });
        match result {
            Ok(merged) => {
                full = merged;
                accepted_devices.push(remote.installation_id.to_string());
            }
            Err(SyncError::UnsupportedSyncVersion) => {
                return Err(SyncError::UnsupportedSyncVersion)
            }
            Err(code) => issues.push(FileIssue {
                installation_id: remote.installation_id.to_string(),
                code,
            }),
        }
    }
    let state_digest = digest(&full)?;
    let selection = select_local_import(&local_state, &full, locally_bound, &BTreeSet::new())
        .map_err(|_| SyncError::LocalStateInvalid)?;
    let projected = merge_portable_states(&local_state, &selection.state)
        .map_err(|_| SyncError::LocalStateInvalid)?;
    let apply_to_local = digest(&projected)? != digest(&local_state)?;
    let publication = if own_digest.as_ref() == Some(&state_digest) {
        None
    } else {
        let file = DeviceFile {
            format: DEVICE_FORMAT.to_string(),
            format_version: FORMAT_VERSION,
            state_schema_version: STATE_VERSION,
            space_id: writer.space_id.to_string(),
            installation_id: writer.installation_id.to_string(),
            writer_nonce: writer.nonce.to_string(),
            device_label: writer.label.to_string(),
            app_version: writer.app_version.to_string(),
            published_at_ms: writer.now_ms,
            state: full.clone(),
        };
        let json = serde_json::to_vec(&file).map_err(|_| SyncError::InvalidData)?;
        // The writer must obey the same envelope and size rules as readers.
        parse_device(&json, writer.space_id, writer.installation_id)?;
        Some(json)
    };
    Ok(RoundPlan {
        full,
        state_digest,
        publication,
        issues,
        accepted_devices,
        apply_to_local,
    })
}

#[cfg(test)]
mod tests;
