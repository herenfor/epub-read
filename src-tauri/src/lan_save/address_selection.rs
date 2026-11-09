//! 平台只提供本机网络事实；过滤、排序和默认选择只在这里实现。
//!
//! Windows/Android/Linux 采集器负责把真实接口类型、端口状态和排除标志带进来；
//! 这里不按名称猜测 VPN/虚拟网卡，也不把 UDP route hint 当作地址来源。

use super::error::LanSaveError;
use serde::Serialize;
#[cfg(any(target_os = "linux", test))]
use std::collections::HashMap;
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
    /// Windows: 非硬件/过滤接口；Android: TRANSPORT_VPN；
    /// Linux: 无总线设备、sysfs virtual、tun/tap、回环、点对点或隧道类型。
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

/// Linux 链路事实。调用方从 sysfs 填入；名称和 MAC 不是字段，不能用来证明物理网卡。
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LinuxLinkFact {
    pub arp_type: u32,
    pub flags: u32,
    pub oper_up: bool,
    pub carrier_up: bool,
    pub bus_device: bool,
    pub virtual_sysfs: bool,
    pub wireless: bool,
    pub tun_tap: bool,
}

#[cfg(any(target_os = "linux", test))]
const ARPHRD_ETHER: u32 = 1;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_PPP: u32 = 512;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_TUNNEL: u32 = 768;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_TUNNEL6: u32 = 769;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_LOOPBACK: u32 = 772;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_SIT: u32 = 776;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_IPGRE: u32 = 778;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_IEEE80211: u32 = 801;
#[cfg(any(target_os = "linux", test))]
const ARPHRD_NONE: u32 = 65534;
#[cfg(any(target_os = "linux", test))]
const IFF_UP: u32 = 0x1;
#[cfg(any(target_os = "linux", test))]
const IFF_LOOPBACK: u32 = 0x8;
#[cfg(any(target_os = "linux", test))]
const IFF_POINTOPOINT: u32 = 0x10;

/// 物理 Wi-Fi/以太网才返回对应类型且不排除。
/// 回环、点对点、隧道类型、tun/tap、sysfs virtual，以及没有总线设备的接口都排除。
/// 元数据不足（读不到总线设备）同样排除，避免把 VPN 或虚拟网卡当成默认 LAN。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_link(fact: &LinuxLinkFact) -> (LinkKind, bool) {
    let loopback = fact.arp_type == ARPHRD_LOOPBACK || fact.flags & IFF_LOOPBACK != 0;
    let point_to_point = fact.flags & IFF_POINTOPOINT != 0;
    let tunnel_type = matches!(
        fact.arp_type,
        ARPHRD_NONE | ARPHRD_PPP | ARPHRD_TUNNEL | ARPHRD_TUNNEL6 | ARPHRD_SIT | ARPHRD_IPGRE
    );
    let unproven = !fact.bus_device || fact.virtual_sysfs || fact.tun_tap;
    if loopback || point_to_point || tunnel_type || unproven {
        return (LinkKind::Other, true);
    }
    if fact.wireless || fact.arp_type == ARPHRD_IEEE80211 {
        return (LinkKind::Wifi, false);
    }
    if fact.arp_type == ARPHRD_ETHER {
        return (LinkKind::Ethernet, false);
    }
    (LinkKind::Other, true)
}

/// 管理面 up、operstate 为 up、且 carrier 为 1 才算接通。三者缺一不选。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_interface_up(fact: &LinuxLinkFact) -> bool {
    fact.flags & IFF_UP != 0 && fact.oper_up && fact.carrier_up
}

/// 只接受可安全拼进 `/sys/class/net/<name>` 的接口名。这是路径约束，不是类型判断。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_ifname_safe(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=15).contains(&bytes.len())
        && name != "."
        && !name.contains("..")
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

