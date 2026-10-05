//! 平台只提供本机网络事实；过滤、排序和默认选择只在这里实现。
//!
//! Windows/Android 采集器负责把真实接口类型、端口状态和排除标志带进来；
//! 这里不按名称猜测 VPN/虚拟网卡，也不把 UDP route hint 当作地址来源。

use super::error::LanSaveError;
use serde::Serialize;
use std::collections::HashSet;
use std::net::Ipv4Addr;
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
use crate::android_lan_network::AndroidLanAddressFact;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkKind {
    Wifi,
    Ethernet,
    Other,
}

impl LinkKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wifi => "wifi",
            Self::Ethernet => "ethernet",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalAddress {
    pub ip: Ipv4Addr,
    pub interface_id: String,
    pub label: String,
    pub kind: LinkKind,
    pub up: bool,
    /// Windows: 非硬件/过滤接口；Android: TRANSPORT_VPN。
    pub excluded: bool,
    /// Windows 可填 Ipv4Metric；这只是排序参考，不证明对端可达。
    pub interface_metric: Option<u32>,
}

impl LocalAddress {
    pub(crate) fn to_info(&self) -> LanAddressInfo {
        LanAddressInfo {
            address: self.ip.to_string(),
            interface_id: self.interface_id.clone(),
            label: self.label.clone(),
            kind: self.kind.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanAddressInfo {
    pub address: String,
    pub interface_id: String,
    pub label: String,
    pub kind: String,
}

/// Windows 的 IF_TYPE 和 MIB_IF_ROW2.InterfaceAndOperStatusFlags 映射。
/// MAC 非空不等于物理网卡；虚拟 Ethernet 也可能有 MAC。
pub(crate) fn windows_link(if_type: u32, status_flags: u8) -> (LinkKind, bool) {
    let kind = match if_type {
        71 => LinkKind::Wifi,
        6 => LinkKind::Ethernet,
        _ => LinkKind::Other,
    };
    let hardware = status_flags & 0x01 != 0;
    let filter = status_flags & 0x02 != 0;
    (kind, !hardware || filter)
}

/// route_source_hint 只能给已合格的真实 LAN 地址加优先级，永不作为兜底地址。
/// 多网卡最终可由用户选择；排序只给出合理默认，不承诺哪个网络与对端相通。
pub(crate) fn ranked_addresses(
    addresses: impl IntoIterator<Item = LocalAddress>,
    route_source_hint: Option<Ipv4Addr>,
) -> Vec<LocalAddress> {
    let mut eligible: Vec<_> = addresses
        .into_iter()
        .filter(|a| {
            a.up && !a.excluded
                && matches!(a.kind, LinkKind::Wifi | LinkKind::Ethernet)
                && (a.ip.is_private() || a.ip.is_link_local())
        })
        .collect();
    eligible.sort_by_key(|a| {
        (
            a.ip.is_link_local(),
            Some(a.ip) != route_source_hint,
            a.interface_metric.unwrap_or(u32::MAX),
            match a.kind {
                LinkKind::Wifi => 0,
                LinkKind::Ethernet => 1,
                LinkKind::Other => 2,
            },
            a.interface_id.clone(),
            a.ip.octets(),
        )
    });
    let mut seen = HashSet::new();
    eligible.retain(|a| seen.insert(a.ip));
    eligible
}

/// 同一份原生采集/排序结果供“列出可选地址”和“无指定时选默认 host”使用。
pub(crate) fn collect_local_addresses<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    let addresses = collect_platform_addresses(app)?;
    let route_hint = super::pairing::route_source_hint_ipv4();
    Ok(ranked_addresses(addresses, route_hint))
}

#[cfg(target_os = "windows")]
fn collect_platform_addresses<R: Runtime>(
    _app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    windows::collect()
}

#[cfg(target_os = "android")]
fn collect_platform_addresses<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    let facts = crate::android_lan_network::snapshot(app).map_err(LanSaveError::network)?;
    Ok(facts
        .into_iter()
        .filter_map(local_address_from_android)
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn collect_platform_addresses<R: Runtime>(
    _app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    // This package ships the LAN feature for Windows and Android only. The
    // collector entry stays compilable for source tests on other platforms;
    // the manual bindIp path remains the explicit advanced route.
    Ok(Vec::new())
}

#[cfg(target_os = "android")]
fn local_address_from_android(fact: AndroidLanAddressFact) -> Option<LocalAddress> {
    let ip = fact.address.parse::<Ipv4Addr>().ok()?;
    let kind = match fact.kind.as_str() {
        "wifi" => LinkKind::Wifi,
        "ethernet" => LinkKind::Ethernet,
        _ => LinkKind::Other,
    };
    Some(LocalAddress {
        ip,
        interface_id: fact.interface_id,
        label: fact.label,
        kind,
        up: fact.up,
        excluded: fact.excluded,
        interface_metric: None,
    })
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{windows_link, LinkKind, LocalAddress};
    use crate::lan_save::error::LanSaveError;
    use std::mem::size_of;
    use std::net::Ipv4Addr;
    use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GetIfEntry2, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, MIB_IF_ROW2,
    };
    use windows::Win32::NetworkManagement::Ndis::{IfOperStatusUp, MediaConnectStateConnected};
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    const INITIAL_BUFFER_BYTES: u32 = 16 * 1024;
    const MAX_BUFFER_BYTES: u32 = 4 * 1024 * 1024;

    pub(super) fn collect() -> Result<Vec<LocalAddress>, LanSaveError> {
        let mut size = INITIAL_BUFFER_BYTES;
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut buffer: Vec<u64>;
        let mut attempts = 0_u32;

        loop {
            attempts += 1;
            if size == 0 {
                size = INITIAL_BUFFER_BYTES;
            }
            let units = (size as usize).div_ceil(size_of::<u64>());
            buffer = vec![0_u64; units];
            let result = unsafe {
                GetAdaptersAddresses(
                    AF_INET.0 as u32,
                    flags,
                    None,
                    Some(buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                    &mut size,
                )
            };
            if result == NO_ERROR.0 {
                break;
            }
            if result == ERROR_BUFFER_OVERFLOW.0 {
                if attempts > 4 || size > MAX_BUFFER_BYTES {
                    return Err(LanSaveError::network(
                        "枚举 Windows 网卡地址时缓冲区长度异常",
                    ));
                }
                continue;
            }
            if result == ERROR_NO_DATA.0 {
                return Ok(Vec::new());
            }
            return Err(LanSaveError::network(format!(
                "枚举 Windows 网卡失败：系统错误 {result}"
            )));
        }

        let mut output = Vec::new();
        let mut current = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !current.is_null() {
            let adapter = unsafe { &*current };
            if adapter.OperStatus == IfOperStatusUp {
                let mut row = MIB_IF_ROW2::default();
                row.InterfaceLuid = adapter.Luid;
                let row_result = unsafe { GetIfEntry2(&mut row) };
                if row_result == NO_ERROR
                    && row.OperStatus == IfOperStatusUp
                    && row.MediaConnectState == MediaConnectStateConnected
                {
                    let (kind, excluded) =
                        windows_link(row.Type, row.InterfaceAndOperStatusFlags._bitfield);
                    let interface_id = unsafe { adapter.AdapterName.to_string() }
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| format!("{:?}", row.InterfaceGuid));
                    let label = unsafe { adapter.FriendlyName.to_string() }
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| interface_id.clone());
                    let metric = (adapter.Ipv4Metric > 0).then_some(adapter.Ipv4Metric);

                    let mut unicast = adapter.FirstUnicastAddress;
                    while !unicast.is_null() {
                        let current_unicast = unsafe { &*unicast };
                        if current_unicast.DadState
                            == windows::Win32::Networking::WinSock::IpDadStatePreferred
                        {
                            if let Some(ip) = sockaddr_ipv4(&current_unicast.Address) {
                                output.push(LocalAddress {
                                    ip,
                                    interface_id: interface_id.clone(),
                                    label: label.clone(),
                                    kind,
                                    up: true,
                                    excluded,
                                    interface_metric: metric,
                                });
                            }
                        }
                        unicast = current_unicast.Next;
                    }
                }
            }
            current = adapter.Next;
        }

        // Keep Other out of the snapshot too; it cannot be auto-bound and would
        // only be dead weight in the returned list. The factory flow above is
        // still the single policy source for VPN/virtual/hardware decisions.
        output.retain(|address| !matches!(address.kind, LinkKind::Other));
        Ok(output)
    }

    fn sockaddr_ipv4(
        address: &windows::Win32::Networking::WinSock::SOCKET_ADDRESS,
    ) -> Option<Ipv4Addr> {
        if address.lpSockaddr.is_null() || address.iSockaddrLength < size_of::<SOCKADDR_IN>() as i32
        {
            return None;
        }
        let base = address.lpSockaddr;
        if unsafe { (*base).sa_family } != AF_INET {
            return None;
        }
        let sin = unsafe { &*(base as *const SOCKADDR_IN) };
        let bytes = unsafe { sin.sin_addr.S_un.S_un_b };
        Some(Ipv4Addr::new(
            bytes.s_b1, bytes.s_b2, bytes.s_b3, bytes.s_b4,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(ip: &str, name: &str, kind: LinkKind) -> LocalAddress {
        LocalAddress {
            ip: ip.parse().unwrap(),
            interface_id: name.into(),
            label: name.into(),
            kind,
            up: true,
            excluded: false,
            interface_metric: None,
        }
    }

    #[test]
    fn vpn_hint_and_virtual_ethernet_cannot_override_real_wifi() {
        let (kind, excluded) = windows_link(6, 0); // Wintun 报为 Ethernet 也不是硬件。
        let mut vpn = address("172.19.0.1", "renamed-adapter", kind);
        vpn.excluded = excluded;
        let wifi = address("192.168.1.8", "arbitrary-name", LinkKind::Wifi);
        let mut wifi_vpn = address("10.8.0.1", "vpn-with-wifi-transport", LinkKind::Wifi);
        wifi_vpn.excluded = true; // Android VPN 可以同时带有 WIFI transport。
        let result = ranked_addresses(
            [vpn, wifi.clone(), wifi_vpn],
            Some("172.19.0.1".parse().unwrap()),
        );
        assert_eq!(result, vec![wifi]);
        assert_eq!(windows_link(6, 0x01), (LinkKind::Ethernet, false));
        assert_eq!(windows_link(6, 0x03), (LinkKind::Ethernet, true));
    }

    #[test]
    fn legitimate_172_network_and_offline_lan_are_not_blacklisted() {
        let lan = address("172.19.0.1", "physical-lan", LinkKind::Ethernet);
        let link_local = address("169.254.1.2", "direct-cable", LinkKind::Ethernet);
        let mut down = address("192.168.1.2", "unplugged", LinkKind::Wifi);
        down.up = false;
        let public = address("8.8.8.8", "public", LinkKind::Wifi);
        let loopback = address("127.0.0.1", "loopback", LinkKind::Wifi);
        let result = ranked_addresses(
            [link_local.clone(), down, public, loopback, lan.clone()],
            None,
        );
        assert_eq!(result, vec![lan, link_local]); // 无 INTERNET/VALIDATED 要求。
    }

    #[test]
    fn preference_is_local_order_is_stable_and_empty_has_no_fallback() {
        let wifi = address("192.168.1.8", "wifi", LinkKind::Wifi);
        let ethernet = address("10.0.0.8", "ethernet", LinkKind::Ethernet);
        assert_eq!(
            ranked_addresses([ethernet.clone(), wifi.clone()], None)[0],
            wifi
        );
        let ranked = ranked_addresses([wifi.clone(), ethernet.clone(), wifi], Some(ethernet.ip));
        assert_eq!(ranked[0], ethernet);
        assert_eq!(ranked.len(), 2);
        assert!(ranked_addresses([], Some("172.19.0.1".parse().unwrap())).is_empty());
    }
}
