//! Bounded device-file gzip. Call on a blocking worker when handling large states.
use super::remote::{Cancel, RemoteError, RemoteErrorCode};
use flate2::{bufread::MultiGzDecoder, write::GzEncoder, Compression};
use std::io::{Read, Write};

pub const JSON_LIMIT: usize = crate::transfer_policy::STATE_JSON_LIMIT as usize;
// Allow gzip's small worst-case expansion without raising the JSON budget.
pub const GZIP_LIMIT: usize = JSON_LIMIT + 1024 * 1024;

pub fn encode(json: &[u8], cancel: &Cancel) -> Result<Vec<u8>, RemoteError> {
    if json.len() > JSON_LIMIT {
        return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    for chunk in json.chunks(32 * 1024) {
        cancel.check()?;
        encoder
            .write_all(chunk)
            .map_err(|_| RemoteError::new(RemoteErrorCode::InvalidResponse))?;
    }
    cancel.check()?;
    let bytes = encoder
        .finish()
        .map_err(|_| RemoteError::new(RemoteErrorCode::InvalidResponse))?;
    if bytes.len() > GZIP_LIMIT {
        return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
    }
    Ok(bytes)
}

pub fn decode(gzip: &[u8], cancel: &Cancel) -> Result<Vec<u8>, RemoteError> {
    decode_with_limit(gzip, JSON_LIMIT, cancel)
}

pub(super) fn decode_with_limit(
    gzip: &[u8],
    limit: usize,
    cancel: &Cancel,
) -> Result<Vec<u8>, RemoteError> {
    if gzip.len() > GZIP_LIMIT {
        return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
    }
    let mut decoder = MultiGzDecoder::new(gzip);
    let mut output = Vec::new();
    let mut chunk = [0; 32 * 1024];
    loop {
        cancel.check()?;
        let n = decoder
            .read(&mut chunk)
            .map_err(|_| RemoteError::new(RemoteErrorCode::InvalidResponse))?;
        if n == 0 {
            return Ok(output);
        }
        if n > limit.saturating_sub(output.len()) {
            return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
        }
        output.extend_from_slice(&chunk[..n]);
    }
}
