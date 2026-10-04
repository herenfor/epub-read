use super::error::LanSaveError;
use crate::portable_state::valid_canonical_uuid;
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, UdpSocket};

pub(crate) const PAIRING_PROTOCOL: &str = "epub-reader-lan";
pub(crate) const PAIRING_VERSION: u32 = 1;
pub(crate) const PAIRING_MAX_BYTES: usize = 4 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LanEndpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LanPairingV1 {
    pub protocol: String,
    pub version: u32,
    pub session_id: String,
    pub endpoint: LanEndpoint,
    pub certificate_sha256: String,
    pub token: String,
}

impl LanPairingV1 {
    pub(crate) fn new(
        session_id: String,
        host: Ipv4Addr,
        port: u16,
        certificate_sha256: String,
        token: String,
    ) -> Self {
        Self {
            protocol: PAIRING_PROTOCOL.to_string(),
            version: PAIRING_VERSION,
            session_id,
            endpoint: LanEndpoint {
                host: host.to_string(),
                port,
            },
            certificate_sha256,
            token,
        }
    }

    pub(crate) fn parse(raw: &str) -> Result<Self, LanSaveError> {
        if raw.len() > PAIRING_MAX_BYTES {
            return Err(LanSaveError::invalid_request(
                "连接信息超过 4KiB 上限",
            ));
        }
        let pairing: Self = serde_json::from_str(raw)
            .map_err(|error| LanSaveError::invalid_request(format!("连接信息不是有效 JSON：{error}")))?;
        pairing.validate()?;
        Ok(pairing)
    }

    pub(crate) fn encode(&self) -> Result<String, LanSaveError> {
        let raw = serde_json::to_string(self)
            .map_err(|error| LanSaveError::invalid_data(format!("连接信息无法编码：{error}")))?;
        if raw.len() > PAIRING_MAX_BYTES {
            return Err(LanSaveError::invalid_request(
                "连接信息超过 4KiB 上限",
            ));
        }
        Ok(raw)
    }

    pub(crate) fn endpoint_addr(&self) -> Result<(Ipv4Addr, u16), LanSaveError> {
        let host = self
            .endpoint
            .host
            .parse::<Ipv4Addr>()
            .map_err(|_| LanSaveError::invalid_request("endpoint.host 必须是 IPv4 字面量"))?;
        Ok((host, self.endpoint.port))
    }

    pub(crate) fn validate(&self) -> Result<(), LanSaveError> {
        if self.protocol != PAIRING_PROTOCOL {
            return Err(LanSaveError::invalid_request("连接协议不是 epub-reader-lan"));
        }
        if self.version != PAIRING_VERSION {
            return Err(LanSaveError::invalid_request("不支持的连接协议版本"));
        }
        if !valid_canonical_uuid(&self.session_id) {
            return Err(LanSaveError::invalid_request("sessionId 必须是规范 UUID"));
        }
        let (host, port) = self.endpoint_addr()?;
        if host.is_unspecified() || host.is_multicast() || host.is_broadcast() {
            return Err(LanSaveError::invalid_request(
                "endpoint 不能是 0.0.0.0、组播或广播地址",
            ));
        }
        if port == 0 {
            return Err(LanSaveError::invalid_request("endpoint.port 必须在 1..=65535"));
        }
        if !valid_hex_32(&self.certificate_sha256) {
            return Err(LanSaveError::invalid_request(
                "certificateSha256 必须是 64 位小写 hex",
            ));
        }
        if !valid_hex_32(&self.token) {
            return Err(LanSaveError::invalid_request(
                "token 必须是 64 位小写 hex",
            ));
        }
        Ok(())
    }
}

pub(crate) fn valid_hex_32(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn random_hex_32() -> Result<String, LanSaveError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| LanSaveError::secure(format!("系统随机数不可用：{error}")))?;
    Ok(hex_encode(&bytes))
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Pick the source address the OS would use for an off-link destination.
/// It does not send a probe packet; if no IPv4 route is available the caller
/// falls back to loopback for same-device testing.
pub(crate) fn choose_default_lan_ipv4() -> Result<Ipv4Addr, LanSaveError> {
    match UdpSocket::bind("0.0.0.0:0").and_then(|socket| {
        socket.connect("192.0.2.1:9")?;
        socket.local_addr()
    }) {
        Ok(addr) if addr.ip().is_ipv4() && !addr.ip().is_unspecified() => {
            let ip = match addr.ip() {
                std::net::IpAddr::V4(ip) => ip,
                std::net::IpAddr::V6(_) => Ipv4Addr::LOCALHOST,
            };
            if !ip.is_loopback() && !ip.is_multicast() && !ip.is_broadcast() {
                Ok(ip)
            } else {
                Err(LanSaveError::unreachable(
                    "没有可用的非 loopback IPv4 局域网地址",
                ))
            }
        }
        Ok(_) | Err(_) => Err(LanSaveError::unreachable(
            "无法选择本机 IPv4 局域网地址",
        )),
    }
}
