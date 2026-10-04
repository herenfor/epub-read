use super::connection::{LanConnection, LanIo};
use super::error::LanSaveError;
use super::pairing::{
    choose_default_lan_ipv4, random_hex_32, LanPairingV1,
};
use super::protocol::{ControlMessage, WireOffer};
use super::session::{LanEventSink, LanSession};
use super::tls::{client_config, server_name, TlsIdentity};
use crate::save_file::commands::{
    active_task, finish_task, reserve_job, run_commit, run_lan_export, run_prepare,
    take_prepared_for_commit,
};
use crate::save_file::{
    new_uuid, valid_job_id, SaveExportScope, SaveFileCommitResult, SaveFileLocation,
    SaveFilePrepareResult, SaveFileProgress,
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
const RESULT_WAIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

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
    pub remote_commit: Option<serde_json::Value>,
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
        if sessions.contains_key(&session.session_id) {
            return Err(LanSaveError::invalid_state("sessionId 已存在"));
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

fn manager<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, LanSaveManager>, LanSaveError> {
    Ok(app.state::<LanSaveManager>())
}

fn insert_session<R: Runtime>(app: &AppHandle<R>, session: Arc<LanSession>) -> Result<(), LanSaveError> {
    manager(app)?.insert(session)
}

fn remove_session<R: Runtime>(app: &AppHandle<R>, session: &Arc<LanSession>) {
    if let Ok(state) = manager(app) {
        state.remove_if_same(session);
    }
}

fn get_session<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<Arc<LanSession>, LanSaveError> {
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
                let total = value
                    .get("totalBytes")
                    .and_then(serde_json::Value::as_u64);
                session.emit_progress(phase, processed, total);
            }
        }
        Ok(())
    })
}

