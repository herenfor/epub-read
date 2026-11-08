use super::*;
use crate::{native_zip_session::NativeZipSession, portable_state::ReadestTarget};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
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

pub(super) struct StoredTarget {
    pub token: String,
    pub target: ReadestTarget,
}
#[derive(Default)]
pub(super) struct SessionData {
    pub archive: Option<Arc<NativeZipSession>>,
    pub library: Option<JsonEntry>,
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
        let bytes = archive.read_chunk(index, offset).map_err(fault)?;
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
        if let Some(archive) = self
            .data
            .lock()
            .map_err(|_| error("storage-error", "迁入状态锁不可用"))?
            .archive
            .take()
        {
            archive.close();
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
        if *disposition != Disposition::Pending || !current() {
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
