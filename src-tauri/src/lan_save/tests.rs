use super::connection::{LanConnection, LanIo};
use super::manager::{accept, close, commit, join, send, start_host, LanHostResult};
use super::pairing::LanPairing;
use super::session::{GateClose, LanEventSink, LanSaveEvent, SessionGate};
use super::tls::{client_config, server_name, TlsIdentity};
use crate::linked_library::LinkedLibraryWriteState;
use crate::portable_state::parse_portable_state_value;
use crate::portable_state_commands::{activate_store, with_existing_store, PortableStateManager};
use crate::save_file::commands::{finish_task, reserve_job, SaveFileManager};
use crate::save_file::{hex_digest, new_uuid, LocalBinding, SaveExportScope};
use serde_json::json;
use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, TlsConnector};

const A: &str = "00000000-0000-4000-8000-000000000001";

static NONCE: AtomicU64 = AtomicU64::new(0);

struct TestApp {
    app: Option<App<MockRuntime>>,
    root: PathBuf,
}

impl TestApp {
    fn new(label: &str) -> Self {
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = format!(
            "com.herenfor.epubreader.lantest.{label}.{}.{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        );
        let app = mock_builder()
            .manage(PortableStateManager::default())
            .manage(SaveFileManager::default())
            .manage(super::LanSaveManager::default())
            .manage(LinkedLibraryWriteState::default())
            .build(context)
            .expect("mock app should build");
        let handle = app.handle().clone();
        activate_store(&handle).expect("portable store should activate");
        let root = handle
            .path()
            .app_local_data_dir()
            .expect("mock app local data dir");
        Self {
            app: Some(app),
            root,
        }
    }

    fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.as_ref().expect("app is alive").handle().clone()
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        if let Some(app) = self.app.take() {
            if let Ok(cache) = app.path().app_cache_dir() {
                let _ = std::fs::remove_dir_all(cache);
            }
            drop(app);
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone, Default)]
struct EventLog(Arc<Mutex<Vec<LanSaveEvent>>>);

impl EventLog {
    fn sink(&self) -> LanEventSink {
        let log = self.0.clone();
        Arc::new(move |event| {
            log.lock().expect("event log lock").push(event);
        })
    }

