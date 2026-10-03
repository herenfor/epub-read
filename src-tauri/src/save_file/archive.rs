use super::{
    hex_digest, now_ms, valid_hash, LocalBinding, MissingBook, ProgressReporter, SaveExportScope,
    SaveFileError, SkippedBook, COPY_BUFFER_BYTES, JSON_LIMIT_BYTES,
};
use crate::portable_state::{
    merge_portable_states, parse_portable_state_json, validate_portable_state, PortableStateV3,
    MAX_SAFE_COUNTER,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub(crate) const SAVE_FORMAT: &str = "epub-reader-save";
pub(crate) const CONTAINER_VERSION: u32 = 1;
pub(crate) const STATE_SCHEMA_VERSION: u64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveManifest {
    pub format: String,
    pub container_version: u32,
    pub state_schema_version: u64,
    pub package_id: String,
    pub created_at_ms: u64,
    pub scope: SaveManifestScope,
    pub entries: Vec<SaveManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveManifestScope {
    pub kind: String,
    #[serde(rename = "bookHashes", default)]
    pub book_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveManifestEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ExportBookPlan {
    pub content_hash: String,
    pub source_path: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ExportStats {
    pub written_books: usize,
    pub book_bytes: u64,
    pub archive_bytes: u64,
}

#[derive(Debug)]
pub(crate) struct ValidatedPackage {
    pub package_id: String,
    pub scope_kind: String,
    pub incoming: PortableStateV3,
    pub attachments: Vec<super::PreparedAttachment>,
    pub source_bytes: u64,
    pub total_uncompressed_bytes: u64,
}

fn serialize_json<T: Serialize>(value: &T) -> Result<Vec<u8>, SaveFileError> {
    serde_json::to_vec(value)
        .map_err(|error| SaveFileError::storage_error(format!("存档 JSON 无法序列化：{error}")))
}

pub(crate) fn scope_kind(scope: &SaveExportScope) -> &'static str {
    match scope {
        SaveExportScope::All => "all",
        SaveExportScope::Selected { .. } => "selected",
    }
}

pub(crate) fn select_export_state(
    snapshot: &PortableStateV3,
    scope: &SaveExportScope,
) -> Result<(PortableStateV3, Vec<String>), SaveFileError> {
    let mut state = snapshot.clone();
    let selected: BTreeSet<String> = match scope {
        SaveExportScope::All => state.books.keys().cloned().collect(),
        SaveExportScope::Selected { book_hashes } => {
            if book_hashes.is_empty() {
                return Err(SaveFileError::invalid_request(
                    "selected 范围至少要选一本书",
                ));
            }
            let mut seen = BTreeSet::new();
            for hash in book_hashes {
                if !valid_hash(hash) {
                    return Err(SaveFileError::invalid_entity(
                        "选中书籍的 contentHash 必须是 64 位小写内容指纹",
                    ));
                }
                if !seen.insert(hash.clone()) {
                    return Err(SaveFileError::invalid_request(
                        "selected 范围不能包含重复书籍",
                    ));
                }
                if !snapshot.books.contains_key(hash) {
                    return Err(SaveFileError::invalid_entity(format!(
                        "选中的书籍不在当前资料库：{hash}"
                    )));
                }
            }
            seen
        }
    };
    state.books.retain(|hash, _| selected.contains(hash));
    state
        .organization
        .books
        .retain(|hash, _| selected.contains(hash));
    match scope {
        SaveExportScope::All => {}
        SaveExportScope::Selected { .. } => {
            let mut folder_ids = BTreeSet::new();
            for book in state.organization.books.values() {
                if let Some(folder_id) = book
                    .folder_id
                    .as_ref()
                    .and_then(|register| register.value.as_ref())
                {
                    folder_ids.insert(folder_id.clone());
                }
            }
            state
                .organization
                .folders
                .retain(|folder_id, _| folder_ids.contains(folder_id));
        }
    }
    let mut hashes: Vec<String> = state.books.keys().cloned().collect();
    hashes.sort();
    Ok((state, hashes))
}

pub(crate) fn plan_export_books(
    root: &Path,
    state: &PortableStateV3,
    bindings: &BTreeMap<String, LocalBinding>,
    include_books: bool,
) -> (Vec<ExportBookPlan>, Vec<SkippedBook>) {
    if !include_books {
        return (Vec::new(), Vec::new());
    }
    let mut plans = Vec::new();
    let mut skipped = Vec::new();
    for (content_hash, book) in &state.books {
        let title = book.metadata.value.title.clone();
        let Some(binding) = bindings.get(content_hash) else {
            skipped.push(SkippedBook {
                content_hash: content_hash.clone(),
                title,
                reason: "本机没有书籍文件绑定".to_string(),
            });
            continue;
        };
        let path = match binding.source_path(root) {
            Ok(path) => path,
            Err(error) => {
                skipped.push(SkippedBook {
                    content_hash: content_hash.clone(),
                    title,
                    reason: error.message,
                });
                continue;
            }
        };
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                skipped.push(SkippedBook {
                    content_hash: content_hash.clone(),
                    title,
                    reason: "本机书籍文件不存在或不可读".to_string(),
                });
                continue;
            }
        };
        if !metadata.is_file() {
            skipped.push(SkippedBook {
                content_hash: content_hash.clone(),
                title,
                reason: "本机书籍源不是普通文件".to_string(),
            });
            continue;
        }
        plans.push(ExportBookPlan {
            content_hash: content_hash.clone(),
            source_path: path,
            bytes: metadata.len(),
        });
    }
    (plans, skipped)
}

fn zip_file_options(compression: CompressionMethod, large_file: bool) -> SimpleFileOptions {
    let mut options = SimpleFileOptions::default().compression_method(compression);
    if large_file {
        options = options.large_file(true);
    }
    options
}

pub(crate) fn write_export_archive(
    archive_path: &Path,
    package_id: &str,
    state: &PortableStateV3,
    plans: &[ExportBookPlan],
    scope_kind: &str,
    selected_hashes: &[String],
    reporter: &mut ProgressReporter,
    cancelled: &AtomicBool,
) -> Result<ExportStats, SaveFileError> {
    let state_bytes = serialize_json(state)?;
    if state_bytes.len() as u64 > JSON_LIMIT_BYTES {
        return Err(SaveFileError::invalid_data("state.json 超过大小上限"));
    }
    let mut entries = Vec::with_capacity(plans.len() + 1);
    entries.push(SaveManifestEntry {
        path: "state.json".to_string(),
        bytes: state_bytes.len() as u64,
        sha256: hex_digest(&state_bytes),
    });
    for plan in plans {
        entries.push(SaveManifestEntry {
            path: format!("books/{}.epub", plan.content_hash),
            bytes: plan.bytes,
            sha256: plan.content_hash.clone(),
        });
    }
    let manifest = SaveManifest {
        format: SAVE_FORMAT.to_string(),
        container_version: CONTAINER_VERSION,
        state_schema_version: STATE_SCHEMA_VERSION,
        package_id: package_id.to_string(),
        created_at_ms: now_ms(),
        scope: SaveManifestScope {
            kind: scope_kind.to_string(),
            book_hashes: if scope_kind == "all" {
                Vec::new()
            } else {
                selected_hashes.to_vec()
            },
        },
        entries,
    };
    let manifest_bytes = serialize_json(&manifest)?;
    if manifest_bytes.len() as u64 > JSON_LIMIT_BYTES {
        return Err(SaveFileError::invalid_data("manifest.json 超过大小上限"));
    }
    let mut total_bytes = manifest_bytes.len() as u64 + state_bytes.len() as u64;
    for plan in plans {
        total_bytes = total_bytes.saturating_add(plan.bytes);
    }
    reporter.set_phase("writing", Some(total_bytes));

    if archive_path.exists() {
        fs::remove_file(archive_path)?;
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(archive_path)?;
    let mut archive = ZipWriter::new(file);

    archive.start_file(
        "manifest.json",
        zip_file_options(CompressionMethod::Deflated, false),
    )?;
    archive.write_all(&manifest_bytes)?;
    reporter.add(manifest_bytes.len() as u64);
    if cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }

    archive.start_file(
        "state.json",
        zip_file_options(CompressionMethod::Deflated, false),
    )?;
    archive.write_all(&state_bytes)?;
    reporter.add(state_bytes.len() as u64);
    if cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }

    for plan in plans {
        if cancelled.load(Ordering::Acquire) {
            return Err(SaveFileError::cancelled());
        }
        let options = zip_file_options(CompressionMethod::Stored, plan.bytes >= u32::MAX as u64);
        archive.start_file(format!("books/{}.epub", plan.content_hash), options)?;
        let mut source = File::open(&plan.source_path)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; COPY_BUFFER_BYTES];
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(SaveFileError::cancelled());
            }
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            archive.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            copied = copied.saturating_add(read as u64);
            reporter.add(read as u64);
        }
        let actual_hash = format!("{:x}", hasher.finalize());
        if copied != plan.bytes {
            return Err(SaveFileError::invalid_data(format!(
                "书籍 {} 在导出期间长度发生变化",
                plan.content_hash
            )));
        }
        if actual_hash != plan.content_hash {
            return Err(SaveFileError::invalid_data(format!(
                "书籍 {} 的内容指纹与资料记录不一致，导出已终止",
                plan.content_hash
            )));
        }
    }

    if cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }
    let file = archive.finish()?;
    file.sync_all()?;
    drop(file);
    let archive_bytes = fs::metadata(archive_path)?.len();
    reporter.force();
    Ok(ExportStats {
        written_books: plans.len(),
        book_bytes: plans.iter().map(|plan| plan.bytes).sum(),
        archive_bytes,
    })
}

