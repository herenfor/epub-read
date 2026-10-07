//! Real filesystem / SAF scanning for FI-N.
//!
//! Windows and Unix path scanning iterate the selected system directory and do
//! not follow symlinks or junctions.  Android uses DocumentsContract through
//! the app-local bridge and never splits a content URI into a fake path.

use super::types::{EntrySource, ImportRoot, ScannedEntry, ScannedEpub};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ScanOutput {
    pub root: ImportRoot,
    pub entries: Vec<ScannedEntry>,
    pub skipped_directory_count: usize,
    pub unreadable_directory_count: usize,
    pub cancelled: bool,
}

impl ScanOutput {
    pub fn new(root: ImportRoot) -> Self {
        Self {
            root,
            entries: Vec::new(),
            skipped_directory_count: 0,
            unreadable_directory_count: 0,
            cancelled: false,
        }
    }
}

/// Stable opaque local source-root key.  It is based on the canonical selected
/// root path, not on the directory display name and not on the job id.
pub fn path_source_root_key(canonical_root: &Path) -> String {
    format!("path:{}", canonical_root.to_string_lossy())
}

fn is_candidate_epub(file_name: &str) -> bool {
    file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.eq_ignore_ascii_case("epub"))
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn scan_directory(
    directory: &Path,
    relative_segments: &[String],
    output: &mut ScanOutput,
    cancelled: &dyn Fn() -> bool,
) -> bool {
    if cancelled() {
        output.cancelled = true;
        return true;
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            output.unreadable_directory_count += 1;
            return false;
        }
    };

    for entry in entries {
        if cancelled() {
            output.cancelled = true;
            return true;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                output.unreadable_directory_count += 1;
                continue;
            }
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                output.unreadable_directory_count += 1;
                continue;
            }
        };

        if is_reparse_point(&metadata) {
            output.skipped_directory_count += 1;
            continue;
        }

        if metadata.is_dir() {
            let mut next_segments = relative_segments.to_vec();
            next_segments.push(file_name);
            if scan_directory(&path, &next_segments, output, cancelled) {
                return true;
            }
            continue;
        }
        if !metadata.is_file() || !is_candidate_epub(&file_name) {
            continue;
        }

        let canonical = match std::fs::canonicalize(&path) {
            Ok(path) => path,
            Err(_) => {
                output.unreadable_directory_count += 1;
                continue;
            }
        };
        output.entries.push(ScannedEntry {
            epub: ScannedEpub {
                input_id: canonical.to_string_lossy().to_string(),
                relative_parent_segments: relative_segments.to_vec(),
                file_name,
                size_hint: Some(metadata.len()),
            },
            source: EntrySource::Path(canonical),
        });
    }
    false
}

/// Scans a canonical Windows/Unix directory.  The caller has already resolved
/// the user-selected root and produced `root_name`.
pub fn scan_path_root(canonical_root: &Path, root_name: String) -> Result<ScanOutput, String> {
    scan_path_root_cancellable(canonical_root, root_name, &|| false)
}

