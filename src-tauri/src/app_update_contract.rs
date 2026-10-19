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
    pub product_name: Option<&'a str>,
    pub executable_directory: Option<&'a str>,
    pub uninstaller_present: bool,
    pub registered_directory: Option<&'a str>,
}

/// Test mode selects a separate identity; it never grants access to a regular
/// install. Returning the name here also drives the actual registry lookup.
pub(crate) fn windows_product_name(
    identifier: &str,
    product_name: Option<&str>,
    test_mode: bool,
) -> Option<&'static str> {
    let (expected_identifier, expected_name) = if test_mode {
        ("dev.epubreader.updatetest", "EPUB Reader Update Test")
    } else {
        ("dev.epubreader.app", "EPUB Reader")
    };
    (identifier == expected_identifier && product_name == Some(expected_name))
        .then_some(expected_name)
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
            if windows_product_name(
                evidence.identifier,
                evidence.product_name,
                evidence.test_mode,
            )
            .is_none()
            {
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
            let supported = if evidence.test_mode {
                matches!(
                    evidence.identifier,
                    "dev.herenfor.epubreader.updatetest"
                        | "dev.herenfor.epubreader.updatetest.debug"
                )
            } else {
                evidence.identifier == "dev.herenfor.epubreader"
            };
            if supported {
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
            product_name: Some("EPUB Reader"),
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
        value.identifier = "dev.epubreader.updatetest";
        value.product_name = Some("EPUB Reader Update Test");
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
        value.identifier = "dev.herenfor.epubreader.updatetest.debug";
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

    #[test]
    fn isolated_windows_test_build_never_borrows_the_regular_application_identity() {
        let mut value = installed();
        value.test_mode = true;
        value.development = true;
        // The test switch must not enable updates over the user's real install.
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.identifier = "dev.epubreader.updatetest";
        // The selected name is used by windows_evidence, not only this predicate.
        assert_eq!(
            windows_product_name(value.identifier, value.product_name, true),
            None
        );
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.product_name = Some("EPUB Reader Update Test");
        assert_eq!(
            windows_product_name(value.identifier, value.product_name, true),
            Some("EPUB Reader Update Test")
        );
        value.executable_directory = Some(r"C:\Users\A\EPUB Reader Update Test");
        value.registered_directory = Some(r#""C:\Users\A\EPUB Reader Update Test""#);
        assert_eq!(classify(&value), InstallKind::Installer);
        value.uninstaller_present = false;
        assert_eq!(classify(&value), InstallKind::Portable);
        value.uninstaller_present = true;
        value.registered_directory = Some(r"C:\Users\A\EPUB Reader");
        assert_eq!(classify(&value), InstallKind::Portable);
        value.identifier = "another.application";
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.identifier = "dev.epubreader.updatetest";
        value.test_mode = false;
        value.development = false;
        assert_eq!(classify(&value), InstallKind::Unsupported);
    }

    #[test]
    fn isolated_android_test_identity_is_allowed_only_in_the_explicit_test_build() {
        let mut value = installed();
        value.platform = Platform::Android;
        value.identifier = "dev.herenfor.epubreader.updatetest";
        value.development = true;
        assert_eq!(classify(&value), InstallKind::Unsupported);
        value.test_mode = true;
        assert_eq!(classify(&value), InstallKind::Android);
        value.identifier = "dev.herenfor.epubreader.updatetest.debug";
        assert_eq!(classify(&value), InstallKind::Android);
        for identifier in [
            "dev.herenfor.epubreader",
            "dev.herenfor.epubreader.debug",
            "another.application",
        ] {
            value.identifier = identifier;
            assert_eq!(classify(&value), InstallKind::Unsupported);
        }
    }
}
