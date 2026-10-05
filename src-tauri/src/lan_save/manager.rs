use super::address_selection::{collect_local_addresses, LanAddressInfo, LocalAddress};
use super::bulk_policy::{
    validate_inventory_reply, CompactCommit, PolicyError, RemotePhase, SpaceBudget, INVENTORY_CHUNK,
};
use super::connection::{LanConnection, LanIo};
use super::error::LanSaveError;
use super::pairing::{random_hex_32, valid_lan_ip, LanPairing};
use super::protocol::{ControlMessage, LanCommitSummary, ProcessingPhase, WireOffer};
use super::session::{
    LanEventSink, LanSession, Phase, PhaseHeartbeat, ReceiverAction, WorkerLease,
};
use super::tls::{client_config, server_name, TlsIdentity};
use crate::portable_state_commands::with_existing_store;
use crate::save_file::commands::{
    active_task, finish_task, reserve_job, run_commit, run_lan_export, run_prepare_owned_lan,
    take_prepared_for_commit, FileTask,
};
use crate::save_file::{
    available_space_for, create_owned_staging_dir, new_uuid, parse_bindings, valid_hash,
    valid_job_id, SaveExportScope, SaveFileCommitResult, SaveFilePrepareResult, SaveFileProgress,
};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, TlsConnector};

const PAIRING_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const ACCEPT_WAIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub struct LanSaveManager {
    sessions: Mutex<HashMap<String, Arc<LanSession>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHostResult {
    pub session_id: String,
    pub pairing_info: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanJoinResult {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSendResult {
    pub status: String,
    pub transfer_id: String,
    pub archive_bytes: u64,
    pub package_id: String,
    pub written_books: usize,
    pub attached_book_count: usize,
    pub skipped_books: Vec<crate::save_file::SkippedBook>,
    pub remote_commit: Option<LanCommitSummary>,
    pub result_delivered: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanCloseResult {
    pub status: String,
}

impl LanSaveManager {
    pub(crate) fn insert(&self, session: Arc<LanSession>) -> Result<(), LanSaveError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| LanSaveError::invalid_state("LAN 会话管理器锁已损坏"))?;
        if !sessions.is_empty() {
            return Err(LanSaveError::new("busy", "已有活动或正在收尾的 LAN 会话"));
        }
        sessions.insert(session.session_id.clone(), session);
        Ok(())
    }

    pub(crate) fn get(&self, session_id: &str) -> Result<Arc<LanSession>, LanSaveError> {
        self.sessions
            .lock()
            .map_err(|_| LanSaveError::invalid_state("LAN 会话管理器锁已损坏"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| LanSaveError::not_found("没有该活动 LAN 会话"))
    }

    pub(crate) fn remove_if_same(&self, session: &Arc<LanSession>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(current) = sessions.get(&session.session_id) {
                if Arc::ptr_eq(current, session) {
                    sessions.remove(&session.session_id);
                }
            }
        }
    }
}

fn manager<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::State<'_, LanSaveManager>, LanSaveError> {
    Ok(app.state::<LanSaveManager>())
}

fn insert_session<R: Runtime>(
    app: &AppHandle<R>,
    session: Arc<LanSession>,
) -> Result<(), LanSaveError> {
    manager(app)?.insert(session)
}

fn remove_session<R: Runtime>(app: &AppHandle<R>, session: &Arc<LanSession>) {
    if let Ok(state) = manager(app) {
        state.remove_if_same(session);
    }
}

fn get_session<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<Arc<LanSession>, LanSaveError> {
    manager(app)?.get(session_id)
}

pub(crate) fn event_sink(channel: Channel<super::session::LanSaveEvent>) -> LanEventSink {
    Arc::new(move |event| {
        let _ = channel.send(event);
    })
}

fn progress_channel(session: &Arc<LanSession>) -> Channel<SaveFileProgress> {
    let session = session.clone();
    Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
                let phase = value
                    .get("phase")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("progress");
                let processed = value
                    .get("processedBytes")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let total = value.get("totalBytes").and_then(serde_json::Value::as_u64);
                session.emit_progress(phase, processed, total);
            }
        }
        Ok(())
    })
}

fn session_staging_dir<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<PathBuf, LanSaveError> {
    if !valid_job_id(session_id) {
        return Err(LanSaveError::invalid_state("sessionId 不是规范 UUID"));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| LanSaveError::storage(format!("无法取得应用缓存目录：{error}")))?
        .join("lan-save-staging")
        .join(session_id);
    Ok(dir)
}

fn temp_session_dir<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<PathBuf, LanSaveError> {
    let dir = session_staging_dir(app, session_id)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Only this module's UUID directories are stale at startup; user files and
/// other cache folders are never included.
pub(crate) fn cleanup_stale_staging<R: Runtime>(app: &AppHandle<R>) -> Result<(), LanSaveError> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| LanSaveError::storage(error.to_string()))?
        .join("lan-save-staging");
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if valid_job_id(&entry.file_name().to_string_lossy()) && entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

/// Normal exit requests stop; forced process termination is recovered by the
/// next startup cleanup. Do not claim an OS exit waits for async file workers.
pub(crate) fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    let sessions = app
        .state::<LanSaveManager>()
        .sessions
        .lock()
        .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for session in sessions {
        session.request_workers_close();
        let committing =
            session.gate().close().ok() == Some(super::session::GateClose::CommitInProgress);
        session.request_close();
        session.emit_event(
            "closed",
            None,
            Some(if committing { "too-late" } else { "cancelled" }),
            Some(if committing {
                "应用已离开前台，连接关闭；本机提交仍在进行。"
            } else {
                "应用已离开前台，连接已结束，请重新连接。"
            }),
            None,
        );
        if let Ok(connection) = session.connection() {
            connection.stop();
        }
        if !committing {
            if let Some(task) = session.file_task().ok().flatten() {
                crate::save_file::commands::request_cancel_task(&task);
            }
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            finalize_session(&app, &session).await;
        });
    }
}

fn spawn_finalize<R: Runtime>(app: &AppHandle<R>, session: Arc<LanSession>) {
    let app = app.clone();
    tokio::spawn(async move {
        finalize_session(&app, &session).await;
    });
}

