//! Device-local linked library organization operations.

use super::*;

// ---- 收藏与文件夹 ----
// 组织数据是独立 JSON（`library-organization.json`）：字段级逻辑时钟、文件夹
// 永久删除标记和原始归属都在同一个 envelope 里，读写沿用书库写互斥与原子替换。

/// `None` 表示还没有文件（新用户）；JSON 损坏或数据无效都是错误，绝不用空对象
/// 覆盖已有内容。
pub(super) fn load_organization_file(path: &Path) -> Result<Option<OrganizationEnvelope>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let envelope: OrganizationEnvelope = serde_json::from_str(&text)
                .map_err(|error| format!("收藏与文件夹数据损坏：{error}"))?;
            library_organization::validate_envelope(&envelope)?;
            Ok(Some(envelope))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取收藏与文件夹数据：{error}")),
    }
}

pub(super) fn save_organization_file(path: &Path, envelope: &OrganizationEnvelope) -> Result<(), String> {
    atomic_write_json(path, envelope)
}

/// 调用方必须持有书库写锁；新用户在同一把锁内只生成一次本机身份。
pub(super) fn load_or_init_organization(app: &AppHandle) -> Result<OrganizationEnvelope, String> {
    load_or_init_organization_at(&organization_path(app)?)
}

pub(super) fn load_or_init_organization_at(path: &Path) -> Result<OrganizationEnvelope, String> {
    match load_organization_file(path)? {
        Some(envelope) => Ok(envelope),
        None => {
            let envelope = OrganizationEnvelope {
                device_id: random_uuid_v4()?,
                counter: 0,
                state: library_organization::empty_organization(),
            };
            save_organization_file(path, &envelope)?;
            Ok(envelope)
        }
    }
}

/// 16 字节系统随机数的 UUID v4 小写规范形式；本机身份只在这里产生。
pub(super) fn random_uuid_v4() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random_bytes(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut value = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            value.push('-');
        }
        value.push_str(&format!("{byte:02x}"));
    }
    Ok(value)
}

#[cfg(unix)]
pub(super) fn fill_random_bytes(buffer: &mut [u8]) -> Result<(), String> {
    let mut source =
        File::open("/dev/urandom").map_err(|error| format!("无法读取系统随机数：{error}"))?;
    source
        .read_exact(buffer)
        .map_err(|error| format!("无法读取系统随机数：{error}"))
}

#[cfg(windows)]
pub(super) fn fill_random_bytes(buffer: &mut [u8]) -> Result<(), String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut core::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    // SAFETY: the buffer is a valid writable slice for `length` bytes.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("无法取得系统随机数：NTSTATUS {status:#x}"))
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) fn fill_random_bytes(_buffer: &mut [u8]) -> Result<(), String> {
    Err("当前平台没有可用的系统随机数来源".into())
}

pub(super) fn get_organization_state(app: &AppHandle) -> Result<LibraryOrganization, String> {
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    Ok(load_or_init_organization(app)?.state)
}

pub(super) fn apply_organization_command(
    app: &AppHandle,
    command: OrganizationCommand,
) -> Result<LibraryOrganization, String> {
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let envelope = load_or_init_organization(app)?;
    // One batch reads the book records once and commits all hashes or none.
    let known_hashes: HashSet<String> = load_records(app)?
        .into_iter()
        .map(|record| record.content_hash)
        .collect();
    let updated = library_organization::apply_command(&envelope, &command, &known_hashes)?;
    if updated != envelope {
        save_organization_file(&organization_path(app)?, &updated)?;
    }
    Ok(updated.state)
}

pub(super) fn merge_organization_command(
    app: &AppHandle,
    incoming: LibraryOrganization,
) -> Result<LibraryOrganization, String> {
    library_organization::validate_organization(&incoming)?;
    let write_state = app.state::<LinkedLibraryWriteState>();
    let _guard = write_state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    // Re-read the latest state under the lock: records may have been imported
    // before this second step and the local clock must not go backwards.
    let local = load_or_init_organization(app)?;
    let merged = library_organization::merge_into_envelope(&local, &incoming)?;
    if merged != local {
        save_organization_file(&organization_path(app)?, &merged)?;
    }
    Ok(merged.state)
}
