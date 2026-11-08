//! External book launch inbox. Notifications are hints; peek + explicit ack owns delivery.
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use std::collections::VecDeque;
#[cfg(not(target_os = "android"))]
use std::ffi::OsString;
#[cfg(not(target_os = "android"))]
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::Emitter;
#[cfg(not(target_os = "android"))]
use tauri::Manager;

#[cfg(desktop)]
pub const PENDING_EVENT: &str = "reader-external-open-pending";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum OpenSource {
    #[serde(rename = "path")]
    Path { path: String },
    #[serde(rename = "contentUri")]
    ContentUri { uri: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    request_id: String,
    source: OpenSource,
    file_name: Option<String>,
}

#[cfg(not(target_os = "android"))]
#[derive(Default)]
struct Inbox {
    next_id: u64,
    pending: VecDeque<OpenRequest>,
}

#[cfg(not(target_os = "android"))]
impl Inbox {
    fn push(&mut self, path: PathBuf) -> bool {
        let source = OpenSource::Path {
            path: path.to_string_lossy().into_owned(),
        };
        if self.pending.iter().any(|item| item.source == source) {
            return false;
        }
        self.next_id += 1;
        self.pending.push_back(OpenRequest {
            request_id: format!("desktop-{}", self.next_id),
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            source,
        });
        true
    }

    fn ack(&mut self, id: &str) -> bool {
        if self
            .pending
            .front()
            .is_some_and(|item| item.request_id == id)
        {
            self.pending.pop_front();
            true
        } else {
            false
        }
    }
}

#[cfg(not(target_os = "android"))]
#[derive(Default)]
pub struct ExternalOpenState(Mutex<Inbox>);

/// Both initial argv and single-instance argv include argv[0]. Paths need not exist
/// here: the existing import pipeline reports unreadable/changed/invalid books.
/// OS file-association registration is unchanged; this only accepts a source
/// the platform already handed to the process.
#[cfg(not(target_os = "android"))]
fn book_arguments(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let text = arg.to_string_lossy();
            if text.starts_with('-') {
                return None;
            }
            let path = if text.starts_with("file:") {
                tauri::Url::parse(&text).ok()?.to_file_path().ok()?
            } else if text.contains("://") {
                return None;
            } else {
                PathBuf::from(&arg)
            };
            if !path.extension().is_some_and(|ext| {
                matches!(
                    ext.to_string_lossy().to_ascii_lowercase().as_str(),
                    "epub" | "mobi" | "azw3"
                )
            }) {
                return None;
            }
            Some(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        })
        .collect()
}

/// No disk I/O on the activation thread. Cold launches are retained before JS subscribes.
#[cfg(desktop)]
pub fn capture_arguments(
    app: &tauri::AppHandle,
    args: impl IntoIterator<Item = OsString>,
    cwd: &Path,
) {
    let paths = book_arguments(args, cwd);
    let state = app.state::<ExternalOpenState>();
    let changed = if let Ok(mut inbox) = state.0.lock() {
        paths
            .into_iter()
            .fold(false, |changed, path| inbox.push(path) || changed)
    } else {
        false
    };
    if changed {
        let _ = app.emit(PENDING_EVENT, ());
    }
}

#[tauri::command]
pub async fn external_open_peek(app: tauri::AppHandle) -> Result<Option<OpenRequest>, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::peek(&app))
            .await
            .map_err(|_| "external-open-worker-failed".to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let state = app.state::<ExternalOpenState>();
        let inbox = state
            .0
            .lock()
            .map_err(|_| "external-open-state-unavailable".to_string())?;
        Ok(inbox.pending.front().cloned())
    }
}

#[tauri::command]
pub async fn external_open_ack(app: tauri::AppHandle, request_id: String) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || android::ack(&app, &request_id))
            .await
            .map_err(|_| "external-open-worker-failed".to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let state = app.state::<ExternalOpenState>();
        let mut inbox = state
            .0
            .lock()
            .map_err(|_| "external-open-state-unavailable".to_string())?;
        Ok(inbox.ack(&request_id))
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::OpenRequest;
    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    struct ExternalOpen<R: Runtime>(PluginHandle<R>);
    #[derive(Deserialize)]
    struct Peek {
        request: Option<OpenRequest>,
    }
    #[derive(Deserialize)]
    struct Ack {
        acknowledged: bool,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AckArgs<'a> {
        request_id: &'a str,
    }

    pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("externalOpen")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("dev.herenfor.epubreader", "ExternalOpenPlugin")?;
                app.manage(ExternalOpen(handle));
                Ok(())
            })
            .build()
    }
    pub fn peek<R: Runtime>(app: &AppHandle<R>) -> Result<Option<OpenRequest>, String> {
        app.state::<ExternalOpen<R>>()
            .0
            .run_mobile_plugin::<Peek>("peek", ())
            .map(|value| value.request)
            .map_err(|_| "external-open-native-unavailable".to_string())
    }
    pub fn ack<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<bool, String> {
        app.state::<ExternalOpen<R>>()
            .0
            .run_mobile_plugin::<Ack>("ack", AckArgs { request_id: id })
            .map(|value| value.acknowledged)
            .map_err(|_| "external-open-native-unavailable".to_string())
    }
}
#[cfg(target_os = "android")]
pub use android::plugin;

#[cfg(all(test, not(target_os = "android")))]
mod external_open_tests {
    use super::*;

    #[test]
    fn argv_keeps_unicode_spaces_and_relative_paths_without_accepting_other_inputs() {
        let cwd = std::env::temp_dir();
        let absolute = cwd.join("一本 书.EPUB");
        let url = tauri::Url::from_file_path(&absolute).unwrap().to_string();
        let args = [
            "reader",
            "--inspect",
            "file.txt",
            "https://host/book.epub",
            "../next.epub",
            "../next.mobi",
            "../next.azw3",
            &url,
        ]
        .into_iter()
        .map(OsString::from);
        assert_eq!(
            book_arguments(args, &cwd),
            vec![
                cwd.join("../next.epub"),
                cwd.join("../next.mobi"),
                cwd.join("../next.azw3"),
                absolute,
            ]
        );
    }

    #[test]
    fn pending_is_not_drained_by_reads_and_only_current_ack_can_remove_it() {
        let mut inbox = Inbox::default();
        let a = PathBuf::from("a.epub");
        assert!(inbox.push(a.clone()));
        assert!(!inbox.push(a.clone()));
        let first = inbox.pending.front().cloned().unwrap();
        assert!(inbox.push(PathBuf::from("b.epub")));
        assert!(!inbox.ack("desktop-2"));
        assert_eq!(inbox.pending.front(), Some(&first));
        assert!(inbox.ack(&first.request_id));
        assert!(!inbox.ack(&first.request_id));
        assert_eq!(inbox.pending.front().unwrap().request_id, "desktop-2");
        assert!(inbox.push(a)); // A fresh user action after ack is legitimate.
        assert_eq!(inbox.pending.len(), 2);
    }
}
