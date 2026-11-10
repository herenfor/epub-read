//! Hands the book files of a Readest source to the normal import pipeline.
//! A ZIP entry is extracted to a private staging file first; a library-folder
//! book is imported from where it is. Nothing is added to the shelf here.
use super::{commands::session, state::*, *};
use crate::native_zip_session::NativeZipSession;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{ipc::Channel, Manager, WebviewWindow};

const STAGING_DIR: &str = "readest-staging";
const STAGE_BATCH: usize = 128;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookFileInfo {
    pub readest_hash: String,
    pub file_name: String,
    pub bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StageProgress {
    completed: usize,
    total: usize,
    bytes_done: u64,
    bytes_total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedBook {
    readest_hash: String,
    /// Desktop: a file the path importer can copy into the library.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// Android: the same staged file as a content URI of this app.
    #[serde(skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

/// A plain file name that is valid on every platform we write to.
pub(super) fn safe_name(raw: &str) -> String {
    let leaf = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned = leaf
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_end_matches('.');
    let extension = crate::document_formats::extension(trimmed);
    let stem = trimmed
        .strip_suffix(extension)
        .and_then(|rest| rest.strip_suffix('.'))
        .unwrap_or("");
    let stem = stem.trim().trim_start_matches('.').trim();
    if stem.is_empty() || extension.is_empty() {
        let extension = crate::document_formats::extension(leaf).to_ascii_lowercase();
        return format!("book.{}", if extension.is_empty() { "epub".into() } else { extension });
    }
    // Keep the name well inside common 255-byte limits.
    let mut stem = stem.to_owned();
    while stem.len() > 180 {
        stem.pop();
    }
    format!("{stem}.{extension}")
}

/// Streams one ZIP entry to `dest`; a partial file never survives a failure.
pub(super) fn extract(
    archive: &NativeZipSession,
    index: usize,
    bytes: u64,
    dest: &Path,
    check: &dyn Fn() -> PortableResult<()>,
    progress: &mut dyn FnMut(u64),
) -> PortableResult<()> {
    let storage = |_| error("storage-error", "无法写入迁入临时文件");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(storage)?;
    }
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
            .map_err(storage)?;
        let mut offset = 0;
        loop {
            check()?;
            let chunk = archive.read_chunk(index, offset).map_err(fault)?;
            if chunk.is_empty() && offset < bytes {
                return Err(error("invalid-backup", "备份里的书文件不完整"));
            }
            file.write_all(&chunk).map_err(storage)?;
            offset += chunk.len() as u64;
            progress(chunk.len() as u64);
            if offset >= bytes {
                break;
            }
        }
        file.flush().map_err(storage)?;
        check()
    })();
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

fn staging_root(app: &tauri::AppHandle) -> PortableResult<PathBuf> {
    app.path()
        .app_cache_dir()
        .map(|cache| cache.join(STAGING_DIR))
        .map_err(|_| error("storage-error", "无法取得应用缓存目录"))
}

/// Only one session exists at a time, so anything left here is from a crash.
pub(super) fn sweep(app: &tauri::AppHandle) {
    if let Ok(root) = staging_root(app) {
        let _ = fs::remove_dir_all(root);
    }
}

fn hand_over(app: &tauri::AppHandle, path: &Path) -> PortableResult<(Option<String>, Option<String>)> {
    #[cfg(target_os = "android")]
    {
        let uri = crate::android_uri_bridge::cache_file_uri(app, &path.to_string_lossy())
            .map_err(|_| error("storage-error", "无法交出迁入临时文件"))?;
        Ok((None, Some(uri)))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok((Some(path.to_string_lossy().into_owned()), None))
    }
}

/// Makes the chosen books importable. Per-book failures are reported in the
/// row; cancellation and a locked shelf fail the whole call.
#[tauri::command]
pub async fn readest_books_stage(
    window: WebviewWindow,
    session_id: String,
    readest_hashes: Vec<String>,
    on_progress: Channel<StageProgress>,
) -> PortableResult<Vec<StagedBook>> {
    tauri::async_runtime::spawn_blocking(move || {
        if readest_hashes.len() > STAGE_BATCH || readest_hashes.iter().any(|hash| !valid_hash(hash)) {
            return Err(error("invalid-request", "每批最多准备128本书"));
        }
        let session = session(&window, &session_id)?;
        let app = window.app_handle();
        let (archive, plan, staging) = {
            let mut data = session
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            let staging = match &data.staging {
                Some(dir) => dir.clone(),
                None => {
                    let dir = staging_root(app)?.join(&session.id);
                    data.staging = Some(dir.clone());
                    dir
                }
            };
            let plan = readest_hashes
                .iter()
                .map(|hash| {
                    data.staged += 1;
                    (hash.clone(), data.books.get(hash).cloned(), data.staged)
                })
                .collect::<Vec<_>>();
            (data.archive.clone(), plan, staging)
        };
        let archive = archive.ok_or_else(|| error("not-ready", "备份尚未打开"))?;
        let total = plan.len();
        let bytes_total = plan
            .iter()
            .filter_map(|(_, book, _)| book.as_ref().map(|book| book.bytes))
            .sum::<u64>();
        let mut bytes_done = 0_u64;
        let mut rows = Vec::with_capacity(total);
        for (completed, (hash, book, serial)) in plan.into_iter().enumerate() {
            session.check()?;
            let report = |bytes_done: u64, completed: usize| {
                let _ = on_progress.send(StageProgress {
                    completed,
                    total,
                    bytes_done,
                    bytes_total,
                });
            };
            let staged = match book {
                None => Err(error("no-file", "来源里没有这本书的文件")),
                Some(book) => {
                    let name = safe_name(&book.name);
                    let ready = match (&book.at, &archive) {
                        (BookAt::File(path), _) => {
                            if path.is_file() {
                                Ok(path.clone())
                            } else {
                                Err(error("source-unavailable", "Readest 书库里的书文件已不在"))
                            }
                        }
                        (BookAt::Zip(index), Origin::Zip(zip)) => {
                            let dest = staging.join(serial.to_string()).join(&name);
                            let start = bytes_done;
                            let mut done = start;
                            extract(zip, *index, book.bytes, &dest, &|| session.check(), &mut |step| {
                                done += step;
                                report(done, completed);
                            })
                            .map(|()| dest)
                        }
                        _ => Err(error("invalid-request", "来源与书文件位置不一致")),
                    };
                    bytes_done += book.bytes;
                    ready.and_then(|path| hand_over(app, &path).map(|(path, uri)| (path, uri, name)))
                }
            };
            report(bytes_done, completed + 1);
            rows.push(match staged {
                Ok((path, uri, name)) => StagedBook {
                    readest_hash: hash,
                    path,
                    uri,
                    file_name: Some(name),
                    error_code: None,
                },
                Err(e) if matches!(e.code.as_str(), "cancelled" | "locked" | "session-closed") => return Err(e),
                Err(e) => StagedBook {
                    readest_hash: hash,
                    path: None,
                    uri: None,
                    file_name: None,
                    error_code: Some(e.code),
                },
            });
        }
        session.check()?;
        Ok(rows)
    })
    .await
    .map_err(|_| error("storage-error", "书文件准备任务中断"))?
}

/// Drops the staged copies once the importer has taken them.
#[tauri::command]
pub async fn readest_books_release(window: WebviewWindow, session_id: String) -> PortableResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        window
            .state::<ReadestImportState>()
            .get(&session_id)?
            .discard_staged()
    })
    .await
    .map_err(|_| error("storage-error", "清理迁入临时文件失败"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryProbe {
    path: String,
    books: usize,
}

/// Looks for a desktop Readest library in its default places. Read-only.
#[tauri::command]
pub async fn readest_library_probe(window: WebviewWindow) -> PortableResult<Option<LibraryProbe>> {
    tauri::async_runtime::spawn_blocking(move || {
        if cfg!(target_os = "android") || window.label() != "main" {
            return Ok(None);
        }
        let paths = window.app_handle().path();
        for root in folder::default_roots(paths.data_dir().ok(), paths.home_dir().ok()) {
            let Some(books) = folder::locate(&root) else {
                continue;
            };
            if let Ok(scan) = folder::scan(&books, &|| Ok(())) {
                return Ok(Some(LibraryProbe {
                    path: books.to_string_lossy().into_owned(),
                    books: scan.books.len(),
                }));
            }
        }
        Ok(None)
    })
    .await
    .map_err(|_| error("storage-error", "查找 Readest 书库失败"))?
}
