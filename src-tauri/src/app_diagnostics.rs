//! User-requested environment facts. No library, credentials, paths or logs.
use crate::{app_update::InstallKind, build_info};
use serde::Serialize;

#[derive(Serialize)]
struct RuntimeInfo {
    name: &'static str,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinuxSession {
    display: &'static str,
    source: &'static str,
    wsl: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppDiagnostics {
    schema_version: u32,
    build: build_info::BuildInfo,
    platform: &'static str,
    arch: &'static str,
    distribution_channel: &'static str,
    runtime: RuntimeInfo,
    linux_session: Option<LinuxSession>,
    compatibility_mode: &'static str,
}

fn current(kind: InstallKind) -> AppDiagnostics {
    let platform = std::env::consts::OS;
    let runtime_name = match platform {
        "linux" => "WebKitGTK",
        "windows" => "WebView2",
        "android" => "Android WebView",
        "macos" | "ios" => "WKWebView",
        _ => "unknown",
    };
    #[cfg(target_os = "linux")]
    // These library-version getters have no preconditions or GTK object access.
    let version = Some(unsafe {
        format!(
            "{}.{}.{}",
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version()
        )
    });
    #[cfg(not(target_os = "linux"))]
    let version = None;
    AppDiagnostics {
        schema_version: 1,
        build: build_info::current(),
        platform: match platform {
            "windows" | "android" | "linux" | "macos" | "ios" => platform,
            _ => "unknown",
        },
        arch: std::env::consts::ARCH,
        distribution_channel: match kind {
            InstallKind::Installer => "installer",
            InstallKind::Portable => "portable",
            _ => "unknown",
        },
        runtime: RuntimeInfo {
            name: runtime_name,
            version,
        },
        linux_session: None,
        compatibility_mode: {
            #[cfg(target_os = "linux")]
            { crate::linux_graphics::compatibility_mode() }
            #[cfg(not(target_os = "linux"))]
            { "unavailable" }
        },
    }
}

#[cfg(target_os = "linux")]
fn session(display_type: Option<&str>, wsl: bool) -> LinuxSession {
    LinuxSession {
        display: match display_type {
            Some("GdkWaylandDisplay") => "wayland",
            Some("GdkX11Display") => "x11",
            _ => "unknown",
        },
        source: if display_type.is_some() {
            "native"
        } else {
            "unavailable"
        },
        wsl,
    }
}

#[tauri::command]
pub(crate) async fn app_diagnostics(
    _window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> AppDiagnostics {
    use tauri::Manager;
    let facts = current(*app.state::<InstallKind>());
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let mut facts = facts;
        // Presence only. Neither variable's path/name is copied to the DTO.
        let wsl = std::env::var_os("WSL_INTEROP").is_some()
            || std::env::var_os("WSL_DISTRO_NAME").is_some();
        let (send, receive) = tokio::sync::oneshot::channel();
        if _window
            .with_webview(move |platform| {
                let display = platform.inner().display();
                let _ = send.send(session(Some(display.type_().name()), wsl));
            })
            .is_ok()
        {
            facts.linux_session = Some(receive.await.unwrap_or_else(|_| session(None, wsl)));
        } else {
            facts.linux_session = Some(session(None, wsl));
        }
        facts
    }
    #[cfg(not(target_os = "linux"))]
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_serialization_keeps_the_public_contract_and_build_handshake() {
        let value = serde_json::to_value(current(InstallKind::Unsupported)).unwrap();
        let keys: Vec<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "arch",
                "build",
                "compatibilityMode",
                "distributionChannel",
                "linuxSession",
                "platform",
                "runtime",
                "schemaVersion"
            ]
        );
        assert_eq!(
            value["build"],
            serde_json::to_value(build_info::current()).unwrap()
        );
        assert_eq!(value["distributionChannel"], "unknown");
        #[cfg(target_os = "linux")]
        assert_eq!(value["compatibilityMode"], crate::linux_graphics::compatibility_mode());
        #[cfg(not(target_os = "linux"))]
        assert_eq!(value["compatibilityMode"], "unavailable");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn diagnostics_session_uses_native_display_not_raw_environment_strings() {
        assert_eq!(session(Some("GdkWaylandDisplay"), true).display, "wayland");
        assert_eq!(session(Some("GdkX11Display"), false).display, "x11");
        let unknown =
            serde_json::to_string(&session(Some("/private/display/socket"), true)).unwrap();
        assert!(!unknown.contains("/private"));
        assert!(unknown.contains("unknown"));
        assert_eq!(session(None, false).source, "unavailable");
    }
}
