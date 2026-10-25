//! Bounded native directory-import coordinator.
//!
//! A fixed preparation pool runs ahead of one ordered commit coordinator.
//! Linked sources reserve no staged EPUB bytes; managed reservations remain
//! held until publish/cleanup. Only paths and metadata enter the ready window.

use super::pipeline::{with_preparation_pool, PreparationPool};
use super::planner::{
    decide_placement, plan_directory_import, validate_targets, PlacementDecision,
    PlacementSnapshot, SkipReason, SuccessfulSources,
};
use super::policy::{
    OrderedWindow, PayloadKind, Reservation, StageBudget, IMPORT_STAGE_BUDGET_BYTES,
};
use super::types::{
    DirectoryProgress, EntrySource, ExistingPlacement, FolderTarget, ImportCounts, ImportIssue,
    ImportIssueKind, ImportJobStatus, ImportOptions, ImportPerformance, ScannedEntry, ScannedEpub,
};
use crate::android_uri_bridge::RestrictedReader;
use crate::linked_library::{
    canonical_epub_path, ensure_library_space, hash_file, inspect_epub, library_file_name,
    library_root, load_bindings, make_binding, make_managed_binding, make_managed_record,
    publish_staged_copy, snapshot, verify_binding_for_list_refresh, DeviceBinding, FileSnapshot,
    ImportedMetadata, LinkedLibraryRecord,
};
#[cfg(target_os = "android")]
use crate::linked_library::{managed_source_path, replace_file_atomically};
use crate::linked_library::{new_staging_path, stream_restricted_reader_to_staging, PrepareError};
use crate::portable_state::{
    DirectoryBindingWrite, DirectoryFolderCreate, DirectoryImportBatchOutcome,
    DirectoryPlacementDecision, DirectoryPlacementRequest, DirectoryPlacementSnapshot,
};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::AppHandle;

const MAX_BATCH_BOOKS: usize = 64;
const PENDING_METADATA_BYTES: usize = 16 * 1024 * 1024;

fn elapsed_micros(start: Instant) -> u64 {
    start.elapsed().as_micros().min(u64::MAX as u128) as u64
}

#[derive(Default)]
struct PreparationTiming {
    hash_micros: u64,
    copy_hash_micros: u64,
    metadata_micros: u64,
    verified_bytes: u64,
    staged_bytes: u64,
}

/// The one source-to-payload hook for A34. Path does not inherently mean
/// linked: its copy option will select Managed here when that entry is wired.
fn select_payload_kind(source: &EntrySource, copy: bool) -> PayloadKind {
    match source {
        EntrySource::Path(_) if !copy => PayloadKind::Linked,
        EntrySource::Path(_) => PayloadKind::Managed,
        EntrySource::TreeUri(_) => PayloadKind::Managed,
    }
}

#[derive(Debug, Clone)]
struct TargetSpec {
    folder_id: String,
    create_name: Option<String>,
}

struct PreparedSuccess {
    ordinal: usize,
    input_id: String,
    group_key: Option<String>,
    content_hash: String,
    file_name: String,
    metadata: ImportedMetadata,
    payload: PreparedPayload,
    reservation: Reservation,
    observed: DirectoryPlacementSnapshot,
    timing: PreparationTiming,
}

impl PreparedSuccess {
    fn retained_metadata_bytes(&self) -> usize {
        let metadata = &self.metadata;
        std::mem::size_of::<Self>()
            + self.input_id.capacity()
            + self.file_name.capacity()
            + self.group_key.as_ref().map_or(0, String::capacity)
            + self.content_hash.capacity()
            + metadata.title.capacity()
            + metadata.creator.capacity()
            + metadata.language.capacity()
            + metadata.cover_zip_path.as_ref().map_or(0, String::capacity)
            + metadata.cover_mime.capacity()
            + metadata.spine.capacity() * std::mem::size_of::<String>()
            + metadata.spine.iter().map(String::capacity).sum::<usize>()
    }
}

struct PrepareTask {
    ordinal: usize,
    entry: ScannedEntry,
    group_key: Option<String>,
    kind: PayloadKind,
    reservation: Reservation,
}

fn admit_preparations(
    pool: &PreparationPool<PrepareTask, PrepareOutcome>,
    ordered: &[(super::planner::PlannedInput, ScannedEntry)],
    window: &mut OrderedWindow<PrepareOutcome>,
    budget: &mut StageBudget,
    gate: &super::policy::DirectoryJobGate,
    performance: &mut ImportPerformance,
    copy: bool,
) -> Result<bool, String> {
    if gate.cancelled() {
        return Ok(false);
    }
    while let Some(index) = window.next_to_dispatch() {
        let (planned, entry) = &ordered[index];
        let kind = select_payload_kind(&entry.source, copy);
        let Some(reservation) = budget.reserve_payload(kind, entry.epub.size_hint) else {
            performance.budget_waits += 1;
            return Ok(true);
        };
        let dispatched = window.dispatch().expect("admitted ordered input");
        pool.dispatch(
            dispatched,
            PrepareTask {
                ordinal: planned.ordinal,
                entry: entry.clone(),
                group_key: planned.group_key.clone(),
                kind,
                reservation,
            },
        )?;
        performance.peak_outstanding = performance.peak_outstanding.max(window.outstanding());
        performance.peak_reserved_staging_bytes =
            performance.peak_reserved_staging_bytes.max(budget.used());
    }
    Ok(false)
}

