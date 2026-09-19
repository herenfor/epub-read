//! Model package manifests and the read-only model-library boundary.
//!
//! This module intentionally does not download, delete, or execute anything.
//! A package is a directory below the configured model-library root containing
//! a `model.json` manifest and one or more relative files.  The manifest is
//! validated before it is registered in the AI database; verification always
//! reads files from that configured root and never accepts an arbitrary path
//! from the frontend.

use super::model_locks::ModelLock;
use super::AiState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, State};

pub(crate) const MODEL_MANIFEST_FILE: &str = "model.json";
pub(crate) const MODEL_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub(crate) const DEFAULT_MODEL_PACKAGE_ID: &str = "default";
pub(crate) const MODEL_MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
const MODEL_MAX_FILES: usize = 128;
const MODEL_MAX_ID_CHARS: usize = 128;
const MODEL_MAX_STRING_CHARS: usize = 4096;
const MODEL_MAX_PATH_CHARS: usize = 4096;
const MODEL_FILE_EXTENSIONS: [&str; 9] = [
    "onnx",
    "onnx_data",
    "gguf",
    "json",
    "txt",
    "model",
    "vocab",
    "merges",
    "tiktoken",
];

const MODEL_CAPABILITIES: [&str; 3] = ["embedding", "generation", "reranking"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelManifestFile {
    #[serde(alias = "fileName")]
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub purpose: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelDownloadMirror {
    pub url: String,
    #[serde(default)]
    pub kind: Option<String>,
}

/// Versioned model metadata.  The aliases keep early hand-written packages
/// (`package`/`model`) readable while the IPC representation uses stable IDs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelPackageManifest {
    pub schema_version: u32,
    #[serde(alias = "package")]
    pub package_id: String,
    #[serde(alias = "model")]
    pub model_id: String,
    pub version: String,
    pub display_name: String,
    pub capabilities: Vec<String>,
    pub format: String,
    pub files: Vec<ModelManifestFile>,
    #[serde(default)]
    pub dimensions: Option<u64>,
    #[serde(default)]
    pub max_input: Option<u64>,
    #[serde(default)]
    pub recommended_batch: Option<u32>,
    #[serde(default)]
    pub min_memory_bytes: Option<u64>,
    #[serde(default)]
    pub recommended_memory_bytes: Option<u64>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    pub license: String,
    pub original_source: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub requires_acceptance: bool,
    #[serde(default)]
    pub download_mirrors: Vec<ModelDownloadMirror>,
    #[serde(default)]
    pub provider_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPackageIssue {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPackageScanStatus {
    /// Relative to the configured model-library root; this avoids exposing a
    /// second absolute path for every package.
    pub package_dir: String,
    pub package_id: Option<String>,
    pub model_id: Option<String>,
    pub state: String,
    pub manifest: Option<ModelPackageManifest>,
    pub issues: Vec<ModelPackageIssue>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelLibraryRootInfo {
    pub path: Option<String>,
    pub exists: bool,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPackageScanResult {
    pub root: ModelLibraryRootInfo,
    pub packages: Vec<ModelPackageScanStatus>,
    pub default_package_id: Option<String>,
    pub scan_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPackageFileRecord {
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub purpose: String,
    pub verification_state: String,
    pub actual_size_bytes: Option<u64>,
    pub actual_sha256: Option<String>,
    pub downloaded_bytes: u64,
    pub installed_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPackageSourceRecord {
    pub url: String,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDownloadTaskRecord {
    pub id: String,
    pub package_id: String,
    pub state: String,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub current_file_path: Option<String>,
    pub current_file_index: Option<u32>,
    pub package_total_bytes: Option<u64>,
    pub current_source_url: Option<String>,
    pub source_index: Option<u32>,
    pub error: Option<String>,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// A registered package is metadata only.  `state` is persisted so later
/// download tasks can use the same record without changing the manifest
/// contract.  This batch only produces `installed`, `missing`, or `corrupt`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPackageRecord {
    pub package_id: String,
    pub model_id: String,
    pub version: String,
    pub display_name: String,
    pub capabilities: Vec<String>,
    pub format: String,
    pub dimensions: Option<u64>,
    pub max_input: Option<u64>,
    pub recommended_batch: Option<u32>,
    pub min_memory_bytes: Option<u64>,
    pub recommended_memory_bytes: Option<u64>,
    pub platform: Option<String>,
    pub arch: Option<String>,
    pub license: String,
    pub original_source: String,
    pub homepage: Option<String>,
    pub requires_acceptance: bool,
    pub provider_kind: Option<String>,
    pub storage_kind: String,
    pub package_dir: String,
    pub linked_external_path: Option<String>,
    pub state: String,
    pub files: Vec<ModelPackageFileRecord>,
    pub sources: Vec<ModelPackageSourceRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelLibraryPathSetting {
    pub path: Option<String>,
    pub exists: bool,
    pub is_directory: bool,
}

pub(crate) fn model_root_from_setting(path: Option<&str>) -> Option<PathBuf> {
    path.map(PathBuf::from)
}

pub(crate) fn model_library_root_info(path: Option<&Path>) -> ModelLibraryRootInfo {
    let Some(path) = path else {
        return ModelLibraryRootInfo {
            path: None,
            exists: false,
            is_directory: false,
        };
    };
    let metadata = fs::metadata(path).ok();
    ModelLibraryRootInfo {
        path: Some(path.to_string_lossy().into_owned()),
        exists: metadata.is_some(),
        is_directory: metadata.is_some_and(|value| value.is_dir()),
    }
}

pub(crate) fn validate_model_library_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("模型库目录必须是非空绝对路径".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("模型库目录必须使用绝对路径".into());
    }
    Ok(trimmed.to_string())
}

fn ensure_model_library_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        if !path.is_dir() {
            return Err("模型库路径已存在但不是目录".into());
        }
    } else {
        fs::create_dir_all(path).map_err(|error| format!("无法创建模型库目录：{error}"))?;
    }
    let probe = path.join(format!(
        ".epub-reader-model-write-test-{}",
        std::process::id()
    ));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("模型库目录不可写：{error}"))?;
    drop(file);
    fs::remove_file(&probe).map_err(|error| format!("无法清理模型库写入测试文件：{error}"))
}

pub(crate) fn scan_model_library(root: &Path) -> ModelPackageScanResult {
    let root_info = model_library_root_info(Some(root));
    if !root_info.exists {
        return ModelPackageScanResult {
            root: root_info,
            packages: Vec::new(),
            default_package_id: None,
            scan_error: None,
        };
    }
    if !root_info.is_directory {
        return ModelPackageScanResult {
            root: root_info,
            packages: Vec::new(),
            default_package_id: None,
            scan_error: Some("模型库路径不是目录".into()),
        };
    }

    let mut entries = match fs::read_dir(root) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(error) => {
            return ModelPackageScanResult {
                root: root_info,
                packages: Vec::new(),
                default_package_id: None,
                scan_error: Some(format!("无法读取模型库目录：{error}")),
            }
        }
    };
    entries.sort_by_key(|entry| entry.file_name());
    let mut packages = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(super::model_locks::LOCK_DIRECTORY)
            || name.eq_ignore_ascii_case(".staging")
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path());
        let is_directory = metadata.as_ref().is_ok_and(|value| value.is_dir());
        let is_symlink = metadata
            .as_ref()
            .is_ok_and(|value| value.file_type().is_symlink());
        if !is_directory && !is_symlink {
            continue;
        }
        if is_symlink {
            packages.push(ModelPackageScanStatus {
                package_dir: name,
                package_id: None,
                model_id: None,
                state: "invalid".into(),
                manifest: None,
                issues: vec![issue("package-path-escape", "模型包目录不能是符号链接")],
            });
            continue;
        }
        packages.push(scan_package_directory(root, &entry.path(), &name));
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut duplicates = Vec::new();
    for (index, package) in packages.iter().enumerate() {
        let Some(package_id) = package.package_id.as_deref() else {
            continue;
        };
        if let Some(previous) = seen.insert(package_id.to_string(), index) {
            duplicates.push((previous, index));
        }
    }
    for (previous, current) in duplicates {
        let duplicate = issue("duplicate-package-id", "模型包 ID 重复，无法作为默认包解析");
        packages[previous].issues.push(duplicate.clone());
        packages[current].issues.push(duplicate);
    }
    for package in &mut packages {
        if !package.issues.is_empty() {
            package.state = "invalid".into();
        }
    }
    let default_package_id = packages
        .iter()
        .find(|package| {
            package.state == "ready"
                && package.package_id.as_deref() == Some(DEFAULT_MODEL_PACKAGE_ID)
        })
        .and_then(|package| package.package_id.clone());
    ModelPackageScanResult {
        root: root_info,
        packages,
        default_package_id,
        scan_error: None,
    }
}

pub(crate) fn scan_single_package(
    root: &Path,
    package_dir: &str,
) -> Result<ModelPackageScanStatus, String> {
    let components = validate_relative_path(package_dir, "模型包目录")?;
    let package_path = components
        .iter()
        .fold(root.to_path_buf(), |path, component| path.join(component));
    let package_metadata = fs::symlink_metadata(&package_path)
        .map_err(|error| format!("读取模型包目录失败：{error}"))?;
    if package_metadata.file_type().is_symlink() || is_reparse_point(&package_metadata) {
        return Err("模型包目录不能是符号链接或重解析点".into());
    }
    let root_canonical = root
        .canonicalize()
        .map_err(|error| format!("无法解析模型库目录：{error}"))?;
    let package_canonical = package_path
        .canonicalize()
        .map_err(|error| format!("无法解析模型包目录：{error}"))?;
    if !package_canonical.starts_with(&root_canonical) || !package_canonical.is_dir() {
        return Err("模型包目录越出模型库根目录或不是目录".into());
    }
    Ok(scan_package_directory(
        root,
        &package_canonical,
        package_dir,
    ))
}

fn validate_linked_external_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if !path.is_absolute() {
        return Err("linked 模型路径必须是绝对路径".into());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取 linked 模型目录失败：{error}"))?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err("linked 模型路径必须是普通目录，不能是符号链接".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("解析 linked 模型目录失败：{error}"))?;
    if !canonical.is_dir() {
        return Err("linked 模型路径不是目录".into());
    }
    Ok(canonical)
}

pub(crate) fn scan_linked_external_package(
    external_path: &str,
) -> Result<(ModelPackageScanStatus, PathBuf), String> {
    let canonical = validate_linked_external_path(external_path)?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "linked 模型目录缺少父目录".to_string())?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "linked 模型目录名称无效".to_string())?;
    Ok((scan_package_directory(parent, &canonical, name), canonical))
}

fn scan_package_directory(
    root: &Path,
    package_path: &Path,
    package_dir: &str,
) -> ModelPackageScanStatus {
    let manifest_path = package_path.join(MODEL_MANIFEST_FILE);
    let mut issues = Vec::new();
    let metadata = fs::symlink_metadata(&manifest_path);
    if metadata.as_ref().is_err() {
        issues.push(issue("manifest-missing", "模型包缺少 model.json"));
        return invalid_status(package_dir, None, None, issues);
    }
    if metadata
        .as_ref()
        .is_ok_and(|value| value.file_type().is_symlink())
    {
        issues.push(issue("manifest-invalid", "model.json 不能是符号链接"));
        return invalid_status(package_dir, None, None, issues);
    }
    let manifest_text = match fs::metadata(&manifest_path) {
        Ok(metadata) if metadata.len() > MODEL_MANIFEST_MAX_BYTES => {
            issues.push(issue("manifest-invalid", "model.json 超过 1 MiB 大小上限"));
            return invalid_status(package_dir, None, None, issues);
        }
        Ok(_) => match fs::read_to_string(&manifest_path) {
            Ok(text) => text,
            Err(error) => {
                issues.push(issue(
                    "manifest-invalid",
                    &format!("无法读取 model.json：{error}"),
                ));
                return invalid_status(package_dir, None, None, issues);
            }
        },
        Err(error) => {
            issues.push(issue(
                "manifest-invalid",
                &format!("无法读取 model.json：{error}"),
            ));
            return invalid_status(package_dir, None, None, issues);
        }
    };
    let manifest: ModelPackageManifest = match serde_json::from_str(&manifest_text) {
        Ok(value) => value,
        Err(error) => {
            issues.push(issue(
                "manifest-invalid",
                &format!("model.json 格式无效：{error}"),
            ));
            return invalid_status(package_dir, None, None, issues);
        }
    };
    issues.extend(validate_manifest(&manifest));
    let package_id = Some(manifest.package_id.clone());
    let model_id = Some(manifest.model_id.clone());
    for file in &manifest.files {
        let Ok(file_path) = resolve_model_file(root, package_path, &file.relative_path) else {
            issues.push(issue(
                "unsafe-model-path",
                "模型文件路径不安全或越出模型包目录",
            ));
            continue;
        };
        verify_model_file(&file_path, file, &mut issues);
    }
    let state = if issues.is_empty() {
        "ready"
    } else {
        "invalid"
    };
    ModelPackageScanStatus {
        package_dir: package_dir.to_string(),
        package_id,
        model_id,
        state: state.into(),
        manifest: Some(manifest),
        issues,
    }
}

fn invalid_status(
    package_dir: &str,
    package_id: Option<String>,
    model_id: Option<String>,
    issues: Vec<ModelPackageIssue>,
) -> ModelPackageScanStatus {
    ModelPackageScanStatus {
        package_dir: package_dir.to_string(),
        package_id,
        model_id,
        state: "invalid".into(),
        manifest: None,
        issues,
    }
}

fn validate_manifest(manifest: &ModelPackageManifest) -> Vec<ModelPackageIssue> {
    let mut issues = Vec::new();
    if manifest.schema_version != MODEL_MANIFEST_SCHEMA_VERSION {
        issues.push(issue("manifest-invalid", "不支持的模型包 schemaVersion"));
    }
    if !is_stable_slug(&manifest.package_id) {
        issues.push(issue("manifest-invalid", "packageId 必须是稳定的小写 slug"));
    }
    if !is_stable_slug(&manifest.model_id) {
        issues.push(issue("manifest-invalid", "modelId 必须是稳定的小写 slug"));
    }
    for (name, value, max_chars) in [
        ("version", manifest.version.as_str(), MODEL_MAX_ID_CHARS),
        ("displayName", manifest.display_name.as_str(), 512),
        ("format", manifest.format.as_str(), 64),
        ("license", manifest.license.as_str(), 512),
        (
            "originalSource",
            manifest.original_source.as_str(),
            MODEL_MAX_STRING_CHARS,
        ),
    ] {
        if !valid_text(value, max_chars) {
            issues.push(issue(
                "manifest-invalid",
                &format!("{name} 不能为空、过长或包含控制字符"),
            ));
        }
    }
    if manifest.capabilities.is_empty()
        || manifest
            .capabilities
            .iter()
            .any(|capability| !MODEL_CAPABILITIES.contains(&capability.as_str()))
    {
        issues.push(issue("manifest-invalid", "capabilities 包含未知或缺失能力"));
    }
    if manifest.files.is_empty() || manifest.files.len() > MODEL_MAX_FILES {
        issues.push(issue(
            "manifest-invalid",
            "模型包至少需要一个且不得超过 128 个 files 条目",
        ));
    }
    let mut paths = HashSet::new();
    for file in &manifest.files {
        if file.relative_path.replace('\\', "/") == MODEL_MANIFEST_FILE {
            issues.push(issue("manifest-invalid", "模型文件不得覆盖 model.json"));
        }
        if validate_relative_path(&file.relative_path, "模型文件").is_err()
            || !is_supported_model_file(&file.relative_path)
        {
            issues.push(issue("unsafe-model-path", "模型文件路径必须是包内相对路径"));
        }
        let normalized_path = file.relative_path.replace('\\', "/").to_ascii_lowercase();
        if !paths.insert(normalized_path) {
            issues.push(issue("manifest-invalid", "模型包包含重复文件路径"));
        }
        if file.size_bytes == 0
            || file.size_bytes > i64::MAX as u64
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            issues.push(issue("manifest-invalid", "模型文件大小或 SHA-256 无效"));
        }
        if !valid_text(&file.purpose, 128) {
            issues.push(issue("manifest-invalid", "模型文件 purpose 不能为空"));
        }
    }
    let mut mirrors = HashSet::new();
    let mut capabilities = HashSet::new();
    for capability in &manifest.capabilities {
        if !capabilities.insert(capability) {
            issues.push(issue("manifest-invalid", "capabilities 不得包含重复能力"));
        }
    }
    for mirror in &manifest.download_mirrors {
        if !valid_base_url(&mirror.url) {
            issues.push(issue("manifest-invalid", "downloadMirrors 包含无效地址"));
        } else if !mirrors.insert(mirror.url.trim_end_matches('/').to_ascii_lowercase()) {
            issues.push(issue(
                "manifest-invalid",
                "downloadMirrors 不得包含重复地址",
            ));
        }
    }
    for (name, value) in [
        ("platform", manifest.platform.as_deref()),
        ("arch", manifest.arch.as_deref()),
        ("providerKind", manifest.provider_kind.as_deref()),
        ("homepage", manifest.homepage.as_deref()),
    ] {
        if value.is_some_and(|value| !valid_text(value, MODEL_MAX_STRING_CHARS)) {
            issues.push(issue(
                "manifest-invalid",
                &format!("{name} 过长或包含控制字符"),
            ));
        }
    }
    for (name, value) in [
        ("dimensions", manifest.dimensions),
        ("maxInput", manifest.max_input),
        ("minMemoryBytes", manifest.min_memory_bytes),
        ("recommendedMemoryBytes", manifest.recommended_memory_bytes),
    ] {
        if value == Some(0) {
            issues.push(issue("manifest-invalid", &format!("{name} 必须大于 0")));
        }
    }
    if manifest.recommended_batch == Some(0) {
        issues.push(issue("manifest-invalid", "recommendedBatch 必须大于 0"));
    }
    issues
}

