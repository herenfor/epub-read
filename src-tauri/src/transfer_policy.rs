//! Shared archive and LAN transfer budgets, bounded metadata, and peer clocks.
//! No Tauri, filesystem probes, wire serialization or runtime threads live here.
use std::io::{self, Write};
use std::time::Duration;

pub const INVENTORY_CHUNK: usize = 128;
pub const STATE_JSON_LIMIT: u64 = 64 * 1024 * 1024;
pub const MANIFEST_JSON_LIMIT: u64 = 16 * 1024 * 1024;
pub const CONTROL_LIMIT: usize = 64 * 1024;
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
pub const PEER_IDLE: Duration = Duration::from_secs(45);
pub const USER_DECISION: Duration = Duration::from_secs(600);
const MIB: u64 = 1024 * 1024;
const MAX_WIRE_BYTES: u64 = 9_007_199_254_740_991;

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    InvalidSize,
    InsufficientSpace { required: u64, available: u64 },
    InvalidInventory,
    InvalidPhase,
    StaleSequence,
    Expired,
    InvalidSummary,
}

fn add(a: u64, b: u64) -> Result<u64, PolicyError> {
    a.checked_add(b)
        .filter(|n| *n <= MAX_WIRE_BYTES)
        .ok_or(PolicyError::InvalidSize)
}

/// Incremental bytes on ONE volume, excluding files already allocated there.
/// The margin is not a reservation; callers must still handle write failures.
#[derive(Debug, PartialEq, Eq)]
pub struct SpaceBudget {
    pub incremental_bytes: u64,
    pub required_free_bytes: u64,
}

impl SpaceBudget {
    pub fn for_incremental(bytes: u64) -> Result<Self, PolicyError> {
        if bytes > MAX_WIRE_BYTES {
            return Err(PolicyError::InvalidSize);
        }
        let margin = (bytes / 20).clamp(64 * MIB, 512 * MIB);
        Ok(Self {
            incremental_bytes: bytes,
            required_free_bytes: add(bytes, margin)?,
        })
    }

    /// Before Accept: one archive plus the declared attached EPUB bytes.
    /// No second archive copy is allowed in the owned LAN prepare path.
    pub fn receiving(archive_bytes: u64, book_bytes: u64) -> Result<Self, PolicyError> {
        if archive_bytes == 0 {
            return Err(PolicyError::InvalidSize);
        }
        Self::for_incremental(add(archive_bytes, book_bytes)?)
    }

    /// Before extracting: the archive is already allocated, count only EPUBs.
    pub fn extracting(book_bytes: u64) -> Result<Self, PolicyError> {
        Self::for_incremental(book_bytes)
    }

    /// Before export: metadata is serialized and bounded, EPUBs use Stored.
    /// Allow compression overhead and per-entry allocation/ZIP headers.
    pub fn exporting(
        book_bytes: u64,
        state_bytes: u64,
        manifest_bytes: u64,
        entries: u64,
    ) -> Result<Self, PolicyError> {
        if state_bytes > STATE_JSON_LIMIT || manifest_bytes > MANIFEST_JSON_LIMIT {
            return Err(PolicyError::InvalidSize);
        }
        let metadata = add(state_bytes, manifest_bytes)?;
        let overhead = entries.checked_mul(8192).ok_or(PolicyError::InvalidSize)?;
        Self::for_incremental(add(
            add(book_bytes, add(metadata, metadata)?)?,
            add(overhead, MIB)?,
        )?)
    }

    pub fn check(&self, available: u64) -> Result<(), PolicyError> {
        if available < self.required_free_bytes {
            Err(PolicyError::InsufficientSpace {
                required: self.required_free_bytes,
                available,
            })
        } else {
            Ok(())
        }
    }
}

/// Enforce metadata size BEFORE allocating beyond the limit.
/// Use with serde_json::to_writer; do not serialize to_vec then check its size.
pub struct BoundedBytes {
    bytes: Vec<u8>,
    limit: u64,
    exceeded: bool,
}