fn temp_session_dir<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<PathBuf, LanSaveError> {
    if !valid_job_id(session_id) {
        return Err(LanSaveError::invalid_state("sessionId 不是规范 UUID"));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| LanSaveError::storage(format!("无法取得应用缓存目录：{error}")))?
        .join("lan-save-staging")
        .join(session_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub(crate) async fn start_host<R: Runtime>(
    app: &AppHandle<R>,
    bind_ip: Ipv4Addr,
    sink: LanEventSink,
) -> Result<LanHostResult, LanSaveError> {
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
    let pairing = LanPairingV1::new(session_id.clone(), bind_ip, port, fingerprint, token.clone());
    let pairing_info = pairing.encode()?;
    let session = Arc::new(LanSession::new_host(
        session_id.clone(),
        token,
        transfer_id.clone(),
        sink,
    ));
    insert_session(app, session.clone())?;
    session.emit_event("pairing", Some(&transfer_id), None, None, None);

    let app_handle = app.clone();
    let worker_session = session.clone();
    tokio::spawn(async move {
        match host_accept_loop(listener, identity, worker_session.clone()).await {
            Ok(()) => {}
            Err(error) => {
                worker_session.emit_event(
                    "error",
                    worker_session.transfer_id().ok().as_deref(),
                    Some(&error.code),
                    Some(&error.message),
                    None,
                );
                remove_session(&app_handle, &worker_session);
            }
        }
    });

    Ok(LanHostResult {
        session_id,
        pairing_info,
    })
}

async fn host_accept_loop(
    listener: TcpListener,
    identity: TlsIdentity,
    session: Arc<LanSession>,
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
        let connected = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            accept_peer(tcp, &identity, &session),
        )
        .await;
        match connected {
            Ok(Ok(connection)) => {
                session.set_connection(connection.clone())?;
                session.gate().paired()?;
                let transfer_id = session.transfer_id()?;
                session.emit_event("paired", Some(&transfer_id), None, None, None);
                spawn_control_reader(session, connection);
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
        ControlMessage::Hello {
            session_id,
            token,
        } => (session_id, token),
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
    let transfer_id = session.transfer_id()?;
    connection
        .write_control(&ControlMessage::Paired {
            session_id: session.session_id.clone(),
            transfer_id,
        })
        .await?;
    Ok(connection)
}

pub(crate) async fn join<R: Runtime>(
    app: &AppHandle<R>,
    pairing_info: &str,
    sink: LanEventSink,
) -> Result<LanJoinResult, LanSaveError> {
    let pairing = LanPairingV1::parse(pairing_info)?;
    let (host, port) = pairing.endpoint_addr()?;
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| LanSaveError::unreachable("连接监听端超时"))?
        .map_err(|error| LanSaveError::unreachable(format!("无法连接监听端：{error}")))?;
    let connector = TlsConnector::from(Arc::new(client_config(&pairing.certificate_sha256)?));
    let tls = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        connector.connect(server_name(host), tcp),
    )
    .await
    .map_err(|_| LanSaveError::secure("TLS 握手超时"))?
    .map_err(map_client_handshake_error)?;
    let connection = Arc::new(LanConnection::new(LanIo::Client(tls)));
    connection
        .write_control(&ControlMessage::Hello {
            session_id: pairing.session_id.clone(),
            token: pairing.token.clone(),
        })
        .await?;
    let paired = connection.read_control().await?;
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
    let session = Arc::new(LanSession::new_join(
        pairing.session_id.clone(),
        transport_transfer_id.clone(),
        sink,
    ));
    session.set_connection(connection.clone())?;
    session.gate().paired()?;
    insert_session(app, session.clone())?;
    session.emit_event("paired", Some(&transport_transfer_id), None, None, None);
    spawn_control_reader(session, connection);
    Ok(LanJoinResult {
        session_id: pairing.session_id,
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

fn spawn_control_reader(session: Arc<LanSession>, connection: Arc<LanConnection>) {
    tokio::spawn(async move {
        loop {
            if session.is_close_requested() {
                return;
            }
            let message = match connection.read_control().await {
                Ok(message) => message,
                Err(error) => {
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
                    return;
                }
            };
            if message.session_id() != session.session_id {
                session.emit_event(
                    "error",
                    session.transfer_id().ok().as_deref(),
                    Some("invalid-state"),
                    Some("控制消息 sessionId 不匹配"),
                    None,
                );
                return;
            }
            let expected_transfer = session.transfer_id().ok();
            if let Some(actual) = message.transfer_id() {
                if expected_transfer.as_deref() != Some(actual) {
                    session.emit_event(
                        "error",
                        expected_transfer.as_deref(),
                        Some("invalid-state"),
                        Some("控制消息 transferId 不匹配"),
                        None,
                    );
                    return;
                }
            }
            match message {
                ControlMessage::Offer {
                    transfer_id,
                    archive_bytes,
                    book_count,
                    attached_book_count,
                    include_books,
                    has_preferences,
                    ..
                } => {
                    if !session.claim_incoming() {
                        let _ = connection
                            .write_control(&ControlMessage::Error {
                                session_id: session.session_id.clone(),
                                transfer_id: Some(transfer_id.clone()),
                                code: "invalid-state".to_string(),
                                message: "双方同时发起或已有传输角色".to_string(),
                            })
                            .await;
                        session.emit_event(
                            "error",
                            Some(&transfer_id),
                            Some("invalid-state"),
                            Some("双方同时发起或已有传输角色"),
                            None,
                        );
                        return;
                    }
                    let offer = WireOffer {
                        session_id: session.session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        archive_bytes,
                        book_count,
                        attached_book_count,
                        include_books,
                        has_preferences,
                    };
                    let _ = session.set_offer(offer.clone());
                    session.emit_event(
                        "offered",
                        Some(&transfer_id),
                        None,
                        None,
                        Some(json!({
                            "archiveBytes": archive_bytes,
                            "bookCount": book_count,
                            "attachedBookCount": attached_book_count,
                            "includeBooks": include_books,
                            "hasPreferences": has_preferences,
                        })),
                    );
                    // Leave the stream positioned exactly at the raw ZIP
                    // bytes; `lan_save_accept` reads the declared length only.
                    return;
                }
                ControlMessage::Accept { .. }
                | ControlMessage::Received { .. }
                | ControlMessage::Result { .. } => {
                    if !session.is_outgoing() {
                        session.emit_event(
                            "error",
                            expected_transfer.as_deref(),
                            Some("invalid-state"),
                            Some("接收端角色收到仅发送端可读的控制消息"),
                            None,
                        );
                        return;
                    }
                    let stop = matches!(message, ControlMessage::Result { .. });
                    let _ = session.push_inbox(message);
                    if stop {
                        return;
                    }
                }
                ControlMessage::Decline { .. }
                | ControlMessage::Cancel { .. }
                | ControlMessage::Error { .. } => {
                    let _ = session.push_inbox(message);
                    return;
                }
                ControlMessage::Hello { .. } | ControlMessage::Paired { .. } => {
                    session.emit_event(
                        "error",
                        expected_transfer.as_deref(),
                        Some("invalid-state"),
                        Some("已配对连接收到 Hello/Paired"),
                        None,
                    );
                    return;
                }
            }
        }
    });
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
    if !session.claim_outgoing() {
        return Err(LanSaveError::invalid_state("会话已经有传输角色"));
    }
    session.gate().begin_export()?;
    let transfer_id = session.transfer_id()?;
    let job_id = new_uuid()?;
    let task = reserve_job(app, &job_id)?;
    session.set_file_task(job_id.clone(), task.clone())?;
    session.emit_event("exporting", Some(&transfer_id), None, None, None);

    let target_dir = match temp_session_dir(app, session_id) {
        Ok(dir) => dir,
        Err(error) => {
            finish_task(app, &task);
            return Err(error);
        }
    };
    let target = target_dir.join(format!("{transfer_id}.epubsave"));
    let worker_app = app.clone();
    let worker_task = task.clone();
    let worker_target = target.clone();
    let progress = progress_channel(&session);
    session.set_file_worker_active(true);
    let export = tokio::task::spawn_blocking(move || {
        run_lan_export(worker_app, worker_task, worker_target, scope, include_books, progress)
    })
    .await;
    session.finish_file_worker();
    let export = export.map_err(|error| LanSaveError::storage(format!("导出工作线程失败：{error}")))?;
    let export = match export {
        Ok(export) => export,
        Err(error) => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Err(error.into());
        }
    };

    let offer = ControlMessage::Offer {
        session_id: session.session_id.clone(),
        transfer_id: transfer_id.clone(),
        archive_bytes: export.archive_bytes,
        book_count: export.book_count,
        attached_book_count: export.written_books,
        include_books,
        has_preferences: export.has_preferences,
    };
    let connection = match session.connection() {
        Ok(connection) => connection,
        Err(error) => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Err(error);
        }
    };
    let offer_result = connection.write_control(&offer).await;
    if let Err(error) = offer_result {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&target_dir);
        return Err(error);
    }
    if let Err(error) = session.gate().export_ready() {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&target_dir);
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
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Err(error);
        }
    };
    match decision {
        ControlMessage::Accept { .. } => {}
        ControlMessage::Decline { code, message, .. } => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
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
                remote_commit: None,
                result_delivered: true,
                code: Some(code),
                message: Some(message),
            });
        }
        ControlMessage::Error { code, message, .. } => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Err(LanSaveError { code, message });
        }
        ControlMessage::Cancel { reason, .. } => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Err(LanSaveError::new("cancelled", reason));
        }
        _ => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Err(LanSaveError::protocol("Offer 后收到意外控制消息"));
        }
    }
    if let Err(error) = session.gate().peer_accepts_download() {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&target_dir);
        return Err(error);
    }
    if let Err(error) = connection
        .send_archive_from_path(&export.path, export.archive_bytes, &session)
        .await
    {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&target_dir);
        return Err(error);
    }

    let received = session
        .wait_for_message(RESULT_WAIT_TIMEOUT, |message| {
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
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&target_dir);
            return Ok(LanSendResult {
                status: "unconfirmed".to_string(),
                transfer_id,
                archive_bytes: export.archive_bytes,
                package_id: export.package_id,
                written_books: export.written_books,
                attached_book_count: export.written_books,
                remote_commit: None,
                result_delivered: false,
                code: Some(error.code),
                message: Some(error.message),
            });
        }
    };
    if let ControlMessage::Received { .. } = received {
        // Wait for the receiver's F-N result next.
    } else if let ControlMessage::Result { status, result, code, message, .. } = received {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&target_dir);
        return Ok(build_send_result(
            if status == "committed" { "completed" } else { "failed" },
            transfer_id,
            &export,
            result,
            true,
            code,
            message,
        ));
    } else {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&target_dir);
        return Err(LanSaveError::cancelled());
    }

    let result = session
        .wait_for_message(RESULT_WAIT_TIMEOUT, |message| {
            matches!(
                message,
                ControlMessage::Result { .. }
                    | ControlMessage::Error { .. }
                    | ControlMessage::Cancel { .. }
            )
        })
        .await;
    finish_task(app, &task);
    let _ = std::fs::remove_dir_all(&target_dir);
    match result {
        Ok(ControlMessage::Result {
            status,
            result,
            code,
            message,
            ..
        }) => {
            if status == "committed" {
                session.gate().receiver_reports_committed()?;
                session.emit_event(
                    "completed",
                    Some(&transfer_id),
                    None,
                    None,
                    result.clone(),
                );
                Ok(build_send_result(
                    "completed",
                    transfer_id,
                    &export,
                    result,
                    true,
                    code,
                    message,
                ))
            } else {
                Ok(build_send_result(
                    "failed",
                    transfer_id,
                    &export,
                    result,
                    true,
                    code,
                    message,
                ))
            }
        }
        Ok(ControlMessage::Error { code, message, .. }) => Ok(LanSendResult {
            status: "unconfirmed".to_string(),
            transfer_id,
            archive_bytes: export.archive_bytes,
            package_id: export.package_id,
            written_books: export.written_books,
            attached_book_count: export.written_books,
            remote_commit: None,
            result_delivered: false,
            code: Some(code),
            message: Some(message),
        }),
        Ok(ControlMessage::Cancel { reason, .. }) => Ok(LanSendResult {
            status: "unconfirmed".to_string(),
            transfer_id,
            archive_bytes: export.archive_bytes,
            package_id: export.package_id,
            written_books: export.written_books,
            attached_book_count: export.written_books,
            remote_commit: None,
            result_delivered: false,
            code: Some("cancelled".to_string()),
            message: Some(reason),
        }),
        Ok(_) => Ok(LanSendResult {
            status: "unconfirmed".to_string(),
            transfer_id,
            archive_bytes: export.archive_bytes,
            package_id: export.package_id,
            written_books: export.written_books,
            attached_book_count: export.written_books,
            remote_commit: None,
            result_delivered: false,
            code: Some("protocol-error".to_string()),
            message: Some("未收到可识别的接收端结果".to_string()),
        }),
        Err(error) => Ok(LanSendResult {
            status: "unconfirmed".to_string(),
            transfer_id,
            archive_bytes: export.archive_bytes,
            package_id: export.package_id,
            written_books: export.written_books,
            attached_book_count: export.written_books,
            remote_commit: None,
            result_delivered: false,
            code: Some(error.code),
            message: Some(error.message),
        }),
    }
}