fn read_entry_bytes(
    archive: &mut ZipArchive<File>,
    index: usize,
    label: &str,
    limit: u64,
) -> Result<Vec<u8>, SaveFileError> {
    let mut entry = archive
        .by_index(index)
        .map_err(|error| SaveFileError::invalid_data(format!("ZIP 条目无法读取：{error}")))?;
    if entry.size() > limit {
        return Err(SaveFileError::invalid_data(format!("{label} 超过大小上限")));
    }
    let mut output = Vec::with_capacity(entry.size().min(limit) as usize);
    entry
        .by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut output)?;
    if output.len() as u64 > limit {
        return Err(SaveFileError::invalid_data(format!("{label} 超过大小上限")));
    }
    if output.len() as u64 != entry.size() {
        return Err(SaveFileError::invalid_data(format!(
            "{label} 声明长度与实际长度不一致"
        )));
    }
    Ok(output)
}

fn allowed_entry_path(name: &str) -> bool {
    if name == "manifest.json" || name == "state.json" {
        return true;
    }
    let Some(hash) = name
        .strip_prefix("books/")
        .and_then(|rest| rest.strip_suffix(".epub"))
    else {
        return false;
    };
    valid_hash(hash)
}

fn book_hash_from_path(name: &str) -> Option<String> {
    name.strip_prefix("books/")
        .and_then(|rest| rest.strip_suffix(".epub"))
        .filter(|hash| valid_hash(hash))
        .map(str::to_string)
}

