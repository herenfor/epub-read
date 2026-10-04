use super::connection::{LanConnection, LanIo};
use super::manager::{
    accept, close, commit, join, send, start_host, LanHostResult,
};
use super::pairing::LanPairingV1;
use super::session::{GateClose, LanEventSink, LanSaveEvent, SessionGate};
use super::tls::{client_config, server_name, TlsIdentity};
use crate::linked_library::LinkedLibraryWriteState;
use crate::portable_state::parse_portable_state_value;
use crate::portable_state_commands::{activate_store, with_existing_store, PortableStateManager};
use crate::save_file::commands::SaveFileManager;
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
        self.app
            .as_ref()
            .expect("app is alive")
            .handle()
            .clone()
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        self.app.take();
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
    let sender = TestApp::new("sender");
    let receiver = TestApp::new("receiver");
    let bytes = b"LAN integration epub bytes";
    let content_hash = hex_digest(bytes);
    seed_book(&sender, &content_hash, bytes);

    let sender_handle = sender.handle();
    let receiver_handle = receiver.handle();
    let host_log = EventLog::default();
    let join_log = EventLog::default();

    let host: LanHostResult =
        start_host(&sender_handle, Ipv4Addr::LOCALHOST, host_log.sink())
            .await
            .expect("host should start");
    assert_eq!(host.session_id.len(), 36);

    let join_result =
        tokio::time::timeout(Duration::from_secs(15), join(&receiver_handle, &host.pairing_info, join_log.sink()))
            .await
            .expect("join should not time out")
            .expect("join should pair");
    assert_eq!(join_result.session_id, host.session_id);

    let session_id = host.session_id.clone();
    let send_handle = sender_handle.clone();
    let send_session = session_id.clone();
    let send_task = tokio::spawn(async move {
        send(&send_handle, &send_session, SaveExportScope::All, true).await
    });

    let offered = wait_event(&join_log, "offered", Duration::from_secs(15)).await;
    let transfer_id = offered.transfer_id.clone().expect("offer transferId");

    let preview = tokio::time::timeout(
        Duration::from_secs(30),
        accept(&receiver_handle, &session_id, &transfer_id),
    )
    .await
    .expect("accept should not time out")
    .expect("accept should prepare");
    assert_eq!(preview.book_count, 1);
    assert_eq!(preview.attached_books, vec![content_hash.clone()]);
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
    assert_eq!(remote["status"], "committed");

    let remote_books = snapshot_books(&receiver);
    assert!(remote_books.contains_key(&content_hash));
    let managed = receiver
        .root
        .join("linked-library")
        .join("books")
        .join(format!("{content_hash}.epub"));
    assert_eq!(std::fs::read(managed).unwrap(), bytes);

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
    let pairing = LanPairingV1::parse(&started.pairing_info).expect("valid pairing");

    let mut wrong_pin = pairing.clone();
    let last = if wrong_pin.certificate_sha256.ends_with('0') { '1' } else { '0' };
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
    assert!(gate.commit_finished().unwrap());
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
    let second = Arc::new(super::session::LanSession::new_join(
        first.session_id.clone(),
        new_uuid().unwrap(),
        Arc::new(|_| {}),
    ));
    assert!(manager.insert(second.clone()).is_err());
    manager.remove_if_same(&first);
    assert!(manager.get(&first.session_id).is_err());
}

