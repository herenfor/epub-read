//! Device-local automatic import. Scans reuse the native directory pipeline.
use super::{
    job::{scan_source, DirectoryImportState},
    runner::run_import,
    types::{
        DirectorySource, ExistingPlacement, GroupingMode, ImportCounts, ImportOptions,
        LooseRootBooks,
    },
};
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Mutex, TryLockError},
};
use tauri::{ipc::Channel, AppHandle, Manager};

static OPERATION: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum WatchSource {
    LibraryInbox,
    Path { path: String },
    Tree { uri: String, name: String },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchAction {
    Disable,
    LibraryInbox,
    Pick,
}

#[derive(Default, Serialize, Deserialize)]
struct WatchFile {
    source: Option<WatchSource>,
    seen: Fingerprints,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Fingerprint {
    size: u64,
    modified: Option<u64>,
}

fn fingerprint(size: Option<u64>, modified: Option<u64>) -> Option<Fingerprint> {
    Some(Fingerprint {
        size: size?,
        modified,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSettings {
    enabled: bool,
    directory: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchResult {
    scanned: usize,
    unchanged: usize,
    unreadable_directories: usize,
    counts: ImportCounts,
}

fn load(path: &Path) -> Result<WatchFile, String> {
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|error| format!("无法读取自动扫描设置：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WatchFile::default()),
        Err(error) => Err(format!("无法读取自动扫描设置：{error}")),
    }
}

fn save(path: &Path, state: &WatchFile) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    crate::linked_library::atomic_write_bytes(path, &bytes)
}

#[cfg(not(target_os = "android"))]
fn inbox(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::linked_library::library_root(app)?;
    Ok(crate::linked_library::managed_books_directory(&root)?.join("Inbox"))
}

#[cfg(not(target_os = "android"))]
fn prepare_inbox(root: &Path) -> Result<PathBuf, String> {
    let books = crate::linked_library::writable_books_directory(root)?;
    let inbox = books.join("Inbox");
    fs::create_dir_all(&inbox).map_err(|error| format!("无法创建书库收件目录：{error}"))?;
    let books = books.canonicalize().map_err(|error| error.to_string())?;
    let inbox = inbox.canonicalize().map_err(|error| error.to_string())?;
    if inbox != books.join("Inbox") {
        return Err("书库收件目录不能重定向到其他位置".into());
    }
    Ok(inbox)
}

fn view(app: &AppHandle, state: &WatchFile) -> Result<WatchSettings, String> {
    let _ = app;
    let directory = match &state.source {
        None => None,
        Some(WatchSource::Path { path }) => Some(path.clone()),
        Some(WatchSource::Tree { name, .. }) => Some(name.clone()),
        Some(WatchSource::LibraryInbox) => {
            #[cfg(not(target_os = "android"))]
            {
                Some(inbox(app)?.to_string_lossy().into_owned())
            }
            #[cfg(target_os = "android")]
            {
                return Err("该平台需要选择系统文件夹".into());
            }
        }
    };
    Ok(WatchSettings {
        enabled: state.source.is_some(),
        directory,
    })
}

#[cfg(not(target_os = "android"))]
fn external_directory(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("无法打开扫描目录：{error}"))?;
    let root = crate::linked_library::library_root(app)?;
    let managed = crate::linked_library::managed_books_directory(&root)?;
    let managed = managed.canonicalize().unwrap_or(managed);
    let local = root.canonicalize().unwrap_or(root);
    if !path.is_dir()
        || path.starts_with(&managed)
        || managed.starts_with(&path)
        || path.starts_with(&local)
        || local.starts_with(&path)
    {
        return Err("请选择独立文件夹，或使用书库收件目录".into());
    }
    Ok(path)
}

fn pick(app: &AppHandle, previous: Option<&WatchSource>) -> Result<Option<WatchSource>, String> {
    #[cfg(target_os = "android")]
    {
        let Some(uri) = crate::android_uri_bridge::pick_watched_directory(app)? else {
            return Ok(None);
        };
        match crate::android_uri_bridge::query_tree_directory(app, &uri, None) {
            Ok(directory) => Ok(Some(WatchSource::Tree {
                uri,
                name: directory.parent_display_name,
            })),
            Err(error) => {
                if !matches!(previous, Some(WatchSource::Tree { uri: old, .. }) if old == &uri) {
                    crate::android_uri_bridge::release_watched_directory(app, &uri);
                }
                Err(error)
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = previous;
        use tauri_plugin_dialog::DialogExt;
        let Some(path) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|error| error.to_string())?;
        let path = external_directory(app, &path)?;
        Ok(Some(WatchSource::Path {
            path: path.to_string_lossy().into_owned(),
        }))
    }
}

fn configure(app: &AppHandle, action: WatchAction) -> Result<Option<WatchSettings>, String> {
    let path = crate::linked_library::library_root(app)?.join("folder-watch.json");
    let mut state = load(&path)?;
    let source = match action {
        WatchAction::Disable => None,
        WatchAction::Pick => {
            let Some(source) = pick(app, state.source.as_ref())? else {
                return Ok(None);
            };
            Some(source)
        }
        WatchAction::LibraryInbox => {
            #[cfg(target_os = "android")]
            return Err("该平台需要选择系统文件夹".into());
            #[cfg(not(target_os = "android"))]
            {
                let _activity = app
                    .state::<DirectoryImportState>()
                    .try_acquire_import_activity("folder-watch-configure".into())?;
                let root = crate::linked_library::library_root(app)?;
                prepare_inbox(&root)?;
                Some(WatchSource::LibraryInbox)
            }
        }
    };
    if state.source != source {
        let previous = std::mem::replace(&mut state.source, source);
        state.seen.clear();
        let saved = save(&path, &state);
        #[cfg(target_os = "android")]
        {
            let (release, keep) = if saved.is_ok() {
                (previous.as_ref(), state.source.as_ref())
            } else {
                (state.source.as_ref(), previous.as_ref())
            };
            if let Some(WatchSource::Tree { uri, .. }) = release {
                if !matches!(keep, Some(WatchSource::Tree { uri: kept, .. }) if kept == uri) {
                    crate::android_uri_bridge::release_watched_directory(app, uri);
                }
            }
        }
        #[cfg(not(target_os = "android"))]
        let _ = previous;
        saved?;
    }
    view(app, &state).map(Some)
}

type Fingerprints = BTreeMap<String, Fingerprint>;

fn select_candidates(
    output: &mut super::scanner::ScanOutput,
    seen: &Fingerprints,
) -> (Fingerprints, Fingerprints) {
    let mut next = if output.unreadable_directory_count == 0 {
        BTreeMap::new()
    } else {
        seen.clone()
    };
    let mut candidates = BTreeMap::new();
    output.entries.retain(|entry| {
        let id = &entry.epub.input_id;
        let stamp = fingerprint(entry.epub.size_hint, output.modified.get(id).copied());
        if let Some(stamp) = stamp {
            if seen.get(id) == Some(&stamp) {
                next.insert(id.clone(), stamp);
                return false;
            }
            candidates.insert(id.clone(), stamp);
        }
        next.remove(id);
        true
    });
    (next, candidates)
}

fn scan(app: &AppHandle) -> Result<WatchResult, String> {
    let path = crate::linked_library::library_root(app)?.join("folder-watch.json");
    let mut state = load(&path)?;
    let Some(source) = state.source.as_ref() else {
        return Ok(WatchResult::default());
    };
    let job = app.state::<DirectoryImportState>().automatic_job(|| {
        let source = match source {
            WatchSource::LibraryInbox => {
                #[cfg(target_os = "android")]
                return Err("该平台需要选择系统文件夹".into());
                #[cfg(not(target_os = "android"))]
                {
                    let inbox = prepare_inbox(&crate::linked_library::library_root(app)?)?;
                    DirectorySource::Path {
                        path: inbox.to_string_lossy().into_owned(),
                    }
                }
            }
            WatchSource::Path { path } => {
                #[cfg(target_os = "android")]
                {
                    let _ = path;
                    return Err("该平台需要选择系统文件夹".into());
                }
                #[cfg(not(target_os = "android"))]
                DirectorySource::Path {
                    path: external_directory(app, Path::new(path))?
                        .to_string_lossy()
                        .into_owned(),
                }
            }
            WatchSource::Tree { uri, .. } => DirectorySource::TreeUri { uri: uri.clone() },
        };
        Ok(source)
    })?;
    let mut output = scan_source(app, job.source(), &|| false)?;
    let mut result = WatchResult {
        scanned: output.entries.len(),
        unreadable_directories: output.unreadable_directory_count,
        ..Default::default()
    };
    let (mut next, candidates) = select_candidates(&mut output, &state.seen);
    result.unchanged = result.scanned - output.entries.len();
    if !output.entries.is_empty() {
        job.set_scan(output, None);
        let imported = run_import(
            app,
            job.clone(),
            ImportOptions {
                grouping: GroupingMode::None,
                loose_root_books: LooseRootBooks::Root,
                existing_placement: ExistingPlacement::PreserveAll,
            },
            Vec::new(),
            None,
            Channel::new(|_| Ok(())),
            cfg!(target_os = "android"),
        )?;
        let failed = job.failed_sources();
        next.extend(
            candidates
                .into_iter()
                .filter(|(id, _)| !failed.contains(id)),
        );
        result.counts = imported.counts;
    }
    if state.seen != next {
        state.seen = next;
        save(&path, &state)?;
    }
    Ok(result)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => "busy: 自动扫描操作正在进行",
            TryLockError::Poisoned(_) => "自动扫描操作锁不可用",
        })?;
        work()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn library_folder_watch_get(app: AppHandle) -> Result<WatchSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = load(&crate::linked_library::library_root(&app)?.join("folder-watch.json"))?;
        view(&app, &state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn library_folder_watch_configure(
    app: AppHandle,
    action: WatchAction,
) -> Result<Option<WatchSettings>, String> {
    blocking(move || configure(&app, action)).await
}

#[tauri::command]
pub async fn library_folder_watch_scan(app: AppHandle) -> Result<WatchResult, String> {
    blocking(move || scan(&app)).await
}

#[cfg(test)]
mod tests {
    use super::super::scanner::scan_path_root;
    use super::*;

    #[test]
    fn skips_successful_unchanged_files_and_retries_failed_or_changed_files() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("good.txt");
        let bad = dir.path().join("bad.cbz");
        fs::write(&ok, "one").unwrap();
        fs::write(&bad, "broken").unwrap();
        let read = || scan_path_root(dir.path(), "test".into()).unwrap();
        let mut initial = read();
        let (_, mut candidates) = select_candidates(&mut initial, &Fingerprints::new());
        assert_eq!(candidates.len(), 2);
        let bad_id = initial
            .entries
            .iter()
            .find(|entry| entry.epub.file_name == "bad.cbz")
            .unwrap()
            .epub
            .input_id
            .clone();
        candidates.remove(&bad_id);
        let state = WatchFile {
            source: Some(WatchSource::LibraryInbox),
            seen: candidates,
        };
        let cache = dir.path().join("watch.json");
        save(&cache, &state).unwrap();
        let seen = load(&cache).unwrap().seen;

        let mut repeat = read();
        let (_, retry) = select_candidates(&mut repeat, &seen);
        assert_eq!(retry.len(), 1);
        assert_eq!(repeat.entries[0].epub.input_id, bad_id);

        fs::write(&ok, "replacement").unwrap();
        let mut changed = read();
        let (_, retry) = select_candidates(&mut changed, &seen);
        assert_eq!(retry.len(), 2);

        fs::remove_file(ok).unwrap();
        let mut incomplete = read();
        incomplete.unreadable_directory_count = 1;
        assert_eq!(select_candidates(&mut incomplete, &seen).0.len(), 1);
        assert!(select_candidates(&mut read(), &seen).0.is_empty());
    }
}
