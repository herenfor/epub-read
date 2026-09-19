//! Windows ONNX Runtime DirectML runtime.
//!
//! Scope for the first validated path: one Microsoft ONNX Runtime build with
//! the DirectML execution provider, one session at a time, no CPU fallback and
//! no silent truncation.  The ONNX Runtime build is pinned by `ort-sys` in
//! `Cargo.lock` (hash-verified download); `DirectML.dll` is copied next to the
//! executable by `copy-dylibs`.

use ort::session::Session as OrtSession;
use ort::value::Tensor;
use tokenizers::Tokenizer as HfTokenizer;

// Included through `embedding_platform/platform_windows.rs`, so the crate
// modules are reached by absolute path rather than `super`.
use crate::ai::embedding::{
    DeviceReport, EmbeddingError, PreparedModel, Runtime, Tokenized, Tokenizer,
};

pub(crate) struct FileTokenizer {
    inner: HfTokenizer,
    max_tokens: usize,
}

impl Tokenizer for FileTokenizer {
    fn count(&self, text: &str) -> Result<usize, EmbeddingError> {
        self.inner
            .encode(text, true)
            .map(|encoding| encoding.get_ids().len())
            .map_err(|e| EmbeddingError::failed(format!("tokenizer 编码失败：{e}")))
    }

    fn encode(&self, text: &str) -> Result<Tokenized, EmbeddingError> {
        let encoding = self
            .inner
            .encode(text, true)
            .map_err(|e| EmbeddingError::failed(format!("tokenizer 编码失败：{e}")))?;
        Ok(Tokenized {
            ids: encoding.get_ids().iter().map(|id| *id as i64).collect(),
            mask: encoding
                .get_attention_mask()
                .iter()
                .map(|m| *m as i64)
                .collect(),
        })
    }

    fn max_tokens(&self) -> usize {
        self.max_tokens
    }
}

/// Builds the tokenizer and DirectML runtime for one verified model package.
pub(crate) fn create(
    model: &PreparedModel,
    device_luid: Option<&str>,
) -> Result<(Box<dyn Tokenizer>, Box<dyn Runtime>, DeviceReport), EmbeddingError> {
    let tokenizer = HfTokenizer::from_file(&model.tokenizer_path).map_err(|e| {
        EmbeddingError::asset(format!("tokenizer.json 无法解析，模型包不可用：{e}"))
    })?;
    // The tokenizer's own truncation setting must not silently shorten input.
    let tokenizer_limit = tokenizer
        .get_truncation()
        .map(|params| params.max_length)
        .unwrap_or(model.max_tokens)
        .min(model.max_tokens);
    if tokenizer_limit < 2 {
        return Err(EmbeddingError::unsupported("tokenizer 最大长度无效"));
    }
    let runtime = OnnxRuntime::open(model, device_luid, tokenizer_limit)?;
    let device = runtime.device_report();
    let boxed = FileTokenizer {
        inner: tokenizer,
        max_tokens: tokenizer_limit,
    };
    Ok((Box::new(boxed), Box::new(runtime), device))
}

/// `onnxruntime-<version>+directml`, where the version comes from the runtime
/// build string (`rel-1.28.0`, ...) rather than a hand-written constant.
fn runtime_identity() -> String {
    let info = ort::info();
    let version = info
        .split(|c: char| c == ',' || c.is_whitespace())
        .find_map(|part| part.strip_prefix("git-branch="))
        .and_then(|branch| branch.strip_prefix("rel-"))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION"));
    format!("onnxruntime-{version}")
}

struct OnnxRuntime {
    session: OrtSession,
    device: DeviceReport,
    dimensions: usize,
    model_path: String,
    /// Input names in the order the model declares them.
    input_names: Vec<String>,
    has_token_type: bool,
    /// Fixed sequence length the DirectML session was built for.  DirectML
    /// performs best with static shapes, so short inputs are padded to this
    /// length and masked out rather than re-running with a dynamic shape.
    padded_length: usize,
}

