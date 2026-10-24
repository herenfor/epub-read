//! Versioned sync sidecar; the library SQLite schema is deliberately unchanged.
use super::{
    codec,
    model::*,
    remote::{Cancel, Capabilities},
    Space,
};
use crate::portable_state::{valid_canonical_uuid, validate_portable_state, PortableStateV3};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeenFile {
    pub device: DeviceInfo,
    pub writer_nonce: String,
}
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const VERSION: u64 = 1;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub schema_version: u64,
    pub installation_id: String,
    pub nonce: String,
}

impl Identity {
    pub fn fresh() -> Result<Self> {
        Ok(Self {
            schema_version: VERSION,
            installation_id: uuid()?,
            nonce: uuid()?,
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub schema_version: u64,
    pub connection_id: String,
    pub settings: Settings,
    pub space: Space,
    pub capabilities: Capabilities,
    pub device_label: String,
    pub remote_view: Option<PortableStateV3>,
    pub last_success_at_ms: Option<u64>,
    pub devices: Vec<DeviceInfo>,
    pub cloud_only_book_count: usize,
    pub seen: BTreeMap<String, SeenFile>,
    pub pending_upload: bool,
}

impl Session {
    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            connection_id: self.connection_id.clone(),
            settings: self.settings.clone(),
            space_id: self.space.space_id.clone(),
            device_label: self.device_label.clone(),
        }
    }
}

#[derive(Clone)]
pub struct Disk {
    pub root: PathBuf,
}

fn storage() -> Failure {
    Failure::new(FailureCode::StorageError)
}

pub(super) fn read(path: &Path, limit: usize) -> Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage()),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| storage())?;
    if bytes.len() > limit {
        return Err(Failure::new(FailureCode::LocalStateInvalid));
    }
    Ok(Some(bytes))
}

fn version(json: &[u8]) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        schema_version: u64,
        remote_view: Option<StateHeader>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StateHeader {
        schema_version: u64,
    }
    let header: Header =
        serde_json::from_slice(json).map_err(|_| Failure::new(FailureCode::LocalStateInvalid))?;
    if header.schema_version > VERSION {
        return Err(Failure::new(FailureCode::UnsupportedLocalVersion));
    }
    if header
        .remote_view
        .is_some_and(|state| state.schema_version > super::STATE_VERSION)
    {
        return Err(Failure::new(FailureCode::UnsupportedLocalVersion));
    }
    if header.schema_version != VERSION {
        return Err(Failure::new(FailureCode::LocalStateInvalid));
    }
    Ok(())
}

impl Disk {
    pub fn load(&self, cancel: &Cancel) -> Result<Option<Session>> {
        let Some(bytes) = read(&self.root.join("connection.json.gz"), codec::GZIP_LIMIT)? else {
            return Ok(None);
        };
        let json = codec::decode(&bytes, cancel).map_err(|e| {
            if e.code == super::remote::RemoteErrorCode::Cancelled {
                Failure::from(e)
            } else {
                Failure::new(FailureCode::LocalStateInvalid)
            }
        })?;
        version(&json)?;
        let session: Session = serde_json::from_slice(&json)
            .map_err(|_| Failure::new(FailureCode::LocalStateInvalid))?;
        if !valid_canonical_uuid(&session.connection_id)
            || session.device_label.trim().is_empty()
            || session.device_label.chars().count() > 128
        {
            return Err(Failure::new(FailureCode::LocalStateInvalid));
        }
        super::parse_space(&serde_json::to_vec(&session.space).map_err(|_| storage())?).map_err(
            |error| {
                if error == super::SyncError::UnsupportedSyncVersion {
                    Failure::new(FailureCode::UnsupportedSyncVersion)
                } else {
                    Failure::new(FailureCode::LocalStateInvalid)
                }
            },
        )?;
        if let Some(full) = &session.remote_view {
            validate_portable_state(full)
                .map_err(|_| Failure::new(FailureCode::LocalStateInvalid))?;
        }
        Ok(Some(session))
    }

    pub fn save(&self, session: &Session, cancel: &Cancel) -> Result<()> {
        let json = serde_json::to_vec(session).map_err(|_| storage())?;
        let bytes = codec::encode(&json, cancel)?;
        self.atomic("connection.json.gz", &bytes)
    }

    pub fn identity(&self) -> Result<Identity> {
        let Some(json) = read(&self.root.join("identity.json"), 4096)? else {
            let identity = Identity::fresh()?;
            self.save_identity(&identity)?;
            return Ok(identity);
        };
        version(&json)?;
        let identity: Identity = serde_json::from_slice(&json)
            .map_err(|_| Failure::new(FailureCode::LocalStateInvalid))?;
        if !valid_canonical_uuid(&identity.installation_id)
            || !valid_canonical_uuid(&identity.nonce)
        {
            return Err(Failure::new(FailureCode::LocalStateInvalid));
        }
        Ok(identity)
    }

    pub fn save_identity(&self, identity: &Identity) -> Result<()> {
        self.atomic(
            "identity.json",
            &serde_json::to_vec(identity).map_err(|_| storage())?,
        )
    }

    pub fn disconnect(&self) -> Result<()> {
        self.clear_sources()?;
        match fs::remove_file(self.root.join("connection.json.gz")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(storage()),
        }
    }

    /// Explicit disconnect can set aside corruption without deleting the book
    /// library. Callers must not use this to bypass a newer sidecar version.
    pub fn quarantine(&self) -> Result<()> {
        let path = self.root.join("connection.json.gz");
        let recovery = self
            .root
            .join(format!("connection-recovery-{}.json.gz", uuid()?));
        fs::rename(path, recovery).map_err(|_| storage())
    }

    pub(super) fn atomic(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.root).map_err(|_| storage())?;
        let temp = self.root.join(format!(".{name}.{}.tmp", uuid()?));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp).map_err(|_| storage())?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| storage())?;
            drop(file);
            crate::linked_library::replace_file_atomically(&temp, &self.root.join(name))
                .map_err(|_| storage())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}
