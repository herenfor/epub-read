use super::version_policy::{select_archive_reader, ArchiveReader, VersionError};
use super::{
    available_space_for, hex_digest, now_ms, valid_hash, LocalBinding,
    ProgressReporter, SaveExportScope, SaveFileError, SkippedBook, COPY_BUFFER_BYTES,
    MANIFEST_JSON_LIMIT, STATE_JSON_LIMIT,
};
use crate::library_organization::LibraryOrganization;
use crate::portable_state::{
    merge_portable_states, parse_portable_state_json, validate_portable_state, PortableStateV3,
    MAX_SAFE_COUNTER,
};
use crate::transfer_policy::{BoundedBytes, PolicyError, SpaceBudget};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub(crate) const SAVE_FORMAT: &str = "epub-reader-save";
pub(crate) const CONTAINER_VERSION: u32 = 1;


/// Minimal header used only to choose a reader. It intentionally ignores all
/// other fields; a future writer may add fields to this object. The strict
/// [`SaveManifest`] decoder runs only after an exact reader is selected.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveManifestVersionProbe {
    format: String,
    container_version: u32,
    state_schema_version: u64,
}

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
    pub source: crate::linked_library::document_source::BookSource,
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

fn serialize_json_bounded<T: Serialize>(
    value: &T,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, SaveFileError> {
    let mut writer = BoundedBytes::new(limit);
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok(writer.into_bytes()),
        Err(_) if writer.exceeded() => Err(SaveFileError::new(
            "metadata-too-large",
            format!("阅读资料过多，{label} 超过大小上限，请减少选书范围后分批发送/导出"),
        )),
        Err(error) => Err(SaveFileError::storage_error(format!(
            "存档 JSON 无法序列化：{error}"
        ))),
    }
}

fn space_error(error: PolicyError) -> SaveFileError {
    match error {
        PolicyError::InsufficientSpace {
            required,
            available,
        } => SaveFileError::new(
            "insufficient-space",
            format!(
                "空间不足，需要约 {}，当前可用 {}",
                human_bytes(required),
                human_bytes(available)
            ),
        ),
        other => SaveFileError::storage_error(format!("空间预检失败：{other:?}")),
    }
}

fn human_bytes(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    format!("{:.1} MiB", bytes as f64 / MIB)
}

pub(crate) fn scope_kind(scope: &SaveExportScope) -> &'static str {
    match scope {
        SaveExportScope::All => "all",
        SaveExportScope::Selected { .. } => "selected",
    }
}

fn archive_version_error(error: VersionError) -> SaveFileError {
    match error {
        VersionError::NeedsNewerApp => {
            SaveFileError::new("invalid-data", "此资料需要较新版本，请升级")
        }
        VersionError::UnsupportedFormat => SaveFileError::new("invalid-data", "不支持此存档格式"),
    }
}

pub(crate) fn select_export_state(
    snapshot: &PortableStateV3,
    scope: &SaveExportScope,
) -> Result<(PortableStateV3, Vec<String>), SaveFileError> {
    let selected: BTreeSet<String> = match scope {
        SaveExportScope::All => snapshot.books.keys().cloned().collect(),
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

    // Clone only selected books instead of snapshot.clone() followed by retain.
    let books: BTreeMap<String, _> = snapshot
        .books
        .iter()
        .filter(|(hash, _)| selected.contains(hash.as_str()))
        .map(|(hash, book)| (hash.clone(), book.clone()))
        .collect();
    let mut organization_books = BTreeMap::new();
    let mut folder_ids = BTreeSet::new();
    for hash in &selected {
        if let Some(book) = snapshot.organization.books.get(hash) {
            organization_books.insert(hash.clone(), book.clone());
            if let Some(folder_id) = book
                .folder_id
                .as_ref()
                .and_then(|register| register.value.as_ref())
            {
                folder_ids.extend(crate::library_organization::folder_stored_lineage(
                    &snapshot.organization,
                    folder_id,
                ));
            }
        }
    }
    let organization = LibraryOrganization {
        schema_version: snapshot.organization.schema_version,
        folders: match scope {
            SaveExportScope::All => snapshot.organization.folders.clone(),
            SaveExportScope::Selected { .. } => snapshot
                .organization
                .folders
                .iter()
                .filter(|(folder_id, _)| folder_ids.contains(*folder_id))
                .map(|(folder_id, folder)| (folder_id.clone(), folder.clone()))
                .collect(),
        },
        books: organization_books,
    };

    let mut hashes: Vec<String> = books.keys().cloned().collect();
    hashes.sort();
    Ok((
        PortableStateV3 {
            schema_version: snapshot.schema_version,
            books,
            organization,
            preferences: snapshot.preferences.clone(),
        },
        hashes,
    ))
}

pub(crate) fn plan_export_books<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
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
        let (source, bytes) = match binding.book_source(root)
            .and_then(|source| source.open(app).map(|(_, size)| (source, size)).map_err(SaveFileError::from)) {
            Ok(value) => value,
            Err(_) => {
                skipped.push(SkippedBook {
                    content_hash: content_hash.clone(),
                    title,
                    reason: "本机书籍文件不存在或不可读".to_string(),
                });
                continue;
            }
        };
        plans.push(ExportBookPlan {
            content_hash: content_hash.clone(),
            source,
            bytes,
        });
    }
    (plans, skipped)
}

