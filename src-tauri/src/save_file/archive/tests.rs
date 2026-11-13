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
        None::<&tauri::AppHandle>,
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
        .merge_validated_import(parsed.incoming.clone(), vec![(HASH.to_string(), "{}".into())], false)
        .unwrap();
    let second = store
        .merge_validated_import(parsed.incoming.clone(), vec![(HASH.to_string(), "{}".into())], false)
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
        None::<&tauri::AppHandle>,
        &archive_path,
        A,
        &state,
        &[ExportBookPlan {
            content_hash: content_hash.clone(),
            source: crate::linked_library::document_source::BookSource::Path(source),
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
fn source_archives_keep_original_suffix_bytes_and_version() {
    for extension in ["txt", "cbz", "zip", "fb2", "mobi", "azw3"] {
        let dir = TempDir::new(extension);
        let source = dir.path().join(format!("source.{extension}"));
        let bytes: &[u8] = if extension == "fb2" {
            br#"<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body><section><p>Original text</p></section></body></FictionBook>"#
        } else { b"original source bytes including any original encoding" };
        fs::write(&source, bytes).unwrap();
        let hash = crate::save_file::hex_digest(bytes);
        let mut state = test_state();
        let mut book = state.books.remove(HASH).unwrap();
        book.metadata.value.file_name = format!("source.{extension}");
        if extension == "fb2" {
            for version in &mut book.progress.versions {
                let crate::portable_state::Locator::Modern(locator) = &mut version.value.as_mut().unwrap().locator else { panic!("expected a modern fixture locator") };
                locator.chapter_path = "__reader__/fb2/c0.xhtml".into();
            }
        }
        state.books.insert(hash.clone(), book);
        state.schema_version = match extension {
            "fb2" => 5,
            "mobi" | "azw3" => 7,
            _ => 4,
        };
        let target = dir.path().join("source.epubsave");
        let mut reporter = ProgressReporter::new(channel(), "formats", None);
        let cancel = AtomicBool::new(false);
        write_export_archive(None::<&tauri::AppHandle>,&target,A,&state,&[ExportBookPlan {content_hash:hash,source:crate::linked_library::document_source::BookSource::Path(source),bytes:bytes.len() as u64}],"all",&[],&mut reporter,&cancel).unwrap();
        let parsed = validate_and_extract(&target,&dir.path().join("staging"),&mut reporter,&cancel).unwrap();
        assert_eq!(parsed.incoming,state);
        assert_eq!(parsed.attachments[0].staging_path.extension().unwrap(),extension);
        assert_eq!(fs::read(&parsed.attachments[0].staging_path).unwrap(),bytes);
        if extension == "fb2" {
            assert_eq!(crate::linked_library::inspect_epub(&parsed.attachments[0].staging_path).unwrap().spine, ["__reader__/fb2/c0.xhtml"]);
            state.schema_version = 4;
            assert!(validate_portable_state(&state).is_err());
        }
        if matches!(extension, "mobi" | "azw3") {
            state.schema_version = 6;
            assert!(validate_portable_state(&state).is_err());
        }
        state.schema_version = 3;
        assert!(validate_portable_state(&state).is_err());
    }
}

#[test]
fn highlight_archive_roundtrip_uses_state_six() {
    let dir = TempDir::new("highlight");
    let mut state = test_state();
    state.schema_version = 6;
    state.books.get_mut(HASH).unwrap().notes.insert(B.into(), serde_json::from_value(json!({
        "versions":[{"stamp":{"deviceId":A,"counter":4},"clock":{A:4},"updatedAtMs":1000,"value":{
            "chapterPath":"Text/chapter.xhtml","spineIndexHint":0,"textProfile":"visible-codepoints-no-whitespace-v1",
            "startTextOffset":0,"endTextOffset":2,"startTextSnippet":"正文","endTextSnippet":"正文",
            "selectedText":"正文","content":"","style":"highlight","color":"#aabbcc","createdAtMs":1000
        }}]
    })).unwrap());
    let path = dir.path().join("highlight.epubsave");
    let cancelled = AtomicBool::new(false);
    let mut reporter = ProgressReporter::new(channel(), "highlight", None);
    write_export_archive(None::<&tauri::AppHandle>, &path, A, &state, &[], "all", &[], &mut reporter, &cancelled).unwrap();
    let parsed = validate_and_extract(&path, &dir.path().join("staging"), &mut reporter, &cancelled).unwrap();
    assert_eq!(parsed.incoming, state);
}

#[test]
fn archive_export_observes_cancel_before_delivery() {
    let dir = TempDir::new("cancel");
    let archive_path = dir.path().join("cancelled.epubsave");
    let state = test_state();
    let cancelled = AtomicBool::new(true);
    let mut reporter = ProgressReporter::new(channel(), "test", None);
    let error = write_export_archive(
        None::<&tauri::AppHandle>,
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
fn archive_version_probe_rejects_future_and_old_combinations_early() {
    let dir = TempDir::new("version-probe");
    let invalid_state_bytes = b"not-json";
    for (label, container, schema, include_future_field, expected, unexpected) in [
        (
            "new-container",
            2_u32,
            3_u64,
            true,
            "需要较新版本",
            Some("不支持此存档格式"),
        ),
        (
            "new-schema",
            1_u32,
            9_u64,
            true,
            "需要较新版本",
            Some("不支持此存档格式"),
        ),
        (
            "old-container",
            0_u32,
            3_u64,
            false,
            "不支持此存档格式",
            Some("需要较新版本"),
        ),
        (
            "old-schema",
            1_u32,
            2_u64,
            false,
            "不支持此存档格式",
            Some("需要较新版本"),
        ),
    ] {
        let path = dir.path().join(format!("{label}.epubsave"));
        let mut manifest = json!({
            "format": SAVE_FORMAT,
            "containerVersion": container,
            "stateSchemaVersion": schema,
            "packageId": A,
            "createdAtMs": 1,
            "scope": { "kind": "all", "bookHashes": [] },
            "entries": [{
                "path": "state.json",
                "bytes": invalid_state_bytes.len() as u64,
                "sha256": hex_digest(invalid_state_bytes)
            }]
        });
        if include_future_field {
            // A future manifest field must not be decoded by SaveManifest
            // before the version selector rejects the package.
            manifest["futureTopLevelField"] = json!({ "nested": true });
        }
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        zip.start_file("state.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(invalid_state_bytes).unwrap();
        if include_future_field {
            // A future writer may add new ZIP entries; the version probe
            // must still win over the current ZIP allow-list.
            zip.start_file("future/data.bin", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"future").unwrap();
        }
        zip.finish().unwrap();

        let staging = dir.path().join(format!("{label}-staging"));
        let mut reporter = ProgressReporter::new(channel(), "test", None);
        let error =
            validate_and_extract(&path, &staging, &mut reporter, &AtomicBool::new(false))
                .unwrap_err();
        assert_eq!(error.code, "invalid-data", "{label}");
        assert!(error.message.contains(expected), "{label}: {error}");
        if let Some(unexpected) = unexpected {
            assert!(!error.message.contains(unexpected), "{label}: {error}");
        }
        assert!(
            !staging.exists(),
            "{label} rejected before state bytes were extracted"
        );
    }
}

#[test]
fn select_export_state_keeps_folder_relationships_without_a_second_wire() {
    let mut state = test_state();
    let parent = "11111111-0000-4000-8000-000000000000";
    let referenced = "11111111-0000-4000-8000-000000000001";
    let unrelated = "22222222-0000-4000-8000-000000000002";
    state.organization = serde_json::from_value(json!({
        "schemaVersion": 2,
        "folders": {
            referenced: {
                "name": {
                    "value": "已引用夹",
                    "stamp": { "deviceId": A, "counter": 1 }
                },
                "parentId": {
                    "value": parent,
                    "stamp": { "deviceId": A, "counter": 1 }
                }
            },
            parent: {
                "name": {
                    "value": "必要祖先",
                    "stamp": { "deviceId": A, "counter": 1 }
                },
                "parentId": {
                    "value": null,
                    "stamp": { "deviceId": A, "counter": 1 }
                }
            },
            unrelated: {
                "name": {
                    "value": "空夹",
                    "stamp": { "deviceId": A, "counter": 2 }
                }
            }
        },
        "books": {
            HASH: {
                "folderId": {
                    "value": referenced,
                    "stamp": { "deviceId": A, "counter": 3 }
                }
            }
        }
    }))
    .unwrap();

    let (all, all_hashes) = select_export_state(&state, &SaveExportScope::All).unwrap();
    assert_eq!(all_hashes, vec![HASH.to_string()]);
    assert_eq!(all.organization.folders.len(), 3);
    assert!(all.organization.folders.contains_key(parent));
    assert!(all.organization.folders.contains_key(referenced));
    assert!(all.organization.folders.contains_key(unrelated));
    assert_eq!(
        all.organization.books[HASH]
            .folder_id
            .as_ref()
            .and_then(|register| register.value.as_deref()),
        Some(referenced)
    );

    let (selected, selected_hashes) = select_export_state(
        &state,
        &SaveExportScope::Selected {
            book_hashes: vec![HASH.to_string()],
        },
    )
    .unwrap();
    assert_eq!(selected_hashes, vec![HASH.to_string()]);
    assert_eq!(selected.books.len(), 1);
    assert_eq!(selected.organization.books.len(), 1);
    assert_eq!(selected.organization.folders.len(), 2);
    assert!(selected.organization.folders.contains_key(parent));
    assert!(selected.organization.folders.contains_key(referenced));
    assert!(!selected.organization.folders.contains_key(unrelated));
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
fn metadata_limits_are_64mib_for_state_and_16mib_for_manifest() {
    let over_old_limit = "x".repeat(17 * 1024 * 1024);
    let value = json!({ "payload": over_old_limit });
    let state_bytes = serialize_json_bounded(&value, STATE_JSON_LIMIT, "state.json").unwrap();
    assert!(state_bytes.len() as u64 > MANIFEST_JSON_LIMIT);

    let manifest_error =
        serialize_json_bounded(&value, MANIFEST_JSON_LIMIT, "manifest.json").unwrap_err();
    assert_eq!(manifest_error.code, "metadata-too-large");

    let over_state_limit = json!({ "payload": "x".repeat(65 * 1024 * 1024) });
    let state_error =
        serialize_json_bounded(&over_state_limit, STATE_JSON_LIMIT, "state.json").unwrap_err();
    assert_eq!(state_error.code, "metadata-too-large");
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
