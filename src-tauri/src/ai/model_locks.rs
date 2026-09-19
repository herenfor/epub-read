//! Cooperative asset ownership. Lock files are permanent: unlinking them would
//! let a new inode bypass a live holder. Each guard owns distinct OS handles;
//! never clone handles, upgrade locks, or wait while holding an AiStore mutex.
use super::models::{is_reparse_point, validate_relative_path};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) const LOCK_DIRECTORY: &str = ".epub-reader-locks";
pub(crate) const BUSY: &str = "模型正在被其他会话使用，暂时不能校验、安装或删除；释放后重试";

#[derive(Debug)]
pub(crate) struct ModelLock {
    files: Vec<File>,
}

impl Drop for ModelLock {
    fn drop(&mut self) {
        for file in self.files.iter().rev() {
            let _ = FileExt::unlock(file);
        }
    }
}

fn ordinary(path: &Path, directory: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("读取模型锁路径失败：{e}"))?;
    if meta.file_type().is_symlink()
        || is_reparse_point(&meta)
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err("模型锁路径包含链接或类型不正确".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !directory && meta.nlink() != 1 {
            return Err("模型锁文件不能是硬链接".into());
        }
    }
    Ok(())
}

fn lock_directory(root: &Path) -> Result<PathBuf, String> {
    // Canonicalize root aliases, but reject links/reparse points along the
    // configured spelling. The model root is an application-owned directory,
    // not a security boundary against another process replacing directories.
    let mut cursor = PathBuf::new();
    for part in root.components() {
        cursor.push(part);
        ordinary(&cursor, true)?;
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("解析模型锁目录失败：{e}"))?;
    let directory = root.join(LOCK_DIRECTORY);
    match fs::create_dir(&directory) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(format!("创建模型锁目录失败：{e}")),
    }
    ordinary(&directory, true)?;
    Ok(directory)
}

