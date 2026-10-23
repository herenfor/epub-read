//! Experimental AI-only transport and read-only indexed chapter access.
use super::{AiSearchHit, AiState};
use serde::Deserialize;
mod retrieval;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::sync::oneshot;

#[tauri::command]
pub(crate) async fn ai_chat_search(
    app: AppHandle,
    input: retrieval::SearchInput,
) -> Result<Vec<Vec<AiSearchHit>>, String> {
    development_only()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AiState>()
            .ensure(&app)?
            .with_connection(|connection| retrieval::search(connection, input))
    })
    .await
    .map_err(|error| error.to_string())?
}

static REQUESTS: LazyLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn development_only() -> Result<(), String> {
    if cfg!(all(debug_assertions, windows)) {
        Ok(())
    } else {
        Err("阅读伙伴仅在 Windows AI 调试版开放".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatInput {
    request_id: String,
    endpoint: String,
    api_key: String,
    payload: serde_json::Value,
}

struct RequestLease(String);
impl Drop for RequestLease {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            requests.remove(&self.0);
        }
    }
}

#[tauri::command]
pub(crate) async fn ai_chat_stream(
    input: ChatInput,
    on_chunk: Channel<Vec<u8>>,
) -> Result<(), String> {
    development_only()?;
    let endpoint = reqwest::Url::parse(&input.endpoint).map_err(|_| "API 地址无效")?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("API 地址必须为不含凭据的 HTTP(S) 地址".into());
    }
    let body = serde_json::to_vec(&input.payload).map_err(|error| error.to_string())?;
    if body.len() > 1024 * 1024 || input.request_id.is_empty() {
        return Err("本次对话上下文过大，请新建对话或缩小检索范围".into());
    }
    let (tx, mut cancelled) = oneshot::channel();
    {
        let mut requests = REQUESTS.lock().map_err(|_| "对话状态不可用")?;
        if requests.contains_key(&input.request_id) {
            return Err("对话请求标识重复".into());
        }
        requests.insert(input.request_id.clone(), tx);
    }
    let _lease = RequestLease(input.request_id);
    // Admission acknowledgment also closes the cancel-before-admission race.
    on_chunk.send(Vec::new()).map_err(|_| "对话窗口已关闭")?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("无法创建 API 连接：{error}"))?;
    let send = client
        .post(endpoint)
        .bearer_auth(input.api_key)
        .header("Content-Type", "application/json")
        .body(body)
        .send();
    let mut response = tokio::select! {
        _ = &mut cancelled => return Err("对话已停止".into()),
        result = send => result.map_err(|error| format!("API 连接失败：{error}"))?,
    };
    if !response.status().is_success() {
        // Do not copy provider response bodies: they can contain input text or credentials.
        return Err(format!(
            "API 请求失败（HTTP {}），请检查地址、模型和密钥",
            response.status().as_u16()
        ));
    }
    let mut received = 0usize;
    loop {
        let bytes = tokio::select! {
            _ = &mut cancelled => return Err("对话已停止".into()),
            result = response.chunk() => result.map_err(|error| format!("API 响应中断：{error}"))?,
        };
        let Some(bytes) = bytes else { break };
        received += bytes.len();
        if received > 8 * 1024 * 1024 {
            return Err("API 响应超过本次对话的大小限制".into());
        }
        for part in bytes.chunks(16 * 1024) {
            on_chunk.send(part.to_vec()).map_err(|_| "对话窗口已关闭")?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn ai_chat_cancel(request_id: String) -> Result<(), String> {
    development_only()?;
    if let Some(sender) = REQUESTS
        .lock()
        .map_err(|_| "对话状态不可用")?
        .remove(&request_id)
    {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_chat_read_chapter(
    app: AppHandle,
    input: retrieval::ReadChapterInput,
) -> Result<retrieval::ChapterPage, String> {
    development_only()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AiState>()
            .ensure(&app)?
            .with_connection(|connection| retrieval::read(connection, input))
    })
    .await
    .map_err(|error| error.to_string())?
}
