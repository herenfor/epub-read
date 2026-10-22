//! Provider-neutral WebDAV I/O for bounded sync metadata, not whole EPUBs.
use super::{codec, dav_xml, parse_space, Space, SyncError};
use reqwest::{header, Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::Serialize;
use std::future::Future;
use std::time::Duration;
use tokio::sync::watch;

pub const LIST_LIMIT: usize = 2 * 1024 * 1024;
pub const SPACE_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteErrorCode {
    InvalidConfig,
    Authentication,
    PermissionDenied,
    NotFound,
    Conflict,
    Locked,
    RateLimited,
    QuotaExceeded,
    Unsupported,
    UnsafeRedirect,
    UnsafeCreation,
    InvalidResponse,
    SizeLimit,
    Timeout,
    Network,
    ServerError,
    Cancelled,
    UnsupportedSyncVersion,
}

/// Never carries response bodies, request URLs, credentials or raw client errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    pub code: RemoteErrorCode,
    pub http_status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
    pub cleanup_failed: bool,
}

impl RemoteError {
    pub(super) fn new(code: RemoteErrorCode) -> Self {
        Self {
            code,
            http_status: None,
            retry_after_seconds: None,
            cleanup_failed: false,
        }
    }

    pub(super) fn status(status: u16) -> Self {
        use RemoteErrorCode::*;
        let mut error = Self::new(match status {
            401 => Authentication,
            403 => PermissionDenied,
            404 => NotFound,
            409 | 412 => Conflict,
            423 => Locked,
            429 => RateLimited,
            507 => QuotaExceeded,
            405 | 501 => Unsupported,
            413 => SizeLimit,
            300..=399 => UnsafeRedirect,
            _ => ServerError,
        });
        error.http_status = Some(status);
        error
    }

    fn transport(error: reqwest::Error) -> Self {
        Self::new(if error.is_timeout() {
            RemoteErrorCode::Timeout
        } else {
            RemoteErrorCode::Network
        })
    }
}

#[derive(Clone)]
pub struct Cancel(watch::Sender<bool>);

impl Default for Cancel {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}

impl Cancel {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }

    pub fn check(&self) -> Result<(), RemoteError> {
        if *self.0.borrow() {
            Err(RemoteError::new(RemoteErrorCode::Cancelled))
        } else {
            Ok(())
        }
    }

    async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        let _ = receiver.wait_for(|value| *value).await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePath(Vec<String>);

impl RemotePath {
    pub fn root() -> Self {
        Self(Vec::new())
    }

    pub fn new(path: &str) -> Result<Self, RemoteError> {
        let mut result = Self::root();
        for part in path.split('/') {
            result = result.child(part)?;
        }
        Ok(result)
    }

    pub fn child(&self, name: &str) -> Result<Self, RemoteError> {
        if name.is_empty()
            || matches!(name, "." | "..")
            || name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
        {
            return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
        }
        let mut parts = self.0.clone();
        parts.push(name.to_string());
        Ok(Self(parts))
    }
}

