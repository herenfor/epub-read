use super::{state::*, *};
use crate::{
    portable_state::{KoreaderProgressImport, KoreaderProgressOutcome, ProgressProjection},
    readest_import::{source, ImportScope},
    save_file::SaveFileLocation,
};
use serde::Serialize;
use std::sync::{atomic::Ordering, Arc};
use tauri::{Manager, WebviewWindow};

fn main_window(window: &WebviewWindow) -> PortableResult<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(error("unavailable", "请在主窗口迁入 KOReader 进度"))
    }
}

fn session(window: &WebviewWindow, id: &str) -> PortableResult<Arc<Session>> {
    main_window(window)?;
    let session = window.state::<KoreaderImportState>().get(id)?;
    session.check()?;
    crate::readest_import::scoped(window, &session.scope, |_, current| {
        if current() {
            Ok(())
        } else {
            Err(error("locked", "书架已锁定"))
        }
    })?;
    Ok(session)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarInfo {
    session_id: String,
    bytes: u64,
}

#[tauri::command]
pub async fn koreader_sidecar_open(
    window: WebviewWindow,
    session_id: String,
    source: SaveFileLocation,
    scope: ImportScope,
) -> PortableResult<SidecarInfo> {
    main_window(&window)?;
    let active = window
        .state::<KoreaderImportState>()
        .reserve(session_id, scope)?;
    let reserved = active.clone();
    let owner = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::readest_import::scoped(&owner, &reserved.scope, |_, _| Ok(()))?;
        reserved.check()?;
        let (bytes, guard) = source::read_bounded(
            owner.app_handle(),
            source,
            SIDECAR_BYTE_LIMIT,
            &|| reserved.cancelled.load(Ordering::Acquire),
        )?;
        reserved.check()?;
        let length = bytes.len() as u64;
        let mut data = reserved
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
        data.bytes = bytes;
        data.guard = Some(guard);
        drop(data);
        crate::readest_import::scoped(&owner, &reserved.scope, |_, current| {
            if current() {
                Ok(())
            } else {
                Err(error("locked", "书架已锁定"))
            }
        })?;
        reserved.check()?;
        Ok(SidecarInfo {
            session_id: reserved.id.clone(),
            bytes: length,
        })
    })
    .await
    .unwrap_or_else(|_| Err(error("storage-error", "侧车读取任务中断")));
    if result.is_err() {
        let _ = window.state::<KoreaderImportState>().close(&active.id);
    }
    result
}

#[tauri::command]
pub async fn koreader_sidecar_read(
    window: WebviewWindow,
    session_id: String,
) -> PortableResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = session(&window, &session_id)?;
        let bytes = {
            let mut data = session
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            if data.guard.is_none() {
                return Err(error("not-ready", "侧车尚未打开"));
            }
            data.fetched = true;
            data.bytes.clone()
        };
        session.check()?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|_| error("storage-error", "侧车读取任务中断"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetCandidate {
    book_hash: String,
    partial_md5: String,
    target_token: String,
    progress: ProgressProjection,
}

#[tauri::command]
pub async fn koreader_import_target(
    window: WebviewWindow,
    session_id: String,
    book_hash: String,
) -> PortableResult<TargetCandidate> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = session(&window, &session_id)?;
        {
            let data = session
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            if !data.fetched {
                return Err(error("invalid-request", "请先读取侧车"));
            }
        }
        let app = window.app_handle();
        let _lease = crate::linked_library::source_lease(app)
            .map_err(|_| error("busy", "书库位置正在调整"))?;
        let target = crate::readest_import::scoped(&window, &session.scope, |store, _| {
            store.readest_target(&book_hash)
        })?;
        let md5 = source::candidate(app, &target.binding, &|| {
            session.cancelled.load(Ordering::Acquire)
        })?;
        crate::readest_import::scoped(&window, &session.scope, |store, _| {
            let current = store.readest_target(&book_hash)?;
            if current.binding != target.binding
                || current.metadata_stamp != target.metadata_stamp
                || current.generation != target.generation
                || current.progress_revision != target.progress_revision
            {
                return Err(error("stale-basis", "本机书籍已变化，请重新预览"));
            }
            Ok(())
        })?;
        session.check()?;
        let token = crate::portable_state::random_uuid_v4()
            .map_err(|_| error("storage-error", "无法生成匹配令牌"))?;
        let row = TargetCandidate {
            book_hash: book_hash.clone(),
            partial_md5: md5,
            target_token: token.clone(),
            progress: target.progress.clone(),
        };
        session
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
            .targets
            .insert(book_hash, StoredTarget { token, target });
        Ok(row)
    })
    .await
    .map_err(|_| error("storage-error", "书籍匹配任务中断"))?
}

#[tauri::command]
pub async fn koreader_import_commit(
    window: WebviewWindow,
    session_id: String,
    book: KoreaderProgressImport,
) -> PortableResult<KoreaderProgressOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = session(&window, &session_id)?;
        let (target, sidecar_guard) = {
            let data = session
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            let stored = accept_commit(&data, &book)?;
            (
                stored.target.clone(),
                data.guard
                    .clone()
                    .ok_or_else(|| error("not-ready", "侧车尚未打开"))?,
            )
        };
        let app = window.app_handle();
        let _lease = crate::linked_library::source_lease(app)
            .map_err(|_| error("busy", "书库位置正在调整"))?;
        let cancelled = || session.cancelled.load(Ordering::Acquire);
        let book_guard = source::verify(app, &target.binding, &book.book_hash, &cancelled)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        crate::readest_import::scoped(&window, &session.scope, |store, current| {
            store.import_koreader_progress(&target, &book, now, &cancelled, |transaction| {
                session.finish(transaction, current, &[book_guard, sidecar_guard])
            })
        })
    })
    .await
    .map_err(|_| error("storage-error", "迁入提交任务中断"))?
}

#[derive(Serialize)]
pub(crate) struct CloseReply {
    status: &'static str,
}

#[tauri::command]
pub async fn koreader_sidecar_close(
    window: WebviewWindow,
    session_id: String,
) -> PortableResult<CloseReply> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(CloseReply {
            status: window.state::<KoreaderImportState>().close(&session_id)?,
        })
    })
    .await
    .map_err(|_| error("storage-error", "关闭迁入会话失败"))?
}