impl OnnxRuntime {
    fn open(
        model: &PreparedModel,
        device_luid: Option<&str>,
        tokenizer_limit: usize,
    ) -> Result<Self, EmbeddingError> {
        let device = resolve_device(device_luid)?;
        let mut builder = OrtSession::builder()
            .map_err(|e| EmbeddingError::failed(format!("无法创建 ONNX Runtime 会话：{e}")))?;
        builder = builder
            .with_execution_providers([ort::ep::DirectML::default()
                .with_device_id(device.device_index.unwrap_or(0))
                .build()])
            .map_err(|e| {
                EmbeddingError::unsupported(format!(
                    "DirectML 执行提供程序初始化失败，已拒绝回退到 CPU：{e}"
                ))
            })?;
        // DirectML requires the memory pattern to be disabled and the graph to
        // run sequentially; both are set explicitly instead of relying on
        // defaults that may change between runtime versions.
        builder = builder
            .with_memory_pattern(false)
            .map_err(|e| EmbeddingError::failed(format!("关闭内存复用失败：{e}")))?
            .with_parallel_execution(false)
            .map_err(|e| EmbeddingError::failed(format!("设置顺序执行失败：{e}")))?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| EmbeddingError::failed(format!("设置图优化级别失败：{e}")))?;
        // Do NOT pin exported dimensions here.  Overriding `batch`/`sequence`
        // to 1/512 made the runtime reject every batch with more than one text
        // and every shorter sequence, which the probe caught on real hardware.
        // Memory-pattern off + sequential execution already satisfy the
        // DirectML requirements, and the runtime builds kernels for the shapes
        // it actually receives.
        let session = builder.commit_from_file(&model.model_path).map_err(|e| {
            EmbeddingError::unsupported(format!("模型无法在 DirectML 上加载（未回退 CPU）：{e}"))
        })?;
        let input_names: Vec<String> = session
            .inputs()
            .iter()
            .map(|outlet| outlet.name().to_string())
            .collect();
        let has_token_type = input_names.iter().any(|name| name == "token_type_ids");
        for required in ["input_ids", "attention_mask"] {
            if !input_names.iter().any(|name| name == required) {
                return Err(EmbeddingError::unsupported(format!(
                    "模型缺少必需的输入 {required}，不是受支持的嵌入模型"
                )));
            }
        }
        let device = DeviceReport {
            providers: vec!["DmlExecutionProvider".to_string()],
            ..device
        };
        Ok(Self {
            session,
            device,
            dimensions: model.dimensions,
            model_path: model.model_path.display().to_string(),
            input_names,
            has_token_type,
            padded_length: tokenizer_limit,
        })
    }
}

/// Matches the C-58A LUID when given, so a stale array index or a marketing
/// name can never select the wrong adapter.
fn resolve_device(luid: Option<&str>) -> Result<DeviceReport, EmbeddingError> {
    let devices = crate::ai::hardware::candidate_luids();
    if devices.is_empty() {
        return Err(EmbeddingError::resources(
            "系统未返回可用的 DirectX 12 适配器，无法在 GPU 上运行嵌入模型",
        ));
    }
    let requested = match luid {
        Some(value) => devices
            .iter()
            .position(|(luid, _)| luid == value)
            .ok_or_else(|| {
                EmbeddingError::unsupported("请求的 GPU LUID 不在本次枚举结果中，请重新探测设备")
            })?,
        None => 0,
    };
    let chosen = &devices[requested];
    Ok(DeviceReport {
        device_index: Some(requested as i32),
        luid: Some(chosen.0.clone()),
        adapter_name: Some(chosen.1.clone()),
        providers: Vec::new(),
        cpu_node_count: None,
    })
}

