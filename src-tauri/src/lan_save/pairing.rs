use super::error::LanSaveError;
use crate::portable_state::valid_canonical_uuid;
use crate::save_file::version_policy::{select_lan_version, VersionError};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, UdpSocket};

pub(crate) const PAIRING_PROTOCOL: &str = "epub-reader-lan";
pub(crate) const PAIRING_VERSION: u32 = 2;
pub(crate) const PAIRING_MAX_BYTES: usize = 4 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LanEndpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanPairingVersionProbe {
    protocol: String,
    version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LanPairing {
    pub protocol: String,
    pub version: u32,
    pub session_id: String,
    pub endpoint: LanEndpoint,
    pub certificate_sha256: String,
    pub token: String,
}

fn map_lan_version_error(error: VersionError) -> LanSaveError {
    match error {
        VersionError::NeedsNewerApp => {
            LanSaveError::new("protocol-mismatch", "此连接信息需要较新版本，请升级")
        }
        VersionError::UnsupportedFormat => LanSaveError::new(
            "protocol-mismatch",
            "本版本不支持该旧互传协议，可使用双方支持的存档文件方式",
        ),
    }
}

impl LanPairing {
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
            return Err(LanSaveError::invalid_request("连接信息超过 4KiB 上限"));
        }

        // The QR protocol header is intentionally decoded before the strict
        // deny_unknown_fields DTO so a future field cannot hide the upgrade
        // reason. This probe is not a validated payload.
        let probe: LanPairingVersionProbe = serde_json::from_str(raw).map_err(|error| {
            LanSaveError::invalid_request(format!("连接信息不是有效 JSON：{error}"))
        })?;
        if probe.protocol != PAIRING_PROTOCOL {
            return Err(LanSaveError::invalid_request(
                "连接协议不是 epub-reader-lan",
            ));
        }
        match select_lan_version(probe.version) {
            Ok(()) => {}
            Err(error) => return Err(map_lan_version_error(error)),
        }

        // Only the selected v2 reader parses the complete payload strictly.
        // Never feed v1/v0 into the v2 DTO just because fields happen to fit.
        let pairing: Self = serde_json::from_str(raw).map_err(|error| {
            LanSaveError::invalid_request(format!("连接信息不是有效 JSON：{error}"))
        })?;
        pairing.validate()?;
        Ok(pairing)
    }

    pub(crate) fn encode(&self) -> Result<String, LanSaveError> {
        let raw = serde_json::to_string(self)
            .map_err(|error| LanSaveError::invalid_data(format!("连接信息无法编码：{error}")))?;
        if raw.len() > PAIRING_MAX_BYTES {
            return Err(LanSaveError::invalid_request("连接信息超过 4KiB 上限"));
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
            return Err(LanSaveError::invalid_request(
                "连接协议不是 epub-reader-lan",
            ));
        }
        if self.version != PAIRING_VERSION {
            return Err(LanSaveError::new(
                "protocol-mismatch",
                "两台设备需要更新到支持同一互传协议的版本",
            ));
        }
        if !valid_canonical_uuid(&self.session_id) {
            return Err(LanSaveError::invalid_request("sessionId 必须是规范 UUID"));
        }
        let (host, port) = self.endpoint_addr()?;
        if !valid_lan_ip(host) {
            return Err(LanSaveError::invalid_request(
                "endpoint 只接受私网或 link-local IPv4 地址",
            ));
        }
        if port == 0 {
            return Err(LanSaveError::invalid_request(
                "endpoint.port 必须在 1..=65535",
            ));
        }
        if !valid_hex_32(&self.certificate_sha256) {
            return Err(LanSaveError::invalid_request(
                "certificateSha256 必须是 64 位小写 hex",
            ));
        }
        if !valid_hex_32(&self.token) {
            return Err(LanSaveError::invalid_request("token 必须是 64 位小写 hex"));
        }
        Ok(())
    }
}

pub(crate) fn valid_lan_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local() || (cfg!(test) && ip.is_loopback())
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

/// Route source hint for an off-link destination.
///
/// It does not send a probe packet. The returned address is never used as a
/// bind address by itself: [`super::address_selection::ranked_addresses`] only
/// applies it when the address is already a real, eligible LAN candidate. A
/// VPN/TUN answer therefore cannot become the default host address.
pub(crate) fn route_source_hint_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) => ip,
        std::net::IpAddr::V6(_) => return None,
    };
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() || ip.is_broadcast() {
        None
    } else {
        Some(ip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const UUID: &str = "00000000-0000-4000-8000-000000000001";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn v2_json() -> String {
        json!({
            "protocol": PAIRING_PROTOCOL,
            "version": 2,
            "sessionId": UUID,
            "endpoint": { "host": "10.0.0.1", "port": 47777 },
            "certificateSha256": HASH,
            "token": HASH
        })
        .to_string()
    }

    #[test]
    fn v2_pairing_still_parses_strictly() {
        let pairing = LanPairing::parse(&v2_json()).expect("current pairing must parse");
        assert_eq!(pairing.version, 2);
        assert_eq!(pairing.session_id, UUID);

        let with_unknown = json!({
            "protocol": PAIRING_PROTOCOL,
            "version": 2,
            "sessionId": UUID,
            "endpoint": { "host": "10.0.0.1", "port": 47777 },
            "certificateSha256": HASH,
            "token": HASH,
            "futureField": true
        })
        .to_string();
        let error = LanPairing::parse(&with_unknown).unwrap_err();
        assert_eq!(error.code, "invalid-request");
    }

    #[test]
    fn v1_and_v0_pairing_are_not_retried_as_v2() {
        for version in [0, 1] {
            let raw = json!({
                "protocol": PAIRING_PROTOCOL,
                "version": version,
                "sessionId": UUID,
                "endpoint": { "host": "10.0.0.1", "port": 47777 },
                "certificateSha256": HASH,
                "token": HASH
            })
            .to_string();
            let error = LanPairing::parse(&raw).unwrap_err();
            assert_eq!(error.code, "protocol-mismatch", "version {version}");
            assert!(
                error.message.contains("不支持该旧互传协议"),
                "version {version}: {error}"
            );
            assert!(
                error.message.contains("存档文件方式"),
                "version {version}: {error}"
            );
        }
    }

    #[test]
    fn high_version_pairing_requests_upgrade_before_strict_payload() {
        // No session fields: the probe must reject by version before the
        // current DTO is asked to decode an incomplete future payload.
        let raw = json!({
            "protocol": PAIRING_PROTOCOL,
            "version": 3,
            "futureField": { "nested": true }
        })
        .to_string();
        let error = LanPairing::parse(&raw).unwrap_err();
        assert_eq!(error.code, "protocol-mismatch");
        assert!(error.message.contains("需要较新版本"), "{error}");
    }

    #[test]
    fn unknown_protocol_is_invalid_not_a_future_reader() {
        let raw = json!({
            "protocol": "other-reader-lan",
            "version": 99
        })
        .to_string();
        let error = LanPairing::parse(&raw).unwrap_err();
        assert_eq!(error.code, "invalid-request");
        assert!(
            error.message.contains("连接协议不是 epub-reader-lan"),
            "{error}"
        );
    }
}
