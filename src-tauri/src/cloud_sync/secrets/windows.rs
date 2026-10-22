use super::*;
use ::windows::{
    core::{PCWSTR, PWSTR},
    Win32::{Foundation::ERROR_NOT_FOUND, Security::Credentials::*},
};

fn target(identifier: &str, connection_id: &str) -> Vec<u16> {
    format!("EPUBReader/{identifier}/WebDAV/{connection_id}")
        .encode_utf16()
        .chain(Some(0))
        .collect()
}

fn failure() -> Failure {
    Failure::new(FailureCode::CredentialUnavailable)
}

pub fn save(identifier: &str, connection_id: &str, password: &str) -> Result<()> {
    if password.is_empty() || password.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let mut target = target(identifier, connection_id);
    let mut bytes = password.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    let result = unsafe { CredWriteW(&credential, 0) }.map_err(|_| failure());
    bytes.fill(0);
    result
}

pub fn load(identifier: &str, connection_id: &str) -> Result<String> {
    let target = target(identifier, connection_id);
    let mut pointer = std::ptr::null_mut();
    unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut pointer,
        )
    }
    .map_err(|_| failure())?;
    struct Owned(*mut CREDENTIALW);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CredFree(self.0.cast()) }
        }
    }
    let owned = Owned(pointer);
    let record = unsafe { &*owned.0 };
    if record.CredentialBlobSize == 0
        || record.CredentialBlobSize > CRED_MAX_CREDENTIAL_BLOB_SIZE
        || record.CredentialBlob.is_null()
    {
        return Err(failure());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(record.CredentialBlob, record.CredentialBlobSize as usize)
    };
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| failure())
}

pub fn delete(identifier: &str, connection_id: &str) -> Result<()> {
    let target = target(identifier, connection_id);
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
        Err(_) => Err(failure()),
    }
}
