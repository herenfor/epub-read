//! Local private repository and password gate. Ordinary library commands do
//! not select this repository implicitly.
use crate::portable_state::PortableStore;
use ring::pbkdf2::{self, PBKDF2_HMAC_SHA256};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    num::NonZeroU32,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Manager, WebviewWindow};

pub(crate) mod operations;

const ITERATIONS: NonZeroU32 = NonZeroU32::new(600_000).unwrap();
const AUTH: &str = "auth.json";
// Owned exclusively by this module. Original files must never enter this tree.
const METADATA: &str = "metadata";

/// Read only the private bindings that reserve names in the shared books directory.
pub(crate) fn managed_library_copies(
    library_root: &Path,
) -> Result<Vec<crate::linked_library::DeviceBinding>, String> {
    let root = library_root.parent().ok_or("书库根目录无效")?;
    let path = root.join("private-shelf").join(METADATA).join("library.sqlite3");
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(Vec::new());
    }
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let mut query = db
        .prepare("SELECT json FROM device_bindings WHERE json_extract(json, '$.storageKind') = 'managed'")
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let raw = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| error.to_string())
    })
    .collect()
}

#[derive(Serialize, Deserialize)]
struct Verifier {
    version: u8,
    salt: [u8; 16],
    digest: [u8; 32],
}

impl Verifier {
    fn new(password: &str) -> Result<Self, ShelfError> {
        let mut salt = [0; 16];
        getrandom::fill(&mut salt).map_err(|error| ShelfError::storage(error.to_string()))?;
        let mut digest = [0; 32];
        pbkdf2::derive(
            PBKDF2_HMAC_SHA256,
            ITERATIONS,
            &salt,
            password.as_bytes(),
            &mut digest,
        );
        Ok(Self {
            version: 1,
            salt,
            digest,
        })
    }

    fn matches(&self, password: &str) -> bool {
        pbkdf2::verify(
            PBKDF2_HMAC_SHA256,
            ITERATIONS,
            &self.salt,
            password.as_bytes(),
            &self.digest,
        )
        .is_ok()
    }
}

#[derive(Debug, Serialize)]
pub struct ShelfError {
    code: String,
    message: String,
}

impl ShelfError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn storage(error: impl std::fmt::Display) -> Self {
        Self::new("storage-error", format!("无法访问隐私书架资料：{error}"))
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivateShelfStatus {
    Unconfigured,
    Locked,
    Unlocked,
}

#[derive(Default)]
struct Shelf {
    unlocked: Option<operations::Session>,
}

fn load_verifier(root: &Path) -> Result<Option<Verifier>, ShelfError> {
    match fs::read(root.join(AUTH)) {
        Ok(bytes) => {
            let verifier: Verifier = serde_json::from_slice(&bytes).map_err(ShelfError::storage)?;
            if verifier.version != 1 {
                return Err(ShelfError::new(
                    "unsupported-verifier",
                    "当前版本无法读取隐私书架密码记录",
                ));
            }
            Ok(Some(verifier))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ShelfError::storage(error)),
    }
}

fn validate_password(password: &str) -> Result<(), ShelfError> {
    if password.len() > 256 || password.chars().count() < 4 || password.trim().is_empty() {
        return Err(ShelfError::new(
            "invalid-password",
            "密码至少需要 4 个字符，最多 256 字节",
        ));
    }
    Ok(())
}

fn open_store(root: &Path) -> Result<PortableStore, ShelfError> {
    let path = root.join(METADATA).join("library.sqlite3");
    PortableStore::open(&path).map_err(ShelfError::storage)
}

impl Shelf {
    fn status(&self, root: &Path) -> Result<PrivateShelfStatus, ShelfError> {
        if self.unlocked.is_some() {
            return Ok(PrivateShelfStatus::Unlocked);
        }
        Ok(if load_verifier(root)?.is_some() {
            PrivateShelfStatus::Locked
        } else {
            PrivateShelfStatus::Unconfigured
        })
    }

