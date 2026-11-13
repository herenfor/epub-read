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
