use serde::Serialize;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
pub(crate) const BACKEND_EDITION: &str = env!("EPUB_READER_BACKEND_EDITION");

const BUILD_PROFILE: &str = env!("EPUB_READER_BUILD_PROFILE");
const BUILD_TARGET: &str = env!("EPUB_READER_BUILD_TARGET");
const BUILD_DEBUG: &str = env!("EPUB_READER_BUILD_DEBUG");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildInfo {
    pub version: &'static str,
    pub edition: &'static str,
    pub protocol_version: u32,
    pub target: &'static str,
    pub profile: &'static str,
    pub debug: bool,
}

pub(crate) fn current() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        edition: BACKEND_EDITION,
        protocol_version: PROTOCOL_VERSION,
        target: BUILD_TARGET,
        profile: BUILD_PROFILE,
        debug: BUILD_DEBUG == "1",
    }
}

#[tauri::command]
pub(crate) fn app_build_info() -> BuildInfo {
    current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_info_contract::BackendEdition;

    #[test]
    fn edition_matches_compiled_feature() {
        let expected = if cfg!(feature = "ai") {
            BackendEdition::Ai.as_str()
        } else {
            BackendEdition::Core.as_str()
        };
        assert_eq!(BACKEND_EDITION, expected);
    }

    #[test]
    fn build_info_serializes_stable_wire_names_without_side_effects() {
        let value = serde_json::to_value(current()).unwrap();
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["edition"], BACKEND_EDITION);
        assert_eq!(value["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(value["target"], BUILD_TARGET);
        assert_eq!(value["profile"], BUILD_PROFILE);
        assert_eq!(value["debug"], BUILD_DEBUG == "1");
        assert!(value.get("protocol_version").is_none());
    }
}