pub(crate) fn plan_export_books_for_missing<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
    root: &Path,
    state: &PortableStateV3,
    bindings: &BTreeMap<String, LocalBinding>,
    include_books: bool,
    receiver_missing: &BTreeSet<String>,
) -> (Vec<ExportBookPlan>, Vec<SkippedBook>, usize) {
    if !include_books {
        return (Vec::new(), Vec::new(), 0);
    }
    let mut plans = Vec::new();
    let mut skipped = Vec::new();
    let mut reused = 0_usize;
    for (content_hash, book) in &state.books {
        if !receiver_missing.contains(content_hash) {
            // The receiver already has a valid local file for this selected
            // hash; no body transfer and no cover work needs the source bytes.
            reused += 1;
            continue;
        }
        let title = book.metadata.value.title.clone();
        let Some(binding) = bindings.get(content_hash) else {
            skipped.push(SkippedBook {
                content_hash: content_hash.clone(),
                title,
                reason: "本机没有书籍文件绑定".to_string(),
            });
            continue;
        };
        if !binding.is_valid_on(app, root, || false).unwrap_or(false) {
            skipped.push(SkippedBook {
                content_hash: content_hash.clone(),
                title,
                reason: "本机书籍文件缺失或内容指纹不一致".to_string(),
            });
            continue;
        }
        let (source, bytes) = match binding.book_source(root)
            .and_then(|source| source.open(app).map(|(_, size)| (source, size)).map_err(SaveFileError::from)) {
            Ok(value) => value,
            Err(_) => {
                skipped.push(SkippedBook {
                    content_hash: content_hash.clone(),
                    title,
                    reason: "本机书籍文件不存在或不可读".to_string(),
                });
                continue;
            }
        };
        plans.push(ExportBookPlan {
            content_hash: content_hash.clone(),
            source,
            bytes,
        });
    }
    (plans, skipped, reused)
}

fn zip_file_options(compression: CompressionMethod, large_file: bool) -> SimpleFileOptions {
    let mut options = SimpleFileOptions::default().compression_method(compression);
    if large_file {
        options = options.large_file(true);
    }
    options
}

pub(crate) fn write_export_archive<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
    archive_path: &Path,
    package_id: &str,
    state: &PortableStateV3,
    plans: &[ExportBookPlan],
    scope_kind: &str,
    selected_hashes: &[String],
    reporter: &mut ProgressReporter,
    cancelled: &AtomicBool,
) -> Result<ExportStats, SaveFileError> {
    let state_bytes = serialize_json_bounded(state, STATE_JSON_LIMIT, "state.json")?;
    let mut entries = Vec::with_capacity(plans.len() + 1);
    entries.push(SaveManifestEntry {
        path: "state.json".to_string(),
        bytes: state_bytes.len() as u64,
        sha256: hex_digest(&state_bytes),
    });
    for plan in plans {
        entries.push(SaveManifestEntry {
            path: source_entry_path(state, &plan.content_hash),
            bytes: plan.bytes,
            sha256: plan.content_hash.clone(),
        });
    }
    let manifest = SaveManifest {
        format: SAVE_FORMAT.to_string(),
        container_version: CONTAINER_VERSION,
        state_schema_version: state.schema_version,
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
    let manifest_bytes = serialize_json_bounded(&manifest, MANIFEST_JSON_LIMIT, "manifest.json")?;
    let book_bytes = plans.iter().map(|plan| plan.bytes).sum::<u64>();
    let budget = SpaceBudget::exporting(
        book_bytes,
        state_bytes.len() as u64,
        manifest_bytes.len() as u64,
        plans.len() as u64,
    )
    .map_err(space_error)?;
    let parent = archive_path
        .parent()
        .ok_or_else(|| SaveFileError::storage_error("导出目标缺少父目录，无法做空间预检"))?;
    let available = available_space_for(parent)?;
    budget.check(available).map_err(space_error)?;

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
        archive.start_file(source_entry_path(state, &plan.content_hash), options)?;
        let (mut source, _) = plan.source.open(app)?;
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
            if read as u64 > plan.bytes.saturating_sub(copied) {
                return Err(SaveFileError::invalid_data("原书在导出期间长度发生变化"));
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
        return Err(SaveFileError::new(
            "metadata-too-large",
            format!("阅读资料过多，{label} 超过大小上限，请减少选书范围后分批发送/导出"),
        ));
    }
    let mut output = Vec::with_capacity(entry.size().min(limit) as usize);
    entry
        .by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut output)?;
    if output.len() as u64 > limit {
        return Err(SaveFileError::new(
            "metadata-too-large",
            format!("阅读资料过多，{label} 超过大小上限，请减少选书范围后分批发送/导出"),
        ));
    }
    if output.len() as u64 != entry.size() {
        return Err(SaveFileError::invalid_data(format!(
            "{label} 声明长度与实际长度不一致"
        )));
    }
    Ok(output)
}

