//! Small bounded-import policies migrated from the FI-N prototype.
//!
//! This is deliberately not a second import engine.  The real coordinator owns
//! worker lifetime and commit batching; these values only make its admission
//! and cancellation rules unit-testable.

use std::collections::BTreeMap;
use std::sync::Mutex;

/// Admission counts BOTH running work and completed results waiting on the
/// head.  Without this window a slow first book permits unlimited later staging.
pub struct OrderedWindow<T> {
    total: usize,
    width: usize,
    dispatched: usize,
    consumed: usize,
    ready: BTreeMap<usize, T>,
}

impl<T> OrderedWindow<T> {
    pub fn new(total: usize, width: usize) -> Self {
        assert!(width > 0);
        Self {
            total,
            width,
            dispatched: 0,
            consumed: 0,
            ready: BTreeMap::new(),
        }
    }

    pub fn next_to_dispatch(&self) -> Option<usize> {
        if self.dispatched == self.total || self.dispatched - self.consumed >= self.width {
            None
        } else {
            Some(self.dispatched)
        }
    }

    /// Call after a worker slot and byte-budget permit have become available.
    pub fn dispatch(&mut self) -> Option<usize> {
        let index = self.next_to_dispatch()?;
        self.dispatched += 1;
        Some(index)
    }

    pub fn complete(&mut self, index: usize, result: T) {
        assert!(index >= self.consumed && index < self.dispatched);
        assert!(self.ready.insert(index, result).is_none());
    }

    /// `T` must carry success/failure; an error still advances the ordered lane.
    pub fn pop_next(&mut self) -> Option<(usize, T)> {
        let result = self.ready.remove(&self.consumed)?;
        let index = self.consumed;
        self.consumed += 1;
        Some((index, result))
    }

    pub fn finished(&self) -> bool {
        self.consumed == self.total
    }
}

/// Reserve staging bytes before dispatch; unknown-size and oversized sources
/// run alone.  This is a staging budget, NOT an EPUB size cap or RAM estimate.
pub struct StageBudget {
    limit: u64,
    used: u64,
    active: usize,
}

#[derive(Clone)]
pub struct Reservation {
    bytes: u64,
}

impl StageBudget {
    pub fn new(limit: u64) -> Self {
        assert!(limit > 0);
        Self {
            limit,
            used: 0,
            active: 0,
        }
    }

    pub fn reserve(&mut self, known_size: Option<u64>) -> Option<Reservation> {
        let bytes = known_size.unwrap_or(self.limit).max(1);
        let available = if bytes >= self.limit {
            self.active == 0
        } else {
            self.used <= self.limit - bytes
        };
        if !available {
            return None;
        }
        self.used += bytes;
        self.active += 1;
        Some(Reservation { bytes })
    }

    /// Release only after publish/duplicate removal/failure cleanup, NOT after
    /// hash.  The coordinator calls this on every terminal path.
    pub fn release(&mut self, reservation: Reservation) {
        self.used -= reservation.bytes;
        self.active -= 1;
    }

    pub fn used(&self) -> u64 {
        self.used
    }
}

#[derive(Default, Debug)]
struct JobState {
    cancel_requested: bool,
    committing: bool,
    finished: bool,
}

#[derive(Default)]
pub struct DirectoryJobGate(Mutex<JobState>);

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CancelReply {
    Requested,
    Settling,
    AlreadyFinished,
}

impl DirectoryJobGate {
    pub fn cancel(&self) -> CancelReply {
        let mut state = self.0.lock().unwrap();
        if state.finished {
            return CancelReply::AlreadyFinished;
        }
        state.cancel_requested = true;
        if state.committing {
            CancelReply::Settling
        } else {
            CancelReply::Requested
        }
    }

    pub fn cancelled(&self) -> bool {
        self.0.lock().unwrap().cancel_requested
    }

    /// Serialize admission against cancel.  Coordinator alone calls begin/end.
    pub fn begin_batch(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.finished || state.cancel_requested {
            return false;
        }
        assert!(!state.committing);
        state.committing = true;
        true
    }

    /// Must run on BOTH commit success and failure.
    pub fn end_batch(&self) {
        self.0.lock().unwrap().committing = false;
    }

    /// Owner calls after all workers exit and owned staging is cleaned.
    /// Idempotent so `dispose` can be repeated.
    pub fn finish(&self) {
        let mut state = self.0.lock().unwrap();
        state.committing = false;
        state.finished = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_window_blocks_head_and_advances_on_failure() {
        let mut window = OrderedWindow::new(4, 3);
        assert_eq!(window.next_to_dispatch(), Some(0));
        assert_eq!(window.dispatch(), Some(0));
        assert_eq!(window.dispatch(), Some(1));
        assert_eq!(window.dispatch(), Some(2));
        assert_eq!(window.dispatch(), None);

        window.complete(2, Ok::<_, ()>(2));
        window.complete(1, Ok(1));
        assert_eq!(window.pop_next(), None);
        window.complete(0, Err(()));
        assert_eq!(window.pop_next(), Some((0, Err(()))));
        assert_eq!(window.dispatch(), Some(3));
        assert_eq!(window.pop_next(), Some((1, Ok(1))));
        window.complete(3, Err(()));
        assert_eq!(window.pop_next(), Some((2, Ok(2))));
        assert_eq!(window.pop_next(), Some((3, Err(()))));
        assert!(window.finished());
    }

    #[test]
    fn stage_budget_singleton_rules_and_release() {
        let mut budget = StageBudget::new(64);
        let small = budget.reserve(Some(32)).unwrap();
        assert!(budget.reserve(Some(100)).is_none());
        budget.release(small);

        let big = budget.reserve(Some(100)).unwrap();
        assert!(budget.reserve(Some(1)).is_none());
        budget.release(big);

        let unknown = budget.reserve(None).unwrap();
        assert!(budget.reserve(Some(1)).is_none());
        budget.release(unknown);

        let one = budget.reserve(Some(1)).unwrap();
        let two = budget.reserve(Some(2)).unwrap();
        assert_eq!(budget.used(), 3);
        budget.release(one);
        budget.release(two);
        assert_eq!(budget.used(), 0);
    }

    #[test]
    fn directory_job_gate_distinguishes_cancel_states() {
        let job = DirectoryJobGate::default();
        assert!(job.begin_batch());
        assert_eq!(job.cancel(), CancelReply::Settling);
        assert!(job.cancelled());
        job.end_batch();
        assert!(!job.begin_batch());
        assert_eq!(job.cancel(), CancelReply::Requested);
        job.finish();
        assert_eq!(job.cancel(), CancelReply::AlreadyFinished);
    }
}
