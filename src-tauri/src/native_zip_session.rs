//! M3 core prototype, NOT a registered Tauri command.
//! Caller verifies the opened source and supplies the existing snapshot guard.
//! Use the project's zip 2.4.2, serde and serde_json; no new ZIP decoder/unsafe.

use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, Sender, SyncSender},
    Arc, Mutex,
};
use zip::ZipArchive;

pub const CHUNK_BYTES: usize = 512 * 1024;
pub const DIRECTORY_PAGE_BYTES: usize = 64 * 1024;
const DIRECTORY_PAGE_ENTRIES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Closed,
    InvalidRequest,
    InvalidArchive,
    CorruptEntry,
    SourceChanged,
    DirectoryTooLarge,
    Io,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub entry_index: usize,
    pub name: String,
    pub compressed_bytes: u64,
    pub expanded_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub entries: Vec<Entry>,
    pub next: Option<usize>,
}

type Reply<T> = SyncSender<Result<T, Fault>>;
type Guard = Box<dyn Fn() -> Result<(), Fault> + Send>;

enum Command {
    Directory { start: usize, reply: Reply<DirectoryPage> },
    Read { index: usize, offset: u64, reply: Reply<Vec<u8>> },
    Close,
}

/// Registry stores Arc<NativeZipSession> under an opaque, window-owned ID.
/// request_gate limits this session to one outstanding native request.
pub struct NativeZipSession {
    tx: Sender<Command>,
    cancelled: Arc<AtomicBool>,
    request_gate: Mutex<()>,
    pub entry_count: usize,
}

impl NativeZipSession {
    /// Called from spawn_blocking AFTER same-handle SHA-256 verification.
    /// `unchanged` uses a descriptor clone ONLY for metadata(), never seek/read.
    /// The original verified File is moved here and never reopened by path.
    pub fn from_verified_file(
        file: File,
        unchanged: impl Fn() -> Result<(), Fault> + Send + 'static,
    ) -> Result<Self, Fault> {
        unchanged()?;
        let mut zip = ZipArchive::new(file).map_err(|_| Fault::InvalidArchive)?;
        let mut entries = Vec::new();
        for index in 0..zip.len() {
            // Raw directory access MUST NOT instantiate/inflate a decoder.
            let entry = zip.by_index_raw(index).map_err(|_| Fault::InvalidArchive)?;
            if entry.is_dir() {
                continue;
            }
            entries.push(Entry {
                entry_index: index,
                name: entry.name().to_owned(),
                compressed_bytes: entry.compressed_size(),
                expanded_bytes: entry.size(),
            });
        }
        unchanged()?;
        let entry_count = entries.len();
        let (tx, rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancelled);
        std::thread::Builder::new()
            .name("epub-zip".into())
            .spawn(move || {
                serve(zip, entries, Box::new(unchanged), rx, &worker_cancel);
                worker_cancel.store(true, Ordering::Release);
            })
            .map_err(|_| Fault::Io)?;
        Ok(Self { tx, cancelled, request_gate: Mutex::new(()), entry_count })
    }

    fn request<T>(&self, command: impl FnOnce(Reply<T>) -> Command) -> Result<T, Fault> {
        let _gate = self.request_gate.lock().map_err(|_| Fault::Closed)?;
        if self.cancelled.load(Ordering::Acquire) {
            return Err(Fault::Closed);
        }
        let (reply, result) = mpsc::sync_channel(1);
        self.tx.send(command(reply)).map_err(|_| Fault::Closed)?;
        result.recv().map_err(|_| Fault::Closed)?
    }

    pub fn directory_page(&self, start: usize) -> Result<DirectoryPage, Fault> {
        self.request(|reply| Command::Directory { start, reply })
    }

    /// Offset 0 starts/restarts an entry; subsequent calls must be sequential.
    /// Raw response contains exactly min(CHUNK_BYTES, declared_size - offset).
    /// The last chunk is returned ONLY after EOF/CRC and snapshot validation.
    pub fn read_chunk(&self, index: usize, offset: u64) -> Result<Vec<u8>, Fault> {
        self.request(|reply| Command::Read { index, offset, reply })
    }

