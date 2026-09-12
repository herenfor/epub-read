mod build_info;
#[cfg(test)]
mod build_info_contract;

#[cfg(feature = "ai")]
macro_rules! configure_invoke_handler {
    ($builder:expr) => {
        $builder.invoke_handler(tauri::generate_handler![
            linked_library::linked_library_import_paths,
            linked_library::linked_library_list_records,
            linked_library::linked_library_read_source_raw,
            linked_library::linked_library_read_cover_raw,
            linked_library::linked_library_relink,
            linked_library::linked_library_delete_record,
            linked_library::linked_library_delete_records,
            linked_library::linked_library_update_progress,
            linked_library::linked_library_mark_opened,
            linked_library::linked_library_update_bookmarks,
            linked_library::linked_library_update_notes,
            linked_library::linked_library_replace_records,
            linked_library::linked_library_thumbnail_read,
            linked_library::linked_library_thumbnail_write_raw,
            linked_library::linked_library_thumbnail_delete,
            fonts_import_raw,
            fonts_list,
            fonts_read,
            fonts_delete,
            system_fonts::system_fonts_list,
            build_info::app_build_info,
            ai::ai_initialize,
            ai::ai_cleanup_book,
            ai::ai_cleanup_all,
            ai::ai_index_clear_all,
            ai::ai_index_replace,
            ai::ai_index_begin,
            ai::ai_index_append,
            ai::ai_index_commit,
            ai::ai_index_abort,
            ai::ai_index_status,
            ai::ai_cache_status,
            ai::ai_cache_clear,
            ai::ai_search,
            ai::ai_task_enqueue,
            ai::ai_task_acquire_library_index,
            ai::ai_task_start,
            ai::ai_task_pause,
            ai::ai_task_resume,
            ai::ai_task_complete,
            ai::ai_task_fail,
            ai::ai_task_cancel,
            ai::ai_task_update_progress,
            ai::ai_task_list,
            ai::ai_model_library_path_get,
            ai::ai_model_library_path_set,
            ai::ai_model_scan,
            ai::ai_model_packages,
            ai::ai_model_package_register,
            ai::ai_model_package_verify,
            ai::ai_model_package_register_linked,
            ai::ai_model_package_relocate,
            ai::ai_model_package_remove,
            ai::ai_model_dev_catalog_register,
            ai::ai_model_download_enqueue,
            ai::ai_model_download_list,
            ai::ai_model_download_pause,
            ai::ai_model_download_resume,
            ai::ai_model_download_cancel,
            ai::ai_model_license_accept
        ])
    };
}

#[cfg(not(feature = "ai"))]
macro_rules! configure_invoke_handler {
    ($builder:expr) => {
        $builder.invoke_handler(tauri::generate_handler![
            linked_library::linked_library_import_paths,
            linked_library::linked_library_list_records,
            linked_library::linked_library_read_source_raw,
            linked_library::linked_library_read_cover_raw,
            linked_library::linked_library_relink,
            linked_library::linked_library_delete_record,
            linked_library::linked_library_delete_records,
            linked_library::linked_library_update_progress,
            linked_library::linked_library_mark_opened,
            linked_library::linked_library_update_bookmarks,
            linked_library::linked_library_update_notes,
            linked_library::linked_library_replace_records,
            linked_library::linked_library_thumbnail_read,
            linked_library::linked_library_thumbnail_write_raw,
            linked_library::linked_library_thumbnail_delete,
            fonts_import_raw,
            fonts_list,
            fonts_read,
            fonts_delete,
            system_fonts::system_fonts_list,
            build_info::app_build_info,
            ai::ai_initialize,
            ai::ai_cleanup_book,
            ai::ai_cleanup_all,
            ai::ai_index_clear_all,
            ai::ai_index_replace,
            ai::ai_index_begin,
            ai::ai_index_append,
            ai::ai_index_commit,
            ai::ai_index_abort,
            ai::ai_index_status,
            ai::ai_cache_status,
            ai::ai_cache_clear,
            ai::ai_search,
            ai::ai_task_enqueue,
            ai::ai_task_acquire_library_index,
            ai::ai_task_start,
            ai::ai_task_pause,
            ai::ai_task_resume,
            ai::ai_task_complete,
            ai::ai_task_fail,
            ai::ai_task_cancel,
            ai::ai_task_update_progress,
            ai::ai_task_list
        ])
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(main_window) = app.get_webview_window("main") {
            for action in second_instance_activation_steps() {
                let _ = match action {
                    ExistingWindowActivation::Unminimize => main_window.unminimize(),
                    ExistingWindowActivation::Show => main_window.show(),
                    ExistingWindowActivation::Focus => main_window.set_focus(),
                };
            }
        }
    }));

    let builder = builder
        .manage(FontWriteState::default())
        .manage(LinkedLibraryWriteState::default())
        .manage(ai::AiState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    configure_invoke_handler!(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExistingWindowActivation {
    Unminimize,
    Show,
    Focus,
}

#[cfg(desktop)]
fn second_instance_activation_steps() -> [ExistingWindowActivation; 3] {
    [
        ExistingWindowActivation::Show,
        ExistingWindowActivation::Unminimize,
        ExistingWindowActivation::Focus,
    ]
}

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

fn valid_content_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法取得应用数据目录：{error}"))
}

// ---- 用户自定义字体 ----
// 字体文件存应用数据目录：<app_data>/fonts/<id>，索引 <app_data>/fonts.json。

#[derive(Default)]
struct FontWriteState(Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontEntry {
    id: String,
    file_name: String,
    family: String,
    size: u64,
    added_at_ms: u64,
}

fn fonts_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("fonts"))
}

