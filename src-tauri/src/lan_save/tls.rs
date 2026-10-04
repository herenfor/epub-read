use super::error::LanSaveError;
use super::pairing::hex_encode;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName,
};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error as RustlsError, ServerConfig,
    SignatureScheme,
};
use subtle::ConstantTimeEq;
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;
use std::sync::Arc;

#[derive(Debug)]
pub(crate) struct TlsIdentity {
    cert_der: CertificateDer<'static>,
    key_der: Vec<u8>,
    pub(crate) fingerprint: String,
}

impl TlsIdentity {
    pub(crate) fn generate(host: Ipv4Addr) -> Result<Self, LanSaveError> {
        let certified = rcgen::generate_simple_self_signed(vec![
            host.to_string(),
            "localhost".to_string(),
        ])
        .map_err(|error| LanSaveError::secure(format!("临时证书生成失败：{error}")))?;
        let cert_der = certified.cert.der().clone();
        let key_der = certified.signing_key.serialize_der();
        let fingerprint = hex_encode(&Sha256::digest(cert_der.as_ref()));
        Ok(Self {
            cert_der,
            key_der,
            fingerprint,
        })
    }

    pub(crate) fn server_config(&self) -> Result<ServerConfig, LanSaveError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone()));
        ServerConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(LanSaveError::from)?
            .with_no_client_auth()
            .with_single_cert(vec![self.cert_der.clone()], key)
            .map_err(LanSaveError::from)
    }
}

#[derive(Debug)]
struct PinnedServerVerifier {
    expected: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl PinnedServerVerifier {
    fn new(fingerprint_hex: &str) -> Result<Self, LanSaveError> {
        let expected = decode_hex_32(fingerprint_hex)?;
        Ok(Self {
            expected,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        })
    }

    fn algorithms(&self) -> WebPkiSupportedAlgorithms {
        self.provider.signature_verification_algorithms
    }
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        let mut actual = [0_u8; 32];
        actual.copy_from_slice(&Sha256::digest(end_entity.as_ref()));
        let same: bool = actual.ct_eq(&self.expected).into();
        if same {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(RustlsError::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, dss, &self.algorithms())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.algorithms())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms().supported_schemes()
    }
}

pub(crate) fn client_config(fingerprint_hex: &str) -> Result<ClientConfig, LanSaveError> {
    let verifier = Arc::new(PinnedServerVerifier::new(fingerprint_hex)?);
    let provider = verifier.provider.clone();
    Ok(ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(LanSaveError::from)?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

pub(crate) fn server_name(host: Ipv4Addr) -> ServerName<'static> {
    ServerName::IpAddress(host.into())
}

fn decode_hex_32(value: &str) -> Result<[u8; 32], LanSaveError> {
    if !super::pairing::valid_hex_32(value) {
        return Err(LanSaveError::invalid_request(
            "certificateSha256 必须是 64 位小写 hex",
        ));
    }
    let mut out = [0_u8; 32];
    for index in 0..32 {
        let high = hex_nibble(value.as_bytes()[index * 2]);
        let low = hex_nibble(value.as_bytes()[index * 2 + 1]);
        out[index] = (high << 4) | low;
    }
    Ok(out)
}

fn hex_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => 0,
    }
}
