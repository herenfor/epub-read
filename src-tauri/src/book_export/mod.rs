//! Export complete original EPUBs independently of reading-data archives.
mod writer;

use crate::directory_import::job::DirectoryImportState;
use crate::linked_library::LinkedLibraryWriteState;
use crate::portable_state_commands::with_existing_store;
use crate::save_file::commands::{
    begin_publication, destination_path, export_temp_path, finish_task, reserve_job, FileTask,
};
use crate::save_file::{
    available_space_for, new_uuid, parse_bindings, valid_hash, ProgressReporter, SaveExportScope,
    SaveFileError, SaveFileLocation, SaveFileProgress, SkippedBook,
};
use crate::transfer_policy::SpaceBudget;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{ipc::Channel, AppHandle, Manager};
use writer::{write_output, SourceBook};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookExportResult {
    pub status: String,
    pub job_id: String,
    pub output_format: String,
    pub requested_books: usize,
    pub written_books: usize,
    pub book_bytes: u64,
    pub output_bytes: u64,
    pub exported_books: Vec<writer::ExportedBook>,
    pub skipped_books: Vec<SkippedBook>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookExportError {
    pub code: String,
    pub message: String,
    pub partial_output_retained: bool,
}
impl From<SaveFileError> for BookExportError {
    fn from(error: SaveFileError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            partial_output_retained: false,
        }
    }
}