/// Single terminal cleanup path. All leases are acquired before spawning work;
/// this finalizer never holds a lease itself and only cleans after drain.
async fn finalize_session<R: Runtime>(app: &AppHandle<R>, session: &Arc<LanSession>) {
    if !session.begin_finalize() {
        session.wait_finalize().await;
        return;
    }
    // Bar new registrations first so a racing command cannot attach a worker
    // after the finalizer observes an idle owner.
    session.request_workers_close();
    let committing =
        session.gate().close().ok() == Some(super::session::GateClose::CommitInProgress);
    session.request_close();
    if let Ok(connection) = session.connection() {
        connection.stop();
    }
    if !committing {
        if let Some(task) = session.file_task().ok().flatten() {
            crate::save_file::commands::request_cancel_task(&task);
        }
    }
    // A timeout never grants cleanup permission; wait for every network and
    // file lease to actually drop.
    session.drain_workers().await;
    if let Some(task) = session.file_task().ok().flatten() {
        finish_task(app, &task);
    }
    if let Some(connection) = session.take_connection().await {
        connection.close_halves().await;
    }
    if let Ok(dir) = session_staging_dir(app, &session.session_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    session.clear_event_sink();
    remove_session(app, session);
    session.finish_finalize();
}

pub(crate) async fn start_host<R: Runtime>(
    app: &AppHandle<R>,
    bind_ip: Ipv4Addr,
    sink: LanEventSink,
) -> Result<LanHostResult, LanSaveError> {
    if !valid_lan_ip(bind_ip) {
        return Err(LanSaveError::invalid_request(
            "监听只接受本地私网或 link-local IPv4 地址",
        ));
    }
    let session_id = new_uuid()?;
    let token = random_hex_32()?;
    let transfer_id = new_uuid()?;
    let identity = TlsIdentity::generate(bind_ip)?;
    let fingerprint = identity.fingerprint.clone();
    let listener = TcpListener::bind(SocketAddr::new(bind_ip.into(), 0))
        .await
        .map_err(|error| LanSaveError::network(format!("监听局域网临时端口失败：{error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| LanSaveError::network(format!("读取监听端口失败：{error}")))?
        .port();
    let pairing = LanPairing::new(
        session_id.clone(),
        bind_ip,
        port,
        fingerprint,
        token.clone(),
    );
    let pairing_info = pairing.encode()?;
    let session = Arc::new(LanSession::new_host(
        session_id.clone(),
        token,
        transfer_id.clone(),
        sink,
    ));
    let listener_lease = session.enter_worker()?;
    insert_session(app, session.clone())?;
    session.emit_event("pairing", Some(&transfer_id), None, None, None);

    let app_handle = app.clone();
    let worker_session = session.clone();
    tokio::spawn(async move {
        let result = host_accept_loop(
            &app_handle,
            listener,
            identity,
            worker_session.clone(),
            &listener_lease,
        )
        .await;
        drop(listener_lease);
        match result {
            Ok(()) => {}
            Err(error) => {
                worker_session.emit_event(
                    "error",
                    worker_session.transfer_id().ok().as_deref(),
                    Some(&error.code),
                    Some(&error.message),
                    None,
                );
                finalize_session(&app_handle, &worker_session).await;
            }
        }
    });

    Ok(LanHostResult {
        session_id,
        pairing_info,
    })
}

async fn host_accept_loop<R: Runtime>(
    app: &AppHandle<R>,
    listener: TcpListener,
    identity: TlsIdentity,
    session: Arc<LanSession>,
    lease: &WorkerLease,
) -> Result<(), LanSaveError> {
    let deadline = Instant::now() + PAIRING_TIMEOUT;
    loop {
        if session.is_close_requested() {
            return Err(LanSaveError::cancelled());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| LanSaveError::expired("等待扫码配对超时"))?;
        let accepted = tokio::select! {
            _ = session.wait_until_closed() => return Err(LanSaveError::cancelled()),
            result = tokio::time::timeout(remaining, listener.accept()) => result,
        };
        let (tcp, _peer) = match accepted {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                return Err(LanSaveError::network(format!("接受 TLS 连接失败：{error}")));
            }
            Err(_) => return Err(LanSaveError::expired("等待扫码配对超时")),
        };
        let connected = tokio::select! {
            biased;
            _ = session.wait_until_closed() => return Err(LanSaveError::cancelled()),
            result = tokio::time::timeout(HANDSHAKE_TIMEOUT, accept_peer(tcp, &identity, &session)) => result,
        };
        match connected {
            Ok(Ok(connection)) => {
                lease
                    .while_open(|| -> Result<(), LanSaveError> {
                        session.set_connection(connection.clone())?;
                        session.gate().paired()
                    })
                    .map_err(|_| LanSaveError::cancelled())??;
                let transfer_id = session.transfer_id()?;
                connection
                    .write_control(&ControlMessage::Paired {
                        session_id: session.session_id.clone(),
                        transfer_id: transfer_id.clone(),
                    })
                    .await?;
                session.emit_event("paired", Some(&transfer_id), None, None, None);
                spawn_control_reader(app, session, connection);
                return Ok(());
            }
            Ok(Err(_error)) => {
                // A failed handshake/token does not consume the one pairing
                // opportunity. Keep the listener and code alive until timeout.
                continue;
            }
            Err(_) => continue,
        }
    }
}

async fn accept_peer(
    tcp: TcpStream,
    identity: &TlsIdentity,
    session: &Arc<LanSession>,
) -> Result<Arc<LanConnection>, LanSaveError> {
    let acceptor = TlsAcceptor::from(Arc::new(identity.server_config()?));
    let tls = acceptor
        .accept(tcp)
        .await
        .map_err(|error| LanSaveError::secure(format!("TLS 服务端握手失败：{error}")))?;
    let connection = Arc::new(LanConnection::new(LanIo::Server(tls)));
    let hello = connection.read_control().await?;
    let (incoming_session, incoming_token) = match hello {
        ControlMessage::Hello { session_id, token } => (session_id, token),
        _ => return Err(LanSaveError::protocol("TLS 后第一条消息必须是 Hello")),
    };
    if incoming_session != session.session_id {
        return Err(LanSaveError::invalid_state("Hello sessionId 不匹配"));
    }
    let expected_token = session
        .host_token()
        .ok_or_else(|| LanSaveError::invalid_state("监听端缺少配对令牌"))?;
    let token_ok: bool = if incoming_token.len() == expected_token.len() {
        incoming_token
            .as_bytes()
            .ct_eq(expected_token.as_bytes())
            .into()
    } else {
        false
    };
    if !token_ok {
        let _ = connection
            .write_control(&ControlMessage::Error {
                session_id: session.session_id.clone(),
                transfer_id: None,
                code: "token-mismatch".to_string(),
                message: "配对令牌校验失败".to_string(),
            })
            .await;
        return Err(LanSaveError::token_mismatch());
    }
    Ok(connection)
}

pub(crate) async fn join<R: Runtime>(
    app: &AppHandle<R>,
    pairing_info: &str,
    sink: LanEventSink,
) -> Result<LanJoinResult, LanSaveError> {
    let pairing = LanPairing::parse(pairing_info)?;
    let session = Arc::new(LanSession::new_pending_join(
        pairing.session_id.clone(),
        sink,
    ));
    let command = session.enter_worker()?;
    insert_session(app, session.clone())?;
    session.emit_event(
        "pairing",
        None,
        None,
        None,
        Some(json!({ "status": "connecting" })),
    );
    let app = app.clone();
    tokio::spawn(async move {
        let outcome = match tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            join_network(&app, &pairing, command, session.clone()),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(_) => Err(LanSaveError::secure("连接/握手/Paired 总时限 10 秒")),
        };
        if let Err(error) = &outcome {
            session.emit_event("error", None, Some(&error.code), Some(&error.message), None);
            finalize_session(&app, &session).await;
        }
        outcome
    })
    .await
    .map_err(|error| LanSaveError::network(format!("连接工作任务失败：{error}")))?
}

async fn join_network<R: Runtime>(
    app: &AppHandle<R>,
    pairing: &LanPairing,
    command: WorkerLease,
    session: Arc<LanSession>,
) -> Result<LanJoinResult, LanSaveError> {
    let (host, port) = pairing.endpoint_addr()?;
    let tcp = match tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port))) => result,
        _ = session.wait_until_closed() => return Err(LanSaveError::cancelled()),
    } {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(error)) => {
            return Err(LanSaveError::unreachable(format!(
                "无法连接监听端：{error}"
            )))
        }
        Err(_) => return Err(LanSaveError::unreachable("连接监听端超时")),
    };
    let connector = TlsConnector::from(Arc::new(client_config(&pairing.certificate_sha256)?));
    let tls = match tokio::select! {
        result = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            connector.connect(server_name(host), tcp),
        ) => result,
        _ = session.wait_until_closed() => return Err(LanSaveError::cancelled()),
    } {
        Ok(Ok(tls)) => tls,
        Ok(Err(error)) => return Err(map_client_handshake_error(error)),
        Err(_) => return Err(LanSaveError::secure("TLS 握手超时")),
    };
    let connection = Arc::new(LanConnection::new(LanIo::Client(tls)));
    if let Err(error) = session.set_connection(connection.clone()) {
        return Err(error);
    }
    let hello = ControlMessage::Hello {
        session_id: pairing.session_id.clone(),
        token: pairing.token.clone(),
    };
    tokio::select! {
        result = connection.write_control(&hello) => result?,
        _ = session.wait_until_closed() => return Err(LanSaveError::cancelled()),
    }
    let paired = tokio::select! {
        result = connection.read_control() => result?,
        _ = session.wait_until_closed() => return Err(LanSaveError::cancelled()),
    };
    let transport_transfer_id = match paired {
        ControlMessage::Paired {
            session_id,
            transfer_id,
        } => {
            if session_id != pairing.session_id {
                return Err(LanSaveError::invalid_state("Paired sessionId 不匹配"));
            }
            if !valid_job_id(&transfer_id) {
                return Err(LanSaveError::protocol("Paired transferId 不是规范 UUID"));
            }
            transfer_id
        }
        ControlMessage::Error { code, message, .. } => {
            if code == "token-mismatch" {
                return Err(LanSaveError::token_mismatch());
            }
            return Err(LanSaveError::new("protocol-error", message));
        }
        _ => return Err(LanSaveError::protocol("Hello 后未收到 Paired")),
    };
    let transfer_id = transport_transfer_id.clone();
    command
        .while_open(|| -> Result<(), LanSaveError> {
            session.set_transfer_id(transfer_id)?;
            session.gate().paired()?;
            Ok(())
        })
        .map_err(|_| LanSaveError::cancelled())??;
    session.emit_event("paired", Some(&transport_transfer_id), None, None, None);
    spawn_control_reader(app, session, connection);
    Ok(LanJoinResult {
        session_id: pairing.session_id.clone(),
    })
}

