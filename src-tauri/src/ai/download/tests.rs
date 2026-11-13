use super::*;
use std::io::Cursor;

struct MockClient {
    responses: Mutex<Vec<HttpResponse>>,
}

struct CountingClient {
    calls: std::sync::atomic::AtomicUsize,
}
impl HttpClient for CountingClient {
    fn get(&self, _url: &str, _range_start: Option<u64>) -> Result<HttpResponse, String> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Err("network must not be called".into())
    }
}
impl HttpClient for MockClient {
    fn get(&self, _url: &str, _range_start: Option<u64>) -> Result<HttpResponse, String> {
        self.responses
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| "no response".into())
    }
}
fn response(status: u16, range: Option<&str>, data: &[u8]) -> HttpResponse {
    HttpResponse {
        status,
        content_range: range.map(str::to_string),
        reader: Box::new(Cursor::new(data.to_vec())),
    }
}
fn expected(data: &[u8]) -> ModelManifestFile {
    ModelManifestFile {
        relative_path: "weights.gguf".into(),
        size_bytes: data.len() as u64,
        sha256: format!("{:x}", Sha256::digest(data)),
        purpose: "weights".into(),
    }
}

fn catalog_manifest(package_id: &str, data: &[u8]) -> ModelPackageManifest {
    ModelPackageManifest {
        schema_version: 1,
        package_id: package_id.into(),
        model_id: format!("{package_id}-model"),
        version: "1".into(),
        display_name: package_id.into(),
        capabilities: vec!["generation".into()],
        format: "gguf".into(),
        files: vec![expected(data)],
        dimensions: None,
        max_input: None,
        recommended_batch: None,
        min_memory_bytes: None,
        recommended_memory_bytes: None,
        platform: None,
        arch: None,
        license: "Apache-2.0".into(),
        original_source: "test".into(),
        homepage: None,
        requires_acceptance: false,
        download_mirrors: vec![super::super::models::ModelDownloadMirror {
            url: "https://example.invalid/models".into(),
            kind: None,
        }],
        provider_kind: None,
    }
}

fn no_progress(_: u64) -> Result<(), String> {
    Ok(())
}

