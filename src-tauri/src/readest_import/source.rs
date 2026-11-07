use super::*;
use crate::{
    linked_library::DeviceBinding,
    native_zip_session::{Fault, NativeZipSession},
    save_file::SaveFileLocation,
};
use md5::{Digest, Md5};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::Arc,
};
use tauri::AppHandle;

trait SourceReader: Read + Seek + Send {}
impl<T: Read + Seek + Send> SourceReader for T {}
pub(super) type Guard = Arc<dyn Fn() -> Result<(), Fault> + Send + Sync>;
struct Source {
    reader: Box<dyn SourceReader>,
    guard: Guard,
    bytes: u64,
}

fn opened_file(file: File) -> PortableResult<Source> {
    if !file
        .metadata()
        .map_err(|_| error("source-unavailable", "无法读取源文件"))?
        .is_file()
    {
        return Err(error("source-unavailable", "来源不是普通文件"));
    }
    let before = crate::linked_library::snapshot_file(&file)
        .map_err(|_| error("source-unavailable", "无法读取源文件"))?;
    let stat = file
        .try_clone()
        .map_err(|_| error("source-unavailable", "无法保留源文件句柄"))?;
    let bytes = file
        .metadata()
        .map_err(|_| error("source-unavailable", "无法读取源文件"))?
        .len();
    Ok(Source {
        reader: Box::new(file),
        bytes,
        guard: Arc::new(move || {
            if crate::linked_library::snapshot_file(&stat).map_err(|_| Fault::Io)? == before {
                Ok(())
            } else {
                Err(Fault::SourceChanged)
            }
        }),
    })
}
#[cfg(target_os = "android")]
fn opened_document(reader: crate::android_uri_bridge::SeekableDocument) -> PortableResult<Source> {
    let before = reader
        .revision()
        .map_err(|_| error("source-unavailable", "无法读取文档状态"))?;
    let stat = reader
        .metadata_handle()
        .map_err(|_| error("source-unavailable", "无法保留文档句柄"))?;
    let bytes = reader.len();
    Ok(Source {
        reader: Box::new(reader),
        bytes,
        guard: Arc::new(move || {
            let after =
                crate::android_uri_bridge::document_revision(&stat).map_err(|_| Fault::Io)?;
            // Some providers touch ctime on reading. This is a transient ZIP/sample
            // guard; the selected book's actual SHA-256 is checked before writing.
            if after.file == before.file && after.modified == before.modified {
                Ok(())
            } else {
                Err(Fault::SourceChanged)
            }
        }),
    })
}
fn book(app: &AppHandle, binding: &DeviceBinding) -> PortableResult<Source> {
    if let Some(uri) = binding.document_uri() {
        #[cfg(target_os = "android")]
        return opened_document(
            crate::android_uri_bridge::open_persisted_document(app, uri)
                .map_err(|_| error("source-unavailable", "原书授权已失效"))?,
        );
        #[cfg(not(target_os = "android"))]
        {
            let _ = uri;
            return Err(error(
                "source-unavailable",
                "此平台无法读取 Android 文档绑定",
            ));
        }
    }
    let root = crate::linked_library::library_root(app)
        .map_err(|_| error("storage-error", "无法取得书库目录"))?;
    let path = binding
        .local_file(&root)
        .map_err(|_| error("source-unavailable", "原书暂不可用"))?;
    opened_file(File::open(path).map_err(|_| error("source-unavailable", "原书暂不可用"))?)
}
pub(super) fn backup(
    app: &AppHandle,
    location: SaveFileLocation,
) -> PortableResult<NativeZipSession> {
    #[cfg(not(target_os = "android"))]
    let _ = app;
    let source = match location {
        SaveFileLocation::Path { path } => opened_file(
            File::open(path).map_err(|_| error("source-unavailable", "无法读取选中的备份"))?,
        )?,
        SaveFileLocation::Uri { uri } => {
            #[cfg(target_os = "android")]
            {
                opened_document(
                    crate::android_uri_bridge::open_content_uri(app, &uri)
                        .map_err(|_| error("source-unavailable", "无法读取选中的备份"))?
                        .into_seekable()
                        .map_err(|_| {
                            error(
                                "random-access-required",
                                "请将备份保存到可随机读取的本地文件后重试",
                            )
                        })?,
                )?
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = uri;
                return Err(error(
                    "unsupported-platform",
                    "content URI 仅在 Android 可用",
                ));
            }
        }
    };
    let guard = source.guard;
    NativeZipSession::from_verified_reader(source.reader, move || guard()).map_err(fault)
}

/// Readest v0.12.20/KOReader ranges. MD5 is only an interoperability candidate
/// key; it does not replace the reader's whole-source SHA-256 identity.
pub(super) fn partial(
    reader: &mut (impl Read + Seek),
    length: u64,
    cancelled: &dyn Fn() -> bool,
) -> PortableResult<String> {
    let mut digest = Md5::new();
    let mut buffer = [0; 1024];
    for start in std::iter::once(0).chain((0..=10).map(|i| 1024u64 << (2 * i))) {
        if start >= length {
            break;
        }
        if cancelled() {
            return Err(error("cancelled", "迁入已取消"));
        }
        reader
            .seek(SeekFrom::Start(start))
            .map_err(|_| error("source-unavailable", "原书不能随机读取"))?;
        let count = (length - start).min(1024) as usize;
        reader
            .read_exact(&mut buffer[..count])
            .map_err(|_| error("source-changed", "原书读取不完整"))?;
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(super) fn candidate(
    app: &AppHandle,
    binding: &str,
    cancelled: &dyn Fn() -> bool,
) -> PortableResult<String> {
    let binding: DeviceBinding =
        serde_json::from_str(binding).map_err(|_| error("storage-error", "原书绑定损坏"))?;
    let mut source = book(app, &binding)?;
    let md5 = partial(&mut source.reader, source.bytes, cancelled)?;
    (source.guard)().map_err(fault)?;
    Ok(md5)
}
pub(super) fn verify(
    app: &AppHandle,
    binding: &str,
    hash: &str,
    cancelled: &dyn Fn() -> bool,
) -> PortableResult<Guard> {
    let binding: DeviceBinding =
        serde_json::from_str(binding).map_err(|_| error("storage-error", "原书绑定损坏"))?;
    let mut source = book(app, &binding)?;
    let (actual, bytes) =
        crate::linked_library::document_source::hash_original_document(&mut source.reader, || {
            cancelled()
        })
        .map_err(|_| {
            if cancelled() {
                error("cancelled", "迁入已取消")
            } else {
                error("source-unavailable", "无法校验原书")
            }
        })?;
    if actual != hash || bytes != source.bytes {
        return Err(error("source-changed", "原书已变化，请重新导入或重新定位"));
    }
    (source.guard)().map_err(fault)?;
    Ok(source.guard)
}