fn map_client_handshake_error(error: std::io::Error) -> LanSaveError {
    if let Some(rustls_error) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        if let rustls::Error::InvalidCertificate(_) = rustls_error {
            return LanSaveError::pin_mismatch();
        }
    }
    LanSaveError::secure(format!("TLS 客户端握手失败：{error}"))
}

fn spawn_control_reader<R: Runtime>(
    app: &AppHandle<R>,
    session: Arc<LanSession>,
    connection: Arc<LanConnection>,
) {
    let lease = match session.enter_worker() {
        Ok(lease) => lease,
        Err(_) => return,
    };
    let app = app.clone();
    tokio::spawn(async move {
        control_reader_loop(&app, &session, &connection, &lease).await;
    });
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReaderMode {
    Unknown,
    Sender,
    ReceiverChecking,
    Receiver,
}

fn control_terminal<R: Runtime>(
    app: &AppHandle<R>,
    session: &Arc<LanSession>,
    error: LanSaveError,
) {
    let _ = session.push_inbox(ControlMessage::Error {
        session_id: session.session_id.clone(),
        transfer_id: session.transfer_id().ok(),
        code: error.code.clone(),
        message: error.message.clone(),
    });
    session.emit_event(
        "error",
        session.transfer_id().ok().as_deref(),
        Some(&error.code),
        Some(&error.message),
        None,
    );
    // Close promptly; never wait for the ZIP writer's lock to report an error.
    spawn_finalize(app, session.clone());
}

fn validate_control(
    session: &Arc<LanSession>,
    message: &ControlMessage,
) -> Result<(), LanSaveError> {
    if message.session_id() != session.session_id {
        return Err(LanSaveError::protocol("控制消息 sessionId 不匹配"));
    }
    if let Some(transfer) = message.transfer_id() {
        if transfer != session.transfer_id()? {
            return Err(LanSaveError::protocol("控制消息 transferId 不匹配"));
        }
    }
    Ok(())
}

fn handle_offer(session: &Arc<LanSession>, message: ControlMessage) -> Result<(), LanSaveError> {
    let ControlMessage::Offer {
        transfer_id,
        archive_bytes,
        book_bytes,
        book_count,
        attached_book_count,
        reused_book_count,
        skipped_book_count,
        include_books,
        has_preferences,
        ..
    } = message
    else {
        return Err(LanSaveError::protocol("预期 Offer"));
    };
    if archive_bytes == 0 || archive_bytes > JS_SAFE_INTEGER {
        return Err(LanSaveError::protocol("Offer archiveBytes 超出范围"));
    }
    if book_bytes > JS_SAFE_INTEGER {
        return Err(LanSaveError::protocol("Offer bookBytes 超出范围"));
    }
    if attached_book_count > JS_SAFE_INTEGER as usize
        || reused_book_count > JS_SAFE_INTEGER as usize
        || skipped_book_count > JS_SAFE_INTEGER as usize
        || book_count > JS_SAFE_INTEGER as usize
    {
        return Err(LanSaveError::protocol("Offer 计数超出安全范围"));
    }
    if !include_books {
        if attached_book_count != 0
            || reused_book_count != 0
            || skipped_book_count != 0
            || book_bytes != 0
        {
            return Err(LanSaveError::protocol(
                "Offer includeBooks=false 时附书/复用/跳过计数必须为 0",
            ));
        }
    } else {
        let total = attached_book_count
            .checked_add(reused_book_count)
            .and_then(|value| value.checked_add(skipped_book_count))
            .ok_or_else(|| LanSaveError::protocol("Offer 附书计数溢出"))?;
        if total != book_count {
            return Err(LanSaveError::protocol(
                "Offer attached+reused+skipped 与 bookCount 不一致",
            ));
        }
        if book_count > 0 {
            let outcome = session
                .inventory_outcome()?
                .ok_or_else(|| LanSaveError::protocol("Offer 在 InventoryQuery 之前到达"))?;
            if !outcome.finished {
                return Err(LanSaveError::protocol("InventoryQuery 尚未结束"));
            }
            if book_count != outcome.queried || reused_book_count != outcome.present {
                return Err(LanSaveError::protocol(
                    "Offer 计数与 InventoryReply 核对结果不一致",
                ));
            }
            let absent = outcome
                .queried
                .checked_sub(outcome.present)
                .ok_or_else(|| LanSaveError::protocol("InventoryReply present 计数非法"))?;
            let attached_skipped = attached_book_count
                .checked_add(skipped_book_count)
                .ok_or_else(|| LanSaveError::protocol("Offer 附书计数溢出"))?;
            if attached_skipped != absent {
                return Err(LanSaveError::protocol(
                    "Offer 附书/跳过计数与 InventoryReply 不一致",
                ));
            }
        }
    }
    let phase = session.gate().phase()?;
    if !matches!(phase, Phase::Ready | Phase::Checking) {
        return Err(LanSaveError::invalid_state("双方同时发起或已有传输角色"));
    }
    if phase == Phase::Ready {
        if !session.claim_incoming() {
            return Err(LanSaveError::invalid_state("双方同时发起或已有传输角色"));
        }
    } else if !session.is_incoming() {
        return Err(LanSaveError::invalid_state("Checking 阶段缺少接收方向"));
    }
    if phase == Phase::Checking {
        session.gate().checking_complete()?;
    }
    session.clear_remote_wait();
    let offer = WireOffer {
        session_id: session.session_id.clone(),
        transfer_id: transfer_id.clone(),
        archive_bytes,
        book_bytes,
        book_count,
        attached_book_count,
        reused_book_count,
        skipped_book_count,
        include_books,
        has_preferences,
    };
    session.set_offer(offer)?;
    session.emit_event(
        "offered",
        Some(&transfer_id),
        None,
        None,
        Some(json!({
            "archiveBytes": archive_bytes,
            "bookBytes": book_bytes,
            "bookCount": book_count,
            "attachedBookCount": attached_book_count,
            "reusedBookCount": reused_book_count,
            "skippedBookCount": skipped_book_count,
            "includeBooks": include_books,
            "hasPreferences": has_preferences,
        })),
    );
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SenderStage {
    Inventory,
    Accept,
    Receipt,
    Result,
}

fn handle_sender_control(
    session: &Arc<LanSession>,
    message: ControlMessage,
    stage: &mut SenderStage,
) -> Result<bool, LanSaveError> {
    if !session.is_outgoing() {
        return Err(LanSaveError::protocol("尚未发送 Offer"));
    }
    let stop = match &message {
        ControlMessage::InventoryReply { .. }
            if *stage == SenderStage::Inventory && session.gate().phase()? == Phase::Exporting =>
        {
            false
        }
        ControlMessage::Accept { .. }
            if *stage != SenderStage::Receipt
                && *stage != SenderStage::Result
                && session.gate().phase()? == Phase::OfferPending =>
        {
            *stage = SenderStage::Receipt;
            false
        }
        ControlMessage::Received { archive_bytes, .. }
            if *stage == SenderStage::Receipt && session.gate().phase()? == Phase::Sending =>
        {
            if *archive_bytes == 0 || *archive_bytes != session.outgoing_bytes() {
                return Err(LanSaveError::protocol("Received 长度与 Offer 不一致"));
            }
            *stage = SenderStage::Result;
            false
        }
        ControlMessage::Result { status, result, .. }
            if *stage != SenderStage::Accept && session.gate().phase()? == Phase::Sending =>
        {
            if !matches!(status.as_str(), "committed" | "cancelled" | "failed") {
                return Err(LanSaveError::protocol("Result status 不在白名单"));
            }
            if status == "committed" && result.is_none() {
                return Err(LanSaveError::protocol("committed 缺少紧凑提交结果"));
            }
            if status != "committed" && result.is_some() {
                return Err(LanSaveError::protocol(
                    "非 committed Result 不应携带提交摘要",
                ));
            }
            true
        }
        ControlMessage::Decline { .. }
            if *stage != SenderStage::Receipt && *stage != SenderStage::Result =>
        {
            true
        }
        ControlMessage::Cancel { .. } | ControlMessage::Error { .. } => true,
        _ => return Err(LanSaveError::protocol("发送端收到重复或错序控制消息")),
    };
    session.push_inbox(message)?;
    Ok(stop)
}

async fn handle_receiver_accept(
    session: &Arc<LanSession>,
    connection: &Arc<LanConnection>,
    part_path: PathBuf,
    archive_bytes: u64,
    reply: tokio::sync::oneshot::Sender<Result<(), LanSaveError>>,
) -> Result<(), LanSaveError> {
    let result = async {
        let transfer_id = session.transfer_id()?;
        connection
            .write_control(&ControlMessage::Accept {
                session_id: session.session_id.clone(),
                transfer_id: transfer_id.clone(),
            })
            .await?;
        let heartbeat = PhaseHeartbeat::start(
            session.clone(),
            transfer_id.clone(),
            ProcessingPhase::Receiving,
        )?;
        let received = connection
            .receive_archive_to_path(&part_path, archive_bytes, session)
            .await;
        heartbeat.stop().await;
        received?;
        let source_path = part_path
            .parent()
            .ok_or_else(|| LanSaveError::storage("下载临时路径缺少父目录"))?
            .join("source.epubsave");
        tokio::fs::rename(&part_path, &source_path)
            .await
            .map_err(|error| LanSaveError::storage(format!("无法命名接收存档：{error}")))?;
        session.gate().received_exact_archive()?;
        connection
            .write_control(&ControlMessage::Received {
                session_id: session.session_id.clone(),
                transfer_id,
                archive_bytes,
            })
            .await
    }
    .await;
    let _ = reply.send(result.clone());
    result
}

fn lan_library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, LanSaveError> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("linked-library"))
        .map_err(|error| LanSaveError::storage(format!("无法取得应用本地数据目录：{error}")))
}

