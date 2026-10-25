//! Opt-in Windows AI development capability host. Core never compiles this module.
mod host;
mod http;

use host::{Grant, Host};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(crate) struct ReaderToolsState(Mutex<Option<(Arc<Host>, Vec<PathBuf>)>>);

fn allowed() -> Result<(), String> {
    if cfg!(all(windows, debug_assertions)) {
        Ok(())
    } else {
        Err("阅读工具仅在 Windows AI 调试版开放".into())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    clients: Vec<Grant>,
}

pub(crate) fn start(app: &AppHandle) -> Result<(), String> {
    if std::env::var("EPUB_READER_TOOLS").as_deref() != Ok("1") {
        return Ok(());
    }
    allowed()?;
    let grants = match std::env::var_os("EPUB_READER_TOOLS_CONFIG") {
        Some(path) => {
            let file = std::fs::File::open(path).map_err(|_| "无法读取阅读工具授权配置")?;
            if file
                .metadata()
                .map_err(|_| "无法读取阅读工具授权配置")?
                .len()
                > 64 * 1024
            {
                return Err("阅读工具授权配置过大".into());
            }
            serde_json::from_reader::<_, Configuration>(file)
                .map_err(|_| "阅读工具授权配置格式错误")?
                .clients
        }
        None => vec![Grant {
            client_id: "local".into(),
            book_ids: None,
            prepare_index: false,
        }],
    };
    let mut ids = HashSet::new();
    if grants.is_empty()
        || grants.len() > 16
        || grants.iter().any(|grant| {
            let id = &grant.client_id;
            id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                || !ids.insert(id.clone())
                || grant
                    .book_ids
                    .as_ref()
                    .is_some_and(|ids| ids.len() > 10_000)
        })
    {
        return Err("阅读工具客户端授权无效".into());
    }
    let cleanup_app = app.clone();
    let host = Host::new(
        grants,
        Box::new(move |archives, tasks| {
            crate::linked_library::close_tool_archives(&cleanup_app, archives);
            cleanup_app
                .state::<crate::ai::AiState>()
                .reclaim_reader_index_tasks(&cleanup_app, tasks);
        }),
    )?;
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "无法启动本机阅读工具服务")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "无法启动本机阅读工具服务")?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法取得阅读工具端口")?
        .port();
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法取得应用数据目录")?
        .join("reader-tools");
    std::fs::create_dir_all(&directory).map_err(|_| "无法建立阅读工具连接目录")?;
    let mut paths = Vec::new();
    for client in &host.clients {
        let path = directory.join(format!("{}.json", client.grant.client_id));
        let data = json!({"apiVersion":"1", "endpoint":format!("http://127.0.0.1:{port}"),
            "token":client.token, "grant":client.grant, "serviceInstance":host.instance,
            "appIdentifier":app.config().identifier, "development":true});
        // User-local application data inherits the current user's access rules.
        // Only the authorized client receives its credential, never the provider channel.
        if crate::linked_library::atomic_write_bytes(
            &path,
            &serde_json::to_vec(&data).map_err(|_| "无法编码阅读工具连接")?,
        )
        .is_err()
        {
            for path in &paths {
                let _ = std::fs::remove_file(path);
            }
            return Err("无法写入阅读工具连接文件".into());
        }
        paths.push(path);
    }
    let state = app.state::<ReaderToolsState>();
    *state.0.lock().map_err(|_| "阅读工具状态不可用")? = Some((host.clone(), paths));
    tauri::async_runtime::spawn(http::serve(listener, host));
    Ok(())
}

fn host_for(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<Arc<Host>, String> {
    allowed()?;
    if window.label() != "main" {
        return Err("阅读工具仅由应用主窗口提供".into());
    }
    app.state::<ReaderToolsState>()
        .0
        .lock()
        .map_err(|_| "阅读工具状态不可用")?
        .as_ref()
        .map(|(host, _)| host.clone())
        .ok_or_else(|| "本次未启用阅读工具".into())
}

#[tauri::command]
pub(crate) fn reader_tools_connect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    frames: tauri::ipc::Channel<Value>,
    definitions: Vec<Value>,
) -> Result<String, String> {
    if definitions.len() > 32
        || serde_json::to_vec(&definitions)
            .map_err(|_| "工具目录格式错误")?
            .len()
            > 64 * 1024
    {
        return Err("工具目录过大".into());
    }
    host_for(&app, &window)?.connect(
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
pub(crate) fn reader_tools_disconnect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    host_for(&app, &window)?.disconnect(&session_id);
    Ok(())
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
    let cleanup_app = app.clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        crate::linked_library::open_tool_archive(app, "main".into(), content_hash)
    })
    .await
    .map_err(|_| "阅读工具归档打开失败")?
    .map_err(|_| "原书当前不可读取，请检查来源")?;
    if !host.own_archive(&session_id, info.session_id.clone()) {
        crate::linked_library::close_tool_archives(&cleanup_app, vec![info.session_id]);
        return Err("阅读工具会话已失效".into());
    }
    Ok(info)
}

#[tauri::command]
pub(crate) async fn reader_tools_archive_close(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    archive_id: String,
) -> Result<(), String> {
    let host = host_for(&app, &window)?;
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
    let cleanup_app = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::ai::AiState>()
            .acquire_reader_index_task(&app, content_hash)
    })
    .await
    .map_err(|_| "无法获取阅读工具准备任务")??;
    if !host.own_task(&session_id, task.id.clone()) {
        cleanup_app
            .state::<crate::ai::AiState>()
            .reclaim_reader_index_tasks(&cleanup_app, vec![task.id]);
        return Err("阅读工具会话已失效".into());
    }
    Ok(task)
}

pub(crate) fn shutdown(app: &AppHandle) {
    let state = app.state::<ReaderToolsState>();
    let Some((host, paths)) = state.0.lock().ok().and_then(|mut state| state.take()) else {
        return;
    };
    host.stop();
    for path in paths {
        let is_ours = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|data| data["serviceInstance"] == host.instance);
        if is_ours {
            let _ = std::fs::remove_file(path);
        }
    }
}
