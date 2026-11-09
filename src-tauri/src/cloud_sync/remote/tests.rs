use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct Store {
    files: BTreeMap<String, Vec<u8>>,
    directories: BTreeSet<String>,
    requests: usize,
    fail_put_status: Option<u16>,
    early_put_status: Option<u16>,
    fail_delete_status: Option<u16>,
    slow_put: bool,
}

struct Server {
    base: String,
    store: Arc<Mutex<Store>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

fn response_xml(path: &str, collection: bool, size: usize) -> String {
    format!(
        r#"<r:response><r:href>{}</r:href><r:propstat><r:prop><r:resourcetype>{}</r:resourcetype><r:getetag>"v1"</r:getetag><r:getcontentlength>{size}</r:getcontentlength></r:prop><r:status>HTTP/1.1 200 OK</r:status></r:propstat><r:propstat><r:prop><r:unavailable/></r:prop><r:status>HTTP/1.1 404 Not Found</r:status></r:propstat></r:response>"#,
        xml_escape(path),
        if collection { "<r:collection/>" } else { "" }
    )
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/dav/", listener.local_addr().unwrap());
        let store = Arc::new(Mutex::new(Store {
            directories: BTreeSet::from(["/dav/".into()]),
            ..Default::default()
        }));
        let shared = store.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let shared = shared.clone();
                tokio::spawn(async move {
                    let mut input = Vec::new();
                    let header_end = loop {
                        let mut buf = [0; 4096];
                        let count = socket.read(&mut buf).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        input.extend_from_slice(&buf[..count]);
                        assert!(input.len() < 1024 * 1024);
                        if let Some(index) = input.windows(4).position(|v| v == b"\r\n\r\n") {
                            break index + 4;
                        }
                    };
                    let header = String::from_utf8(input[..header_end].to_vec()).unwrap();
                    let mut lines = header.lines();
                    let first = lines.next().unwrap().split_whitespace().collect::<Vec<_>>();
                    let (method, path) = (first[0], first[1]);
                    let headers = lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
                        .collect::<BTreeMap<_, _>>();
                    let length = headers
                        .get("content-length")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let early_put = if method == "PUT" {
                        shared.lock().unwrap().early_put_status
                    } else {
                        None
                    };
                    let body_length = if early_put.is_some() { 0 } else { length };
                    while input.len() - header_end < body_length {
                        let mut buf = [0; 4096];
                        let count = socket.read(&mut buf).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        input.extend_from_slice(&buf[..count]);
                    }
                    let body = if early_put.is_some() {
                        &[][..]
                    } else {
                        &input[header_end..header_end + length]
                    };
                    let (status, result, extra) = {
                        let mut store = shared.lock().unwrap();
                        store.requests += 1;
                        assert!(headers
                            .get("authorization")
                            .is_some_and(|v| v.starts_with("Basic ")));
                        let mut result = Vec::new();
                        let mut extra = String::new();
                        let status = if let Some(code) = path
                            .rsplit('/')
                            .next()
                            .and_then(|v| v.strip_prefix("error-"))
                            .and_then(|v| v.parse::<u16>().ok())
                        {
                            extra = "Retry-After: 7\r\n".into();
                            code
                        } else if path.ends_with("/redirect") {
                            extra = "Location: https://example.invalid/never-follow\r\n".into();
                            302
                        } else if path.ends_with("/oversize") || path.ends_with("/chunked") {
                            result = b"abcd".to_vec();
                            200
                        } else if path.ends_with("/slow") {
                            200
                        } else {
                            match method {
                                "MKCOL" => {
                                    if store.directories.contains(path) {
                                        405
                                    } else {
                                        store.directories.insert(path.into());
                                        201
                                    }
                                }
                                "PUT" => {
                                    if let Some(code) = store.early_put_status {
                                        code
                                    } else if let Some(code) = store.fail_put_status {
                                        code
                                    } else {
                                        // Deliberately ignores If-None-Match, like the first live service.
                                        let existed = store
                                            .files
                                            .insert(path.into(), body.to_vec())
                                            .is_some();
                                        if existed {
                                            204
                                        } else {
                                            201
                                        }
                                    }
                                }
                                "GET" => match store.files.get(path) {
                                    Some(_)
                                        if headers.get("if-none-match").map(String::as_str)
                                            == Some("\"v1\"") =>
                                    {
                                        304
                                    }
                                    Some(bytes) => {
                                        result = bytes.clone();
                                        extra = "ETag: \"v1\"\r\n".into();
                                        200
                                    }
                                    None => 404,
                                },
                                "MOVE" => {
                                    let destination =
                                        Url::parse(headers.get("destination").unwrap())
                                            .unwrap()
                                            .path()
                                            .to_string();
                                    if headers.get("overwrite").map(String::as_str) == Some("F")
                                        && store.files.contains_key(&destination)
                                    {
                                        409
                                    } else if let Some(bytes) = store.files.remove(path) {
                                        store.files.insert(destination, bytes);
                                        201
                                    } else {
                                        404
                                    }
                                }
                                "PROPFIND" => {
                                    if !store.directories.contains(path) {
                                        404
                                    } else {
                                        let mut xml = format!(
                                            r#"<?xml version="1.0"?><r:multistatus xmlns:r="DAV:">{}"#,
                                            response_xml(path, true, 0)
                                        );
                                        for (file, bytes) in &store.files {
                                            if file
                                                .strip_prefix(path)
                                                .is_some_and(|v| !v.contains('/'))
                                            {
                                                xml.push_str(&response_xml(
                                                    file,
                                                    false,
                                                    bytes.len(),
                                                ));
                                            }
                                        }
                                        for dir in &store.directories {
                                            if dir != path
                                                && dir.strip_prefix(path).is_some_and(|v| {
                                                    !v.trim_end_matches('/').contains('/')
                                                })
                                            {
                                                xml.push_str(&response_xml(dir, true, 0));
                                            }
                                        }
                                        xml.push_str("</r:multistatus>");
                                        result = xml.into_bytes();
                                        207
                                    }
                                }
                                "DELETE" => {
                                    if let Some(code) = store.fail_delete_status {
                                        code
                                    } else {
                                        store.files.remove(path);
                                        if store.directories.remove(path) {
                                            store.files.retain(|p, _| !p.starts_with(path));
                                            store.directories.retain(|p| !p.starts_with(path));
                                        }
                                        204
                                    }
                                }
                                _ => 405,
                            }
                        };
                        (status, result, extra)
                    };
                    if method == "PUT" && shared.lock().unwrap().slow_put {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    if path.ends_with("/slow") {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    let packet = if path.ends_with("/chunked") {
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n0\r\n\r\n".as_bytes().to_vec()
                    } else {
                        let mut packet=format!("HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n",result.len()).into_bytes();
                        packet.extend(result);
                        packet
                    };
                    let _ = socket.write_all(&packet).await;
                    if early_put.is_some() {
                        // The 507 was intentionally sent before the request
                        // body was consumed. Drain the remaining body so a
                        // TCP reset cannot erase the response on loopback;
                        // the client has already stopped writing when hyper
                        // accepts this early response.
                        let mut sink = [0u8; 4096];
                        while matches!(socket.read(&mut sink).await, Ok(count) if count > 0) {}
                    }
                });
            }
        });
        Self { base, store, task }
    }

    fn fail_puts(&self, status: u16) {
        self.store.lock().unwrap().fail_put_status = Some(status);
    }

    fn allow_puts(&self) {
        self.store.lock().unwrap().fail_put_status = None;
    }

    fn slow_puts(&self) {
        self.store.lock().unwrap().slow_put = true;
    }

    fn fail_puts_early(&self, status: u16) {
        self.store.lock().unwrap().early_put_status = Some(status);
    }

    fn fail_deletes(&self, status: u16) {
        self.store.lock().unwrap().fail_delete_status = Some(status);
    }

    fn allow_deletes(&self) {
        self.store.lock().unwrap().fail_delete_status = None;
    }

    fn seed_dir(&self, relative: &str) {
        let mut store = self.store.lock().unwrap();
        let prefix = store
            .files
            .keys()
            .find(|name| name.ends_with("/space.json"))
            .and_then(|name| name.strip_suffix("/space.json"))
            .unwrap()
            .to_string();
        store.directories.insert(format!("{prefix}/{relative}/"));
    }

    fn seed_file(&self, relative: &str, bytes: Vec<u8>) {
        let mut store = self.store.lock().unwrap();
        let prefix = store
            .files
            .keys()
            .find(|name| name.ends_with("/space.json"))
            .and_then(|name| name.strip_suffix("/space.json"))
            .unwrap()
            .to_string();
        store.files.insert(format!("{prefix}/{relative}"), bytes);
    }

    fn remote(&self) -> WebDavRemote {
        WebDavRemote::build(
            &self.base,
            "test dir",
            Credentials {
                username: "test".into(),
                app_password: "test".into(),
            },
            true,
        )
        .unwrap()
    }
}