fn start_inventory_query<R: Runtime>(
    app: &AppHandle<R>,
    session: &Arc<LanSession>,
    lease: &WorkerLease,
    message: &ControlMessage,
    expected_index: u64,
    finished: bool,
    pending: bool,
) -> Result<(), LanSaveError> {
    let ControlMessage::InventoryQuery {
        transfer_id,
        query_index,
        hashes,
        last,
        ..
    } = message
    else {
        return Err(LanSaveError::protocol("预期 InventoryQuery"));
    };
    if finished || pending {
        return Err(LanSaveError::protocol(
            "InventoryQuery 未等待上一块或在 last 之后重复出现",
        ));
    }
    if *query_index != expected_index {
        return Err(LanSaveError::protocol("InventoryQuery 序号不连续"));
    }
    if hashes.is_empty() || hashes.len() > super::bulk_policy::INVENTORY_CHUNK {
        return Err(LanSaveError::protocol("InventoryQuery 块大小非法"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for hash in hashes {
        if !valid_hash(hash) || !seen.insert(hash) {
            return Err(LanSaveError::protocol("InventoryQuery 含非法或重复 hash"));
        }
    }
    let phase = session.gate().phase()?;
    if phase == Phase::Ready {
        if !session.claim_incoming() {
            return Err(LanSaveError::invalid_state("双方同时发起或已有传输角色"));
        }
        session.gate().begin_checking()?;
    } else if phase == Phase::Checking {
        if !session.is_incoming() {
            return Err(LanSaveError::invalid_state("Checking 阶段缺少接收方向"));
        }
    } else {
        return Err(LanSaveError::invalid_state("当前阶段不接收 InventoryQuery"));
    }
    if !session.has_remote_wait() {
        session.arm_remote_wait(RemotePhase::PreparingSend)?;
    }

    let checking_heartbeat = PhaseHeartbeat::start(
        session.clone(),
        transfer_id.clone(),
        ProcessingPhase::Checking,
    )?;
    let worker_lease = lease.child().map_err(|_| LanSaveError::cancelled())?;
    let completion_lease = lease.child().map_err(|_| LanSaveError::cancelled())?;
    let worker_app = app.clone();
    let worker_hashes = hashes.clone();
    let worker_session = session.clone();
    let completion_session = session.clone();
    let query_index = *query_index;
    let last = *last;
    let job = tokio::task::spawn_blocking(move || -> Result<Vec<bool>, LanSaveError> {
        let _lease = worker_lease;
        let root = lan_library_root(&worker_app)?;
        // Read only this bounded chunk; do not clone every binding per query.
        let raw_bindings = with_existing_store(&worker_app, |store| {
            let mut rows = std::collections::BTreeMap::new();
            for hash in &worker_hashes {
                if let Some(raw) = store.binding_raw(hash)? {
                    rows.insert(hash.clone(), raw);
                }
            }
            Ok(rows)
        })
        .map_err(LanSaveError::from)?
        .ok_or_else(|| LanSaveError::storage("可移植资料仓储尚未激活"))?;
        let bindings = parse_bindings(raw_bindings)?;
        let mut presence = Vec::with_capacity(worker_hashes.len());
        for hash in worker_hashes {
            if worker_session.is_close_requested() {
                return Err(LanSaveError::cancelled());
            }
            let present = match bindings.get(&hash) {
                Some(binding) => {
                    binding.is_valid_cancellable(&root, || worker_session.is_close_requested())?
                }
                None => false,
            };
            presence.push(present);
        }
        Ok(presence)
    });
    tokio::spawn(async move {
        let _lease = completion_lease;
        let presence = job
            .await
            .map_err(|error| LanSaveError::storage(format!("Inventory 核对线程失败：{error}")))
            .and_then(|result| result);
        checking_heartbeat.stop().await;
        let action = ReceiverAction::InventoryDone {
            query_index,
            last,
            presence,
        };
        let sender = completion_session.receiver_action_sender();
        tokio::select! {
            _ = completion_session.wait_until_closed() => {}
            _ = sender.send(action) => {}
        }
    });
    Ok(())
}

async fn control_reader_loop<R: Runtime>(
    app: &AppHandle<R>,
    session: &Arc<LanSession>,
    connection: &Arc<LanConnection>,
    lease: &WorkerLease,
) {
    let mut frame_buffer = Vec::new();
    let Some(mut actions) = session.take_receiver_action_receiver() else {
        return;
    };
    let mut mode = ReaderMode::Unknown;
    let mut stage = SenderStage::Inventory;
    let mut observed_phase = None;
    let mut deadline = None;
    let mut expected_query_index = 0_u64;
    let mut inventory_finished = false;
    let mut inventory_pending = false;
    loop {
        if session.is_close_requested() {
            return;
        }
        let phase = match session.gate().phase() {
            Ok(phase) => phase,
            Err(error) => {
                control_terminal(app, session, error);
                return;
            }
        };
        if observed_phase != Some(phase) {
            // User decisions expire; export/download/prepare/commit are governed
            // by their own progress/cancellation, not a hidden UI wait timer.
            // Checking is governed by the sender's Processing heartbeat instead.
            deadline = match phase {
                Phase::Ready | Phase::OfferPending | Phase::Preview => {
                    Some(tokio::time::Instant::now() + ACCEPT_WAIT_TIMEOUT)
                }
                _ => None,
            };
            observed_phase = Some(phase);
        }
        let expiry = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            biased;
            _ = session.wait_until_closed() => return,
            _ = expiry => {
                control_terminal(app, session, LanSaveError::expired("等待传输选择/导入确认超时"));
                return;
            }
            result = connection.read_control_buffered(&mut frame_buffer, None) => {
                let message = match result {
                    Ok(message) => message,
                    Err(error) => { control_terminal(app, session, error); return; }
                };
                if let Err(error) = validate_control(session, &message) {
                    control_terminal(app, session, error); return;
                }
                if let ControlMessage::Processing { sequence, phase, .. } = &message {
                    if *phase == ProcessingPhase::PreparingSend && mode == ReaderMode::Unknown {
                        // The first sender liveness notification moves the
                        // receiver into Checking even for a metadata-only
                        // package, so it does not inherit the Ready user timer.
                        let current = match session.gate().phase() {
                            Ok(phase) => phase,
                            Err(error) => { control_terminal(app, session, error); return; }
                        };
                        if current == Phase::Ready {
                            if !session.claim_incoming() {
                                control_terminal(app, session, LanSaveError::invalid_state("双方同时发起或已有传输角色"));
                                return;
                            }
                            if let Err(error) = session.gate().begin_checking() {
                                control_terminal(app, session, error); return;
                            }
                            if !session.has_remote_wait() {
                                if let Err(error) = session.arm_remote_wait(RemotePhase::PreparingSend) {
                                    control_terminal(app, session, error); return;
                                }
                            }
                            mode = ReaderMode::ReceiverChecking;
                        } else if current == Phase::Checking && !session.is_incoming() {
                            control_terminal(app, session, LanSaveError::invalid_state("Checking 阶段缺少接收方向"));
                            return;
                        }
                    }
                    if let Err(error) = session.observe_remote_processing(*sequence, *phase) {
                        control_terminal(app, session, error); return;
                    }
                    continue;
                }
                if matches!(&message, ControlMessage::InventoryQuery { .. }) {
                    if matches!(mode, ReaderMode::Sender | ReaderMode::Receiver) {
                        control_terminal(app, session, LanSaveError::protocol("接收端收到错序 InventoryQuery"));
                        return;
                    }
                    if let Err(error) = start_inventory_query(
                        app, session, lease, &message,
                        expected_query_index, inventory_finished, inventory_pending,
                    ) {
                        control_terminal(app, session, error); return;
                    }
                    inventory_pending = true;
                    mode = ReaderMode::ReceiverChecking;
                    continue;
                }
                if matches!(&message, ControlMessage::Offer { .. }) {
                    if matches!(mode, ReaderMode::Sender | ReaderMode::Receiver) {
                        control_terminal(app, session, LanSaveError::protocol("接收端收到重复 Offer"));
                        return;
                    }
                    let offer = lease
                        .while_open(|| handle_offer(session, message))
                        .map_err(|_| LanSaveError::cancelled())
                        .and_then(|result| result);
                    if let Err(error) = offer {
                        control_terminal(app, session, error); return;
                    }
                    mode = ReaderMode::Receiver;
                    // The Offer starts the confirmation window while Phase is
                    // still Ready; it must not inherit a nearly-expired pairing.
                    deadline = Some(tokio::time::Instant::now() + ACCEPT_WAIT_TIMEOUT);
                    continue;
                }
                if matches!(mode, ReaderMode::Receiver | ReaderMode::ReceiverChecking) {
                    match message {
                        ControlMessage::Cancel { .. } | ControlMessage::Error { .. } => {
                            control_terminal(app, session, LanSaveError::cancelled());
                        }
                        _ => control_terminal(app, session, LanSaveError::protocol("接收端收到错序控制消息")),
                    }
                    return;
                } else {
                    match handle_sender_control(session, message, &mut stage) {
                        Ok(true) => return, // The sender consumes the result before finalizing.
                        Ok(false) => mode = ReaderMode::Sender,
                        Err(error) => { control_terminal(app, session, error); return; }
                    }
                }
            }
            _ = session.wait_remote_expired(), if session.has_remote_wait() => {
                control_terminal(app, session, LanSaveError::expired("等待发送端处理进展超时"));
                return;
            }
            // Never switch a partially consumed control frame into raw ZIP.
            action = actions.recv(), if frame_buffer.is_empty() => {
                match action {
                    Some(ReceiverAction::PhaseChanged) => {}
                    Some(ReceiverAction::InventoryDone { query_index, last, presence })
                        if inventory_pending && query_index == expected_query_index && mode == ReaderMode::ReceiverChecking => {
                        let result = async {
                            let presence = presence?;
                            session.record_inventory_chunk(presence.len(), presence.iter().filter(|present| **present).count(), last)?;
                            connection.write_control(&ControlMessage::InventoryReply {
                                session_id: session.session_id.clone(),
                                transfer_id: session.transfer_id()?,
                                query_index,
                                present: presence,
                            }).await?;
                            expected_query_index = query_index.checked_add(1)
                                .ok_or_else(|| LanSaveError::protocol("InventoryQuery 序号溢出"))?;
                            inventory_finished = last;
                            inventory_pending = false;
                            Ok::<(), LanSaveError>(())
                        }.await;
                        if let Err(error) = result {
                            control_terminal(app, session, error); return;
                        }
                    }
                    Some(ReceiverAction::Accept { part_path, archive_bytes, reply }) if mode == ReaderMode::Receiver => {
                        if let Err(error) = handle_receiver_accept(session, connection, part_path, archive_bytes, reply).await {
                            control_terminal(app, session, error); return;
                        }
                    }
                    _ => {
                        control_terminal(app, session, LanSaveError::protocol("接收动作与阶段不匹配"));
                        return;
                    }
                }
            }
        }
    }
}

pub(crate) async fn send<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    scope: SaveExportScope,
    include_books: bool,
) -> Result<LanSendResult, LanSaveError> {
    let session = get_session(app, session_id)?;
    if session.is_close_requested() {
        return Err(LanSaveError::cancelled());
    }
    // This command lease covers the whole send flow. The blocking export gets
    // a separate child lease before spawn, so closing drains the actual thread.
    let command = session.enter_worker()?;
    let transfer_id = session.transfer_id()?;
    let job_id = new_uuid()?;
    let task: Arc<FileTask> = command
        .while_open(|| -> Result<Arc<FileTask>, LanSaveError> {
            if !session.is_role_idle() {
                return Err(LanSaveError::new("busy", "已有传输正在进行"));
            }
            if session.gate().phase()? != Phase::Ready {
                return Err(LanSaveError::new("busy", "会话阶段不允许再次发送"));
            }
            // Reserve first. A busy F-N slot must leave role/phase untouched
            // so this session can retry the same Offer.
            let task = reserve_job(app, &job_id)?;
            session.set_file_task(job_id.clone(), task.clone())?;
            if !session.claim_outgoing() {
                return Err(LanSaveError::new("busy", "已有传输正在进行"));
            }
            session.gate().begin_export()?;
            Ok(task)
        })
        .map_err(|_| LanSaveError::cancelled())??;
    let app = app.clone();
    tokio::spawn(async move {
        let result = send_inner(
            &app,
            session.clone(),
            command,
            task,
            transfer_id,
            scope,
            include_books,
        )
        .await;
        finalize_session(&app, &session).await;
        result
    })
    .await
    .map_err(|error| LanSaveError::storage(format!("发送工作任务失败：{error}")))?
}

async fn send_inner<R: Runtime>(
    app: &AppHandle<R>,
    session: Arc<LanSession>,
    command: WorkerLease,
    task: Arc<FileTask>,
    transfer_id: String,
    scope: SaveExportScope,
    include_books: bool,
) -> Result<LanSendResult, LanSaveError> {
    let _ = session
        .receiver_action_sender()
        .try_send(ReceiverAction::PhaseChanged);
    session.emit_event("exporting", Some(&transfer_id), None, None, None);
    let connection = session.connection()?;

    // Inventory and packing must refer to the same immutable selection.
    // Liveness starts before repository reads, including metadata-only sends.
    let heartbeat = PhaseHeartbeat::start(
        session.clone(),
        transfer_id.clone(),
        ProcessingPhase::PreparingSend,
    )?;
    let selection_lease = command.child().map_err(|_| LanSaveError::cancelled())?;
    let selection_app = app.clone();
    let frozen = tokio::task::spawn_blocking(move || {
        let _lease = selection_lease;
        crate::save_file::commands::freeze_lan_export(&selection_app, &scope)
    })
    .await
    .map_err(|error| LanSaveError::storage(format!("读取发送范围线程失败：{error}")))??;
    let selected_hashes = &frozen.selected_hashes;

    let mut receiver_missing = std::collections::BTreeSet::new();
    if include_books && !selected_hashes.is_empty() {
        session.arm_remote_wait(RemotePhase::Checking)?;
        for (index, chunk) in selected_hashes.chunks(INVENTORY_CHUNK).enumerate() {
            let query_index = index as u64;
            let last = (index + 1) * INVENTORY_CHUNK >= selected_hashes.len();
            connection
                .write_control(&ControlMessage::InventoryQuery {
                    session_id: session.session_id.clone(),
                    transfer_id: transfer_id.clone(),
                    query_index,
                    hashes: chunk.to_vec(),
                    last,
                })
                .await?;
            let reply = session
                .wait_for_remote_message(|message| {
                    matches!(
                        message,
                        ControlMessage::InventoryReply { .. }
                            | ControlMessage::Error { .. }
                            | ControlMessage::Cancel { .. }
                    )
                })
                .await?;
            match reply {
                ControlMessage::InventoryReply {
                    query_index: received_index,
                    present,
                    ..
                } if received_index == query_index => {
                    validate_inventory_reply(query_index, received_index, chunk.len(), &present)
                        .map_err(|_| LanSaveError::protocol("InventoryReply 长度或序号非法"))?;
                    for (offset, exists) in present.iter().enumerate() {
                        if !exists {
                            receiver_missing.insert(chunk[offset].clone());
                        }
                    }
                }
                ControlMessage::Error { code, message, .. } => {
                    return Err(LanSaveError { code, message });
                }
                ControlMessage::Cancel { reason, .. } => {
                    return Err(LanSaveError::new("cancelled", reason));
                }
                _ => return Err(LanSaveError::protocol("InventoryReply 序号不匹配")),
            }
        }
        session.clear_remote_wait();
    }

    let target_dir = match temp_session_dir(app, &session.session_id) {
        Ok(dir) => dir,
        Err(error) => {
            return Err(error);
        }
    };
    let target = target_dir.join(format!("{transfer_id}.epubsave"));
    let worker_app = app.clone();
    let worker_task = task.clone();
    let worker_target = target.clone();
    let progress = progress_channel(&session);
    let export_lease = command.child().map_err(|_| LanSaveError::cancelled())?;
    let export = tokio::task::spawn_blocking(move || {
        let _lease = export_lease;
        run_lan_export(
            worker_app,
            worker_task,
            worker_target,
            frozen,
            include_books,
            if include_books {
                Some(receiver_missing)
            } else {
                None
            },
            progress,
        )
    })
    .await;
    let export =
        export.map_err(|error| LanSaveError::storage(format!("导出工作线程失败：{error}")))?;
    let export = match export {
        Ok(export) => export,
        Err(error) => {
            return Err(error.into());
        }
    };

    heartbeat.stop().await;

    let offer = ControlMessage::Offer {
        session_id: session.session_id.clone(),
        transfer_id: transfer_id.clone(),
        archive_bytes: export.archive_bytes,
        book_bytes: export.book_bytes,
        book_count: export.book_count,
        attached_book_count: export.written_books,
        reused_book_count: export.reused_book_count,
        skipped_book_count: export.skipped_books.len(),
        include_books,
        has_preferences: export.has_preferences,
    };
    command
        .while_open(|| -> Result<(), LanSaveError> {
            session.set_outgoing_bytes(export.archive_bytes);
            session.gate().export_ready()
        })
        .map_err(|_| LanSaveError::cancelled())??;
    let _ = session
        .receiver_action_sender()
        .try_send(ReceiverAction::PhaseChanged);
    let offer_result = connection.write_control(&offer).await;
    if let Err(error) = offer_result {
        return Err(error);
    }

    let decision = session
        .wait_for_message(ACCEPT_WAIT_TIMEOUT, |message| {
            matches!(
                message,
                ControlMessage::Accept { .. }
                    | ControlMessage::Decline { .. }
                    | ControlMessage::Error { .. }
                    | ControlMessage::Cancel { .. }
            )
        })
        .await;
    let decision = match decision {
        Ok(message) => message,
        Err(error) => {
            return Err(error);
        }
    };
    match decision {
        ControlMessage::Accept { .. } => {}
        ControlMessage::Decline { code, message, .. } => {
            session.emit_event(
                "closed",
                Some(&transfer_id),
                Some(&code),
                Some(&message),
                None,
            );
            return Ok(LanSendResult {
                status: "cancelled".to_string(),
                transfer_id,
                archive_bytes: export.archive_bytes,
                package_id: export.package_id,
                written_books: export.written_books,
                attached_book_count: export.written_books,
                skipped_books: export.skipped_books.clone(),
                remote_commit: None,
                result_delivered: true,
                code: Some(code),
                message: Some(message),
            });
        }
        ControlMessage::Error { code, message, .. } => {
            return Err(LanSaveError { code, message });
        }
        ControlMessage::Cancel { reason, .. } => {
            return Err(LanSaveError::new("cancelled", reason));
        }
        _ => {
            return Err(LanSaveError::protocol("Offer 后收到意外控制消息"));
        }
    }
    if let Err(error) = session.gate().peer_accepts_download() {
        return Err(error);
    }
    session.arm_remote_wait(RemotePhase::Receiving)?;
    let _ = session
        .receiver_action_sender()
        .try_send(ReceiverAction::PhaseChanged);
    if let Err(error) = connection
        .send_archive_from_path(&export.path, export.archive_bytes, &session)
        .await
    {
        // A flush failure can happen after the entire ZIP reached the peer.
        // Without its Result, transport failure cannot prove import failure.
        return Ok(build_send_result(
            "unconfirmed",
            transfer_id,
            &export,
            None,
            false,
            Some(error.code),
            Some(error.message),
        ));
    }

    let received = session
        .wait_for_remote_message(|message| {
            matches!(
                message,
                ControlMessage::Received { .. }
                    | ControlMessage::Result { .. }
                    | ControlMessage::Error { .. }
                    | ControlMessage::Cancel { .. }
            )
        })
        .await;
    let received = match received {
        Ok(message) => message,
        Err(error) => {
            return Ok(build_send_result(
                "unconfirmed",
                transfer_id,
                &export,
                None,
                false,
                Some(error.code),
                Some(error.message),
            ));
        }
    };
    if let ControlMessage::Received { archive_bytes, .. } = &received {
        if *archive_bytes != export.archive_bytes {
            return Err(LanSaveError::protocol("Received 长度与 Offer 不一致"));
        }
        // Wait for the receiver's F-N result next.
    } else if let ControlMessage::Result {
        status,
        result,
        code,
        message,
        ..
    } = received
    {
        return finish_sender_result(
            &session,
            transfer_id,
            &export,
            status,
            result,
            code,
            message,
        );
    } else {
        let (code, message) = match received {
            ControlMessage::Error { code, message, .. } => (Some(code), Some(message)),
            ControlMessage::Cancel { reason, .. } => (Some("cancelled".to_string()), Some(reason)),
            _ => (Some("protocol-error".to_string()), None),
        };
        return Ok(build_send_result(
            "unconfirmed",
            transfer_id,
            &export,
            None,
            false,
            code,
            message,
        ));
    }

    let result = session
        .wait_for_remote_message(|message| {
            matches!(
                message,
                ControlMessage::Result { .. }
                    | ControlMessage::Error { .. }
                    | ControlMessage::Cancel { .. }
            )
        })
        .await;
    match result {
        Ok(ControlMessage::Result {
            status,
            result,
            code,
            message,
            ..
        }) => finish_sender_result(
            &session,
            transfer_id,
            &export,
            status,
            result,
            code,
            message,
        ),
        Ok(ControlMessage::Error { code, message, .. }) => Ok(build_send_result(
            "unconfirmed",
            transfer_id,
            &export,
            None,
            false,
            Some(code),
            Some(message),
        )),
        Ok(ControlMessage::Cancel { reason, .. }) => Ok(build_send_result(
            "unconfirmed",
            transfer_id,
            &export,
            None,
            false,
            Some("cancelled".to_string()),
            Some(reason),
        )),
        Ok(_) => Ok(build_send_result(
            "unconfirmed",
            transfer_id,
            &export,
            None,
            false,
            Some("protocol-error".to_string()),
            Some("未收到可识别的接收端结果".to_string()),
        )),
        Err(error) => Ok(build_send_result(
            "unconfirmed",
            transfer_id,
            &export,
            None,
            false,
            Some(error.code),
            Some(error.message),
        )),
    }
}

fn finish_sender_result(
    session: &Arc<LanSession>,
    transfer_id: String,
    export: &crate::save_file::commands::LanExportOutput,
    status: String,
    result: Option<LanCommitSummary>,
    code: Option<String>,
    message: Option<String>,
) -> Result<LanSendResult, LanSaveError> {
    let status = match status.as_str() {
        "committed" => {
            let summary = result
                .as_ref()
                .ok_or_else(|| LanSaveError::protocol("committed 缺少紧凑提交结果"))?;
            let compact = CompactCommit {
                imported_book_count: summary.imported_book_count,
                new_visible_book_count: summary.new_visible_book_count,
                missing_book_count: summary.missing_book_count,
                progress_conflict_book_count: summary.progress_conflict_book_count,
                applied_preferences: summary.applied_preferences,
            };
            compact
                .validate(export.book_count as u64, export.has_preferences)
                .map_err(|_| LanSaveError::protocol("紧凑提交结果计数与 Offer 不一致"))?;
            session.gate().receiver_reports_committed()?;
            session.emit_event(
                "completed",
                Some(&transfer_id),
                None,
                None,
                serde_json::to_value(summary).ok(),
            );
            "completed"
        }
        "cancelled" => "cancelled",
        "failed" => "failed",
        _ => return Err(LanSaveError::protocol("未知 Result status")),
    };
    Ok(build_send_result(
        status,
        transfer_id,
        export,
        result,
        true,
        code,
        message,
    ))
}

fn build_send_result(
    status: &str,
    transfer_id: String,
    export: &crate::save_file::commands::LanExportOutput,
    remote_value: Option<LanCommitSummary>,
    result_delivered: bool,
    code: Option<String>,
    message: Option<String>,
) -> LanSendResult {
    let remote_commit = remote_value;
    LanSendResult {
        status: status.to_string(),
        transfer_id,
        archive_bytes: export.archive_bytes,
        package_id: export.package_id.clone(),
        written_books: export.written_books,
        attached_book_count: export.written_books,
        skipped_books: export.skipped_books.clone(),
        remote_commit,
        result_delivered,
        code,
        message,
    }
}

fn space_policy_error(error: PolicyError) -> LanSaveError {
    match error {
        PolicyError::InsufficientSpace {
            required,
            available,
        } => LanSaveError::new(
            "insufficient-space",
            format!(
                "空间不足，需要约 {}，当前可用 {}",
                human_bytes(required),
                human_bytes(available)
            ),
        ),
        other => LanSaveError::storage(format!("空间预检失败：{other:?}")),
    }
}

fn human_bytes(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

async fn reject_accept_preflight<R: Runtime>(
    app: &AppHandle<R>,
    session: &Arc<LanSession>,
    task: &Arc<FileTask>,
    transfer_id: &str,
    error: LanSaveError,
) -> LanSaveError {
    finish_task(app, task);
    let _ = session.clear_file_task();
    if let Ok(connection) = session.connection() {
        let _ = connection
            .write_control(&ControlMessage::Decline {
                session_id: session.session_id.clone(),
                transfer_id: transfer_id.to_string(),
                code: error.code.clone(),
                message: error.message.clone(),
            })
            .await;
    }
    spawn_finalize(app, session.clone());
    error
}

pub(crate) async fn accept<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    transfer_id: &str,
) -> Result<SaveFilePrepareResult, LanSaveError> {
    let session = get_session(app, session_id)?;
    if session.transfer_id()? != transfer_id {
        return Err(LanSaveError::invalid_state("transferId 不匹配"));
    }
    let command = session.enter_worker()?;
    let offer = session
        .offer_snapshot()?
        .ok_or_else(|| LanSaveError::invalid_state("Offer 尚未到达，不能接受下载"))?;
    if offer.transfer_id != transfer_id {
        return Err(LanSaveError::invalid_state("Offer transferId 不匹配"));
    }
    session.connection()?;
    let root = lan_library_root(app)?;
    let job_id = new_uuid()?;
    let task: Arc<FileTask> = command
        .while_open(|| -> Result<Arc<FileTask>, LanSaveError> {
            if session.gate().phase()? != Phase::Ready {
                return Err(LanSaveError::new("busy", "会话阶段不允许再次接收"));
            }
            // Reserve first. Busy must keep the Offer so the same command can
            // retry after the system file task releases its slot.
            let task = reserve_job(app, &job_id)?;
            session.set_file_task(job_id.clone(), task.clone())?;
            Ok(task)
        })
        .map_err(|_| LanSaveError::cancelled())??;

    let staging_dir = match create_owned_staging_dir(&root, &job_id) {
        Ok(dir) => dir,
        Err(error) => {
            return Err(
                reject_accept_preflight(app, &session, &task, transfer_id, error.into()).await,
            )
        }
    };
    if let Err(error) = task.set_owned_staging_dir(staging_dir.clone()) {
        return Err(reject_accept_preflight(app, &session, &task, transfer_id, error.into()).await);
    }

    let budget = match SpaceBudget::receiving(offer.archive_bytes, offer.book_bytes) {
        Ok(budget) => budget,
        Err(error) => {
            return Err(reject_accept_preflight(
                app,
                &session,
                &task,
                transfer_id,
                space_policy_error(error),
            )
            .await)
        }
    };
    let available = match available_space_for(&staging_dir) {
        Ok(available) => available,
        Err(error) => {
            return Err(
                reject_accept_preflight(app, &session, &task, transfer_id, error.into()).await,
            )
        }
    };
    if let Err(error) = budget.check(available) {
        return Err(reject_accept_preflight(
            app,
            &session,
            &task,
            transfer_id,
            space_policy_error(error),
        )
        .await);
    }

    let accepted = command
        .while_open(|| -> Result<(), LanSaveError> {
            if session.gate().phase()? != Phase::Ready {
                return Err(LanSaveError::new("busy", "会话阶段不允许再次接收"));
            }
            let current = session
                .take_offer()?
                .ok_or_else(|| LanSaveError::invalid_state("Offer 已不存在"))?;
            if current.transfer_id != transfer_id {
                return Err(LanSaveError::invalid_state("Offer transferId 不匹配"));
            }
            session.gate().accept_download()?;
            Ok(())
        })
        .map_err(|_| LanSaveError::cancelled())
        .and_then(|result| result);
    if let Err(error) = accepted {
        return Err(reject_accept_preflight(app, &session, &task, transfer_id, error).await);
    }

    let app = app.clone();
    let transfer_id = transfer_id.to_string();
    let worker_staging_dir = staging_dir.clone();
    tokio::spawn(async move {
        let result = accept_inner(
            &app,
            session.clone(),
            command,
            task,
            offer,
            &transfer_id,
            worker_staging_dir,
        )
        .await;
        if let Err(error) = &result {
            session.emit_event(
                "error",
                Some(&transfer_id),
                Some(&error.code),
                Some(&error.message),
                None,
            );
            if let Ok(connection) = session.connection() {
                let _ = connection
                    .write_control(&ControlMessage::Result {
                        session_id: session.session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        status: if error.code == "cancelled" {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .to_string(),
                        result: None,
                        code: Some(error.code.clone()),
                        message: Some(truncate_utf8(&error.message, 2048)),
                    })
                    .await;
            }
            finalize_session(&app, &session).await;
        }
        result
    })
    .await
    .map_err(|error| LanSaveError::storage(format!("接收工作任务失败：{error}")))?
}

async fn accept_inner<R: Runtime>(
    app: &AppHandle<R>,
    session: Arc<LanSession>,
    command: WorkerLease,
    task: Arc<FileTask>,
    offer: WireOffer,
    transfer_id: &str,
    staging_dir: PathBuf,
) -> Result<SaveFilePrepareResult, LanSaveError> {
    let part_path = staging_dir.join(format!("{transfer_id}.epubsave.part"));

    let setup = async {
        let (reply, result) = tokio::sync::oneshot::channel();
        session
            .receiver_action_sender()
            .send(ReceiverAction::Accept {
                part_path: part_path.clone(),
                archive_bytes: offer.archive_bytes,
                reply,
            })
            .await
            .map_err(|_| LanSaveError::cancelled())?;
        result.await.map_err(|_| LanSaveError::cancelled())??;
        session.emit_event("preparing", Some(transfer_id), None, None, None);
        Ok::<(), LanSaveError>(())
    }
    .await;
    if let Err(error) = setup {
        return Err(error);
    }

    let worker_app = app.clone();
    let worker_task = task.clone();
    let worker_staging_dir = staging_dir.clone();
    let progress = progress_channel(&session);
    let prepare_lease = command.child().map_err(|_| LanSaveError::cancelled())?;
    let expected = Some((offer.book_bytes, offer.attached_book_count));
    let heartbeat = PhaseHeartbeat::start(
        session.clone(),
        transfer_id.to_string(),
        ProcessingPhase::Preparing,
    )?;
    let prepared = tokio::task::spawn_blocking(move || {
        let _lease = prepare_lease;
        run_prepare_owned_lan(
            worker_app,
            worker_task,
            worker_staging_dir,
            expected,
            progress,
        )
    })
    .await;
    heartbeat.stop().await;
    let prepared = match prepared {
        Ok(result) => result,
        Err(error) => {
            return Err(LanSaveError::storage(format!(
                "prepare 工作线程失败：{error}"
            )));
        }
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            return Err(error.into());
        }
    };
    if let Err(error) = session.gate().import_prepared() {
        return Err(error);
    }
    // Actually write the Preview phase before exposing a clickable UI.
    let preview_heartbeat = PhaseHeartbeat::start(
        session.clone(),
        transfer_id.to_string(),
        ProcessingPhase::Preview,
    )?;
    preview_heartbeat.stop().await;
    session
        .receiver_action_sender()
        .send(ReceiverAction::PhaseChanged)
        .await
        .map_err(|_| LanSaveError::cancelled())?;
    session.emit_event(
        "preview",
        Some(transfer_id),
        None,
        None,
        Some(serde_json::to_value(&prepared).unwrap_or(serde_json::Value::Null)),
    );
    Ok(prepared)
}

pub(crate) async fn commit<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    transfer_id: &str,
    apply_preferences: bool,
) -> Result<SaveFileCommitResult, LanSaveError> {
    let session = get_session(app, session_id)?;
    if session.transfer_id()? != transfer_id {
        return Err(LanSaveError::invalid_state("transferId 不匹配"));
    }
    let command = session.enter_worker()?;
    let commit_lease = command.child().map_err(|_| LanSaveError::cancelled())?;
    let heartbeat_lease = command.child().map_err(|_| LanSaveError::cancelled())?;
    let (task, prepared) = command
        .while_open(|| -> Result<_, LanSaveError> {
            if session.gate().phase()? != Phase::Preview {
                return Err(LanSaveError::invalid_state("会话尚未进入预览阶段"));
            }
            let job_id = session
                .file_job_id()?
                .ok_or_else(|| LanSaveError::invalid_state("没有关联的文件任务"))?;
            let task = active_task(app, &job_id)?;
            // F-N changes its own task to Committing here. The LAN phase is
            // set in the same short lock, after all prechecks have passed.
            let prepared = take_prepared_for_commit(&task)?;
            session.gate().begin_commit()?;
            Ok((task, prepared))
        })
        .map_err(|_| LanSaveError::cancelled())??;
    session.emit_event("committing", Some(transfer_id), None, None, None);
    let app = app.clone();
    let transfer_id = transfer_id.to_string();
    tokio::spawn(async move {
        let result = commit_inner(
            &app,
            session.clone(),
            command,
            commit_lease,
            heartbeat_lease,
            task,
            prepared,
            &transfer_id,
            apply_preferences,
        )
        .await;
        finalize_session(&app, &session).await;
        result
    })
    .await
    .map_err(|error| LanSaveError::storage(format!("提交工作任务失败：{error}")))?
}

