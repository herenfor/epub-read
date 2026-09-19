use super::{Candidate, HardwareDevice, MemoryEvidence};
use windows::core::Interface;
use windows::Win32::Graphics::{
    Direct3D::D3D_FEATURE_LEVEL_11_0,
    Direct3D12::{D3D12CreateDevice, ID3D12Device},
    Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_ERROR_NOT_FOUND, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    },
};

pub(super) fn probe_devices() -> Result<Vec<HardwareDevice>, String> {
    // All COM objects stay on this blocking worker and are released on return.
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|e| format!("DXGI 设备枚举不可用：{e}"))?;
    let mut devices = Vec::new();
    let started = std::time::Instant::now();
    for index in 0..32 {
        if started.elapsed() > std::time::Duration::from_secs(4) {
            return Err("设备枚举超过时间上限，请稍后重试".into());
        }
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => return Ok(devices),
            Err(error) => return Err(format!("枚举适配器 {index} 失败：{error}")),
        };
        let desc = unsafe { adapter.GetDesc1() }
            .map_err(|e| format!("读取适配器 {index} 信息失败：{e}"))?;
        let end = desc
            .Description
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(desc.Description.len());
        let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
        // NULL output tests support without actually creating a D3D12 device.
        // S_FALSE is success; windows-rs Result correctly accepts it.
        let compatibility = if software {
            Err("软件适配器，不自动启用 CPU 回退".into())
        } else {
            unsafe {
                D3D12CreateDevice::<_, ID3D12Device>(
                    &adapter,
                    D3D_FEATURE_LEVEL_11_0,
                    std::ptr::null_mut(),
                )
            }
            .map_err(|e| format!("Direct3D 12 能力检查失败：{e}"))
        };
        let memory = (|| {
            let adapter3: IDXGIAdapter3 = adapter
                .cast()
                .map_err(|e| format!("IDXGIAdapter3 不可用：{e}"))?;
            let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
            unsafe { adapter3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info) }
                .map_err(|e| format!("进程显存预算未知：{e}"))?;
            Ok::<_, String>((info.Budget, info.CurrentUsage))
        })();
        let (budget_bytes, usage_bytes, reason) = match memory {
            Ok((budget, usage)) => (Some(budget), Some(usage), None),
            Err(reason) => (None, None, Some(reason)),
        };
        devices.push(HardwareDevice {
            id: format!(
                "dxgi:{:08x}:{:08x}",
                desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
            ),
            name: String::from_utf16_lossy(&desc.Description[..end]),
            candidate: Candidate {
                id: "d3d12-fl11_0".into(),
                name: "Direct3D 12 设备能力（FL 11_0）".into(),
                available: compatibility.is_ok(),
                reason: compatibility.err(),
            },
            memory: MemoryEvidence {
                budget_bytes,
                usage_bytes,
                source: "DXGI QueryVideoMemoryInfo / LOCAL / node 0（当前进程）".into(),
                reason,
            },
        });
    }
    Err("适配器数量超过本次探测上限 32，未返回不完整结果".into())
}