fn space(id: &str) -> Space {
    Space {
        format: super::super::SPACE_FORMAT.into(),
        format_version: super::super::FORMAT_VERSION,
        space_id: id.into(),
        created_at_ms: 1,
    }
}

#[tokio::test]
async fn dav_probe_safe_initialization_publication_and_conditional_read() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let caps = probe(&remote, &cancel).await.unwrap();
    assert!(caps.move_file && caps.move_no_replace);
    assert!(!caps.conditional_create);
    assert!(server.store.lock().unwrap().files.is_empty());
    assert!(!server
        .store
        .lock()
        .unwrap()
        .directories
        .iter()
        .any(|p| p.contains(".probe-")));
    let a = space("11111111-1111-4111-8111-111111111111");
    let b = space("22222222-2222-4222-8222-222222222222");
    let (left, right) = tokio::join!(
        ensure_space(&remote, &a, true, caps, &cancel),
        ensure_space(&remote, &b, true, caps, &cancel)
    );
    let winner = left.unwrap();
    assert_eq!(winner, right.unwrap());
    assert!(winner == a || winner == b);
    let no_safety = Capabilities {
        move_file: true,
        move_no_replace: false,
        conditional_create: false,
    };
    // Existing space is still readable, regardless of first-create capabilities.
    assert_eq!(
        ensure_space(&remote, &a, false, no_safety, &cancel)
            .await
            .unwrap(),
        winner
    );
    let path = RemotePath::new("device.json.gz").unwrap();
    publish(&remote, &path, b"state".to_vec(), true, &cancel)
        .await
        .unwrap();
    let first = remote.get(&path, None, 64, &cancel).await.unwrap();
    assert_eq!(
        first,
        ReadResult::Content {
            bytes: b"state".to_vec(),
            etag: Some("\"v1\"".into())
        }
    );
    assert_eq!(
        remote
            .get(&path, Some("\"v1\""), 64, &cancel)
            .await
            .unwrap(),
        ReadResult::NotModified
    );
    assert_eq!(
        remote
            .get(&RemotePath::new("absent").unwrap(), None, 64, &cancel)
            .await
            .unwrap(),
        ReadResult::Missing
    );
    let target = RemotePath::new("space.json").unwrap();
    remote.delete(&target, false, &cancel).await.unwrap();
    assert_eq!(
        ensure_space(&remote, &a, false, caps, &cancel)
            .await
            .unwrap_err()
            .code,
        RemoteErrorCode::NotFound
    );
    assert_eq!(
        ensure_space(&remote, &a, true, no_safety, &cancel)
            .await
            .unwrap_err()
            .code,
        RemoteErrorCode::UnsafeCreation
    );
    assert!(!server
        .store
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|p| p.contains(".upload-")));
}