pub(crate) fn validate_manifest_for_registration(
    manifest: &ModelPackageManifest,
) -> Result<(), String> {
    let issues = validate_manifest(manifest);
    issues
        .first()
        .map(|issue| Err(issue.message.clone()))
        .unwrap_or(Ok(()))
}

fn verify_model_file(
    path: &Path,
    expected: &ModelManifestFile,
    issues: &mut Vec<ModelPackageIssue>,
) {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            issues.push(issue(
                "missing-file",
                &format!("缺少模型文件：{}", expected.relative_path),
            ));
            return;
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        issues.push(issue(
            "missing-file",
            &format!("模型文件不是普通文件：{}", expected.relative_path),
        ));
        return;
    }
    if metadata.len() != expected.size_bytes {
        issues.push(issue(
            "size-mismatch",
            &format!("模型文件大小不匹配：{}", expected.relative_path),
        ));
        return;
    }
    match sha256_file(path) {
        Ok(actual) if actual.eq_ignore_ascii_case(&expected.sha256) => {}
        Ok(_) => issues.push(issue(
            "sha256-mismatch",
            &format!("模型文件 SHA-256 不匹配：{}", expected.relative_path),
        )),
        Err(error) => issues.push(issue(
            "sha256-mismatch",
            &format!("无法校验模型文件：{error}"),
        )),
    }
}