impl BoundedBytes {
    pub fn new(limit: u64) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            exceeded: false,
        }
    }
    pub fn exceeded(&self) -> bool {
        self.exceeded
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for BoundedBytes {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let size = (self.bytes.len() as u64).checked_add(data.len() as u64);
        if size.map_or(false, |size| size > self.limit) {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "metadata-too-large",
            ));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reply uses a positional bool mask: no repeated hash strings, no unknown IDs.
/// Caller pins sessionId/transferId and the only outstanding query before use.
pub fn validate_inventory_reply(
    expected_index: u64,
    received_index: u64,
    requested_count: usize,
    present: &[bool],
) -> Result<(), PolicyError> {
    if expected_index != received_index
        || !(1..=INVENTORY_CHUNK).contains(&requested_count)
        || present.len() != requested_count
    {
        return Err(PolicyError::InvalidInventory);
    }
    Ok(())
}

pub fn missing_indexes(present: &[bool]) -> impl Iterator<Item = usize> + '_ {
    present
        .iter()
        .enumerate()
        .filter_map(|(i, exists)| (!exists).then_some(i))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePhase {
    PreparingSend,
    Checking,
    Receiving,
    Preparing,
    Preview,
    Committing,
}

impl RemotePhase {
    fn may_follow(self, next: Self) -> bool {
        self == next
            || matches!(
                (self, next),
                (Self::Receiving, Self::Preparing)
                    | (Self::Preparing, Self::Preview)
                    | (Self::Preview, Self::Committing)
            )
    }
}

/// `now` is monotonic elapsed time from one local Instant, never peer wall time.
/// Valid heartbeats renew work liveness, but NEVER renew a Preview decision.
/// This clock covers preparing an Offer, a Checking exchange, or the flow
/// AFTER accepting an Offer. Destroy the preparing clock when Offer arrives.
/// Existing local Offer/Ready decision timers remain separate.
#[derive(Debug)]
pub struct RemoteWait {
    phase: RemotePhase,
    entered_at: Duration,
    last_seen: Duration,
    last_sequence: u64,
}

impl RemoteWait {
    pub fn new(phase: RemotePhase, now: Duration) -> Result<Self, PolicyError> {
        if !matches!(
            phase,
            RemotePhase::PreparingSend | RemotePhase::Checking | RemotePhase::Receiving
        ) {
            return Err(PolicyError::InvalidPhase);
        }
        Ok(Self {
            phase,
            entered_at: now,
            last_seen: now,
            last_sequence: 0,
        })
    }

    pub fn observe(
        &mut self,
        now: Duration,
        sequence: u64,
        phase: RemotePhase,
    ) -> Result<(), PolicyError> {
        if sequence <= self.last_sequence {
            return Err(PolicyError::StaleSequence);
        }
        if self.remaining(now).is_zero() {
            return Err(PolicyError::Expired);
        }
        if now < self.last_seen || !self.phase.may_follow(phase) {
            return Err(PolicyError::InvalidPhase);
        }
        if self.phase != phase {
            self.entered_at = now;
        }
        self.phase = phase;
        self.last_seen = now;
        self.last_sequence = sequence;
        Ok(())
    }

    pub fn remaining(&self, now: Duration) -> Duration {
        let (start, budget) = if self.phase == RemotePhase::Preview {
            (self.entered_at, USER_DECISION)
        } else {
            (self.last_seen, PEER_IDLE)
        };
        budget.saturating_sub(now.saturating_sub(start))
    }
}

/// Serialize via a deny_unknown_fields DTO in protocol.rs. Never add arrays.
/// The full local SaveFileCommitResult stays local for UI/repository refresh.
#[derive(Debug, PartialEq, Eq)]
pub struct CompactCommit {
    pub imported_book_count: u64,
    pub new_visible_book_count: u64,
    pub missing_book_count: u64,
    pub progress_conflict_book_count: u64,
    pub applied_preferences: bool,
}

impl CompactCommit {
    pub fn validate(
        &self,
        offered_book_count: u64,
        offered_preferences: bool,
    ) -> Result<(), PolicyError> {
        if offered_book_count > MAX_WIRE_BYTES
            || self.imported_book_count != offered_book_count
            || self.new_visible_book_count > self.imported_book_count
            || self.missing_book_count > self.imported_book_count
            || self.progress_conflict_book_count > self.imported_book_count
            || (self.applied_preferences && !offered_preferences)
        {
            return Err(PolicyError::InvalidSummary);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sec(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn space_counts_incremental_files_and_rejects_overflow() {
        let receive = SpaceBudget::receiving(10 * MIB, 10 * MIB).unwrap();
        assert_eq!(receive.incremental_bytes, 20 * MIB);
        assert_eq!(receive.required_free_bytes, 84 * MIB);
        assert!(receive.check(83 * MIB).is_err());
        assert!(receive.check(84 * MIB).is_ok());
        assert_eq!(
            SpaceBudget::extracting(10 * MIB).unwrap().incremental_bytes,
            10 * MIB
        );
        assert_eq!(
            SpaceBudget::receiving(MAX_WIRE_BYTES, 1),
            Err(PolicyError::InvalidSize)
        );
    }

    #[test]
    fn metadata_writer_rejects_before_appending() {
        let mut bytes = BoundedBytes::new(4);
        bytes.write_all(b"1234").unwrap();
        assert!(bytes.write_all(b"5").is_err());
        assert!(bytes.exceeded());
        assert_eq!(bytes.into_bytes(), b"1234");
    }

    #[test]
    fn inventory_matches_one_chunk_exactly() {
        validate_inventory_reply(7, 7, 3, &[true, false, true]).unwrap();
        assert_eq!(
            missing_indexes(&[true, false, true]).collect::<Vec<_>>(),
            vec![1]
        );
        assert!(validate_inventory_reply(7, 8, 3, &[true, false, true]).is_err());
        assert!(validate_inventory_reply(7, 7, 3, &[true]).is_err());
        assert!(validate_inventory_reply(7, 7, 129, &[true; 129]).is_err());
    }

    #[test]
    fn processing_can_exceed_ten_minutes_with_liveness() {
        let mut wait = RemoteWait::new(RemotePhase::Receiving, sec(0)).unwrap();
        wait.observe(sec(1), 1, RemotePhase::Preparing).unwrap();
        for i in 2..=200 {
            wait.observe(sec(i * 5), i, RemotePhase::Preparing).unwrap();
        }
        assert_eq!(wait.remaining(sec(1000)), PEER_IDLE);
        assert_eq!(wait.remaining(sec(1045)), Duration::ZERO);
        assert_eq!(
            wait.observe(sec(1045), 201, RemotePhase::Preparing),
            Err(PolicyError::Expired)
        );
    }

    #[test]
    fn preview_heartbeats_and_replays_do_not_extend_confirmation() {
        let mut wait = RemoteWait::new(RemotePhase::Receiving, sec(0)).unwrap();
        wait.observe(sec(1), 1, RemotePhase::Preparing).unwrap();
        wait.observe(sec(2), 2, RemotePhase::Preview).unwrap();
        wait.observe(sec(600), 3, RemotePhase::Preview).unwrap();
        assert_eq!(wait.remaining(sec(602)), Duration::ZERO);
        assert_eq!(
            wait.observe(sec(602), 4, RemotePhase::Committing),
            Err(PolicyError::Expired)
        );
        assert_eq!(
            wait.observe(sec(601), 3, RemotePhase::Committing),
            Err(PolicyError::StaleSequence)
        );
        assert_eq!(wait.remaining(sec(602)), Duration::ZERO);
    }

    #[test]
    fn compact_result_uses_counts_for_large_libraries() {
        let summary = CompactCommit {
            imported_book_count: 50_000,
            new_visible_book_count: 100,
            missing_book_count: 0,
            progress_conflict_book_count: 2,
            applied_preferences: false,
        };
        summary.validate(50_000, false).unwrap();
        assert!(summary.validate(49_999, false).is_err());
    }
}