    /// Never waits for request_gate, decoder completion or thread join.
    pub fn close(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            let _ = self.tx.send(Command::Close);
        }
    }
}

impl Drop for NativeZipSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn directory_page(entries: &[Entry], start: usize) -> Result<DirectoryPage, Fault> {
    if start > entries.len() {
        return Err(Fault::InvalidRequest);
    }
    let mut page = DirectoryPage { entries: Vec::new(), next: None };
    // Reserve envelope/cursor overhead, including JSON escaping in each name.
    let mut bytes = 256;
    for entry in entries.iter().skip(start).take(DIRECTORY_PAGE_ENTRIES) {
        let encoded = serde_json::to_vec(entry).map_err(|_| Fault::InvalidArchive)?;
        if bytes + encoded.len() + 1 > DIRECTORY_PAGE_BYTES {
            break;
        }
        bytes += encoded.len() + 1;
        page.entries.push(entry.clone());
    }
    let end = start + page.entries.len();
    if end < entries.len() {
        if end == start {
            return Err(Fault::DirectoryTooLarge);
        }
        page.next = Some(end);
    }
    Ok(page)
}

fn send_directory(entries: &[Entry], start: usize, reply: Reply<DirectoryPage>, guard: &Guard) -> bool {
    if let Err(error) = guard() {
        let _ = reply.send(Err(error));
        return false;
    }
    let _ = reply.send(directory_page(entries, start));
    true
}