fn valid_text(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn is_stable_slug(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > MODEL_MAX_ID_CHARS {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    if !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit() {
        return false;
    }
    value.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
    })
}

pub(crate) fn is_supported_model_file(value: &str) -> bool {
    let Some(name) = value.rsplit('/').next() else {
        return false;
    };
    let Some((_, extension)) = name.rsplit_once('.') else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    MODEL_FILE_EXTENSIONS.contains(&extension.as_str())
}

pub(crate) fn valid_base_url(value: &str) -> bool {
    let trimmed = value.trim();
    (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
        && valid_text(trimmed, MODEL_MAX_STRING_CHARS)
        && !trimmed.contains(['?', '#'])
}

pub(crate) fn resolve_model_file(
    root: &Path,
    package_path: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let components = validate_relative_path(relative_path, "模型文件")?;
    let path = components
        .iter()
        .fold(package_path.to_path_buf(), |path, component| {
            path.join(component)
        });
    let mut component_path = package_path.to_path_buf();
    for component in &components {
        component_path.push(component);
        if let Ok(metadata) = fs::symlink_metadata(&component_path) {
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err("模型文件路径不能包含符号链接或重解析点".into());
            }
        }
    }
    let root_canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let package_canonical = package_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !package_canonical.starts_with(&root_canonical) {
        return Err("模型包目录越出模型库根目录".into());
    }
    let mut ancestor = path.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "模型文件路径无效".to_string())?;
    }
    let canonical_ancestor = ancestor.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_ancestor.starts_with(&package_canonical) {
        return Err("模型文件路径越出模型包目录".into());
    }
    Ok(path)
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