fn commit_summary(result: &SaveFileCommitResult) -> LanCommitSummary {
    LanCommitSummary {
        imported_book_count: result.imported_books.len() as u64,
        new_visible_book_count: result.new_visible_books.len() as u64,
        missing_book_count: result.missing_books.len() as u64,
        progress_conflict_book_count: result.progress_conflict_books.len() as u64,
        applied_preferences: result.applied_preferences,
    }
}

async fn commit_inner<R: Runtime>(
    app: &AppHandle<R>,
    session: Arc<LanSession>,
    _command: WorkerLease,
    commit_lease: WorkerLease,
    heartbeat_lease: WorkerLease,
    task: Arc<FileTask>,
    prepared: crate::save_file::PreparedImport,
    transfer_id: &str,
    apply_preferences: bool,
) -> Result<SaveFileCommitResult, LanSaveError> {
    let heartbeat = PhaseHeartbeat::start_owned(
        session.clone(),
        transfer_id.to_string(),
        ProcessingPhase::Committing,
        heartbeat_lease,
    );
    let worker_app = app.clone();
    let worker_task = task.clone();
    let progress = progress_channel(&session);
    // No await between accepting commit and spawning its already-owned worker.
    let worker = tokio::task::spawn_blocking(move || {
        let _lease = commit_lease;
        run_commit(
            worker_app,
            worker_task,
            prepared,
            apply_preferences,
            progress,
        )
    });
    let _ = session
        .receiver_action_sender()
        .try_send(ReceiverAction::PhaseChanged);
    let result = worker.await;
    heartbeat.stop().await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            return Err(LanSaveError::storage(format!(
                "commit 工作线程失败：{error}"
            )));
        }
    };

    let (wire_status, wire_result, wire_code, wire_message) = match &result {
        Ok(committed) => (
            "committed".to_string(),
            Some(commit_summary(committed)),
            None,
            None,
        ),
        Err(error) => (
            "failed".to_string(),
            None,
            Some(error.code.clone()),
            Some(truncate_utf8(&error.message, 2048)),
        ),
    };
    let delivered = match session.connection() {
        Ok(connection) => connection
            .write_control(&ControlMessage::Result {
                session_id: session.session_id.clone(),
                transfer_id: transfer_id.to_string(),
                status: wire_status.clone(),
                result: wire_result,
                code: wire_code,
                message: wire_message,
            })
            .await
            .is_ok(),
        Err(_) => false,
    };
    let _ = session.gate().commit_finished();
    match result {
        Ok(committed) => {
            if delivered {
                session.emit_event(
                    "completed",
                    Some(transfer_id),
                    None,
                    None,
                    serde_json::to_value(&committed).ok(),
                );
            } else {
                session.emit_event(
                    "closed",
                    Some(transfer_id),
                    Some("ack-lost"),
                    Some("接收端已完成提交，但提交确认未送达发送端"),
                    None,
                );
            }
            Ok(committed)
        }
        Err(error) => {
            session.emit_event(
                "error",
                Some(transfer_id),
                Some(&error.code),
                Some(&error.message),
                None,
            );
            Err(error.into())
        }
    }
}