fn build_send_result(
    status: &str,
    transfer_id: String,
    export: &crate::save_file::commands::LanExportOutput,
    remote_value: Option<serde_json::Value>,
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
        remote_commit,
        result_delivered,
        code,
        message,
    }
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
    let offer = session
        .take_offer()?
        .ok_or_else(|| LanSaveError::invalid_state("Offer 尚未到达，不能接受下载"))?;
    if offer.transfer_id != transfer_id {
        return Err(LanSaveError::invalid_state("Offer transferId 不匹配"));
    }
    session.gate().accept_download()?;
    let connection = session.connection()?;
    let job_id = new_uuid()?;
    let task = reserve_job(app, &job_id)?;
    if let Err(error) = session.set_file_task(job_id.clone(), task.clone()) {
        finish_task(app, &task);
        return Err(error);
    }
    let part_dir = match temp_session_dir(app, session_id) {
        Ok(dir) => dir,
        Err(error) => {
            finish_task(app, &task);
            return Err(error);
        }
    };
    let part_path = part_dir.join(format!("{transfer_id}.epubsave.part"));

    let setup = async {
        connection
            .write_control(&ControlMessage::Accept {
                session_id: session.session_id.clone(),
                transfer_id: transfer_id.to_string(),
            })
            .await?;
        connection
            .receive_archive_to_path(&part_path, offer.archive_bytes, &session)
            .await?;
        connection
            .write_control(&ControlMessage::Received {
                session_id: session.session_id.clone(),
                transfer_id: transfer_id.to_string(),
                archive_bytes: offer.archive_bytes,
            })
            .await?;
        session.gate().received_exact_archive()?;
        session.emit_event("preparing", Some(transfer_id), None, None, None);
        Ok::<(), LanSaveError>(())
    }
    .await;
    if let Err(error) = setup {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&part_dir);
        return Err(error);
    }

    let worker_app = app.clone();
    let worker_task = task.clone();
    let worker_path = part_path.clone();
    let progress = progress_channel(&session);
    session.set_file_worker_active(true);
    let prepared = tokio::task::spawn_blocking(move || {
        run_prepare(
            worker_app,
            worker_task,
            SaveFileLocation::Path {
                path: worker_path.to_string_lossy().into_owned(),
            },
            progress,
        )
    })
    .await;
    session.finish_file_worker();
    let prepared = match prepared {
        Ok(result) => result,
        Err(error) => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&part_dir);
            return Err(LanSaveError::storage(format!("prepare 工作线程失败：{error}")));
        }
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            finish_task(app, &task);
            let _ = std::fs::remove_dir_all(&part_dir);
            return Err(error.into());
        }
    };
    if let Err(error) = session.gate().import_prepared() {
        finish_task(app, &task);
        let _ = std::fs::remove_dir_all(&part_dir);
        return Err(error);
    }
    session.emit_event(
        "preview",
        Some(transfer_id),
        None,
        None,
        Some(serde_json::to_value(&prepared).unwrap_or(serde_json::Value::Null)),
    );
    let _ = std::fs::remove_dir_all(&part_dir);
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
    session.gate().begin_commit()?;
    let job_id = session
        .file_job_id()?
        .ok_or_else(|| LanSaveError::invalid_state("没有关联的文件任务"))?;
    let task = active_task(app, &job_id)?;
    let prepared = take_prepared_for_commit(&task)?;
    session.emit_event("committing", Some(transfer_id), None, None, None);
    let worker_app = app.clone();
    let worker_task = task.clone();
    let progress = progress_channel(&session);
    session.set_file_worker_active(true);
    let result = tokio::task::spawn_blocking(move || {
        run_commit(worker_app, worker_task, prepared, apply_preferences, progress)
    })
    .await;
    session.finish_file_worker();
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            finish_task(app, &task);
            return Err(LanSaveError::storage(format!("commit 工作线程失败：{error}")));
        }
    };
    finish_task(app, &task);

    let (wire_status, wire_result, wire_code, wire_message) = match &result {
        Ok(committed) => (
            "committed".to_string(),
            serde_json::to_value(committed).ok(),
            None,
            None,
        ),
        Err(error) => (
            "failed".to_string(),
            None,
            Some(error.code.clone()),
            Some(error.message.clone()),
        ),
    };
    let delivered = match session.connection() {
        Ok(connection) => connection
            .write_control(&ControlMessage::Result {
                session_id: session.session_id.clone(),
                transfer_id: transfer_id.to_string(),
                status: wire_status,
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
            remove_session(app, &session);
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
            remove_session(app, &session);
            Err(error.into())
        }
    }
}

