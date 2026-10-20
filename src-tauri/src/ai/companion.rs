//! Experimental AI-only transport and read-only indexed chapter access.
use super::{AiSearchHit, AiState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::sync::oneshot;

#[tauri::command]
pub(crate) async fn ai_chat_search(
    app: AppHandle,
    input: super::AiSearchInput,
) -> Result<Vec<AiSearchHit>, String> {
    development_only()?;
    tauri::async_runtime::spawn_blocking(move || app.state::<AiState>().ensure(&app)?.search(input))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadChapterInput {
    content_hash: String,
    chapter_path: String,
    offset: u32,
    parser_version: String,
    normalizer_version: String,
    chunker_version: String,
    around_chunk_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChapterPage {
    hits: Vec<AiSearchHit>,
    offset: u32,
    next_offset: Option<u32>,
}

#[tauri::command]
pub(crate) async fn ai_chat_read_chapter(
    app: AppHandle,
    input: ReadChapterInput,
) -> Result<ChapterPage, String> {
    development_only()?;
    let hash = super::normalize_content_hash(&input.content_hash)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AiState>().ensure(&app)?.with_connection(|connection| {
            let offset = if let Some(chunk_id) = &input.around_chunk_id {
                let index: u32 = connection.query_row(
                    "WITH ordered AS (
                       SELECT c.chunk_id, ROW_NUMBER() OVER (
                         ORDER BY CAST(json_extract(c.anchor_json, '$.start') AS INTEGER), c.chunk_id
                       ) - 1 AS position
                       FROM chunks c JOIN books b ON b.content_hash=c.content_hash
                       WHERE c.content_hash=?1 AND c.chapter_path=?2
                         AND b.parser_version=?3 AND b.normalizer_version=?4 AND b.chunker_version=?5
                     ) SELECT position FROM ordered WHERE chunk_id=?6",
                    rusqlite::params![hash, input.chapter_path, input.parser_version,
                        input.normalizer_version, input.chunker_version, chunk_id],
                    |row| row.get(0),
                ).map_err(|_| "命中段落已失效，请重新检索".to_string())?;
                index.saturating_sub(2)
            } else { input.offset };
            let mut statement = connection.prepare(
                "SELECT c.content_hash, b.title, b.creator, b.language, c.chunk_id, c.spine_index,
                        c.chapter_path, c.chapter_title, c.content_type, c.original_text,
                        c.normalized_text, c.anchor_json
                 FROM chunks c JOIN books b ON b.content_hash=c.content_hash
                 WHERE c.content_hash=?1 AND c.chapter_path=?2
                   AND b.parser_version=?4 AND b.normalizer_version=?5 AND b.chunker_version=?6
                 ORDER BY CAST(json_extract(c.anchor_json, '$.start') AS INTEGER), c.chunk_id
                 LIMIT 9 OFFSET ?3"
            ).map_err(|error| error.to_string())?;
            let rows = statement.query_map(rusqlite::params![hash, input.chapter_path, offset,
                input.parser_version, input.normalizer_version, input.chunker_version],
                super::store::read_search_hit).map_err(|error| error.to_string())?;
            let mut hits = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            let next_offset = (hits.len() > 8).then_some(offset + 8);
            hits.truncate(8);
            Ok(ChapterPage { hits, offset, next_offset })
        })
    }).await.map_err(|error| error.to_string())?
}
