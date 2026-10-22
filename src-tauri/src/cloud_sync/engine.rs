//! Immutable, content-addressed device snapshots: publish a new complete file,
//! then retain two owned generations. No remote overwrite or shared head pointer.
use super::{
    codec,
    model::*,
    remote::*,
    storage::{Disk, Identity, SeenFile, Session},
    Accumulator, FileIssue, OwnRemote, Space, SyncError, Writer, FORMAT_VERSION,
};
use crate::portable_state::{valid_canonical_uuid, valid_content_hash, PortableStateV3};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Arc,
};
use tokio::sync::watch;

const ROUND_LIMIT: usize = 128 * 1024 * 1024;
const DEVICE_LIMIT: usize = 128;

pub trait Repository: Send + Sync {
    fn snapshot(&self) -> impl Future<Output = Result<LocalSnapshot>> + Send;
    fn apply(&self, full: PortableStateV3) -> impl Future<Output = Result<Applied>> + Send;
}

pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| Failure::new(FailureCode::StorageError))?
}

pub async fn idle(activity: &mut watch::Receiver<Activity>, cancel: &Cancel) -> Result<()> {
    loop {
        cancel.check()?;
        let current = *activity.borrow_and_update();
        if current.foreground && !current.interaction_busy {
            return Ok(());
        }
        tokio::select! {
         biased;
         _=cancel.cancelled()=>return Err(Failure::new(FailureCode::Cancelled)),
         changed=activity.changed()=>if changed.is_err(){return Err(Failure::new(FailureCode::Cancelled));}
        }
    }
}

pub fn empty() -> PortableStateV3 {
    PortableStateV3 {
        schema_version: 3,
        books: BTreeMap::new(),
        preferences: None,
        organization: crate::library_organization::LibraryOrganization {
            schema_version: 1,
            books: BTreeMap::new(),
            folders: BTreeMap::new(),
        },
    }
}

struct Author {
    space: String,
    identity: Identity,
    label: String,
    app_version: String,
    now: u64,
}
impl Author {
    fn writer(&self) -> Writer<'_> {
        Writer {
            space_id: &self.space,
            installation_id: &self.identity.installation_id,
            nonce: &self.identity.nonce,
            label: &self.label,
            app_version: &self.app_version,
            now_ms: self.now,
        }
    }
}

#[derive(Default)]
struct Budget {
    wire: usize,
    decoded: usize,
}
impl Budget {
    fn wire(&mut self, length: usize) -> Result<()> {
        self.wire = self
            .wire
            .checked_add(length)
            .filter(|n| *n <= ROUND_LIMIT)
            .ok_or_else(size_limit)?;
        Ok(())
    }
    fn decoded(&mut self, length: usize) -> Result<()> {
        self.decoded = self
            .decoded
            .checked_add(length)
            .filter(|n| *n <= ROUND_LIMIT)
            .ok_or_else(size_limit)?;
        Ok(())
    }
}
fn size_limit() -> Failure {
    RemoteError::new(RemoteErrorCode::SizeLimit).into()
}

#[derive(Clone)]
struct FileRef {
    name: String,
    id: String,
    fingerprint: String,
}
fn file_name(id: &str, fingerprint: &str) -> String {
    format!("{id}.v{FORMAT_VERSION}.{fingerprint}.json.gz")
}
fn file_path(name: &str) -> Result<RemotePath> {
    Ok(RemotePath::new("devices")?.child(name)?)
}

fn pending_path(author: &Author) -> Result<RemotePath> {
    file_path(&format!(
        ".{}.{}.pending",
        author.identity.installation_id, author.identity.nonce
    ))
}

