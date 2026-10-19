//! Installation policy, independent of the registry, filesystem and Tauri.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallKind {
    Installer,
    Portable,
    Android,
    Unsupported,
}

impl InstallKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Installer => "installer",
            Self::Portable => "portable",
            Self::Android => "android",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Platform {
    Windows,
    Android,
    Other,
}

pub(crate) struct InstallEvidence<'a> {
    pub platform: Platform,
    pub core: bool,
    pub development: bool,
    pub test_mode: bool,
    pub identifier: &'a str,
    pub executable_directory: Option<&'a str>,
    pub uninstaller_present: bool,
    pub registered_directory: Option<&'a str>,
}

// NSIS quotes InstallLocation; canonicalized Windows paths can also carry the
// extended-length prefix. The IO boundary resolves aliases before this policy.
fn windows_directory(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    let value = value.replace('/', "\\");
    let value = value
        .strip_prefix("\\\\?\\UNC\\")
        .map(|v| format!("\\\\{v}"))
        .unwrap_or_else(|| value.strip_prefix("\\\\?\\").unwrap_or(&value).to_owned());
    value.trim_end_matches('\\').to_ascii_lowercase()
}

pub(crate) fn classify(evidence: &InstallEvidence<'_>) -> InstallKind {
    if !evidence.core || (evidence.development && !evidence.test_mode) {
        return InstallKind::Unsupported;
    }
    match evidence.platform {
        Platform::Windows => {
            if evidence.identifier != "dev.epubreader.app" && !evidence.test_mode {
                return InstallKind::Unsupported;
            }
            let registered = evidence
                .registered_directory
                .zip(evidence.executable_directory)
                .is_some_and(|(registered, current)| {
                    !registered.trim().is_empty()
                        && windows_directory(registered) == windows_directory(current)
                });
            if evidence.uninstaller_present && registered {
                InstallKind::Installer
            } else {
                InstallKind::Portable
            }
        }
        Platform::Android => {
            if evidence.identifier == "dev.herenfor.epubreader"
                || (evidence.test_mode && evidence.identifier == "dev.herenfor.epubreader.debug")
            {
                InstallKind::Android
            } else {
                InstallKind::Unsupported
            }
        }
        Platform::Other => InstallKind::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> InstallEvidence<'static> {
        InstallEvidence {
            platform: Platform::Windows,
            core: true,
            development: false,
            test_mode: false,
            identifier: "dev.epubreader.app",
            executable_directory: Some(r"\\?\C:\Users\A\EPUB Reader"),
            uninstaller_present: true,
            registered_directory: Some(r#""c:\Users\A\EPUB Reader\""#),
        }
    }

    #[test]
    fn installer_requires_both_the_uninstaller_and_same_registered_directory() {
        let mut value = installed();
        assert_eq!(classify(&value), InstallKind::Installer);
        value.uninstaller_present = false;
        assert_eq!(classify(&value), InstallKind::Portable);
        value.uninstaller_present = true;
        value.registered_directory = Some(r"C:\Other");
        assert_eq!(classify(&value), InstallKind::Portable);
        value.registered_directory = None;
        assert_eq!(classify(&value), InstallKind::Portable);
    }

    #[test]
    fn development_and_ai_do_not_gain_updater_access() {
        let mut value = installed();
        value.development = true;
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.test_mode = true;
        assert_eq!(classify(&value), InstallKind::Installer);
        value.uninstaller_present = false;
        assert_eq!(classify(&value), InstallKind::Portable); // test flag never upgrades a portable copy.
        value.core = false;
        assert_eq!(classify(&value), InstallKind::Unsupported);
    }

    #[test]
    fn android_requires_its_own_identifier_and_release_or_explicit_test_mode() {
        let mut value = installed();
        value.platform = Platform::Android;
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.identifier = "dev.herenfor.epubreader";
        assert_eq!(classify(&value).as_str(), "android");
        value.development = true;
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.identifier = "dev.herenfor.epubreader.debug";
        value.test_mode = true;
        assert_eq!(classify(&value), InstallKind::Android);
        value.identifier = "another.application";
        assert_eq!(classify(&value), InstallKind::Unsupported);
    }

    #[test]
    fn unsupported_platform_never_registers_updater() {
        let mut value = installed();
        value.platform = Platform::Other;
        assert_eq!(classify(&value), InstallKind::Unsupported);
    }
}