impl ModelLock {
    /// Explicit debug self-check in a reserved namespace, never model files.
    pub(crate) fn probe(root: &Path) -> Result<(), String> {
        let directory = lock_directory(root)?;
        let mut coordinator = Self { files: Vec::new() };
        coordinator.take(&directory, "root.lock", false)?;
        let mut first = Self { files: Vec::new() };
        let mut second = Self { files: Vec::new() };
        first.take(&directory, "probe.lock", false)?;
        second.take(&directory, "probe.lock", false)?;
        let mut writer = Self { files: Vec::new() };
        if writer.take(&directory, "probe.lock", true).err().as_deref() != Some(BUSY) {
            return Err("模型锁自检失败：共享占用未阻止写入".into());
        }
        drop(first);
        drop(second);
        writer.take(&directory, "probe.lock", true)?;
        Ok(())
    }
    fn take(&mut self, directory: &Path, name: &str, exclusive: bool) -> Result<(), String> {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => ordinary(&path, false)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("读取模型锁文件失败：{e}")),
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("打开模型锁文件失败：{e}"))?;
        ordinary(&path, false)?;
        let result = if exclusive {
            FileExt::try_lock_exclusive(&file)
        } else {
            FileExt::try_lock_shared(&file)
        };
        result.map_err(|e| {
            if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                BUSY.to_string()
            } else {
                format!("取得模型文件锁失败：{e}")
            }
        })?;
        self.files.push(file);
        Ok(())
    }

    /// Fail immediately; safe to call inside a DB transaction. Whole-root
    /// scans/config changes use this instead of upgrading a package guard.
    pub(crate) fn root(root: &Path) -> Result<Self, String> {
        let directory = lock_directory(root)?;
        let mut guard = Self { files: Vec::new() };
        guard.take(&directory, "root.lock", true)?;
        Ok(guard)
    }

    /// Shared guards must live from validation through Provider disposal.
    /// Path keys (not digest alone) also protect replacement by another model.
    /// Shared ancestor keys prevent deleting a parent of an active package.
    pub(crate) fn package(root: &Path, package_dir: &str, exclusive: bool) -> Result<Self, String> {
        let parts = validate_relative_path(package_dir, "模型包目录")?;
        if parts[0].eq_ignore_ascii_case(LOCK_DIRECTORY)
            || parts[0].eq_ignore_ascii_case(".staging")
        {
            return Err("模型包不能使用内部锁或暂存目录".into());
        }
        let directory = lock_directory(root)?;
        let mut guard = Self { files: Vec::new() };
        // Windows aliases (including short names) can identify the same file.
        // Serialize writers at the root until the native alias matrix passes.
        guard.take(&directory, "root.lock", cfg!(windows) && exclusive)?;
        let mut key = String::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                key.push('/');
            }
            key.push_str(&part.to_lowercase());
            guard.take(
                &directory,
                &format!("{:x}.lock", Sha256::digest(key.as_bytes())),
                exclusive && index + 1 == parts.len(),
            )?;
        }
        Ok(guard)
    }

    /// Worker-only bounded acquisition. Every failed attempt drops all handles
    /// before retrying; cancellation is checked at most 25 ms apart.
    pub(crate) fn wait_package(
        root: &Path,
        package_dir: &str,
        package_id: &str,
        timeout: Duration,
        cancelled: impl Fn() -> bool,
    ) -> Result<Self, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if cancelled() {
                return Err("模型锁等待已取消".into());
            }
            match Self::assets(root, package_dir, package_id) {
                Err(e) if e == BUSY && Instant::now() < deadline => {
                    std::thread::sleep(
                        Duration::from_millis(25)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    );
                }
                result => return result,
            }
        }
    }

    pub(crate) fn assets(root: &Path, package_dir: &str, package_id: &str) -> Result<Self, String> {
        let mut guard = Self::package(root, package_dir, true)?;
        // Staging is keyed by package ID even when two catalogs disagree about
        // the final directory. Protect both namespaces with the same guard.
        guard.take(
            &lock_directory(root)?,
            &format!("staging-{:x}.lock", Sha256::digest(package_id.as_bytes())),
            true,
        )?;
        Ok(guard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn temp_root() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "epub-lock-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn readers_block_deletion_of_package_and_ancestor_until_drop() {
        let root = temp_root();
        let first = ModelLock::package(&root, "中文/模型", false).unwrap();
        let second = ModelLock::package(&root, "中文/模型", false).unwrap();
        assert_eq!(ModelLock::package(&root, "中文", true).unwrap_err(), BUSY);
        assert_eq!(
            ModelLock::package(&root, "中文/模型", true).unwrap_err(),
            BUSY
        );
        assert!(ModelLock::root(&root).is_err());
        drop(first);
        assert!(ModelLock::package(&root, "中文/模型", true).is_err());
        drop(second);
        drop(ModelLock::package(&root, "中文/模型", true).unwrap());
        assert!(root.join(LOCK_DIRECTORY).is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wait_is_bounded_and_cancellable_without_releasing_the_owner() {
        let root = temp_root();
        let owner = ModelLock::package(&root, "model", false).unwrap();
        assert_eq!(
            ModelLock::wait_package(&root, "model", "model", Duration::ZERO, || false).unwrap_err(),
            BUSY
        );
        let calls = std::cell::Cell::new(0);
        let start = Instant::now();
        assert!(
            ModelLock::wait_package(&root, "model", "model", Duration::from_secs(5), || {
                calls.set(calls.get() + 1);
                calls.get() > 1
            })
            .unwrap_err()
            .contains("取消")
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(ModelLock::package(&root, "model", true).is_err());
        drop(owner);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_lock_holder() {
        let Ok(root) = std::env::var("EPUB_MODEL_LOCK_CHILD_ROOT") else {
            return;
        };
        let _guard = ModelLock::package(Path::new(&root), "model", false).unwrap();
        fs::write(Path::new(&root).join("ready"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn real_process_kill_releases_lock_without_removing_lock_files() {
        let root = temp_root();
        let store = super::super::AiStore::open(&root.join("second-installation")).unwrap();
        store
            .set_model_library_path(root.to_str().unwrap())
            .unwrap();
        let manifest: super::super::models::ModelPackageManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"packageId":"model","modelId":"model","version":"1","displayName":"Model","capabilities":["generation"],"format":"gguf","files":[{"relativePath":"weights.gguf","sizeBytes":7,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","purpose":"weights"}],"license":"test","originalSource":"local"}"#,
        ).unwrap();
        store
            .register_verified_model_manifest(&manifest, "model")
            .unwrap();
        fs::create_dir(root.join("model")).unwrap();
        fs::write(root.join("model/weights.gguf"), b"weights").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ai::model_locks::tests::process_lock_holder",
                "--nocapture",
            ])
            .env("EPUB_MODEL_LOCK_CHILD_ROOT", &root)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = root.join("ready").exists();
        let blocked = ModelLock::package(&root, "model", true).is_err();
        let removal = store.remove_model_package("model", true);
        let intact = root.join("model/weights.gguf").exists()
            && store.get_model_package("model").unwrap().is_some();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready && blocked);
        assert_eq!(removal.unwrap_err(), BUSY);
        assert!(intact);
        drop(ModelLock::package(&root, "model", true).unwrap());
        store.remove_model_package("model", true).unwrap();
        assert!(!root.join("model").exists());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_ids_and_reserved_paths_cannot_bypass_ownership() {
        let root = temp_root();
        let owner = ModelLock::assets(&root, "first", "same-id").unwrap();
        assert_eq!(
            ModelLock::assets(&root, "second", "same-id").unwrap_err(),
            BUSY
        );
        drop(owner);
        drop(ModelLock::assets(&root, "second", "same-id").unwrap());
        assert!(ModelLock::package(&root, ".epub-reader-locks", true).is_err());
        assert!(ModelLock::package(&root, ".staging/pkg", false).is_err());
        ModelLock::probe(&root).unwrap();
        let scan = super::super::models::scan_model_library(&root);
        assert!(scan.packages.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_linked_lock_directory_and_files() {
        let root = temp_root();
        let outside = temp_root();
        std::os::unix::fs::symlink(&outside, root.join(LOCK_DIRECTORY)).unwrap();
        assert!(ModelLock::root(&root).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_file(root.join(LOCK_DIRECTORY)).unwrap();
        fs::create_dir(root.join(LOCK_DIRECTORY)).unwrap();
        fs::write(outside.join("target"), b"untouched").unwrap();
        std::os::unix::fs::symlink(
            outside.join("target"),
            root.join(LOCK_DIRECTORY).join("root.lock"),
        )
        .unwrap();
        assert!(ModelLock::root(&root).is_err());
        assert_eq!(fs::read(outside.join("target")).unwrap(), b"untouched");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