pub(crate) fn validate_relative_path(value: &str, label: &str) -> Result<Vec<String>, String> {
    if value.trim().is_empty()
        || value.chars().count() > MODEL_MAX_PATH_CHARS
        || value
            .chars()
            .any(|value| value == '\0' || value.is_control())
    {
        return Err(format!("{label}路径不能为空或包含控制字符"));
    }
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.starts_with("//")
        || normalized.as_bytes().get(1) == Some(&b':')
    {
        return Err(format!("{label}路径不能是绝对路径"));
    }
    let components = normalized
        .split('/')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if components.iter().any(|component| {
        component.is_empty()
            || component == "."
            || component == ".."
            || component.contains(':')
            || component.ends_with(['.', ' '])
            || is_windows_reserved_name(component)
    }) {
        return Err(format!("{label}路径包含不安全片段"));
    }
    let path = components
        .iter()
        .fold(PathBuf::new(), |path, component| path.join(component));
    if path.components().any(|component| {
        matches!(
            component,
            Component::RootDir | Component::ParentDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("{label}路径不是安全相对路径"));
    }
    Ok(components)
}

fn is_windows_reserved_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    // Keep the streaming buffer off the stack. Windows application threads
    // commonly have a 1 MiB stack, so a 1 MiB local array can terminate the
    // process before verification begins.
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn issue(code: &str, message: &str) -> ModelPackageIssue {
    ModelPackageIssue {
        code: code.into(),
        message: message.into(),
    }
}

pub(crate) fn ai_model_library_path_get_impl(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<ModelLibraryPathSetting, String> {
    let path = state.ensure(&app)?.model_library_path()?;
    let root = model_root_from_setting(path.as_deref());
    let info = model_library_root_info(root.as_deref());
    Ok(ModelLibraryPathSetting {
        path: info.path,
        exists: info.exists,
        is_directory: info.is_directory,
    })
}

pub(crate) fn ai_model_library_path_set_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    path: String,
) -> Result<ModelLibraryPathSetting, String> {
    let path = validate_model_library_path(&path)?;
    let store = state.ensure(&app)?;
    if store.has_active_model_downloads()? {
        return Err("模型下载任务进行中，暂时不能更改模型库目录".into());
    }
    ensure_model_library_directory(Path::new(&path))?;
    store.set_model_library_path(&path)?;
    let info = model_library_root_info(Some(Path::new(&path)));
    Ok(ModelLibraryPathSetting {
        path: info.path,
        exists: info.exists,
        is_directory: info.is_directory,
    })
}

pub(crate) fn ai_model_scan_impl(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<ModelPackageScanResult, String> {
    let store = state.ensure(&app)?;
    let path = store.model_library_path()?;
    let Some(path) = model_root_from_setting(path.as_deref()) else {
        return Ok(ModelPackageScanResult {
            root: model_library_root_info(None),
            packages: Vec::new(),
            default_package_id: None,
            scan_error: Some("尚未设置模型库目录".into()),
        });
    };
    let _guard = ModelLock::root(&path)?;
    ensure_current_root(&store, &path)?;
    store.mark_missing_managed_packages(&path)?;
    let result = scan_model_library(&path);
    let stale_results = result
        .packages
        .iter()
        .map(|package| {
            (
                package.package_dir.clone(),
                package.package_id.clone(),
                if package
                    .issues
                    .iter()
                    .any(|issue| issue.code == "manifest-missing")
                {
                    "missing".to_string()
                } else if package.state == "ready" {
                    "ready".to_string()
                } else {
                    "corrupt".to_string()
                },
            )
        })
        .collect::<Vec<_>>();
    store.mark_stale_managed_packages(&stale_results)?;
    for package in &result.packages {
        let Some(package_id) = package.package_id.as_deref() else {
            continue;
        };
        if package.state == "ready" {
            if let Some(manifest) = package.manifest.as_ref() {
                store.register_verified_model_manifest(manifest, &package.package_dir)?;
            }
        } else if store.get_model_package(package_id)?.is_some() {
            store.update_model_package_verification(package_id, package)?;
        }
    }
    Ok(result)
}

pub(crate) fn ai_model_packages_impl(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<Vec<ModelPackageRecord>, String> {
    state.ensure(&app)?.list_model_packages()
}

/// Shared by the debug setup command: validates one package directory under
/// `root`, confirms its manifest, and registers it as a verified managed
/// package.  It performs no download and no model load.
#[cfg(feature = "ai")]
pub(crate) fn register_package_from_dir(
    store: &super::AiStore,
    root: &Path,
    package_dir: &str,
) -> Result<ModelPackageRecord, String> {
    let _guard = ModelLock::package(root, package_dir, true)?;
    ensure_current_root(store, root)?;
    let status = scan_single_package(root, package_dir)?;
    if status.state != "ready" {
        return Err(status
            .issues
            .first()
            .map(|issue| issue.message.clone())
            .unwrap_or_else(|| "模型包无效".into()));
    }
    let manifest = status
        .manifest
        .ok_or_else(|| "模型包缺少 manifest".to_string())?;
    store.register_verified_model_manifest(&manifest, &status.package_dir)?;
    store
        .get_model_package(&manifest.package_id)?
        .ok_or_else(|| "模型包注册后无法读取".into())
}

pub(crate) fn ai_model_package_register_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    package_dir: String,
) -> Result<ModelPackageRecord, String> {
    let store = state.ensure(&app)?;
    let path = store
        .model_library_path()?
        .ok_or_else(|| "尚未设置模型库目录".to_string())?;
    let _guard = ModelLock::package(Path::new(&path), &package_dir, true)?;
    ensure_current_root(&store, Path::new(&path))?;
    let status = scan_single_package(Path::new(&path), &package_dir)?;
    if status.state != "ready" {
        return Err(status
            .issues
            .first()
            .map(|issue| issue.message.clone())
            .unwrap_or_else(|| "模型包无效".into()));
    }
    let manifest = status
        .manifest
        .ok_or_else(|| "模型包缺少 manifest".to_string())?;
    store.register_verified_model_manifest(&manifest, &status.package_dir)?;
    store
        .get_model_package(&manifest.package_id)?
        .ok_or_else(|| "模型包注册后无法读取".into())
}

pub(crate) fn ai_model_package_verify_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
) -> Result<ModelPackageRecord, String> {
    let store = state.ensure(&app)?;
    let package = store
        .get_model_package(&package_id)?
        .ok_or_else(|| "模型包不存在".to_string())?;
    if package.storage_kind == "linked" {
        return verify_linked_package(&store, &package);
    }
    let root = store
        .model_library_path()?
        .ok_or_else(|| "尚未设置模型库目录".to_string())?;
    let _guard = ModelLock::package(Path::new(&root), &package.package_dir, true)?;
    ensure_current_root(&store, Path::new(&root))?;
    let status = scan_single_package(Path::new(&root), &package.package_dir)?;
    store.update_model_package_verification(&package_id, &status)?;
    store
        .get_model_package(&package_id)?
        .ok_or_else(|| "模型包校验后无法读取".into())
}

fn ensure_current_root(store: &super::AiStore, expected: &Path) -> Result<(), String> {
    if store.model_library_path()?.as_deref().map(Path::new) != Some(expected) {
        return Err("模型库目录已变更，请刷新后重试".into());
    }
    Ok(())
}

fn guard_linked_managed_root(
    store: &super::AiStore,
    external: &str,
) -> Result<Option<ModelLock>, String> {
    let Some(root) = store.model_library_path()?.map(PathBuf::from) else {
        return Ok(None);
    };
    let (Ok(canonical_root), Ok(canonical_external)) =
        (root.canonicalize(), Path::new(external).canonicalize())
    else {
        return Ok(None);
    };
    // Linked packages elsewhere are never mutated by this asset manager. If
    // linked into our managed root, coordinate with its installers/deleters.
    if !canonical_external.starts_with(&canonical_root) {
        return Ok(None);
    }
    let guard = ModelLock::root(&root)?;
    ensure_current_root(store, &root)?;
    Ok(Some(guard))
}

pub(crate) fn verify_linked_package(
    store: &super::AiStore,
    package: &ModelPackageRecord,
) -> Result<ModelPackageRecord, String> {
    let external = package
        .linked_external_path
        .as_deref()
        .ok_or_else(|| "linked 模型缺少外部路径".to_string())?;
    let _guard = guard_linked_managed_root(store, external)?;
    let status = match scan_linked_external_package(external) {
        Ok((status, _)) => status,
        Err(error) => {
            let state = if !Path::new(external).exists() {
                "missing"
            } else {
                "corrupt"
            };
            store.set_model_package_state(&package.package_id, state)?;
            return store
                .get_model_package(&package.package_id)?
                .ok_or_else(|| format!("linked 模型校验后无法读取：{error}"));
        }
    };
    store.update_model_package_verification(&package.package_id, &status)?;
    store
        .get_model_package(&package.package_id)?
        .ok_or_else(|| "linked 模型校验后无法读取".into())
}

pub(crate) fn ai_model_package_register_linked_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    external_path: String,
) -> Result<ModelPackageRecord, String> {
    let store = state.ensure(&app)?;
    let _guard = guard_linked_managed_root(&store, &external_path)?;
    let (status, canonical) = scan_linked_external_package(&external_path)?;
    if status.state != "ready" {
        return Err(status
            .issues
            .first()
            .map(|issue| issue.message.clone())
            .unwrap_or_else(|| "linked 模型无效".into()));
    }
    let manifest = status
        .manifest
        .ok_or_else(|| "linked 模型缺少 manifest".to_string())?;
    store.register_linked_model_manifest(&manifest, canonical.to_string_lossy().as_ref())?;
    store
        .get_model_package(&manifest.package_id)?
        .ok_or_else(|| "linked 模型注册后无法读取".into())
}

