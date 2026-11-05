//! Native recovery for an abnormal WebKit content-process exit.
//!
//! Restart only after user confirmation: a new host also releases native work
//! belonging to the lost JS session. Durable book/progress data is untouched.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("linux-webview-recovery")
        .on_webview_ready(|webview| {
            let app = webview.app_handle().clone();
            let parent = webview.window();
            let label = webview.label().to_owned();
            let installed = webview.with_webview(move |platform| {
                let prompt_open = Arc::new(AtomicBool::new(false));
                platform.inner().connect_web_process_terminated(move |_, reason| {
                    if reason == WebProcessTerminationReason::TerminatedByApi
                        || prompt_open.swap(true, Ordering::Relaxed)
                    {
                        return;
                    }
                    // Log only the engine reason, never the current URL/book.
                    eprintln!("linux-webview-recovery: content process terminated: {reason:?}");
                    let chinese = std::env::var("LC_ALL")
                        .ok().filter(|value| !value.is_empty())
                        .or_else(|| std::env::var("LANG").ok())
                        .is_some_and(|value| value.starts_with("zh"));
                    let (message, restart, quit) = if chinese {
                        (
                            "阅读界面进程已停止。最近保存的书架、进度和笔记仍会保留；尚未保存的操作可能丢失。重新启动 SeLis？",
                            "重新启动", "退出",
                        )
                    } else {
                        (
                            "The reading interface has stopped. Your last saved library, progress and notes are kept; unsaved changes may be lost. Restart SeLis?",
                            "Restart", "Quit",
                        )
                    };
                    let app = app.clone();
                    let label = label.clone();
                    // This GTK dialog is owned by the native host, not WebKit.
                    app.dialog().message(message)
                        .title("SeLis")
                        .kind(MessageDialogKind::Error)
                        .parent(&parent)
                        .buttons(MessageDialogButtons::OkCancelCustom(restart.into(), quit.into()))
                        .show(move |restart| {
                            if app.get_webview_window(&label).is_none() {
                                return;
                            }
                            if restart {
                                app.request_restart();
                            } else {
                                app.exit(0);
                            }
                        });
                });
            });
            if let Err(error) = installed {
                eprintln!("linux-webview-recovery: could not attach native handler: {error}");
            }
        })
        .build()
}
