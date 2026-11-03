//! M3 core prototype, NOT a registered Tauri command.
//! Caller verifies the opened source and supplies the existing snapshot guard.
//! Use the project's zip 2.4.2, serde and serde_json; no new ZIP decoder/unsafe.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Take, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, Sender, SyncSender},
    Arc, Mutex,
};
use zip::ZipArchive;

pub const CHUNK_BYTES: usize = 512 * 1024;
pub const DIRECTORY_PAGE_BYTES: usize = 64 * 1024;
const DIRECTORY_PAGE_ENTRIES: usize = 512;

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

#[derive(Clone, Deserialize, Serialize)]
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
    CompactDirectory { reply: Reply<Vec<u8>> },
    Read { index: usize, offset: u64, reply: Reply<Vec<u8>> },
    Close,
}

const COMPACT_DIRECTORY_JSON_MAX: usize = 4 * 1024 * 1024;

// An optional transport optimization. Each tuple has the same semantics as
// one paged row, without repeating field names on the wire.
fn compact_directory(entries: &[Entry]) -> Vec<u8> {
    let mut json = vec![b'['];
    for (i, row) in entries.iter().enumerate() {
        if i != 0 { json.push(b','); }
        if serde_json::to_writer(&mut json, &(row.entry_index, &row.name, row.compressed_bytes, row.expanded_bytes)).is_err()
            || json.len() >= COMPACT_DIRECTORY_JSON_MAX
        {
            return Vec::new();
        }
    }
    json.push(b']');
    let mut writer = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    if writer.write_all(&json).is_err() { return Vec::new(); }
    writer.finish().ok().filter(|bytes| bytes.len() <= CHUNK_BYTES).unwrap_or_default()
}

fn send_compact_directory(entries: &[Entry], guard: &Guard, reply: Reply<Vec<u8>>) {
    let result = guard().and_then(|_| {
        let bytes = compact_directory(entries);
        guard()?;
        Ok(bytes)
    });
    let _ = reply.send(result);
}

const MAX_STORED_INDEX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
struct StoredEntry {
    entry: Entry,
    data_offset: u64,
    crc: u32,
}

fn load_stored_index(path: &Path, archive_size: u64) -> Option<Vec<StoredEntry>> {
    let mut bytes = Vec::new();
    File::open(path).ok()?.take((MAX_STORED_INDEX_BYTES + 1) as u64)
        .read_to_end(&mut bytes).ok()?;
    if bytes.len() <= 32 || bytes.len() > MAX_STORED_INDEX_BYTES {
        return None;
    }
    let (checksum, json) = bytes.split_at(32);
    if Sha256::digest(json).as_slice() != checksum {
        return None;
    }
    let entries: Vec<StoredEntry> = serde_json::from_slice(json).ok()?;
    if entries.is_empty()
        || entries.windows(2).any(|w| w[0].entry.entry_index >= w[1].entry.entry_index)
        || entries.iter().any(|item| item.entry.compressed_bytes != item.entry.expanded_bytes
            || item.data_offset.checked_add(item.entry.expanded_bytes).is_none_or(|end| end > archive_size))
    {
        return None;
    }
    Some(entries)
}

fn encode_stored_index(rows: &[StoredEntry]) -> Option<Vec<u8>> {
    let json = serde_json::to_vec(rows).ok()?;
    if json.len() + 32 > MAX_STORED_INDEX_BYTES {
        return None;
    }
    let mut bytes = Sha256::digest(&json).to_vec();
    bytes.extend(json);
    Some(bytes)
}

enum ArchiveEntries {
    Zip(ZipArchive<File>),
    Stored { file: File, entries: Vec<StoredEntry> },
}

struct StoredRead<'a> {
    file: Take<&'a mut File>,
    crc: flate2::Crc,
    expected_crc: u32,
}

impl Read for StoredRead<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let n = self.file.read(bytes)?;
        self.crc.update(&bytes[..n]);
        if n == 0 && self.file.limit() == 0 && self.crc.sum() != self.expected_crc {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(n)
    }
}