pub(crate) fn ai_model_package_relocate_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
    external_path: String,
) -> Result<ModelPackageRecord, String> {
    let store = state.ensure(&app)?;
    let package = store
        .get_model_package(&package_id)?
        .ok_or_else(|| "模型包不存在".to_string())?;
    if package.storage_kind != "linked" {
        return Err("只有 linked 模型支持重新定位".into());
    }
    let _guard = guard_linked_managed_root(&store, &external_path)?;
    let (status, canonical) = scan_linked_external_package(&external_path)?;
    let manifest = status
        .manifest
        .ok_or_else(|| "linked 模型缺少 manifest".to_string())?;
    if status.state != "ready" || manifest.package_id != package.package_id {
        return Err("新 linked 模型未通过完整校验或 packageId 不匹配".into());
    }
    let current = package_manifest_from_record(&package)?;
    if manifest != current {
        return Err("重新定位的模型清单与原记录不一致".into());
    }
    store.update_linked_model_path(&package_id, canonical.to_string_lossy().as_ref())?;
    store
        .get_model_package(&package_id)?
        .ok_or_else(|| "linked 模型重新定位后无法读取".into())
}

pub(crate) fn ai_model_package_remove_impl(
    app: AppHandle,
    state: State<'_, AiState>,
    package_id: String,
    delete_managed_files: bool,
) -> Result<(), String> {
    state
        .ensure(&app)?
        .remove_model_package(&package_id, delete_managed_files)
}

