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
                    while input.len() - header_end < length {
                        let mut buf = [0; 4096];
                        let count = socket.read(&mut buf).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        input.extend_from_slice(&buf[..count]);
                    }
                    let body = &input[header_end..header_end + length];
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
                                    // Deliberately ignores If-None-Match, like the first live service.
                                    let existed =
                                        store.files.insert(path.into(), body.to_vec()).is_some();
                                    if existed {
                                        204
                                    } else {
                                        201
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
                                    store.files.remove(path);
                                    if store.directories.remove(path) {
                                        store.files.retain(|p, _| !p.starts_with(path));
                                        store.directories.retain(|p| !p.starts_with(path));
                                    }
                                    204
                                }
                                _ => 405,
                            }
                        };
                        (status, result, extra)
                    };
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
                });
            }
        });
        Self { base, store, task }
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
        format_version: 1,
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
