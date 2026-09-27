//! Import cancellation/commit arbitration for the Android managed-import batch.
//!
//! This is intentionally small: it only arbitrates one already-registered
//! batch. File copying, staging, Tauri state and persistence live in
//! `linked_library`.
//!
//! See `docs/tasks/active/android-backend-design.md` (not imported by product
//! code) for the surrounding pipeline.

use std::sync::atomic::{AtomicU8, Ordering};

const PREPARING: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTING: u8 = 2;
const FINISHED: u8 = 3;

#[derive(Debug)]
pub(crate) struct ImportGate(AtomicU8);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CancelReply {
    Requested,
    TooLate,
    Finished,
}

impl Default for ImportGate {
    fn default() -> Self {
        Self(AtomicU8::new(PREPARING))
    }
}

impl ImportGate {
    /// `Requested` only means cancellation won the pre-commit race. The main
    /// import task still has to finish reading, clean staging and release busy.
    pub(crate) fn cancel(&self) -> CancelReply {
        match self
            .0
            .compare_exchange(PREPARING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) | Err(CANCELLED) => CancelReply::Requested,
            Err(COMMITTING) => CancelReply::TooLate,
            Err(FINISHED) => CancelReply::Finished,
            Err(_) => unreachable!("private state invariant"),
        }
    }

    /// Checked between blocking read operations and after a successful copy.
    /// It cannot interrupt an already-blocked provider read.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire) == CANCELLED
    }

    /// Called by the single import worker after it re-reads the latest small
    /// indexes under the library write lock. Obtaining a permit is the only
    /// gate that allows the first permanent rename.
    #[must_use]
    pub(crate) fn begin_commit(&self) -> Option<CommitPermit<'_>> {
        self.0
            .compare_exchange(PREPARING, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| CommitPermit(self))
    }

    /// Called when the batch will not commit (all failed or cancelled after
    /// preparation). The caller must already have cleaned its staging files.
    pub(crate) fn finish_preparing(&self) -> bool {
        match self
            .0
            .compare_exchange(PREPARING, FINISHED, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => false,
            Err(CANCELLED) => {
                self.0.store(FINISHED, Ordering::Release);
                true
            }
            Err(_) => unreachable!("only the preparation owner may finish here"),
        }
    }
}

/// Not a disk transaction. Dropping the permit (including on an I/O error)
/// closes the cancellation window; the actual success/failure is reported by
/// the caller's I/O result.
#[must_use]
pub(crate) struct CommitPermit<'a>(&'a ImportGate);

impl Drop for CommitPermit<'_> {
    fn drop(&mut self) {
        self.0 .0.store(FINISHED, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn cancel_before_commit_prevents_all_permanent_writes() {
        let gate = ImportGate::default();
        assert_eq!(gate.cancel(), CancelReply::Requested);
        assert_eq!(gate.cancel(), CancelReply::Requested);
        assert!(gate.begin_commit().is_none());
        assert!(gate.is_cancelled());
        assert!(gate.finish_preparing());
        assert_eq!(gate.cancel(), CancelReply::Finished);
    }

    #[test]
    fn late_cancel_cannot_relabel_a_committed_batch() {
        let gate = ImportGate::default();
        let permit = gate.begin_commit().unwrap();
        assert_eq!(gate.cancel(), CancelReply::TooLate);
        assert!(!gate.is_cancelled());
        assert!(gate.begin_commit().is_none());
        drop(permit);
        assert_eq!(gate.cancel(), CancelReply::Finished);
    }

    #[test]
    fn io_failure_closes_gate_but_preserves_error() {
        let gate = ImportGate::default();
        fn commit(gate: &ImportGate) -> Result<(), &'static str> {
            let _permit = gate.begin_commit().unwrap();
            Err("records write failed after bindings were saved")
        }
        assert!(commit(&gate).is_err());
        assert_eq!(gate.cancel(), CancelReply::Finished);
    }

    #[test]
    fn preparation_can_finish_without_publishing() {
        let gate = ImportGate::default();
        assert!(!gate.finish_preparing());
        assert!(gate.begin_commit().is_none());
        assert_eq!(gate.cancel(), CancelReply::Finished);
    }

    #[test]
    fn racing_cancel_and_commit_cannot_both_win() {
        let gate = ImportGate::default();
        let barrier = Barrier::new(2);
        std::thread::scope(|scope| {
            let cancel = scope.spawn(|| {
                barrier.wait();
                gate.cancel()
            });
            barrier.wait();
            let permit = gate.begin_commit();
            let reply = cancel.join().unwrap();
            match permit {
                Some(_permit) => assert_eq!(reply, CancelReply::TooLate),
                None => {
                    assert_eq!(reply, CancelReply::Requested);
                    assert!(gate.finish_preparing());
                }
            }
        });
    }
}