    fn take(&self, name: &str) -> Option<LanSaveEvent> {
        let mut events = self.0.lock().expect("event log lock");
        let index = events.iter().position(|event| event.event == name)?;
        Some(events.remove(index))
    }
}

async fn wait_event(log: &EventLog, name: &str, timeout: Duration) -> LanSaveEvent {
    let started = std::time::Instant::now();
    loop {
        if let Some(event) = log.take(name) {
            return event;
        }
        assert!(
            started.elapsed() < timeout,
            "timed out waiting for event {name}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn seed_book(app: &TestApp, content_hash: &str, bytes: &[u8]) {
    let linked_root = app.root.join("linked-library");
    let book_path = linked_root
        .join("books")
        .join(format!("{content_hash}.epub"));
    std::fs::create_dir_all(book_path.parent().expect("book parent")).unwrap();
    std::fs::write(&book_path, bytes).unwrap();

    let mut books = serde_json::Map::new();
    books.insert(
        content_hash.to_string(),
        json!({
            "metadata": {
                "value": {
                    "title": "LAN test book",
                    "creator": "tester",
                    "fileName": "book.epub",
                    "addedAtMs": 1000
                },
                "stamp": { "deviceId": A, "counter": 1 }
            },
            "progress": {
                "versions": [{
                    "stamp": { "deviceId": A, "counter": 1 },
                    "clock": { A: 1 },
                    "value": {
                        "locator": {
                            "locatorVersion": 1,
                            "chapterPath": "Text/chapter.xhtml",
                            "spineIndexHint": 0,
                            "target": { "kind": "chapter-start" }
                        },
                        "progressPctHint": 10
                    },
                    "updatedAtMs": 1000
                }]
            },
            "bookmarks": {},
            "notes": {}
        }),
    );
    let state = parse_portable_state_value(json!({
        "schemaVersion": 3,
        "books": books,
        "organization": { "schemaVersion": 1, "folders": {}, "books": {} }
    }))
    .unwrap();
    let binding = LocalBinding::new_managed(content_hash, bytes.len() as u64, 1000);
    let raw = serde_json::to_string(&binding).unwrap();
    let handle = app.handle();
    let merged = with_existing_store(&handle, |store| {
        store
            .merge_validated_import(state, vec![(content_hash.to_string(), raw)], false)
            .map(|state| state.books.len())
    })
    .unwrap()
    .unwrap();
    assert_eq!(merged, 1);
}

fn snapshot_books(app: &TestApp) -> BTreeMap<String, usize> {
    let handle = app.handle();
    with_existing_store(&handle, |store| {
        let snapshot = store.snapshot()?;
        Ok(snapshot
            .books
            .keys()
            .map(|hash| (hash.clone(), 1))
            .collect::<BTreeMap<_, _>>())
    })
    .unwrap()
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_loopback_streams_archive_then_prepares_and_commits() {
    for already_imported in [false, true] {
        lan_cover_roundtrip(already_imported).await;
    }
}

async fn lan_cover_roundtrip(already_imported: bool) {
    let sender = TestApp::new("sender");
    let receiver = TestApp::new("receiver");
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, contents) in [
    ("META-INF/container.xml", br#"<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>"#.as_slice()),
    ("OPS/content.opf", br#"<package><metadata><title>Cover test</title></metadata><manifest><item id="image" href="Images/cover.jpg" media-type="image/jpeg" properties="cover-image"/><item id="text" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>"#.as_slice()),
    ("OPS/Images/cover.jpg", b"exact cover entry bytes".as_slice()),
    ("OPS/Text/chapter.xhtml", b"<html><body>Test</body></html>".as_slice()),
] {
    zip.start_file(path, zip::write::SimpleFileOptions::default()).unwrap();
    std::io::Write::write_all(&mut zip, contents).unwrap();
}
    let bytes = zip.finish().unwrap().into_inner();
    let content_hash = hex_digest(&bytes);
    seed_book(&sender, &content_hash, &bytes);
    if already_imported {
        seed_book(&receiver, &content_hash, &bytes);
    }

    let sender_handle = sender.handle();
    let receiver_handle = receiver.handle();
    let host_log = EventLog::default();
    let join_log = EventLog::default();
    let host: LanHostResult = start_host(&sender_handle, Ipv4Addr::LOCALHOST, host_log.sink())
        .await
        .expect("host should start");
    assert_eq!(host.session_id.len(), 36);
    let join_result = tokio::time::timeout(
        Duration::from_secs(15),
        join(&receiver_handle, &host.pairing_info, join_log.sink()),
    )
    .await
    .expect("join should not time out")
    .expect("join should pair");
    assert_eq!(join_result.session_id, host.session_id);

    let session_id = host.session_id.clone();
    let send_handle = sender_handle.clone();
    let send_session = session_id.clone();
    let send_task =
        tokio::spawn(
            async move { send(&send_handle, &send_session, SaveExportScope::All, true).await },
        );

    let offered = wait_event(&join_log, "offered", Duration::from_secs(15)).await;
    let offered_summary = offered.summary.as_ref().expect("offer summary");
    assert_eq!(
        offered_summary["attachedBookCount"],
        if already_imported { 0 } else { 1 }
    );
    assert_eq!(
        offered_summary["reusedBookCount"],
        if already_imported { 1 } else { 0 }
    );
    let transfer_id = offered.transfer_id.clone().expect("offer transferId");
    let preview = tokio::time::timeout(
        Duration::from_secs(30),
        accept(&receiver_handle, &session_id, &transfer_id),
    )
    .await
    .expect("accept should not time out")
    .expect("accept should prepare");
    assert_eq!(preview.book_count, 1);
    if already_imported {
        assert!(preview.attached_books.is_empty());
    } else {
        assert_eq!(preview.attached_books, vec![content_hash.clone()]);
    }
    assert!(preview.missing_books.is_empty());
    let committed = commit(&receiver_handle, &session_id, &transfer_id, false)
        .await
        .expect("commit should succeed");
    assert_eq!(committed.status, "committed");
    let sent = tokio::time::timeout(Duration::from_secs(30), send_task)
        .await
        .expect("send should not time out")
        .expect("send task should join")
        .expect("send should return");
    assert_eq!(sent.status, "completed", "{sent:?}");
    let remote = sent.remote_commit.expect("remote commit summary");
    assert_eq!(remote.imported_book_count, 1);
    assert!(!remote.applied_preferences);

    assert!(
        !join_log
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.event == "exporting"),
        "receiver prepare progress must not be projected as export"
    );
    let remote_books = snapshot_books(&receiver);
    assert!(remote_books.contains_key(&content_hash));
    let managed = receiver
        .root
        .join("linked-library")
        .join("books")
        .join(format!("{content_hash}.epub"));
    assert_eq!(std::fs::read(managed).unwrap(), bytes);
    let raw = with_existing_store(&receiver_handle, |store| store.binding_raw(&content_hash))
        .unwrap()
        .unwrap()
        .unwrap();
    let binding: LocalBinding = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        binding.cover_zip_path.as_deref(),
        Some("OPS/Images/cover.jpg")
    );
    assert_eq!(binding.cover_mime, "image/jpeg");
    assert_eq!(snapshot_books(&receiver).len(), 1);
    let _ = close(&receiver_handle, &session_id).await;
    let _ = close(&sender_handle, &session_id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_rejects_wrong_pin_and_token_without_touching_store() {
    let host = TestApp::new("pin-host");
    let guest = TestApp::new("pin-guest");
    let host_handle = host.handle();
    let guest_handle = guest.handle();
    let host_log = EventLog::default();
    let guest_log = EventLog::default();

    let started = start_host(&host_handle, Ipv4Addr::LOCALHOST, host_log.sink())
        .await
        .expect("host should start");
    let pairing = LanPairing::parse(&started.pairing_info).expect("valid pairing");

    let mut wrong_pin = pairing.clone();
    let last = if wrong_pin.certificate_sha256.ends_with('0') {
        '1'
    } else {
        '0'
    };
    wrong_pin.certificate_sha256.pop();
    wrong_pin.certificate_sha256.push(last);
    let pin_error = join(
        &guest_handle,
        &wrong_pin.encode().unwrap(),
        guest_log.sink(),
    )
    .await
    .expect_err("pin mismatch must fail");
    assert_eq!(pin_error.code, "pin-mismatch");

    let mut wrong_token = pairing;
    wrong_token.token = "0".repeat(64);
    let token_error = join(
        &guest_handle,
        &wrong_token.encode().unwrap(),
        guest_log.sink(),
    )
    .await
    .expect_err("token mismatch must fail");
    assert_eq!(token_error.code, "token-mismatch");

    assert!(snapshot_books(&guest).is_empty());
    let books_dir = guest.root.join("linked-library").join("books");
    if books_dir.exists() {
        assert_eq!(std::fs::read_dir(&books_dir).unwrap().count(), 0);
    }

    let _ = close(&host_handle, &started.session_id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_connection_stop_wakes_pending_control_read() {
    let identity = TlsIdentity::generate(Ipv4Addr::LOCALHOST).unwrap();
    let fingerprint = identity.fingerprint.clone();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server_identity = Arc::new(identity);
    let server = tokio::spawn({
        let server_identity = server_identity.clone();
        async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let acceptor = TlsAcceptor::from(Arc::new(server_identity.server_config().unwrap()));
            let tls = acceptor.accept(tcp).await.unwrap();
            LanConnection::new(LanIo::Server(tls))
        }
    });

    let tcp = TcpStream::connect(addr).await.unwrap();
    let connector = TlsConnector::from(Arc::new(client_config(&fingerprint).unwrap()));
    let tls = connector
        .connect(server_name(Ipv4Addr::LOCALHOST), tcp)
        .await
        .unwrap();
    let client = Arc::new(LanConnection::new(LanIo::Client(tls)));
    let server = Arc::new(server.await.unwrap());

    let pending = {
        let server = server.clone();
        tokio::spawn(async move { server.read_control().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    server.stop();
    let error = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .expect("stop must wake pending read")
        .expect("read task join")
        .expect_err("read should be cancelled");
    assert_eq!(error.code, "cancelled");
    client.stop();
    drop((client, server));
}

#[test]
fn lan_gate_keeps_commit_slot_on_close() {
    let gate = SessionGate::default();
    gate.paired().unwrap();
    gate.accept_download().unwrap();
    gate.received_exact_archive().unwrap();
    gate.import_prepared().unwrap();
    gate.begin_commit().unwrap();
    assert_eq!(gate.close().unwrap(), GateClose::CommitInProgress);
    // The local commit finishes, but a closed link must not send an ACK.
    assert!(!gate.commit_finished().unwrap());
    assert_eq!(gate.close().unwrap(), GateClose::AlreadyFinished);
}

#[test]
fn lan_session_slots_are_identity_scoped() {
    let manager = super::LanSaveManager::default();
    let first = Arc::new(super::session::LanSession::new_join(
        new_uuid().unwrap(),
        new_uuid().unwrap(),
        Arc::new(|_| {}),
    ));
    manager.insert(first.clone()).unwrap();
    manager.remove_if_same(&first);
    assert!(manager.get(&first.session_id).is_err());

    // A late callback from the old session must not clear a new session that
    // reused the same valid sessionId.
    let second = Arc::new(super::session::LanSession::new_join(
        first.session_id.clone(),
        new_uuid().unwrap(),
        Arc::new(|_| {}),
    ));
    manager.insert(second.clone()).unwrap();
    manager.remove_if_same(&first);
    assert!(manager.get(&second.session_id).is_ok());
    manager.remove_if_same(&second);
    assert!(manager.get(&second.session_id).is_err());
}

#[tokio::test]
async fn lan_worker_owner_blocks_cleanup_until_blocking_worker_exits() {
    let owner = Arc::new(super::session::WorkerOwner::default());
    let command = owner.enter().unwrap();
    let blocking_lease = command.child().unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let blocking = tokio::task::spawn_blocking(move || {
        let _lease = blocking_lease;
        wait.recv().unwrap();
    });
    owner.request_close();
    drop(command);
    assert!(
        tokio::time::timeout(Duration::from_millis(5), owner.drain_closed())
            .await
            .is_err()
    );
    release.send(()).unwrap();
    blocking.await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), owner.drain_closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn lan_worker_owner_close_bars_new_entries_and_is_shared() {
    let owner = Arc::new(super::session::WorkerOwner::default());
    let command = owner.enter().unwrap();
    assert!(owner.request_close());
    assert!(!owner.request_close());
    assert!(owner.enter().is_err());
    assert!(command.child().is_err());
    let mut attached = false;
    assert!(command.while_open(|| attached = true).is_err());
    assert!(!attached);
    drop(command);
    tokio::time::timeout(Duration::from_secs(1), owner.drain_closed())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_pending_join_close_wakes_connection_attempt() {
    let app = TestApp::new("pending-join");
    let handle = app.handle();
    let identity = TlsIdentity::generate(Ipv4Addr::LOCALHOST).unwrap();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let pairing = super::pairing::LanPairing::new(
        new_uuid().unwrap(),
        Ipv4Addr::LOCALHOST,
        addr.port(),
        identity.fingerprint.clone(),
        "a".repeat(64),
    );
    let pairing_info = pairing.encode().unwrap();
    let join_handle = handle.clone();
    let join_task =
        tokio::spawn(async move { join(&join_handle, &pairing_info, Arc::new(|_| {})).await });
    let (tcp, _) = listener.accept().await.unwrap();
    let _keep_open = tcp;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let closed = close(&handle, &pairing.session_id).await.unwrap();
    assert_eq!(closed.status, "cancelled");
    let joined = tokio::time::timeout(Duration::from_secs(2), join_task)
        .await
        .expect("pending join must be woken by close")
        .expect("join task join");
    assert!(joined.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_busy_retries_same_offer_and_preview_disconnect_releases_slot() {
    let sender = TestApp::new("busy-sender");
    let receiver = TestApp::new("busy-receiver");
    seed_book(&sender, &hex_digest(b"busy book"), b"busy book");
    let sh = sender.handle();
    let rh = receiver.handle();
    let log = EventLog::default();
    let host = start_host(&sh, Ipv4Addr::LOCALHOST, Arc::new(|_| {}))
        .await
        .unwrap();
    join(&rh, &host.pairing_info, log.sink()).await.unwrap();
    let blocked = reserve_job(&sh, &new_uuid().unwrap()).unwrap();
    assert_eq!(
        send(&sh, &host.session_id, SaveExportScope::All, false)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    finish_task(&sh, &blocked);
    let sid = host.session_id.clone();
    let send_app = sh.clone();
    let sending =
        tokio::spawn(async move { send(&send_app, &sid, SaveExportScope::All, false).await });
    let offer = wait_event(&log, "offered", Duration::from_secs(5)).await;
    assert_eq!(offer.summary.as_ref().unwrap()["skippedBookCount"], 0);
    let tid = offer.transfer_id.unwrap();
    let blocked = reserve_job(&rh, &new_uuid().unwrap()).unwrap();
    assert_eq!(
        accept(&rh, &host.session_id, &tid).await.unwrap_err().code,
        "busy"
    );
    finish_task(&rh, &blocked);
    let prepared = accept(&rh, &host.session_id, &tid).await.unwrap();
    assert_eq!(prepared.book_count, 1);
    // Failed preflight must not consume the Offer. Disconnect at preview must
    // discard prepared data and release the exclusive F-N slot.
    close(&sh, &host.session_id).await.unwrap();
    close(&rh, &host.session_id).await.unwrap();
    assert_eq!(sending.await.unwrap().unwrap().status, "unconfirmed");
    assert!(snapshot_books(&receiver).is_empty());
    let next = reserve_job(&rh, &new_uuid().unwrap()).unwrap();
    finish_task(&rh, &next);
    assert_eq!(
        close(&rh, &host.session_id).await.unwrap().status,
        "already-finished"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_close_and_dropped_invoke_do_not_cancel_accepted_commit() {
    let sender = TestApp::new("commit-sender");
    let receiver = TestApp::new("commit-receiver");
    let hash = hex_digest(b"commit book");
    seed_book(&sender, &hash, b"commit book");
    let sh = sender.handle();
    let rh = receiver.handle();
    let log = EventLog::default();
    let host = start_host(&sh, Ipv4Addr::LOCALHOST, Arc::new(|_| {}))
        .await
        .unwrap();
    let log_sink = log.sink();
    let commit_receiver = rh.clone();
    join(
        &rh,
        &host.pairing_info,
        Arc::new(move |event| {
            if event.event == "committing" {
                // Close after acceptance, before heartbeat/commit workers start.
                let session = commit_receiver
                    .state::<super::LanSaveManager>()
                    .get(&event.session_id)
                    .unwrap();
                assert_eq!(session.gate().close().unwrap(), GateClose::CommitInProgress);
                session.request_workers_close();
                session.request_close();
                session.connection().unwrap().stop();
            }
            log_sink(event);
        }),
    )
    .await
    .unwrap();
    let sid = host.session_id.clone();
    let send_app = sh.clone();
    let sending =
        tokio::spawn(async move { send(&send_app, &sid, SaveExportScope::All, true).await });
    let offer = wait_event(&log, "offered", Duration::from_secs(5)).await;
    let tid = offer.transfer_id.unwrap();
    accept(&rh, &host.session_id, &tid).await.unwrap();
    // Hold the real storage lock so the commit worker is demonstrably alive.
    let write_state = rh.state::<LinkedLibraryWriteState>();
    let blocked = write_state.0.lock().unwrap();
    let commit_app = rh.clone();
    let sid = host.session_id.clone();
    let invoking = tokio::spawn(async move { commit(&commit_app, &sid, &tid, false).await });
    wait_event(&log, "committing", Duration::from_secs(5)).await;
    invoking.abort(); // The native owner must survive loss of the IPC waiter.
    assert_eq!(
        close(&rh, &host.session_id).await.unwrap().status,
        "too-late"
    );
    assert_eq!(
        close(&rh, &host.session_id).await.unwrap().status,
        "too-late"
    );
    assert_eq!(
        reserve_job(&rh, &new_uuid().unwrap()).unwrap_err().code,
        "busy"
    );
    drop(blocked);
    let sent = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(sent.status, "unconfirmed");
    // The disconnected peer cannot confirm, but local commit must finish.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match reserve_job(&rh, &new_uuid().unwrap()) {
                Ok(task) => {
                    finish_task(&rh, &task);
                    break;
                }
                Err(error) => {
                    assert_eq!(error.code, "busy");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(snapshot_books(&receiver).contains_key(&hash));
    assert_eq!(
        close(&rh, &host.session_id).await.unwrap().status,
        "already-finished"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_partial_control_frame_survives_select_without_prefetch() {
    let identity = TlsIdentity::generate(Ipv4Addr::LOCALHOST).unwrap();
    let fingerprint = identity.fingerprint.clone();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (continue_write, wait) = tokio::sync::oneshot::channel();
    let (partial_written, ready) = tokio::sync::oneshot::channel();
    let session_id = new_uuid().unwrap();
    let message = super::protocol::ControlMessage::Error {
        session_id: session_id.clone(),
        transfer_id: None,
        code: "test".into(),
        message: "test".into(),
    };
    let payload = serde_json::to_vec(&message).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(identity.server_config().unwrap()));
        let mut tls = acceptor.accept(tcp).await.unwrap();
        tls.write_all(&frame[..2]).await.unwrap();
        tls.flush().await.unwrap();
        partial_written.send(()).unwrap();
        wait.await.unwrap();
        // Next-phase bytes already available in the same TLS stream must not
        // be swallowed by the first frame parser.
        let rest = [&frame[2..], &frame[..]].concat();
        tls.write_all(&rest).await.unwrap();
        tls.flush().await.unwrap();
        tls
    });
    let tcp = TcpStream::connect(addr).await.unwrap();
    let connector = TlsConnector::from(Arc::new(client_config(&fingerprint).unwrap()));
    let tls = connector
        .connect(server_name(Ipv4Addr::LOCALHOST), tcp)
        .await
        .unwrap();
    let client = LanConnection::new(LanIo::Client(tls));
    ready.await.unwrap();
    let mut buffer = Vec::new();
    assert!(tokio::time::timeout(
        Duration::from_millis(50),
        client.read_control_buffered(&mut buffer, None)
    )
    .await
    .is_err());
    assert_eq!(buffer.len(), 2);
    continue_write.send(()).unwrap();
    let _keep_open = server.await.unwrap();
    let first = client
        .read_control_buffered(&mut buffer, Some(Duration::from_secs(1)))
        .await
        .unwrap();
    assert_eq!(first.session_id(), session_id);
    assert!(buffer.is_empty());
    let second = client
        .read_control_buffered(&mut buffer, Some(Duration::from_secs(1)))
        .await
        .unwrap();
    assert_eq!(second.session_id(), session_id);
    assert!(buffer.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn lan_space_preflight_rejects_without_accept_or_store_change() {
    let sender = TestApp::new("space-sender");
    let receiver = TestApp::new("space-receiver");
    let hash = hex_digest(b"space book");
    seed_book(&sender, &hash, b"space book");
    let sh = sender.handle();
    let rh = receiver.handle();
    let log = EventLog::default();
    let host = start_host(&sh, Ipv4Addr::LOCALHOST, Arc::new(|_| {}))
        .await
        .unwrap();
    join(&rh, &host.pairing_info, log.sink()).await.unwrap();
    let sid = host.session_id.clone();
    let send_app = sh.clone();
    let sending =
        tokio::spawn(async move { send(&send_app, &sid, SaveExportScope::All, true).await });
    let offer = wait_event(&log, "offered", Duration::from_secs(5)).await;
    let tid = offer.transfer_id.unwrap();

    // Test-only override: the receiver's next real volume probe reports zero
    // available bytes. No device storage is filled.
    crate::save_file::set_available_space_override(Some(0));
    let rejected = accept(&rh, &host.session_id, &tid).await;
    crate::save_file::clear_available_space_override();
    let error = rejected.expect_err("low-space accept must fail");
    assert_eq!(error.code, "insufficient-space");

    let sent = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .expect("sender should observe decline")
        .expect("send task join")
        .expect("send returns a result");
    assert_eq!(sent.status, "cancelled");
    assert_eq!(sent.code.as_deref(), Some("insufficient-space"));
    assert!(snapshot_books(&receiver).is_empty());
    let managed = receiver
        .root
        .join("linked-library")
        .join("books")
        .join(format!("{hash}.epub"));
    assert!(!managed.exists());
    let staging = receiver
        .root
        .join("linked-library")
        .join("books")
        .join(".staging");
    if staging.exists() {
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    }
    let _ = close(&rh, &host.session_id).await;
    let _ = close(&sh, &host.session_id).await;
}

#[test]
fn lan_v1_pairing_is_rejected_with_clear_protocol_mismatch() {
    let mut pairing = LanPairing::new(
        new_uuid().unwrap(),
        Ipv4Addr::new(10, 0, 0, 1),
        47777,
        "b".repeat(64),
        "a".repeat(64),
    );
    pairing.version = 1;
    let error = LanPairing::parse(&pairing.encode().unwrap()).unwrap_err();
    assert_eq!(error.code, "protocol-mismatch");
    assert!(error.message.contains("更新到支持同一互传协议"));
}

#[test]
fn lan_commit_summary_wire_stays_under_two_kib() {
    let message = super::protocol::ControlMessage::Result {
        session_id: new_uuid().unwrap(),
        transfer_id: new_uuid().unwrap(),
        status: "committed".to_string(),
        result: Some(super::protocol::LanCommitSummary {
            imported_book_count: 50_000,
            new_visible_book_count: 123,
            missing_book_count: 0,
            progress_conflict_book_count: 2,
            applied_preferences: true,
        }),
        code: None,
        message: None,
    };
    let bytes = serde_json::to_vec(&message).unwrap();
    assert!(bytes.len() < 2048, "wire result too large: {}", bytes.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_shutdown_notifies_quiet_session_and_drains_before_retry() {
    let host = TestApp::new("suspend-host");
    let guest = TestApp::new("suspend-guest");
    let hh = host.handle();
    let gh = guest.handle();
    let log = EventLog::default();
    let session = start_host(&hh, Ipv4Addr::LOCALHOST, log.sink())
        .await
        .unwrap();
    join(&gh, &session.pairing_info, Arc::new(|_| {}))
        .await
        .unwrap();
    super::manager::shutdown(&hh);
    let event = wait_event(&log, "closed", Duration::from_secs(2)).await;
    assert_eq!(event.code.as_deref(), Some("cancelled"));
    tokio::time::timeout(Duration::from_secs(2), close(&hh, &session.session_id))
        .await
        .unwrap()
        .unwrap();
    close(&gh, &session.session_id).await.unwrap();
    let next = start_host(&hh, Ipv4Addr::LOCALHOST, Arc::new(|_| {}))
        .await
        .unwrap();
    close(&hh, &next.session_id).await.unwrap();
}

#[test]
fn lan_merge_processing_sequence_survives_phase_clock_reset() {
    use super::bulk_policy::RemotePhase;
    use super::protocol::ProcessingPhase;
    use super::session::LanSession;
    let session = LanSession::new_join(new_uuid().unwrap(), new_uuid().unwrap(), Arc::new(|_| {}));
    assert!(session
        .observe_remote_processing(0, ProcessingPhase::Checking)
        .is_err());
    session
        .observe_remote_processing(7, ProcessingPhase::Checking)
        .unwrap();
    assert!(session
        .observe_remote_processing(7, ProcessingPhase::Checking)
        .is_err());
    session.clear_remote_wait();
    session.arm_remote_wait(RemotePhase::Receiving).unwrap();
    assert!(session
        .observe_remote_processing(7, ProcessingPhase::Receiving)
        .is_err());
    session
        .observe_remote_processing(8, ProcessingPhase::Receiving)
        .unwrap();
}

#[test]
fn lan_merge_binding_verification_cancels_between_buffers() {
    let app = TestApp::new("hash-cancel");
    let body = vec![42_u8; 3 * crate::save_file::COPY_BUFFER_BYTES];
    let hash = hex_digest(&body);
    seed_book(&app, &hash, &body);
    let root = app.root.join("linked-library");
    let binding = LocalBinding::new_managed(&hash, body.len() as u64, 0);
    let calls = std::cell::Cell::new(0);
    let result = binding.is_valid_cancellable(&root, || {
        calls.set(calls.get() + 1);
        calls.get() >= 3
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(binding.is_valid(&root));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_merge_cancel_reaches_pump_while_inventory_is_blocked() {
    let sender = TestApp::new("blocked-inventory-sender");
    let receiver = TestApp::new("blocked-inventory-receiver");
    let hash = hex_digest(b"blocked inventory");
    seed_book(&sender, &hash, b"blocked inventory");
    let sh = sender.handle();
    let rh = receiver.handle();
    let host = start_host(&sh, Ipv4Addr::LOCALHOST, Arc::new(|_| {}))
        .await
        .unwrap();
    join(&rh, &host.pairing_info, Arc::new(|_| {}))
        .await
        .unwrap();
    let session = rh
        .state::<super::LanSaveManager>()
        .get(&host.session_id)
        .unwrap();
    let hold_app = rh.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hold = tokio::task::spawn_blocking(move || {
        with_existing_store(&hold_app, |_| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        })
        .unwrap();
    });
    entered_rx.await.unwrap();
    let sid = host.session_id.clone();
    let send_app = sh.clone();
    let sending =
        tokio::spawn(async move { send(&send_app, &sid, SaveExportScope::All, true).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while session.gate().phase().unwrap() != super::session::Phase::Checking {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Let the query enter the real blocked repository lookup, then stop peer.
    tokio::time::sleep(Duration::from_millis(80)).await;
    close(&sh, &host.session_id).await.unwrap();
    let cancelled = tokio::time::timeout(Duration::from_secs(2), session.wait_until_closed()).await;
    // Always release the lock before asserting, even if the old pump deadlocks.
    release_tx.send(()).unwrap();
    hold.await.unwrap();
    assert!(
        cancelled.is_ok(),
        "control pump stopped reading during inventory"
    );
    let _ = sending.await.unwrap();
    close(&rh, &host.session_id).await.unwrap();
}