pub(crate) fn validate_and_extract(
    source_path: &Path,
    staging_dir: &Path,
    reporter: &mut ProgressReporter,
    cancelled: &AtomicBool,
) -> Result<ValidatedPackage, SaveFileError> {
    let source_bytes = fs::metadata(source_path)?.len();
    let file = File::open(source_path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| SaveFileError::invalid_data(format!("不是有效的 ZIP 存档：{error}")))?;

    let mut indexes: BTreeMap<String, usize> = BTreeMap::new();
    let mut zip_sizes: BTreeMap<String, u64> = BTreeMap::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| SaveFileError::invalid_data(format!("ZIP 目录损坏：{error}")))?;
        if entry.is_dir() {
            return Err(SaveFileError::invalid_data("存档不允许目录条目"));
        }
        if entry.is_symlink() {
            return Err(SaveFileError::invalid_data("存档不允许符号链接条目"));
        }
        let name_raw = entry.name_raw();
        let name = std::str::from_utf8(name_raw)
            .map_err(|_| SaveFileError::invalid_data("ZIP 条目名称不是 UTF-8"))?;
        if name.contains('/')
            && name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(SaveFileError::invalid_data(format!(
                "非法 ZIP 路径：{name}"
            )));
        }
        if name.contains('\\') || name.starts_with('/') || !allowed_entry_path(name) {
            return Err(SaveFileError::invalid_data(format!(
                "存档包含清单外条目：{name}"
            )));
        }
        if indexes.insert(name.to_string(), index).is_some() {
            return Err(SaveFileError::invalid_data(format!(
                "存档包含重复条目：{name}"
            )));
        }
        zip_sizes.insert(name.to_string(), entry.size());
    }

    let manifest_index = *indexes
        .get("manifest.json")
        .ok_or_else(|| SaveFileError::invalid_data("存档缺少 manifest.json"))?;
    let state_index = *indexes
        .get("state.json")
        .ok_or_else(|| SaveFileError::invalid_data("存档缺少 state.json"))?;

    let manifest_bytes = read_entry_bytes(
        &mut archive,
        manifest_index,
        "manifest.json",
        JSON_LIMIT_BYTES,
    )?;
    let manifest: SaveManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| SaveFileError::invalid_data(format!("manifest.json 无法解析：{error}")))?;
    if manifest.format != SAVE_FORMAT {
        return Err(SaveFileError::invalid_data("未知存档格式"));
    }
    if manifest.container_version != CONTAINER_VERSION {
        return Err(SaveFileError::invalid_data("未知容器主版本"));
    }
    if manifest.state_schema_version != STATE_SCHEMA_VERSION {
        return Err(SaveFileError::invalid_data("未知状态主版本"));
    }
    if !super::valid_job_id(&manifest.package_id) {
        return Err(SaveFileError::invalid_data("packageId 不是规范 UUID"));
    }
    if manifest.created_at_ms > MAX_SAFE_COUNTER {
        return Err(SaveFileError::invalid_data("createdAtMs 超出安全整数范围"));
    }
    match manifest.scope.kind.as_str() {
        "all" => {
            if !manifest.scope.book_hashes.is_empty() {
                return Err(SaveFileError::invalid_data(
                    "all 范围的 manifest 不应携带 bookHashes",
                ));
            }
        }
        "selected" => {
            if manifest.scope.book_hashes.is_empty() {
                return Err(SaveFileError::invalid_data("selected 范围缺少 bookHashes"));
            }
            let mut seen = BTreeSet::new();
            for hash in &manifest.scope.book_hashes {
                if !valid_hash(hash) || !seen.insert(hash.clone()) {
                    return Err(SaveFileError::invalid_data(
                        "manifest 范围的书籍指纹无效或重复",
                    ));
                }
            }
        }
        _ => return Err(SaveFileError::invalid_data("未知 manifest 范围")),
    }
    if manifest.entries.is_empty() {
        return Err(SaveFileError::invalid_data("manifest 不能没有条目"));
    }

    let manifest_state_count = manifest
        .entries
        .iter()
        .filter(|entry| entry.path == "state.json")
        .count();
    if manifest_state_count != 1 {
        return Err(SaveFileError::invalid_data(
            "manifest 必须且只能声明一个 state.json",
        ));
    }
    let mut manifest_paths = BTreeSet::new();
    let mut attachment_hashes = BTreeSet::new();
    for entry in &manifest.entries {
        if !allowed_entry_path(&entry.path) {
            return Err(SaveFileError::invalid_data(format!(
                "manifest 包含未知条目：{}",
                entry.path
            )));
        }
        if !manifest_paths.insert(entry.path.clone()) {
            return Err(SaveFileError::invalid_data("manifest 条目重复"));
        }
        if entry.path == "manifest.json" {
            return Err(SaveFileError::invalid_data("manifest 不能为自身声明条目"));
        }
        if entry.bytes > MAX_SAFE_COUNTER {
            return Err(SaveFileError::invalid_data(
                "manifest 条目长度超出安全整数范围",
            ));
        }
        if !valid_hash(&entry.sha256) {
            return Err(SaveFileError::invalid_data("manifest 条目 sha256 无效"));
        }
        if let Some(hash) = book_hash_from_path(&entry.path) {
            if !attachment_hashes.insert(hash.clone()) {
                return Err(SaveFileError::invalid_data("manifest 同一本书重复附带"));
            }
            if entry.sha256 != hash {
                return Err(SaveFileError::invalid_data(
                    "附带书籍的 sha256 与内容指纹不一致",
                ));
            }
        }
    }
    let mut expected_names = manifest_paths.clone();
    expected_names.insert("manifest.json".to_string());
    if expected_names != indexes.keys().cloned().collect::<BTreeSet<_>>() {
        return Err(SaveFileError::invalid_data(
            "ZIP 条目与 manifest 声明不一致",
        ));
    }
    for (name, index) in &indexes {
        if name == "manifest.json" {
            continue;
        }
        if !manifest_paths.contains(name) {
            return Err(SaveFileError::invalid_data(format!(
                "ZIP 含 manifest 未声明条目：{name}"
            )));
        }
        let declared = manifest
            .entries
            .iter()
            .find(|entry| &entry.path == name)
            .expect("path checked above");
        let actual_size = zip_sizes.get(name).copied().unwrap_or(0);
        if *index >= archive.len() || actual_size != declared.bytes {
            return Err(SaveFileError::invalid_data(format!(
                "ZIP 条目长度与 manifest 不一致：{name}"
            )));
        }
    }

    let state_bytes = read_entry_bytes(&mut archive, state_index, "state.json", JSON_LIMIT_BYTES)?;
    let declared_state = manifest
        .entries
        .iter()
        .find(|entry| entry.path == "state.json")
        .expect("single state entry checked above");
    if hex_digest(&state_bytes) != declared_state.sha256 {
        return Err(SaveFileError::invalid_data("state.json 内容校验失败"));
    }
    let incoming = parse_portable_state_json(
        std::str::from_utf8(&state_bytes)
            .map_err(|_| SaveFileError::invalid_data("state.json 不是 UTF-8"))?,
    )?;
    validate_portable_state(&incoming)?;

    match manifest.scope.kind.as_str() {
        "selected" => {
            let scope_set: BTreeSet<String> = manifest.scope.book_hashes.iter().cloned().collect();
            let state_set: BTreeSet<String> = incoming.books.keys().cloned().collect();
            if scope_set != state_set {
                return Err(SaveFileError::invalid_data(
                    "manifest 范围与 state.books 不一致",
                ));
            }
            if incoming
                .organization
                .books
                .keys()
                .any(|hash| !scope_set.contains(hash))
            {
                return Err(SaveFileError::invalid_data(
                    "选书存档包含范围外的书籍组织资料",
                ));
            }
            let referenced_folders: BTreeSet<&String> = incoming
                .organization
                .books
                .values()
                .filter_map(|book| {
                    book.folder_id
                        .as_ref()
                        .and_then(|register| register.value.as_ref())
                })
                .collect();
            if incoming
                .organization
                .folders
                .keys()
                .any(|id| !referenced_folders.contains(id))
            {
                return Err(SaveFileError::invalid_data("选书存档包含范围外的文件夹"));
            }
        }
        "all" => {}
        _ => unreachable!(),
    }
    for hash in &attachment_hashes {
        if !incoming.books.contains_key(hash) {
            return Err(SaveFileError::invalid_data(format!(
                "附带书籍 {hash} 不在 state.books 中"
            )));
        }
    }

    let total_uncompressed_bytes = manifest
        .entries
        .iter()
        .map(|entry| entry.bytes)
        .fold(0_u64, u64::saturating_add);
    reporter.set_phase("extracting", Some(total_uncompressed_bytes));

    fs::create_dir_all(staging_dir)?;
    let mut attachments = Vec::with_capacity(attachment_hashes.len());
    for entry in manifest
        .entries
        .iter()
        .filter(|entry| entry.path != "state.json")
    {
        if cancelled.load(Ordering::Acquire) {
            return Err(SaveFileError::cancelled());
        }
        let Some(content_hash) = book_hash_from_path(&entry.path) else {
            continue;
        };
        let index = *indexes
            .get(&entry.path)
            .ok_or_else(|| SaveFileError::invalid_data("manifest 条目在 ZIP 中缺失"))?;
        let mut source = archive
            .by_index(index)
            .map_err(|error| SaveFileError::invalid_data(format!("ZIP 条目无法读取：{error}")))?;
        if source.size() != entry.bytes {
            return Err(SaveFileError::invalid_data(format!(
                "附带书籍声明长度不一致：{}",
                entry.path
            )));
        }
        let target_path = staging_dir.join(format!("{content_hash}.epub"));
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; COPY_BUFFER_BYTES];
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(SaveFileError::cancelled());
            }
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            if (read as u64) > entry.bytes.saturating_sub(copied) {
                return Err(SaveFileError::invalid_data("附带书籍超过声明长度"));
            }
            target.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            copied = copied.saturating_add(read as u64);
            reporter.add(read as u64);
        }
        if copied != entry.bytes {
            return Err(SaveFileError::invalid_data(format!(
                "附带书籍实际长度与 manifest 不一致：{}",
                entry.path
            )));
        }
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != content_hash || actual_hash != entry.sha256 {
            return Err(SaveFileError::invalid_data(format!(
                "附带书籍内容指纹校验失败：{}",
                entry.path
            )));
        }
        target.sync_all()?;
        drop(target);
        attachments.push(super::PreparedAttachment {
            content_hash,
            staging_path: target_path,
            bytes: entry.bytes,
            sha256: entry.sha256.clone(),
        });
    }
    reporter.force();
    if cancelled.load(Ordering::Acquire) {
        return Err(SaveFileError::cancelled());
    }

    Ok(ValidatedPackage {
        package_id: manifest.package_id,
        scope_kind: manifest.scope.kind,
        incoming,
        attachments,
        source_bytes,
        total_uncompressed_bytes,
    })
}

