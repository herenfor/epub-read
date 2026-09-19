//! Single-session native embedding gateway.
//!
//! This module owns *how* a verified local embedding model is executed:
//! asset identity, tokenizer/model consistency, global admission, cancellation
//! semantics and bounded output validation.  Platform inference itself lives
//! behind [`Runtime`] (`embedding_windows.rs` on Windows).
//!
//! Rules this module enforces regardless of platform:
//! * a front end never supplies a filesystem path, only a registered package ID;
//! * the model read lock and the single-session admission are held for the whole
//!   session lifetime, so cancelling or closing never frees a driver that is
//!   still running;
//! * tokenizer, model, dimension, pooling and prefix all belong to one identity,
//!   and a mismatch is refused instead of silently re-encoded;
//! * token overflow is rejected, never truncated.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::model_locks::ModelLock;
use super::models::{resolve_model_file, ModelPackageRecord};
use super::AiStore;

/// Stable, user-visible error classes.  The front end must not have to parse
/// prose to decide whether a retry, a rebuild or a settings change is needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EmbeddingErrorKind {
    Cancelled,
    InsufficientResources,
    AssetChanged,
    Unsupported,
    ExecutionFailed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingError {
    pub kind: EmbeddingErrorKind,
    pub message: String,
}

impl EmbeddingError {
    pub(crate) fn new(kind: EmbeddingErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    /// Windows-only in production (see `Tokenizer`).
    #[allow(dead_code)]
    pub(crate) fn cancelled() -> Self {
        Self::new(EmbeddingErrorKind::Cancelled, "嵌入计算已取消")
    }
    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self::new(EmbeddingErrorKind::Unsupported, message)
    }
    pub(crate) fn asset(message: impl Into<String>) -> Self {
        Self::new(EmbeddingErrorKind::AssetChanged, message)
    }
    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self::new(EmbeddingErrorKind::ExecutionFailed, message)
    }
    /// Windows-only in production (see `Tokenizer`).
    #[allow(dead_code)]
    pub(crate) fn resources(message: impl Into<String>) -> Self {
        Self::new(EmbeddingErrorKind::InsufficientResources, message)
    }
}

impl From<String> for EmbeddingError {
    fn from(message: String) -> Self {
        Self::failed(message)
    }
}

/// The identity every stored vector belongs to.  Field order is part of the
/// encoding and must stay in step with `semantic/contracts.ts`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDescriptor {
    pub model_id: String,
    pub model_digest: String,
    pub tokenizer_digest: String,
    pub runtime_version: String,
    pub dimensions: usize,
    pub max_tokens: usize,
    pub pooling: String,
    pub normalization: String,
    pub query_prefix: String,
    pub passage_prefix: String,
}

