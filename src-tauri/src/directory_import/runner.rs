//! Bounded native directory-import coordinator.
//!
//! Preparation is ordered and the staging budget is held until publish,
//! duplicate cleanup or failure.  Commit batches flush on the 64-book boundary
//! or as soon as the staging budget blocks the next reservation.

use super::planner::{
    decide_placement, plan_directory_import, validate_targets, PlacementDecision,
    PlacementSnapshot, SkipReason, SuccessfulSources,
};
use super::policy::{Reservation, StageBudget};
use super::types::{
    DirectoryProgress, EntrySource, ExistingPlacement, FolderTarget, ImportCounts,
    ImportIssue, ImportIssueKind, ImportJobStatus, ImportOptions, ScannedEntry,
    ScannedEpub,
};
use crate::linked_library::{
    canonical_epub_path, hash_file, inspect_epub, library_root, make_binding,
    make_managed_binding, make_managed_record, managed_source_path, replace_file_atomically,
    snapshot, verify_binding_for_list_refresh, DeviceBinding, FileSnapshot,
    ImportedMetadata, LinkedLibraryRecord,
};
#[cfg(target_os = "android")]
use crate::linked_library::{
    new_staging_path, stream_restricted_reader_to_staging, PrepareError,
};
use crate::portable_state::{
    DirectoryBindingWrite, DirectoryFolderCreate, DirectoryImportBatchOutcome,
    DirectoryPlacementDecision, DirectoryPlacementRequest, DirectoryPlacementSnapshot,
};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::AppHandle;

const MAX_BATCH_BOOKS: usize = 64;
const STAGE_BUDGET_BYTES: u64 = 64 * 1024 * 1024;

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
}

