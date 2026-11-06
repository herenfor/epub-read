//! Opt-in fallback for machines whose DMA-BUF presentation path cannot paint.
//! This does not disable compositing, detect GPU brands or change reader layout.

use std::ffi::OsStr;

pub(crate) const COMPATIBILITY_FLAG: &str = "--graphics-compatibility";
const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

pub(crate) fn requested(args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> bool {
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == OsStr::new(COMPATIBILITY_FLAG))
}

pub(crate) fn prepare() {
    if requested(std::env::args_os()) {
        // Run before GTK/WebKit or any Tauri plugins are initialized.
        std::env::set_var(DISABLE_DMABUF, "1");
    }
}

fn mode_from_overrides(overrides: impl IntoIterator<Item = Option<String>>) -> &'static str {
    if overrides
        .into_iter()
        .any(|value| value.as_deref() == Some("1"))
    {
        "enabled"
    } else {
        "default"
    }
}

/// Configured rendering fallback, not proof of the actual GPU or frame rate.
pub(crate) fn compatibility_mode() -> &'static str {
    mode_from_overrides(
        [
            DISABLE_DMABUF,
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "WEBKIT_DMABUF_RENDERER_DISABLE_GBM",
            "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
        ]
        .map(|key| std::env::var(key).ok()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_requires_an_exact_launch_argument() {
        assert!(requested([
            "epub-reader",
            COMPATIBILITY_FLAG,
            "/books/a.epub"
        ]));
        assert!(!requested([COMPATIBILITY_FLAG]));
        assert!(!requested([
            "epub-reader",
            "/books/--graphics-compatibility.epub"
        ]));
        assert!(!requested([
            "epub-reader",
            "--graphics-compatibility=false"
        ]));
    }

    #[test]
    fn ordinary_launch_reports_the_default_without_claiming_acceleration() {
        assert_eq!(
            mode_from_overrides([None, Some("0".into()), None, None]),
            "default"
        );
    }

    #[test]
    fn known_fallbacks_are_reported_without_exposing_environment_values() {
        for index in 0..4 {
            let mut values = [None, None, None, None];
            values[index] = Some("1".into());
            assert_eq!(mode_from_overrides(values), "enabled");
        }
        assert_eq!(
            mode_from_overrides([Some("/private/value".into())]),
            "default"
        );
    }
}