pub struct Credentials {
    pub username: String,
    pub app_password: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEntry {
    pub name: String,
    pub is_collection: bool,
    pub etag: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadResult {
    Missing,
    NotModified,
    Content {
        bytes: Vec<u8>,
        etag: Option<String>,
    },
}

#[derive(Clone, Copy)]
pub enum WriteCondition {
    Any,
    Absent,
}

/// No cache keyed solely by modification time/length. Callers may reuse bytes
/// only after a successful conditional GET, otherwise read the file again.
pub trait SyncRemote: Send + Sync {
    fn list(
        &self,
        path: &RemotePath,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<Vec<RemoteEntry>, RemoteError>> + Send;
    fn get(
        &self,
        path: &RemotePath,
        etag: Option<&str>,
        limit: usize,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<ReadResult, RemoteError>> + Send;
    fn put(
        &self,
        path: &RemotePath,
        bytes: Vec<u8>,
        condition: WriteCondition,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<(), RemoteError>> + Send;
    fn move_file(
        &self,
        from: &RemotePath,
        to: &RemotePath,
        overwrite: bool,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<(), RemoteError>> + Send;
    /// Returns false only for an existing, verified collection.
    fn create_collection(
        &self,
        path: &RemotePath,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<bool, RemoteError>> + Send;
    fn delete(
        &self,
        path: &RemotePath,
        collection: bool,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<(), RemoteError>> + Send;
}

pub struct WebDavRemote {
    client: Client,
    root: Url,
    credentials: Credentials,
}

impl WebDavRemote {
    pub fn new(
        base_url: &str,
        remote_root: &str,
        credentials: Credentials,
    ) -> Result<Self, RemoteError> {
        Self::build(base_url, remote_root, credentials, false)
    }

    fn build(
        base_url: &str,
        remote_root: &str,
        credentials: Credentials,
        loopback_test: bool,
    ) -> Result<Self, RemoteError> {
        let mut root =
            Url::parse(base_url).map_err(|_| RemoteError::new(RemoteErrorCode::InvalidConfig))?;
        let local_test =
            loopback_test && root.scheme() == "http" && root.host_str() == Some("127.0.0.1");
        if (root.scheme() != "https" && !local_test)
            || root.host_str().is_none()
            || !root.username().is_empty()
            || root.password().is_some()
            || root.query().is_some()
            || root.fragment().is_some()
            || base_url.contains('\\')
            || credentials.username.is_empty()
            || credentials.username.contains(':')
            || credentials.app_password.is_empty()
        {
            return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
        }
        let relative = RemotePath::new(remote_root)?;
        {
            let mut segments = root
                .path_segments_mut()
                .map_err(|_| RemoteError::new(RemoteErrorCode::InvalidConfig))?;
            segments.pop_if_empty();
            for part in &relative.0 {
                segments.push(part);
            }
            segments.push("");
        }
        // No redirect is followed, including same-origin changes. A misconfigured
        // endpoint must be corrected explicitly; credentials never follow it.
        let client = Client::builder()
            .https_only(!local_test)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(45))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .user_agent("EPUBReader-WebDAV/1")
            .build()
            .map_err(RemoteError::transport)?;
        Ok(Self {
            client,
            root,
            credentials,
        })
    }

    fn url(&self, path: &RemotePath, collection: bool) -> Url {
        let mut url = self.root.clone();
        let mut segments = url.path_segments_mut().expect("validated collection URL");
        segments.pop_if_empty();
        for part in &path.0 {
            segments.push(part);
        }
        if collection {
            segments.push("");
        }
        drop(segments);
        url
    }

    fn request(&self, method: Method, path: &RemotePath, collection: bool) -> RequestBuilder {
        self.client
            .request(method, self.url(path, collection))
            .basic_auth(
                &self.credentials.username,
                Some(&self.credentials.app_password),
            )
            .header(header::ACCEPT_ENCODING, "identity")
    }

    async fn send(
        &self,
        request: RequestBuilder,
        cancel: &Cancel,
    ) -> Result<Response, RemoteError> {
        cancel.check()?;
        #[cfg(test)]
        let trace_method = std::env::var_os("EPUB_READER_WEBDAV_TEST_TRACE").and_then(|_| {
            request
                .try_clone()
                .and_then(|r| r.build().ok())
                .map(|r| r.method().clone())
        });
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(RemoteError::new(RemoteErrorCode::Cancelled)),
            response = request.send() => response.map_err(RemoteError::transport)?,
        };
        #[cfg(test)]
        if let Some(method) = trace_method {
            println!(
                "webdav_method={method} status={}",
                response.status().as_u16()
            );
        }
        // 207 is valid only when its individual statuses have been parsed.
        if response.status().is_redirection() && response.status() != StatusCode::NOT_MODIFIED {
            return Err(RemoteError::status(response.status().as_u16()));
        }
        Ok(response)
    }

    fn failure(response: &Response) -> RemoteError {
        let mut error = RemoteError::status(response.status().as_u16());
        error.retry_after_seconds = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        error
    }
}

async fn bounded_body(
    mut response: Response,
    limit: usize,
    cancel: &Cancel,
) -> Result<Vec<u8>, RemoteError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
    }
    let mut output = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(RemoteError::new(RemoteErrorCode::Cancelled)),
            next = response.chunk() => next.map_err(RemoteError::transport)?,
        };
        let Some(chunk) = chunk else {
            return Ok(output);
        };
        if chunk.len() > limit.saturating_sub(output.len()) {
            return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
        }
        output.extend_from_slice(&chunk);
    }
}

impl SyncRemote for WebDavRemote {
    async fn list(
        &self,
        path: &RemotePath,
        cancel: &Cancel,
    ) -> Result<Vec<RemoteEntry>, RemoteError> {
        let request = self.request(Method::from_bytes(b"PROPFIND").unwrap(), path, true)
            .header("Depth", "1").header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
            .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>"#);
        let response = self.send(request, cancel).await?;
        if response.status() != StatusCode::MULTI_STATUS {
            return Err(Self::failure(&response));
        }
        let xml = bounded_body(response, LIST_LIMIT, cancel).await?;
        dav_xml::listing(&xml, &self.url(path, true))
    }

    async fn get(
        &self,
        path: &RemotePath,
        etag: Option<&str>,
        limit: usize,
        cancel: &Cancel,
    ) -> Result<ReadResult, RemoteError> {
        if limit > codec::GZIP_LIMIT {
            return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
        }
        let mut request = self.request(Method::GET, path, false);
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = self.send(request, cancel).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(ReadResult::Missing),
            StatusCode::NOT_MODIFIED if etag.is_some() => Ok(ReadResult::NotModified),
            StatusCode::NOT_MODIFIED => Err(RemoteError::new(RemoteErrorCode::InvalidResponse)),
            StatusCode::OK => {
                let etag = response
                    .headers()
                    .get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let bytes = bounded_body(response, limit, cancel).await?;
                Ok(ReadResult::Content { bytes, etag })
            }
            _ => Err(Self::failure(&response)),
        }
    }

    async fn put(
        &self,
        path: &RemotePath,
        bytes: Vec<u8>,
        condition: WriteCondition,
        cancel: &Cancel,
    ) -> Result<(), RemoteError> {
        if path.0.is_empty() {
            return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
        }
        if bytes.len() > codec::GZIP_LIMIT {
            return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
        }
        let mut request = self
            .request(Method::PUT, path, false)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes);
        if matches!(condition, WriteCondition::Absent) {
            request = request.header(header::IF_NONE_MATCH, "*");
        }
        let response = self.send(request, cancel).await?;
        match response.status().as_u16() {
            200 | 201 | 204 => Ok(()),
            _ => Err(Self::failure(&response)),
        }
    }

