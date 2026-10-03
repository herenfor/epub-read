//! Rust implementation of the frozen causal merge and trusted-basis core.
//!
//! The repository may persist the caller's value, but only after these helpers
//! have checked the original event set.  Merge never allocates a local event.

use super::dto::{
    self, safe_time, validate_clock, validate_portable_state, validate_stamp, Annotation,
    PortableBook, PortableStateV3, ProgressState, Register, Stamp, Version,
};
use super::error::{PortableError, PortableResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EntityRef {
    Progress { book_hash: String },
    Bookmark { book_hash: String, id: String },
    Note { book_hash: String, id: String },
}

impl EntityRef {
    pub fn book_hash(&self) -> &str {
        match self {
            EntityRef::Progress { book_hash }
            | EntityRef::Bookmark { book_hash, .. }
            | EntityRef::Note { book_hash, .. } => book_hash,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            EntityRef::Progress { .. } => "progress",
            EntityRef::Bookmark { .. } => "bookmark",
            EntityRef::Note { .. } => "note",
        }
    }

    pub fn annotation_id(&self) -> Option<&str> {
        match self {
            EntityRef::Progress { .. } => None,
            EntityRef::Bookmark { id, .. } | EntityRef::Note { id, .. } => Some(id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AdoptSelection {
    Chosen {
        stamp: Stamp,
    },
    Empty,
    #[serde(rename = "shown-all")]
    ShownAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BasisSelection {
    Chosen,
    ShownAll,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBasis<T> {
    pub entity: EntityRef,
    pub local_revision: u64,
    pub selection: BasisSelection,
    pub observed: Vec<Version<T>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteIntent {
    Auto,
    Edit,
    Resolve,
    Reset,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PreparedWrite<T> {
    Unchanged,
    Write {
        versions: Vec<Version<T>>,
        next_basis: ReadBasis<T>,
    },
}

pub fn compare_stamps(left: &Stamp, right: &Stamp) -> Ordering {
    left.counter
        .cmp(&right.counter)
        .then_with(|| left.device_id.as_bytes().cmp(right.device_id.as_bytes()))
}

pub fn join_clocks(clocks: &[BTreeMap<String, u64>]) -> BTreeMap<String, u64> {
    let mut merged = BTreeMap::new();
    for clock in clocks {
        for (device_id, counter) in clock {
            let current = merged.get(device_id).copied().unwrap_or(0);
            if *counter > current {
                merged.insert(device_id.clone(), *counter);
            }
        }
    }
    merged
}

/// True only if `left` has seen all of `right` and at least one later event.
pub fn dominates(left: &BTreeMap<String, u64>, right: &BTreeMap<String, u64>) -> bool {
    for (device_id, counter) in right {
        if left.get(device_id).copied().unwrap_or(0) < *counter {
            return false;
        }
    }
    left.iter()
        .any(|(device_id, counter)| *counter > right.get(device_id).copied().unwrap_or(0))
}

fn assert_version<T>(version: &Version<T>) -> PortableResult<()> {
    validate_clock(&version.stamp, &version.clock)?;
    if !safe_time(version.updated_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：updatedAtMs 必须是非负安全整数",
        ));
    }
    Ok(())
}

/// Union minus causally superseded versions.  Same stamp with different
/// clock/value/time is corruption, never an import-order decision.
pub fn merge_versions<T: Clone + PartialEq>(
    states: &[&[Version<T>]],
) -> PortableResult<Vec<Version<T>>> {
    let mut unique: BTreeMap<(String, u64), Version<T>> = BTreeMap::new();
    for state in states {
        for version in *state {
            assert_version(version)?;
            let key = (version.stamp.device_id.clone(), version.stamp.counter);
            if let Some(previous) = unique.get(&key) {
                if previous.clock != version.clock
                    || previous.value != version.value
                    || previous.updated_at_ms != version.updated_at_ms
                {
                    return Err(PortableError::invalid_data("event-collision"));
                }
            }
            unique.insert(key, version.clone());
        }
    }
    let all: Vec<Version<T>> = unique.into_values().collect();
    let mut result = Vec::with_capacity(all.len());
    for (index, candidate) in all.iter().enumerate() {
        let dominated = all.iter().enumerate().any(|(other_index, other)| {
            other_index != index && dominates(&other.clock, &candidate.clock)
        });
        if !dominated {
            result.push(candidate.clone());
        }
    }
    result.sort_by(|left, right| compare_stamps(&left.stamp, &right.stamp));
    Ok(result)
}

pub fn same_event_frontier<T: Clone + PartialEq>(
    left: &[Version<T>],
    right: &[Version<T>],
) -> PortableResult<bool> {
    let left = merge_versions(&[left])?;
    let right = merge_versions(&[right])?;
    Ok(left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left, right)| left.stamp == right.stamp))
}

/// Persist a local event whose observed context is trusted caller state.  The
/// repository must allocate `stamp` and commit clock+value atomically.
pub fn write_observed<T: Clone + PartialEq>(
    current: &[Version<T>],
    observed: &[Version<T>],
    stamp: Stamp,
    value: T,
    updated_at_ms: u64,
) -> PortableResult<Vec<Version<T>>> {
    validate_stamp(&stamp)?;
    if !safe_time(updated_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：updatedAtMs 必须是非负安全整数",
        ));
    }
    let own_current: Vec<Version<T>> = current
        .iter()
        .filter(|version| version.stamp.device_id == stamp.device_id)
        .cloned()
        .collect();
    let seen = merge_versions(&[observed, own_current.as_slice()])?;
    let clocks: Vec<BTreeMap<String, u64>> =
        seen.iter().map(|version| version.clock.clone()).collect();
    let context = join_clocks(&clocks);
    if context.values().any(|counter| stamp.counter <= *counter) {
        return Err(PortableError::invalid_data(
            "clock-not-advanced：本机 stamp 必须晚于已采用的全部事件",
        ));
    }
    let mut clock = context;
    clock.insert(stamp.device_id.clone(), stamp.counter);
    let next = Version {
        stamp,
        clock,
        value,
        updated_at_ms,
    };
    validate_clock(&next.stamp, &next.clock)?;
    merge_versions(&[current, std::slice::from_ref(&next)])
}

pub fn merge_annotation<T: Clone + PartialEq>(
    left: &Annotation<T>,
    right: &Annotation<T>,
) -> PortableResult<Annotation<T>> {
    if let Some(stamp) = &left.deleted {
        validate_stamp(stamp)?;
    }
    if let Some(stamp) = &right.deleted {
        validate_stamp(stamp)?;
    }
    let deleted = match (&left.deleted, &right.deleted) {
        (None, None) => None,
        (Some(stamp), None) | (None, Some(stamp)) => Some(stamp.clone()),
        (Some(left_stamp), Some(right_stamp)) => Some(
            if compare_stamps(left_stamp, right_stamp) == Ordering::Less {
                right_stamp.clone()
            } else {
                left_stamp.clone()
            },
        ),
    };
    if let Some(stamp) = deleted {
        return Ok(Annotation {
            versions: Vec::new(),
            deleted: Some(stamp),
        });
    }
    Ok(Annotation {
        versions: merge_versions(&[&left.versions, &right.versions])?,
        deleted: None,
    })
}

pub fn merge_register<T: Clone + PartialEq>(
    left: Option<&Register<T>>,
    right: Option<&Register<T>>,
) -> PortableResult<Option<Register<T>>> {
    if let Some(register) = left {
        validate_stamp(&register.stamp)?;
    }
    if let Some(register) = right {
        validate_stamp(&register.stamp)?;
    }
    match (left, right) {
        (None, None) => Ok(None),
        (Some(register), None) | (None, Some(register)) => Ok(Some(register.clone())),
        (Some(left), Some(right)) => match compare_stamps(&left.stamp, &right.stamp) {
            Ordering::Equal if left.value != right.value => {
                Err(PortableError::invalid_data("event-collision"))
            }
            Ordering::Greater | Ordering::Equal => Ok(Some(left.clone())),
            Ordering::Less => Ok(Some(right.clone())),
        },
    }
}

fn merge_annotation_map<T: Clone + PartialEq>(
    left: &BTreeMap<String, Annotation<T>>,
    right: &BTreeMap<String, Annotation<T>>,
) -> PortableResult<BTreeMap<String, Annotation<T>>> {
    let mut merged = left.clone();
    for (id, annotation) in right {
        match merged.remove(id) {
            Some(existing) => {
                merged.insert(id.clone(), merge_annotation(&existing, annotation)?);
            }
            None => {
                merged.insert(id.clone(), annotation.clone());
            }
        }
    }
    Ok(merged)
}

pub fn merge_progress_states(
    left: &ProgressState,
    right: &ProgressState,
) -> PortableResult<ProgressState> {
    Ok(ProgressState {
        versions: merge_versions(&[&left.versions, &right.versions])?,
    })
}

pub fn merge_books(left: &PortableBook, right: &PortableBook) -> PortableResult<PortableBook> {
    Ok(PortableBook {
        metadata: merge_register(Some(&left.metadata), Some(&right.metadata))?
            .expect("metadata is required on both sides"),
        progress: merge_progress_states(&left.progress, &right.progress)?,
        bookmarks: merge_annotation_map(&left.bookmarks, &right.bookmarks)?,
        notes: merge_annotation_map(&left.notes, &right.notes)?,
    })
}

pub fn merge_portable_states(
    left: &PortableStateV3,
    right: &PortableStateV3,
) -> PortableResult<PortableStateV3> {
    let mut books = left.books.clone();
    for (book_hash, right_book) in &right.books {
        match books.get(book_hash) {
            Some(left_book) => {
                let merged = merge_books(left_book, right_book)?;
                books.insert(book_hash.clone(), merged);
            }
            None => {
                books.insert(book_hash.clone(), right_book.clone());
            }
        }
    }
    Ok(PortableStateV3 {
        schema_version: 3,
        books,
        organization: crate::library_organization::merge_organization(
            &left.organization,
            &right.organization,
        )
        .map_err(PortableError::invalid_data)?,
        // Preferences have no merge clock in v3.  Keep the local explicit
        // choice; only a fresh repository adopts an incoming preference set.
        preferences: match (&left.preferences, &right.preferences) {
            (Some(preferences), _) => Some(preferences.clone()),
            (None, Some(preferences)) => Some(preferences.clone()),
            (None, None) => None,
        },
    })
}

pub fn capture_read_basis<T: Clone + PartialEq>(
    entity: EntityRef,
    current: &[Version<T>],
    local_revision: u64,
    selection: AdoptSelection,
) -> PortableResult<ReadBasis<T>> {
    if local_revision > dto::MAX_SAFE_COUNTER {
        return Err(PortableError::invalid_data(
            "invalid-data：localRevision 超出安全范围",
        ));
    }
    let frontier = merge_versions(&[current])?;
    let (observed, kind) = match selection {
        AdoptSelection::Empty => {
            if !frontier.is_empty() {
                return Err(PortableError::invalid_choice(
                    "invalid-choice：非空实体不能采用空基线",
                ));
            }
            (Vec::new(), BasisSelection::Chosen)
        }
        AdoptSelection::Chosen { stamp } => {
            validate_stamp(&stamp)?;
            let selected: Vec<Version<T>> = frontier
                .iter()
                .filter(|version| version.stamp == stamp)
                .cloned()
                .collect();
            if selected.len() != 1 {
                return Err(PortableError::invalid_choice(
                    "invalid-choice：所选版本不在可信候选中",
                ));
            }
            (selected, BasisSelection::Chosen)
        }
        AdoptSelection::ShownAll => (frontier, BasisSelection::ShownAll),
    };
    Ok(ReadBasis {
        entity,
        local_revision,
        selection: kind,
        observed,
    })
}

fn same_json_value<T: Serialize>(left: &T, right: &T) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

pub fn prepare_observed_write<T: Clone + PartialEq + Serialize>(
    entity: EntityRef,
    current: &[Version<T>],
    local_revision: u64,
    basis: &ReadBasis<T>,
    intent: WriteIntent,
    next_stamp: Stamp,
    value: T,
    updated_at_ms: u64,
) -> PortableResult<PreparedWrite<T>> {
    if entity != basis.entity {
        return Err(PortableError::invalid_entity("wrong-entity"));
    }
    validate_stamp(&next_stamp)?;
    if !safe_time(updated_at_ms) {
        return Err(PortableError::invalid_data(
            "invalid-data：updatedAtMs 必须是非负安全整数",
        ));
    }
    if basis.local_revision != local_revision {
        return Err(PortableError::stale_basis("stale-basis"));
    }
    if intent == WriteIntent::Auto && entity.kind() != "progress" {
        return Err(PortableError::invalid_intent("invalid-intent"));
    }
    if matches!(intent, WriteIntent::Resolve | WriteIntent::Reset) {
        if basis.selection != BasisSelection::ShownAll
            || !same_event_frontier(current, &basis.observed)?
        {
            return Err(PortableError::stale_choice("stale-choice"));
        }
        if intent == WriteIntent::Reset
            && (entity.kind() != "progress"
                || serde_json::to_value(&value).ok() != Some(Value::Null))
        {
            return Err(PortableError::invalid_intent("invalid-intent"));
        }
    } else if basis.selection != BasisSelection::Chosen {
        return Err(PortableError::invalid_intent("invalid-basis"));
    }
    if intent == WriteIntent::Auto
        && basis.observed.len() == 1
        && same_json_value(&basis.observed[0].value, &value)
    {
        return Ok(PreparedWrite::Unchanged);
    }
    if next_stamp.counter <= local_revision {
        return Err(PortableError::invalid_data(
            "clock-not-advanced：本机 stamp 未超过 localRevision",
        ));
    }
    let versions = write_observed(
        current,
        &basis.observed,
        next_stamp.clone(),
        value,
        updated_at_ms,
    )?;
    let written = versions
        .iter()
        .find(|version| version.stamp == next_stamp)
        .cloned()
        .ok_or_else(|| PortableError::invalid_data("clock-not-advanced：写入被已见事件支配"))?;
    Ok(PreparedWrite::Write {
        versions,
        next_basis: ReadBasis {
            entity: basis.entity.clone(),
            local_revision: next_stamp.counter,
            selection: BasisSelection::Chosen,
            observed: vec![written],
        },
    })
}

pub fn maximum_received_counter<T>(
    versions: &[Version<T>],
    register_stamps: &[Stamp],
    tombstones: &[Stamp],
) -> PortableResult<u64> {
    let mut maximum = 0_u64;
    let mut observe = |counter: u64| -> PortableResult<()> {
        if !dto::safe_counter(counter) {
            return Err(PortableError::invalid_data("invalid-counter"));
        }
        if counter > maximum {
            maximum = counter;
        }
        Ok(())
    };
    for version in versions {
        observe(version.stamp.counter)?;
        for counter in version.clock.values() {
            observe(*counter)?;
        }
    }
    for stamp in register_stamps {
        observe(stamp.counter)?;
    }
    for stamp in tombstones {
        observe(stamp.counter)?;
    }
    Ok(maximum)
}

pub fn maximum_received_counter_from_state(state: &PortableStateV3) -> PortableResult<u64> {
    validate_portable_state(state)?;
    let mut maximum = 0_u64;
    for book in state.books.values() {
        maximum = maximum.max(book.metadata.stamp.counter);
        maximum = maximum.max(maximum_received_counter(&book.progress.versions, &[], &[])?);
        for annotation in book.bookmarks.values() {
            let tombstones: Vec<Stamp> = annotation.deleted.iter().cloned().collect();
            maximum = maximum.max(maximum_received_counter(
                &annotation.versions,
                &[],
                &tombstones,
            )?);
        }
        for annotation in book.notes.values() {
            let tombstones: Vec<Stamp> = annotation.deleted.iter().cloned().collect();
            maximum = maximum.max(maximum_received_counter(
                &annotation.versions,
                &[],
                &tombstones,
            )?);
        }
    }
    maximum = maximum.max(crate::library_organization::max_observed_counter(
        &state.organization,
    ));
    Ok(maximum)
}

pub fn next_local_counter(local_counter: u64, received_maximum: u64) -> PortableResult<u64> {
    if local_counter > dto::MAX_SAFE_COUNTER || received_maximum > dto::MAX_SAFE_COUNTER {
        return Err(PortableError::invalid_data("invalid-counter"));
    }
    let previous = local_counter.max(received_maximum);
    if previous == dto::MAX_SAFE_COUNTER {
        return Err(PortableError::clock_exhausted(
            "clock-exhausted：本机逻辑时钟已达上限",
        ));
    }
    Ok(previous + 1)
}