    fn setup(&mut self, root: &Path, password: &str) -> Result<PrivateShelfStatus, ShelfError> {
        validate_password(password)?;
        if load_verifier(root)?.is_some() {
            return Err(ShelfError::new("already-configured", "隐私书架已设置密码"));
        }
        // Unknown metadata without a verifier may belong to an interrupted
        // reset or external restore. Never attach a new password to it.
        if root
            .join(METADATA)
            .try_exists()
            .map_err(ShelfError::storage)?
        {
            return Err(ShelfError::new(
                "reset-required",
                "请先清除旧的隐私书架资料",
            ));
        }
        let verifier = Verifier::new(password)?;
        let bytes = serde_json::to_vec(&verifier).map_err(ShelfError::storage)?;
        crate::linked_library::atomic_write_bytes(&root.join(AUTH), &bytes)
            .map_err(ShelfError::storage)?;
        Ok(PrivateShelfStatus::Locked)
    }

    fn unlock(&mut self, root: &Path, password: &str) -> Result<PrivateShelfStatus, ShelfError> {
        if password.len() > 256 {
            return Err(ShelfError::new("wrong-password", "密码不正确"));
        }
        let verifier = load_verifier(root)?
            .ok_or_else(|| ShelfError::new("not-configured", "隐私书架尚未设置密码"))?;
        if !verifier.matches(password) {
            return Err(ShelfError::new("wrong-password", "密码不正确"));
        }
        if self.unlocked.is_none() {
            self.unlocked = Some(operations::Session::new(open_store(root)?)?);
        }
        Ok(PrivateShelfStatus::Unlocked)
    }

    fn lock(&mut self) {
        self.unlocked = None;
    }

    fn reset(&mut self, root: &Path, confirm: bool) -> Result<PrivateShelfStatus, ShelfError> {
        if !confirm {
            return Err(ShelfError::new(
                "confirmation-required",
                "请确认清除隐私书架资料",
            ));
        }
        self.lock();
        // Only the private metadata directory is owned here. Even a managed
        // private source lives outside it. Keep the verifier until cleanup
        // succeeds so a failed reset remains locked and can be retried.
        match fs::remove_dir_all(root.join(METADATA)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(ShelfError::storage(error)),
        }
        match fs::remove_file(root.join(AUTH)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(ShelfError::storage(error)),
        }
        Ok(PrivateShelfStatus::Unconfigured)
    }
}

#[derive(Default)]
pub(crate) struct PrivateShelfState {
    shelf: Mutex<Shelf>,
    lock_epoch: AtomicU64,
}

fn main_state(window: &WebviewWindow) -> Result<tauri::State<'_, PrivateShelfState>, ShelfError> {
    if window.label() != "main" {
        return Err(ShelfError::new("unavailable", "请在主窗口管理隐私书架"));
    }
    Ok(window.state::<PrivateShelfState>())
}

async fn run<T: Send + 'static>(
    window: WebviewWindow,
    action: impl FnOnce(&mut Shelf, &Path, &PrivateShelfState) -> Result<T, ShelfError> + Send + 'static,
) -> Result<T, ShelfError> {
    main_state(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = window
            .path()
            .app_local_data_dir()
            .map_err(ShelfError::storage)?
            .join("private-shelf");
        let state = window.state::<PrivateShelfState>();
        let mut shelf = state
            .shelf
            .lock()
            .map_err(|_| ShelfError::storage("状态锁不可用"))?;
        action(&mut shelf, &root, &state)
    })
    .await
    .map_err(ShelfError::storage)?
}

#[tauri::command]
pub async fn private_shelf_status(window: WebviewWindow) -> Result<PrivateShelfStatus, ShelfError> {
    run(window, |shelf, root, _| shelf.status(root)).await
}

#[tauri::command]
pub async fn private_shelf_setup(
    window: WebviewWindow,
    password: String,
) -> Result<PrivateShelfStatus, ShelfError> {
    run(window, move |shelf, root, _| shelf.setup(root, &password)).await
}