    async fn move_file(
        &self,
        from: &RemotePath,
        to: &RemotePath,
        overwrite: bool,
        cancel: &Cancel,
    ) -> Result<(), RemoteError> {
        if from.0.is_empty() || to.0.is_empty() {
            return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
        }
        let response = self
            .send(
                self.request(Method::from_bytes(b"MOVE").unwrap(), from, false)
                    .header("Destination", self.url(to, false).as_str())
                    .header("Overwrite", if overwrite { "T" } else { "F" }),
                cancel,
            )
            .await?;
        match response.status().as_u16() {
            200 | 201 | 204 => Ok(()),
            _ => Err(Self::failure(&response)),
        }
    }

    async fn create_collection(
        &self,
        path: &RemotePath,
        cancel: &Cancel,
    ) -> Result<bool, RemoteError> {
        let response = self
            .send(
                self.request(Method::from_bytes(b"MKCOL").unwrap(), path, true),
                cancel,
            )
            .await?;
        match response.status().as_u16() {
            201 => Ok(true),
            405 | 409 => match self.list(path, cancel).await {
                Ok(_) => Ok(false),
                Err(_) => Err(Self::failure(&response)),
            },
            _ => Err(Self::failure(&response)),
        }
    }

    async fn delete(
        &self,
        path: &RemotePath,
        collection: bool,
        cancel: &Cancel,
    ) -> Result<(), RemoteError> {
        if path.0.is_empty() {
            return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
        }
        let response = self
            .send(self.request(Method::DELETE, path, collection), cancel)
            .await?;
        match response.status().as_u16() {
            200 | 204 | 404 => Ok(()),
            _ => Err(Self::failure(&response)),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub move_file: bool,
    pub conditional_create: bool,
    pub move_no_replace: bool,
}

fn random_name(prefix: &str) -> Result<String, RemoteError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| RemoteError::new(RemoteErrorCode::InvalidConfig))?;
    Ok(format!(
        "{prefix}{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

async fn matches(
    remote: &impl SyncRemote,
    path: &RemotePath,
    bytes: &[u8],
    cancel: &Cancel,
) -> Result<bool, RemoteError> {
    Ok(
        matches!(remote.get(path, None, SPACE_LIMIT, cancel).await?, ReadResult::Content { bytes: actual, .. } if actual == bytes),
    )
}

/// Explicit user-triggered probe. Cleanup owns only the freshly created random
/// directory, never pre-existing data. Cancellation doesn't cancel that cleanup.
pub async fn probe(remote: &impl SyncRemote, cancel: &Cancel) -> Result<Capabilities, RemoteError> {
    let root = RemotePath::root();
    match remote.list(&root, cancel).await {
        Ok(_) => {}
        Err(error) if error.code == RemoteErrorCode::NotFound => {
            remote.create_collection(&root, cancel).await?;
        }
        Err(error) => return Err(error),
    }
    let dir = RemotePath::new(&random_name(".probe-")?)?;
    if !remote.create_collection(&dir, cancel).await? {
        return Err(RemoteError::new(RemoteErrorCode::Conflict));
    }
    let result = async {
        let before = dir.child("before.txt")?;
        let after = dir.child("after.txt")?;
        let source = dir.child("source.txt")?;
        let payload = b"EPUB Reader WebDAV probe\n";
        remote
            .put(&before, payload.to_vec(), WriteCondition::Any, cancel)
            .await?;
        if !matches(remote, &before, payload, cancel).await? {
            return Err(RemoteError::new(RemoteErrorCode::InvalidResponse));
        }
        if !remote
            .list(&dir, cancel)
            .await?
            .iter()
            .any(|item| item.name == "before.txt" && !item.is_collection)
        {
            return Err(RemoteError::new(RemoteErrorCode::InvalidResponse));
        }
        let can_move = match remote.move_file(&before, &after, false, cancel).await {
            Ok(()) => {
                if !matches(remote, &after, payload, cancel).await?
                    || remote.get(&before, None, SPACE_LIMIT, cancel).await? != ReadResult::Missing
                {
                    return Err(RemoteError::new(RemoteErrorCode::InvalidResponse));
                }
                true
            }
            Err(e) if e.code == RemoteErrorCode::Unsupported => false,
            Err(e) => return Err(e),
        };
        let existing = if can_move { &after } else { &before };
        let conditional = match remote
            .put(
                existing,
                b"conditional".to_vec(),
                WriteCondition::Absent,
                cancel,
            )
            .await
        {
            Err(e) if e.http_status == Some(412) => {
                matches(remote, existing, payload, cancel).await?
            }
            Ok(()) => false,
            Err(e) => return Err(e),
        };
        // Some DAV services ignore If-None-Match on PUT. Independently verify
        // MOVE Overwrite:F before using it to create a shared space declaration.
        remote
            .put(existing, payload.to_vec(), WriteCondition::Any, cancel)
            .await?;
        let mut move_no_replace = false;
        if can_move {
            remote
                .put(
                    &source,
                    b"replacement".to_vec(),
                    WriteCondition::Any,
                    cancel,
                )
                .await?;
            move_no_replace = match remote.move_file(&source, existing, false, cancel).await {
                Err(e) if matches!(e.http_status, Some(409 | 412)) => {
                    matches(remote, existing, payload, cancel).await?
                        && matches(remote, &source, b"replacement", cancel).await?
                }
                Ok(()) => false,
                Err(e) => return Err(e),
            };
        }
        Ok(Capabilities {
            move_file: can_move,
            conditional_create: conditional,
            move_no_replace,
        })
    }
    .await;
    let cleanup = remote.delete(&dir, true, &Cancel::default()).await;
    match (result, cleanup) {
        (Ok(report), Ok(())) => Ok(report),
        (Err(mut error), cleanup) => {
            error.cleanup_failed = cleanup.is_err();
            Err(error)
        }
        (Ok(_), Err(mut error)) => {
            error.cleanup_failed = true;
            Err(error)
        }
    }
}

fn decode_space(bytes: &[u8]) -> Result<Space, RemoteError> {
    parse_space(bytes).map_err(|e| {
        RemoteError::new(if e == SyncError::UnsupportedSyncVersion {
            RemoteErrorCode::UnsupportedSyncVersion
        } else {
            RemoteErrorCode::InvalidResponse
        })
    })
}

/// Only an explicit first-connect operation may create a space. A missing file
/// during an established sync must stop; callers must not silently recreate it.
pub async fn ensure_space(
    remote: &impl SyncRemote,
    candidate: &Space,
    create: bool,
    caps: Capabilities,
    cancel: &Cancel,
) -> Result<Space, RemoteError> {
    let path = RemotePath::new("space.json")?;
    match remote.get(&path, None, SPACE_LIMIT, cancel).await? {
        ReadResult::Content { bytes, .. } => return decode_space(&bytes),
        ReadResult::Missing if create => {}
        ReadResult::Missing => return Err(RemoteError::new(RemoteErrorCode::NotFound)),
        ReadResult::NotModified => return Err(RemoteError::new(RemoteErrorCode::InvalidResponse)),
    }
    let bytes = serde_json::to_vec(candidate)
        .map_err(|_| RemoteError::new(RemoteErrorCode::InvalidConfig))?;
    decode_space(&bytes)?;
    if bytes.len() > SPACE_LIMIT {
        return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
    }
    let result = if caps.conditional_create {
        remote
            .put(&path, bytes, WriteCondition::Absent, cancel)
            .await
    } else if caps.move_no_replace {
        publish(remote, &path, bytes, false, cancel).await
    } else {
        return Err(RemoteError::new(RemoteErrorCode::UnsafeCreation));
    };
    match result {
        Ok(()) => {}
        Err(e) if matches!(e.http_status, Some(409 | 412)) && !e.cleanup_failed => {}
        Err(e) => return Err(e),
    }
    // Read the actual winner instead of returning our proposal after a race.
    match remote.get(&path, None, SPACE_LIMIT, cancel).await? {
        ReadResult::Content { bytes, .. } => decode_space(&bytes),
        _ => Err(RemoteError::new(RemoteErrorCode::InvalidResponse)),
    }
}

/// Publish via a temporary sibling and MOVE. A failed operation may have been
/// accepted remotely; S3 reconciles it by GET next round, never by blind retry.
pub async fn publish(
    remote: &impl SyncRemote,
    path: &RemotePath,
    bytes: Vec<u8>,
    overwrite: bool,
    cancel: &Cancel,
) -> Result<(), RemoteError> {
    if path.0.is_empty() {
        return Err(RemoteError::new(RemoteErrorCode::InvalidConfig));
    }
    let mut parent = path.clone();
    parent.0.pop();
    let temp = parent.child(&random_name(".upload-")?)?;
    let result = async {
        remote
            .put(&temp, bytes, WriteCondition::Any, cancel)
            .await?;
        remote.move_file(&temp, path, overwrite, cancel).await
    }
    .await;
    // Even PUT timeout can leave a partial temporary file. Only our random name
    // is cleaned; the target is never deleted after a failed/ambiguous MOVE.
    match result {
        Ok(()) => Ok(()), // The successful MOVE already consumed our source.
        Err(mut e) => {
            e.cleanup_failed = remote
                .delete(&temp, false, &Cancel::default())
                .await
                .is_err();
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests;
