//! Opt-in Windows AI development capability host. Core never compiles this module.
mod host;
mod http;

mod control;

use control::{Controller, Status};
use host::Host;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub(crate) struct ReaderToolsState(Mutex<Option<Arc<Controller>>>);

fn unsupported_reason() -> Option<&'static str> {
    if !cfg!(windows) {
        Some("platform")
    } else if !cfg!(debug_assertions) {
        Some("release-build")
    } else {
        None
    }
}

fn allowed(window: &tauri::WebviewWindow) -> Result<(), String> {
    if unsupported_reason().is_some() {
        return Err("阅读工具仅在 Windows AI 调试版开放".into());
    }
    if window.label() != "main" {
        return Err("阅读工具仅由应用主窗口管理".into());
    }
    Ok(())
}

fn controller(app: &AppHandle) -> Arc<Controller> {
    let state = app.state::<ReaderToolsState>();
    let mut slot = state.0.lock().expect("reader management slot");
    slot.get_or_insert_with(|| {
        let cleanup_app = app.clone();
        let event_app = app.clone();
        Controller::new(
            app.path()
                .app_local_data_dir()
                .ok()
                .map(|dir| dir.join("reader-tools")),
            std::env::var_os("EPUB_READER_TOOLS_CONFIG").map(Into::into),
            std::env::var("EPUB_READER_TOOLS").as_deref() == Ok("1"),
            unsupported_reason(),
            app.config().identifier.clone(),
            Arc::new(move |archives, tasks| {
                crate::linked_library::close_tool_archives(&cleanup_app, archives);
                cleanup_app
                    .state::<crate::ai::AiState>()
                    .reclaim_reader_index_tasks(&cleanup_app, tasks);
            }),
            Box::new(move |status| {
                let _ = event_app.emit("reader-tools-status", status);
            }),
        )
    })
    .clone()
}

pub(crate) fn start(app: &AppHandle) {
    let control = controller(app);
    control.refresh();
    if std::env::var("EPUB_READER_TOOLS").as_deref() == Ok("1") {
        control.set_enabled(true);
    }
}

fn host_for(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<Arc<Host>, String> {
    allowed(window)?;
    controller(app)
        .host()
        .ok_or_else(|| "本次未启用阅读工具".into())
}

#[tauri::command]
pub(crate) async fn reader_tools_status(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || controller(&app).refresh())
        .await
        .map_err(|_| "无法读取阅读工具状态".into())
}

#[tauri::command]
pub(crate) async fn reader_tools_set_enabled(
    app: AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<Status, String> {
    allowed(&window)?;
    tauri::async_runtime::spawn_blocking(move || controller(&app).set_enabled(enabled))
        .await
        .map_err(|_| "无法切换阅读工具状态".into())
}

#[tauri::command]
pub(crate) fn reader_tools_retry_provider(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Status, String> {
    allowed(&window)?;
    let control = controller(&app);
    if let Some(host) = control.host() {
        host.retry_provider();
    }
    Ok(control.status())
}

#[tauri::command]
pub(crate) fn reader_tools_report_provider_error(
    app: AppHandle,
    window: tauri::WebviewWindow,
    service_instance: String,
    message: String,
) -> Result<(), String> {
    let host = host_for(&app, &window)?;
    // A late failure from a retired provider must not poison the next instance.
    if host.instance == service_instance {
        host.report_error(&message);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn reader_tools_connect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    frames: tauri::ipc::Channel<Value>,
    definitions: Vec<Value>,
    service_instance: String,
) -> Result<String, String> {
    if definitions.len() > 32
        || serde_json::to_vec(&definitions)
            .map_err(|_| "工具目录格式错误")?
            .len()
            > 64 * 1024
    {
        return Err("工具目录过大".into());
    }
    let host = host_for(&app, &window)?;
    if host.instance != service_instance {
        return Err("阅读工具会话已失效".into());
    }
    host.connect(
        Box::new(move |frame| frames.send(frame).map_err(|_| "提供方已断开".into())),
        definitions,
    )
}

#[tauri::command]
pub(crate) fn reader_tools_reply(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    id: String,
    reply: Value,
) -> Result<(), String> {
    if serde_json::to_vec(&reply)
        .map_err(|_| "工具结果格式错误")?
        .len()
        > 4 * 1024 * 1024
    {
        return Err("工具结果过大".into());
    }
    host_for(&app, &window)?.reply(&session_id, &id, reply)
}

#[tauri::command]
pub(crate) async fn reader_tools_disconnect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    allowed(&window)?;
    // Normal shutdown/reload is idempotent even if the service has already stopped.
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(host) = controller(&app).host() {
            host.disconnect(&session_id, reason.as_deref());
        }
    })
    .await
    .map_err(|_| "无法断开阅读工具提供方".into())
}

#[tauri::command]
pub(crate) async fn reader_tools_archive_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    content_hash: String,
) -> Result<crate::linked_library::ArchiveOpenView, String> {
    let host = host_for(&app, &window)?;
    if !host.owns_session(&session_id) {
        return Err("阅读工具会话已失效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        host.source_operation(&session_id, || {
            let info =
                crate::linked_library::open_tool_archive(app.clone(), "main".into(), content_hash)
                    .map_err(|_| "原书当前不可读取，请检查来源".to_string())?;
            if !host.own_archive(&session_id, info.session_id.clone()) {
                crate::linked_library::close_tool_archives(&app, vec![info.session_id]);
                return Err("阅读工具会话已失效".into());
            }
            Ok(info)
        })
    })
    .await
    .map_err(|_| "阅读工具归档打开失败")?
}

#[tauri::command]
pub(crate) async fn reader_tools_archive_close(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    archive_id: String,
) -> Result<(), String> {
    let host = host_for(&app, &window)?;
    if !host.owns_session(&session_id) {
        return Err("阅读工具会话已失效".into());
    }
    tauri::async_runtime::spawn_blocking(move || host.close_archive(&session_id, &archive_id))
        .await
        .map_err(|_| "阅读工具归档关闭失败")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn reader_tools_index_acquire(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    content_hash: String,
) -> Result<crate::ai::AiJob, String> {
    let host = host_for(&app, &window)?;
    if !host.owns_session(&session_id) {
        return Err("阅读工具会话已失效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        host.source_operation(&session_id, || {
            let task = app
                .state::<crate::ai::AiState>()
                .acquire_reader_index_task(&app, content_hash)?;
            if !host.own_task(&session_id, task.id.clone()) {
                app.state::<crate::ai::AiState>()
                    .reclaim_reader_index_tasks(&app, vec![task.id]);
                return Err("阅读工具会话已失效".into());
            }
            Ok(task)
        })
    })
    .await
    .map_err(|_| "无法获取阅读工具准备任务")?
}

pub(crate) fn shutdown(app: &AppHandle) {
    if let Some(control) = app
        .state::<ReaderToolsState>()
        .0
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
    {
        control.set_enabled(false);
    }
}
