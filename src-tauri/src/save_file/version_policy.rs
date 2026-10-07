//! SC-N explicit save-format and LAN-protocol readers.
//!
//! This is deliberately a tiny policy module: callers must choose a known
//! reader by exact version combination, then run that reader's strict decoder.
//! It is never `incoming <= current`, and unknown newer versions are not
//! decoded with the current DTO.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveReader {
    /// zipped `.epubsave` container 1 with portable state schema 3.
    Container1State3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VersionError {
    /// A format/container/state/protocol version newer than this binary knows.
    NeedsNewerApp,
    /// A known old or malformed version combination with no registered reader.
    UnsupportedFormat,
}

/// Select a ZIP archive reader by the exact container/state pair.
///
/// A future schema4 reader must be added as a new arm here. Do not turn this
/// into a range check: old values can be invalid and must not be silently
/// decoded by the current v3 reader.
pub(crate) fn select_archive_reader(
    container: u32,
    schema: u64,
) -> Result<ArchiveReader, VersionError> {
    match (container, schema) {
        (1, 3) => Ok(ArchiveReader::Container1State3),
        (container, schema) if container > 1 || schema > 3 => Err(VersionError::NeedsNewerApp),
        _ => Err(VersionError::UnsupportedFormat),
    }
}

/// Select the active LAN pairing protocol version.
///
/// v1 was explicitly rejected and never had an adapter. v2 stays the only
/// registered protocol; a real v3 requires its own implemented receiver and
/// direction-limited compatibility mode, not just a constant bump.
pub(crate) fn select_lan_version(version: u32) -> Result<(), VersionError> {
    match version {
        2 => Ok(()),
        version if version > 2 => Err(VersionError::NeedsNewerApp),
        _ => Err(VersionError::UnsupportedFormat),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_use_exact_registered_versions() {
        assert_eq!(
            select_archive_reader(1, 3),
            Ok(ArchiveReader::Container1State3)
        );
        assert_eq!(
            select_archive_reader(2, 3),
            Err(VersionError::NeedsNewerApp)
        );
        assert_eq!(
            select_archive_reader(1, 4),
            Err(VersionError::NeedsNewerApp)
        );
        assert_eq!(
            select_archive_reader(1, 2),
            Err(VersionError::UnsupportedFormat)
        );
        assert_eq!(select_lan_version(2), Ok(()));
        assert_eq!(select_lan_version(3), Err(VersionError::NeedsNewerApp));
        assert_eq!(select_lan_version(1), Err(VersionError::UnsupportedFormat));
        assert_eq!(select_lan_version(0), Err(VersionError::UnsupportedFormat));
    }
}