#[test]
fn worker_holds_ownership_through_install_and_second_store_reuses_package() {
    struct LockedClient {
        root: PathBuf,
        other: Arc<AiStore>,
    }
    impl HttpClient for LockedClient {
        fn get(&self, _: &str, _: Option<u64>) -> Result<HttpResponse, String> {
            assert!(
                super::super::model_locks::ModelLock::package(&self.root, "shared", false)
                    .is_err()
            );
            assert_eq!(
                self.other.remove_model_package("shared", true).unwrap_err(),
                super::super::model_locks::BUSY
            );
            Ok(response(200, None, b"weights"))
        }
    }
    let root = std::env::temp_dir().join(format!(
        "epub-download-shared-install-{}",
        std::process::id()
    ));
    let model_root = root.join("models");
    fs::create_dir_all(&model_root).unwrap();
    let first = AiStore::open(&root.join("first-app")).unwrap();
    let second = Arc::new(AiStore::open(&root.join("second-app")).unwrap());
    for store in [&first, second.as_ref()] {
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        store
            .register_catalog_model_manifest(&catalog_manifest("shared", b"weights"), "shared")
            .unwrap();
    }
    let task = first.create_or_get_model_download_task("shared").unwrap();
    run_task_with_client(
        &first,
        &task.id,
        Arc::default(),
        &FsDiskSpace,
        &LockedClient {
            root: model_root.clone(),
            other: Arc::clone(&second),
        },
    )
    .unwrap();
    assert_eq!(
        first
            .get_model_download_task(&task.id)
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
    let task = second.create_or_get_model_download_task("shared").unwrap();
    let client = CountingClient {
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    run_task_with_client(&second, &task.id, Arc::default(), &FsDiskSpace, &client).unwrap();
    assert_eq!(client.calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        second
            .get_model_download_task(&task.id)
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        fs::read(model_root.join("shared/weights.gguf")).unwrap(),
        b"weights"
    );
    second.remove_model_package("shared", true).unwrap();
    drop(first);
    drop(second);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn blocked_worker_pause_cancel_preserve_staging_and_never_contact_network() {
    for cancel in [false, true] {
        let root = std::env::temp_dir().join(format!(
            "epub-download-lock-{}-{cancel}",
            std::process::id()
        ));
        let store = Arc::new(AiStore::open(&root).unwrap());
        let model_root = root.join("models");
        fs::create_dir_all(&model_root).unwrap();
        store
            .set_model_library_path(model_root.to_str().unwrap())
            .unwrap();
        store
            .register_catalog_model_manifest(&catalog_manifest("held", b"weights"), "held")
            .unwrap();
        let task = store.create_or_get_model_download_task("held").unwrap();
        let staging = ensure_staging_for_task(&model_root, "held", &task.id).unwrap();
        fs::write(staging.join("weights.gguf.part"), b"wei").unwrap();
        let holder =
            super::super::model_locks::ModelLock::package(&model_root, "held", false).unwrap();
        let control = Arc::new(DownloadControl::default());
        let worker_control = Arc::clone(&control);
        let worker_store = Arc::clone(&store);
        let task_id = task.id.clone();
        let worker = thread::spawn(move || {
            let client = CountingClient {
                calls: std::sync::atomic::AtomicUsize::new(0),
            };
            let result = run_task_with_client(
                &worker_store,
                &task_id,
                worker_control,
                &FsDiskSpace,
                &client,
            );
            assert_eq!(client.calls.load(Ordering::Relaxed), 0);
            result
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while store
            .get_model_download_task(&task.id)
            .unwrap()
            .unwrap()
            .state
            == "queued"
            && std::time::Instant::now() < deadline
        {
            thread::sleep(std::time::Duration::from_millis(5));
        }
        if cancel {
            control.cancel.store(true, Ordering::Release);
        } else {
            control.pause.store(true, Ordering::Release);
        }
        let result = worker.join().unwrap();
        let latest = store.get_model_download_task(&task.id).unwrap().unwrap();
        assert_eq!(latest.state, if cancel { "failed" } else { "paused" });
        assert_eq!(fs::read(staging.join("weights.gguf.part")).unwrap(), b"wei");
        assert_eq!(result.is_err(), cancel);
        drop(holder);
        DownloadManager::default().cancel(&store, &task.id).unwrap();
        assert!(!staging.exists());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn cancelled_queued_task_is_claim_rejected_without_network() {
    let root =
        std::env::temp_dir().join(format!("epub-download-cancel-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let store = AiStore::open(&root).unwrap();
    let model_root = root.join("models");
    fs::create_dir_all(&model_root).unwrap();
    store
        .set_model_library_path(model_root.to_str().unwrap())
        .unwrap();
    let bytes = b"weights";
    let manifest = ModelPackageManifest {
        schema_version: 1,
        package_id: "cancel-queued".into(),
        model_id: "cancel-model".into(),
        version: "1".into(),
        display_name: "Cancel".into(),
        capabilities: vec!["generation".into()],
        format: "gguf".into(),
        files: vec![expected(bytes)],
        dimensions: None,
        max_input: None,
        recommended_batch: None,
        min_memory_bytes: None,
        recommended_memory_bytes: None,
        platform: None,
        arch: None,
        license: "Apache-2.0".into(),
        original_source: "test".into(),
        homepage: None,
        requires_acceptance: false,
        download_mirrors: vec![super::super::models::ModelDownloadMirror {
            url: "https://example.invalid/models".into(),
            kind: None,
        }],
        provider_kind: None,
    };
    store
        .register_catalog_model_manifest(&manifest, "cancel-queued")
        .unwrap();
    let task = store
        .create_or_get_model_download_task("cancel-queued")
        .unwrap();
    store
        .update_model_download_task(&task.id, "cancelled", 0, None, None, None, None, None)
        .unwrap();
    let client = CountingClient {
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    run_task_with_client(
        &store,
        &task.id,
        Arc::new(DownloadControl::default()),
        &FsDiskSpace,
        &client,
    )
    .unwrap();
    assert_eq!(client.calls.load(Ordering::Relaxed), 0);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn completed_directory_recovers_database_without_network() {
    let root =
        std::env::temp_dir().join(format!("epub-download-recover-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let store = AiStore::open(&root).unwrap();
    let model_root = root.join("models");
    let package_id = "recover-package";
    let data = b"weights";
    let manifest = catalog_manifest(package_id, data);
    let final_dir = model_root.join(package_id);
    fs::create_dir_all(&final_dir).unwrap();
    fs::write(final_dir.join("weights.gguf"), data).unwrap();
    fs::write(
        final_dir.join("model.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    store
        .set_model_library_path(model_root.to_str().unwrap())
        .unwrap();
    store
        .register_catalog_model_manifest(&manifest, package_id)
        .unwrap();
    let task = store.create_or_get_model_download_task(package_id).unwrap();
    let recovered = recover_committed_package(
        &store,
        &model_root,
        &store.get_model_package(package_id).unwrap().unwrap(),
        &manifest,
        &task.id,
    )
    .unwrap();
    assert!(matches!(recovered, Some(Ok(()))));
    assert_eq!(
        store.get_model_package(package_id).unwrap().unwrap().state,
        "installed"
    );
    assert_eq!(
        store
            .get_model_download_task(&task.id)
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn range_200_restarts_from_zero() {
    let root = std::env::temp_dir().join(format!("epub-download-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let part = root.join("x.part");
    fs::write(&part, b"old").unwrap();
    let data = b"fresh";
    let client = MockClient {
        responses: Mutex::new(vec![response(200, None, data)]),
    };
    let exp = expected(data);
    download_file(
        &client,
        "https://example.invalid/x",
        &part,
        &exp,
        3,
        &DownloadControl::default(),
        &mut no_progress,
    )
    .unwrap();
    assert_eq!(fs::read(&part).unwrap(), data);
    let _ = fs::remove_dir_all(root);
}
#[test]
fn range_206_requires_matching_start() {
    let root = std::env::temp_dir().join(format!("epub-download-range-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let part = root.join("x.part");
    fs::write(&part, b"abc").unwrap();
    let client = MockClient {
        responses: Mutex::new(vec![response(206, Some("bytes 2-4/5"), b"de")]),
    };
    let exp = expected(b"abcde");
    assert!(download_file(
        &client,
        "https://example.invalid/x",
        &part,
        &exp,
        3,
        &DownloadControl::default(),
        &mut no_progress,
    )
    .is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn initial_206_requires_zero_start_and_expected_total() {
    let root = std::env::temp_dir().join(format!(
        "epub-download-initial-range-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let part = root.join("x.part");
    let data = b"fresh";
    let client = MockClient {
        responses: Mutex::new(vec![response(206, Some("bytes 1-4/5"), data)]),
    };
    assert!(download_file(
        &client,
        "https://example.invalid/x",
        &part,
        &expected(data),
        0,
        &DownloadControl::default(),
        &mut no_progress,
    )
    .is_err());
    assert!(!part.exists());
    let _ = fs::remove_dir_all(root);
}
#[test]
fn source_url_cannot_escape_or_use_query() {
    assert!(join_source_url("https://example.invalid/models", "../x.gguf").is_err());
    assert!(join_source_url("https://example.invalid/models?x=1", "x.gguf").is_err());
    assert!(join_source_url("https://example.invalid/models", "x.gguf")
        .unwrap()
        .ends_with("/models/x.gguf"));
}

#[test]
fn content_range_requires_start_and_total() {
    assert_eq!(parse_content_range("bytes 0-4/5"), Some((0, 4, Some(5))));
    assert_eq!(parse_content_range("bytes 5-9/*"), Some((5, 9, None)));
    assert_eq!(parse_content_range("bytes 0-4/6"), Some((0, 4, Some(6))));
    assert!(parse_content_range("bytes 0-4").is_none());
}

#[test]
fn redirect_policy_allows_exactly_five_http_hops() {
    assert!(redirect_is_allowed(0, "https"));
    assert!(redirect_is_allowed(4, "http"));
    assert!(!redirect_is_allowed(5, "https"));
    assert!(!redirect_is_allowed(0, "file"));
}

#[test]
fn queue_empty_transition_is_atomic_with_running_flag() {
    let mut queue = QueueState {
        queue: VecDeque::new(),
        controls: HashMap::new(),
        running: true,
    };
    assert!(pop_or_stop(&mut queue).is_none());
    assert!(!queue.running);
    queue.queue.push_back("next".into());
    queue.running = true;
    assert_eq!(pop_or_stop(&mut queue).as_deref(), Some("next"));
    assert!(queue.running);
}

#[test]
fn real_disk_space_provider_returns_a_value_for_temp_dir() {
    let available = FsDiskSpace.available_bytes(&std::env::temp_dir()).unwrap();
    assert!(available.is_some());
}

#[cfg(unix)]
#[test]
fn staging_symlink_is_rejected() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("epub-download-link-{}", std::process::id()));
    let outside = root.with_extension("outside");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(&root).unwrap();
    symlink(&outside, root.join(".staging")).unwrap();
    assert!(ensure_staging_for_task(&root, "default", "task").is_err());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn component_guard_handles_missing_targets_and_rejects_escape() {
    let root =
        std::env::temp_dir().join(format!("epub-download-components-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    assert!(ensure_no_symlink_components(&root, &root.join("new/nested")).is_ok());
    assert!(ensure_no_symlink_components(&root, &root.join("..").join("outside")).is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn atomic_install_supports_multiple_files_without_overwrite() {
    let root =
        std::env::temp_dir().join(format!("epub-download-install-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let staging = ensure_staging_for_task(&root, "default", "task").unwrap();
    let first = b"weights";
    let second = b"tokenizer";
    fs::create_dir_all(staging.join("nested")).unwrap();
    fs::write(staging.join("weights.gguf.part"), first).unwrap();
    fs::write(staging.join("nested/tokenizer.json.part"), second).unwrap();
    let manifest = ModelPackageManifest {
        schema_version: 1,
        package_id: "default".into(),
        model_id: "model".into(),
        version: "1".into(),
        display_name: "Model".into(),
        capabilities: vec!["embedding".into()],
        format: "gguf".into(),
        files: vec![
            expected(first),
            ModelManifestFile {
                relative_path: "nested/tokenizer.json".into(),
                size_bytes: second.len() as u64,
                sha256: format!("{:x}", Sha256::digest(second)),
                purpose: "tokenizer".into(),
            },
        ],
        dimensions: None,
        max_input: None,
        recommended_batch: None,
        min_memory_bytes: None,
        recommended_memory_bytes: None,
        platform: None,
        arch: None,
        license: "Apache-2.0".into(),
        original_source: "test".into(),
        homepage: None,
        requires_acceptance: false,
        download_mirrors: vec![],
        provider_kind: None,
    };
    let package = ModelPackageRecord {
        package_id: "default".into(),
        model_id: "model".into(),
        version: "1".into(),
        display_name: "Model".into(),
        capabilities: vec!["embedding".into()],
        format: "gguf".into(),
        dimensions: None,
        max_input: None,
        recommended_batch: None,
        min_memory_bytes: None,
        recommended_memory_bytes: None,
        platform: None,
        arch: None,
        license: "Apache-2.0".into(),
        original_source: "test".into(),
        homepage: None,
        requires_acceptance: false,
        provider_kind: None,
        storage_kind: "managed".into(),
        package_dir: "installed".into(),
        linked_external_path: None,
        state: "uninstalled".into(),
        files: vec![],
        sources: vec![],
    };
    install_package(&root, &staging, &package, &manifest, None).unwrap();
    assert_eq!(
        fs::read(root.join("installed/weights.gguf")).unwrap(),
        first
    );
    assert_eq!(
        fs::read(root.join("installed/nested/tokenizer.json")).unwrap(),
        second
    );
    assert!(root.join("installed/model.json").is_file());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn oversized_response_is_rejected() {
    let root = std::env::temp_dir().join(format!("epub-download-over-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let part = root.join("x.part");
    let data = b"too-long";
    let exp = expected(b"short");
    let client = MockClient {
        responses: Mutex::new(vec![response(200, None, data)]),
    };
    assert!(download_file(
        &client,
        "https://example.invalid/x",
        &part,
        &exp,
        0,
        &DownloadControl::default(),
        &mut no_progress,
    )
    .is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn complete_local_file_can_finish_after_416() {
    let root = std::env::temp_dir().join(format!("epub-download-416-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let part = root.join("x.part");
    let data = b"complete";
    fs::write(&part, data).unwrap();
    let client = MockClient {
        responses: Mutex::new(vec![response(416, None, &[])]),
    };
    let exp = expected(data);
    download_file(
        &client,
        "https://example.invalid/x",
        &part,
        &exp,
        data.len() as u64,
        &DownloadControl::default(),
        &mut no_progress,
    )
    .unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn pause_signal_is_observed_before_writing() {
    let root = std::env::temp_dir().join(format!("epub-download-pause-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let part = root.join("x.part");
    let control = DownloadControl::default();
    control.pause.store(true, Ordering::Release);
    let data = b"data";
    let client = MockClient {
        responses: Mutex::new(vec![response(200, None, data)]),
    };
    let exp = expected(data);
    assert_eq!(
        download_file(
            &client,
            "https://example.invalid/x",
            &part,
            &exp,
            0,
            &control,
            &mut no_progress,
        )
        .unwrap_err(),
        "__paused__"
    );
    // Pausing must retain the staging file so a later resume can reuse it.
    // With no bytes received yet this is an empty `.part` file.
    assert!(part.exists());
    assert_eq!(fs::metadata(&part).unwrap().len(), 0);
    let _ = fs::remove_dir_all(root);
}
