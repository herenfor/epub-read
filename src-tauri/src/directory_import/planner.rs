//! Pure FI planner and placement rules.
//!
//! The TypeScript handoff core and this module must agree on ordering and
//! condition checks.  Inputs are sorted by Unicode scalar value (Rust
//! `char`/`chars()`), never by platform directory enumeration order.

use super::types::{
    ExistingPlacement, GroupingMode, ImportOptions, ImportRoot, ScannedEpub,
};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedGroup {
    pub group_key: String,
    pub source_segments: Vec<String>,
    pub suggested_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedInput {
    pub input_id: String,
    pub ordinal: usize,
    pub group_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPlan {
    pub groups: Vec<PlannedGroup>,
    pub inputs: Vec<PlannedInput>,
    pub flattened: bool,
}

impl ImportPlan {
    pub fn input(&self, input_id: &str) -> Option<&PlannedInput> {
        self.inputs.iter().find(|input| input.input_id == input_id)
    }
}

/** Matches Rust `str.chars()` order; no platform locale or UTF-16 ordering. */
pub fn compare_code_points(a: &str, b: &str) -> std::cmp::Ordering {
    a.chars().cmp(b.chars())
}

fn compare_segments(a: &[String], b: &[String]) -> std::cmp::Ordering {
    a.iter()
        .map(String::as_str)
        .cmp(b.iter().map(String::as_str))
}

pub fn directory_group_key(root: &ImportRoot, segments: &[String]) -> String {
    // JSON array prevents separator/name collisions; never decode display names.
    serde_json::to_string(&(root.source_root_key.as_str(), segments))
        .expect("serializing an opaque group key cannot fail")
}

pub fn proposed_folder_name(root: &ImportRoot, segments: &[String]) -> String {
    let names: Vec<&str> = if segments.is_empty() {
        vec![root.name.as_str()]
    } else {
        segments.iter().map(String::as_str).collect()
    };
    let leaf = names
        .last()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or("导入书籍");
    let mut result: String = leaf.chars().take(40).collect();
    for name in names.iter().rev().skip(1) {
        let prefix = name.trim();
        if prefix.is_empty() {
            continue;
        }
        let candidate = format!("{prefix} · {result}");
        if candidate.chars().count() > 40 {
            break;
        }
        result = candidate;
    }
    result
}

pub fn plan_directory_import(
    root: &ImportRoot,
    entries: &[ScannedEpub],
    options: &ImportOptions,
) -> ImportPlan {
    let has_children = entries
        .iter()
        .any(|entry| !entry.relative_parent_segments.is_empty());

    let mut groups: Vec<PlannedGroup> = Vec::new();
    let mut seen_group_keys: HashSet<String> = HashSet::new();
    let mut mapped: Vec<(Option<String>, &ScannedEpub)> = entries
        .iter()
        .map(|entry| {
            let segments: Option<Vec<String>> = match options.grouping {
                GroupingMode::None => None,
                GroupingMode::SingleFolder => Some(Vec::new()),
                GroupingMode::Auto => {
                    if !entry.relative_parent_segments.is_empty() {
                        Some(entry.relative_parent_segments.clone())
                    } else if !has_children
                        || options.loose_root_books == super::types::LooseRootBooks::NamedFolder
                    {
                        Some(Vec::new())
                    } else {
                        None
                    }
                }
            };
            let group_key = segments.as_ref().map(|segments| {
                let key = directory_group_key(root, segments);
                if seen_group_keys.insert(key.clone()) {
                    groups.push(PlannedGroup {
                        group_key: key.clone(),
                        source_segments: segments.clone(),
                        suggested_name: proposed_folder_name(root, segments),
                    });
                }
                key
            });
            (group_key, entry)
        })
        .collect();

    mapped.sort_by(|(left_key, left_entry), (right_key, right_entry)| {
        // Categorized candidates must precede loose-root duplicates even across
        // batches; completion order never participates.
        let target_order =
            (left_key.is_none() as u8).cmp(&(right_key.is_none() as u8));
        target_order
            .then_with(|| {
                let mut left_path = left_entry.relative_parent_segments.clone();
                left_path.push(left_entry.file_name.clone());
                let mut right_path = right_entry.relative_parent_segments.clone();
                right_path.push(right_entry.file_name.clone());
                compare_segments(&left_path, &right_path)
            })
            .then_with(|| compare_code_points(&left_entry.input_id, &right_entry.input_id))
    });

    groups.sort_by(|left, right| compare_segments(&left.source_segments, &right.source_segments));

    let inputs = mapped
        .into_iter()
        .enumerate()
        .map(|(ordinal, (group_key, entry))| PlannedInput {
            input_id: entry.input_id.clone(),
            ordinal,
            group_key,
        })
        .collect();

    ImportPlan {
        groups,
        inputs,
        flattened: options.grouping == GroupingMode::Auto
            && entries
                .iter()
                .any(|entry| entry.relative_parent_segments.len() > 1),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub device_id: String,
    pub counter: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacementSnapshot {
    pub raw_folder_id: Option<String>,
    /// Absent register differs from explicit null + stamp.
    pub stamp: Option<Stamp>,
    pub effective_folder_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlacementDecision {
    Keep {
        reason: KeepReason,
    },
    Move {
        folder_id: String,
    },
    Skipped {
        reason: SkipReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepReason {
    UnclassifiedTarget,
    ExistingPolicy,
    SameFolder,
    AlreadyClassified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    PlacementChanged,
    TargetDeleted,
}

pub fn decide_placement(
    observed: &PlacementSnapshot,
    current: &PlacementSnapshot,
    is_existing_book: bool,
    target_folder_id: Option<&str>,
    target_is_alive: bool,
    policy: ExistingPlacement,
) -> PlacementDecision {
    let Some(target_folder_id) = target_folder_id else {
        return PlacementDecision::Keep {
            reason: KeepReason::UnclassifiedTarget,
        };
    };
    if is_existing_book && policy == ExistingPlacement::PreserveAll {
        return PlacementDecision::Keep {
            reason: KeepReason::ExistingPolicy,
        };
    }
    let same_stamp = match (&observed.stamp, &current.stamp) {
        (None, None) => true,
        (Some(left), Some(right)) => left.device_id == right.device_id && left.counter == right.counter,
        _ => false,
    };
    if !same_stamp
        || observed.raw_folder_id != current.raw_folder_id
        || observed.effective_folder_id != current.effective_folder_id
    {
        return PlacementDecision::Skipped {
            reason: SkipReason::PlacementChanged,
        };
    }
    if !target_is_alive {
        return PlacementDecision::Skipped {
            reason: SkipReason::TargetDeleted,
        };
    }
    if current.effective_folder_id.as_deref() == Some(target_folder_id) {
        return PlacementDecision::Keep {
            reason: KeepReason::SameFolder,
        };
    }
    if is_existing_book
        && policy == ExistingPlacement::FillUnclassified
        && current.effective_folder_id.is_some()
    {
        return PlacementDecision::Keep {
            reason: KeepReason::AlreadyClassified,
        };
    }
    PlacementDecision::Move {
        folder_id: target_folder_id.to_string(),
    }
}

/// One instance per job, called only in ordinal order after a successful publish.
#[derive(Debug, Default)]
pub struct SuccessfulSources {
    chosen: BTreeMap<String, usize>,
}

impl SuccessfulSources {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn winner(&self, content_hash: &str) -> Option<usize> {
        self.chosen.get(content_hash).copied()
    }

    pub fn record_published(&mut self, content_hash: &str, ordinal: usize) {
        self.chosen.entry(content_hash.to_string()).or_insert(ordinal);
    }
}

/// Targets supplied by the UI must cover exactly the plan groups once each.
pub fn validate_targets(
    plan: &ImportPlan,
    targets: &[super::types::FolderTarget],
) -> Result<HashMap<String, super::types::FolderTarget>, String> {
    let expected: HashSet<&str> = plan.groups.iter().map(|group| group.group_key.as_str()).collect();
    let mut by_group: HashMap<String, super::types::FolderTarget> = HashMap::new();
    for target in targets {
        let group_key = target.group_key();
        if !expected.contains(group_key) {
            return Err(format!("targets 包含未知目录分组：{group_key}"));
        }
        if by_group.insert(group_key.to_string(), target.clone()).is_some() {
            return Err(format!("targets 目录分组重复：{group_key}"));
        }
    }
    if by_group.len() != expected.len() {
        return Err("targets 必须恰好覆盖本次计划的全部分组".to_string());
    }
    Ok(by_group)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{ExistingPlacement, GroupingMode, LooseRootBooks};

    fn root() -> ImportRoot {
        ImportRoot {
            source_root_key: "local-root".to_string(),
            name: "全部书籍".to_string(),
        }
    }

    fn options() -> ImportOptions {
        ImportOptions {
            grouping: GroupingMode::Auto,
            loose_root_books: LooseRootBooks::Root,
            existing_placement: ExistingPlacement::FillUnclassified,
        }
    }

    fn entry(input_id: &str, segments: &[&str], file_name: &str) -> ScannedEpub {
        ScannedEpub {
            input_id: input_id.to_string(),
            relative_parent_segments: segments.iter().map(|value| value.to_string()).collect(),
            file_name: file_name.to_string(),
            size_hint: None,
        }
    }

    #[test]
    fn plan_orders_categorized_before_loose_root_then_by_code_points() {
        let plan = plan_directory_import(
            &root(),
            &[
                entry("loose", &[], "0.epub"),
                entry("deep", &["分类", "系列"], "z.epub"),
                entry("root", &[], "a.epub"),
            ],
            &options(),
        );
        assert_eq!(plan.inputs.len(), 3);
        assert_eq!(plan.inputs[0].input_id, "deep");
        assert_eq!(plan.inputs[1].input_id, "loose");
        assert_eq!(plan.inputs[2].input_id, "root");
        assert_eq!(plan.inputs[0].ordinal, 0);
        assert!(plan.flattened);
        assert_eq!(plan.groups.len(), 1);
        assert_eq!(plan.groups[0].suggested_name, "分类 · 系列");
    }

    #[test]
    fn root_only_entries_create_root_named_folder() {
        let plan = plan_directory_import(
            &root(),
            &[entry("one", &[], "a.epub")],
            &options(),
        );
        assert_eq!(plan.groups.len(), 1);
        assert_eq!(plan.groups[0].source_segments, Vec::<String>::new());
        assert_eq!(plan.groups[0].suggested_name, "全部书籍");
        assert_eq!(plan.inputs[0].group_key, Some(plan.groups[0].group_key.clone()));
    }

    #[test]
    fn grouping_none_has_no_targets_and_single_folder_ignores_source_segments() {
        let mut none = options();
        none.grouping = GroupingMode::None;
        let plan = plan_directory_import(
            &root(),
            &[entry("deep", &["分类"], "a.epub")],
            &none,
        );
        assert!(plan.groups.is_empty());
        assert_eq!(plan.inputs[0].group_key, None);

        let mut single = options();
        single.grouping = GroupingMode::SingleFolder;
        let plan = plan_directory_import(
            &root(),
            &[entry("deep", &["分类"], "a.epub")],
            &single,
        );
        assert_eq!(plan.groups.len(), 1);
        assert_eq!(plan.groups[0].suggested_name, "全部书籍");
        assert_eq!(plan.inputs[0].group_key, Some(plan.groups[0].group_key.clone()));
    }

    #[test]
    fn group_key_distinguishes_segment_separator_and_name() {
        assert_ne!(
            directory_group_key(&root(), &[ "a · b".to_string() ]),
            directory_group_key(&root(), &[ "a".to_string(), "b".to_string() ]),
        );
    }

    #[test]
    fn placement_rechecks_aba_stamp_and_user_change() {
        let observed = PlacementSnapshot {
            raw_folder_id: Some("old".to_string()),
            stamp: Some(Stamp {
                device_id: "device".to_string(),
                counter: 1,
            }),
            effective_folder_id: Some("old".to_string()),
        };
        let changed_stamp = PlacementSnapshot {
            stamp: Some(Stamp {
                device_id: "device".to_string(),
                counter: 2,
            }),
            ..observed.clone()
        };
        assert_eq!(
            decide_placement(
                &observed,
                &changed_stamp,
                true,
                Some("new"),
                true,
                ExistingPlacement::Replace,
            ),
            PlacementDecision::Skipped {
                reason: SkipReason::PlacementChanged,
            }
        );

        let dissolved = PlacementSnapshot {
            effective_folder_id: None,
            ..observed.clone()
        };
        assert_eq!(
            decide_placement(
                &observed,
                &dissolved,
                true,
                Some("new"),
                true,
                ExistingPlacement::FillUnclassified,
            ),
            PlacementDecision::Skipped {
                reason: SkipReason::PlacementChanged,
            }
        );
        assert_eq!(
            decide_placement(
                &observed,
                &observed,
                true,
                None,
                false,
                ExistingPlacement::Replace,
            ),
            PlacementDecision::Keep {
                reason: KeepReason::UnclassifiedTarget,
            }
        );
        assert_eq!(
            decide_placement(
                &observed,
                &observed,
                true,
                Some("new"),
                true,
                ExistingPlacement::FillUnclassified,
            ),
            PlacementDecision::Keep {
                reason: KeepReason::AlreadyClassified,
            }
        );
    }

    #[test]
    fn successful_sources_remeber_first_published_ordinal_only() {
        let mut successful = SuccessfulSources::new();
        assert_eq!(successful.winner("hash"), None);
        successful.record_published("hash", 3);
        successful.record_published("hash", 8);
        assert_eq!(successful.winner("hash"), Some(3));
    }
}
