//! Runtime session lifecycle for the native embedding gateway.
//!
//! Owns the process-wide admission and the platform runtime, so a front end
//! that forgets to close a session cannot leave a driver running: every
//! request is validated against the live session ID and the session is
//! disposed through Rust before admission is released.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::embedding::{
    describe, prepare_model, Admission, DeviceReport, EmbeddingError, EmbeddingErrorKind,
    PreparedModel, ProfileDescriptor, Purpose, Session, SessionOwner,
};
use super::{AiState, AiStore};

/// Session identity handed to the front end.  It is opaque and short-lived.
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenInput {
    pub package_id: String,
    /// LUID string from the C-58A hardware report; never an array position.
    pub device_luid: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenReply {
    pub session_id: String,
    pub profile: ProfileDescriptor,
    pub device: DeviceReport,
    pub admission: Admission,
    /// The model package directory relative to the library root, for evidence.
    pub package_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EmbedInput {
    pub session_id: String,
    pub texts: Vec<String>,
    pub purpose: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbedReply {
    pub vectors: Vec<Vec<f64>>,
    /// Token counts per text, including prefix and special tokens.
    pub tokens: Vec<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CountInput {
    pub session_id: String,
    pub texts: Vec<String>,
    pub purpose: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountReply {
    pub tokens: Vec<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionInput {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusReply {
    pub admission: Admission,
    /// The live session identity, if any.  Never a path or a model digest.
    pub session_id: Option<String>,
    pub platform_supported: bool,
}

/// Serialized as a tagged error so the front end can classify without parsing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayError {
    pub kind: EmbeddingErrorKind,
    pub message: String,
}

impl From<EmbeddingError> for GatewayError {
    fn from(error: EmbeddingError) -> Self {
        Self {
            kind: error.kind,
            message: error.message,
        }
    }
}

/// One live session.  `owner` is dropped (and therefore disposes the runtime)
/// before admission is released, so a late cancel can never free a busy driver.
struct Live {
    id: String,
    owner: SessionOwner,
}

#[derive(Default)]
pub(crate) struct EmbeddingState {
    live: Mutex<Option<Live>>,
}

impl EmbeddingState {
    fn with_live<T>(
        &self,
        session_id: &str,
        operation: impl FnOnce(&mut Session) -> Result<T, EmbeddingError>,
    ) -> Result<T, GatewayError> {
        let mut slot = self
            .live
            .lock()
            .map_err(|_| GatewayError::from(EmbeddingError::failed("嵌入会话状态锁已损坏")))?;
        let live = slot
            .as_mut()
            .ok_or_else(|| EmbeddingError::failed("嵌入会话不存在或已关闭"))?;
        if live.id != session_id {
            return Err(EmbeddingError::failed("嵌入会话标识不匹配").into());
        }
        if live.owner.session.is_busy() {
            return Err(EmbeddingError::failed("上一次嵌入计算尚未结束").into());
        }
        operation(&mut live.owner.session).map_err(GatewayError::from)
    }

    fn close(&self, session_id: &str) -> Result<(), GatewayError> {
        let live = {
            let mut slot = self
                .live
                .lock()
                .map_err(|_| GatewayError::from(EmbeddingError::failed("嵌入会话状态锁已损坏")))?;
            match slot.as_ref() {
                None => return Ok(()),
                Some(live) if live.id != session_id => {
                    return Err(EmbeddingError::failed("嵌入会话标识不匹配").into())
                }
                Some(_) => slot.take().expect("checked above"),
            }
        };
        let mut live = live;
        live.owner.dispose().map_err(GatewayError::from)
    }

    fn flag_cancel(&self, session_id: &str) -> Result<(), GatewayError> {
        let slot = self
            .live
            .lock()
            .map_err(|_| GatewayError::from(EmbeddingError::failed("嵌入会话状态锁已损坏")))?;
        let live = slot
            .as_ref()
            .ok_or_else(|| GatewayError::from(EmbeddingError::failed("嵌入会话不存在或已关闭")))?;
        if live.id != session_id {
            return Err(EmbeddingError::failed("嵌入会话标识不匹配").into());
        }
        live.owner.session.cancel();
        Ok(())
    }

    fn session_id(&self) -> Option<String> {
        self.live
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|live| live.id.clone()))
    }
}

/// Narrow seam so tests can drive the lifecycle without a real model package.
trait Opener: Send + Sync {
    fn open(
        &self,
        store: &AiStore,
        input: &OpenInput,
    ) -> Result<(SessionOwner, PreparedModel), EmbeddingError>;
}

struct PlatformOpener;

impl Opener for PlatformOpener {
    fn open(
        &self,
        store: &AiStore,
        input: &OpenInput,
    ) -> Result<(SessionOwner, PreparedModel), EmbeddingError> {
        let (model, guard) = prepare_model(store, &input.package_id)?;
        let (tokenizer, runtime, device) =
            super::embedding_platform::create(&model, input.device_luid.as_deref())?;
        let version = runtime.version();
        // The declared identity is rebuilt from the verified files, so a
        // front end cannot claim a profile the assets do not support.
        let profile = describe(&model, &version)?;
        if let Some(requested) = &input.device_luid {
            if device.luid.as_deref() != Some(requested.as_str()) {
                return Err(EmbeddingError::unsupported(
                    "未能枚举到请求的 GPU（LUID 不匹配），请重新探测设备",
                ));
            }
        }
        let owner = super::embedding::new_session_owner(
            format!("session-{}", NEXT_SESSION.fetch_add(1, Ordering::AcqRel)),
            profile,
            tokenizer,
            runtime,
            device,
            guard,
        )?;
        Ok((owner, model))
    }
}

pub(crate) struct Gateway {
    opener: Box<dyn Opener>,
}

impl Default for Gateway {
    fn default() -> Self {
        Self {
            opener: Box::new(PlatformOpener),
        }
    }
}

impl Gateway {
    fn open(
        &self,
        state: &EmbeddingState,
        store: &AiStore,
        input: OpenInput,
    ) -> Result<OpenReply, GatewayError> {
        // Admission is acquired first so a second open fails before any file
        // access, and so a failed open is reported without leaving a driver.
        let mut slot = state
            .live
            .lock()
            .map_err(|_| GatewayError::from(EmbeddingError::failed("嵌入会话状态锁已损坏")))?;
        if slot.is_some() {
            return Err(EmbeddingError::failed("已有活动的嵌入会话，请先关闭").into());
        }
        let (owner, model) = match self.opener.open(store, &input) {
            Ok(opened) => opened,
            Err(error) => {
                // A failed open must still clean up whatever it created.
                return Err(GatewayError::from(error));
            }
        };
        let reply = OpenReply {
            session_id: owner.session.id.clone(),
            profile: owner.session.profile.clone(),
            device: owner.session.device().clone(),
            admission: Admission::status(),
            package_dir: model.package_dir.clone(),
        };
        *slot = Some(Live {
            id: reply.session_id.clone(),
            owner,
        });
        Ok(reply)
    }

    fn embed(&self, state: &EmbeddingState, input: EmbedInput) -> Result<EmbedReply, GatewayError> {
        let purpose = parse_purpose(&input.purpose)?;
        for text in &input.texts {
            if text.is_empty() || text.len() > MAX_TEXT_BYTES {
                return Err(EmbeddingError::failed("嵌入文本为空或超长").into());
            }
        }
        state.with_live(&input.session_id, |session| {
            let tokens = session.count_tokens(&input.texts, purpose)?;
            let vectors = session.embed(&input.texts, purpose)?;
            Ok(EmbedReply { vectors, tokens })
        })
    }

    fn count(&self, state: &EmbeddingState, input: CountInput) -> Result<CountReply, GatewayError> {
        let purpose = parse_purpose(&input.purpose)?;
        if input.texts.len() > 512 {
            return Err(EmbeddingError::failed("token 统计文本数量越界").into());
        }
        state.with_live(&input.session_id, |session| {
            Ok(CountReply {
                tokens: session.count_tokens(&input.texts, purpose)?,
            })
        })
    }
}

const MAX_TEXT_BYTES: usize = 16 * 1024;

fn parse_purpose(value: &str) -> Result<Purpose, GatewayError> {
    match value {
        "query" => Ok(Purpose::Query),
        "passage" => Ok(Purpose::Passage),
        other => Err(EmbeddingError::unsupported(format!("未知嵌入用途：{other}")).into()),
    }
}

/// Shares the process-wide gateway between the Tauri state and the probe.
pub(crate) struct EmbeddingGatewayState {
    pub(crate) embedding: EmbeddingState,
    pub(crate) gateway: Gateway,
}

impl Default for EmbeddingGatewayState {
    fn default() -> Self {
        Self {
            embedding: EmbeddingState::default(),
            gateway: Gateway::default(),
        }
    }
}

pub(crate) struct SemanticEmbedding(pub(crate) Arc<EmbeddingGatewayState>);

impl Default for SemanticEmbedding {
    fn default() -> Self {
        Self(Arc::new(EmbeddingGatewayState::default()))
    }
}

#[tauri::command]
pub(crate) async fn ai_semantic_open(
    app: AppHandle,
    state: State<'_, AiState>,
    embedding: State<'_, SemanticEmbedding>,
    input: OpenInput,
) -> Result<OpenReply, GatewayError> {
    let store = state.ensure(&app).map_err(EmbeddingError::from)?;
    let embedding = Arc::clone(&embedding.0);
    tauri::async_runtime::spawn_blocking(move || {
        embedding.gateway.open(&embedding.embedding, &store, input)
    })
    .await
    .map_err(|e| EmbeddingError::failed(format!("嵌入会话线程失败：{e}")))?
}

#[tauri::command]
pub(crate) async fn ai_semantic_embed(
    embedding: State<'_, SemanticEmbedding>,
    input: EmbedInput,
) -> Result<EmbedReply, GatewayError> {
    let embedding = Arc::clone(&embedding.0);
    tauri::async_runtime::spawn_blocking(move || {
        embedding.gateway.embed(&embedding.embedding, input)
    })
    .await
    .map_err(|e| GatewayError::from(EmbeddingError::failed(format!("嵌入线程失败：{e}"))))?
}

#[tauri::command]
pub(crate) async fn ai_semantic_count(
    embedding: State<'_, SemanticEmbedding>,
    input: CountInput,
) -> Result<CountReply, GatewayError> {
    let embedding = Arc::clone(&embedding.0);
    tauri::async_runtime::spawn_blocking(move || {
        embedding.gateway.count(&embedding.embedding, input)
    })
    .await
    .map_err(|e| GatewayError::from(EmbeddingError::failed(format!("token 统计线程失败：{e}"))))?
}

/// Requests cancellation.  It never releases admission: a driver that is still
/// running keeps the session, and `close` must confirm disposal afterwards.
#[tauri::command]
pub(crate) fn ai_semantic_cancel(
    embedding: State<'_, SemanticEmbedding>,
    input: SessionInput,
) -> Result<(), GatewayError> {
    embedding.0.embedding.flag_cancel(&input.session_id)
}

#[tauri::command]
pub(crate) fn ai_semantic_close(
    embedding: State<'_, SemanticEmbedding>,
    input: SessionInput,
) -> Result<(), GatewayError> {
    embedding.0.embedding.close(&input.session_id)
}

#[tauri::command]
pub(crate) fn ai_semantic_status(embedding: State<'_, SemanticEmbedding>) -> StatusReply {
    StatusReply {
        admission: Admission::status(),
        session_id: embedding.0.embedding.session_id(),
        platform_supported: cfg!(windows),
    }
}

/// Debug-only evidence probe: opens one real session, embeds a short query and
/// passage with the verified model, and reports identity, device, EP, tokens,
/// vector statistics and timing.  It never writes to the index and never runs
/// in a release build.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProbeInput {
    /// Registered package ID.  When omitted, the only verified ONNX embedding
    /// package in the library is used, so evidence does not depend on the
    /// caller guessing an identity.
    pub package_id: Option<String>,
    pub device_luid: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeReport {
    pub package_dir: String,
    pub profile: ProfileDescriptor,
    pub device: DeviceReport,
    pub admission: Admission,
    pub query_tokens: usize,
    pub passage_tokens: usize,
    /// Scaled preview of the query vector, for comparing against a reference run.
    pub vector_preview: Vec<f64>,
    pub vector_norm: f64,
    pub vector_max_abs: f64,
    /// SHA-256 over the little-endian f32 query vector, for exact comparison
    /// with an independent reference implementation.
    pub vector_digest: String,
    pub elapsed_ms: u64,
    /// SHA-256 of query vs passage cosine, so prefix handling is observable.
    pub query_passage_cosine: f64,
}

/// Debug-only setup helper: points the model library at `library_root`,
/// registers the package found in `package_dir` (a relative directory under
/// that root) and returns the refreshed record.  It exists so the first
/// Windows run can be an audit script instead of manual UI steps; it never
/// downloads anything and never loads a model.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetupInput {
    pub library_root: String,
    pub package_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupReply {
    pub package_id: String,
    pub package_dir: String,
    pub state: String,
    pub format: String,
    pub dimensions: Option<u64>,
    pub max_input: Option<u64>,
    pub files: Vec<String>,
    pub library_root: String,
}

#[tauri::command]
pub(crate) async fn ai_semantic_setup(
    app: AppHandle,
    state: State<'_, AiState>,
    input: SetupInput,
) -> Result<SetupReply, String> {
    if !cfg!(debug_assertions) {
        return Err("模型接入辅助只在 AI 调试版可用".into());
    }
    let store = state.ensure(&app)?;
    let root = PathBuf::from(&input.library_root);
    let info = super::models::model_library_root_info(Some(root.as_path()));
    if !info.exists || !info.is_directory {
        return Err("模型库目录不存在或不是目录".into());
    }
    store.set_model_library_path(&input.library_root)?;
    let relative = input.package_dir.replace('\\', "/");
    let record = super::models::register_package_from_dir(&store, &root, &relative)?;
    Ok(SetupReply {
        package_id: record.package_id,
        package_dir: record.package_dir,
        state: record.state,
        format: record.format,
        dimensions: record.dimensions,
        max_input: record.max_input,
        files: record
            .files
            .iter()
            .map(|file| file.relative_path.clone())
            .collect(),
        library_root: input.library_root,
    })
}

#[tauri::command]
pub(crate) async fn ai_semantic_probe(
    app: AppHandle,
    state: State<'_, AiState>,
    embedding: State<'_, SemanticEmbedding>,
    input: ProbeInput,
) -> Result<ProbeReport, GatewayError> {
    if !cfg!(debug_assertions) {
        return Err(EmbeddingError::unsupported("嵌入探针仅在 AI 调试版可用").into());
    }
    let store = state.ensure(&app).map_err(EmbeddingError::from)?;
    let embedding = Arc::clone(&embedding.0);
    tauri::async_runtime::spawn_blocking(move || probe_once(&embedding, &store, input))
        .await
        .map_err(|e| GatewayError::from(EmbeddingError::failed(format!("嵌入探针线程失败：{e}"))))?
}

/// Picks the single verified ONNX embedding package.  Ambiguity is a refusal,
/// never a silent choice between models with different identities.
fn select_probe_package(store: &AiStore) -> Result<String, GatewayError> {
    let packages = store.list_model_packages().map_err(EmbeddingError::from)?;
    let candidates: Vec<String> = packages
        .into_iter()
        .filter(|package| {
            package.state == "installed"
                && package.format == "onnx"
                && package
                    .capabilities
                    .iter()
                    .any(|value| value == "embedding")
        })
        .map(|package| package.package_id)
        .collect();
    match candidates.len() {
        1 => Ok(candidates[0].clone()),
        0 => Err(EmbeddingError::asset("模型库中没有已验证的 ONNX 嵌入模型包").into()),
        _ => Err(EmbeddingError::unsupported(format!(
            "模型库中有多个候选嵌入模型（{}），请在探针中指定 packageId",
            candidates.join(", ")
        ))
        .into()),
    }
}

fn probe_once(
    embedding: &EmbeddingGatewayState,
    store: &AiStore,
    input: ProbeInput,
) -> Result<ProbeReport, GatewayError> {
    let text = input
        .text
        .clone()
        .unwrap_or_else(|| "本地语义检索探针：这句话用于验证真实模型输出。".to_string());
    let package_id = match input.package_id.clone() {
        Some(value) => value,
        None => select_probe_package(store)?,
    };
    let opened = embedding.gateway.open(
        &embedding.embedding,
        store,
        OpenInput {
            package_id,
            device_luid: input.device_luid.clone(),
        },
    )?;
    let started = std::time::Instant::now();
    let query = embedding.gateway.embed(
        &embedding.embedding,
        EmbedInput {
            session_id: opened.session_id.clone(),
            texts: vec![text.clone()],
            purpose: "query".to_string(),
        },
    )?;
    let passage = embedding.gateway.embed(
        &embedding.embedding,
        EmbedInput {
            session_id: opened.session_id.clone(),
            texts: vec![text.clone()],
            purpose: "passage".to_string(),
        },
    )?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    // Disposal must complete before the report is returned.
    embedding.embedding.close(&opened.session_id)?;
    let vector = query
        .vectors
        .first()
        .ok_or_else(|| GatewayError::from(EmbeddingError::failed("探针未取得查询向量")))?;
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    let max_abs = vector.iter().fold(0f64, |acc, value| acc.max(value.abs()));
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    for value in vector {
        <sha2::Sha256 as sha2::Digest>::update(&mut hasher, (*value as f32).to_le_bytes());
    }
    let vector_digest = format!("{:x}", <sha2::Sha256 as sha2::Digest>::finalize(hasher));
    let other = passage
        .vectors
        .first()
        .ok_or_else(|| GatewayError::from(EmbeddingError::failed("探针未取得段落向量")))?;
    let cosine = vector
        .iter()
        .zip(other.iter())
        .map(|(a, b)| a * b)
        .sum::<f64>()
        .clamp(-1.0, 1.0);
    Ok(ProbeReport {
        package_dir: opened.package_dir,
        profile: opened.profile,
        device: opened.device,
        admission: Admission::status(),
        query_tokens: query.tokens.first().copied().unwrap_or(0),
        passage_tokens: passage.tokens.first().copied().unwrap_or(0),
        vector_preview: vector.iter().take(8).copied().collect(),
        vector_norm: norm,
        vector_max_abs: max_abs,
        vector_digest,
        elapsed_ms,
        query_passage_cosine: cosine,
    })
}