fn verified_chunk(
    entry: &mut impl Read,
    size: u64,
    offset: u64,
    guard: &Guard,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, Fault> {
    if cancelled.load(Ordering::Acquire) {
        return Err(Fault::Closed);
    }
    guard()?;
    let remaining = size.checked_sub(offset).ok_or(Fault::InvalidRequest)?;
    let len = remaining.min(CHUNK_BYTES as u64) as usize;
    let mut bytes = vec![0; len];
    entry.read_exact(&mut bytes).map_err(|_| Fault::CorruptEntry)?;
    if remaining == len as u64 {
        // read_exact(size) alone does NOT force ZIP's EOF/CRC validation.
        // Also checks empty entries, trailing output and an incorrect size.
        let mut extra = [0; 1];
        if entry.read(&mut extra).map_err(|_| Fault::CorruptEntry)? != 0 {
            return Err(Fault::CorruptEntry);
        }
    }
    guard()?;
    if cancelled.load(Ordering::Acquire) {
        return Err(Fault::Closed);
    }
    Ok(bytes)
}

fn serve(
    mut zip: ZipArchive<File>,
    entries: Vec<Entry>,
    guard: Guard,
    rx: Receiver<Command>,
    cancelled: &AtomicBool,
) {
    let mut pending = None;
    loop {
        let command = match pending.take().or_else(|| rx.recv().ok()) {
            Some(command) => command,
            None => return,
        };
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        let (index, reply) = match command {
            Command::Close => return,
            Command::Directory { start, reply } => {
                if !send_directory(&entries, start, reply, &guard) { return; }
                continue;
            }
            Command::Read { index, offset: 0, reply } => (index, reply),
            Command::Read { reply, .. } => {
                let _ = reply.send(Err(Fault::InvalidRequest));
                continue;
            }
        };
        let mut entry = match zip.by_index(index) {
            Ok(entry) if !entry.is_dir() => entry,
            _ => {
                let _ = reply.send(Err(Fault::InvalidArchive));
                return;
            }
        };
        let size = entry.size();
        let mut offset = 0;
        let mut current_reply = Some(reply);
        // Borrowed ZipFile lives on this stack, not in a self-referential struct.
        // Decoder state survives between pulls; entry/file drop on exit/close.
        loop {
            if let Some(reply) = current_reply.take() {
                let chunk = match verified_chunk(&mut entry, size, offset, &guard, cancelled) {
                    Ok(chunk) => chunk,
                    Err(error) => { let _ = reply.send(Err(error)); return; }
                };
                offset += chunk.len() as u64;
                if reply.send(Ok(chunk)).is_err() {
                    return;
                }
                if offset == size {
                    break;
                }
            }
            let command = match rx.recv() { Ok(command) => command, Err(_) => return };
            if cancelled.load(Ordering::Acquire) { return; }
            match command {
                Command::Close => return,
                Command::Directory { start, reply } => {
                    if !send_directory(&entries, start, reply, &guard) { return; }
                }
                Command::Read { index: next_index, offset: 0, reply } => {
                    // A cancelled caller can begin another resource without
                    // exhausting the abandoned entry or writing a temp file.
                    pending = Some(Command::Read { index: next_index, offset: 0, reply });
                    break;
                }
                Command::Read { index: next_index, offset: next_offset, reply }
                    if next_index == index && next_offset == offset => {
                    current_reply = Some(reply);
                }
                Command::Read { reply, .. } => {
                    let _ = reply.send(Err(Fault::InvalidRequest));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;

    fn fixture(method: zip::CompressionMethod) -> (File, std::path::PathBuf, Vec<u8>) {
        let path = std::env::temp_dir().join(format!("m3-core-{}-{}.zip", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let data: Vec<_> = (0..CHUNK_BYTES * 2 + 17).map(|i| (i % 251) as u8).collect();
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer.start_file("synthetic.bin", SimpleFileOptions::default().compression_method(method)).unwrap();
        writer.write_all(&data).unwrap();
        writer.start_file("empty", SimpleFileOptions::default()).unwrap();
        writer.finish().unwrap();
        (File::open(&path).unwrap(), path, data)
    }

    #[test]
    fn chunk_bound_empty_entry_and_persistent_deflate_cursor() {
        let (file, path, data) = fixture(zip::CompressionMethod::Deflated);
        let session = NativeZipSession::from_verified_file(file, || Ok(())).unwrap();
        assert_eq!(session.entry_count, 2);
        let page = session.directory_page(0).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= DIRECTORY_PAGE_BYTES);
        let mut actual = Vec::new();
        while actual.len() < data.len() {
            let chunk = session.read_chunk(0, actual.len() as u64).unwrap();
            assert!(chunk.len() <= CHUNK_BYTES);
            actual.extend(chunk);
        }
        assert_eq!(actual, data);
        assert!(session.read_chunk(1, 0).unwrap().is_empty());
        session.close();
        assert_eq!(session.read_chunk(0, 0), Err(Fault::Closed));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn last_chunk_checks_crc_and_never_reports_a_corrupt_entry_as_success() {
        let (file, path, _) = fixture(zip::CompressionMethod::Stored);
        let mut raw = std::fs::read(&path).unwrap();
        let central = raw.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        raw[central + 16] ^= 1; // Only synthetic CRC metadata is corrupted.
        std::fs::write(&path, raw).unwrap();
        let session = NativeZipSession::from_verified_file(file, || Ok(())).unwrap();
        session.read_chunk(0, 0).unwrap();
        session.read_chunk(0, CHUNK_BYTES as u64).unwrap();
        assert_eq!(session.read_chunk(0, (CHUNK_BYTES * 2) as u64), Err(Fault::CorruptEntry));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn changed_source_is_rejected_before_a_later_chunk() {
        let (file, path, _) = fixture(zip::CompressionMethod::Deflated);
        let changed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&changed);
        let session = NativeZipSession::from_verified_file(file, move || {
            if flag.load(Ordering::Acquire) { Err(Fault::SourceChanged) } else { Ok(()) }
        }).unwrap();
        session.read_chunk(0, 0).unwrap();
        changed.store(true, Ordering::Release);
        assert_eq!(session.read_chunk(0, CHUNK_BYTES as u64), Err(Fault::SourceChanged));
        std::fs::remove_file(path).unwrap();
    }
}
