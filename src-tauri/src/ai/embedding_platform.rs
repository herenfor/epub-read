//! Platform selection for the native embedding runtime.
//!
//! The non-Windows build deliberately has no ONNX Runtime: the product only
//! ships a validated Windows DirectML path, and the Web preview must state
//! that clearly instead of emulating a GPU result.  Each platform lives in its
//! own file so a non-Windows build never resolves the Windows runtime at all.
#[cfg(windows)]
#[path = "embedding_platform/platform_windows.rs"]
mod platform;

#[cfg(not(windows))]
#[path = "embedding_platform/platform_stub.rs"]
mod platform;

pub(crate) use platform::create;

/// Compile-time platform marker used by the probe to prove which
/// implementation was actually linked, instead of inferring it at runtime.
#[allow(dead_code)]
pub(crate) const PLATFORM_IMPLEMENTATION: &str = if cfg!(windows) {
    "windows-directml"
} else {
    "unsupported-stub"
};