pub(crate) async fn close<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<LanCloseResult, LanSaveError> {
    let session = match get_session(app, session_id) {
        Ok(session) => session,
        Err(error) if error.code == "not-found" && valid_job_id(session_id) => {
            return Ok(LanCloseResult {
                status: "already-finished".to_string(),
            })
        }
        Err(error) => return Err(error),
    };
    // Closing the worker owner first bars new registrations; every in-flight
    // command that already owns a lease can finish or observe the stop signal.
    session.request_workers_close();
    let close = session.gate().close()?;
    session.request_close();
    if let Ok(connection) = session.connection() {
        connection.stop();
    }
    match close {
        super::session::GateClose::AlreadyFinished => {
            session.emit_event("closed", None, None, None, None);
            finalize_session(app, &session).await;
            Ok(LanCloseResult {
                status: "already-finished".to_string(),
            })
        }
        super::session::GateClose::CommitInProgress => {
            session.emit_event(
                "closed",
                None,
                Some("too-late"),
                Some("提交已经开始，保留文件任务直至真实结果返回"),
                None,
            );
            // The finalizer retains every worker and does not cancel a commit.
            spawn_finalize(app, session.clone());
            Ok(LanCloseResult {
                status: "too-late".to_string(),
            })
        }
        super::session::GateClose::Cancelled => {
            session.emit_event("closed", None, None, None, None);
            finalize_session(app, &session).await;
            Ok(LanCloseResult {
                status: "cancelled".to_string(),
            })
        }
    }
}