impl ArchiveEntries {
    fn open(&mut self, index: usize) -> Result<(u64, Box<dyn Read + '_>), Fault> {
        match self {
            Self::Zip(zip) => {
                let entry = zip.by_index(index).map_err(|_| Fault::InvalidArchive)?;
                if entry.is_dir() {
                    return Err(Fault::InvalidArchive);
                }
                Ok((entry.size(), Box::new(entry)))
            }
            Self::Stored { file, entries } => {
                let row = entries.binary_search_by_key(&index, |row| row.entry.entry_index)
                    .ok().and_then(|i| entries.get(i)).ok_or(Fault::InvalidArchive)?;
                let size = row.entry.expanded_bytes;
                file.seek(SeekFrom::Start(row.data_offset)).map_err(|_| Fault::Io)?;
                Ok((size, Box::new(StoredRead {
                    file: file.take(size), crc: flate2::Crc::new(), expected_crc: row.crc,
                })))
            }
        }
    }
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
        Self::from_verified_file_indexed(file, unchanged, None)
    }

    /// Only a caller with a strong source receipt may reuse the stored index.
    pub(crate) fn from_verified_file_indexed(
        file: File,
        unchanged: impl Fn() -> Result<(), Fault> + Send + 'static,
        index: Option<(PathBuf, bool)>,
    ) -> Result<Self, Fault> {
        unchanged()?;
        let cached = index.as_ref().filter(|(_, reuse)| *reuse)
            .and_then(|(path, _)| load_stored_index(path, file.metadata().ok()?.len()));
        let mut publish = None;
        let (archive, entries) = if let Some(rows) = cached {
            let entries = rows.iter().map(|row| row.entry.clone()).collect::<Vec<_>>();
            (ArchiveEntries::Stored { file, entries: rows }, entries)
        } else {
            let mut zip = ZipArchive::new(file).map_err(|_| Fault::InvalidArchive)?;
            let mut entries = Vec::new();
            let mut stored = index.is_some() && zip.len() >= 512;
            let mut rows = Vec::new();
            for i in 0..zip.len() {
                let entry = zip.by_index_raw(i).map_err(|_| Fault::InvalidArchive)?;
                if entry.is_dir() {
                    continue;
                }
                let row = Entry {
                    entry_index: i,
                    name: entry.name().to_owned(),
                    compressed_bytes: entry.compressed_size(),
                    expanded_bytes: entry.size(),
                };
                stored &= entry.compression() == zip::CompressionMethod::Stored
                    && !entry.encrypted() && row.compressed_bytes == row.expanded_bytes
                    && row.name != "META-INF/container.xml";
                if stored {
                    rows.push(StoredEntry { entry: row.clone(), data_offset: entry.data_start(), crc: entry.crc32() });
                }
                entries.push(row);
            }
            if let Some((path, _)) = index.filter(|_| stored && !rows.is_empty()) {
                publish = Some((path, rows));
            }
            (ArchiveEntries::Zip(zip), entries)
        };
        unchanged()?;
        let entry_count = entries.len();
        let (tx, rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancelled);
        std::thread::Builder::new()
            .name("epub-zip".into())
            .spawn(move || {
                serve(archive, entries, Box::new(unchanged), rx, &worker_cancel);
                worker_cancel.store(true, Ordering::Release);
            })
            .map_err(|_| Fault::Io)?;
        if let Some((path, rows)) = publish {
            // This derived data never gates a reader open.
            let _ = std::thread::Builder::new().name("comic-index-save".into()).spawn(move || {
                if let Some(bytes) = encode_stored_index(&rows) {
                    let _ = crate::linked_library::atomic_write_bytes(&path, &bytes);
                }
            });
        }
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

    pub fn compact_directory(&self) -> Result<Vec<u8>, Fault> {
        self.request(|reply| Command::CompactDirectory { reply })
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
    mut archive: ArchiveEntries,
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
            Command::CompactDirectory { reply } => {
                send_compact_directory(&entries, &guard, reply);
                continue;
            }
            Command::Read { index, offset: 0, reply } => (index, reply),
            Command::Read { reply, .. } => {
                let _ = reply.send(Err(Fault::InvalidRequest));
                continue;
            }
        };
        let (size, mut entry) = match archive.open(index) {
            Ok(entry) => entry,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
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
                Command::CompactDirectory { reply } => send_compact_directory(&entries, &guard, reply),
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
    fn stored_index_hit_checks_crc_and_invalid_index_falls_back() {
        let (file, path, data) = fixture(zip::CompressionMethod::Stored);
        let scratch = tempfile::tempdir().unwrap();
        let index = scratch.path().join("index");
        let mut zip = ZipArchive::new(file).unwrap();
        let entry = zip.by_index_raw(0).unwrap();
        let row = StoredEntry {
            entry: Entry { entry_index: 0, name: entry.name().to_owned(),
                compressed_bytes: entry.compressed_size(), expanded_bytes: entry.size() },
            data_offset: entry.data_start(),
            crc: entry.crc32(),
        };
        let offset = row.data_offset;
        drop(entry);
        std::fs::write(&index, encode_stored_index(&[row]).unwrap()).unwrap();
        let session = NativeZipSession::from_verified_file_indexed(
            File::open(&path).unwrap(), || Ok(()), Some((index.clone(), true)),
        ).unwrap();
        assert_eq!(session.entry_count, 1);
        assert_eq!(session.read_chunk(0, 0).unwrap(), data[..CHUNK_BYTES]);
        session.close();

        let mut raw = std::fs::read(&path).unwrap();
        raw[offset as usize] ^= 1;
        std::fs::write(&path, raw).unwrap();
        let session = NativeZipSession::from_verified_file_indexed(
            File::open(&path).unwrap(), || Ok(()), Some((index.clone(), true)),
        ).unwrap();
        session.read_chunk(0, 0).unwrap();
        session.read_chunk(0, CHUNK_BYTES as u64).unwrap();
        assert_eq!(session.read_chunk(0, (CHUNK_BYTES * 2) as u64), Err(Fault::CorruptEntry));

        let mut bad = std::fs::read(&index).unwrap();
        bad[0] ^= 1;
        std::fs::write(&index, bad).unwrap();
        let session = NativeZipSession::from_verified_file_indexed(
            File::open(&path).unwrap(), || Ok(()), Some((index, true)),
        ).unwrap();
        assert_eq!(session.entry_count, 2);
        session.close();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn chunk_bound_empty_entry_and_persistent_deflate_cursor() {
        let (file, path, data) = fixture(zip::CompressionMethod::Deflated);
        let session = NativeZipSession::from_verified_file(file, || Ok(())).unwrap();
        assert_eq!(session.entry_count, 2);
        let page = session.directory_page(0).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= DIRECTORY_PAGE_BYTES);
        let compact = session.compact_directory().unwrap();
        let mut decoder = flate2::read::ZlibDecoder::new(compact.as_slice());
        let mut json = String::new();
        decoder.read_to_string(&mut json).unwrap();
        let rows: Vec<(usize, String, u64, u64)> = serde_json::from_str(&json).unwrap();
        assert_eq!(rows[0], (page.entries[0].entry_index, page.entries[0].name.clone(),
            page.entries[0].compressed_bytes, page.entries[0].expanded_bytes));
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
    fn new_target_replaces_a_partially_read_entry() {
        let (file, path, data) = fixture(zip::CompressionMethod::Deflated);
        let session = NativeZipSession::from_verified_file(file, || Ok(())).unwrap();
        session.read_chunk(0, 0).unwrap();
        assert!(session.read_chunk(1, 0).unwrap().is_empty());
        assert_eq!(session.read_chunk(0, CHUNK_BYTES as u64), Err(Fault::InvalidRequest));
        assert_eq!(session.read_chunk(0, 0).unwrap(), data[..CHUNK_BYTES]);
        session.close();
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