async fn directory(
    remote: &impl SyncRemote,
    cancel: &Cancel,
) -> Result<(Vec<FileRef>, Vec<RemoteEntry>)> {
    let entries = remote.list(&RemotePath::new("devices")?, cancel).await?;
    let mut files = Vec::new();
    let mut ids = BTreeSet::new();
    for entry in &entries {
        if entry.is_collection {
            continue;
        }
        let Some(stem) = entry.name.strip_suffix(".json.gz") else {
            continue;
        };
        let fields = stem.split('.').collect::<Vec<_>>();
        if fields.first().is_none_or(|id| !valid_canonical_uuid(id)) {
            continue;
        }
        // Never silently ignore a known old layout or a future generation version.
        if fields.len() != 3 {
            return Err(Failure::new(FailureCode::UnsupportedSyncVersion));
        }
        let version = fields[1]
            .strip_prefix('v')
            .and_then(|v| v.parse::<u64>().ok());
        if version != Some(FORMAT_VERSION) {
            return Err(Failure::new(FailureCode::UnsupportedSyncVersion));
        }
        if !valid_content_hash(fields[2]) {
            return Err(Failure::new(FailureCode::InvalidData));
        }
        ids.insert(fields[0].to_string());
        files.push(FileRef {
            name: entry.name.clone(),
            id: fields[0].into(),
            fingerprint: fields[2].into(),
        });
    }
    if ids.len() > DEVICE_LIMIT || files.len() > DEVICE_LIMIT * 4 {
        return Err(size_limit());
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((files, entries))
}

pub async fn read_space(remote: &impl SyncRemote, cancel: &Cancel) -> Result<Option<Space>> {
    match remote
        .get(&RemotePath::new("space.json")?, None, SPACE_LIMIT, cancel)
        .await?
    {
        ReadResult::Missing => Ok(None),
        ReadResult::Content { bytes, .. } => Ok(Some(super::parse_space(&bytes)?)),
        ReadResult::NotModified => Err(Failure::new(FailureCode::InvalidData)),
    }
}

fn parse_generation(json: &[u8], file: &FileRef, author: &Author) -> Result<super::DeviceFile> {
    let parsed = super::parse_device(json, &author.space, &file.id)?;
    if super::digest(&parsed.state)? != file.fingerprint {
        return Err(Failure::new(FailureCode::InvalidData));
    }
    if file.id == author.identity.installation_id && parsed.writer_nonce != author.identity.nonce {
        return Err(Failure::new(FailureCode::WriterIdentityConflict));
    }
    Ok(parsed)
}

async fn fold(
    remote: &impl SyncRemote,
    mut files: Vec<FileRef>,
    author: Arc<Author>,
    mut round: Accumulator,
    mut seen: BTreeMap<String, SeenFile>,
    cancel: &Cancel,
    activity: &mut watch::Receiver<Activity>,
    mut budget: Budget,
) -> Result<(Accumulator, BTreeMap<String, SeenFile>)> {
    files.sort_by_key(|file| {
        (
            file.id != author.identity.installation_id,
            file.name.clone(),
        )
    });
    let listed = files
        .iter()
        .map(|f| f.name.as_str())
        .collect::<BTreeSet<_>>();
    seen.retain(|name, _| listed.contains(name.as_str()));
    for file in files {
        if let Some(cached) = seen.get(&file.name) {
            if cached.device.installation_id != file.id {
                return Err(Failure::new(FailureCode::LocalStateInvalid));
            }
            round.see(
                &author.writer(),
                cached.device.clone(),
                &cached.writer_nonce,
                &file.fingerprint,
            )?;
            continue;
        }
        let bytes = match remote
            .get(&file_path(&file.name)?, None, codec::GZIP_LIMIT, cancel)
            .await?
        {
            ReadResult::Content { bytes, .. } => bytes,
            ReadResult::Missing => continue, // May have been collected after the listing.
            ReadResult::NotModified => return Err(Failure::new(FailureCode::InvalidData)),
        };
        budget.wire(bytes.len())?;
        idle(activity, cancel).await?;
        let writer = author.clone();
        let token = cancel.clone();
        (round, seen, budget) = blocking(move || {
            token.check()?;
            let json = match codec::decode(&bytes, &token) {
                Ok(json) => json,
                Err(e) if e.code == RemoteErrorCode::Cancelled => return Err(e.into()),
                Err(e) if file.id == writer.identity.installation_id => return Err(e.into()),
                Err(_) => {
                    round.issues.push(FileIssue {
                        installation_id: file.id,
                        code: SyncError::InvalidData,
                    });
                    return Ok((round, seen, budget));
                }
            };
            budget.decoded(json.len())?;
            match parse_generation(&json, &file, &writer) {
                Ok(parsed) => {
                    let marker = SeenFile {
                        device: parsed.info(),
                        writer_nonce: parsed.writer_nonce.clone(),
                    };
                    if round.ingest(&writer.writer(), parsed, Some(&file.fingerprint))? {
                        seen.insert(file.name, marker);
                    }
                }
                Err(e)
                    if file.id == writer.identity.installation_id
                        || e.code == FailureCode::UnsupportedSyncVersion =>
                {
                    return Err(e)
                }
                Err(_) => round.issues.push(FileIssue {
                    installation_id: file.id,
                    code: SyncError::InvalidData,
                }),
            }
            Ok((round, seen, budget))
        })
        .await?;
    }
    Ok((round, seen))
}

pub async fn preview(
    remote: &impl SyncRemote,
    cancel: &Cancel,
) -> Result<(Option<Space>, usize, Vec<DeviceInfo>, Vec<FileIssue>)> {
    let Some(space) = read_space(remote, cancel).await? else {
        return Ok((None, 0, Vec::new(), Vec::new()));
    };
    let (files, _) = match directory(remote, cancel).await {
        Ok(files) => files,
        Err(e)
            if e.remote
                .as_ref()
                .is_some_and(|r| r.code == RemoteErrorCode::NotFound) =>
        {
            (Vec::new(), Vec::new())
        }
        Err(e) => return Err(e),
    };
    let author = Arc::new(Author {
        space: space.space_id.clone(),
        identity: Identity::fresh()?,
        label: "Preview".into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        now: now_ms(),
    });
    let round = Accumulator::new(&author.writer(), None, &empty(), OwnRemote::Absent)?;
    let (_tx, mut activity) = watch::channel(Activity::default());
    let (round, _) = fold(
        remote,
        files,
        author,
        round,
        BTreeMap::new(),
        cancel,
        &mut activity,
        Budget::default(),
    )
    .await?;
    Ok((
        Some(space),
        round.full.books.len(),
        round.devices,
        round.issues,
    ))
}

pub struct Outcome {
    pub session: Session,
    pub changed: bool,
    pub issues: Vec<FileIssue>,
    pub cloud_only_count: usize,
}

async fn save(disk: &Disk, session: Session, cancel: &Cancel) -> Result<Session> {
    let disk = disk.clone();
    let token = cancel.clone();
    blocking(move || {
        disk.save(&session, &token)?;
        Ok(session)
    })
    .await
}

async fn publish_generation(
    remote: &impl SyncRemote,
    name: &str,
    json: Vec<u8>,
    author: Arc<Author>,
    cancel: &Cancel,
) -> Result<SeenFile> {
    let token = cancel.clone();
    let gzip = blocking(move || Ok(codec::encode(&json, &token)?)).await?;
    match publish_prepared(
        remote,
        &pending_path(&author)?,
        &file_path(name)?,
        gzip,
        false,
        cancel,
    )
    .await
    {
        Ok(()) => Ok(SeenFile {
            device: DeviceInfo {
                installation_id: author.identity.installation_id.clone(),
                device_label: author.label.clone(),
                app_version: author.app_version.clone(),
                published_at_ms: author.now,
            },
            writer_nonce: author.identity.nonce.clone(),
        }),
        Err(e) if matches!(e.http_status, Some(409 | 412)) && !e.cleanup_failed => {
            // Two identical publication attempts are idempotent, but a collision must
            // be read and validated, never retried with overwrite enabled.
            let bytes = match remote
                .get(&file_path(name)?, None, codec::GZIP_LIMIT, cancel)
                .await?
            {
                ReadResult::Content { bytes, .. } => bytes,
                _ => return Err(e.into()),
            };
            let token = cancel.clone();
            let name = name.to_string();
            blocking(move || {
                let parsed = parse_generation(
                    &codec::decode(&bytes, &token)?,
                    &FileRef {
                        name: name.clone(),
                        id: author.identity.installation_id.clone(),
                        fingerprint: name.split('.').nth(2).unwrap_or_default().into(),
                    },
                    &author,
                )?;
                Ok(SeenFile {
                    device: parsed.info(),
                    writer_nonce: parsed.writer_nonce,
                })
            })
            .await
        }
        Err(e) => Err(e.into()),
    }
}

async fn collect_owned(
    remote: &impl SyncRemote,
    session: &mut Session,
    current: &str,
    author: &Author,
    cancel: &Cancel,
) -> Result<()> {
    let mut old = session
        .seen
        .iter()
        .filter(|(name, marker)| {
            name.as_str() != current
                && marker.device.installation_id == author.identity.installation_id
        })
        .map(|(name, marker)| (name.clone(), marker.device.published_at_ms))
        .collect::<Vec<_>>();
    // Timestamp selects only a redundant backup, never reading-position truth.
    old.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    for (name, _) in old.into_iter().skip(1) {
        if let Err(mut e) = remote.delete(&file_path(&name)?, false, cancel).await {
            e.cleanup_failed = true;
            return Err(e.into());
        }
        session.seen.remove(&name);
    }
    Ok(())
}

pub async fn run(
    remote: &impl SyncRemote,
    repository: &impl Repository,
    disk: &Disk,
    mut session: Session,
    identity: Identity,
    mut activity: watch::Receiver<Activity>,
    cancel: &Cancel,
) -> Result<Outcome> {
    if !session.capabilities.move_file || !session.capabilities.move_no_replace {
        return Err(RemoteError::new(RemoteErrorCode::Unsupported).into());
    }
    let space = read_space(remote, cancel)
        .await?
        .ok_or_else(|| Failure::from(RemoteError::new(RemoteErrorCode::NotFound)))?;
    if space.space_id != session.space.space_id {
        return Err(Failure::new(FailureCode::SpaceChanged));
    }
    let (files, entries) = directory(remote, cancel).await?;
    let author = Arc::new(Author {
        space: space.space_id,
        identity,
        label: session.device_label.clone(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        now: now_ms(),
    });
    idle(&mut activity, cancel).await?;
    let local = repository.snapshot().await?;
    let pending = if session.remote_view.is_none() {
        match remote
            .get(&pending_path(&author)?, None, codec::GZIP_LIMIT, cancel)
            .await?
        {
            ReadResult::Content { bytes, .. } => Some(bytes),
            ReadResult::Missing => None,
            ReadResult::NotModified => return Err(Failure::new(FailureCode::InvalidData)),
        }
    } else {
        None
    };
    let writer = author.clone();
    let token = cancel.clone();
    let (mut session, round, budget) = blocking(move || {
        let mut budget = Budget::default();
        if session.remote_view.is_none() {
            session.seen.clear();
        }
        let previous = session.remote_view.take();
        let mut round = Accumulator::new(
            &writer.writer(),
            previous.as_ref(),
            &local.state,
            OwnRemote::Absent,
        )?;
        if let Some(bytes) = pending {
            budget.wire(bytes.len())?;
            session.pending_upload = true;
            match codec::decode(&bytes, &token) {
                Ok(json) => {
                    budget.decoded(json.len())?;
                    match super::parse_device(
                        &json,
                        &writer.space,
                        &writer.identity.installation_id,
                    ) {
                        Ok(file) => {
                            if file.writer_nonce != writer.identity.nonce {
                                return Err(Failure::new(FailureCode::WriterIdentityConflict));
                            }
                            // Recovery is not publication: don't add this digest to
                            // own_digests until a complete generation is visible.
                            round.full = crate::portable_state::merge_portable_states(
                                &round.full,
                                &file.state,
                            )
                            .map_err(|_| Failure::new(FailureCode::LocalStateInvalid))?;
                        }
                        Err(SyncError::UnsupportedSyncVersion) => {
                            return Err(Failure::new(FailureCode::UnsupportedSyncVersion))
                        }
                        Err(_) => {} // An incomplete owned upload has no usable state.
                    }
                }
                Err(e) if e.code == RemoteErrorCode::Cancelled => return Err(e.into()),
                Err(_) => {}
            }
        }
        Ok((session, round, budget))
    })
    .await?;
    let (round, seen) = fold(
        remote,
        files,
        author.clone(),
        round,
        std::mem::take(&mut session.seen),
        cancel,
        &mut activity,
        budget,
    )
    .await?;
    session.seen = seen;
    idle(&mut activity, cancel).await?;
    session.remote_view = Some(round.full.clone());
    session = save(disk, session, cancel).await?;
    cancel.check()?;
    let applied = repository.apply(round.full.clone()).await?;
    let changed = applied.changed;
    let writer = author.clone();
    idle(&mut activity, cancel).await?;
    let (plan, bound, event_device_id) = blocking(move || {
        let bound = applied.snapshot.bound;
        let plan = round.finish(&writer.writer(), &applied.snapshot.state, &bound)?;
        Ok((plan, bound, applied.snapshot.event_device_id))
    })
    .await?;
    let cloud_only_count = plan
        .full
        .books
        .keys()
        .filter(|hash| !bound.contains(*hash))
        .count();
    let current = file_name(&author.identity.installation_id, &plan.state_digest);
    let issues = plan.issues;
    session.devices = plan.devices;
    session.remote_view = Some(plan.full);
    if let Some(json) = plan.publication {
        idle(&mut activity, cancel).await?;
        session.pending_upload = true;
        session = save(disk, session, cancel).await?;
        let marker = publish_generation(remote, &current, json, author.clone(), cancel).await?;
        session.pending_upload = false;
        session
            .devices
            .retain(|d| d.installation_id != author.identity.installation_id);
        session.devices.push(marker.device.clone());
        session.seen.insert(current.clone(), marker);
        // Full history was saved before publishing, and the new complete file
        // is durable remotely. A crash during collection rebuilds seen by GET.
    }
    if session.pending_upload {
        remote
            .delete(&pending_path(&author)?, false, cancel)
            .await?;
        session.pending_upload = false;
    }
    collect_owned(remote, &mut session, &current, &author, cancel).await?;
    idle(&mut activity, cancel).await?;
    super::sources::sync(
        remote,
        entries,
        disk,
        &session,
        &author.identity,
        event_device_id.as_deref(),
        cancel,
    )
    .await?;
    session.last_success_at_ms = Some(now_ms());
    session.cloud_only_book_count = cloud_only_count;
    let session = save(disk, session, cancel).await?;
    Ok(Outcome {
        session,
        changed,
        issues,
        cloud_only_count,
    })
}

#[cfg(test)]
mod tests;
