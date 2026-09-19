//! Windows selection: the real ONNX Runtime DirectML runtime, included as a
//! child module so a non-Windows build never resolves this file.
#[path = "../embedding_windows.rs"]
mod inner;

pub(crate) use inner::create;
