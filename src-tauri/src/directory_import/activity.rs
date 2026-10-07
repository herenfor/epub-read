//! Process-wide activity gate shared by the legacy/Android import path and the
//! directory-import job.
//!
//! The directory import is split across several IPC commands (scan, page,
//! start, dispose), so it cannot hold a scoped Rust mutex for the whole job.
//! Instead it acquires one owned guard for the lifetime of the job and stores
//! that guard in `DirectoryImportJob`.  Legacy managed/path imports acquire the
//! same gate for the duration of their import, so both entry points reject each
//! other instead of racing on the portable repository.

use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub(crate) struct ImportActivityState(Arc<Mutex<Option<String>>>);

/// Owned activity token.  Dropping it releases the slot only when this guard
/// still owns the current owner string; that keeps a stale guard from clearing
/// a newer import that somehow acquired the gate later.
#[derive(Debug)]
pub(crate) struct ImportActivityGuard {
    slot: Arc<Mutex<Option<String>>>,
    owner: String,
}

impl ImportActivityState {
    pub(crate) fn try_acquire(&self, owner: String) -> Result<ImportActivityGuard, String> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "导入活动门锁已损坏".to_string())?;
        if let Some(current) = slot.as_ref() {
            return Err(format!("busy: 已有导入进行中（{current}）"));
        }
        *slot = Some(owner.clone());
        Ok(ImportActivityGuard {
            slot: Arc::clone(&self.0),
            owner,
        })
    }

    pub(crate) fn is_busy(&self) -> Result<bool, String> {
        self.0
            .lock()
            .map(|slot| slot.is_some())
            .map_err(|_| "导入活动门锁已损坏".to_string())
    }
}

impl Drop for ImportActivityGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            if slot.as_deref() == Some(self.owner.as_str()) {
                *slot = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_activity_owner_blocks_another_until_dropped() {
        let state = ImportActivityState::default();
        let first = state.try_acquire("directory:one".to_string()).unwrap();
        assert!(state.is_busy().unwrap());
        assert!(state.try_acquire("managed:two".to_string()).is_err());
        drop(first);
        assert!(!state.is_busy().unwrap());
        let second = state.try_acquire("managed:two".to_string()).unwrap();
        assert!(state.is_busy().unwrap());
        drop(second);
        assert!(!state.is_busy().unwrap());
    }

    #[test]
    fn stale_guard_does_not_clear_a_new_owner() {
        let state = ImportActivityState::default();
        let first = state.try_acquire("directory:one".to_string()).unwrap();
        // Simulate a newer owner replacing the string without acquiring a new
        // guard; dropping the stale guard must not clear the new owner.
        *state.0.lock().unwrap() = Some("managed:two".to_string());
        drop(first);
        assert_eq!(state.0.lock().unwrap().as_deref(), Some("managed:two"));
        *state.0.lock().unwrap() = None;
        assert!(!state.is_busy().unwrap());
    }
}