/// Never removes an existing file: this guard is made only AFTER create_new.
struct OwnedOutput(PathBuf);
impl Drop for OwnedOutput {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn prevent_source_overwrite(
    target: &Path,
    root: &Path,
    plans: &[SourceBook],
) -> Result<(), SaveFileError> {
    let parent = target
        .parent()
        .ok_or_else(|| SaveFileError::invalid_request("目标路径缺少父目录"))?
        .canonicalize()?;
    if parent.starts_with(root.canonicalize()?) {
        return Err(SaveFileError::invalid_request(
            "请将原书导出到应用书库之外的位置",
        ));
    }
    if target.exists() {
        let target = target.canonicalize()?;
        if plans
            .iter()
            .any(|book| book.path.canonicalize().ok().as_ref() == Some(&target))
        {
            return Err(SaveFileError::invalid_request(
                "导出目标不能覆盖书架正在使用的源文件",
            ));
        }
    }
    Ok(())
}

fn run_export(
    app: &AppHandle,
    task: &FileTask,
    destination: &SaveFileLocation,
    scope: SaveExportScope,
    on_progress: Channel<SaveFileProgress>,
    uri_started: &AtomicBool,
) -> Result<BookExportResult, SaveFileError> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| SaveFileError::storage_error(e.to_string()))?
        .join("linked-library");
    // The shared import gate blocks destructive asset mutations while the
    // long read runs; the library/SQLite locks themselves are released early.
    let _activity = {
        let writes = app.state::<LinkedLibraryWriteState>();
        let _guard = writes
            .0
            .lock()
            .map_err(|_| SaveFileError::storage_error("书库锁已损坏"))?;
        app.state::<DirectoryImportState>()
            .try_acquire_import_activity(format!("book-export:{}", task.job_id))
            .map_err(|message| SaveFileError::new("busy", message))?
    };
    let (metadata, raw_bindings) = with_existing_store(app, |store| {
        Ok((store.book_source_metadata()?, store.bindings_raw()?))
    })?
    .ok_or_else(|| SaveFileError::storage_error("本机书库尚未激活"))?;
    let bindings = parse_bindings(raw_bindings)?;
    let all = matches!(&scope, SaveExportScope::All);
    let selected = match scope {
        SaveExportScope::All => metadata.keys().cloned().collect::<BTreeSet<_>>(),
        SaveExportScope::Selected { book_hashes } => {
            if book_hashes.is_empty() || book_hashes.iter().any(|hash| !valid_hash(hash)) {
                return Err(SaveFileError::invalid_request("请选择有效的书籍内容指纹"));
            }
            book_hashes.into_iter().collect()
        }
    };
    // Explicit selected single book is EPUB; all/multi is ZIP.
    let zip = all || selected.len() != 1;
    let mut result = BookExportResult {
        status: "no-books".into(),
        job_id: task.job_id.clone(),
        output_format: if zip { "zip" } else { "epub" }.into(),
        requested_books: selected.len(),
        written_books: 0,
        book_bytes: 0,
        output_bytes: 0,
        exported_books: Vec::new(),
        skipped_books: Vec::new(),
    };
    let mut plans = Vec::new();
    for hash in selected {
        let Some(meta) = metadata.get(&hash) else {
            result.skipped_books.push(SkippedBook {
                content_hash: hash,
                title: String::new(),
                reason: "book-not-found".into(),
            });
            continue;
        };
        let prepared = (|| -> Result<SourceBook, &'static str> {
            let binding = bindings.get(&hash).ok_or("source-unbound")?;
            let path = binding
                .source_path(&root)
                .map_err(|_| "source-unreadable")?;
            let stat = fs::metadata(&path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "source-missing"
                } else {
                    "source-unreadable"
                }
            })?;
            if !stat.is_file() || stat.len() == 0 {
                return Err("source-unreadable");
            }
            if binding.file_size != 0 && stat.len() != binding.file_size {
                return Err("source-changed");
            }
            Ok(SourceBook {
                hash: hash.clone(),
                title: meta.title.clone(),
                file_name: meta.file_name.clone(),
                path,
                bytes: stat.len(),
            })
        })();
        match prepared {
            Ok(book) => plans.push(book),
            Err(reason) => result.skipped_books.push(SkippedBook {
                content_hash: hash,
                title: meta.title.clone(),
                reason: reason.into(),
            }),
        }
    }
    if task.cancelled.load(Ordering::Acquire) {
        result.status = "cancelled".into();
        return Ok(result);
    }
    if plans.is_empty() {
        return Ok(result);
    }
    if let SaveFileLocation::Path { path } = destination {
        prevent_source_overwrite(Path::new(path), &root, &plans)?;
    }
    let book_total = plans
        .iter()
        .try_fold(0_u64, |n, book| n.checked_add(book.bytes))
        .ok_or_else(|| SaveFileError::invalid_request("导出字节预算超出支持范围"))?;
    let total = Some(book_total)
        .and_then(|n| n.checked_add(plans.len() as u64 * 8192))
        .ok_or_else(|| SaveFileError::invalid_request("导出字节预算超出支持范围"))?;
    let temp = export_temp_path(app, destination, &new_uuid()?)?;
    let budget = SpaceBudget::for_incremental(total)
        .map_err(|_| SaveFileError::invalid_request("导出字节预算超出支持范围"))?;
    budget
        .check(available_space_for(temp.parent().unwrap())?)
        .map_err(|_| SaveFileError::new("insufficient-space", "导出临时文件所在卷空间不足"))?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let _owned = OwnedOutput(temp.clone());
    let mut progress = ProgressReporter::new(on_progress, "writing", Some(book_total));
    let written = match write_output(file, &plans, zip, &task.cancelled, |n| progress.add(n)) {
        Ok(written) => written,
        Err(error) if error.code == "cancelled" => {
            result.status = "cancelled".into();
            return Ok(result);
        }
        Err(error) => return Err(error),
    };
    result.skipped_books.extend(written.skipped);
    if written.books.is_empty() {
        return Ok(result);
    }
    result.output_bytes = fs::metadata(&temp)?.len();
    match destination {
        SaveFileLocation::Path { path } => {
            progress.set_phase("finalizing", Some(result.output_bytes));
            begin_publication(task)?;
            crate::save_file::atomic_replace(&temp, Path::new(path))?;
        }
        SaveFileLocation::Uri { uri } => {
            #[cfg(target_os = "android")]
            {
                progress.set_phase("copying", Some(result.output_bytes));
                if task.cancelled.load(Ordering::Acquire) {
                    return Err(SaveFileError::cancelled());
                }
                uri_started.store(true, Ordering::Release);
                crate::android_uri_bridge::write_staged_file_blocking(
                    app,
                    uri,
                    &temp,
                    &task.job_id,
                )
                .map_err(SaveFileError::storage_error)?;
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (uri, uri_started);
                return Err(SaveFileError::unsupported_platform(
                    "content URI仅支持Android",
                ));
            }
        }
    }
    task.published.store(true, Ordering::Release);
    progress.add(result.output_bytes);
    progress.force();
    result.status = "written".into();
    result.written_books = written.books.len();
    result.book_bytes = written.book_bytes;
    result.exported_books = written.books;
    Ok(result)
}