pub(crate) async fn close<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<LanCloseResult, LanSaveError> {
    let session = get_session(app, session_id)?;
    let close = session.gate().close()?;
    session.request_close();
    if let Ok(connection) = session.connection() {
        connection.stop();
    }
    match close {
        super::session::GateClose::AlreadyFinished => {
            session.emit_event("closed", None, None, None, None);
            remove_session(app, &session);
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
            // The commit worker remains the owner of the session slot and
            // removes it after F-N returns its real result.
            Ok(LanCloseResult {
                status: "too-late".to_string(),
            })
        }
        super::session::GateClose::Cancelled => {
            if let Some(task) = session.file_task()? {
                if session.is_file_worker_active() {
                    crate::save_file::commands::request_cancel_task(&task);
                    let _ = session
                        .wait_file_worker_done(Duration::from_secs(30))
                        .await;
                }
                // No worker is running after the wait; the slot is either
                // idle-running (network phase) or prepared. Discard it without
                // entering the `cancel_task` worker-observation loop.
                finish_task(app, &task);
            }
            session.emit_event("closed", None, None, None, None);
            remove_session(app, &session);
            Ok(LanCloseResult {
                status: "cancelled".to_string(),
            })
        }
    }
}

pub(crate) async fn host_with_default_ip<R: Runtime>(
    app: &AppHandle<R>,
    sink: LanEventSink,
) -> Result<LanHostResult, LanSaveError> {
    let bind_ip = choose_default_lan_ipv4()?;
    start_host(app, bind_ip, sink).await
}
