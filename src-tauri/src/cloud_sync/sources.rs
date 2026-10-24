//! Optional display metadata, separate from the strict v2 state envelope.
//! An uploader relays other writers' events: only its SQLite identity can
//! declare which progress writer it represents. Names never select a version.
use super::{
    engine::blocking,
    model::*,
    remote::*,
    storage::{self, Disk, Identity, Session},
};
use crate::portable_state::{valid_canonical_uuid, valid_content_hash};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const CACHE: &str = "progress-sources.json";
const FILE_LIMIT: usize = 4096;
const FILE_COUNT: usize = 512;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Declaration {
    format: String,
    format_version: u64,
    space_id: String,
    installation_id: String,
    writer_nonce: String,
    event_device_id: String,
    device_name: String,
    published_at_ms: u64,
}

impl Declaration {
    fn name(&self) -> Result<String> {
        let key = serde_json::to_vec(self).map_err(|_| Failure::new(FailureCode::InvalidData))?;
        Ok(format!(
            "{}.source-v1.{}.json",
            self.installation_id,
            crate::save_file::hex_digest(&key)
        ))
    }

    fn valid(&self, name: &str, space: &str) -> bool {
        self.format == "epub-reader-progress-source"
            && self.format_version == 1
            && self.space_id == space
            && valid_canonical_uuid(&self.installation_id)
            && valid_canonical_uuid(&self.writer_nonce)
            && valid_canonical_uuid(&self.event_device_id)
            && !self.device_name.trim().is_empty()
            && self.device_name.chars().count() <= 128
            && crate::portable_state::safe_time(self.published_at_ms)
            && self.name().is_ok_and(|expected| expected == name)
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Catalog {
    schema_version: u64,
    connection_id: String,
    space_id: String,
    files: BTreeMap<String, Declaration>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSource {
    pub event_device_id: String,
    pub device_name: Option<String>,
    pub is_local: bool,
}

impl Disk {
    pub(super) fn sources(&self, connection: &ConnectionInfo) -> Result<Catalog> {
        let bytes = storage::read(&self.root.join(CACHE), FILE_LIMIT * FILE_COUNT)?;
        // This file is a disposable display cache, never a progress journal.
        // Corruption/loss simply rebuilds from complete remote declarations.
        let catalog = bytes.and_then(|bytes| serde_json::from_slice::<Catalog>(&bytes).ok());
        Ok(catalog
            .filter(|c| {
                c.schema_version == 1
                    && c.connection_id == connection.connection_id
                    && c.space_id == connection.space_id
                    && c.files.len() <= FILE_COUNT
                    && c.files.iter().all(|(n, d)| d.valid(n, &c.space_id))
            })
            .unwrap_or_else(|| Catalog {
                schema_version: 1,
                connection_id: connection.connection_id.clone(),
                space_id: connection.space_id.clone(),
                files: BTreeMap::new(),
            }))
    }

    pub(super) fn clear_sources(&self) -> Result<()> {
        match std::fs::remove_file(self.root.join(CACHE)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(Failure::new(FailureCode::StorageError)),
        }
    }
}

fn source_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((id, hash)) = stem.split_once(".source-v1.") else {
        return false;
    };
    valid_canonical_uuid(id) && valid_content_hash(hash)
}

fn path(name: &str) -> Result<RemotePath> {
    Ok(RemotePath::new("devices")?.child(name)?)
}

/// Uses the same bounded PROPFIND as the state engine. Old v2 clients ignore
/// these .json display files, so no shared head/root/DTO upgrade is necessary.
pub(super) async fn sync(
    remote: &impl SyncRemote,
    entries: Vec<RemoteEntry>,
    disk: &Disk,
    session: &Session,
    identity: &Identity,
    event_device_id: Option<&str>,
    cancel: &Cancel,
) -> Result<()> {
    let store = disk.clone();
    let saved = session.info();
    let mut catalog = blocking(move || store.sources(&saved)).await?;
    let names = entries
        .iter()
        .filter(|e| !e.is_collection && source_name(&e.name))
        .map(|e| e.name.clone())
        .collect::<BTreeSet<_>>();
    if names.len() > FILE_COUNT {
        return Err(RemoteError::new(RemoteErrorCode::SizeLimit).into());
    }
    catalog.files.retain(|name, _| names.contains(name));
    for name in names {
        cancel.check()?;
        if catalog.files.contains_key(&name) {
            continue;
        }
        let bytes = match remote.get(&path(&name)?, None, FILE_LIMIT, cancel).await? {
            ReadResult::Content { bytes, .. } => bytes,
            ReadResult::Missing => continue,
            ReadResult::NotModified => return Err(Failure::new(FailureCode::InvalidData)),
        };
        if let Ok(declaration) = serde_json::from_slice::<Declaration>(&bytes) {
            if declaration.valid(&name, &catalog.space_id) {
                catalog.files.insert(name, declaration);
            }
        }
        // A malformed optional name must not discard valid progress data.
    }
    // Link only to state publishers whose envelope+nonce were actually read
    // and accepted. A declaration alone cannot impersonate a relayed event.
    catalog.files.retain(|_, d| {
        session.seen.values().any(|s| {
            s.device.installation_id == d.installation_id && s.writer_nonce == d.writer_nonce
        })
    });
    let pending = format!(
        ".{}.{}.source-pending",
        identity.installation_id, identity.nonce
    );
    if let Some(event_id) = event_device_id {
        let previous = catalog
            .files
            .iter()
            .filter(|(_, d)| {
                d.installation_id == identity.installation_id && d.writer_nonce == identity.nonce
            })
            .max_by_key(|(name, d)| (d.published_at_ms, *name));
        let unchanged = previous.filter(|(_, d)| {
            d.event_device_id == event_id && d.device_name == session.device_label
        });
        // A -> B -> A is a real rename, even while A's old generation remains.
        // This monotonic timestamp orders display names only, never progress.
        let published_at_ms = previous.map_or(now_ms(), |(_, d)| {
            now_ms().max(d.published_at_ms.saturating_add(1))
        });
        let declaration = Declaration {
            format: "epub-reader-progress-source".into(),
            format_version: 1,
            space_id: catalog.space_id.clone(),
            installation_id: identity.installation_id.clone(),
            writer_nonce: identity.nonce.clone(),
            event_device_id: event_id.into(),
            device_name: session.device_label.clone(),
            published_at_ms,
        };
        let current = match unchanged {
            Some((name, _)) => name.clone(),
            None => declaration.name()?,
        };
        if unchanged.is_none() && !declaration.valid(&current, &catalog.space_id) {
            return Err(Failure::new(FailureCode::LocalStateInvalid));
        }
        if !catalog.files.contains_key(&current) {
            let json = serde_json::to_vec(&declaration)
                .map_err(|_| Failure::new(FailureCode::InvalidData))?;
            match publish_prepared(
                remote,
                &path(&pending)?,
                &path(&current)?,
                json,
                false,
                cancel,
            )
            .await
            {
                Ok(()) => {
                    catalog.files.insert(current.clone(), declaration);
                }
                Err(e) if matches!(e.http_status, Some(409 | 412)) && !e.cleanup_failed => {
                    // Ambiguous MOVE completion: accept only a verified complete
                    // identical declaration, never overwrite another object.
                    let read = remote
                        .get(&path(&current)?, None, FILE_LIMIT, cancel)
                        .await?;
                    let ReadResult::Content { bytes, .. } = read else {
                        return Err(e.into());
                    };
                    let existing: Declaration = serde_json::from_slice(&bytes)
                        .map_err(|_| Failure::new(FailureCode::InvalidData))?;
                    if !existing.valid(&current, &catalog.space_id) {
                        return Err(Failure::new(FailureCode::InvalidData));
                    }
                    catalog.files.insert(current.clone(), existing);
                }
                Err(e) => return Err(e.into()),
            }
        }
        // New complete declaration is visible first. Only validated files
        // belonging to this identity+nonce can be reclaimed; keep one backup.
        let mut old = catalog
            .files
            .iter()
            .filter(|(n, d)| {
                **n != current
                    && d.installation_id == identity.installation_id
                    && d.writer_nonce == identity.nonce
            })
            .map(|(n, d)| (n.clone(), d.published_at_ms))
            .collect::<Vec<_>>();
        old.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
        for (name, _) in old.into_iter().skip(1) {
            remote
                .delete(&path(&name)?, false, cancel)
                .await
                .map_err(|mut e| {
                    e.cleanup_failed = true;
                    e
                })?;
            catalog.files.remove(&name);
        }
    }
    if entries
        .iter()
        .any(|e| !e.is_collection && e.name == pending)
    {
        remote
            .delete(&path(&pending)?, false, cancel)
            .await
            .map_err(|mut e| {
                e.cleanup_failed = true;
                e
            })?;
    }
    let store = disk.clone();
    blocking(move || {
        store.atomic(
            CACHE,
            &serde_json::to_vec(&catalog).map_err(|_| Failure::new(FailureCode::StorageError))?,
        )
    })
    .await
}

impl Catalog {
    pub(super) fn query(
        &self,
        ids: Vec<String>,
        local: Option<&str>,
        label: Option<&str>,
    ) -> Result<Vec<ProgressSource>> {
        if ids.len() > 128 || ids.iter().any(|id| !valid_canonical_uuid(id)) {
            return Err(Failure::new(FailureCode::InvalidConfig));
        }
        let mut latest = BTreeMap::<&str, (&str, &Declaration)>::new();
        for (name, d) in &self.files {
            let candidate = (d.published_at_ms, name.as_str());
            let old = latest.get(d.installation_id.as_str());
            if old.is_none_or(|(n, old)| candidate > (old.published_at_ms, *n)) {
                latest.insert(&d.installation_id, (name, d));
            }
        }
        let mut seen = BTreeSet::new();
        Ok(ids
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .map(|id| {
                let is_local = local == Some(id.as_str());
                let claimants = latest
                    .values()
                    .filter(|(_, d)| d.event_device_id == id)
                    .map(|(_, d)| d)
                    .collect::<Vec<_>>();
                let device_name = if is_local {
                    label.map(str::to_owned)
                } else if claimants.len() == 1 {
                    Some(claimants[0].device_name.clone())
                } else {
                    None
                };
                ProgressSource {
                    event_device_id: id,
                    device_name,
                    is_local,
                }
            })
            .collect())
    }
}

pub(super) fn query(
    disk: &Disk,
    connection: Option<&ConnectionInfo>,
    local: Option<&str>,
    ids: Vec<String>,
) -> Result<Vec<ProgressSource>> {
    let catalog = match connection {
        Some(s) => disk.sources(s)?,
        None => Catalog::default(),
    };
    catalog.query(ids, local, connection.map(|s| s.device_label.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ambiguous_or_legacy_progress_sources_remain_unknown() {
        let actor = "00000000-0000-4000-8000-000000000001";
        let unknown = "00000000-0000-4000-8000-000000000002";
        let mut catalog = Catalog::default();
        for owner in [
            "00000000-0000-4000-8000-000000000003",
            "00000000-0000-4000-8000-000000000004",
        ] {
            let declaration = Declaration {
                format: "epub-reader-progress-source".into(),
                format_version: 1,
                space_id: "space".into(),
                installation_id: owner.into(),
                writer_nonce: actor.into(),
                event_device_id: actor.into(),
                device_name: owner.into(),
                published_at_ms: 1000,
            };
            let name = declaration.name().unwrap();
            assert!(declaration.valid(&name, "space"));
            catalog.files.insert(name, declaration);
        }
        let sources = catalog
            .query(vec![actor.into(), unknown.into(), actor.into()], None, None)
            .unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources
            .iter()
            .all(|s| s.device_name.is_none() && !s.is_local));
        // Locally verified SQLite identity remains reliable despite a clone's
        // ambiguous declaration. This changes only the label, never progress.
        let own = catalog
            .query(vec![actor.into()], Some(actor), Some("This device"))
            .unwrap();
        assert_eq!(own[0].device_name.as_deref(), Some("This device"));
        assert!(own[0].is_local);
    }
}