enum PreparedPayload {
    Linked {
        path: PathBuf,
        snapshot: FileSnapshot,
    },
    Managed {
        staging: OwnedStaging,
    },
}

/// Owns exactly one staging path until the bytes have been atomically moved to
/// their managed target.  `published` is the only way to revoke cleanup; after
/// that the guard never touches the published target.
struct OwnedStaging(Option<PathBuf>);

impl OwnedStaging {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    fn path(&self) -> &Path {
        self.0
            .as_deref()
            .expect("owned staging has not been published")
    }

    fn published(&mut self) {
        self.0 = None;
    }
}

impl Drop for OwnedStaging {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

enum PrepareOutcome {
    Success(PreparedSuccess),
    Failed {
        input_id: String,
        message: String,
        reservation: Reservation,
    },
    Cancelled {
        reservation: Reservation,
    },
}

struct RunnerState {
    app: AppHandle,
    job: Arc<super::job::DirectoryImportJob>,
    root: PathBuf,
    gate: Arc<super::policy::DirectoryJobGate>,
    policy: ExistingPlacement,
    target_specs: HashMap<String, TargetSpec>,
    counts: ImportCounts,
    issue_count: usize,
    seen: SuccessfulSources,
    performance: ImportPerformance,
}

impl RunnerState {
    fn push_issue(&mut self, input_id: String, kind: ImportIssueKind, message: String) {
        self.issue_count += 1;
        self.job.add_issue(ImportIssue {
            input_id,
            kind,
            message,
        });
    }

    fn observe_many(
        &self,
        content_hashes: &[String],
    ) -> Result<BTreeMap<String, DirectoryPlacementSnapshot>, String> {
        if content_hashes.is_empty() {
            return Ok(BTreeMap::new());
        }
        let values = crate::portable_state_commands::with_existing_store(&self.app, |store| {
            store.directory_placement_snapshots(content_hashes)
        })
        .map_err(|error| error.to_string())?;
        let Some(values) = values else {
            return Err("可移植资料仓储未激活，无法开始目录导入".to_string());
        };
        Ok(values)
    }