pub(crate) fn ai_model_dev_catalog_register_impl(
    app: AppHandle,
    state: State<'_, AiState>,
) -> Result<ModelPackageRecord, String> {
    if !cfg!(debug_assertions) {
        return Err("模型开发 catalog 仅在开发构建可用".into());
    }
    let manifest = development_catalog_manifest();
    let store = state.ensure(&app)?;
    store.register_catalog_model_manifest(&manifest, "c57-dev-probe")?;
    store
        .get_model_package(&manifest.package_id)?
        .ok_or_else(|| "开发 catalog 注册后无法读取".into())
}

fn development_catalog_manifest() -> ModelPackageManifest {
    ModelPackageManifest {
        schema_version: MODEL_MANIFEST_SCHEMA_VERSION,
        package_id: "c57-dev-probe".into(),
        model_id: "c57-dev-probe".into(),
        version: "0.0.1".into(),
        display_name: "C-57 开发探针（不可推理）".into(),
        capabilities: vec!["embedding".into()],
        format: "text-fixture".into(),
        files: vec![ModelManifestFile {
            relative_path: "probe.txt".into(),
            size_bytes: 15,
            sha256: "ce6d4d8b3f39c5ecaeaf120c0fdeb6acdca57ea6e8235c430d61c50919eba736".into(),
            purpose: "development-fixture".into(),
        }],
        dimensions: None,
        max_input: Some(64),
        recommended_batch: Some(1),
        min_memory_bytes: None,
        recommended_memory_bytes: None,
        platform: None,
        arch: None,
        license: "Apache-2.0".into(),
        original_source: "EPUB Reader development fixture".into(),
        homepage: None,
        requires_acceptance: true,
        download_mirrors: vec![ModelDownloadMirror {
            // Keep this host aligned with tauri.conf.json's development devUrl.
            // On Windows, Vite may bind localhost through IPv6 only, in which
            // case a separate 127.0.0.1 request cannot reach the fixture.
            url: "http://localhost:5173/c57-dev-probe".into(),
            kind: Some("development-fixture".into()),
        }],
        provider_kind: Some("mock".into()),
    }
}