#[tokio::test]
async fn dav_errors_redirects_body_limits_and_cancellation_are_bounded() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    for (status, code) in [
        (401, RemoteErrorCode::Authentication),
        (403, RemoteErrorCode::PermissionDenied),
        (409, RemoteErrorCode::Conflict),
        (412, RemoteErrorCode::Conflict),
        (423, RemoteErrorCode::Locked),
        (429, RemoteErrorCode::RateLimited),
        (507, RemoteErrorCode::QuotaExceeded),
        (503, RemoteErrorCode::ServerError),
    ] {
        let path = RemotePath::new(&format!("error-{status}")).unwrap();
        let error = remote.get(&path, None, 64, &cancel).await.unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.http_status, Some(status));
        assert_eq!(error.retry_after_seconds, Some(7));
    }
    assert_eq!(
        remote
            .get(&RemotePath::new("redirect").unwrap(), None, 64, &cancel)
            .await
            .unwrap_err()
            .code,
        RemoteErrorCode::UnsafeRedirect
    );
    for name in ["oversize", "chunked"] {
        assert_eq!(
            remote
                .get(&RemotePath::new(name).unwrap(), None, 3, &cancel)
                .await
                .unwrap_err()
                .code,
            RemoteErrorCode::SizeLimit
        );
    }
    let stopped = Cancel::default();
    stopped.cancel();
    let count = server.store.lock().unwrap().requests;
    assert_eq!(
        remote
            .get(&RemotePath::new("absent").unwrap(), None, 64, &stopped)
            .await
            .unwrap_err()
            .code,
        RemoteErrorCode::Cancelled
    );
    assert_eq!(server.store.lock().unwrap().requests, count);
    let in_flight = Cancel::default();
    let path = RemotePath::new("slow").unwrap();
    let request = remote.get(&path, None, 64, &in_flight);
    let interrupt = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        in_flight.cancel();
    };
    let (result, ()) = tokio::join!(request, interrupt);
    assert_eq!(result.unwrap_err().code, RemoteErrorCode::Cancelled);
}

