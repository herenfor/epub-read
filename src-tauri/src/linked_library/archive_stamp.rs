//! A disposable verification receipt for app-owned archives.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ArchiveStamp {
    version: u8,
    volume: u64,
    file_id: [u8; 16],
    size: u64,
    modified: i64,
    changed: i64,
    changed_ns: i64,
}

impl ArchiveStamp {
    #[cfg(unix)]
    pub(super) fn read(file: &File) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata().ok()?;
        if !m.is_file() || m.ino() == 0 || m.ctime() <= 0 {
            return None;
        }
        let mut file_id = [0; 16];
        file_id[..8].copy_from_slice(&m.ino().to_le_bytes());
        Some(Self {
            version: 1,
            volume: m.dev(),
            file_id,
            size: m.len(),
            modified: m.mtime(),
            changed: m.ctime(),
            changed_ns: m.ctime_nsec(),
        })
    }

    #[cfg(windows)]
    pub(super) fn read(file: &File) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
                FILE_ID_INFO,
            },
        };
        let handle = HANDLE(file.as_raw_handle());
        let mut id = FILE_ID_INFO::default();
        let mut info = FILE_BASIC_INFO::default();
        // Both buffers have the layout and size required by their information class.
        unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(),
                std::mem::size_of_val(&id) as u32,
            )
            .ok()?;
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut info as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
            )
            .ok()?;
        }
        if id.FileId.Identifier == [0; 16] || info.ChangeTime <= 0 {
            return None;
        }
        Some(Self {
            version: 1,
            volume: id.VolumeSerialNumber,
            file_id: id.FileId.Identifier,
            size: file.metadata().ok()?.len(),
            modified: info.LastWriteTime,
            changed: info.ChangeTime,
            changed_ns: 0,
        })
    }
}

pub(super) fn receipt_path(root: &Path, content_hash: &str) -> PathBuf {
    root.join("archive-verification-v1")
        .join(format!("{content_hash}.json"))
}

pub(super) fn read_receipt(path: &Path) -> Option<ArchiveStamp> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Android's default books directory is app-private. The import job has just
/// published the staging file that it hashed while writing under its permit.
#[cfg(target_os = "android")]
pub(crate) fn remember_imported_archive(root: &Path, target: &Path, hash: &str, name: &str) {
    if target.starts_with(root.join("books"))
        && matches!(
            crate::document_formats::extension(name)
                .to_ascii_lowercase()
                .as_str(),
            "zip" | "cbz"
        )
    {
        if let Some(stamp) = File::open(target)
            .ok()
            .as_ref()
            .and_then(ArchiveStamp::read)
        {
            let _ = atomic_write_json(&receipt_path(root, hash), &stamp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn archive_stamp_detects_in_place_write_with_restored_mtime() {
        let file = tempfile::tempfile().unwrap();
        (&file).write_all(b"first").unwrap();
        let original_time = file.metadata().unwrap().modified().unwrap();
        let original = ArchiveStamp::read(&file).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        (&file).seek(SeekFrom::Start(0)).unwrap();
        (&file).write_all(b"other").unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(original_time))
            .unwrap();
        let changed = ArchiveStamp::read(&file).unwrap();
        assert_eq!(changed.size, original.size);
        assert_eq!(changed.modified, original.modified);
        assert_ne!(changed, original);
    }

    #[test]
    fn archive_stamp_rejects_replaced_file_and_preserves_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let replacement = dir.path().join("replacement");
        let receipt = receipt_path(dir.path(), &"f".repeat(64));
        fs::write(&source, b"first").unwrap();
        let stamp = ArchiveStamp::read(&File::open(&source).unwrap()).unwrap();
        atomic_write_json(&receipt, &stamp).unwrap();
        assert_eq!(read_receipt(&receipt), Some(stamp.clone()));
        fs::write(&replacement, b"other").unwrap();
        replace_file_atomically(&replacement, &source).unwrap();
        assert_ne!(
            ArchiveStamp::read(&File::open(&source).unwrap()),
            Some(stamp)
        );
    }
}
