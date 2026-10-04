//! S2-N native LAN transfer base.
//!
//! One TLS 1.3 connection carries one existing `.epubsave` v3 archive. The
//! WebView only receives bounded status/progress events; archive bytes never
//! travel through JSON or a JS `Vec`. File/metadata work is delegated to the
//! existing F-N `SaveFileManager` and `save_file` service functions.

mod connection;
mod error;
mod manager;
mod pairing;
mod protocol;
mod session;
mod tls;

pub(crate) mod commands;

pub use manager::LanSaveManager;

#[cfg(test)]
mod tests;
