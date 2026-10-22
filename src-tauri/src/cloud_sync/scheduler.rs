//! Small single-flight scheduling policy. Timers belong to the service.
use super::model::{Failure, Trigger};

#[derive(Default)]
pub struct Schedule {
    pub running: bool,
    pub due_at: Option<u64>,
    pub pending: bool,
    pub blocked: bool,
    pub retry_at: Option<u64>,
    failures: usize,
    last_progress: Option<u64>,
    manual: bool,
}

impl Schedule {
    pub fn cancel(&mut self) {
        let (blocked, last_progress) = (self.blocked, self.last_progress);
        *self = Self::default();
        self.blocked = blocked;
        self.last_progress = last_progress;
    }
    pub fn request(&mut self, trigger: Trigger, now: u64) {
        let manual = trigger == Trigger::Manual;
        if manual {
            self.blocked = false;
            self.retry_at = None;
            self.failures = 0;
            self.manual = true;
        }
        if self.blocked {
            return;
        }
        let due = match trigger {
            Trigger::Startup => now.saturating_add(5_000),
            Trigger::DataChanged => now.saturating_add(3_000),
            Trigger::ProgressChanged => now.saturating_add(3_000).max(
                self.last_progress
                    .map_or(0, |last| last.saturating_add(60_000)),
            ),
            Trigger::Foreground => {
                self.retry_at = None;
                self.failures = 0;
                now
            }
            _ => now,
        }
        .max(self.retry_at.unwrap_or(0));
        // Quiet-window updates extend only other delayed change requests. An
        // explicit immediate request is never pushed back by page progress.
        self.due_at = Some(match self.due_at {
            Some(old) if old <= now || self.manual => old.min(due),
            Some(old) if matches!(trigger, Trigger::DataChanged | Trigger::ProgressChanged) => {
                old.max(due)
            }
            Some(old) => old.min(due),
            None => due,
        });
        self.pending = true;
    }

    pub fn start(&mut self, now: u64) -> bool {
        if self.running || !self.pending || self.blocked || self.due_at.is_none_or(|due| due > now)
        {
            return false;
        }
        self.running = true;
        self.pending = false;
        self.due_at = None;
        self.manual = false;
        // All successful rounds publish current progress, regardless of trigger.
        self.last_progress = Some(now);
        true
    }

    pub fn finish(&mut self, now: u64, failure: Option<&Failure>) {
        self.running = false;
        match failure {
            None => {
                self.failures = 0;
                self.retry_at = None;
            }
            Some(_) if self.manual && self.pending => {
                self.blocked = false;
                self.retry_at = None;
                self.due_at = Some(now);
                self.failures = 0;
            }
            Some(error) if error.code == super::model::FailureCode::Cancelled => {
                self.pending = true;
                self.due_at = Some(now);
            }
            Some(error) if error.retryable() => {
                let delay = [60, 300, 900, 3600][self.failures.min(3)];
                self.failures = self.failures.saturating_add(1);
                let server = error
                    .remote
                    .as_ref()
                    .and_then(|e| e.retry_after_seconds)
                    .unwrap_or(0);
                let due = now.saturating_add(delay.max(server).saturating_mul(1000));
                self.retry_at = Some(due);
                self.due_at = Some(due);
                self.pending = true;
            }
            Some(_) => {
                self.blocked = true;
                self.pending = false;
                self.due_at = None;
                self.retry_at = None;
            }
        }
    }
}
