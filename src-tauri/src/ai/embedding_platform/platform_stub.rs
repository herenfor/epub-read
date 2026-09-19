//! Non-Windows selection: no ONNX Runtime and no DirectML in this build.
use crate::ai::embedding::{DeviceReport, EmbeddingError, PreparedModel, Runtime, Tokenizer};

pub(crate) fn create(
    _model: &PreparedModel,
    _device_luid: Option<&str>,
) -> Result<(Box<dyn Tokenizer>, Box<dyn Runtime>, DeviceReport), EmbeddingError> {
    Err(EmbeddingError::unsupported(
        "当前平台未接入本地嵌入运行库；Windows AI 版才提供 ONNX Runtime DirectML 推理",
    ))
}