#[test]
fn dav_xml_paths_and_gzip_do_not_turn_invalid_input_into_empty_state() {
    let url = Url::parse("https://nas.invalid/dav/test%20dir/").unwrap();
    let valid = format!(
        r#"<r:multistatus xmlns:r="DAV:">{}{}</r:multistatus>"#,
        response_xml(url.path(), true, 0),
        response_xml("/dav/test%20dir/a%3Fb%23c%2520", false, 9)
    );
    let entries = dav_xml::listing(valid.as_bytes(), &url).unwrap();
    assert_eq!(entries[0].name, "a?b#c%20");
    for bad in [
        valid.replace("a%3Fb%23c%2520", "%2e%2e/outside"),
        valid.replace("a%3Fb%23c%2520", "a%2Fb"),
        valid.replace(
            "/dav/test%20dir/a%3Fb%23c%2520",
            "https://elsewhere.invalid/x",
        ),
        valid.replace("200 OK", "403 Forbidden"),
        valid.trim_end_matches("</r:multistatus>").to_string(),
        "<html/>".into(),
        r#"<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><x/>"#.into(),
    ] {
        assert!(dav_xml::listing(bad.as_bytes(), &url).is_err());
    }
    for path in ["../x", "x/../y", "x//y", "/x", "x\\y", ""] {
        assert!(RemotePath::new(path).is_err());
    }
    for base in [
        "http://nas.invalid/dav/",
        "https://user:secret@nas.invalid/",
        "https://nas.invalid/dav/?query",
        "https://nas.invalid/dav/#fragment",
    ] {
        assert!(WebDavRemote::new(
            base,
            "books",
            Credentials {
                username: "user".into(),
                app_password: "test".into()
            }
        )
        .is_err());
    }
    let cancel = Cancel::default();
    let json = vec![b' '; 128 * 1024];
    let gzip = codec::encode(&json, &cancel).unwrap();
    assert_eq!(codec::decode(&gzip, &cancel).unwrap(), json);
    assert_eq!(
        codec::decode_with_limit(&gzip, 64, &cancel)
            .unwrap_err()
            .code,
        RemoteErrorCode::SizeLimit
    );
    assert_eq!(
        codec::decode(&gzip[..gzip.len() - 3], &cancel)
            .unwrap_err()
            .code,
        RemoteErrorCode::InvalidResponse
    );
    cancel.cancel();
    assert_eq!(
        codec::decode(&gzip, &cancel).unwrap_err().code,
        RemoteErrorCode::Cancelled
    );
}

#[tokio::test]
#[ignore = "explicit live probe, credentials remain outside the repository"]
async fn live_webdav_probe() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Config {
        base_url: String,
        username: String,
        app_password: String,
        remote_root: String,
    }
    let path = std::env::var("EPUB_READER_WEBDAV_TEST_CONFIG")
        .expect("set the external configuration file path");
    let config: Config =
        serde_json::from_slice(&std::fs::read(path).expect("configuration unreadable"))
            .expect("configuration is not valid JSON");
    assert_eq!(
        config.remote_root, "EPUBReader-Test",
        "only the isolated experiment directory is allowed"
    );
    let remote = WebDavRemote::new(
        &config.base_url,
        &config.remote_root,
        Credentials {
            username: config.username,
            app_password: config.app_password,
        },
    )
    .expect("invalid connection configuration");
    println!("isolated_probe_root={}", remote.root.path());
    let report = probe(&remote, &Cancel::default())
        .await
        .expect("sanitized probe error");
    println!("webdav_probe={}", serde_json::to_string(&report).unwrap());
}

