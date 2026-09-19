//! Explicit read-only probe. No AiStore, model files, inference or downloads.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
#[path = "hardware_windows.rs"]
mod platform;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryEvidence {
    pub budget_bytes: Option<u64>,
    pub usage_bytes: Option<u64>,
    pub source: String,
    pub reason: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareDevice {
    pub id: String,
    pub name: String,
    pub candidate: Candidate,
    pub memory: MemoryEvidence,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareReport {
    pub source: &'static str,
    pub measured_at_ms: u64,
    pub platform: &'static str,
    pub devices: Vec<HardwareDevice>,
    pub reason: Option<String>,
}

static PROBING: AtomicBool = AtomicBool::new(false);
struct ProbePermit;
impl ProbePermit {
    fn acquire() -> Result<Self, String> {
        PROBING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "上一次系统探测尚未结束，请稍后重试".to_string())?;
        Ok(Self)
    }
}
impl Drop for ProbePermit {
    fn drop(&mut self) {
        PROBING.store(false, Ordering::Release);
    }
}

fn probe() -> HardwareReport {
    #[cfg(windows)]
    let result = platform::probe_devices();
    #[cfg(not(windows))]
    let result: Result<Vec<HardwareDevice>, String> =
        Err("当前原生平台暂未接入硬件探测；不使用预览数据代替实际结果".into());
    let (devices, reason) = match result {
        Ok(devices) if devices.is_empty() => (devices, Some("系统未返回显示适配器".into())),
        Ok(devices) => (devices, None),
        Err(reason) => (Vec::new(), Some(reason)),
    };
    HardwareReport {
        source: "native",
        platform: std::env::consts::OS,
        measured_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        devices,
        reason,
    }
}

/// Adapter identities in DXGI enumeration order, for the embedding runtime.
/// The LUID string is the only device identity the front end may send back;
/// an array position is returned alongside it because DirectML selects a
/// device by index within this same enumeration.
#[allow(dead_code)]
pub(crate) fn candidate_luids() -> Vec<(String, String)> {
    #[cfg(windows)]
    let result = platform::probe_devices();
    #[cfg(not(windows))]
    let result: Result<Vec<HardwareDevice>, String> =
        Err("当前平台没有 DirectX 12 设备枚举".into());
    result
        .map(|devices| {
            devices
                .into_iter()
                .map(|device| (device.id, device.name))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) async fn ai_hardware_probe() -> Result<HardwareReport, String> {
    if !cfg!(debug_assertions) {
        return Err("硬件探测仅在 AI 调试版开放".into());
    }
    let permit = ProbePermit::acquire()?;
    // A front-end timeout cannot kill a blocked driver call. Retain the permit
    // in this worker until it really returns, preventing unbounded retries.
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        probe()
    })
    .await
    .map_err(|e| format!("系统探测线程失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn in_flight_probe_cannot_be_duplicated_and_releases_on_drop() {
        let permit = ProbePermit::acquire().unwrap();
        assert!(ProbePermit::acquire().is_err());
        drop(permit);
        drop(ProbePermit::acquire().unwrap());
    }
    #[cfg(not(windows))]
    #[test]
    fn unsupported_host_returns_native_unknown_not_fake_gpu() {
        let result = probe();
        assert_eq!(result.source, "native");
        assert!(result.devices.is_empty());
        assert!(result.reason.is_some());
    }
    #[cfg(windows)]
    #[test]
    fn windows_probe_produces_serializable_evidence() {
        let result = probe();
        println!("{}", serde_json::to_string(&result).unwrap());
        assert_eq!(result.source, "native");
        assert_eq!(result.platform, "windows");
        assert!(result.reason.is_some() || !result.devices.is_empty());
    }
}
