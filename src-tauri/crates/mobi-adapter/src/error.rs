//! Stable machine-readable error codes and the crate error type.

use std::fmt;
use std::io;

/// Stable error categories for callers that map machine codes to UI strings.
///
/// The string values are part of the adapter contract. ER-0141 may translate
/// them, but must not invent a different meaning for the same code.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum MobiErrorCode {
    /// Source or temporary-file I/O failed.
    Io,
    /// The bounded source was empty, disappeared, or changed length.
    Source,
    /// The file is a MOBI/PalmDB file but its records or rawml could not be parsed.
    Parse,
    /// A recognized but unsupported representation (AZW4/Replica, dictionary, version).
    Unsupported,
    /// Any non-zero PalmDOC encryption value, including type 1/2/other.
    Encrypted,
    /// Print Replica / AZW4.
    Replica,
    /// Dictionary with an orthographic index.
    Dictionary,
    /// A configured byte/part budget was exceeded.
    Budget,
    /// The caller's cancellation token was set at a checkpoint.
    Cancelled,
    /// Writing or persisting the temporary EPUB failed.
    Output,
    /// The reconstructed archive has no OPF package document.
    NoOpf,
    /// Allocation or an internal bridge invariant failed.
    Memory,
    /// A bug or an invalid adapter state.
    Internal,
}

impl MobiErrorCode {
    /// Stock machine code. Use this exact value in logs and UI mapping.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Io => "mobi.io",
            Self::Source => "mobi.source",
            Self::Parse => "mobi.parse",
            Self::Unsupported => "mobi.unsupported",
            Self::Encrypted => "mobi.encrypted",
            Self::Replica => "mobi.replica",
            Self::Dictionary => "mobi.dictionary",
            Self::Budget => "mobi.budget",
            Self::Cancelled => "mobi.cancelled",
            Self::Output => "mobi.output",
            Self::NoOpf => "mobi.no_opf",
            Self::Memory => "mobi.memory",
            Self::Internal => "mobi.internal",
        }
    }
}

impl fmt::Display for MobiErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Adapter error with a stable code and a human-readable detail.
#[derive(Debug)]
pub struct MobiError {
    code: MobiErrorCode,
    message: String,
}

impl MobiError {
    pub fn new(code: MobiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> MobiErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn io(context: &str, error: io::Error) -> Self {
        Self::new(MobiErrorCode::Io, format!("{context}: {error}"))
    }

    pub(crate) fn source(message: impl Into<String>) -> Self {
        Self::new(MobiErrorCode::Source, message)
    }

    pub(crate) fn parse(message: impl Into<String>) -> Self {
        Self::new(MobiErrorCode::Parse, message)
    }

    pub(crate) fn budget(message: impl Into<String>) -> Self {
        Self::new(MobiErrorCode::Budget, message)
    }

    pub(crate) fn cancelled() -> Self {
        Self::new(MobiErrorCode::Cancelled, "conversion was cancelled")
    }

    pub(crate) fn output(context: &str, error: impl fmt::Display) -> Self {
        Self::new(MobiErrorCode::Output, format!("{context}: {error}"))
    }

    pub(crate) fn no_opf() -> Self {
        Self::new(
            MobiErrorCode::NoOpf,
            "reconstructed MOBI has no OPF package document",
        )
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new(MobiErrorCode::Internal, message)
    }
}

impl fmt::Display for MobiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MobiError {}

impl From<io::Error> for MobiError {
    fn from(error: io::Error) -> Self {
        Self::io("I/O", error)
    }
}

impl From<zip::result::ZipError> for MobiError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::output("EPUB ZIP", error)
    }
}

pub type Result<T> = std::result::Result<T, MobiError>;

pub(crate) fn from_c_code(raw: i32) -> MobiError {
    let code = match raw {
        1 => MobiErrorCode::Io,
        2 => MobiErrorCode::Memory,
        3 => MobiErrorCode::Parse,
        4 => MobiErrorCode::Unsupported,
        5 => MobiErrorCode::Encrypted,
        6 => MobiErrorCode::Replica,
        7 => MobiErrorCode::Dictionary,
        10 => MobiErrorCode::Unsupported,
        _ => MobiErrorCode::Internal,
    };
    let message = match code {
        MobiErrorCode::Memory => "libmobi could not allocate memory".to_string(),
        MobiErrorCode::Encrypted => {
            "MOBI is encrypted (non-zero encryption type); decryption is unsupported".to_string()
        }
        MobiErrorCode::Replica => "MOBI Print Replica/AZW4 is unsupported".to_string(),
        MobiErrorCode::Dictionary => "MOBI dictionaries are unsupported".to_string(),
        MobiErrorCode::Unsupported => "MOBI representation is unsupported".to_string(),
        _ => format!("libmobi bridge returned code {raw}"),
    };
    MobiError::new(code, message)
}