fn fonts_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("fonts.json"))
}

fn load_fonts(app: &AppHandle) -> Result<Vec<FontEntry>, String> {
    let p = fonts_index_path(app)?;
    match fs::read_to_string(&p) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("字体索引损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("无法读取字体索引：{e}")),
    }
}

fn save_fonts(app: &AppHandle, entries: &[FontEntry]) -> Result<(), String> {
    let p = fonts_index_path(app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建字体目录：{e}"))?;
    }
    let text =
        serde_json::to_string_pretty(entries).map_err(|e| format!("序列化字体索引失败：{e}"))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("无法写入字体索引：{e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("无法更新字体索引：{e}"))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// HTML 文件选择器上传字体：raw body + 头部元数据。
#[tauri::command]
fn fonts_import_raw(
    app: AppHandle,
    state: State<'_, FontWriteState>,
    request: tauri::ipc::Request<'_>,
) -> Result<FontEntry, String> {
    let id = request
        .headers()
        .get("x-font-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !valid_content_hash(&id) {
        return Err("无效的字体指纹".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("字体保存请求必须使用原始二进制".into());
    };
    if bytes.is_empty() {
        return Err("字体内容为空".into());
    }
    let file_name = request
        .headers()
        .get("x-font-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "font.ttf".into());
    let family = request
        .headers()
        .get("x-font-family")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| file_name.clone());
    let dir = fonts_root(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建字体目录：{e}"))?;
    let file_path = dir.join(&id);
    fs::write(&file_path, &bytes).map_err(|e| format!("无法保存字体文件：{e}"))?;

    let _guard = state.0.lock().map_err(|_| "字体写入锁已损坏".to_string())?;
    let mut entries = load_fonts(&app)?;
    entries.retain(|e| e.id != id);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = FontEntry {
        id,
        file_name,
        family,
        size: bytes.len() as u64,
        added_at_ms: now,
    };
    entries.push(entry.clone());
    save_fonts(&app, &entries)?;
    Ok(entry)
}

#[tauri::command]
fn fonts_list(app: AppHandle) -> Result<Vec<FontEntry>, String> {
    load_fonts(&app)
}

#[tauri::command]
fn fonts_read(app: AppHandle, font_id: String) -> Result<tauri::ipc::Response, String> {
    if !valid_content_hash(&font_id) {
        return Err("无效的字体指纹".into());
    }
    let p = fonts_root(&app)?.join(&font_id);
    fs::read(&p)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("无法读取字体：{e}"))
}

#[tauri::command]
fn fonts_delete(
    app: AppHandle,
    state: State<'_, FontWriteState>,
    font_id: String,
) -> Result<(), String> {
    if !valid_content_hash(&font_id) {
        return Err("无效的字体指纹".into());
    }
    let _guard = state.0.lock().map_err(|_| "字体写入锁已损坏".to_string())?;
    let p = fonts_root(&app)?.join(&font_id);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("无法删除字体文件：{e}"))?;
    }
    let mut entries = load_fonts(&app)?;
    let before = entries.len();
    entries.retain(|e| e.id != font_id);
    if entries.len() == before {
        return Err("字体不存在".into());
    }
    save_fonts(&app, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_requires_full_sha256_hex() {
        assert!(valid_content_hash(&"a".repeat(64)));
        assert!(valid_content_hash(&"A".repeat(64)));
        assert!(!valid_content_hash(&"a".repeat(63)));
        assert!(!valid_content_hash(&"g".repeat(64)));
    }

    #[cfg(desktop)]
    #[test]
    fn second_instance_shows_and_restores_main_window_before_focusing_it() {
        assert_eq!(
            second_instance_activation_steps(),
            [
                ExistingWindowActivation::Show,
                ExistingWindowActivation::Unminimize,
                ExistingWindowActivation::Focus,
            ]
        );
    }
}
mod ai;
mod linked_library;
mod system_fonts;

use linked_library::LinkedLibraryWriteState;
