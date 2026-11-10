//! Pure FI planner and placement rules.
//!
//! The TypeScript handoff core and this module must agree on ordering and
//! condition checks.  Inputs are sorted by Unicode scalar value (Rust
//! `char`/`chars()`), never by platform directory enumeration order.

use super::types::{
    ExistingPlacement, GroupingMode, ImportAnchor, ImportOptions, ImportRoot, ScannedEpub,
};
use crate::library_organization::MAX_FOLDER_DEPTH;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedGroup {
    pub group_key: String,
    /// Source path prefix represented by this folder, never a display path.
    pub source_segments: Vec<String>,
    pub parent_group_key: Option<String>,
    /// Absolute shelf depth (1..=5).
    pub depth: u32,
    pub suggested_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedInput {
    pub input_id: String,
    pub ordinal: usize,
    pub group_key: Option<String>,
    /// Set only when the current folder is the deepest allowed target.
    pub direct_folder_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPlan {
    pub groups: Vec<PlannedGroup>,
    pub inputs: Vec<PlannedInput>,
    pub flattened: bool,
    pub anchor_folder_id: Option<String>,
    pub anchor_depth: u32,
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

/// Local binding key. A non-root anchor adds the current folder so the same
/// source tree under different shelf parents cannot overwrite one mapping.
/// Root imports keep the legacy two-element key and existing bindings.
pub fn directory_group_key(
    root: &ImportRoot,
    segments: &[String],
    anchor_folder_id: Option<&str>,
) -> String {
    let tuple = match anchor_folder_id {
        None => serde_json::json!([root.source_root_key, segments]),
        Some(anchor) => serde_json::json!([root.source_root_key, segments, anchor]),
    };
    serde_json::to_string(&tuple).expect("serializing an opaque group key cannot fail")
}

/// A tree folder uses the leaf name only; package 3 shows the path separately.
pub fn proposed_folder_name(root: &ImportRoot, segments: &[String]) -> String {
    let raw = segments
        .last()
        .map(String::as_str)
        .unwrap_or(root.name.as_str());
    let raw = crate::library_organization::js_trim(raw);
    let raw = if raw.is_empty() { "导入书籍" } else { raw };
    raw.chars().take(40).collect()
}

fn normalized_anchor(anchor: Option<&ImportAnchor>) -> (Option<String>, u32) {
    let folder_id = anchor.and_then(|anchor| anchor.folder_id.clone());
    let depth = if folder_id.is_none() {
        0
    } else {
        anchor
            .map(|anchor| anchor.depth.min(MAX_FOLDER_DEPTH as u32))
            .unwrap_or(0)
    };
    (folder_id, depth)
}

fn ensure_group(
    root: &ImportRoot,
    segments: &[String],
    anchor_folder_id: Option<&str>,
    anchor_depth: u32,
    groups: &mut Vec<PlannedGroup>,
    seen: &mut HashSet<String>,
) -> String {
    let key = directory_group_key(root, segments, anchor_folder_id);
    if seen.contains(&key) {
        return key;
    }
    let parent_group_key = if segments.is_empty() {
        None
    } else {
        Some(ensure_group(
            root,
            &segments[..segments.len() - 1],
            anchor_folder_id,
            anchor_depth,
            groups,
            seen,
        ))
    };
    groups.push(PlannedGroup {
        group_key: key.clone(),
        source_segments: segments.to_vec(),
        parent_group_key,
        depth: anchor_depth + segments.len() as u32 + 1,
        suggested_name: proposed_folder_name(root, segments),
    });
    seen.insert(key.clone());
    key
}

pub fn plan_directory_import(
    root: &ImportRoot,
    entries: &[ScannedEpub],
    options: &ImportOptions,
    anchor: Option<&ImportAnchor>,
) -> ImportPlan {
    let (anchor_folder_id, anchor_depth) = normalized_anchor(anchor);
    let max_new_depth = (MAX_FOLDER_DEPTH as u32).saturating_sub(anchor_depth);
    let has_children = entries
        .iter()
        .any(|entry| !entry.relative_parent_segments.is_empty());
    let mut groups: Vec<PlannedGroup> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let direct_anchor = if max_new_depth == 0 || options.grouping == GroupingMode::None {
        anchor_folder_id.clone()
    } else {
        None
    };

    let mut mapped: Vec<(Option<String>, Option<String>, u8, &ScannedEpub)> = entries
        .iter()
        .map(|entry| {
            if direct_anchor.is_some() {
                return (None, direct_anchor.clone(), 1, entry);
            }
            match options.grouping {
                GroupingMode::None => (None, None, 0, entry),
                GroupingMode::SingleFolder => (
                    Some(ensure_group(
                        root,
                        &[],
                        anchor_folder_id.as_deref(),
                        anchor_depth,
                        &mut groups,
                        &mut seen,
                    )),
                    None,
                    0,
                    entry,
                ),
                GroupingMode::Auto => {
                    if entry.relative_parent_segments.is_empty() {
                        if options.loose_root_books == super::types::LooseRootBooks::NamedFolder
                            || !has_children
                        {
                            (
                                Some(ensure_group(
                                    root,
                                    &[],
                                    anchor_folder_id.as_deref(),
                                    anchor_depth,
                                    &mut groups,
                                    &mut seen,
                                )),
                                None,
                                1,
                                entry,
                            )
                        } else {
                            (
                                None,
                                anchor_folder_id.clone(),
                                if anchor_folder_id.is_none() { 2 } else { 1 },
                                entry,
                            )
                        }
                    } else {
                        let prefix_len = entry
                            .relative_parent_segments
                            .len()
                            .min(max_new_depth.saturating_sub(1) as usize);
                        (
                            Some(ensure_group(
                                root,
                                &entry.relative_parent_segments[..prefix_len],
                                anchor_folder_id.as_deref(),
                                anchor_depth,
                                &mut groups,
                                &mut seen,
                            )),
                            None,
                            0,
                            entry,
                        )
                    }
                }
            }
        })
        .collect();

    let flattened = options.grouping == GroupingMode::Auto
        && entries.iter().any(|entry| {
            entry.relative_parent_segments.len()
                > max_new_depth.saturating_sub(1) as usize
        });

    mapped.sort_by(|(_, _, left_priority, left_entry), (_, _, right_priority, right_entry)| {
        // Deeper categorized candidates precede direct-root books; global
        // unclassified entries come last across batches.
        left_priority
            .cmp(right_priority)
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
        .map(|(ordinal, (group_key, direct_folder_id, _, entry))| PlannedInput {
            input_id: entry.input_id.clone(),
            ordinal,
            group_key,
            direct_folder_id,
        })
        .collect();

    ImportPlan {
        groups,
        inputs,
        flattened,
        anchor_folder_id,
        anchor_depth,
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
            None,
        );
        assert_eq!(plan.inputs.len(), 3);
        assert_eq!(plan.inputs[0].input_id, "deep");
        assert_eq!(plan.inputs[1].input_id, "loose");
        assert_eq!(plan.inputs[2].input_id, "root");
        assert_eq!(plan.inputs[0].ordinal, 0);
        assert!(!plan.flattened);
        assert_eq!(
            plan.groups
                .iter()
                .map(|group| (group.suggested_name.as_str(), group.depth))
                .collect::<Vec<_>>(),
            vec![("全部书籍", 1), ("分类", 2), ("系列", 3)]
        );
    }

    #[test]
    fn root_only_entries_create_root_named_folder() {
        let plan = plan_directory_import(
            &root(),
            &[entry("one", &[], "a.epub")],
            &options(),
            None,
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
            None,
        );
        assert!(plan.groups.is_empty());
        assert_eq!(plan.inputs[0].group_key, None);

        let mut single = options();
        single.grouping = GroupingMode::SingleFolder;
        let plan = plan_directory_import(
            &root(),
            &[entry("deep", &["分类"], "a.epub")],
            &single,
            None,
        );
        assert_eq!(plan.groups.len(), 1);
        assert_eq!(plan.groups[0].suggested_name, "全部书籍");
        assert_eq!(plan.inputs[0].group_key, Some(plan.groups[0].group_key.clone()));
    }

    #[test]
    fn group_key_distinguishes_segment_separator_and_name() {
        assert_ne!(
            directory_group_key(&root(), &[ "a · b".to_string() ], None),
            directory_group_key(&root(), &[ "a".to_string(), "b".to_string() ], None),
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

#[cfg(test)]
mod tree_tests {
    use super::*;
    use super::super::types::{ExistingPlacement, GroupingMode, ImportAnchor, LooseRootBooks};

    fn root() -> ImportRoot {
        ImportRoot { source_root_key: "local-root".into(), name: "全部书籍".into() }
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
            input_id: input_id.into(),
            relative_parent_segments: segments.iter().map(|s| s.to_string()).collect(),
            file_name: file_name.into(),
            size_hint: None,
        }
    }

    #[test]
    fn tree_groups_have_parents_and_deep_books_cap_at_five() {
        let plan = plan_directory_import(
            &root(),
            &[
                entry("deep", &["A", "B", "C", "D", "E", "F"], "deep.epub"),
                entry("loose", &[], "loose.epub"),
            ],
            &options(),
            None,
        );
        assert_eq!(
            plan.groups.iter().map(|g| (g.suggested_name.as_str(), g.depth)).collect::<Vec<_>>(),
            vec![("全部书籍", 1), ("A", 2), ("B", 3), ("C", 4), ("D", 5)]
        );
        assert!(plan.flattened);
        assert_eq!(plan.groups[0].parent_group_key, None);
        for pair in plan.groups.windows(2) {
            assert_eq!(pair[1].parent_group_key.as_deref(), Some(pair[0].group_key.as_str()));
        }
        let deep = plan.inputs.iter().find(|i| i.input_id == "deep").unwrap();
        assert_eq!(deep.group_key.as_deref(), Some(plan.groups[4].group_key.as_str()));
        assert!(plan.inputs.iter().find(|i| i.input_id == "loose").unwrap().group_key.is_none());
    }

    #[test]
    fn current_folder_depth_uses_direct_target_at_five_and_counts_layers() {
        let anchored = plan_directory_import(
            &root(),
            &[entry("deep", &["A", "B"], "a.epub")],
            &options(),
            Some(&ImportAnchor { folder_id: Some("current".into()), depth: 3 }),
        );
        assert_eq!(anchored.anchor_folder_id.as_deref(), Some("current"));
        assert_eq!(anchored.anchor_depth, 3);
        assert_eq!(anchored.groups.iter().map(|g| (g.suggested_name.as_str(), g.depth)).collect::<Vec<_>>(),
            vec![("全部书籍", 4), ("A", 5)]);
        assert_eq!(anchored.inputs[0].group_key.as_deref(), Some(anchored.groups[1].group_key.as_str()));

        let direct = plan_directory_import(
            &root(),
            &[entry("one", &["A"], "a.epub")],
            &options(),
            Some(&ImportAnchor { folder_id: Some("current".into()), depth: 5 }),
        );
        assert!(direct.groups.is_empty());
        assert_eq!(direct.inputs[0].group_key, None);
        assert_eq!(direct.inputs[0].direct_folder_id.as_deref(), Some("current"));
    }

    #[test]
    fn loose_root_books_follow_the_named_layer_or_current_anchor() {
        let mut named = options();
        named.loose_root_books = LooseRootBooks::NamedFolder;
        let plan = plan_directory_import(
            &root(),
            &[entry("loose", &[], "loose.epub"), entry("deep", &["A"], "deep.epub")],
            &named,
            None,
        );
        let root_group = plan.groups.iter().find(|g| g.source_segments.is_empty()).unwrap();
        assert_eq!(plan.inputs.iter().find(|i| i.input_id == "loose").unwrap().group_key.as_deref(), Some(root_group.group_key.as_str()));

        let fallback = plan_directory_import(
            &root(),
            &[entry("loose", &[], "loose.epub"), entry("deep", &["A"], "deep.epub")],
            &options(),
            Some(&ImportAnchor { folder_id: Some("current".into()), depth: 3 }),
        );
        let loose = fallback.inputs.iter().find(|i| i.input_id == "loose").unwrap();
        assert_eq!(loose.group_key, None);
        assert_eq!(loose.direct_folder_id.as_deref(), Some("current"));

        let root_fallback = plan_directory_import(
            &root(),
            &[entry("loose", &[], "loose.epub"), entry("deep", &["A"], "deep.epub")],
            &options(),
            None,
        );
        let loose = root_fallback.inputs.iter().find(|i| i.input_id == "loose").unwrap();
        assert!(loose.direct_folder_id.is_none());
    }

    #[test]
    fn binding_key_includes_non_root_anchor_but_keeps_legacy_root_key() {
        let legacy = directory_group_key(&root(), &["A".into()], None);
        assert_eq!(legacy, serde_json::to_string(&("local-root", vec!["A"])).unwrap());
        assert_ne!(legacy, directory_group_key(&root(), &["A".into()], Some("current")));
    }
}
