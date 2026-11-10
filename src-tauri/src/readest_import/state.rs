use super::*;
use crate::{native_zip_session::NativeZipSession, portable_state::ReadestTarget};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub(super) const LIBRARY_LIMIT: u64 = 64 * 1024 * 1024;
pub(super) const CONFIG_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ImportScope {
    Public,
    Private { session_id: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsonEntry {
    pub entry_index: usize,
    pub bytes: u64,
}

/// Where the session reads from: a backup ZIP, or Readest's own library folder
/// (entry index -> JSON file).
#[derive(Clone)]
pub(super) enum Origin {
    Zip(Arc<NativeZipSession>),
    Folder(Arc<BTreeMap<usize, PathBuf>>),
}
#[derive(Clone)]
pub(super) enum BookAt {
    Zip(usize),
    File(PathBuf),
}
/// The original book file Readest keeps next to a book's `config.json`.
#[derive(Clone)]
pub(super) struct BookFile {
    pub name: String,
    pub bytes: u64,
    pub at: BookAt,
}

pub(super) struct StoredTarget {
    pub token: String,
    pub partial_md5: String,
    pub target: ReadestTarget,
}
#[derive(Default)]
pub(super) struct SessionData {
    pub archive: Option<Origin>,
    pub library: Option<JsonEntry>,
    pub books: BTreeMap<String, BookFile>,
    /// Folder sources only: one JSON file held from its stable read to its last chunk.
    pub cache: BTreeMap<usize, Arc<Vec<u8>>>,
    pub staging: Option<PathBuf>,
    pub staged: u64,
    pub prepared: BTreeMap<String, Arc<super::intake::Prepared>>,
    pub configs: BTreeMap<String, JsonEntry>,
    pub entries: BTreeMap<usize, (JsonEntry, Option<String>)>,
    pub configs_read: BTreeSet<String>,
    pub targets: BTreeMap<String, StoredTarget>,
}

#[derive(PartialEq, Eq)]
enum Disposition {
    Pending,
    Cancelled,
    Committed,
}
pub(super) struct Session {
    pub id: String,
    pub scope: ImportScope,
    pub cancelled: AtomicBool,
    pub data: Mutex<SessionData>,
    commit_gate: Mutex<Disposition>,
}
impl Session {
    fn new(id: String, scope: ImportScope) -> Self {
        Self {
            id,
            scope,
            cancelled: AtomicBool::new(false),
            data: Mutex::new(SessionData::default()),
            commit_gate: Mutex::new(Disposition::Pending),
        }
    }
    pub fn check(&self) -> PortableResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(error("cancelled", "迁入已取消"))
        } else {
            Ok(())
        }
    }
    pub fn read_json(&self, index: usize, offset: u64) -> PortableResult<Vec<u8>> {
        self.check()?;
        let (archive, entry, config) = {
            let data = self
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            let (entry, config) = data
                .entries
                .get(&index)
                .ok_or_else(|| error("invalid-request", "只允许读取书目和单书配置"))?;
            if entry.bytes
                > if config.is_some() {
                    CONFIG_LIMIT
                } else {
                    LIBRARY_LIMIT
                }
            {
                return Err(error("too-large", "JSON 条目超出读取上限"));
            }
            (
                data.archive
                    .clone()
                    .ok_or_else(|| error("not-ready", "备份尚未打开"))?,
                entry.clone(),
                config.clone(),
            )
        };
        let bytes = match archive {
            Origin::Zip(archive) => archive.read_chunk(index, offset).map_err(fault)?,
            Origin::Folder(paths) => self.folder_chunk(&paths, index, offset, &entry, config.is_some())?,
        };
        self.check()?;
        if offset + bytes.len() as u64 == entry.bytes {
            if let Some(hash) = config {
                self.data
                    .lock()
                    .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
                    .configs_read
                    .insert(hash);
            }
        }
        Ok(bytes)
    }
    /// Loads one folder JSON file with a before/after snapshot and keeps it until read to EOF.
    pub fn hold(&self, index: usize, path: &std::path::Path, config: bool) -> PortableResult<Arc<Vec<u8>>> {
        let limit = if config { CONFIG_LIMIT } else { LIBRARY_LIMIT };
        let bytes = Arc::new(folder::read_stable(path, limit, &|| self.check())?);
        let mut data = self
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
        if data.cache.len() >= 4 {
            data.cache.clear();
        }
        data.cache.insert(index, bytes.clone());
        Ok(bytes)
    }
    fn folder_chunk(
        &self,
        paths: &BTreeMap<usize, PathBuf>,
        index: usize,
        offset: u64,
        entry: &JsonEntry,
        config: bool,
    ) -> PortableResult<Vec<u8>> {
        let held = self
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
            .cache
            .get(&index)
            .cloned();
        let bytes = match held {
            Some(bytes) => bytes,
            None if offset == 0 => {
                let path = paths
                    .get(&index)
                    .ok_or_else(|| error("invalid-request", "只允许读取书目和单书配置"))?;
                self.hold(index, path, config)?
            }
            None => return Err(error("invalid-request", "备份读取范围无效")),
        };
        // The size the caller was told is the contract; Readest rewrote the file otherwise.
        if bytes.len() as u64 != entry.bytes {
            return Err(error("source-changed", "Readest 正在改动这份资料，请稍后重试"));
        }
        if offset > entry.bytes {
            return Err(error("invalid-request", "备份读取范围无效"));
        }
        let start = offset as usize;
        let end = (start + crate::native_zip_session::CHUNK_BYTES).min(bytes.len());
        if end == bytes.len() {
            self.data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
                .cache
                .remove(&index);
        }
        Ok(bytes[start..end].to_vec())
    }
    /// A folder config is re-read when asked for, so its size is the one about to be served.
    pub fn config_entry(&self, hash: &str) -> PortableResult<Option<JsonEntry>> {
        let (entry, path) = {
            let data = self
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            let Some(entry) = data.configs.get(hash).cloned() else {
                return Ok(None);
            };
            let path = match &data.archive {
                Some(Origin::Folder(paths)) => paths.get(&entry.entry_index).cloned(),
                _ => None,
            };
            (entry, path)
        };
        let Some(path) = path else {
            return Ok(Some(entry));
        };
        let bytes = self.hold(entry.entry_index, &path, true)?;
        let fresh = JsonEntry {
            entry_index: entry.entry_index,
            bytes: bytes.len() as u64,
        };
        let mut data = self
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
        data.configs.insert(hash.to_owned(), fresh.clone());
        data.entries
            .insert(fresh.entry_index, (fresh.clone(), Some(hash.to_owned())));
        Ok(Some(fresh))
    }
    /// Removes extracted book files; the session can stage again afterwards.
    pub fn discard_staged(&self) -> PortableResult<()> {
        let staging = self
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入状态锁不可用"))?
            .staging
            .clone();
        if let Some(dir) = staging {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(error("storage-error", "无法清理迁入临时文件")),
            }
        }
        Ok(())
    }
    pub fn close(&self) -> PortableResult<&'static str> {
        // Same gate as SQLite commit: accepted cancellation rolls back, or the
        // caller explicitly learns the transaction already committed.
        let mut disposition = self
            .commit_gate
            .lock()
            .map_err(|_| error("storage-error", "迁入状态锁不可用"))?;
        let result = if *disposition == Disposition::Committed {
            "committed"
        } else {
            *disposition = Disposition::Cancelled;
            "closed"
        };
        self.cancelled.store(true, Ordering::Release);
        drop(disposition);
        let (archive, staging) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| error("storage-error", "迁入状态锁不可用"))?;
            data.cache.clear();
            (data.archive.take(), data.staging.take())
        };
        if let Some(Origin::Zip(archive)) = archive {
            archive.close();
        }
        if let Some(dir) = staging {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(result)
    }
    pub fn finish(
        &self,
        transaction: rusqlite::Transaction<'_>,
        current: &dyn Fn() -> bool,
        guards: &[source::Guard],
    ) -> PortableResult<()> {
        let mut disposition = self
            .commit_gate
            .lock()
            .map_err(|_| error("storage-error", "迁入状态锁不可用"))?;
        // A large library commits in several batches; only cancellation closes the gate.
        if *disposition == Disposition::Cancelled || !current() {
            return Err(error("cancelled", "迁入已取消或书架已锁定"));
        }
        self.check()?;
        for guard in guards {
            guard().map_err(fault)?;
        }
        if !current() {
            return Err(error("locked", "书架已锁定"));
        }
        self.check()?;
        transaction.commit()?;
        *disposition = Disposition::Committed;
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct ReadestImportState(Mutex<Option<Arc<Session>>>);
impl ReadestImportState {
    pub(super) fn reserve(&self, id: String, scope: ImportScope) -> PortableResult<Arc<Session>> {
        if !crate::portable_state::valid_canonical_uuid(&id) {
            return Err(error("invalid-request", "sessionId 必须是规范 UUID"));
        }
        let mut slot = self
            .0
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
        if slot.is_some() {
            return Err(error("busy", "已有 Readest 迁入正在进行"));
        }
        let session = Arc::new(Session::new(id, scope));
        *slot = Some(session.clone());
        Ok(session)
    }
    pub(super) fn get(&self, id: &str) -> PortableResult<Arc<Session>> {
        self.0
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| error("session-closed", "Readest 迁入会话不存在或已关闭"))
    }
    pub(super) fn close(&self, id: &str) -> PortableResult<&'static str> {
        let session = {
            let mut slot = self
                .0
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            if slot.as_ref().is_some_and(|s| s.id == id) {
                slot.take()
            } else {
                None
            }
        };
        match session {
            Some(session) => session.close(),
            None => Ok("not-found"),
        }
    }
    pub fn shutdown(&self) {
        let session = self.0.lock().ok().and_then(|mut slot| slot.take());
        if let Some(session) = session {
            let _ = session.close();
        }
    }
}

/// A matching token is scoped to both the local bytes and the Readest book identity.
pub(super) fn matched_target<'a>(data: &'a SessionData, book: &crate::portable_state::ReadestBookImport) -> PortableResult<&'a ReadestTarget> {
    let stored = data.targets.get(&book.book_hash).filter(|target| target.token == book.target_token)
        .ok_or_else(|| error("stale-basis", "匹配令牌已失效，请重新预览"))?;
    if stored.partial_md5 != book.readest_hash {
        return Err(error("source-mismatch", "原书与 Readest 指纹不符"));
    }
    Ok(&stored.target)
}