    fn persist_metadata(
        &self,
        records: &[LinkedLibraryRecord],
        bindings: &[DeviceBinding],
    ) -> Result<(), String> {
        let values = records
            .iter()
            .map(|record| serde_json::to_value(record).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let rows = bindings
            .iter()
            .map(|binding| {
                serde_json::to_string(binding)
                    .map(|raw| (binding.content_hash.clone(), raw))
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let visible_hashes = records
            .iter()
            .map(|record| record.content_hash.clone())
            .collect::<Vec<_>>();
        let is_new_hashes = records
            .iter()
            .filter(|record| record.is_new)
            .map(|record| record.content_hash.clone())
            .collect::<Vec<_>>();
        let result = crate::portable_state_commands::with_existing_store(&self.app, |store| {
            store.publish_directory_import_batch(values, rows, visible_hashes, is_new_hashes)
        })
        .map_err(|error| error.to_string())?;
        result.ok_or_else(|| "可移植资料仓储未激活".to_string())
    }

    fn existing_binding_available(&self, content_hash: &str) -> Result<bool, String> {
        let raw = match crate::portable_state_commands::with_existing_store(&self.app, |store| {
            store.binding_raw(content_hash)
        }) {
            Ok(Some(value)) => value,
            Ok(None) => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        let Some(raw) = raw else {
            return Ok(false);
        };
        let mut binding: DeviceBinding =
            serde_json::from_str(&raw).map_err(|error| format!("设备绑定损坏：{error}"))?;
        let verification = verify_binding_for_list_refresh(&mut binding, &self.root)?;
        Ok(verification.available)
    }

    fn cleanup_item(&self, budget: &mut StageBudget, item: PreparedSuccess) {
        let PreparedSuccess {
            payload,
            reservation,
            ..
        } = item;
        drop(payload);
        budget.release(reservation);
    }

    fn publish(
        &self,
        item: &mut PreparedSuccess,
        known_bindings: &[DeviceBinding],
    ) -> Result<(LinkedLibraryRecord, DeviceBinding), String> {
        match &mut item.payload {
            PreparedPayload::Linked { path, snapshot } => {
                let binding = make_binding(
                    item.content_hash.clone(),
                    &*path,
                    snapshot.clone(),
                    &item.metadata,
                );
                let record = linked_record(
                    item.content_hash.clone(),
                    item.file_name.clone(),
                    &item.metadata,
                );
                Ok((record, binding))
            }
            PreparedPayload::Managed { staging } => {
                let staging_path = staging.path().to_path_buf();
                #[cfg(not(target_os = "android"))]
                let binding = {
                    let wanted = library_file_name(&item.file_name, &item.metadata.title);
                    let (name, file_snapshot) =
                        publish_staged_copy(&self.root, &staging_path, &wanted, known_bindings)?;
                    staging.published();
                    make_managed_binding(item.content_hash.clone(), file_snapshot, &item.metadata)
                        .with_managed_file_name(name)
                };
                #[cfg(target_os = "android")]
                let binding = {
                    let _ = known_bindings;
                    let target = managed_source_path(&self.root, &item.content_hash)?;
                    replace_file_atomically(&staging_path, &target)
                        .map_err(|error| format!("无法发布托管副本：{error}"))?;
                    staging.published();
                    make_managed_binding(
                        item.content_hash.clone(),
                        snapshot(&target)?,
                        &item.metadata,
                    )
                };
                let record = make_managed_record(
                    item.content_hash.clone(),
                    item.file_name.clone(),
                    &item.metadata,
                );
                Ok((record, binding))
            }
        }
    }

    fn flush_pending(
        &mut self,
        budget: &mut StageBudget,
        pending: &mut Vec<PreparedSuccess>,
    ) -> Result<(), String> {
        if pending.is_empty() {
            return Ok(());
        }
        let started = Instant::now();
        let result = self.flush_pending_inner(budget, pending);
        self.performance.commit_micros += elapsed_micros(started);
        result
    }

    fn flush_pending_inner(
        &mut self,
        budget: &mut StageBudget,
        pending: &mut Vec<PreparedSuccess>,
    ) -> Result<(), String> {
        if pending.is_empty() {
            return Ok(());
        }
        let mut known_bindings = if pending
            .iter()
            .any(|item| matches!(item.payload, PreparedPayload::Managed { .. }))
        {
            load_bindings(&self.app)?
        } else {
            Vec::new()
        };
        let batch = std::mem::take(pending);
        if !self.gate.begin_batch() {
            for item in batch {
                self.cleanup_item(budget, item);
            }
            return Ok(());
        }

        self.performance.commit_batches += 1;
        let mut records: Vec<LinkedLibraryRecord> = Vec::new();
        let mut bindings: Vec<DeviceBinding> = Vec::new();
        let mut published_items: Vec<PreparedSuccess> = Vec::new();
        let mut placements: Vec<DirectoryPlacementRequest> = Vec::new();
        let mut group_targets: Vec<(String, String)> = Vec::new();
        let mut create_specs: HashMap<String, String> = HashMap::new();

        for mut item in batch {
            if self.seen.winner(&item.content_hash).is_some() {
                self.counts.duplicates += 1;
                self.cleanup_item(budget, item);
                continue;
            }

            let existing_available = if item.observed.is_existing_book {
                self.existing_binding_available(&item.content_hash)
                    .unwrap_or(false)
            } else {
                false
            };
            let publish_started = Instant::now();
            let published: Result<Option<(LinkedLibraryRecord, DeviceBinding)>, String> =
                if existing_available {
                    Ok(None)
                } else {
                    self.publish(&mut item, &known_bindings).map(Some)
                };
            self.performance.publish_micros += elapsed_micros(publish_started);
            match published {
                Ok(published) => {
                    if let Some((mut record, binding)) = published {
                        if item.observed.is_existing_book {
                            record.is_new = false;
                        }
                        records.push(record);
                        known_bindings.push(binding.clone());
                        bindings.push(binding);
                    } else {
                        // Existing healthy source: do not republish bytes or
                        // overwrite the binding.  Keep the book visible and
                        // let the portable merge preserve canonical data.
                        let mut record = linked_record(
                            item.content_hash.clone(),
                            item.file_name.clone(),
                            &item.metadata,
                        );
                        record.is_new = false;
                        records.push(record);
                    }
                    self.seen.record_published(&item.content_hash, item.ordinal);
                    if item.observed.is_existing_book {
                        self.counts.duplicates += 1;
                    } else {
                        self.counts.imported += 1;
                    }
                    if let Some(group_key) = &item.group_key {
                        if let Some(target) = self.target_specs.get(group_key) {
                            if !group_targets
                                .iter()
                                .any(|(existing, _)| existing == group_key)
                            {
                                group_targets.push((group_key.clone(), target.folder_id.clone()));
                            }
                            if let Some(name) = &target.create_name {
                                create_specs
                                    .entry(target.folder_id.clone())
                                    .or_insert_with(|| name.clone());
                            }
                            placements.push(DirectoryPlacementRequest {
                                content_hash: item.content_hash.clone(),
                                target_folder_id: Some(target.folder_id.clone()),
                                is_existing_book: item.observed.is_existing_book,
                                observed: item.observed.clone(),
                            });
                        }
                    }
                    published_items.push(item);
                }
                Err(message) => {
                    let input_id = item.input_id.clone();
                    self.counts.failed += 1;
                    self.push_issue(input_id, ImportIssueKind::SourceFailed, message);
                    self.cleanup_item(budget, item);
                }
            }
        }

        if !records.is_empty() || !bindings.is_empty() {
            if let Err(message) = self.persist_metadata(&records, &bindings) {
                self.gate.end_batch();
                for item in published_items {
                    self.cleanup_item(budget, item);
                }
                return Err(format!(
                    "书籍正文已发布，但本机资料写入失败：{message}；请刷新后重试"
                ));
            }
        }

        let hash_to_input: HashMap<String, String> = published_items
            .iter()
            .map(|item| (item.content_hash.clone(), item.input_id.clone()))
            .collect();
        if !placements.is_empty() {
            let creates: Vec<DirectoryFolderCreate> = create_specs
                .into_iter()
                .map(|(folder_id, name)| DirectoryFolderCreate { folder_id, name })
                .collect();
            let binding_rows: Vec<DirectoryBindingWrite> = group_targets
                .into_iter()
                .map(|(directory_key, folder_id)| DirectoryBindingWrite {
                    directory_key,
                    folder_id,
                })
                .collect();
            let policy = self.policy;
            let requests = placements.clone();
            let result = crate::portable_state_commands::with_existing_store(&self.app, |store| {
                store.apply_directory_import_batch(
                    &creates,
                    &requests,
                    &binding_rows,
                    |request, current, target_alive| {
                        let observed = to_planner_placement(&request.observed);
                        let current = to_planner_placement(current);
                        match decide_placement(
                            &observed,
                            &current,
                            request.is_existing_book,
                            request.target_folder_id.as_deref(),
                            target_alive,
                            policy,
                        ) {
                            PlacementDecision::Keep { .. } => DirectoryPlacementDecision::Keep,
                            PlacementDecision::Move { .. } => DirectoryPlacementDecision::Move,
                            PlacementDecision::Skipped {
                                reason: SkipReason::PlacementChanged,
                            } => DirectoryPlacementDecision::PlacementChanged,
                            PlacementDecision::Skipped {
                                reason: SkipReason::TargetDeleted,
                            } => DirectoryPlacementDecision::TargetDeleted,
                        }
                    },
                )
            });
            match result {
                Ok(Some(outcome)) => self.apply_batch_outcome(outcome, &hash_to_input),
                Ok(None) => {
                    for request in &requests {
                        self.counts.placement_skipped += 1;
                        self.push_issue(
                            hash_to_input
                                .get(&request.content_hash)
                                .cloned()
                                .unwrap_or_else(|| request.content_hash.clone()),
                            ImportIssueKind::PlacementChanged,
                            "可移植资料仓储未激活，未写入目录归属".to_string(),
                        );
                    }
                }
                Err(error) => {
                    for request in &requests {
                        self.counts.placement_skipped += 1;
                        self.push_issue(
                            hash_to_input
                                .get(&request.content_hash)
                                .cloned()
                                .unwrap_or_else(|| request.content_hash.clone()),
                            ImportIssueKind::PlacementChanged,
                            format!("目录归属提交失败：{error}"),
                        );
                    }
                }
            }
        }

        for item in published_items {
            self.cleanup_item(budget, item);
        }
        self.gate.end_batch();
        Ok(())
    }

    fn apply_batch_outcome(
        &mut self,
        outcome: DirectoryImportBatchOutcome,
        hash_to_input: &HashMap<String, String>,
    ) {
        self.counts.created_folders = self
            .counts
            .created_folders
            .saturating_add(outcome.created_folders);
        for result in outcome.placements {
            match result.decision {
                DirectoryPlacementDecision::Keep | DirectoryPlacementDecision::Move => {}
                DirectoryPlacementDecision::PlacementChanged => {
                    self.counts.placement_skipped += 1;
                    self.push_issue(
                        hash_to_input
                            .get(&result.content_hash)
                            .cloned()
                            .unwrap_or_else(|| result.content_hash.clone()),
                        ImportIssueKind::PlacementChanged,
                        "书籍归属在准备期间发生变化，已保留用户新归属".to_string(),
                    );
                }
                DirectoryPlacementDecision::TargetDeleted => {
                    self.counts.placement_skipped += 1;
                    self.push_issue(
                        hash_to_input
                            .get(&result.content_hash)
                            .cloned()
                            .unwrap_or_else(|| result.content_hash.clone()),
                        ImportIssueKind::TargetDeleted,
                        "目标文件夹已解散，书籍保留为未归档".to_string(),
                    );
                }
            }
        }
    }
}

fn linked_record(
    content_hash: String,
    file_name: String,
    metadata: &ImportedMetadata,
) -> LinkedLibraryRecord {
    LinkedLibraryRecord {
        content_hash,
        title: if metadata.title.trim().is_empty() {
            "未命名书籍".to_string()
        } else {
            metadata.title.clone()
        },
        creator: metadata.creator.clone(),
        language: metadata.language.clone(),
        file_name,
        added_at_ms: now_ms(),
        last_read_at_ms: 0,
        spine_index: 0,
        page: 0,
        progress_pct: 0,
        anchor_index: None,
        anchor_ratio: None,
        anchor_text_offset: None,
        anchor_text_snippet: None,
        media_anchor: None,
        bookmarks: Vec::new(),
        notes: Vec::new(),
        is_new: true,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn to_planner_placement(snapshot: &DirectoryPlacementSnapshot) -> PlacementSnapshot {
    PlacementSnapshot {
        raw_folder_id: snapshot.raw_folder_id.clone(),
        stamp: snapshot.stamp.as_ref().map(|stamp| super::planner::Stamp {
            device_id: stamp.device_id.clone(),
            counter: stamp.counter,
        }),
        effective_folder_id: snapshot.effective_folder_id.clone(),
    }
}

fn target_specs(
    plan: &super::planner::ImportPlan,
    targets: &[FolderTarget],
) -> Result<HashMap<String, TargetSpec>, String> {
    let by_group = validate_targets(plan, targets)?;
    let mut specs = HashMap::new();
    for (group_key, target) in by_group {
        specs.insert(
            group_key,
            TargetSpec {
                folder_id: target.folder_id().to_string(),
                create_name: target.create_name().map(str::to_string),
            },
        );
    }
    Ok(specs)
}

fn prepare_one(
    app: &AppHandle,
    root: &PathBuf,
    gate: &super::policy::DirectoryJobGate,
    ordinal: usize,
    entry: &ScannedEntry,
    group_key: Option<String>,
    kind: PayloadKind,
    reservation: Reservation,
) -> PrepareOutcome {
    let cancelled = || gate.cancelled();
    if cancelled() {
        return PrepareOutcome::Cancelled { reservation };
    }
    let result: Result<PreparedSuccess, (bool, String)> = match (kind, &entry.source) {
        (PayloadKind::Linked, EntrySource::Path(_)) => {
            prepare_linked(entry, ordinal, group_key, reservation.clone())
        }
        (PayloadKind::Managed, EntrySource::TreeUri(uri)) => prepare_managed(
            app,
            root,
            uri,
            ordinal,
            entry,
            group_key,
            reservation.clone(),
            &cancelled,
        ),
        _ => Err((false, "导入来源与载荷方式不匹配".to_string())),
    };
    match result {
        Ok(mut item) => {
            item.observed = empty_observation();
            PrepareOutcome::Success(item)
        }
        Err((was_cancelled, message)) => {
            if was_cancelled {
                PrepareOutcome::Cancelled { reservation }
            } else {
                PrepareOutcome::Failed {
                    input_id: entry.epub.input_id.clone(),
                    message,
                    reservation,
                }
            }
        }
    }
}

fn prepare_linked(
    entry: &ScannedEntry,
    ordinal: usize,
    group_key: Option<String>,
    reservation: Reservation,
) -> Result<PreparedSuccess, (bool, String)> {
    let source_path = match &entry.source {
        EntrySource::Path(path) => path,
        _ => return Err((false, "内部错误：linked 来源类型不匹配".to_string())),
    };
    let path =
        canonical_epub_path(&source_path.to_string_lossy()).map_err(|error| (false, error))?;
    let started = Instant::now();
    let (content_hash, hashed_snapshot) = hash_file(&path).map_err(|error| (false, error))?;
    let hash_micros = elapsed_micros(started);
    let started = Instant::now();
    let metadata = inspect_epub(&path).map_err(|error| (false, error))?;
    let metadata_micros = elapsed_micros(started);
    if metadata.spine.is_empty() {
        return Err((false, "EPUB OPF 没有可阅读的 spine 条目".to_string()));
    }
    let final_snapshot = snapshot(&path).map_err(|error| (false, error))?;
    if final_snapshot != hashed_snapshot {
        return Err((
            false,
            "源 EPUB 在解析元数据期间发生了变化，请重新导入".to_string(),
        ));
    }
    let verified_bytes = std::fs::metadata(&path)
        .map_err(|error| (false, error.to_string()))?
        .len();
    Ok(PreparedSuccess {
        ordinal,
        input_id: entry.epub.input_id.clone(),
        group_key,
        content_hash,
        file_name: entry.epub.file_name.clone(),
        metadata,
        payload: PreparedPayload::Linked {
            path,
            snapshot: final_snapshot,
        },
        reservation,
        observed: empty_observation(),
        timing: PreparationTiming {
            hash_micros,
            metadata_micros,
            verified_bytes,
            ..Default::default()
        },
    })
}

#[allow(clippy::too_many_arguments)]
#[cfg(target_os = "android")]
fn prepare_managed(
    app: &AppHandle,
    root: &PathBuf,
    uri: &str,
    ordinal: usize,
    entry: &ScannedEntry,
    group_key: Option<String>,
    reservation: Reservation,
    cancelled: &dyn Fn() -> bool,
) -> Result<PreparedSuccess, (bool, String)> {
    let reader = crate::android_uri_bridge::open_content_uri(app, uri)
        .map_err(|error| (false, format!("无法打开 Android content URI：{error}")))?;
    prepare_managed_reader(
        root,
        reader,
        ordinal,
        entry,
        group_key,
        reservation,
        cancelled,
    )
}

fn prepare_managed_path(
    root: &PathBuf,
    ordinal: usize,
    entry: &ScannedEntry,
    group_key: Option<String>,
    reservation: Reservation,
    cancelled: &dyn Fn() -> bool,
) -> Result<PreparedSuccess, (bool, String)> {
    let EntrySource::Path(source) = &entry.source else {
        return Err((false, "来源不是文件路径".into()));
    };
    let path = canonical_epub_path(&source.to_string_lossy()).map_err(|error| (false, error))?;
    let before = snapshot(&path).map_err(|error| (false, error))?;
    let file =
        std::fs::File::open(&path).map_err(|error| (false, format!("无法打开原书：{error}")))?;
    let reader = RestrictedReader::from_file(file, 0, -1)
        .map_err(|error| (false, format!("无法读取原书：{error}")))?;
    let item = prepare_managed_reader(
        root,
        reader,
        ordinal,
        entry,
        group_key,
        reservation,
        cancelled,
    )?;
    if before != snapshot(&path).map_err(|error| (false, error))? {
        return Err((false, "源 EPUB 在复制期间发生了变化，请重新导入".into()));
    }
    Ok(item)
}

fn prepare_managed_reader(
    root: &PathBuf,
    mut reader: RestrictedReader,
    ordinal: usize,
    entry: &ScannedEntry,
    group_key: Option<String>,
    reservation: Reservation,
    cancelled: &dyn Fn() -> bool,
) -> Result<PreparedSuccess, (bool, String)> {
    let staging = OwnedStaging::new(new_staging_path(root).map_err(|error| (false, error))?);
    let started = Instant::now();
    let staged = match stream_restricted_reader_to_staging(&mut reader, staging.path(), cancelled) {
        Ok(staged) => staged,
        Err(PrepareError::Cancelled { .. }) => return Err((true, String::new())),
        Err(PrepareError::Failed { message, .. }) => return Err((false, message)),
    };
    let copy_hash_micros = elapsed_micros(started);
    let staged_bytes = std::fs::metadata(staging.path())
        .map_err(|error| (false, error.to_string()))?
        .len();
    let content_hash = staged.content_hash;
    let started = Instant::now();
    let metadata = inspect_epub(staging.path()).map_err(|error| (false, error))?;
    let metadata_micros = elapsed_micros(started);
    if metadata.spine.is_empty() {
        return Err((false, "EPUB OPF 没有可阅读的 spine 条目".to_string()));
    }
    if cancelled() {
        return Err((true, String::new()));
    }
    Ok(PreparedSuccess {
        ordinal,
        input_id: entry.epub.input_id.clone(),
        group_key,
        content_hash,
        file_name: entry.epub.file_name.clone(),
        metadata,
        payload: PreparedPayload::Managed { staging },
        reservation,
        observed: empty_observation(),
        timing: PreparationTiming {
            copy_hash_micros,
            metadata_micros,
            verified_bytes: staged_bytes,
            staged_bytes,
            ..Default::default()
        },
    })
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(target_os = "android"))]
fn prepare_managed(
    _app: &AppHandle,
    _root: &PathBuf,
    _uri: &str,
    _ordinal: usize,
    _entry: &ScannedEntry,
    _group_key: Option<String>,
    _reservation: Reservation,
    _cancelled: &dyn Fn() -> bool,
) -> Result<PreparedSuccess, (bool, String)> {
    Err((
        false,
        "Android 树 URI 导入仅可在 Android 上运行".to_string(),
    ))
}

fn empty_observation() -> DirectoryPlacementSnapshot {
    DirectoryPlacementSnapshot {
        raw_folder_id: None,
        stamp: None,
        effective_folder_id: None,
        is_existing_book: false,
    }
}

pub fn run_import(
    app: &AppHandle,
    job: Arc<super::job::DirectoryImportJob>,
    options: ImportOptions,
    targets: Vec<FolderTarget>,
    on_progress: Channel<DirectoryProgress>,
    copy: bool,
) -> Result<super::types::DirectoryImportResult, String> {
    let import_started = Instant::now();
    let root = job.root().ok_or_else(|| "目录扫描尚未完成".to_string())?;
    let entries = job.entries();
    let public_entries: Vec<ScannedEpub> = entries.iter().map(|entry| entry.epub.clone()).collect();
    let plan = plan_directory_import(&root, &public_entries, &options);
    let target_specs = target_specs(&plan, &targets)?;
    let root_path = library_root(app)?;
    if copy
        && entries
            .iter()
            .all(|entry| matches!(entry.source, EntrySource::Path(_)))
    {
        let total = public_entries.iter().try_fold(0u64, |sum, entry| {
            sum.checked_add(entry.size_hint.unwrap_or(0))
                .ok_or("导入总大小溢出")
        })?;
        ensure_library_space(&root_path, total)?;
    }

    let by_input: HashMap<String, ScannedEntry> = entries
        .into_iter()
        .map(|entry| (entry.epub.input_id.clone(), entry))
        .collect();
    let ordered: Vec<(super::planner::PlannedInput, ScannedEntry)> = plan
        .inputs
        .iter()
        .filter_map(|input| {
            by_input
                .get(&input.input_id)
                .cloned()
                .map(|entry| (input.clone(), entry))
        })
        .collect();

    let mut state = RunnerState {
        app: app.clone(),
        job: Arc::clone(&job),
        root: root_path,
        gate: job.gate(),
        policy: options.existing_placement,
        target_specs,
        counts: ImportCounts::default(),
        issue_count: 0,
        seen: SuccessfulSources::new(),
        performance: ImportPerformance::default(),
    };
    let mut budget = StageBudget::new(IMPORT_STAGE_BUDGET_BYTES);
    let mut pending: Vec<PreparedSuccess> = Vec::new();
    let total = ordered.len();
    let width = (if cfg!(target_os = "android") { 2 } else { 4 }).min(total.max(1));
    // Admission bounds queued, running and ready results together. Pending
    // committed metadata has its own bound and never contains full EPUB bytes.
    let capacity = width * 2;
    let prepare_root = state.root.clone();
    let prepare_gate = Arc::clone(&state.gate);
    with_preparation_pool(
        width,
        capacity,
        |task: PrepareTask| {
            prepare_one(
                app,
                &prepare_root,
                &prepare_gate,
                task.ordinal,
                &task.entry,
                task.group_key,
                task.kind,
                task.reservation,
            )
        },
        |pool| {
            let mut window = OrderedWindow::new(total, capacity);
            let mut pending_bytes = 0usize;
            while !window.finished() {
                let budget_blocked = admit_preparations(
                    pool,
                    &ordered,
                    &mut window,
                    &mut budget,
                    &state.gate,
                    &mut state.performance,
                    copy,
                )?;
                // Flush before waiting for a byte reservation held by pending
                // files. Workers already admitted keep preparing during this call.
                if budget_blocked && !pending.is_empty() {
                    state.flush_pending(&mut budget, &mut pending)?;
                    pending_bytes = 0;
                    continue;
                }
                if window.outstanding() == 0 {
                    if state.gate.cancelled() {
                        break;
                    }
                    return Err("暂存预算无法释放，目录导入已停止".to_string());
                }
                let waiting = Instant::now();
                let (index, outcome) = pool.receive()?;
                state.performance.waiting_micros += elapsed_micros(waiting);
                window.complete(index, outcome);
                while let Some((index, outcome)) = pool.try_receive()? {
                    window.complete(index, outcome);
                }

                let mut successes = Vec::new();
                while let Some((_, outcome)) = window.pop_next() {
                    match outcome {
                        PrepareOutcome::Success(item) => {
                            let timing = &item.timing;
                            state.performance.prepared_books += 1;
                            state.performance.hash_task_micros += timing.hash_micros;
                            state.performance.copy_hash_task_micros += timing.copy_hash_micros;
                            state.performance.metadata_task_micros += timing.metadata_micros;
                            state.performance.verified_source_bytes += timing.verified_bytes;
                            state.performance.staged_write_bytes += timing.staged_bytes;
                            if state.gate.cancelled() {
                                state.cleanup_item(&mut budget, item);
                            } else {
                                successes.push(item);
                            }
                        }
                        PrepareOutcome::Failed {
                            input_id,
                            message,
                            reservation,
                        } => {
                            state.counts.failed += 1;
                            state.push_issue(input_id, ImportIssueKind::SourceFailed, message);
                            budget.release(reservation);
                        }
                        PrepareOutcome::Cancelled { reservation } => budget.release(reservation),
                    }
                    state.counts.completed += 1;
                }
                if !successes.is_empty() {
                    let hashes: Vec<_> = successes
                        .iter()
                        .map(|item| item.content_hash.clone())
                        .collect();
                    let started = Instant::now();
                    let snapshots = state.observe_many(&hashes);
                    state.performance.observe_micros += elapsed_micros(started);
                    for mut item in successes {
                        let observed = snapshots
                            .as_ref()
                            .ok()
                            .and_then(|values| values.get(&item.content_hash))
                            .cloned();
                        if let Some(observed) = observed {
                            item.observed = observed;
                            let bytes = item.retained_metadata_bytes();
                            if !pending.is_empty()
                                && pending_bytes.saturating_add(bytes) > PENDING_METADATA_BYTES
                            {
                                admit_preparations(
                                    pool,
                                    &ordered,
                                    &mut window,
                                    &mut budget,
                                    &state.gate,
                                    &mut state.performance,
                                    copy,
                                )?;
                                state.flush_pending(&mut budget, &mut pending)?;
                                pending_bytes = 0;
                            }
                            pending_bytes = pending_bytes.saturating_add(bytes);
                            pending.push(item);
                            if pending.len() >= MAX_BATCH_BOOKS
                                || pending_bytes >= PENDING_METADATA_BYTES
                            {
                                admit_preparations(
                                    pool,
                                    &ordered,
                                    &mut window,
                                    &mut budget,
                                    &state.gate,
                                    &mut state.performance,
                                    copy,
                                )?;
                                state.flush_pending(&mut budget, &mut pending)?;
                                pending_bytes = 0;
                            }
                        } else {
                            state.counts.failed += 1;
                            let message = snapshots
                                .as_ref()
                                .err()
                                .cloned()
                                .unwrap_or_else(|| "无法读取书籍归属观察值".to_string());
                            state.push_issue(
                                item.input_id.clone(),
                                ImportIssueKind::SourceFailed,
                                message,
                            );
                            state.cleanup_item(&mut budget, item);
                        }
                    }
                }
                let _ = on_progress.send(DirectoryProgress {
                    job_id: job.id().to_string(),
                    phase: super::types::ProgressPhase::Preparing,
                    scanned_inputs: state.counts.completed,
                    total_inputs: Some(total),
                    counts: state.counts.clone(),
                });
                // Refill next iteration, even if another earlier item is slow.
                // Cancel drains already-admitted outcomes without dispatching more.
            }
            state.performance.peak_preparing = pool.peak_active();
            Ok(())
        },
    )?;

    if state.gate.cancelled() {
        for item in pending.drain(..) {
            state.cleanup_item(&mut budget, item);
        }
    } else {
        state.flush_pending(&mut budget, &mut pending)?;
    }

    let status = if state.gate.cancelled() {
        ImportJobStatus::Cancelled
    } else if state.counts.failed > 0 && state.counts.imported == 0 {
        ImportJobStatus::Failed
    } else {
        ImportJobStatus::Completed
    };
    state.performance.elapsed_micros = elapsed_micros(import_started);
    let result = super::types::DirectoryImportResult {
        job_id: job.id().to_string(),
        status,
        counts: state.counts.clone(),
        issue_count: state.issue_count,
        performance: Some(state.performance),
    };
    job.set_result(result.clone());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fi-native-staging-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn c2_fixture(root: &Path) -> ScannedEntry {
        let path = root.join("原书.epub");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in [
            ("META-INF/container.xml", br#"<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>"#.as_slice()),
            ("OPS/content.opf", br#"<package><metadata><title>Copy fixture</title></metadata><manifest><item id="c" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>"#.as_slice()),
            ("OPS/text.xhtml", b"<html><body>synthetic</body></html>".as_slice()),
        ] {
            zip.start_file(name, options).unwrap(); zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        ScannedEntry {
            epub: ScannedEpub {
                input_id: "c2-fixture".into(),
                relative_parent_segments: Vec::new(),
                file_name: "原书.epub".into(),
                size_hint: Some(std::fs::metadata(&path).unwrap().len()),
            },
            source: EntrySource::Path(path),
        }
    }

    #[test]
    fn c2_path_copy_streams_verified_bytes_and_publishes_a_readable_name() {
        let root = temp_file("c2-copy");
        std::fs::create_dir_all(&root).unwrap();
        let entry = c2_fixture(&root);
        assert_eq!(
            select_payload_kind(&entry.source, false),
            PayloadKind::Linked
        );
        assert_eq!(
            select_payload_kind(&entry.source, true),
            PayloadKind::Managed
        );
        assert_eq!(
            select_payload_kind(&EntrySource::TreeUri("content://fixture".into()), false),
            PayloadKind::Managed
        );
        let EntrySource::Path(ref source) = entry.source else {
            unreachable!()
        };
        let original = std::fs::read(source).unwrap();
        let expected = hash_file(source).unwrap().0;
        let mut budget = StageBudget::new(IMPORT_STAGE_BUDGET_BYTES);
        let reservation = budget
            .reserve_payload(PayloadKind::Managed, entry.epub.size_hint)
            .unwrap();
        let mut item = prepare_managed_path(&root, 0, &entry, None, reservation, &|| false)
            .unwrap_or_else(|error| panic!("{}", error.1));
        assert_eq!(item.content_hash, expected);
        assert_eq!(item.timing.staged_bytes, original.len() as u64);
        let PreparedPayload::Managed { ref mut staging } = item.payload else {
            unreachable!()
        };
        let (name, file_snapshot) =
            publish_staged_copy(&root, staging.path(), &entry.epub.file_name, &[]).unwrap();
        staging.published();
        assert_eq!(name, "原书.epub");
        let _binding = make_managed_binding(expected, file_snapshot, &item.metadata)
            .with_managed_file_name(name.clone());
        assert_eq!(
            std::fs::read(root.join("books").join(name)).unwrap(),
            original
        );
        assert_eq!(std::fs::read(source).unwrap(), original);
        budget.release(item.reservation);
        assert_eq!(budget.used(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn c2_cancel_or_invalid_metadata_leaves_no_partial_copy() {
        let root = temp_file("c2-failure");
        std::fs::create_dir_all(&root).unwrap();
        let entry = c2_fixture(&root);
        let mut budget = StageBudget::new(IMPORT_STAGE_BUDGET_BYTES);
        let reservation = budget
            .reserve_payload(PayloadKind::Managed, entry.epub.size_hint)
            .unwrap();
        assert!(
            prepare_managed_path(&root, 0, &entry, None, reservation.clone(), &|| true).is_err()
        );
        budget.release(reservation);
        let EntrySource::Path(ref source) = entry.source else {
            unreachable!()
        };
        std::fs::write(source, b"invalid zip").unwrap();
        let reservation = budget
            .reserve_payload(PayloadKind::Managed, entry.epub.size_hint)
            .unwrap();
        assert!(
            prepare_managed_path(&root, 0, &entry, None, reservation.clone(), &|| false).is_err()
        );
        budget.release(reservation);
        assert_eq!(std::fs::read(source).unwrap(), b"invalid zip");
        assert_eq!(
            std::fs::read_dir(root.join("books/.staging"))
                .unwrap()
                .count(),
            0
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn w1_cancelled_pipeline_cleans_only_its_owned_staging() {
        let paths: Vec<_> = (0..4).map(|_| temp_file("pipeline-cancel")).collect();
        for path in &paths {
            std::fs::write(path, b"owned").unwrap();
        }
        let unrelated = temp_file("unrelated");
        std::fs::write(&unrelated, b"keep").unwrap();
        let gate = super::super::policy::DirectoryJobGate::default();
        let result = with_preparation_pool(
            2,
            4,
            |staging: OwnedStaging| staging,
            |pool| -> Result<(), String> {
                for (n, path) in paths.iter().enumerate() {
                    pool.dispatch(n, OwnedStaging::new(path.clone()))?;
                }
                let (_, completed) = pool.receive()?;
                assert_eq!(gate.cancel(), super::super::policy::CancelReply::Requested);
                drop(completed);
                Err("cancelled".into())
            },
        );
        assert_eq!(result.unwrap_err(), "cancelled");
        assert!(paths.iter().all(|path| !path.exists()));
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"keep");
        std::fs::remove_file(unrelated).unwrap();
    }

    #[test]
    fn owned_staging_removes_an_unpublished_file_on_drop() {
        let path = temp_file("unpublished");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"staged")
            .unwrap();
        let guard = OwnedStaging::new(path.clone());
        assert_eq!(guard.path(), path.as_path());
        drop(guard);
        assert!(!path.exists());
    }

    #[test]
    fn owned_staging_keeps_a_published_target_after_drop() {
        let path = temp_file("published");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"published")
            .unwrap();
        let mut guard = OwnedStaging::new(path.clone());
        guard.published();
        drop(guard);
        assert!(path.exists());
        let _ = std::fs::remove_file(path);
    }
}