impl Runtime for OnnxRuntime {
    fn run(
        &mut self,
        batch: &[Tokenized],
        signal: &dyn Fn() -> bool,
    ) -> Result<Vec<Vec<f64>>, EmbeddingError> {
        if batch.is_empty() {
            return Err(EmbeddingError::failed("空批次"));
        }
        if signal() {
            return Err(EmbeddingError::cancelled());
        }
        let batch_size = batch.len();
        let longest = batch.iter().map(|item| item.ids.len()).max().unwrap_or(0);
        if longest == 0 {
            return Err(EmbeddingError::failed("批次中没有有效 token"));
        }
        // DirectML is fastest with a fixed shape, so the session was built for
        // `padded_length`; pad_ids/mask are zero there, which keeps CLS pooling
        // and the attention mask correct.  An input that somehow exceeds the
        // built length would be a hard mismatch, so it is refused instead of
        // silently reshaped.
        let sequence = self.padded_length.max(longest);
        if longest > self.padded_length {
            return Err(EmbeddingError::failed(format!(
                "单条输入 {longest} 个 token 超过会话固定长度 {}，身份校验应先拒绝该输入",
                self.padded_length
            )));
        }
        let mut ids = vec![0i64; batch_size * sequence];
        let mut mask = vec![0i64; batch_size * sequence];
        let types = vec![0i64; batch_size * sequence];
        // Pooling needs a mask aligned with the padded `values` slice, not the
        // tokenizer's shorter mask: `pool` checks `values.len() == mask.len() *
        // dimensions`, so the raw per-text mask would fail on every padded
        // batch.  Padding positions stay 0 and are excluded from the mean.
        let mut aligned_mask: Vec<Vec<i64>> = Vec::with_capacity(batch_size);
        for (row, item) in batch.iter().enumerate() {
            if item.mask.len() != item.ids.len() {
                return Err(EmbeddingError::failed("tokenizer 输出形状不一致"));
            }
            let mut row_mask = vec![0i64; sequence];
            for (column, id) in item.ids.iter().enumerate() {
                ids[row * sequence + column] = *id;
                mask[row * sequence + column] = item.mask[column];
                row_mask[column] = item.mask[column];
            }
            aligned_mask.push(row_mask);
        }
        let shape = [batch_size as i64, sequence as i64];
        let ids_value = Tensor::from_array((shape, ids.into_boxed_slice()))
            .map_err(|e| EmbeddingError::failed(format!("构造 input_ids 张量失败：{e}")))?;
        let mask_value = Tensor::from_array((shape, mask.into_boxed_slice()))
            .map_err(|e| EmbeddingError::failed(format!("构造 attention_mask 张量失败：{e}")))?;
        let types_value = Tensor::from_array((shape, types.into_boxed_slice()))
            .map_err(|e| EmbeddingError::failed(format!("构造 token_type_ids 张量失败：{e}")))?;
        let mut inputs: Vec<(&str, ort::session::SessionInputValue)> = Vec::new();
        for name in &self.input_names {
            match name.as_str() {
                "input_ids" => inputs.push(("input_ids", ids_value.clone().into())),
                "attention_mask" => inputs.push(("attention_mask", mask_value.clone().into())),
                "token_type_ids" if self.has_token_type => {
                    inputs.push(("token_type_ids", types_value.clone().into()))
                }
                _ => {
                    return Err(EmbeddingError::unsupported(format!(
                        "模型输入 {name} 不受支持；首批只支持 BERT 类嵌入模型"
                    )))
                }
            }
        }
        let outputs = self
            .session
            .run(inputs)
            .map_err(|e| EmbeddingError::failed(format!("DirectML 推理失败：{e}")))?;
        if signal() {
            return Err(EmbeddingError::cancelled());
        }
        let hidden = match outputs.get("last_hidden_state") {
            Some(value) => value,
            None => match outputs.get("token_embeddings") {
                Some(value) => value,
                None => {
                    // Fall back to the first declared output name. Only
                    // borrowed keys enter `get`, so no temporary escapes.
                    let first = outputs
                        .keys()
                        .next()
                        .map(|name| name.to_string())
                        .ok_or_else(|| EmbeddingError::failed("模型没有返回隐藏状态"))?;
                    outputs
                        .get(&first)
                        .ok_or_else(|| EmbeddingError::failed("模型输出无法按名称读取"))?
                }
            },
        };
        let (shape, data) = hidden
            .try_extract_tensor::<f32>()
            .map_err(|e| EmbeddingError::failed(format!("读取模型输出失败：{e}")))?;
        // `ort`'s `Shape` derefs to `[i64]` but has no `as_slice`, so index the
        // dereferenced slice instead of calling a method that does not exist.
        let dims: &[i64] = &shape;
        if dims.len() != 3
            || dims[0] != batch_size as i64
            || dims[1] != sequence as i64
            || dims[2] != self.dimensions as i64
        {
            let actual: Vec<i64> = dims.to_vec();
            return Err(EmbeddingError::failed(format!(
                "模型输出形状 {actual:?}（{dims_len} 维）与身份不符（期望 [{batch_size}, {sequence}, {}]），模型包与运行时不匹配",
                self.dimensions,
                dims_len = dims.len()
            )));
        }
        // The pooled path needs exactly `sequence * dimensions` values per row
        // and one mask entry per token; report the real numbers when the
        // runtime returns something else instead of a generic error.
        let expected = batch_size * sequence * self.dimensions;
        if data.len() < expected {
            let actual: Vec<i64> = dims.to_vec();
            return Err(EmbeddingError::failed(format!(
                "模型输出数据不足：形状 {actual:?}，需要 {expected} 个 f32，实际 {}",
                data.len()
            )));
        }
        let mut vectors = Vec::with_capacity(batch_size);
        for row in 0..batch_size {
            let start = row * sequence * self.dimensions;
            let end = start + sequence * self.dimensions;
            let values: Vec<f64> = data[start..end].iter().map(|v| *v as f64).collect();
            vectors.push(crate::ai::embedding::pool(
                &values,
                &aligned_mask[row],
                self.dimensions,
                "cls",
            )?);
        }
        Ok(vectors)
    }

    fn version(&self) -> String {
        // Pin the runtime identity to the build ONNX Runtime reports, so a
        // different DLL or build cannot silently reuse stored vectors.
        format!("{}+directml", runtime_identity())
    }

    fn device_report(&self) -> DeviceReport {
        self.device.clone()
    }

    fn close(&mut self) -> Result<(), EmbeddingError> {
        // Dropping the session is the only disposal ONNX Runtime offers; a
        // failure here would mean the driver never confirmed release.
        let _ = &self.model_path;
        Ok(())
    }
}