fn package_manifest_from_record(
    package: &ModelPackageRecord,
) -> Result<ModelPackageManifest, String> {
    Ok(ModelPackageManifest {
        schema_version: MODEL_MANIFEST_SCHEMA_VERSION,
        package_id: package.package_id.clone(),
        model_id: package.model_id.clone(),
        version: package.version.clone(),
        display_name: package.display_name.clone(),
        capabilities: package.capabilities.clone(),
        format: package.format.clone(),
        files: package
            .files
            .iter()
            .map(|file| ModelManifestFile {
                relative_path: file.relative_path.clone(),
                size_bytes: file.size_bytes,
                sha256: file.sha256.clone(),
                purpose: file.purpose.clone(),
            })
            .collect(),
        dimensions: package.dimensions,
        max_input: package.max_input,
        recommended_batch: package.recommended_batch,
        min_memory_bytes: package.min_memory_bytes,
        recommended_memory_bytes: package.recommended_memory_bytes,
        platform: package.platform.clone(),
        arch: package.arch.clone(),
        license: package.license.clone(),
        original_source: package.original_source.clone(),
        homepage: package.homepage.clone(),
        requires_acceptance: package.requires_acceptance,
        download_mirrors: package
            .sources
            .iter()
            .map(|source| ModelDownloadMirror {
                url: source.url.clone(),
                kind: source.kind.clone(),
            })
            .collect(),
        provider_kind: package.provider_kind.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "epub-reader-model-test-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write_package(root: &Path, dir: &str, manifest: &str, bytes: &[u8]) {
        let package = root.join(dir);
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("model.json"), manifest).unwrap();
        fs::write(package.join("weights.gguf"), bytes).unwrap();
    }

    fn valid_manifest(package: &str, size: usize, sha: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"packageId":"{package}","modelId":"model","version":"1","displayName":"Model","capabilities":["generation"],"format":"gguf","files":[{{"relativePath":"weights.gguf","sizeBytes":{size},"sha256":"{sha}","purpose":"weights"}}],"license":"Apache-2.0","originalSource":"local","providerKind":"llama.cpp"}}"#
        )
    }

    #[test]
    fn scans_valid_multifile_package_and_resolves_default_only_when_ready() {
        let root = temp_root();
        let bytes = b"weights";
        let hash = format!("{:x}", Sha256::digest(bytes));
        write_package(
            &root,
            "default",
            &valid_manifest("default", bytes.len(), &hash),
            bytes,
        );
        let result = scan_model_library(&root);
        assert_eq!(result.packages.len(), 1);
        assert_eq!(result.packages[0].state, "ready");
        assert_eq!(result.default_package_id.as_deref(), Some("default"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_missing_size_and_hash_as_item_issues() {
        let root = temp_root();
        write_package(
            &root,
            "broken",
            &valid_manifest("broken", 999, &"a".repeat(64)),
            b"weights",
        );
        let result = scan_model_library(&root);
        let codes = result.packages[0]
            .issues
            .iter()
            .map(|issue| issue.code.as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"size-mismatch"));
        fs::remove_file(root.join("broken/weights.gguf")).unwrap();
        let result = scan_model_library(&root);
        assert!(result.packages[0]
            .issues
            .iter()
            .any(|issue| issue.code == "missing-file"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_manifest_does_not_hide_valid_sibling() {
        let root = temp_root();
        write_package(&root, "bad", "{", b"bad");
        let bytes = b"weights";
        let hash = format!("{:x}", Sha256::digest(bytes));
        write_package(
            &root,
            "good",
            &valid_manifest("good", bytes.len(), &hash),
            bytes,
        );
        let result = scan_model_library(&root);
        assert_eq!(result.packages.len(), 2);
        assert!(result
            .packages
            .iter()
            .any(|package| package.state == "ready"));
        assert!(result.packages.iter().any(|package| package
            .issues
            .iter()
            .any(|issue| issue.code == "manifest-invalid")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_absolute_and_parent_paths_before_file_access() {
        assert!(validate_relative_path("../weights.bin", "模型文件").is_err());
        assert!(validate_relative_path("C:\\weights.bin", "模型文件").is_err());
        assert!(validate_relative_path("/weights.bin", "模型文件").is_err());
        assert!(is_supported_model_file("weights.gguf"));
        assert!(is_supported_model_file("tokenizer.json"));
        assert!(!is_supported_model_file("runner.exe"));
        assert!(!is_supported_model_file("script.js"));
        assert!(!is_supported_model_file("weights.bin"));
        for name in [
            "CON",
            "nul.txt",
            "PRN",
            "COM1",
            "LPT9",
            "weights.gguf ",
            "weights.gguf.",
        ] {
            assert!(validate_relative_path(name, "模型文件").is_err(), "{name}");
        }
    }

    #[test]
    fn scans_linked_external_package_without_copying() {
        let root = temp_root();
        let package = root.join("external");
        fs::create_dir_all(&package).unwrap();
        let bytes = b"weights";
        let hash = format!("{:x}", Sha256::digest(bytes));
        fs::write(
            package.join("model.json"),
            valid_manifest("linked", bytes.len(), &hash),
        )
        .unwrap();
        fs::write(package.join("weights.gguf"), bytes).unwrap();
        let (status, canonical) = scan_linked_external_package(package.to_str().unwrap()).unwrap();
        assert_eq!(status.state, "ready");
        assert_eq!(canonical, package.canonicalize().unwrap());
        assert!(package.join("weights.gguf").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn managed_single_package_rejects_symlink_alias_before_canonicalize() {
        use std::os::unix::fs::symlink;
        let root = temp_root();
        let real = root.join("real");
        let alias = root.join("alias");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &alias).unwrap();
        assert!(scan_single_package(&root, "alias").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_external_root_rejects_symlink() {
        use std::os::unix::fs::symlink;
        let root = temp_root();
        let real = root.join("real");
        let alias = root.join("alias");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &alias).unwrap();
        assert!(scan_linked_external_package(alias.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_model_library_requires_absolute_path() {
        assert!(validate_model_library_path("models").is_err());
        let absolute_model_path = std::env::temp_dir().join("epub-reader-models");
        assert!(validate_model_library_path(absolute_model_path.to_str().unwrap()).is_ok());
        assert!(valid_base_url("https://example.invalid/models"));
        assert!(valid_base_url("http://127.0.0.1:8080/models"));
        assert!(!valid_base_url("file:///tmp/models"));
        assert!(!valid_base_url("https://example.invalid/models?x=1"));
        assert!(!is_stable_slug("Default"));
        assert!(is_stable_slug("qwen2.5-7b"));
    }

    #[test]
    fn model_library_directory_is_created_and_write_checked_without_touching_contents() {
        let root = temp_root();
        let nested = root.join("nested");
        ensure_model_library_directory(&nested).unwrap();
        let sentinel = nested.join("sentinel.txt");
        fs::write(&sentinel, b"keep").unwrap();
        ensure_model_library_directory(&nested).unwrap();
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        let file_path = root.join("not-a-directory");
        fs::write(&file_path, b"keep").unwrap();
        assert!(ensure_model_library_directory(&file_path).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn development_catalog_is_fixed_small_and_local_only() {
        let manifest = development_catalog_manifest();
        assert_eq!(manifest.package_id, "c57-dev-probe");
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].relative_path, "probe.txt");
        assert_eq!(manifest.files[0].size_bytes, 15);
        assert_eq!(
            manifest.files[0].sha256,
            "ce6d4d8b3f39c5ecaeaf120c0fdeb6acdca57ea6e8235c430d61c50919eba736"
        );
        assert_eq!(
            manifest.download_mirrors[0].url,
            "http://localhost:5173/c57-dev-probe"
        );
        assert!(manifest.requires_acceptance);
        assert!(cfg!(debug_assertions));
    }

    #[test]
    fn sha256_verification_works_on_a_windows_sized_small_stack() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let file = root.join("digest.txt");
        fs::write(&file, b"abc").unwrap();

        let digest = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || sha256_file(&file))
            .unwrap()
            .join()
            .expect("small-stack SHA worker must not overflow")
            .unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        fs::remove_dir_all(root).unwrap();
    }
}