pub(crate) fn preview_missing_books(
    incoming: &PortableStateV3,
    attachments: &[super::PreparedAttachment],
) -> Vec<MissingBook> {
    let attached: BTreeSet<&str> = attachments
        .iter()
        .map(|attachment| attachment.content_hash.as_str())
        .collect();
    incoming
        .books
        .iter()
        .filter(|(hash, _)| !attached.contains(hash.as_str()))
        .map(|(hash, book)| MissingBook {
            content_hash: hash.clone(),
            title: book.metadata.value.title.clone(),
        })
        .collect()
}

pub(crate) fn count_progress_conflicts(
    local: &PortableStateV3,
    incoming: &PortableStateV3,
) -> Result<usize, SaveFileError> {
    Ok(progress_conflict_hashes(local, incoming)?.len())
}

pub(crate) fn progress_conflict_hashes(
    local: &PortableStateV3,
    incoming: &PortableStateV3,
) -> Result<Vec<String>, SaveFileError> {
    let merged = merge_portable_states(local, incoming)?;
    Ok(imported_progress_conflicts(&merged, incoming))
}

pub(crate) fn imported_progress_conflicts(
    merged: &PortableStateV3,
    incoming: &PortableStateV3,
) -> Vec<String> {
    let mut conflicts = Vec::new();
    for hash in incoming.books.keys() {
        if merged
            .books
            .get(hash)
            .is_some_and(|book| book.progress.versions.len() > 1)
        {
            conflicts.push(hash.clone());
        }
    }
    conflicts.sort();
    conflicts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portable_state::{parse_portable_state_value, PortableStateV3, PortableStore};
    use crate::save_file::SaveFileProgress;
    use serde_json::json;
    use std::sync::atomic::AtomicU64;
    use tauri::ipc::Channel;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const C: &str = "00000000-0000-4000-8000-000000000003";

    static NONCE: AtomicU64 = AtomicU64::new(0);

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "epub-reader-save-file-{label}-{}-{}",
                std::process::id(),
                NONCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn channel() -> Channel<SaveFileProgress> {
        Channel::new(|_| Ok(()))
    }

    fn test_state() -> PortableStateV3 {
        parse_portable_state_value(json!({
            "schemaVersion": 3,
            "books": {
                HASH: {
                    "metadata": {
                        "value": {
                            "title": "书",
                            "creator": "作者",
                            "fileName": "book.epub",
                            "addedAtMs": 1000
                        },
                        "stamp": { "deviceId": A, "counter": 1 }
                    },
                    "progress": {
                        "versions": [
                            {
                                "stamp": { "deviceId": A, "counter": 1 },
                                "clock": { A: 1 },
                                "value": {
                                    "locator": {
                                        "locatorVersion": 1,
                                        "chapterPath": "Text/chapter.xhtml",
                                        "spineIndexHint": 0,
                                        "target": { "kind": "chapter-start" }
                                    },
                                    "progressPctHint": 10
                                },
                                "updatedAtMs": 1000
                            },
                            {
                                "stamp": { "deviceId": B, "counter": 2 },
                                "clock": { B: 2 },
                                "value": {
                                    "locator": {
                                        "locatorVersion": 1,
                                        "chapterPath": "Text/chapter.xhtml",
                                        "spineIndexHint": 0,
                                        "target": { "kind": "chapter-start" }
                                    },
                                    "progressPctHint": 20
                                },
                                "updatedAtMs": 1100
                            }
                        ]
                    },
                    "bookmarks": {},
                    "notes": {
                        "note_legacy_1": {
                            "versions": [],
                            "deleted": { "deviceId": C, "counter": 3 }
                        }
                    }
                }
            },
            "organization": { "schemaVersion": 1, "folders": {}, "books": {} }
        }))
        .unwrap()
    }

    #[test]
    fn archive_roundtrip_preserves_concurrent_progress_deleted_note_and_is_idempotent() {
        let dir = TempDir::new("roundtrip");
        let archive_path = dir.path().join("roundtrip.epubsave");
        let state = test_state();
        let cancelled = AtomicBool::new(false);
        let mut reporter = ProgressReporter::new(channel(), "test", None);
        write_export_archive(
            &archive_path,
            A,
            &state,
            &[],
            "all",
            &[],
            &mut reporter,
            &cancelled,
        )
        .unwrap();

        let staging = dir.path().join("staging");
        let parsed =
            validate_and_extract(&archive_path, &staging, &mut reporter, &cancelled).unwrap();
        assert_eq!(parsed.incoming, state);
        assert_eq!(parsed.incoming.books[HASH].progress.versions.len(), 2);
        assert!(parsed.incoming.books[HASH].notes["note_legacy_1"]
            .deleted
            .is_some());

        let mut store = PortableStore::open_in_memory().unwrap();
        let first = store
            .merge_validated_import(parsed.incoming.clone(), Vec::new(), false)
            .unwrap();
        let second = store
            .merge_validated_import(parsed.incoming.clone(), Vec::new(), false)
            .unwrap();
        assert_eq!(first, second);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.books[HASH].progress.versions.len(), 2);
        assert!(snapshot.books[HASH].notes["note_legacy_1"]
            .deleted
            .is_some());
    }

    #[test]
    fn archive_roundtrip_streams_one_epub_attachment() {
        let dir = TempDir::new("epub-attachment");
        let source = dir.path().join("source.epub");
        let bytes = b"small epub bytes used only for the direct file-backend roundtrip";
        fs::write(&source, bytes).unwrap();
        let content_hash = crate::save_file::hex_digest(bytes);
        let mut state = test_state();
        let book = state.books.remove(HASH).unwrap();
        state.books.insert(content_hash.clone(), book);

        let archive_path = dir.path().join("with-book.epubsave");
        let staging = dir.path().join("staging");
        let cancelled = AtomicBool::new(false);
        let mut reporter = ProgressReporter::new(channel(), "test", None);
        write_export_archive(
            &archive_path,
            A,
            &state,
            &[ExportBookPlan {
                content_hash: content_hash.clone(),
                source_path: source,
                bytes: bytes.len() as u64,
            }],
            "all",
            &[],
            &mut reporter,
            &cancelled,
        )
        .unwrap();

        let parsed =
            validate_and_extract(&archive_path, &staging, &mut reporter, &cancelled).unwrap();
        assert_eq!(parsed.incoming, state);
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].content_hash, content_hash);
        assert_eq!(
            fs::read(&parsed.attachments[0].staging_path).unwrap(),
            bytes
        );
    }

    #[test]
    fn archive_export_observes_cancel_before_delivery() {
        let dir = TempDir::new("cancel");
        let archive_path = dir.path().join("cancelled.epubsave");
        let state = test_state();
        let cancelled = AtomicBool::new(true);
        let mut reporter = ProgressReporter::new(channel(), "test", None);
        let error = write_export_archive(
            &archive_path,
            A,
            &state,
            &[],
            "all",
            &[],
            &mut reporter,
            &cancelled,
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(archive_path.exists());
    }

    #[test]
    fn archive_rejects_zip_without_manifest() {
        let dir = TempDir::new("missing-manifest");
        let archive_path = dir.path().join("missing-manifest.epubsave");
        let state_bytes = serde_json::to_vec(&test_state()).unwrap();
        let file = File::create(&archive_path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file(
                "state.json",
                zip_file_options(CompressionMethod::Deflated, false),
            )
            .unwrap();
        archive.write_all(&state_bytes).unwrap();
        archive.finish().unwrap();

        let staging = dir.path().join("staging");
        let mut reporter = ProgressReporter::new(channel(), "test", None);
        let cancelled = AtomicBool::new(false);
        let error =
            validate_and_extract(&archive_path, &staging, &mut reporter, &cancelled).unwrap_err();
        assert_eq!(error.code, "invalid-data");
    }

    #[test]
    fn file_review_rejects_tampered_state_and_out_of_scope_organization() {
        let dir = TempDir::new("file-review-validation");
        let mut outside = test_state();
        let foreign_hash = "b".repeat(64);
        outside.organization.books.insert(
            foreign_hash.clone(),
            serde_json::from_value(json!({
                "favorite": { "value": true, "stamp": { "deviceId": A, "counter": 1 } }
            }))
            .unwrap(),
        );
        for (label, state, scope, tampered) in [
            ("bad-state-hash", test_state(), "all", true),
            ("foreign-organization", outside, "selected", false),
        ] {
            let bytes = serde_json::to_vec(&state).unwrap();
            let manifest = SaveManifest {
                format: SAVE_FORMAT.into(),
                container_version: 1,
                state_schema_version: 3,
                package_id: A.into(),
                created_at_ms: 1,
                scope: SaveManifestScope {
                    kind: scope.into(),
                    book_hashes: if scope == "selected" {
                        vec![HASH.into()]
                    } else {
                        vec![]
                    },
                },
                entries: vec![SaveManifestEntry {
                    path: "state.json".into(),
                    bytes: bytes.len() as u64,
                    sha256: if tampered {
                        foreign_hash.clone()
                    } else {
                        hex_digest(&bytes)
                    },
                }],
            };
            let path = dir.path().join(format!("{label}.epubsave"));
            let mut zip = ZipWriter::new(File::create(&path).unwrap());
            zip.start_file("manifest.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&serde_json::to_vec(&manifest).unwrap())
                .unwrap();
            zip.start_file("state.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&bytes).unwrap();
            zip.finish().unwrap();
            let mut reporter = ProgressReporter::new(channel(), "test", None);
            let error = validate_and_extract(
                &path,
                &dir.path().join(label),
                &mut reporter,
                &AtomicBool::new(false),
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid-data", "{label}");
            assert!(
                error.message.contains(if tampered {
                    "校验失败"
                } else {
                    "范围外"
                }),
                "{label}: {error}"
            );
        }
    }

    #[test]
    fn file_review_conflicts_only_describe_the_imported_books() {
        let local = test_state();
        let mut incoming = test_state();
        let mut book = incoming.books.remove(HASH).unwrap();
        book.progress.versions.truncate(1);
        incoming.books.insert("b".repeat(64), book);
        assert!(progress_conflict_hashes(&local, &incoming)
            .unwrap()
            .is_empty());
    }
}
