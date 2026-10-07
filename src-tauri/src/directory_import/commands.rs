//! Registered Tauri directory-import commands with the shared import activity
//! gate. Job metadata/progress cross IPC; source bytes stay native.

use super::job::{cancel_reply, scan_job, DirectoryImportJob, DirectoryImportState};
use super::runner;
use super::types::{
    DirectoryCancelReply, DirectoryImportResult, DirectoryPickResult, DirectoryProgress,
    DirectorySource, FolderTarget, ImportOptions, InputPage, IssuePage, ScanResult,
};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn directory_import_pick(app: AppHandle) -> Result<Option<DirectoryPickResult>, String> {
    #[cfg(not(target_os = "android"))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let picked = app.dialog().file().blocking_pick_folder();
            match picked {
                None => Ok(None),
                Some(path) => {
                    let path = path
                        .into_path()
                        .map_err(|error| format!("无法转换所选文件夹路径：{error}"))?;
                    Ok(Some(DirectoryPickResult::Path {
                        path: path.to_string_lossy().to_string(),
                    }))
                }
            }
        })
        .await
        .map_err(|error| format!("目录选择工作线程失败：{error}"))?
    }

    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            match crate::android_uri_bridge::pick_directory_tree(&app)? {
                Some(uri) => Ok(Some(DirectoryPickResult::TreeUri { uri })),
                None => Ok(None),
            }
        })
        .await
        .map_err(|error| format!("目录选择工作线程失败：{error}"))?
    }
}

#[tauri::command]
pub async fn directory_import_scan(
    app: AppHandle,
    state: State<'_, DirectoryImportState>,
    job_id: String,
    source: DirectorySource,
    on_progress: Channel<DirectoryProgress>,
) -> Result<ScanResult, String> {
    let job = state.register(&job_id, source)?;
    let Some(worker) = job.begin_scan() else {
        let _ = state.remove(&job_id);
        return Err("该目录导入作业当前不可扫描".to_string());
    };
    let worker_job = Arc::clone(&job);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _worker = worker;
        scan_job(&app, &worker_job, &on_progress)
    })
    .await;
    match result {
        Ok(Ok(scan)) => Ok(scan),
        Ok(Err(message)) => {
            let _ = state.remove(&job_id);
            Err(message)
        }
        Err(error) => {
            let _ = state.remove(&job_id);
            Err(format!("目录扫描工作线程失败：{error}"))
        }
    }
}

#[tauri::command]
pub fn directory_import_page(
    app: AppHandle,
    state: State<'_, DirectoryImportState>,
    job_id: String,
    cursor: Option<String>,
) -> Result<InputPage, String> {
    let job = state
        .get(&job_id)?
        .ok_or_else(|| "目录导入作业不存在或已释放".to_string())?;
    job.page(cursor.as_deref(), &app)
}

#[tauri::command]
pub fn directory_import_issues(
    state: State<'_, DirectoryImportState>,
    job_id: String,
    cursor: Option<String>,
) -> Result<IssuePage, String> {
    let job = state
        .get(&job_id)?
        .ok_or_else(|| "目录导入作业不存在或已释放".to_string())?;
    job.issues_page(cursor.as_deref())
}

#[tauri::command]
pub fn directory_import_cancel(
    state: State<'_, DirectoryImportState>,
    job_id: String,
) -> Result<DirectoryCancelReply, String> {
    let job = state
        .get(&job_id)?
        .ok_or_else(|| "目录导入作业不存在或已释放".to_string())?;
    Ok(cancel_reply(&job.gate()))
}

#[tauri::command]
pub async fn directory_import_start(
    app: AppHandle,
    state: State<'_, DirectoryImportState>,
    job_id: String,
    options: ImportOptions,
    targets: Vec<FolderTarget>,
    on_progress: Channel<DirectoryProgress>,
) -> Result<DirectoryImportResult, String> {
    let job = state
        .get(&job_id)?
        .ok_or_else(|| "目录导入作业不存在或已释放".to_string())?;
    if job.scan_result().is_none() {
        return Err("目录扫描尚未完成，无法开始导入".to_string());
    }
    let worker = job
        .begin_import()
        .ok_or_else(|| "该目录导入作业当前不可启动或只能启动一次".to_string())?;
    let worker_job = Arc::clone(&job);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _worker = worker;
        runner::run_import(&app, worker_job, options, targets, on_progress)
    })
    .await;
    match result {
        Ok(Ok(result)) => {
            job.set_result(result.clone());
            job.gate().finish();
            Ok(result)
        }
        Ok(Err(message)) => {
            job.gate().finish();
            Err(message)
        }
        Err(error) => {
            job.gate().finish();
            Err(format!("目录导入工作线程失败：{error}"))
        }
    }
}

#[tauri::command]
pub async fn directory_import_dispose(
    app: AppHandle,
    state: State<'_, DirectoryImportState>,
    job_id: String,
) -> Result<(), String> {
    let Some(job) = state.get(&job_id)? else {
        return Ok(());
    };
    job.request_dispose();
    let _ = job.gate().cancel();
    tauri::async_runtime::spawn_blocking(move || {
        job.wait_for_workers();
        job.gate().finish();
        let state = app.state::<DirectoryImportState>();
        let _ = state.remove(&job_id)?;
        Ok(())
    })
    .await
    .map_err(|error| format!("目录清理工作线程失败：{error}"))?
}

#[allow(dead_code)]
fn _job_source_is_local(job: &DirectoryImportJob) {
    let _ = job.source();
}