#[tokio::test]
async fn dav_streaming_put_with_length_and_hash_check_are_bounded() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let path = RemotePath::new("books/aa/streamed.bin").unwrap();
    let payload = b"bounded streaming payload".to_vec();
    remote
        .put_stream(
            &path,
            payload.len() as u64,
            reqwest::Body::from(payload.clone()),
            &cancel,
        )
        .await
        .unwrap();
    assert!(server
        .store
        .lock()
        .unwrap()
        .files
        .iter()
        .any(
            |(name, bytes)| name.ends_with(&format!("/{}", path.as_relative()))
                && *bytes == payload
        ));
    assert_eq!(
        remote
            .hash_file(
                &path,
                &crate::save_file::hex_digest(&payload),
                payload.len() as u64,
                &cancel
            )
            .await
            .unwrap(),
        HashCheck::Match
    );
    assert_eq!(
        remote
            .hash_file(&path, &"0".repeat(64), payload.len() as u64, &cancel)
            .await
            .unwrap(),
        HashCheck::Mismatch
    );
    assert_eq!(
        remote
            .hash_file(
                &RemotePath::new("books/aa/missing.bin").unwrap(),
                &"0".repeat(64),
                1,
                &cancel
            )
            .await
            .unwrap(),
        HashCheck::Missing
    );
}

#[tokio::test]
async fn dav_source_stream_aborts_before_publish_when_hash_or_length_changed() {
    let server = Server::start().await;
    let remote = server.remote();
    let path = RemotePath::new("books/aa/source.epub").unwrap();
    let payload = vec![7u8; 256 * 1024];
    let file = std::env::temp_dir().join(format!(
        "epub-reader-stream-{}.bin",
        crate::save_file::new_uuid().unwrap()
    ));
    std::fs::write(&file, &payload).unwrap();
    let hash = crate::save_file::hex_digest(&payload);
    crate::cloud_sync::books::test_put_file(
        &remote,
        &path,
        file.clone(),
        hash.clone(),
        payload.len() as u64,
    )
    .await
    .unwrap();
    assert!(server
        .store
        .lock()
        .unwrap()
        .files
        .iter()
        .any(
            |(name, bytes)| name.ends_with(&format!("/{}", path.as_relative()))
                && *bytes == payload
        ));

    let bad = "0".repeat(64);
    let error = crate::cloud_sync::books::test_put_file(
        &remote,
        &RemotePath::new("books/aa/changed.epub").unwrap(),
        file.clone(),
        bad,
        payload.len() as u64,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "source-changed");
    let _ = std::fs::remove_file(file);
}

#[tokio::test]
async fn dav_streaming_put_reports_quota_and_honors_cancel() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let quota = remote
        .put_stream(
            &RemotePath::new("books/aa/error-507").unwrap(),
            4,
            reqwest::Body::from(b"data".to_vec()),
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(quota.code, RemoteErrorCode::QuotaExceeded);
    assert_eq!(quota.http_status, Some(507));

    let in_flight = Cancel::default();
    let slow = RemotePath::new("books/aa/slow").unwrap();
    let request = remote.put_stream(&slow, 4, reqwest::Body::from(b"data".to_vec()), &in_flight);
    let interrupt = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        in_flight.cancel();
    };
    let (result, ()) = tokio::join!(request, interrupt);
    assert_eq!(result.unwrap_err().code, RemoteErrorCode::Cancelled);
}

#[tokio::test]
async fn dav_repairs_an_object_that_lost_its_completion_marker() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let payload = b"object without marker".to_vec();
    let hash = crate::save_file::hex_digest(&payload);
    let plan = crate::cloud_sync::books::test_plan(hash.clone(), payload.len() as u64);
    remote
        .create_collection(&RemotePath::new("books").unwrap(), &cancel)
        .await
        .unwrap();
    let shard = RemotePath::new("books").unwrap().child(&hash[..2]).unwrap();
    remote.create_collection(&shard, &cancel).await.unwrap();
    let (object_name, _) = crate::cloud_sync::books::test_paths(&plan);
    let object = shard.child(&object_name).unwrap();
    remote
        .put(&object, payload.clone(), WriteCondition::Any, &cancel)
        .await
        .unwrap();
    let caps = Capabilities {
        move_file: true,
        move_no_replace: true,
        conditional_create: false,
    };
    assert!(
        crate::cloud_sync::books::test_resolve_complete(&remote, &plan, "space-id", caps)
            .await
            .unwrap()
    );
    let (_, marker) = crate::cloud_sync::books::test_paths(&plan);
    assert!(server
        .store
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|name| name.ends_with(&format!("/{marker}"))));
}