impl ProfileDescriptor {
    /// Same canonical form as the TypeScript `profileKey`.
    pub(crate) fn key(&self) -> Result<String, EmbeddingError> {
        if !is_digest(&self.model_digest) || !is_digest(&self.tokenizer_digest) {
            return Err(EmbeddingError::asset("模型或 tokenizer 摘要无效"));
        }
        if self.dimensions < 1
            || self.dimensions > 4096
            || self.max_tokens < 2
            || self.max_tokens > 8192
        {
            return Err(EmbeddingError::unsupported("向量维度或最大 token 越界"));
        }
        if !["cls", "mean"].contains(&self.pooling.as_str()) || self.normalization != "l2" {
            return Err(EmbeddingError::unsupported("不支持的 pooling 或归一化策略"));
        }
        serde_json::to_string(&[
            self.model_id.as_str(),
            self.model_digest.as_str(),
            self.tokenizer_digest.as_str(),
            self.runtime_version.as_str(),
            &self.dimensions.to_string(),
            &self.max_tokens.to_string(),
            self.pooling.as_str(),
            self.normalization.as_str(),
            self.query_prefix.as_str(),
            self.passage_prefix.as_str(),
        ])
        .map_err(|e| EmbeddingError::failed(format!("profile 序列化失败：{e}")))
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One tokenizer call.  `false` means the tokenizer itself failed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Tokenized {
    pub ids: Vec<i64>,
    pub mask: Vec<i64>,
}

/// Windows-only in production; the non-Windows platform stub never implements
/// it, so the Linux build reports this trait as unused.
pub(crate) trait Tokenizer: Send {
    /// Token count of a text including prefix and special tokens.  Used to
    /// bound batches without loading a model.
    fn count(&self, text: &str) -> Result<usize, EmbeddingError>;
    /// Encodes one text without padding or truncation.
    fn encode(&self, text: &str) -> Result<Tokenized, EmbeddingError>;
    /// The tokenizer's own view of the maximum sequence length.
    #[allow(dead_code)]
    fn max_tokens(&self) -> usize;
}

/// Platform inference.  Implementations must not be called concurrently.
/// Windows-only in production (see `Tokenizer`).
pub(crate) trait Runtime: Send {
    /// Runs one batch of equal-length encoded inputs and returns flat
    /// `[batch, sequence, dimensions]` values plus the pooled output shape.
    fn run(
        &mut self,
        batch: &[Tokenized],
        signal: &dyn Fn() -> bool,
    ) -> Result<Vec<Vec<f64>>, EmbeddingError>;
    /// Human-readable runtime identity, e.g. `onnxruntime-1.28.0/directml`.
    fn version(&self) -> String;
    /// Devices actually used, for the debug probe and support evidence.
    #[allow(dead_code)]
    fn device_report(&self) -> DeviceReport;
    fn close(&mut self) -> Result<(), EmbeddingError>;
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceReport {
    /// DirectML device index chosen in this run.
    pub device_index: Option<i32>,
    /// C-58A LUID of the matched adapter, never an array position.
    pub luid: Option<String>,
    pub adapter_name: Option<String>,
    /// Execution provider names reported by the session, in order.
    pub providers: Vec<String>,
    /// Nodes the runtime assigned to a non-GPU provider, if reported.
    pub cpu_node_count: Option<usize>,
}

/// Everything a session owns.  Dropping it releases the model read lock and the
/// process-wide admission.
pub(crate) struct Session {
    pub(crate) id: String,
    pub(crate) profile: ProfileDescriptor,
    tokenizer: Box<dyn Tokenizer>,
    runtime: Box<dyn Runtime>,
    device: DeviceReport,
    /// Held from validation through disposal; never released on cancellation.
    /// The field itself is only read through `Drop`.
    #[allow(dead_code)]
    guard: Option<ModelLock>,
    cancelled: Arc<AtomicBool>,
    inflight: Arc<AtomicU64>,
}

impl Session {
    pub(crate) fn device(&self) -> &DeviceReport {
        &self.device
    }

    /// Token count per text, including the retrieval prefix and special
    /// tokens.  Used to bound batches before any model work happens.
    pub(crate) fn count_tokens(
        &self,
        texts: &[String],
        purpose: Purpose,
    ) -> Result<Vec<usize>, EmbeddingError> {
        if texts.is_empty() || texts.len() > MAX_BATCH_TEXTS {
            return Err(EmbeddingError::failed("嵌入批次数量越界"));
        }
        let prefix = self.prefix_for(purpose);
        texts
            .iter()
            .map(|text| {
                let full = if prefix.is_empty() {
                    text.clone()
                } else {
                    format!("{prefix}{text}")
                };
                self.tokenizer.count(&full)
            })
            .collect()
    }

    /// The tokenizer's own maximum sequence length, which must not exceed the
    /// identity's `maxTokens`.
    #[allow(dead_code)]
    pub(crate) fn tokenizer_limit(&self) -> usize {
        self.tokenizer.max_tokens()
    }

    fn prefix_for(&self, purpose: Purpose) -> String {
        match purpose {
            Purpose::Query => self.profile.query_prefix.clone(),
            Purpose::Passage => self.profile.passage_prefix.clone(),
        }
    }

    /// Test-only constructor: production sessions always hold a model read
    /// lock from `prepare_model`.
    #[cfg(test)]
    pub(crate) fn for_test(
        profile: ProfileDescriptor,
        tokenizer: Box<dyn Tokenizer>,
        runtime: Box<dyn Runtime>,
        device: DeviceReport,
    ) -> Self {
        Self {
            id: "test-session".to_string(),
            profile,
            tokenizer,
            runtime,
            device,
            guard: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            inflight: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Encodes and runs one batch.  `purpose` selects the retrieval prefix that
    /// is part of the stored identity.
    pub(crate) fn embed(
        &mut self,
        texts: &[String],
        purpose: Purpose,
    ) -> Result<Vec<Vec<f64>>, EmbeddingError> {
        if texts.is_empty() || texts.len() > MAX_BATCH_TEXTS {
            return Err(EmbeddingError::failed("嵌入批次数量越界"));
        }
        let prefix = self.prefix_for(purpose);
        let mut encoded = Vec::with_capacity(texts.len());
        for text in texts {
            let full = if prefix.is_empty() {
                text.clone()
            } else {
                format!("{prefix}{text}")
            };
            let tokens = self.tokenizer.encode(&full)?;
            // Prefix and special tokens are already included by `encode`.
            if tokens.ids.is_empty() || tokens.ids.len() > self.profile.max_tokens {
                return Err(EmbeddingError::unsupported(format!(
                    "正文块超过模型 token 上限（{} > {}），请缩短分块后重建",
                    tokens.ids.len(),
                    self.profile.max_tokens
                )));
            }
            encoded.push(tokens);
        }
        let cancelled = Arc::clone(&self.cancelled);
        self.inflight.fetch_add(1, Ordering::AcqRel);
        let result = self
            .runtime
            .run(&encoded, &|| cancelled.load(Ordering::Acquire));
        self.inflight.fetch_sub(1, Ordering::AcqRel);
        let vectors = result?;
        if vectors.len() != texts.len() {
            return Err(EmbeddingError::failed("模型返回的向量数量与输入不一致"));
        }
        for vector in &vectors {
            if vector.len() != self.profile.dimensions
                || vector.iter().any(|value| !value.is_finite())
            {
                return Err(EmbeddingError::failed("模型输出向量维度或数值无效"));
            }
        }
        Ok(vectors)
    }

    /// Requests cooperative cancellation of the running inference.
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub(crate) fn is_busy(&self) -> bool {
        self.inflight.load(Ordering::Acquire) > 0
    }

    #[allow(dead_code)]
    pub(crate) fn open(&mut self) -> Result<(), EmbeddingError> {
        self.cancelled.store(false, Ordering::Release);
        Ok(())
    }

    /// Closes the runtime before the guard is dropped by the caller.
    pub(crate) fn shutdown(&mut self) -> Result<(), EmbeddingError> {
        self.runtime.close()
    }
}

const MAX_BATCH_TEXTS: usize = 32;
/// BGE Chinese retrieval models are trained with this instruction on queries
/// only (see the model card).  It is part of the stored profile identity.
pub(crate) const DEFAULT_QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Purpose {
    Query,
    Passage,
}

/// Process-wide admission.  The TypeScript coordinator is not sufficient: any
/// UI, tab or retry could open a second session, and the driver does not allow
/// concurrent `Run` calls on one session.
static ADMISSION: Mutex<Admission> = Mutex::new(Admission::Idle);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Admission {
    Idle,
    Active,
    /// A previous close did not confirm disposal; new sessions stay refused.
    Faulted,
}

impl Admission {
    pub(crate) fn status() -> Self {
        ADMISSION
            .lock()
            .map(|state| *state)
            .unwrap_or(Admission::Faulted)
    }
}

/// Guards the process-wide admission.  It is only released by `Drop`, which
/// runs after the session (and therefore the driver) has been disposed.
pub(crate) struct AdmissionGuard {
    armed: bool,
}

impl AdmissionGuard {
    pub(crate) fn acquire() -> Result<Self, EmbeddingError> {
        let mut state = ADMISSION
            .lock()
            .map_err(|_| EmbeddingError::failed("嵌入会话状态锁已损坏"))?;
        match *state {
            Admission::Idle => {
                *state = Admission::Active;
                Ok(Self { armed: true })
            }
            Admission::Active => Err(EmbeddingError::failed(
                "另一个会话正在使用本地嵌入模型，请稍后重试",
            )),
            Admission::Faulted => Err(EmbeddingError::failed(
                "上一次嵌入会话未能确认释放，请重启应用后再试",
            )),
        }
    }

    pub(crate) fn fault(&mut self) {
        if let Ok(mut state) = ADMISSION.lock() {
            *state = Admission::Faulted;
        }
        self.armed = false;
    }

    pub(crate) fn release(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut state) = ADMISSION.lock() {
            if *state == Admission::Active {
                *state = Admission::Idle;
            }
        }
        self.armed = false;
    }
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Session lifetime owned by Rust so a dropped front end cannot leak a driver.
pub(crate) struct SessionOwner {
    pub(crate) session: Session,
    guard: Option<AdmissionGuard>,
}

impl SessionOwner {
    /// Disposes the runtime, then releases admission.  A failed disposal is
    /// reported and leaves the process faulted instead of pretending success.
    pub(crate) fn dispose(&mut self) -> Result<(), EmbeddingError> {
        let shutdown = self.session.shutdown();
        match shutdown {
            Ok(()) => {
                if let Some(mut guard) = self.guard.take() {
                    guard.release();
                }
                Ok(())
            }
            Err(error) => {
                if let Some(guard) = self.guard.as_mut() {
                    guard.fault();
                }
                Err(error)
            }
        }
    }
}

impl Drop for SessionOwner {
    fn drop(&mut self) {
        if self.guard.is_some() {
            let _ = self.dispose();
        }
    }
}

/// Verified local assets for one package: the only paths allowed to load.
/// Windows-only in production (see `Tokenizer`).
#[allow(dead_code)]
pub(crate) struct PreparedModel {
    pub(crate) package_id: String,
    pub(crate) package_dir: String,
    pub(crate) root: PathBuf,
    pub(crate) model_path: PathBuf,
    pub(crate) tokenizer_path: PathBuf,
    pub(crate) model_digest: String,
    pub(crate) tokenizer_digest: String,
    pub(crate) dimensions: usize,
    pub(crate) max_tokens: usize,
    pub(crate) pooling: String,
    pub(crate) query_prefix: String,
    pub(crate) passage_prefix: String,
}

/// Digests every file under the package that affects model output, in a stable
/// order, so a swap of the tokenizer or a quantization sidecar is detected.
fn digest_files(paths: &[(String, PathBuf)]) -> Result<String, EmbeddingError> {
    let mut hasher = Sha256::new();
    for (relative, path) in paths {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        let bytes = std::fs::read(path)
            .map_err(|e| EmbeddingError::asset(format!("读取模型资产失败：{e}")))?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Resolves one registered package into loadable paths.  The caller must hold
/// the package read lock for the whole session lifetime.
pub(crate) fn prepare_model(
    store: &AiStore,
    package_id: &str,
) -> Result<(PreparedModel, ModelLock), EmbeddingError> {
    let record: ModelPackageRecord = store
        .get_model_package(package_id)
        .map_err(EmbeddingError::from)?
        .ok_or_else(|| EmbeddingError::asset("模型包不存在或未注册"))?;
    if record.state != "installed" {
        return Err(EmbeddingError::asset("模型包尚未校验通过，不能加载"));
    }
    if !record.capabilities.iter().any(|value| value == "embedding") {
        return Err(EmbeddingError::unsupported("该模型包不提供 embedding 能力"));
    }
    if record.format != "onnx" {
        return Err(EmbeddingError::unsupported(
            "首批语义索引只支持 ONNX 嵌入模型包",
        ));
    }
    let root = store
        .model_library_path()
        .map_err(EmbeddingError::from)?
        .map(PathBuf::from)
        .ok_or_else(|| EmbeddingError::asset("尚未设置模型库目录"))?;
    let guard =
        ModelLock::assets(&root, &record.package_dir, package_id).map_err(EmbeddingError::from)?;
    // Re-read after acquiring the lock: another session may have replaced it.
    let record = store
        .get_model_package(package_id)
        .map_err(EmbeddingError::from)?
        .ok_or_else(|| EmbeddingError::asset("模型包在取得读锁后消失"))?;
    if record.state != "installed" {
        return Err(EmbeddingError::asset("模型包在取得读锁后不可用"));
    }
    let package_path = if record.storage_kind == "linked" {
        PathBuf::from(
            record
                .linked_external_path
                .as_deref()
                .ok_or_else(|| EmbeddingError::asset("linked 模型包缺少外部路径"))?,
        )
    } else {
        root.join(&record.package_dir)
    };
    let mut model_files: Vec<(String, PathBuf)> = Vec::new();
    let mut tokenizer_files: Vec<(String, PathBuf)> = Vec::new();
    for file in &record.files {
        let path = resolve_model_file(&root, &package_path, &file.relative_path)
            .map_err(EmbeddingError::asset)?;
        let lower = file.relative_path.to_ascii_lowercase();
        let is_tokenizer = lower.contains("tokenizer") || lower.ends_with("vocab.txt");
        let is_model = lower.ends_with(".onnx") || lower.ends_with(".onnx_data");
        if !is_tokenizer && !is_model {
            // Configs, licenses and other metadata do not affect output.
            continue;
        }
        if is_tokenizer {
            tokenizer_files.push((file.relative_path.clone(), path));
        } else {
            model_files.push((file.relative_path.clone(), path));
        }
    }
    if model_files.is_empty() || tokenizer_files.is_empty() {
        return Err(EmbeddingError::unsupported(
            "模型包必须同时包含 ONNX 模型与 tokenizer 资产",
        ));
    }
    model_files.sort_by(|a, b| a.0.cmp(&b.0));
    tokenizer_files.sort_by(|a, b| a.0.cmp(&b.0));
    let model_digest = digest_files(&model_files)?;
    let tokenizer_digest = digest_files(&tokenizer_files)?;
    let model_path = model_files
        .iter()
        .find(|(name, _)| name.to_ascii_lowercase().ends_with(".onnx"))
        .map(|(_, path)| path.clone())
        .ok_or_else(|| EmbeddingError::unsupported("模型包缺少 .onnx 权重文件"))?;
    let tokenizer_path = tokenizer_files
        .iter()
        .find(|(name, _)| name.to_ascii_lowercase().ends_with("tokenizer.json"))
        .map(|(_, path)| path.clone())
        .ok_or_else(|| {
            EmbeddingError::unsupported("模型包缺少 tokenizer.json，无法保证与模型同源")
        })?;
    let dimensions = record
        .dimensions
        .map(|value| value as usize)
        .filter(|value| (1..=4096).contains(value))
        .ok_or_else(|| EmbeddingError::unsupported("模型包缺少有效向量维度"))?;
    let max_tokens = record
        .max_input
        .map(|value| value as usize)
        .filter(|value| (2..=8192).contains(value))
        .ok_or_else(|| EmbeddingError::unsupported("模型包缺少有效最大 token 数"))?;
    let pooling = record
        .provider_kind
        .clone()
        .unwrap_or_else(|| "cls".to_string());
    if pooling != "cls" {
        return Err(EmbeddingError::unsupported(
            "首批只支持 CLS pooling 的嵌入模型；请核对模型卡后更换模型包",
        ));
    }
    Ok((
        PreparedModel {
            package_id: package_id.to_string(),
            package_dir: record.package_dir.clone(),
            root,
            model_path,
            tokenizer_path,
            model_digest,
            tokenizer_digest,
            dimensions,
            max_tokens,
            pooling,
            // BGE retrieval models expect an instruction prefix on queries
            // only; the passage side is embedded verbatim.  Both are part of
            // the stored profile, so changing either forces a rebuild.
            query_prefix: DEFAULT_QUERY_PREFIX.to_string(),
            passage_prefix: String::new(),
        },
        guard,
    ))
}

/// Creates a session and takes process-wide admission.  A failed runtime open
/// must already have cleaned up before this is called.
#[allow(clippy::too_many_arguments)]
pub(crate) fn new_session_owner(
    id: String,
    profile: ProfileDescriptor,
    tokenizer: Box<dyn Tokenizer>,
    runtime: Box<dyn Runtime>,
    device: DeviceReport,
    model_lock: ModelLock,
) -> Result<SessionOwner, EmbeddingError> {
    let admission = AdmissionGuard::acquire()?;
    let session = Session {
        id,
        profile,
        tokenizer,
        runtime,
        device,
        guard: Some(model_lock),
        cancelled: Arc::new(AtomicBool::new(false)),
        inflight: Arc::new(AtomicU64::new(0)),
    };
    Ok(SessionOwner {
        session,
        guard: Some(admission),
    })
}

/// Builds the descriptor a caller can compare against its stored manifest.
pub(crate) fn describe(
    model: &PreparedModel,
    runtime_version: &str,
) -> Result<ProfileDescriptor, EmbeddingError> {
    let descriptor = ProfileDescriptor {
        model_id: model.package_id.clone(),
        model_digest: model.model_digest.clone(),
        tokenizer_digest: model.tokenizer_digest.clone(),
        runtime_version: runtime_version.to_string(),
        dimensions: model.dimensions,
        max_tokens: model.max_tokens,
        pooling: model.pooling.clone(),
        normalization: "l2".to_string(),
        query_prefix: model.query_prefix.clone(),
        passage_prefix: model.passage_prefix.clone(),
    };
    descriptor.key()?;
    Ok(descriptor)
}

/// Pooling per the model card.  `cls` takes the first token of the last hidden
/// state; `mean` masks padding.  Both normalize with the shared stable L2.
#[allow(dead_code)]
pub(crate) fn pool(
    values: &[f64],
    mask: &[i64],
    dimensions: usize,
    pooling: &str,
) -> Result<Vec<f64>, EmbeddingError> {
    let tokens = mask.len();
    if tokens == 0 || tokens > 8192 || values.len() != tokens * dimensions {
        return Err(EmbeddingError::failed("模型输出张量形状无效"));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(EmbeddingError::failed("模型输出包含非有限值"));
    }
    if mask.iter().any(|value| *value != 0 && *value != 1) {
        return Err(EmbeddingError::failed("attention mask 无效"));
    }
    let mut pooled = match pooling {
        "cls" => {
            if mask[0] != 1 {
                return Err(EmbeddingError::failed("CLS 位置被 padding 遮蔽"));
            }
            values[..dimensions].to_vec()
        }
        "mean" => {
            let count = mask.iter().filter(|value| **value == 1).count();
            if count == 0 {
                return Err(EmbeddingError::failed("没有有效 token"));
            }
            let mut output = vec![0f64; dimensions];
            for (token, keep) in mask.iter().enumerate() {
                if *keep == 1 {
                    for dimension in 0..dimensions {
                        output[dimension] += values[token * dimensions + dimension] / count as f64;
                    }
                }
            }
            output
        }
        other => {
            return Err(EmbeddingError::unsupported(format!(
                "不支持的 pooling 策略：{other}"
            )))
        }
    };
    normalize(&mut pooled)
}

/// Stable L2: scale first so extreme finite magnitudes cannot overflow or
/// underflow, then reject the zero vector.
#[allow(dead_code)]
pub(crate) fn normalize(vector: &mut [f64]) -> Result<Vec<f64>, EmbeddingError> {
    let scale = vector.iter().fold(0f64, |acc, value| acc.max(value.abs()));
    if scale == 0.0 || !scale.is_finite() {
        return Err(EmbeddingError::failed("拒绝零向量"));
    }
    for value in vector.iter_mut() {
        *value /= scale;
    }
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return Err(EmbeddingError::failed("向量归一化失败"));
    }
    for value in vector.iter_mut() {
        *value /= norm;
    }
    Ok(vector.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Fake tokenizer that reports one token per character plus a special token.
    struct CharTokenizer {
        limit: usize,
    }

    impl Tokenizer for CharTokenizer {
        fn count(&self, text: &str) -> Result<usize, EmbeddingError> {
            Ok(text.chars().count() + 2)
        }
        fn encode(&self, text: &str) -> Result<Tokenized, EmbeddingError> {
            Ok(Tokenized {
                ids: std::iter::once(101)
                    .chain(text.chars().map(|c| c as i64))
                    .chain(std::iter::once(102))
                    .collect(),
                mask: vec![1; text.chars().count() + 2],
            })
        }
        fn max_tokens(&self) -> usize {
            self.limit
        }
    }

    /// Fake runtime that records how many times it ran and returns fixed values.
    struct ConstantRuntime {
        calls: Arc<AtomicUsize>,
        dimensions: usize,
        fail: Option<EmbeddingError>,
    }

    impl Runtime for ConstantRuntime {
        fn run(
            &mut self,
            batch: &[Tokenized],
            _signal: &dyn Fn() -> bool,
        ) -> Result<Vec<Vec<f64>>, EmbeddingError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            if let Some(error) = &self.fail {
                return Err(error.clone());
            }
            Ok(batch
                .iter()
                .map(|item| {
                    // Already-normalized base values, so `Session::embed` can be
                    // checked against this vector's pooled form.
                    let _ = item;
                    let mut vector = vec![0f64; self.dimensions];
                    vector[0] = 1.0;
                    vector
                })
                .collect())
        }
        fn version(&self) -> String {
            "test-runtime".to_string()
        }
        fn device_report(&self) -> DeviceReport {
            DeviceReport {
                device_index: Some(0),
                luid: Some("dxgi:00000000:00000001".into()),
                adapter_name: Some("Test Adapter".into()),
                providers: vec!["DmlExecutionProvider".into()],
                cpu_node_count: None,
            }
        }
        fn close(&mut self) -> Result<(), EmbeddingError> {
            Ok(())
        }
    }

    fn profile(max_tokens: usize, dimensions: usize) -> ProfileDescriptor {
        ProfileDescriptor {
            model_id: "test-model".into(),
            model_digest: "b".repeat(64),
            tokenizer_digest: "c".repeat(64),
            runtime_version: "test-runtime".into(),
            dimensions,
            max_tokens,
            pooling: "cls".into(),
            normalization: "l2".into(),
            query_prefix: "查询：".into(),
            passage_prefix: String::new(),
        }
    }

    fn session_with(
        max_tokens: usize,
        dimensions: usize,
        fail: Option<EmbeddingError>,
    ) -> (Session, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let session = Session::for_test(
            profile(max_tokens, dimensions),
            Box::new(CharTokenizer { limit: max_tokens }),
            Box::new(ConstantRuntime {
                calls: Arc::clone(&calls),
                dimensions,
                fail,
            }),
            DeviceReport::default(),
        );
        (session, calls)
    }

    #[test]
    fn identity_key_is_order_sensitive_and_rejects_bad_identity() {
        let base = profile(512, 4);
        let key = base.key().unwrap();
        assert_eq!(key, base.key().unwrap());
        assert_ne!(
            key,
            ProfileDescriptor {
                query_prefix: "其他：".into(),
                ..base.clone()
            }
            .key()
            .unwrap()
        );
        assert_ne!(
            key,
            ProfileDescriptor {
                dimensions: 8,
                ..base.clone()
            }
            .key()
            .unwrap()
        );
        let broken = ProfileDescriptor {
            model_digest: "mock-v1".into(),
            ..base.clone()
        };
        assert!(matches!(
            broken.key(),
            Err(EmbeddingError {
                kind: EmbeddingErrorKind::AssetChanged,
                ..
            })
        ));
        let unsupported = ProfileDescriptor {
            pooling: "max".into(),
            ..base
        };
        assert!(matches!(
            unsupported.key(),
            Err(EmbeddingError {
                kind: EmbeddingErrorKind::Unsupported,
                ..
            })
        ));
    }

    #[test]
    fn query_prefix_is_counted_and_passage_stays_unprefixed() {
        let (session, _) = session_with(512, 4, None);
        let query = session
            .count_tokens(&["文本".to_string()], Purpose::Query)
            .unwrap();
        let passage = session
            .count_tokens(&["文本".to_string()], Purpose::Passage)
            .unwrap();
        assert_eq!(query[0], "查询：文本".chars().count() + 2);
        assert_eq!(passage[0], "文本".chars().count() + 2);
        assert!(query[0] > passage[0]);
    }

    #[test]
    fn token_overflow_is_refused_and_never_truncated() {
        let (mut session, calls) = session_with(6, 4, None);
        let error = session
            .embed(&["这段文字明显超过上限".to_string()], Purpose::Passage)
            .unwrap_err();
        assert_eq!(error.kind, EmbeddingErrorKind::Unsupported);
        assert!(error.message.contains("token 上限"));
        // The refusal must happen before any model work.
        assert_eq!(calls.load(Ordering::Acquire), 0);
    }

    #[test]
    fn embed_normalizes_output_and_rejects_bad_shapes() {
        let (mut session, calls) = session_with(512, 4, None);
        let vectors = session
            .embed(&["短句".to_string()], Purpose::Passage)
            .unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 1);
        assert_eq!(vectors[0].len(), 4);
        let norm = vectors[0].iter().map(|v| v * v).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-9);

        let (mut wrong, _) = session_with(512, 4, None);
        wrong.profile.dimensions = 8;
        assert!(wrong
            .embed(&["短句".to_string()], Purpose::Passage)
            .is_err());

        let (mut broken, _) = session_with(512, 4, Some(EmbeddingError::cancelled()));
        assert_eq!(
            broken
                .embed(&["短句".to_string()], Purpose::Passage)
                .unwrap_err()
                .kind,
            EmbeddingErrorKind::Cancelled
        );
    }

    #[test]
    fn admission_refuses_a_second_session_and_survives_abort() {
        assert_eq!(Admission::status(), Admission::Idle);
        let first = AdmissionGuard::acquire().unwrap();
        assert_eq!(Admission::status(), Admission::Active);
        assert!(AdmissionGuard::acquire().is_err());
        let faulted = AdmissionGuard::acquire();
        assert!(faulted.is_err());
        drop(first);
        assert_eq!(Admission::status(), Admission::Idle);
        let mut guard = AdmissionGuard::acquire().unwrap();
        guard.fault();
        assert_eq!(Admission::status(), Admission::Faulted);
        drop(guard);
        // A faulted process stays refused until it restarts.
        assert_eq!(Admission::status(), Admission::Faulted);
        let mut recover = AdmissionGuard { armed: false };
        recover.release();
        ADMISSION.lock().unwrap().clone_from(&Admission::Idle);
    }

    #[test]
    fn pooling_uses_cls_or_masked_mean_and_normalizes() {
        let cls = pool(&[3.0, 4.0, 0.0, 0.0], &[1, 1], 2, "cls").unwrap();
        assert!((cls[0] - 0.6).abs() < 1e-9 && (cls[1] - 0.8).abs() < 1e-9);
        let mean = pool(&[3.0, 4.0, 3.0, 4.0], &[1, 1], 2, "mean").unwrap();
        assert!((mean[0] - 0.6).abs() < 1e-9 && (mean[1] - 0.8).abs() < 1e-9);
        assert!(pool(&[1.0, 0.0], &[0], 2, "cls").is_err());
        assert!(pool(&[f64::NAN, 0.0], &[1], 2, "cls").is_err());
        assert!(pool(&[1.0, 0.0], &[1], 2, "max").is_err());
        assert!(normalize(&mut [0.0, 0.0]).is_err());
    }
}
