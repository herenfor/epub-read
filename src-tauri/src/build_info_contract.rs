#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendEdition {
    Core,
    Ai,
}

impl BackendEdition {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Ai => "ai",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BuildConfigError {
    ConflictingFeatures,
    InvalidExpectedEdition,
    MissingExpectedEdition,
    EditionMismatch {
        expected: BackendEdition,
        actual: BackendEdition,
    },
}

impl std::fmt::Display for BuildConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConflictingFeatures => {
                formatter.write_str("core and ai features are mutually exclusive")
            }
            Self::InvalidExpectedEdition => {
                formatter.write_str("EPUB_READER_EXPECTED_EDITION must be core or ai")
            }
            Self::MissingExpectedEdition => {
                formatter.write_str("release builds require EPUB_READER_EXPECTED_EDITION")
            }
            Self::EditionMismatch { expected, actual } => write!(
                formatter,
                "expected {} edition but Cargo features select {}",
                expected.as_str(),
                actual.as_str()
            ),
        }
    }
}

pub(crate) fn resolve_backend_edition(
    ai_feature: bool,
    core_feature: bool,
    debug: bool,
    expected: Option<&str>,
) -> Result<BackendEdition, BuildConfigError> {
    if ai_feature && core_feature {
        return Err(BuildConfigError::ConflictingFeatures);
    }
    let actual = if ai_feature {
        BackendEdition::Ai
    } else {
        BackendEdition::Core
    };
    let Some(expected) = expected.map(str::trim) else {
        return if debug {
            Ok(actual)
        } else {
            Err(BuildConfigError::MissingExpectedEdition)
        };
    };
    let expected = if expected.eq_ignore_ascii_case("core") {
        BackendEdition::Core
    } else if expected.eq_ignore_ascii_case("ai") {
        BackendEdition::Ai
    } else {
        return Err(BuildConfigError::InvalidExpectedEdition);
    };
    if expected != actual {
        return Err(BuildConfigError::EditionMismatch { expected, actual });
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_feature_defaults_to_core_in_debug() {
        assert_eq!(
            resolve_backend_edition(false, false, true, None).unwrap(),
            BackendEdition::Core
        );
    }

    #[test]
    fn release_requires_an_explicit_expected_edition() {
        assert_eq!(
            resolve_backend_edition(false, false, false, None),
            Err(BuildConfigError::MissingExpectedEdition)
        );
    }

    #[test]
    fn conflicting_features_are_rejected_before_expected_value() {
        assert_eq!(
            resolve_backend_edition(true, true, true, Some("ai")),
            Err(BuildConfigError::ConflictingFeatures)
        );
    }

    #[test]
    fn invalid_and_mismatched_expected_editions_are_rejected() {
        assert_eq!(
            resolve_backend_edition(true, false, false, Some("preview")),
            Err(BuildConfigError::InvalidExpectedEdition)
        );
        assert_eq!(
            resolve_backend_edition(true, false, false, Some("core")),
            Err(BuildConfigError::EditionMismatch {
                expected: BackendEdition::Core,
                actual: BackendEdition::Ai,
            })
        );
    }

    #[test]
    fn matching_expected_edition_is_accepted_case_insensitively() {
        assert_eq!(
            resolve_backend_edition(false, true, false, Some(" CORE ")).unwrap(),
            BackendEdition::Core
        );
        assert_eq!(
            resolve_backend_edition(true, false, false, Some("Ai")).unwrap(),
            BackendEdition::Ai
        );
    }
}