#[tauri::command]
pub async fn book_source_export(
    app: AppHandle,
    job_id: String,
    destination: SaveFileLocation,
    scope: SaveExportScope,
    destination_is_new: Option<bool>,
    on_progress: Channel<SaveFileProgress>,
) -> Result<BookExportResult, BookExportError> {
    destination_path(&destination)?;
    #[cfg(not(target_os = "android"))]
    if matches!(&destination, SaveFileLocation::Uri { .. }) {
        return Err(SaveFileError::unsupported_platform("content URI仅支持Android").into());
    }
    let task = match reserve_job(&app, &job_id) {
        Ok(task) => task,
        Err(error) => {
            // The Android picker already created this target, even though a
            // competing job can reject us before the export worker starts.
            #[cfg(target_os = "android")]
            if let SaveFileLocation::Uri { uri } = &destination {
                if destination_is_new.unwrap_or(false) {
                    let cleanup_app = app.clone();
                    let uri = uri.clone();
                    return tauri::async_runtime::spawn_blocking(move || {
                        let mut error = BookExportError::from(error);
                        if let Err(cleanup) =
                            crate::android_uri_bridge::delete_created_document_blocking(
                                &cleanup_app,
                                &uri,
                            )
                        {
                            error.partial_output_retained = true;
                            error.message =
                                format!("{}；无法删除本任务新建输出：{cleanup}", error.message);
                        }
                        Err(error)
                    })
                    .await
                    .map_err(|join| BookExportError {
                        code: "output-cleanup-failed".into(),
                        message: format!("输出清理线程失败：{join}"),
                        partial_output_retained: true,
                    })?;
                }
            }
            return Err(error.into());
        }
    };
    let worker_task = task.clone();
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let started = AtomicBool::new(false);
        let mut result = run_export(
            &worker_app,
            &worker_task,
            &destination,
            scope,
            on_progress,
            &started,
        )
        .map_err(BookExportError::from);
        if worker_task.cancelled.load(Ordering::Acquire)
            && !worker_task.published.load(Ordering::Acquire)
        {
            if let Err(error) = &mut result {
                error.code = "cancelled".into();
            }
        }
        #[cfg(target_os = "android")]
        if let SaveFileLocation::Uri { uri } = &destination {
            let written = result
                .as_ref()
                .is_ok_and(|result| result.status == "written");
            if !written {
                if destination_is_new.unwrap_or(false) {
                    if let Err(cleanup) =
                        crate::android_uri_bridge::delete_created_document_blocking(
                            &worker_app,
                            uri,
                        )
                    {
                        let error = result.err().unwrap_or_else(|| {
                            SaveFileError::new("output-cleanup-failed", "没有导出书籍").into()
                        });
                        result = Err(BookExportError {
                            message: format!(
                                "{}；无法删除本任务新建输出：{cleanup}",
                                error.message
                            ),
                            partial_output_retained: true,
                            ..error
                        });
                    }
                } else if started.load(Ordering::Acquire) {
                    if let Err(error) = &mut result {
                        error.partial_output_retained = true;
                    }
                }
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = destination_is_new;
        }
        finish_task(&worker_app, &worker_task);
        result
    })
    .await;
    match result {
        Ok(result) => result,
        Err(error) => {
            finish_task(&app, &task);
            Err(SaveFileError::storage_error(format!("书籍导出线程失败：{error}")).into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unpublished_failure_cleans_only_owned_file_and_source_overwrite_is_rejected() {
        let dir = std::env::temp_dir().join(format!("epub-export-owner-{}", new_uuid().unwrap()));
        let root = dir.join("library");
        fs::create_dir_all(&root).unwrap();
        let source = dir.join("source.epub");
        fs::write(&source, b"keep source").unwrap();
        let plan = SourceBook {
            hash: "a".repeat(64),
            title: String::new(),
            file_name: "a.epub".into(),
            path: source.clone(),
            bytes: 11,
        };
        assert!(prevent_source_overwrite(&source, &root, &[plan]).is_err());
        assert!(prevent_source_overwrite(&root.join("library.sqlite3"), &root, &[]).is_err());
        let target = dir.join("existing.epub");
        fs::write(&target, b"keep target").unwrap();
        let temporary = dir.join("own.part");
        {
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .unwrap();
            let _guard = OwnedOutput(temporary.clone());
            let plan = SourceBook {
                hash: "b".repeat(64),
                title: String::new(),
                file_name: "a.epub".into(),
                path: source.clone(),
                bytes: 11,
            };
            assert!(write_output(file, &[plan], false, &AtomicBool::new(false), |_| {}).is_err());
        }
        assert!(!temporary.exists());
        assert_eq!(fs::read(&source).unwrap(), b"keep source");
        assert_eq!(fs::read(&target).unwrap(), b"keep target");
        fs::remove_dir_all(dir).unwrap();
    }
}
