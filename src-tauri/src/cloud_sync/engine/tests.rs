use super::super::{
    model::FailureCode, scheduler::Schedule, storage::Session, DEVICE_FORMAT, FORMAT_VERSION,
    SPACE_FORMAT,
};
use super::*;
use crate::portable_state::{parse_portable_state_value, PortableStore};
use serde_json::json;
use std::sync::Mutex;

const SPACE: &str = "00000000-0000-4000-8000-000000000010";
const A: &str = "00000000-0000-4000-8000-000000000001";
const B: &str = "00000000-0000-4000-8000-000000000002";
const NONCE: &str = "00000000-0000-4000-8000-000000000020";

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("epub-cloud-{}", uuid().unwrap()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn disk(&self, name: &str) -> Disk {
        Disk {
            root: self.0.join(name),
        }
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn identity(id: &str) -> Identity {
    Identity {
        schema_version: 1,
        installation_id: id.into(),
        nonce: NONCE.into(),
    }
}

fn book(owner: &str, hash: &str, counter: u64, pct: u64) -> PortableStateV3 {
    parse_portable_state_value(json!({"schemaVersion":3,"books":{hash:{
        "metadata":{"value":{"title":"Synthetic book","creator":"Test","fileName":"test.epub","addedAtMs":1000},"stamp":{"deviceId":owner,"counter":1}},
        "progress":{"versions":[{"stamp":{"deviceId":owner,"counter":counter},"clock":{owner:counter},
            "value":{"locator":{"locatorVersion":1,"chapterPath":"Text/chapter.xhtml","spineIndexHint":0,"target":{"kind":"chapter-start"}},"progressPctHint":pct},"updatedAtMs":1000}]},
        "bookmarks":{},"notes":{}}},"organization":{"schemaVersion":1,"books":{},"folders":{}}})).unwrap()
}

fn session() -> Session {
    Session {
        schema_version: 1,
        connection_id: uuid().unwrap(),
        settings: Settings {
            base_url: "https://nas.invalid/dav/".into(),
            remote_root: "test".into(),
            username: "test".into(),
        },
        space: Space {
            format: SPACE_FORMAT.into(),
            format_version: FORMAT_VERSION,
            space_id: SPACE.into(),
            created_at_ms: 1,
        },
        capabilities: Capabilities {
            move_file: true,
            conditional_create: false,
            move_no_replace: true,
        },
        device_label: "Synthetic".into(),
        remote_view: None,
        last_success_at_ms: None,
        devices: Vec::new(),
        cloud_only_book_count: 0,
        seen: BTreeMap::new(),
        pending_upload: false,
    }
}

#[derive(Default)]
struct Memory {
    files: BTreeMap<String, Vec<u8>>,
    writes: usize,
    reads: usize,
    fail_publish: bool,
    fail_get: Option<String>,
    hook: Option<(String, Box<dyn FnOnce() + Send>)>,
}

#[derive(Clone)]
struct Remote(Arc<Mutex<Memory>>);

impl Remote {
    fn new() -> Self {
        let mut store = Memory::default();
        store.files.insert(
            "space.json".into(),
            serde_json::to_vec(&session().space).unwrap(),
        );
        Self(Arc::new(Mutex::new(store)))
    }
    fn file(&self, id: &str, state: PortableStateV3) -> String {
        let fingerprint =
            super::super::digest(&super::super::normalized(state.clone()).unwrap()).unwrap();
        let name = format!("devices/{}", file_name(id, &fingerprint));
        let json = super::super::plan_round(
            &Writer {
                space_id: SPACE,
                installation_id: id,
                nonce: NONCE,
                label: "Synthetic",
                app_version: "0.3.5",
                now_ms: 1,
            },
            None,
            &state,
            &state.books.keys().cloned().collect(),
            OwnRemote::Absent,
            &[],
        )
        .unwrap()
        .publication
        .unwrap();
        self.0.lock().unwrap().files.insert(
            name.clone(),
            codec::encode(&json, &Cancel::default()).unwrap(),
        );
        name
    }
}

impl SyncRemote for Remote {
    async fn list(
        &self,
        path: &RemotePath,
        cancel: &Cancel,
    ) -> std::result::Result<Vec<RemoteEntry>, RemoteError> {
        cancel.check()?;
        let prefix = format!("{}/", path.as_relative());
        Ok(self
            .0
            .lock()
            .unwrap()
            .files
            .keys()
            .filter_map(|name| {
                let name = name.strip_prefix(&prefix)?;
                (!name.contains('/')).then(|| RemoteEntry {
                    name: name.into(),
                    is_collection: false,
                    etag: None,
                    size: None,
                })
            })
            .collect())
    }
    async fn get(
        &self,
        path: &RemotePath,
        _: Option<&str>,
        limit: usize,
        cancel: &Cancel,
    ) -> std::result::Result<ReadResult, RemoteError> {
        cancel.check()?;
        let key = path.as_relative();
        let hook = {
            let mut store = self.0.lock().unwrap();
            if store.hook.as_ref().is_some_and(|(path, _)| path == &key) {
                store.hook.take()
            } else {
                None
            }
        };
        if let Some((_, hook)) = hook {
            hook();
        }
        let mut store = self.0.lock().unwrap();
        store.reads += 1;
        if store.fail_get.as_ref() == Some(&key) {
            return Err(RemoteError::new(RemoteErrorCode::Network));
        }
        match store.files.get(&key) {
            None => Ok(ReadResult::Missing),
            Some(bytes) if bytes.len() > limit => Err(RemoteError::new(RemoteErrorCode::SizeLimit)),
            Some(bytes) => Ok(ReadResult::Content {
                bytes: bytes.clone(),
                etag: None,
            }),
        }
    }
    async fn put(
        &self,
        path: &RemotePath,
        bytes: Vec<u8>,
        condition: WriteCondition,
        cancel: &Cancel,
    ) -> std::result::Result<(), RemoteError> {
        cancel.check()?;
        let mut store = self.0.lock().unwrap();
        if store.fail_publish {
            return Err(RemoteError::new(RemoteErrorCode::Timeout));
        }
        if matches!(condition, WriteCondition::Absent)
            && store.files.contains_key(&path.as_relative())
        {
            return Err(RemoteError::status(412));
        }
        store.files.insert(path.as_relative(), bytes);
        store.writes += 1;
        Ok(())
    }
    async fn move_file(
        &self,
        from: &RemotePath,
        to: &RemotePath,
        overwrite: bool,
        cancel: &Cancel,
    ) -> std::result::Result<(), RemoteError> {
        cancel.check()?;
        let mut store = self.0.lock().unwrap();
        if !overwrite && store.files.contains_key(&to.as_relative()) {
            return Err(RemoteError::status(409));
        }
        let bytes = store
            .files
            .remove(&from.as_relative())
            .ok_or_else(|| RemoteError::status(404))?;
        store.files.insert(to.as_relative(), bytes);
        store.writes += 1;
        Ok(())
    }
    async fn create_collection(
        &self,
        _: &RemotePath,
        _: &Cancel,
    ) -> std::result::Result<bool, RemoteError> {
        Ok(true)
    }
    async fn delete(
        &self,
        path: &RemotePath,
        _: bool,
        _: &Cancel,
    ) -> std::result::Result<(), RemoteError> {
        self.0.lock().unwrap().files.remove(&path.as_relative());
        Ok(())
    }
}

#[derive(Clone)]
struct Local(Arc<Mutex<PortableStore>>);

impl Local {
    fn new(temp: &Temp, name: &str, state: PortableStateV3) -> Self {
        let store = PortableStore::open(&temp.0.join(format!("{name}.sqlite3"))).unwrap();
        let result = Self(Arc::new(Mutex::new(store)));
        result.seed(state);
        result
    }
    fn seed(&self, state: PortableStateV3) {
        let bindings = state
            .books
            .keys()
            .map(|hash| (hash.clone(), "{}".into()))
            .collect();
        self.0
            .lock()
            .unwrap()
            .merge_local_import_ref(&state, bindings, &BTreeSet::new(), false)
            .unwrap();
    }
}

impl Repository for Local {
    async fn snapshot(&self) -> Result<LocalSnapshot> {
        let store = self.0.clone();
        blocking(move || {
            let store = store.lock().unwrap();
            Ok(LocalSnapshot {
                state: store.snapshot()?,
                bound: store.locally_bound_hashes()?,
            })
        })
        .await
    }
    async fn apply(&self, full: PortableStateV3) -> Result<Applied> {
        let store = self.0.clone();
        blocking(move || {
            let mut store = store.lock().unwrap();
            let before = store.snapshot()?;
            let after = store
                .merge_local_import_ref(&full, Vec::new(), &BTreeSet::new(), false)?
                .state;
            Ok(Applied {
                changed: before != after,
                snapshot: LocalSnapshot {
                    state: after,
                    bound: store.locally_bound_hashes()?,
                },
            })
        })
        .await
    }
}

fn activity() -> watch::Receiver<Activity> {
    watch::channel(Activity::default()).1
}

#[tokio::test]
async fn two_sqlite_repositories_preserve_cloud_history_and_late_local_events() {
    let temp = Temp::new();
    let remote = Remote::new();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let left = Local::new(&temp, "a", book(A, &a, 2, 20));
    let right = Local::new(&temp, "b", book(B, &b, 2, 40));
    let da = temp.disk("sync-a");
    let db = temp.disk("sync-b");
    let cancel = Cancel::default();
    let first = run(
        &remote,
        &left,
        &da,
        session(),
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    let second = run(
        &remote,
        &right,
        &db,
        session(),
        identity(B),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(second.session.remote_view.as_ref().unwrap().books.len(), 2);
    assert_eq!(right.snapshot().await.unwrap().state.books.len(), 1);
    assert_eq!(second.cloud_only_count, 1);
    let late = left.clone();
    let hash = a.clone();
    let peer_key = remote
        .0
        .lock()
        .unwrap()
        .files
        .keys()
        .find(|key| key.starts_with(&format!("devices/{B}.v")))
        .unwrap()
        .clone();
    remote.0.lock().unwrap().hook =
        Some((peer_key, Box::new(move || late.seed(book(A, &hash, 3, 80)))));
    let third = run(
        &remote,
        &left,
        &da,
        first.session,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(
        left.snapshot().await.unwrap().state.books[&a]
            .progress
            .versions[0]
            .value
            .as_ref()
            .unwrap()
            .progress_pct_hint,
        80
    );
    let written_key = format!(
        "devices/{}",
        file_name(
            A,
            &super::super::digest(third.session.remote_view.as_ref().unwrap()).unwrap()
        )
    );
    let written = remote.0.lock().unwrap().files[&written_key].clone();
    let file =
        super::super::parse_device(&codec::decode(&written, &cancel).unwrap(), SPACE, A).unwrap();
    assert_eq!(
        file.state.books[&a].progress.versions[0]
            .value
            .as_ref()
            .unwrap()
            .progress_pct_hint,
        80
    );
    let writes = remote.0.lock().unwrap().writes;
    let mut rebuilt = third.session;
    rebuilt.remote_view = None;
    let fourth = run(
        &remote,
        &left,
        &da,
        rebuilt,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(remote.0.lock().unwrap().writes, writes);
    assert_eq!(fourth.session.remote_view.as_ref().unwrap().books.len(), 2);
    assert_eq!(
        da.load(&cancel).unwrap().unwrap().last_success_at_ms,
        fourth.session.last_success_at_ms
    );
    left.0.lock().unwrap().hide_linked_record(&a).unwrap();
    let deleted = run(
        &remote,
        &left,
        &da,
        fourth.session,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert!(!left.snapshot().await.unwrap().state.books.contains_key(&a));
    assert!(deleted
        .session
        .remote_view
        .as_ref()
        .unwrap()
        .books
        .contains_key(&a));
    let mut reimport = book(A, &a, 2, 20);
    reimport
        .books
        .get_mut(&a)
        .unwrap()
        .progress
        .versions
        .clear();
    left.seed(reimport);
    let restored = run(
        &remote,
        &left,
        &da,
        deleted.session,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert!(restored.changed);
    assert_eq!(
        left.snapshot().await.unwrap().state.books[&a]
            .progress
            .versions[0]
            .value
            .as_ref()
            .unwrap()
            .progress_pct_hint,
        80
    );
    left.seed(book(A, &a, 4, 90));
    let newest = run(
        &remote,
        &left,
        &da,
        restored.session,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(
        remote
            .0
            .lock()
            .unwrap()
            .files
            .keys()
            .filter(|key| key.starts_with(&format!("devices/{A}.v2.")))
            .count(),
        2
    );
    assert!(!remote
        .0
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|key| key.ends_with(".pending")));
    let (reads, writes) = {
        let state = remote.0.lock().unwrap();
        (state.reads, state.writes)
    };
    run(
        &remote,
        &left,
        &da,
        newest.session,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(remote.0.lock().unwrap().writes, writes);
    assert_eq!(
        remote.0.lock().unwrap().reads - reads,
        1,
        "only space header is read; immutable generations reuse verified history"
    );

    let pending_remote = Remote::new();
    let generation = pending_remote.file(A, book(A, &a, 4, 90));
    let pending_key = format!("devices/.{A}.{NONCE}.pending");
    {
        let mut state = pending_remote.0.lock().unwrap();
        let bytes = state.files.remove(&generation).unwrap();
        state.files.insert(pending_key.clone(), bytes);
    }
    let no_books = Local::new(&temp, "empty", empty());
    let recovered = run(
        &pending_remote,
        &no_books,
        &temp.disk("lost-cache"),
        session(),
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .unwrap();
    assert!(recovered
        .session
        .remote_view
        .unwrap()
        .books
        .contains_key(&a));
    assert!(no_books.snapshot().await.unwrap().state.books.is_empty());
    assert!(!pending_remote
        .0
        .lock()
        .unwrap()
        .files
        .contains_key(&pending_key));
    assert!(pending_remote
        .0
        .lock()
        .unwrap()
        .files
        .contains_key(&generation));
}

#[tokio::test]
async fn failed_rounds_preserve_state_and_do_not_publish_over_unknown_own_files() {
    let temp = Temp::new();
    let remote = Remote::new();
    let hash = "a".repeat(64);
    let cancel = Cancel::default();
    let local = Local::new(&temp, "a", book(A, &hash, 2, 10));
    let disk = temp.disk("sync");
    let mut unsafe_session = session();
    unsafe_session.capabilities.move_no_replace = false;
    let error = run(
        &remote,
        &local,
        &disk,
        unsafe_session,
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.remote.unwrap().code, RemoteErrorCode::Unsupported);
    assert_eq!(remote.0.lock().unwrap().writes, 0);
    let own_key = remote.file(A, book(A, &hash, 2, 10));
    let other_key = format!("devices/{}", file_name(B, &"f".repeat(64)));
    let original = remote.0.lock().unwrap().files[&own_key].clone();
    remote
        .0
        .lock()
        .unwrap()
        .files
        .insert(own_key.clone(), b"truncated".to_vec());
    assert!(run(
        &remote,
        &local,
        &disk,
        session(),
        identity(A),
        activity(),
        &cancel
    )
    .await
    .is_err());
    assert_eq!(remote.0.lock().unwrap().writes, 0);
    remote
        .0
        .lock()
        .unwrap()
        .files
        .insert(own_key.clone(), original.clone());
    let future = json!({"format":DEVICE_FORMAT,"formatVersion":FORMAT_VERSION+1,"spaceId":SPACE,"installationId":B,"futureField":true});
    remote.0.lock().unwrap().files.insert(
        other_key.clone(),
        codec::encode(&serde_json::to_vec(&future).unwrap(), &cancel).unwrap(),
    );
    let before = local.snapshot().await.unwrap().state;
    let error = run(
        &remote,
        &local,
        &disk,
        session(),
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, FailureCode::UnsupportedSyncVersion);
    assert_eq!(local.snapshot().await.unwrap().state, before);
    assert_eq!(remote.0.lock().unwrap().files[&own_key], original);
    remote.0.lock().unwrap().files.remove(&other_key);
    let future_name = format!(
        "devices/{B}.v{}.{}.json.gz",
        FORMAT_VERSION + 1,
        "f".repeat(64)
    );
    remote
        .0
        .lock()
        .unwrap()
        .files
        .insert(future_name.clone(), b"future".to_vec());
    assert_eq!(
        run(
            &remote,
            &local,
            &disk,
            session(),
            identity(A),
            activity(),
            &cancel
        )
        .await
        .err()
        .unwrap()
        .code,
        FailureCode::UnsupportedSyncVersion
    );
    remote.0.lock().unwrap().files.remove(&future_name);
    let other_key = remote.file(B, book(B, &hash, 2, 70));
    remote.0.lock().unwrap().fail_get = Some(other_key.clone());
    assert!(run(
        &remote,
        &local,
        &disk,
        session(),
        identity(A),
        activity(),
        &cancel
    )
    .await
    .is_err());
    assert_eq!(local.snapshot().await.unwrap().state, before);
    remote.0.lock().unwrap().fail_get = None;
    remote.0.lock().unwrap().fail_publish = true;
    let error = run(
        &remote,
        &local,
        &disk,
        session(),
        identity(A),
        activity(),
        &cancel,
    )
    .await
    .err()
    .unwrap();
    assert!(error.retryable());
    assert_eq!(
        local.snapshot().await.unwrap().state.books[&hash]
            .progress
            .versions
            .len(),
        2
    );
    assert_eq!(
        disk.load(&cancel)
            .unwrap()
            .unwrap()
            .remote_view
            .unwrap()
            .books[&hash]
            .progress
            .versions
            .len(),
        2
    );
    assert_eq!(remote.0.lock().unwrap().files[&own_key], original);
}

#[test]
fn scheduling_and_sidecar_versions_preserve_their_boundaries() {
    let mut schedule = Schedule::default();
    schedule.request(Trigger::DataChanged, 0);
    schedule.request(Trigger::DataChanged, 1000);
    assert_eq!(schedule.due_at, Some(4000));
    assert!(!schedule.start(3999));
    assert!(schedule.start(4000));
    schedule.request(Trigger::ProgressChanged, 5000);
    schedule.request(Trigger::ProgressChanged, 5100);
    assert_eq!(schedule.due_at, Some(64_000));
    schedule.finish(6000, None);
    assert!(schedule.pending);
    schedule.request(Trigger::Manual, 7000);
    assert!(schedule.start(7000));
    let network = Failure::from(RemoteError::new(RemoteErrorCode::Network));
    schedule.finish(7000, Some(&network));
    assert_eq!(schedule.retry_at, Some(67_000));
    schedule.request(Trigger::Foreground, 8000);
    assert!(schedule.start(8000));
    let auth = Failure::from(RemoteError::status(401));
    schedule.finish(8000, Some(&auth));
    schedule.request(Trigger::Foreground, 9000);
    assert!(schedule.blocked);
    assert!(!schedule.pending);
    schedule.cancel();
    schedule.request(Trigger::Foreground, 9500);
    assert!(
        schedule.blocked,
        "cancelling does not clear an auth failure"
    );
    assert!(!schedule.pending);
    schedule.request(Trigger::Manual, 10_000);
    assert!(schedule.start(10_000));
    schedule.request(Trigger::Manual, 10_500);
    schedule.finish(11_000, Some(&auth));
    assert!(
        schedule.start(11_000),
        "an explicit queued retry is retained"
    );
    schedule.finish(12_000, None);
    assert!(!schedule.pending);
    assert_eq!(schedule.due_at, None);
    let temp = Temp::new();
    let disk = temp.disk("sync");
    let cancel = Cancel::default();
    let old = disk.identity().unwrap();
    assert_eq!(
        disk.identity().unwrap().installation_id,
        old.installation_id
    );
    disk.save(&session(), &cancel).unwrap();
    assert_eq!(disk.load(&cancel).unwrap().unwrap().space.space_id, SPACE);
    let mut future = serde_json::to_value(session()).unwrap();
    future["schemaVersion"] = json!(2);
    let bytes = codec::encode(&serde_json::to_vec(&future).unwrap(), &cancel).unwrap();
    let path = disk.root.join("connection.json.gz");
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(
        disk.load(&cancel).err().unwrap().code,
        FailureCode::UnsupportedLocalVersion
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    std::fs::write(disk.root.join("connection.json.gz"), b"corrupt gzip").unwrap();
    assert_eq!(
        disk.load(&cancel).err().unwrap().code,
        FailureCode::LocalStateInvalid
    );
    disk.quarantine().unwrap();
    assert!(disk.load(&cancel).unwrap().is_none());
    assert!(std::fs::read_dir(&disk.root).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("connection-recovery-")));
}

#[tokio::test]
#[ignore = "explicit isolated live sync; never opens the user's library"]
async fn live_two_device_metadata_roundtrip() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Config {
        base_url: String,
        remote_root: String,
        username: String,
        app_password: String,
    }
    let path = std::env::var("EPUB_READER_WEBDAV_TEST_CONFIG")
        .expect("external development configuration path required");
    let config: Config =
        serde_json::from_slice(&std::fs::read(path).expect("configuration unreadable"))
            .expect("invalid configuration JSON");
    assert_eq!(config.remote_root, "EPUBReader-Test");
    let credentials = Credentials {
        username: config.username.clone(),
        app_password: config.app_password,
    };
    let parent =
        WebDavRemote::new(&config.base_url, &config.remote_root, credentials.clone()).unwrap();
    let folder = format!(".probe-round-{}", uuid().unwrap());
    let child = RemotePath::new(&folder).unwrap();
    assert!(
        parent
            .create_collection(&child, &Cancel::default())
            .await
            .unwrap(),
        "must own a fresh test directory"
    );
    let root = format!("{}/{}", config.remote_root, folder);
    let result = tokio::spawn(async move {
        let remote = WebDavRemote::new(&config.base_url, &root, credentials)?;
        let token = Cancel::default();
        let caps = probe(&remote, &token).await?;
        let space = ensure_space(
            &remote,
            &Space {
                format: SPACE_FORMAT.into(),
                format_version: FORMAT_VERSION,
                space_id: uuid()?,
                created_at_ms: now_ms(),
            },
            true,
            caps,
            &token,
        )
        .await?;
        remote
            .create_collection(&RemotePath::new("devices")?, &token)
            .await?;
        let temp = Temp::new();
        let hash = "a".repeat(64);
        let other = "b".repeat(64);
        let left = Local::new(&temp, "a", book(A, &hash, 2, 20));
        let right = Local::new(&temp, "b", book(B, &other, 2, 40));
        let mut base = session();
        base.space = space;
        base.capabilities = caps;
        base.settings = Settings {
            base_url: config.base_url,
            remote_root: root,
            username: config.username,
        };
        println!("synthetic_round=A1");
        let a = run(
            &remote,
            &left,
            &temp.disk("sync-a"),
            base.clone(),
            identity(A),
            activity(),
            &token,
        )
        .await?;
        println!("synthetic_round=B1");
        let b = run(
            &remote,
            &right,
            &temp.disk("sync-b"),
            base,
            identity(B),
            activity(),
            &token,
        )
        .await?;
        assert_eq!(right.snapshot().await?.state.books.len(), 1);
        assert_eq!(b.cloud_only_count, 1);
        let mut imported = book(A, &hash, 2, 20);
        imported
            .books
            .get_mut(&hash)
            .unwrap()
            .progress
            .versions
            .clear();
        right.seed(imported);
        let b = run(
            &remote,
            &right,
            &temp.disk("sync-b"),
            b.session,
            identity(B),
            activity(),
            &token,
        )
        .await?;
        assert!(b.changed);
        assert_eq!(
            right.snapshot().await?.state.books[&hash].progress.versions[0]
                .value
                .as_ref()
                .unwrap()
                .progress_pct_hint,
            20
        );
        right.seed(book(A, &hash, 3, 75));
        let b = run(
            &remote,
            &right,
            &temp.disk("sync-b"),
            b.session,
            identity(B),
            activity(),
            &token,
        )
        .await?;
        assert!(b.session.last_success_at_ms.is_some());
        let a = run(
            &remote,
            &left,
            &temp.disk("sync-a"),
            a.session,
            identity(A),
            activity(),
            &token,
        )
        .await?;
        assert!(a.changed);
        assert_eq!(
            left.snapshot().await?.state.books[&hash].progress.versions[0]
                .value
                .as_ref()
                .unwrap()
                .progress_pct_hint,
            75
        );
        assert!(!left.snapshot().await?.state.books.contains_key(&other));
        assert_eq!(a.session.remote_view.as_ref().unwrap().books.len(), 2);
        left.seed(book(A, &hash, 4, 90));
        let a = run(
            &remote,
            &left,
            &temp.disk("sync-a"),
            a.session,
            identity(A),
            activity(),
            &token,
        )
        .await?;
        assert!(a.session.last_success_at_ms.is_some());
        assert_eq!(
            directory(&remote, &token)
                .await?
                .iter()
                .filter(|file| file.id == A)
                .count(),
            2
        );
        Ok::<(), Failure>(())
    })
    .await;
    let cleanup = parent.delete(&child, true, &Cancel::default()).await;
    println!("isolated_sync_cleanup={}", cleanup.is_ok());
    cleanup.expect("temporary sync directory cleanup failed");
    result
        .expect("synthetic roundtrip assertions failed")
        .expect("sanitized live sync error");
    println!("isolated_sync_roundtrip=passed (two temporary SQLite libraries, no user data)");
}