fn source_entry_path(state: &PortableStateV3, hash: &str) -> String {
    let extension=state.books.get(hash).map(|b| crate::document_formats::extension(&b.metadata.value.file_name).to_ascii_lowercase()).filter(|e| matches!(e.as_str(),"epub"|"txt"|"cbz"|"zip"|"fb2"|"mobi"|"azw3")).unwrap_or_else(||"epub".into());
    format!("books/{hash}.{extension}")
}
fn book_hash_from_path(name: &str) -> Option<String> {
    let (hash, extension)=name.strip_prefix("books/")?.rsplit_once('.')?;
    (valid_hash(hash) && matches!(extension,"epub"|"txt"|"cbz"|"zip"|"fb2"|"mobi"|"azw3")).then(||hash.to_owned())
}
fn allowed_entry_path(name: &str) -> bool {
    name=="manifest.json" || name=="state.json" || book_hash_from_path(name).is_some()
}

pub(crate) fn validate_and_extract(
    source_path: &Path,
    staging_dir: &Path,
    reporter: &mut ProgressReporter,
    cancelled: &AtomicBool,
) -> Result<ValidatedPackage, SaveFileError> {
    validate_and_extract_with_expectation(source_path, staging_dir, reporter, cancelled, None)
}

pub(crate) fn validate_and_extract_with_expectation(
    source_path: &Path,
    staging_dir: &Path,
    reporter: &mut ProgressReporter,
    cancelled: &AtomicBool,
    expected: Option<(u64, usize)>,
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
        if name.contains('\\') || name.starts_with('/') {
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

    let manifest_bytes = read_entry_bytes(
        &mut archive,
        manifest_index,
        "manifest.json",
        MANIFEST_JSON_LIMIT,
    )?;
    let version_probe: SaveManifestVersionProbe = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| SaveFileError::invalid_data(format!("manifest.json 无法解析：{error}")))?;
    if version_probe.format != SAVE_FORMAT {
        return Err(SaveFileError::invalid_data("未知存档格式"));
    }
    let reader = select_archive_reader(
        version_probe.container_version,
        version_probe.state_schema_version,
    )
    .map_err(archive_version_error)?;
    match reader {
        ArchiveReader::Container1State3 => {}
    }
    let state_index = *indexes
        .get("state.json")
        .ok_or_else(|| SaveFileError::invalid_data("存档缺少 state.json"))?;

    // The exact current reader still parses every declared field strictly. The
    // version probe above must not become the validated payload.
    let manifest: SaveManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| SaveFileError::invalid_data(format!("manifest.json 无法解析：{error}")))?;
    if manifest.container_version != CONTAINER_VERSION {
        return Err(SaveFileError::invalid_data("未知容器主版本"));
    }
    // State/container support was selected above; do not keep a second schema list.
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

    let state_bytes = read_entry_bytes(&mut archive, state_index, "state.json", STATE_JSON_LIMIT)?;
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
    drop(state_bytes);
    validate_portable_state(&incoming)?;
    if manifest.state_schema_version != incoming.schema_version {
        return Err(SaveFileError::invalid_data(
            "manifest.stateSchemaVersion 与 state.json 的 schemaVersion 不一致",
        ));
    }

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
            let mut allowed_folders: BTreeSet<String> = BTreeSet::new();
            for folder_id in incoming.organization.books.values().filter_map(|book| {
                book.folder_id
                    .as_ref()
                    .and_then(|register| register.value.as_ref())
            }) {
                allowed_folders.extend(crate::library_organization::folder_stored_lineage(
                    &incoming.organization,
                    folder_id,
                ));
            }
            if incoming
                .organization
                .folders
                .keys()
                .any(|id| !allowed_folders.contains(id))
            {
                return Err(SaveFileError::invalid_data(
                    "选书存档包含范围外或缺少祖先的文件夹",
                ));
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

    for entry in &manifest.entries {
        if let Some(hash) = book_hash_from_path(&entry.path) {
            if entry.path != source_entry_path(&incoming, &hash) {
                return Err(SaveFileError::invalid_data("附带原书格式与资料中的文件名不一致"));
            }
        }
    }

    let book_bytes = manifest
        .entries
        .iter()
        .filter(|entry| book_hash_from_path(&entry.path).is_some())
        .map(|entry| entry.bytes)
        .sum::<u64>();
    let attached_count = attachment_hashes.len();
    if let Some((expected_bytes, expected_count)) = expected {
        if book_bytes != expected_bytes || attached_count != expected_count {
            return Err(SaveFileError::invalid_data(format!(
                "清单附书 {attached_count} 本/{book_bytes} 字节与 Offer {expected_count} 本/{expected_bytes} 字节不一致"
            )));
        }
    }
    let budget = SpaceBudget::extracting(book_bytes).map_err(space_error)?;
    let available = available_space_for(staging_dir)?;
    budget.check(available).map_err(space_error)?;

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
        let target_path = staging_dir.join(entry.path.strip_prefix("books/").ok_or_else(|| SaveFileError::invalid_data("书籍条目路径无效"))?);
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
mod tests;
