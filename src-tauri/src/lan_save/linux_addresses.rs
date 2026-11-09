//! Linux 本机 IPv4 事实采集。
//!
//! `getifaddrs` 只提供接口名和 IPv4。类型、接通状态和是否虚拟全部来自 sysfs：
//! `type`、`flags`、`operstate`、`carrier`、`device` 真实路径、`wireless`/`phy80211`、
//! `tun_flags`。不读 MAC，也不按接口名判断物理网卡。
//! `/proc/net/route` 只取默认路由 metric；读不到就留空，不会拿路由里的地址当候选。
//!
//! 读不到 type/flags、接口名不能安全拼进 sysfs，或分类结果不是 Wi-Fi/以太网时，
//! 这个地址不进入快照。没有合格接口就返回空列表，由现有 host 路径报无地址，
//! 不回退 127.0.0.1，也不改用 UDP 出口。
//!
//! Flatpak 当前 finish-args 没有 `--share=network`。自动选择需要宿主网络命名空间，
//! 以及可读的 `/sys/class/net`。沙箱里看不到这些元数据时结果为空，而不是猜测。
//! `/proc/net/route` 缺失只影响排序 metric。点对点、桥、bond、vlan、veth、
//! tun/tap 和 WireGuard 一类接口不会成为默认地址；显式 bindIp 仍走原命令。

use super::address_selection::{
    linux_default_route_metrics, linux_ifname_safe, linux_interface_up, linux_link, LinkKind,
    LinuxLinkFact, LocalAddress,
};
use super::error::LanSaveError;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, CStr};
use std::net::Ipv4Addr;
use std::path::Path;
use std::ptr;

const AF_INET: u16 = 2;

#[repr(C)]
struct IfAddrs {
    ifa_next: *mut IfAddrs,
    ifa_name: *mut c_char,
    ifa_flags: u32,
    ifa_addr: *mut SockAddr,
    ifa_netmask: *mut SockAddr,
    ifa_ifu: *mut SockAddr,
    ifa_data: *mut std::ffi::c_void,
}

#[repr(C)]
struct SockAddr {
    sa_family: u16,
    sa_data: [u8; 14],
}

extern "C" {
    fn getifaddrs(ifap: *mut *mut IfAddrs) -> c_int;
    fn freeifaddrs(ifa: *mut IfAddrs);
}

struct IfAddrsList(*mut IfAddrs);

impl Drop for IfAddrsList {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { freeifaddrs(self.0) };
        }
    }
}

pub(super) fn collect() -> Result<Vec<LocalAddress>, LanSaveError> {
    let metrics = std::fs::read_to_string("/proc/net/route")
        .map(|text| linux_default_route_metrics(&text))
        .unwrap_or_default();
    let list = read_ifaddrs()?;
    let mut output = Vec::new();
    let mut cursor = list.0;
    while !cursor.is_null() {
        let node = unsafe { &*cursor };
        if let Some(address) = local_address(node, &metrics) {
            output.push(address);
        }
        cursor = node.ifa_next;
    }
    output.retain(|address| !matches!(address.kind, LinkKind::Other));
    Ok(output)
}

pub(super) fn interface_fact(name: &str) -> Option<LinuxLinkFact> {
    if !linux_ifname_safe(name) {
        return None;
    }
    let base = Path::new("/sys/class/net").join(name);
    let arp_type: u32 = read_small(&base.join("type"))?.parse().ok()?;
    let flags = parse_flags(&read_small(&base.join("flags"))?)?;
    let oper_up = read_small(&base.join("operstate")).as_deref() == Some("up");
    let carrier_up = read_small(&base.join("carrier")).as_deref() == Some("1");
    let virtual_sysfs = std::fs::canonicalize(&base)
        .map(|path| path.starts_with("/sys/devices/virtual"))
        .unwrap_or(true);
    let device = base.join("device");
    let bus_device = device.symlink_metadata().is_ok()
        && std::fs::canonicalize(&device)
            .map(|path| !path.starts_with("/sys/devices/virtual"))
            .unwrap_or(false);
    Some(LinuxLinkFact {
        arp_type,
        flags,
        oper_up,
        carrier_up,
        bus_device,
        virtual_sysfs,
        wireless: base.join("wireless").exists() || base.join("phy80211").exists(),
        tun_tap: base.join("tun_flags").exists(),
    })
}

fn read_ifaddrs() -> Result<IfAddrsList, LanSaveError> {
    let mut head = ptr::null_mut();
    let result = unsafe { getifaddrs(&mut head) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return Err(LanSaveError::network(format!(
            "枚举 Linux 网卡失败：{error}"
        )));
    }
    Ok(IfAddrsList(head))
}

fn local_address(node: &IfAddrs, metrics: &HashMap<String, u32>) -> Option<LocalAddress> {
    if node.ifa_name.is_null() {
        return None;
    }
    let c_name = unsafe { CStr::from_ptr(node.ifa_name) };
    let name = c_name.to_str().ok()?;
    if !linux_ifname_safe(name) {
        return None;
    }
    let ip = ipv4_of(node.ifa_addr)?;
    if ip.is_unspecified() || ip.is_broadcast() || ip.is_multicast() {
        return None;
    }
    let fact = interface_fact(name)?;
    let (kind, excluded) = linux_link(&fact);
    let interface_id = read_small(&Path::new("/sys/class/net").join(name).join("ifindex"))?;
    let interface_id = interface_id.parse::<u32>().ok()?.to_string();
    Some(LocalAddress {
        ip,
        interface_id,
        label: name.to_string(),
        kind,
        up: linux_interface_up(&fact),
        excluded,
        interface_metric: metrics.get(name).copied(),
    })
}

fn ipv4_of(addr: *const SockAddr) -> Option<Ipv4Addr> {
    if addr.is_null() {
        return None;
    }
    let (family, data) = unsafe { ((*addr).sa_family, (*addr).sa_data) };
    if family != AF_INET {
        return None;
    }
    Some(Ipv4Addr::new(data[2], data[3], data[4], data[5]))
}

fn read_small(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 64 {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn parse_flags(text: &str) -> Option<u32> {
    let hex = text
        .trim()
        .strip_prefix("0x")
        .or_else(|| text.trim().strip_prefix("0X"))?;
    u32::from_str_radix(hex, 16).ok()
}