#[tauri::command]
pub async fn private_shelf_unlock(
    window: WebviewWindow,
    password: String,
) -> Result<operations::UnlockReply, ShelfError> {
    let epoch = main_state(&window)?.lock_epoch.load(Ordering::Acquire);
    run(window, move |shelf, root, state| {
        if state.lock_epoch.load(Ordering::Acquire) != epoch {
            return Err(ShelfError::new("unlock-cancelled", "解锁请求已取消"));
        }
        if shelf
            .unlocked
            .as_ref()
            .is_some_and(|session| session.epoch != epoch)
        {
            shelf.lock();
        }
        let result = shelf.unlock(root, &password);
        if state.lock_epoch.load(Ordering::Acquire) != epoch {
            shelf.lock();
            return Err(ShelfError::new("unlock-cancelled", "解锁请求已取消"));
        }
        let status = result?;
        let session = shelf.unlocked.as_mut().ok_or_else(operations::locked)?;
        session.epoch = epoch;
        let session_id = session.id.clone();
        Ok(operations::UnlockReply { status, session_id })
    })
    .await
}

#[tauri::command]
pub async fn private_shelf_lock(window: WebviewWindow) -> Result<(), ShelfError> {
    main_state(&window)?
        .lock_epoch
        .fetch_add(1, Ordering::AcqRel);
    run(window, |shelf, _, _| {
        shelf.lock();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn private_shelf_reset(
    window: WebviewWindow,
    confirm: bool,
) -> Result<PrivateShelfStatus, ShelfError> {
    if confirm {
        main_state(&window)?
            .lock_epoch
            .fetch_add(1, Ordering::AcqRel);
    }
    #[cfg(target_os = "android")]
    {
        let app = window.app_handle().clone();
        return run(window, move |shelf, root, _| {
            if !confirm { return shelf.reset(root, false); }
            crate::linked_library::with_document_binding_lock(&app, || {
                // Reset must still work when private metadata is corrupt.
                let uris = crate::linked_library::document_source::private_document_uris(root).ok();
                let status = shelf.reset(root, true)?;
                if let (Some(uris), Ok(bindings)) = (uris, crate::linked_library::load_bindings(&app)) {
                    crate::linked_library::document_source::release_unreferenced_documents(&app, &bindings, uris);
                }
                Ok(status)
            }).map_err(ShelfError::storage)?
        }).await;
    }
    #[cfg(not(target_os = "android"))]
    run(window, move |shelf, root, _| shelf.reset(root, confirm)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_restart_lock_and_reset_keep_original_files() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("private-shelf");
        let normal = sandbox.path().join("linked-library");
        let sources = root.join("sources");
        fs::create_dir_all(&normal).unwrap();
        fs::create_dir_all(&sources).unwrap();
        let normal_file = normal.join("library.sqlite3");
        let source = sources.join("book.epub");
        fs::write(&normal_file, b"normal metadata").unwrap();
        fs::write(&source, b"original bytes").unwrap();

        let mut session = Shelf::default();
        assert_eq!(
            session.status(&root).unwrap(),
            PrivateShelfStatus::Unconfigured
        );
        session.setup(&root, "book password").unwrap();
        assert_eq!(
            session.unlock(&root, "wrong").unwrap_err().code,
            "wrong-password"
        );
        assert_eq!(
            session.unlock(&root, "book password").unwrap(),
            PrivateShelfStatus::Unlocked
        );
        let database = root.join(METADATA).join("library.sqlite3");
        assert!(database.is_file());
        session.lock();
        assert!(session.unlocked.is_none());
        let mut restarted = Shelf::default();
        assert_eq!(restarted.status(&root).unwrap(), PrivateShelfStatus::Locked);
        assert_eq!(
            restarted.reset(&root, false).unwrap_err().code,
            "confirmation-required"
        );
        assert!(database.is_file());
        assert_eq!(
            restarted.reset(&root, true).unwrap(),
            PrivateShelfStatus::Unconfigured
        );
        assert!(!database.exists());
        assert_eq!(fs::read(source).unwrap(), b"original bytes");
        assert_eq!(fs::read(normal_file).unwrap(), b"normal metadata");
    }
}

/// Nonblocking epoch guard for scoped import archive reads.
pub(crate) fn import_epoch(app: &tauri::AppHandle) -> u64 {
    app.state::<PrivateShelfState>().lock_epoch.load(Ordering::Acquire)
}