pub fn scan_path_root_cancellable(
    canonical_root: &Path,
    root_name: String,
    cancelled: &dyn Fn() -> bool,
) -> Result<ScanOutput, String> {
    let canonical_root = std::fs::canonicalize(canonical_root)
        .map_err(|error| format!("无法解析所选目录：{error}"))?;
    let metadata = std::fs::metadata(&canonical_root)
        .map_err(|error| format!("无法读取所选目录属性：{error}"))?;
    if !metadata.is_dir() {
        return Err("所选来源不是文件夹".to_string());
    }
    let mut output = ScanOutput::new(ImportRoot {
        source_root_key: path_source_root_key(&canonical_root),
        name: root_name,
    });
    output.cancelled = scan_directory(&canonical_root, &[], &mut output, cancelled);
    Ok(output)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidEntry {
    pub document_id: String,
    pub uri: String,
    pub display_name: String,
    pub mime_type: String,
    pub size: Option<u64>,
    pub is_directory: bool,
}

pub trait AndroidTreeBridge {
    /// Returns this directory's display name and its direct children.  Cursors
    /// must be closed by the implementation before returning.
    fn query_directory(
        &self,
        tree_uri: &str,
        parent_document_id: Option<&str>,
    ) -> Result<(String, Vec<AndroidEntry>), String>;
}

pub fn scan_android_tree(
    bridge: &dyn AndroidTreeBridge,
    tree_uri: &str,
) -> Result<ScanOutput, String> {
    scan_android_tree_cancellable(bridge, tree_uri, &|| false)
}

pub fn scan_android_tree_cancellable(
    bridge: &dyn AndroidTreeBridge,
    tree_uri: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<ScanOutput, String> {
    if !tree_uri.starts_with("content://") {
        return Err("Android 目录来源必须是 content:// 树 URI".to_string());
    }
    let mut output = ScanOutput::new(ImportRoot {
        source_root_key: format!("tree:{tree_uri}"),
        name: String::new(),
    });
    if cancelled() {
        output.cancelled = true;
        return Ok(output);
    }
    let (root_name, root_children) = bridge.query_directory(tree_uri, None)?;
    if cancelled() {
        output.cancelled = true;
        return Ok(output);
    }
    output.root.name = root_name;
    output.cancelled = scan_android_children(
        bridge,
        tree_uri,
        &root_children,
        &[],
        &mut output,
        cancelled,
    )?;
    Ok(output)
}

fn scan_android_children(
    bridge: &dyn AndroidTreeBridge,
    tree_uri: &str,
    children: &[AndroidEntry],
    relative_segments: &[String],
    output: &mut ScanOutput,
    cancelled: &dyn Fn() -> bool,
) -> Result<bool, String> {
    for child in children {
        if cancelled() {
            output.cancelled = true;
            return Ok(true);
        }
        if child.is_directory {
            let mut next_segments = relative_segments.to_vec();
            next_segments.push(child.display_name.clone());
            let result = bridge.query_directory(tree_uri, Some(&child.document_id));
            if cancelled() {
                output.cancelled = true;
                return Ok(true);
            }
            match result {
                Ok((_name, grandchildren)) => {
                    if scan_android_children(
                        bridge,
                        tree_uri,
                        &grandchildren,
                        &next_segments,
                        output,
                        cancelled,
                    )? {
                        return Ok(true);
                    }
                }
                Err(_) => {
                    output.unreadable_directory_count += 1;
                }
            }
            continue;
        }

        if !child.mime_type.eq_ignore_ascii_case("application/epub+zip")
            && !is_candidate_epub(&child.display_name)
        {
            continue;
        }
        output.entries.push(ScannedEntry {
            epub: ScannedEpub {
                input_id: child.uri.clone(),
                relative_parent_segments: relative_segments.to_vec(),
                file_name: child.display_name.clone(),
                size_hint: child.size,
            },
            source: EntrySource::TreeUri(child.uri.clone()),
        });
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_scan_skips_non_epub_and_preserves_parent_segments() {
        let root = std::env::temp_dir().join(format!(
            "fi-native-scan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("小说").join("系列")).unwrap();
        std::fs::write(root.join("a.epub"), b"a").unwrap();
        std::fs::write(root.join("b.txt"), b"b").unwrap();
        std::fs::write(root.join("小说").join("c.EPUB"), b"c").unwrap();
        std::fs::write(root.join("小说").join("系列").join("d.epub"), b"d").unwrap();

        let output = scan_path_root(&root, "全部书籍".to_string()).unwrap();
        assert_eq!(output.root.name, "全部书籍");
        assert_eq!(output.entries.len(), 3);
        let names: Vec<&str> = output
            .entries
            .iter()
            .map(|entry| entry.epub.file_name.as_str())
            .collect();
        assert!(names.contains(&"a.epub"));
        assert!(names.contains(&"c.EPUB"));
        assert!(names.contains(&"d.epub"));
        let deep = output
            .entries
            .iter()
            .find(|entry| entry.epub.file_name == "d.epub")
            .unwrap();
        assert_eq!(deep.epub.relative_parent_segments, vec!["小说", "系列"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn root_and_direct_child_have_distinct_input_ids() {
        let root = std::env::temp_dir().join(format!(
            "fi-native-scan-ids-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("same.epub"), b"r").unwrap();
        std::fs::write(root.join("a").join("same.epub"), b"c").unwrap();

        let output = scan_path_root(&root, "root".to_string()).unwrap();
        assert_eq!(output.entries.len(), 2);
        assert_ne!(output.entries[0].epub.input_id, output.entries[1].epub.input_id);
        assert_ne!(output.entries[0].epub.relative_parent_segments, output.entries[1].epub.relative_parent_segments);

        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_path_scan_stops_before_enumerating_candidates() {
        let root = std::env::temp_dir().join(format!(
            "fi-native-scan-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("deep")).unwrap();
        std::fs::write(root.join("a.epub"), b"a").unwrap();
        std::fs::write(root.join("deep").join("b.epub"), b"b").unwrap();

        let output = scan_path_root_cancellable(&root, "root".to_string(), &|| true).unwrap();
        assert!(output.cancelled);
        assert!(output.entries.is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

}
