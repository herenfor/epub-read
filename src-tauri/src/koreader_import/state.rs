use super::*;
use crate::{portable_state::ReadestTarget, readest_import::source::Guard};
use crate::readest_import::ImportScope;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub(super) struct StoredTarget {
    pub token: String,
    pub target: ReadestTarget,
}

pub(super) struct SessionData {
    pub bytes: Vec<u8>,
    pub guard: Option<Guard>,
    pub fetched: bool,
    pub targets: BTreeMap<String, StoredTarget>,
}

impl Default for SessionData {
    fn default() -> Self {
        Self {
            bytes: Vec::new(),
            guard: None,
            fetched: false,
            targets: BTreeMap::new(),
        }
    }
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

    pub fn close(&self) -> PortableResult<&'static str> {
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
        if let Ok(mut data) = self.data.lock() {
            data.bytes.clear();
            data.guard.take();
        }
        Ok(result)
    }

    pub fn finish(
        &self,
        transaction: rusqlite::Transaction<'_>,
        current: &dyn Fn() -> bool,
        guards: &[Guard],
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
            guard().map_err(map_fault)?;
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
pub(crate) struct KoreaderImportState(Mutex<Option<Arc<Session>>>);

impl KoreaderImportState {
    pub(super) fn reserve(&self, id: String, scope: ImportScope) -> PortableResult<Arc<Session>> {
        if !crate::portable_state::valid_canonical_uuid(&id) {
            return Err(error("invalid-request", "sessionId 必须是规范 UUID"));
        }
        let mut slot = self
            .0
            .lock()
            .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
        if slot.is_some() {
            return Err(error("busy", "已有 KOReader 迁入正在进行"));
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
            .filter(|session| session.id == id)
            .cloned()
            .ok_or_else(|| error("session-closed", "KOReader 迁入会话不存在或已关闭"))
    }

    pub(super) fn close(&self, id: &str) -> PortableResult<&'static str> {
        let session = {
            let mut slot = self
                .0
                .lock()
                .map_err(|_| error("storage-error", "迁入会话锁不可用"))?;
            if slot.as_ref().is_some_and(|session| session.id == id) {
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

pub(super) fn accept_commit<'a>(
    data: &'a SessionData,
    book: &crate::portable_state::KoreaderProgressImport,
) -> PortableResult<&'a StoredTarget> {
    if !data.fetched {
        return Err(error("invalid-request", "请先读取侧车"));
    }
    data.targets
        .get(&book.book_hash)
        .filter(|stored| stored.token == book.target_token)
        .ok_or_else(|| error("stale-basis", "匹配令牌已失效，请重新预览"))
}
