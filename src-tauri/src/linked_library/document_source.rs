//! Content identity for a source whose offsets are relative to a SAF document.

use sha2::{Digest, Sha256};
use std::io::{self, Read};

/// Hash the same bounded reader the caller will parse or stream. The caller
/// owns the revision check and rewinds only after the hash succeeds.
pub(super) fn hash_original_document(
    reader: &mut impl Read,
    cancelled: impl Fn() -> bool,
) -> io::Result<(String, u64)> {
    let mut digest = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        if cancelled() {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        match reader.read(&mut buffer) {
            Ok(0) => return Ok((format!("{:x}", digest.finalize()), bytes)),
            Ok(count) => {
                digest.update(&buffer[..count]);
                bytes += count as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}