#[tokio::test]
async fn dav_original_book_batch_uploads_once_and_reports_partial_success() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let cloud_space = space("33333333-3333-4333-8333-333333333333");
    remote
        .put(
            &RemotePath::new("space.json").unwrap(),
            serde_json::to_vec(&cloud_space).unwrap(),
            WriteCondition::Any,
            &cancel,
        )
        .await
        .unwrap();

    let app = tauri::test::mock_builder()
        .manage(crate::cloud_sync::commands::CloudSyncManager::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let handle = app.handle().clone();
    crate::cloud_sync::commands::test_set_connection(
        &handle,
        crate::cloud_sync::model::ConnectionInfo {
            connection_id: "44444444-4444-4444-8444-444444444444".into(),
            settings: crate::cloud_sync::model::Settings {
                base_url: "https://nas.invalid/dav/".into(),
                remote_root: "test dir".into(),
                username: "test".into(),
            },
            space_id: cloud_space.space_id.clone(),
            device_label: "Test".into(),
        },
    );

    let payload = b"original book bytes for upload".to_vec();
    let hash = crate::save_file::hex_digest(&payload);
    let good = std::env::temp_dir().join(format!(
        "epub-reader-book-upload-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    std::fs::write(&good, &payload).unwrap();
    let missing = std::env::temp_dir().join(format!(
        "epub-reader-book-missing-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    let missing_hash = "b".repeat(64);
    let caps = Capabilities {
        move_file: true,
        move_no_replace: true,
        conditional_create: false,
    };
    let files = vec![
        (hash.clone(), good.clone(), payload.len() as u64),
        (missing_hash, missing, 12),
    ];
    let result = crate::cloud_sync::books::test_run_upload(
        &handle,
        &remote,
        files,
        "44444444-4444-4444-8444-444444444444",
        &cloud_space.space_id,
        caps,
    )
    .await
    .unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.uploaded, 1);
    assert_eq!(result.failed, 1);
    let shard = &hash[..2];
    let object = format!("/books/{shard}/{hash}.epub");
    let marker = format!("/books/{shard}/{hash}.ok");
    let store = server.store.lock().unwrap();
    assert!(store.files.keys().any(|name| name.ends_with(&object)));
    assert!(store.files.keys().any(|name| name.ends_with(&marker)));
    assert!(!store.files.keys().any(|name| name.contains(".pending")));
    drop(store);

    let retry = crate::cloud_sync::books::test_run_upload(
        &handle,
        &remote,
        vec![(hash, good.clone(), payload.len() as u64)],
        "44444444-4444-4444-8444-444444444444",
        &cloud_space.space_id,
        caps,
    )
    .await
    .unwrap();
    assert_eq!(retry.status, "completed");
    assert_eq!(retry.already_present, 1);
    assert_eq!(retry.uploaded, 0);

    let quota_payload = b"quota book one".to_vec();
    let quota_hash = crate::save_file::hex_digest(&quota_payload);
    let quota_file = std::env::temp_dir().join(format!(
        "epub-reader-book-quota-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    std::fs::write(&quota_file, &quota_payload).unwrap();
    let quota_missing = std::env::temp_dir().join(format!(
        "epub-reader-book-quota-missing-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    server.fail_puts(507);
    let stopped = crate::cloud_sync::books::test_run_upload(
        &handle,
        &remote,
        vec![
            (quota_hash, quota_file.clone(), quota_payload.len() as u64),
            ("c".repeat(64), quota_missing, 9),
        ],
        "44444444-4444-4444-8444-444444444444",
        &cloud_space.space_id,
        caps,
    )
    .await
    .unwrap();
    assert_eq!(stopped.status, "stopped");
    assert_eq!(stopped.failed, 1);
    assert_eq!(stopped.not_attempted, 1);
    assert_eq!(stopped.books[0].code.as_deref(), Some("quota-exceeded"));

    // Ten thousand already-present books must not cause per-book GET/PUT.
    server.allow_puts();
    server.seed_dir("books");
    let mut plans = Vec::with_capacity(10_000);
    for index in 0..10_000u32 {
        let hash = format!("{:02x}{:062x}", index % 256, index);
        let shard = &hash[..2];
        server.seed_dir(&format!("books/{shard}"));
        server.seed_file(&format!("books/{shard}/{hash}.epub"), vec![1; 10]);
        server.seed_file(&format!("books/{shard}/{hash}.ok"), b"{}".to_vec());
        plans.push(crate::cloud_sync::books::test_plan(hash, 10));
    }
    let before = server.store.lock().unwrap().requests;
    let scale = crate::cloud_sync::books::test_run_upload_plans(
        &handle,
        &remote,
        plans,
        "44444444-4444-4444-8444-444444444444",
        &cloud_space.space_id,
        caps,
    )
    .await
    .unwrap();
    let requests = server.store.lock().unwrap().requests - before;
    assert_eq!(scale.status, "completed");
    assert_eq!(scale.already_present, 10_000);
    assert_eq!(scale.uploaded, 0);
    assert_eq!(scale.failed, 0);
    assert_eq!(requests, 257, "one space GET plus one PROPFIND per shard");
    let _ = std::fs::remove_file(good);
    server.slow_puts();
    let cancel_payload = vec![9u8; 2 * 1024 * 1024];
    let cancel_hash = crate::save_file::hex_digest(&cancel_payload);
    let cancel_file = std::env::temp_dir().join(format!(
        "epub-reader-book-cancel-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    std::fs::write(&cancel_file, &cancel_payload).unwrap();
    let cancel = Cancel::default();
    let run = crate::cloud_sync::books::test_run_upload_plans_with_cancel(
        &handle,
        &remote,
        vec![crate::cloud_sync::books::test_plan_with_file(
            cancel_hash,
            cancel_file.clone(),
            cancel_payload.len() as u64,
        )],
        "44444444-4444-4444-8444-444444444444",
        &cloud_space.space_id,
        caps,
        cancel.clone(),
    );
    let interrupt = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    };
    let (cancelled_result, ()) = tokio::join!(run, interrupt);
    let cancelled_result = cancelled_result.unwrap();
    assert_eq!(cancelled_result.status, "cancelled");
    assert!(server
        .store
        .lock()
        .unwrap()
        .files
        .keys()
        .all(|name| !name.contains(".pending")));
    let _ = std::fs::remove_file(cancel_file);
    let _ = std::fs::remove_file(quota_file);
}

#[tokio::test]
async fn dav_early_quota_response_keeps_quota_and_stop_semantics() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let cloud_space = space("55555555-5555-4555-8555-555555555555");
    remote
        .put(
            &RemotePath::new("space.json").unwrap(),
            serde_json::to_vec(&cloud_space).unwrap(),
            WriteCondition::Any,
            &cancel,
        )
        .await
        .unwrap();

    let app = tauri::test::mock_builder()
        .manage(crate::cloud_sync::commands::CloudSyncManager::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let handle = app.handle().clone();
    crate::cloud_sync::commands::test_set_connection(
        &handle,
        crate::cloud_sync::model::ConnectionInfo {
            connection_id: "55555555-5555-4555-8555-555555555501".into(),
            settings: crate::cloud_sync::model::Settings {
                base_url: "https://nas.invalid/dav/".into(),
                remote_root: "test dir".into(),
                username: "test".into(),
            },
            space_id: cloud_space.space_id.clone(),
            device_label: "Test".into(),
        },
    );

    let payload = vec![3u8; 512 * 1024];
    let hash = crate::save_file::hex_digest(&payload);
    let file = std::env::temp_dir().join(format!(
        "epub-reader-early-quota-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    std::fs::write(&file, &payload).unwrap();
    let missing = std::env::temp_dir().join(format!(
        "epub-reader-early-quota-missing-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    server.fail_puts_early(507);
    let result = crate::cloud_sync::books::test_run_upload(
        &handle,
        &remote,
        vec![
            (hash, file.clone(), payload.len() as u64),
            ("d".repeat(64), missing, 12),
        ],
        "55555555-5555-4555-8555-555555555501",
        &cloud_space.space_id,
        Capabilities {
            move_file: true,
            move_no_replace: true,
            conditional_create: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.status, "stopped", "{:?}", result.books);
    assert_eq!(result.failed, 1);
    assert_eq!(result.not_attempted, 1);
    assert_eq!(
        result.books[0].code.as_deref(),
        Some("quota-exceeded"),
        "{:?}",
        result.books
    );
    assert_eq!(result.books[1].outcome, "not-attempted");

    // Reuse the same early-response fixture for a non-stop 500. The body
    // channel closes before the source is complete; that must not turn the
    // known remote failure into a user cancellation.
    let server_payload = b"early server error".to_vec();
    let server_hash = crate::save_file::hex_digest(&server_payload);
    let server_file = std::env::temp_dir().join(format!(
        "epub-reader-early-500-{}.epub",
        crate::save_file::new_uuid().unwrap()
    ));
    std::fs::write(&server_file, &server_payload).unwrap();
    server.fail_puts_early(500);
    let server_result = crate::cloud_sync::books::test_run_upload(
        &handle,
        &remote,
        vec![(
            server_hash,
            server_file.clone(),
            server_payload.len() as u64,
        )],
        "55555555-5555-4555-8555-555555555501",
        &cloud_space.space_id,
        Capabilities {
            move_file: true,
            move_no_replace: true,
            conditional_create: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(server_result.status, "partial", "{:?}", server_result.books);
    assert_eq!(server_result.books[0].outcome, "failed");
    assert_eq!(
        server_result.books[0].code.as_deref(),
        Some("server-error"),
        "{:?}",
        server_result.books
    );
    let _ = std::fs::remove_file(file);
    let _ = std::fs::remove_file(server_file);
}

#[tokio::test]
async fn dav_cleanup_survives_disconnect_and_is_scoped_to_server_and_space() {
    let server = Server::start().await;
    let remote = server.remote();
    let cancel = Cancel::default();
    let space_id = "66666666-6666-4666-8666-666666666666";
    let cloud_space = space(space_id);
    remote
        .put(
            &RemotePath::new("space.json").unwrap(),
            serde_json::to_vec(&cloud_space).unwrap(),
            WriteCondition::Any,
            &cancel,
        )
        .await
        .unwrap();
    let pending = "books/.00000000-0000-4000-8000-000000000001.job.pending";
    server.seed_file(pending, b"orphan pending".to_vec());
    let cleanup_root = std::env::temp_dir().join(format!(
        "epub-reader-er0018-cleanup-{}",
        crate::save_file::new_uuid().unwrap()
    ));
    let cleanup_path = crate::cloud_sync::books::test_cleanup_file(&cleanup_root);
    let owner = crate::cloud_sync::books::test_cleanup_owner(&remote, space_id);
    assert!(crate::cloud_sync::books::test_add_cleanup(
        &cleanup_path,
        &owner,
        pending
    ));

    // A different server, even with the same space id, must never receive
    // this record. It is not a network cleanup target.
    let other_server = Server::start().await;
    let other_remote = other_server.remote();
    let other_owner = crate::cloud_sync::books::test_cleanup_owner(&other_remote, space_id);
    let other_before = other_server.store.lock().unwrap().requests;
    assert!(
        !crate::cloud_sync::books::test_cleanup_remote(
            &cleanup_path,
            &other_remote,
            &other_owner,
            &cancel
        )
        .await
    );
    assert_eq!(other_server.store.lock().unwrap().requests, other_before);

    // The same server but a different space is also a different owner.
    let other_space_owner = crate::cloud_sync::books::test_cleanup_owner(
        &remote,
        "77777777-7777-4777-8777-777777777777",
    );
    let before = server.store.lock().unwrap().requests;
    assert!(
        !crate::cloud_sync::books::test_cleanup_remote(
            &cleanup_path,
            &remote,
            &other_space_owner,
            &cancel
        )
        .await
    );
    assert_eq!(server.store.lock().unwrap().requests, before);

    // Cleanup failure is recorded, then the connection is "disconnected"
    // without deleting the local record. Rebuilding the remote for the same
    // root/space can resume and remove the orphan.
    server.fail_deletes(500);
    assert!(
        crate::cloud_sync::books::test_cleanup_remote(&cleanup_path, &remote, &owner, &cancel)
            .await
    );
    assert!(cleanup_path.exists());
    let (entries, invalid) =
        crate::cloud_sync::books::test_cleanup_scope_entries(&cleanup_path, &owner);
    assert!(!invalid);
    assert_eq!(entries, vec![pending.to_string()]);
    assert!(server
        .store
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|name| name.ends_with(&format!("/{pending}"))));

    server.allow_deletes();
    let reconnected = server.remote();
    let reconnected_owner = crate::cloud_sync::books::test_cleanup_owner(&reconnected, space_id);
    assert_eq!(reconnected_owner, owner);
    assert!(
        !crate::cloud_sync::books::test_cleanup_remote(
            &cleanup_path,
            &reconnected,
            &reconnected_owner,
            &cancel
        )
        .await
    );
    let (entries, invalid) =
        crate::cloud_sync::books::test_cleanup_scope_entries(&cleanup_path, &owner);
    assert!(!invalid);
    assert!(entries.is_empty());
    assert!(!cleanup_path.exists());
    assert!(!server
        .store
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|name| name.ends_with(&format!("/{pending}"))));
    let _ = std::fs::remove_dir_all(cleanup_root);
}