/// `/proc/net/route` 里目的地为 0 的路由 metric。不读取网关，也不产生地址。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_default_route_metrics(table: &str) -> HashMap<String, u32> {
    let mut metrics = HashMap::new();
    for line in table.lines().skip(1) {
        let mut cols = line.split_whitespace();
        let Some(iface) = cols.next() else {
            continue;
        };
        let Some(destination) = cols.next() else {
            continue;
        };
        if destination != "00000000" {
            continue;
        }
        // Gateway, Flags, RefCnt, Use, Metric
        let Some(metric) = cols.nth(4).and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        metrics
            .entry(iface.to_string())
            .and_modify(|current: &mut u32| *current = (*current).min(metric))
            .or_insert(metric);
    }
    metrics
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

#[cfg(target_os = "linux")]
fn collect_platform_addresses<R: Runtime>(
    _app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    super::linux_addresses::collect()
}

#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
fn collect_platform_addresses<R: Runtime>(
    _app: &AppHandle<R>,
) -> Result<Vec<LocalAddress>, LanSaveError> {
    // macOS and other hosts keep the previous disabled collector. Linux has
    // its own snapshot; manual bindIp remains available everywhere.
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

    fn fact_address(ip: &str, label: &str, fact: LinuxLinkFact) -> LocalAddress {
        let (kind, excluded) = linux_link(&fact);
        LocalAddress {
            ip: ip.parse().unwrap(),
            interface_id: label.into(),
            label: label.into(),
            kind,
            up: linux_interface_up(&fact),
            excluded,
            interface_metric: None,
        }
    }

    fn bus_ethernet(up: bool) -> LinuxLinkFact {
        LinuxLinkFact {
            arp_type: 1,
            flags: if up { 0x1003 } else { 0x1002 },
            oper_up: up,
            carrier_up: up,
            bus_device: true,
            virtual_sysfs: false,
            wireless: false,
            tun_tap: false,
        }
    }

    #[test]
    fn linux_facts_keep_real_wifi_and_drop_renamed_virtual_vpn_and_loopback() {
        let mut wifi = bus_ethernet(true);
        wifi.wireless = true;
        let ethernet = bus_ethernet(true);
        let mut tun = LinuxLinkFact {
            arp_type: 65534,
            flags: 0x1091,
            oper_up: true,
            carrier_up: true,
            bus_device: false,
            virtual_sysfs: true,
            wireless: false,
            tun_tap: true,
        };
        // 名称像以太网，事实仍是 tun。
        let vpn = fact_address("10.8.0.1", "eth0", tun);
        tun.arp_type = 1;
        tun.tun_tap = true;
        tun.bus_device = true;
        tun.virtual_sysfs = false;
        let tap = fact_address("10.9.0.1", "tap-with-mac", tun);
        let mut virtual_ethernet = bus_ethernet(true);
        virtual_ethernet.bus_device = false;
        virtual_ethernet.virtual_sysfs = true;
        let bridge = fact_address("192.168.50.1", "br0", virtual_ethernet);
        let mut no_device = bus_ethernet(true);
        no_device.bus_device = false;
        let unproven = fact_address("192.168.51.1", "mystery", no_device);
        let mut point_to_point = bus_ethernet(true);
        point_to_point.flags |= 0x10;
        let p2p = fact_address("10.7.0.1", "ppp0", point_to_point);
        let loopback = fact_address(
            "10.255.255.254",
            "lo",
            LinuxLinkFact {
                arp_type: 772,
                flags: 0x9,
                oper_up: true,
                carrier_up: true,
                bus_device: false,
                virtual_sysfs: true,
                wireless: false,
                tun_tap: false,
            },
        );
        let down = fact_address("192.168.1.2", "unplugged", bus_ethernet(false));
        let wifi_address = fact_address("192.168.1.8", "renamed-wifi", wifi);
        let ethernet_address = fact_address("10.0.0.8", "enp1s0", ethernet);
        let mut ieee = bus_ethernet(true);
        ieee.arp_type = 801;
        assert_eq!(linux_link(&ieee).0, LinkKind::Wifi);
        assert!(!linux_interface_up(&bus_ethernet(false)));

        let result = ranked_addresses(
            [
                vpn,
                tap,
                bridge,
                unproven,
                p2p,
                loopback,
                down,
                ethernet_address.clone(),
                wifi_address.clone(),
            ],
            Some("10.8.0.1".parse().unwrap()),
        );
        assert_eq!(result, vec![wifi_address, ethernet_address]);
        assert!(ranked_addresses(
            [fact_address(
                "172.19.0.1",
                "only-virtual",
                LinuxLinkFact {
                    arp_type: 1,
                    flags: 0x1003,
                    oper_up: true,
                    carrier_up: true,
                    bus_device: false,
                    virtual_sysfs: true,
                    wireless: false,
                    tun_tap: false,
                }
            )],
            Some("172.19.0.1".parse().unwrap()),
        )
        .is_empty());
    }

    #[test]
    fn linux_route_metric_and_ifname_do_not_invent_addresses() {
        let table = "\
Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
eth3 00000000 0100A8C0 0003 0 0 35 00000000 0 0 0
eth3 0000A8C0 00000000 0001 0 0 291 00FFFFFF 0 0 0
MetaWSL 000013C6 00000000 0001 0 0 0 FCFFFFFF 0 0 0
wlan0 00000000 0101A8C0 0003 0 0 600 00000000 0 0 0
wlan0 00000000 0101A8C0 0003 0 0 50 00000000 0 0 0
";
        let metrics = linux_default_route_metrics(table);
        assert_eq!(metrics.get("eth3"), Some(&35));
        assert_eq!(metrics.get("wlan0"), Some(&50));
        assert!(!metrics.contains_key("MetaWSL"));
        assert!(linux_ifname_safe("eth0"));
        assert!(linux_ifname_safe("wlp2s0"));
        assert!(linux_ifname_safe("enp0s31f6"));
        assert!(!linux_ifname_safe(""));
        assert!(!linux_ifname_safe("."));
        assert!(!linux_ifname_safe(".."));
        assert!(!linux_ifname_safe("../etc"));
        assert!(!linux_ifname_safe("eth0/dev"));
        assert!(!linux_ifname_safe(&"a".repeat(16)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn live_linux_snapshot_matches_sysfs_and_ignores_route_hint() {
        let raw = super::super::linux_addresses::collect().expect("枚举 Linux 网卡失败");
        let hint = super::super::pairing::route_source_hint_ipv4();
        let ranked = ranked_addresses(raw.iter().cloned(), hint);
        let metrics = std::fs::read_to_string("/proc/net/route")
            .map(|text| linux_default_route_metrics(&text))
            .unwrap_or_default();
        assert!(ranked
            .iter()
            .all(|item| raw.iter().any(|source| source.ip == item.ip)));
        for address in &ranked {
            assert_ne!(address.ip, Ipv4Addr::new(127, 0, 0, 1));
            assert!(address.ip.is_private() || address.ip.is_link_local());
            assert!(address.up && !address.excluded);
            assert!(matches!(address.kind, LinkKind::Wifi | LinkKind::Ethernet));
            let fact = super::super::linux_addresses::interface_fact(&address.label)
                .expect("合格地址必须还能读到 sysfs");
            assert_eq!(linux_link(&fact), (address.kind, false));
            assert!(linux_interface_up(&fact));
            let ifindex =
                std::fs::read_to_string(format!("/sys/class/net/{}/ifindex", address.label))
                    .unwrap();
            assert_eq!(address.interface_id, ifindex.trim());
            if let Some(metric) = metrics.get(&address.label) {
                assert_eq!(address.interface_metric, Some(*metric));
            }
        }
        let entries = std::fs::read_dir("/sys/class/net").expect("sysfs 网卡目录");
        for entry in entries {
            let entry = entry.unwrap();
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !linux_ifname_safe(name) {
                assert!(ranked.iter().all(|item| item.label != name));
                continue;
            }
            let Some(fact) = super::super::linux_addresses::interface_fact(name) else {
                assert!(ranked.iter().all(|item| item.label != name));
                continue;
            };
            let (_kind, excluded) = linux_link(&fact);
            if excluded || !linux_interface_up(&fact) {
                assert!(
                    ranked.iter().all(|item| item.label != name),
                    "{name} 不应进入默认 LAN 候选"
                );
            }
        }
    }
}