enum PreparedPayload {
    Linked { path: PathBuf, snapshot: FileSnapshot },
    Managed { staging: OwnedStaging },
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
            store.publish_directory_import_batch(
                values,
                rows,
                visible_hashes,
                is_new_hashes,
            )
        })
        .map_err(|error| error.to_string())?;
        result.ok_or_else(|| "可移植资料仓储未激活".to_string())
    }

    fn existing_binding_available(&self, content_hash: &str) -> Result<bool, String> {
        let raw = match crate::portable_state_commands::with_existing_store(
            &self.app,
            |store| store.binding_raw(content_hash),
        ) {
            Ok(Some(value)) => value,
            Ok(None) => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        let Some(raw) = raw else {
            return Ok(false);
        };
        let mut binding: DeviceBinding = serde_json::from_str(&raw)
            .map_err(|error| format!("设备绑定损坏：{error}"))?;
        let verification = verify_binding_for_list_refresh(&mut binding, &self.root)?;
        Ok(verification.available)
    }

    fn cleanup_item(&self, budget: &mut StageBudget, item: PreparedSuccess) {
        let PreparedSuccess {
            payload, reservation, ..
        } = item;
        drop(payload);
        budget.release(reservation);
    }

    fn publish(&self, item: &mut PreparedSuccess) -> Result<(LinkedLibraryRecord, DeviceBinding), String> {
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
                let target = managed_source_path(&self.root, &item.content_hash)?;
                let staging_path = staging.path().to_path_buf();
                replace_file_atomically(&staging_path, &target)
                    .map_err(|error| format!("无法发布托管副本：{error}"))?;
                staging.published();
                let snapshot = snapshot(&target)?;
                let binding = make_managed_binding(
                    item.content_hash.clone(),
                    snapshot,
                    &item.metadata,
                );
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
        let batch = std::mem::take(pending);
        if !self.gate.begin_batch() {
            for item in batch {
                self.cleanup_item(budget, item);
            }
            return Ok(());
        }

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
            let published: Result<Option<(LinkedLibraryRecord, DeviceBinding)>, String> =
                if existing_available {
                    Ok(None)
                } else {
                    self.publish(&mut item).map(Some)
                };
            match published {
                Ok(published) => {
                    if let Some((mut record, binding)) = published {
                        if item.observed.is_existing_book {
                            record.is_new = false;
                        }
                        records.push(record);
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
                            if !group_targets.iter().any(|(existing, _)| existing == group_key) {
                                group_targets
                                    .push((group_key.clone(), target.folder_id.clone()));
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
            let result = crate::portable_state_commands::with_existing_store(
                &self.app,
                |store| {
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
                                PlacementDecision::Keep { .. } => {
                                    DirectoryPlacementDecision::Keep
                                }
                                PlacementDecision::Move { .. } => {
                                    DirectoryPlacementDecision::Move
                                }
                                PlacementDecision::Skipped {
                                    reason: SkipReason::PlacementChanged,
                                } => DirectoryPlacementDecision::PlacementChanged,
                                PlacementDecision::Skipped {
                                    reason: SkipReason::TargetDeleted,
                                } => DirectoryPlacementDecision::TargetDeleted,
                            }
                        },
                    )
                },
            );
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
    reservation: Reservation,
) -> PrepareOutcome {
    let cancelled = || gate.cancelled();
    let result: Result<PreparedSuccess, (bool, String)> = match &entry.source {
        EntrySource::Path(_) => prepare_linked(entry, ordinal, group_key, reservation.clone()),
        EntrySource::TreeUri(uri) => {
            prepare_managed(app, root, uri, ordinal, entry, group_key, reservation.clone(), &cancelled)
        }
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
    let path = canonical_epub_path(&source_path.to_string_lossy())
        .map_err(|error| (false, error))?;
    let (content_hash, hashed_snapshot) =
        hash_file(&path).map_err(|error| (false, error))?;
    let metadata = inspect_epub(&path).map_err(|error| (false, error))?;
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
    let staging = OwnedStaging::new(new_staging_path(root).map_err(|error| (false, error))?);
    let mut reader = crate::android_uri_bridge::open_content_uri(app, uri)
        .map_err(|error| (false, format!("无法打开 Android content URI：{error}")))?;
    let staged = match stream_restricted_reader_to_staging(&mut reader, staging.path(), cancelled) {
        Ok(staged) => staged,
        Err(PrepareError::Cancelled { .. }) => return Err((true, String::new())),
        Err(PrepareError::Failed { message, .. }) => return Err((false, message)),
    };
    let content_hash = staged.content_hash;
    let metadata = inspect_epub(staging.path()).map_err(|error| (false, error))?;
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
    Err((false, "Android 树 URI 导入仅可在 Android 上运行".to_string()))
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
) -> Result<super::types::DirectoryImportResult, String> {
    let root = job
        .root()
        .ok_or_else(|| "目录扫描尚未完成".to_string())?;
    let entries = job.entries();
    let public_entries: Vec<ScannedEpub> = entries.iter().map(|entry| entry.epub.clone()).collect();
    let plan = plan_directory_import(&root, &public_entries, &options);
    let target_specs = target_specs(&plan, &targets)?;
    let root_path = library_root(app)?;

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
    };
    let mut budget = StageBudget::new(STAGE_BUDGET_BYTES);
    let mut pending: Vec<PreparedSuccess> = Vec::new();
    let total = ordered.len();
    let width = if cfg!(target_os = "android") { 2 } else { 4 };
    let mut next = 0usize;

    while next < total {
        if state.gate.cancelled() {
            break;
        }

        // Fill one ordered preparation window.  A big/unknown source
        // automatically becomes a one-item window because its reservation
        // blocks every later reservation until publish/cleanup releases it.
        let wave_start = next;
        let mut wave: Vec<(usize, ScannedEntry, Option<String>, Reservation)> = Vec::new();
        while next < total && wave.len() < width {
            let (planned, entry) = &ordered[next];
            match budget.reserve(entry.epub.size_hint) {
                Some(reservation) => {
                    wave.push((
                        planned.ordinal,
                        entry.clone(),
                        planned.group_key.clone(),
                        reservation,
                    ));
                    next += 1;
                }
                None => break,
            }
        }

        if wave.is_empty() {
            if !pending.is_empty() {
                state.flush_pending(&mut budget, &mut pending)?;
                continue;
            }
            return Err("暂存预算无法释放，目录导入已停止".to_string());
        }

        let outcomes: Vec<PrepareOutcome> = std::thread::scope(|scope| {
            let handles: Vec<_> = wave
                .into_iter()
                .map(|(ordinal, entry, group_key, reservation)| {
                    let app = state.app.clone();
                    let root = state.root.clone();
                    let gate = Arc::clone(&state.gate);
                    scope.spawn(move || {
                        prepare_one(
                            &app,
                            &root,
                            &gate,
                            ordinal,
                            &entry,
                            group_key,
                            reservation,
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("directory import worker panicked"))
                .collect()
        });

        let mut cancelled_in_wave = false;
        let mut wave_successes: Vec<PreparedSuccess> = Vec::new();
        for (offset, outcome) in outcomes.into_iter().enumerate() {
            match outcome {
                PrepareOutcome::Success(item) => {
                    if state.gate.cancelled() {
                        state.cleanup_item(&mut budget, item);
                    } else {
                        wave_successes.push(item);
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
                PrepareOutcome::Cancelled { reservation } => {
                    budget.release(reservation);
                    cancelled_in_wave = true;
                }
            }

            let completed = wave_start + offset + 1;
            state.counts.completed = completed;
            let _ = on_progress.send(DirectoryProgress {
                job_id: job.id().to_string(),
                phase: super::types::ProgressPhase::Preparing,
                scanned_inputs: completed,
                total_inputs: Some(total),
                counts: state.counts.clone(),
            });
        }

        if !cancelled_in_wave && !state.gate.cancelled() && !wave_successes.is_empty() {
            let hashes: Vec<String> = wave_successes
                .iter()
                .map(|item| item.content_hash.clone())
                .collect();
            match state.observe_many(&hashes) {
                Ok(snapshots) => {
                    for mut item in wave_successes {
                        match snapshots.get(&item.content_hash).cloned() {
                            Some(observed) => {
                                item.observed = observed;
                                pending.push(item);
                            }
                            None => {
                                let input_id = item.input_id.clone();
                                state.counts.failed += 1;
                                state.push_issue(
                                    input_id,
                                    ImportIssueKind::SourceFailed,
                                    "无法读取书籍归属观察值".to_string(),
                                );
                                state.cleanup_item(&mut budget, item);
                            }
                        }
                    }
                }
                Err(message) => {
                    for item in wave_successes {
                        let input_id = item.input_id.clone();
                        state.counts.failed += 1;
                        state.push_issue(input_id, ImportIssueKind::SourceFailed, message.clone());
                        state.cleanup_item(&mut budget, item);
                    }
                }
            }
        } else {
            for item in wave_successes {
                state.cleanup_item(&mut budget, item);
            }
        }

        if pending.len() >= MAX_BATCH_BOOKS {
            state.flush_pending(&mut budget, &mut pending)?;
        }

        if cancelled_in_wave || state.gate.cancelled() {
            break;
        }
    }

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
    let result = super::types::DirectoryImportResult {
        job_id: job.id().to_string(),
        status,
        counts: state.counts.clone(),
        issue_count: state.issue_count,
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
