//! Connection reuse starts only after both endpoints have released their
//! previous file jobs. File-stream failures still end the connection.
use super::*;

const RESET_TIMEOUT: Duration = Duration::from_secs(45);

fn remove_owned_dir(path: PathBuf) -> Result<(), LanSaveError> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn finish_or_close<R: Runtime>(
    app: &AppHandle<R>,
    session: Arc<LanSession>,
    reusable: bool,
) {
    if !reusable || session.is_close_requested() || session.gate().finish_transfer().is_err() {
        spawn_finalize(app, session);
        return;
    }
    let owner = match session.enter_worker() {
        Ok(owner) => owner,
        Err(_) => {
            spawn_finalize(app, session);
            return;
        }
    };
    let app = app.clone();
    tokio::spawn(async move {
        let result = recycle(&app, &session, &owner).await;
        drop(owner); // A terminal finalizer must never wait for its own lease.
        if let Err(error) = result {
            if !session.is_close_requested() {
                session.emit_event(
                    "error",
                    session.transfer_id().ok().as_deref(),
                    Some(&error.code),
                    Some(&error.message),
                    None,
                );
            }
            finalize_session(&app, &session).await;
        }
    });
}

async fn recycle<R: Runtime>(
    app: &AppHandle<R>,
    session: &Arc<LanSession>,
    owner: &WorkerLease,
) -> Result<(), LanSaveError> {
    let old = session.transfer_id()?;
    let workers = session.begin_turnover(&old)?;
    workers.drain_closed().await; // Not a timeout granting deletion permission.
    let cleanup_app = app.clone();
    let cleanup_session = session.clone();
    let cleanup_lease = owner.child().map_err(|_| LanSaveError::cancelled())?;
    tokio::task::spawn_blocking(move || {
        let _lease = cleanup_lease;
        if let Some(task) = cleanup_session.file_task()? {
            let staging = crate::save_file::staging_root(&lan_library_root(&cleanup_app)?)?
                .join(format!("save-file-{}", task.job_id));
            finish_task(&cleanup_app, &task);
            // F-N's normal cleanup is best effort. Before advertising reusable,
            // report a genuine deletion error rather than silently leak batches.
            remove_owned_dir(staging)?;
        }
        remove_owned_dir(session_staging_dir(
            &cleanup_app,
            &cleanup_session.session_id,
        )?)?;
        cleanup_session.clear_transfer_data()
    })
    .await
    .map_err(|e| LanSaveError::storage(format!("批次清理线程失败：{e}")))??;
    session.mark_local_done()?;
    let connection = session.connection()?;
    connection
        .write_control(&ControlMessage::TransferDone {
            session_id: session.session_id.clone(),
            transfer_id: old.clone(),
        })
        .await?;
    let handshake = async {
        session.wait_peer_done().await?;
        if session.host_token().is_some() {
            let next = new_uuid()?;
            session.set_next_transfer(next.clone())?;
            connection
                .write_control(&ControlMessage::NextTransfer {
                    session_id: session.session_id.clone(),
                    transfer_id: old.clone(),
                    next_transfer_id: next,
                })
                .await?;
        }
        session.wait_next_transfer(&old).await
    };
    tokio::time::timeout(RESET_TIMEOUT, handshake)
        .await
        .map_err(|_| LanSaveError::expired("上一批已结束，等待双方释放文件任务超时，请重新连接"))?
}