async fn collect_addresses_off_thread<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || collect_local_addresses(&app))
        .await
        .map_err(|error| {
            LanSaveError::invalid_state(format!("读取本机网络地址任务失败：{error}"))
        })?
}

/// Sorted native snapshot used by the read-only address list command. The
/// first element is the same default the host path would choose; JS does not
/// keep or implement another ranking.
pub(crate) async fn list_local_addresses<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<LanAddressInfo>, LanSaveError> {
    let addresses = collect_addresses_off_thread(app).await?;
    Ok(addresses.iter().map(|address| address.to_info()).collect())
}

pub(crate) async fn host_with_bind_ip<R: Runtime>(
    app: &AppHandle<R>,
    sink: LanEventSink,
    requested: Option<String>,
) -> Result<LanHostResult, LanSaveError> {
    let bind_ip = match requested {
        Some(raw) => {
            let ip = raw
                .parse::<Ipv4Addr>()
                .map_err(|_| LanSaveError::invalid_request("bindIp 必须是 IPv4 字面量"))?;
            if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || ip.is_loopback() {
                return Err(LanSaveError::invalid_request(
                    "bindIp 不能是 loopback/unspecified/组播/广播地址",
                ));
            }
            if !ip.is_private() && !ip.is_link_local() {
                return Err(LanSaveError::invalid_request(
                    "bindIp 只接受私网或 link-local 地址",
                ));
            }
            ip
        }
        None => {
            let addresses = collect_addresses_off_thread(app).await?;
            addresses
                .into_iter()
                .next()
                .map(|address| address.ip)
                .ok_or_else(|| {
                    LanSaveError::unreachable(
                        "没有检测到可用的 Wi‑Fi 或以太网地址，请确认网络已连接",
                    )
                })?
        }
    };
    if !valid_lan_ip(bind_ip) {
        return Err(LanSaveError::unreachable(
            "没有可用的私网或 link-local IPv4 地址",
        ));
    }
    start_host(app, bind_ip, sink).await
}