/// Runs inside the sole control pump, before ordinary phase dispatch. In
/// particular installing the new ID happens before reading any following frame.
pub(super) async fn control(
    session: &Arc<LanSession>,
    connection: &Arc<LanConnection>,
    message: &ControlMessage,
) -> Result<bool, LanSaveError> {
    match message {
        ControlMessage::TransferDone { transfer_id, .. } => {
            if session.transfer_id()? != *transfer_id {
                return Err(LanSaveError::protocol("收尾编号不匹配"));
            }
            session.mark_peer_done()?;
        }
        ControlMessage::NextTransfer {
            transfer_id,
            next_transfer_id,
            ..
        } => {
            if session.host_token().is_some() {
                return Err(LanSaveError::protocol("仅监听端可分配下一批编号"));
            }
            session.install_next_transfer(transfer_id, next_transfer_id, false)?;
            connection
                .write_control(&ControlMessage::NextTransferAck {
                    session_id: session.session_id.clone(),
                    transfer_id: transfer_id.clone(),
                    next_transfer_id: next_transfer_id.clone(),
                })
                .await?;
            session.activate_next_transfer()?;
            session.emit_event(
                "ready",
                Some(next_transfer_id),
                None,
                None,
                Some(json!({"previousTransferId":transfer_id})),
            );
        }
        ControlMessage::NextTransferAck {
            transfer_id,
            next_transfer_id,
            ..
        } => {
            if session.host_token().is_none() {
                return Err(LanSaveError::protocol("下一批确认方向不匹配"));
            }
            session.install_next_transfer(transfer_id, next_transfer_id, true)?;
            session.emit_event(
                "ready",
                Some(next_transfer_id),
                None,
                None,
                Some(json!({"previousTransferId":transfer_id})),
            );
        }
        _ => return Ok(false),
    }
    Ok(true)
}

pub(crate) async fn cancel_transfer<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    transfer_id: &str,
) -> Result<LanCloseResult, LanSaveError> {
    let session = get_session(app, session_id)?;
    if session.transfer_id()? != transfer_id {
        return Err(LanSaveError::invalid_state("transferId 已失效"));
    }
    let too_late = || {
        Ok(LanCloseResult {
            status: "too-late".into(),
        })
    };
    if session.gate().phase()? == Phase::Committing {
        return too_late();
    }
    let command = match session.enter_transfer_worker() {
        Ok(command) => command,
        Err(_) if session.gate().phase()? == Phase::Committing => return too_late(),
        Err(error) => return Err(error),
    };
    let preview = command
        .while_open(|| -> Result<_, LanSaveError> {
            if session.transfer_id()? != transfer_id {
                return Err(LanSaveError::invalid_state("transferId 已失效"));
            }
            match session.gate().phase()? {
                Phase::Committing => Ok(None),
                Phase::Preview => {
                    session.gate().finish_transfer()?;
                    Ok(Some(true))
                }
                Phase::Ready if session.is_incoming() && session.offer_snapshot()?.is_some() => {
                    session.gate().finish_transfer()?;
                    Ok(Some(false))
                }
                _ => Err(LanSaveError::new(
                    "busy",
                    "传送中不能只取消本批，请断开连接",
                )),
            }
        })
        .map_err(|_| LanSaveError::cancelled())??;
    let Some(preview) = preview else {
        return Ok(LanCloseResult {
            status: "too-late".into(),
        });
    };
    let message = if preview {
        ControlMessage::Result {
            session_id: session_id.into(),
            transfer_id: transfer_id.into(),
            status: "cancelled".into(),
            result: None,
            code: Some("cancelled".into()),
            message: Some("接收方取消本批导入".into()),
        }
    } else {
        ControlMessage::Decline {
            session_id: session_id.into(),
            transfer_id: transfer_id.into(),
            code: "cancelled".into(),
            message: "接收方拒绝本批传送".into(),
        }
    };
    let app = app.clone();
    let transfer_id = transfer_id.to_owned();
    tokio::spawn(async move {
        let sent = match session.connection() {
            Ok(connection) => connection.write_control(&message).await,
            Err(error) => Err(error),
        };
        session.emit_event(
            "cancelled",
            Some(&transfer_id),
            Some("cancelled"),
            None,
            None,
        );
        drop(command);
        finish_or_close(&app, session, sent.is_ok());
        sent?;
        Ok(LanCloseResult {
            status: "cancelled".into(),
        })
    })
    .await
    .map_err(|e| LanSaveError::storage(format!("取消批次工作失败：{e}")))?
}
