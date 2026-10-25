    use super::*;

    #[test]
    fn source_error_wire_keeps_codes_separate_from_message_text() {
        let error = archive_fault_error(Fault::SourceChanged);
        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire["code"], "source-changed");
        assert!(wire["message"].as_str().unwrap().contains("源 EPUB"));
        let generic: LinkedLibraryError = "源 EPUB 在一条未知外部信息里发生了变化".into();
        assert_eq!(generic.code, "failed");
        assert_eq!(source_open_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).code, "failed");
    }

    #[test]
    fn source_error_missing_binding_is_proven_at_lookup() {
        let root = organization_temp_dir("source-error-unbound");
        let hash = "a".repeat(64);
        let records = vec![bk2_record(&hash, 77)];
        assert_eq!(prepare_source_read(&root, &records, &[], &hash).err().unwrap().code, "source-unbound");
        assert_eq!(prepare_source_read(&root, &[], &[], &hash).err().unwrap().code, "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn source_protection_open_distinguishes_missing_and_permission_failures() {
        use std::os::unix::fs::PermissionsExt;

        let root = organization_temp_dir("source-protection-open");
        let path = root.join("book.epub");
        fs::write(&path, b"source-protection").unwrap();
        let hash = hash_bytes(b"source-protection");
        let records = vec![bk2_record(&hash, 77)];
        let bindings = vec![sample_linked_binding(&hash, &path, snapshot(&path).unwrap())];
        assert!(prepare_source_read(&root, &records, &bindings, &hash).is_ok());

        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let denied = prepare_source_read(&root, &records, &bindings, &hash).err();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let denied = denied.expect("unreadable source must fail");
        assert_eq!(denied.code, "failed");
        assert!(denied.message.starts_with("无法打开源 EPUB："));
        assert!(!denied.message.contains("变化或丢失"));

        fs::remove_file(&path).unwrap();
        let missing = prepare_source_read(&root, &records, &bindings, &hash).err().unwrap();
        assert_eq!(missing.code, "source-missing");
        assert_eq!(missing.message, "源 EPUB 已变化或丢失；请重新导入或重新定位");
        assert_eq!(records[0].progress_pct, 77);
        fs::remove_dir_all(root).unwrap();
    }

    fn binding_json_value() -> serde_json::Value {
        let source = std::env::temp_dir().join("legacy-linked.epub");
        serde_json::json!({
            "contentHash": "a".repeat(64),
            "canonicalSourcePath": source.to_string_lossy(),
            "fileSize": 12,
            "sourceMtimeNs": 34,
            "coverZipPath": null,
            "coverMime": "image/jpeg",
            "lastVerifiedAtMs": 56,
        })
    }

    fn sample_managed_binding(hash: &str, snapshot: FileSnapshot) -> DeviceBinding {
        DeviceBinding {
            content_hash: hash.into(),
            storage_kind: StorageKind::Managed,
            canonical_source_path: None,
            file_size: snapshot.size,
            source_mtime_ns: snapshot.mtime_ns,
            cover_zip_path: None,
            cover_mime: "image/jpeg".into(),
            last_verified_at_ms: 0,
        }
    }

    fn sample_linked_binding(hash: &str, path: &Path, snapshot: FileSnapshot) -> DeviceBinding {
        DeviceBinding {
            content_hash: hash.into(),
            storage_kind: StorageKind::Linked,
            canonical_source_path: Some(path.to_string_lossy().into_owned()),
            file_size: snapshot.size,
            source_mtime_ns: snapshot.mtime_ns,
            cover_zip_path: None,
            cover_mime: String::new(),
            last_verified_at_ms: 0,
        }
    }

    fn write_test_cover_zip(path: &Path, cover: &[u8]) {
        use std::io::Write as _;

        let file = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("OPS/cover.jpg", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(cover).unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn bk1_legacy_binding_without_storage_kind_is_linked_and_keeps_path() {
        let expected_path = std::env::temp_dir().join("legacy-linked.epub");
        let value = binding_json_value();
        let binding: DeviceBinding = serde_json::from_value(value).unwrap();
        assert_eq!(binding.storage_kind, StorageKind::Linked);
        assert_eq!(
            binding.resolve_source(&std::env::temp_dir()).unwrap(),
            BindingSource::Linked(expected_path)
        );

        let serialized = serde_json::to_value(&binding).unwrap();
        assert_eq!(serialized["storageKind"], "linked");
        assert!(serialized.get("canonicalSourcePath").is_some());
    }

    #[test]
    fn bk1_explicit_null_or_unknown_storage_kind_is_rejected() {
        let mut explicit_null = binding_json_value();
        explicit_null["storageKind"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<DeviceBinding>(explicit_null).is_err());

        let mut unknown = binding_json_value();
        unknown["storageKind"] = serde_json::json!("cloud");
        assert!(serde_json::from_value::<DeviceBinding>(unknown).is_err());
    }

    #[test]
    fn bk1_binding_source_shape_is_validated_by_storage_kind() {
        let root = std::env::temp_dir();

        let mut linked_missing_path = binding_json_value();
        linked_missing_path["storageKind"] = serde_json::json!("linked");
        linked_missing_path
            .as_object_mut()
            .unwrap()
            .remove("canonicalSourcePath");
        let linked_missing_path: DeviceBinding =
            serde_json::from_value(linked_missing_path).unwrap();
        assert!(linked_missing_path.resolve_source(&root).is_err());

        let mut linked_relative_path = binding_json_value();
        linked_relative_path["storageKind"] = serde_json::json!("linked");
        linked_relative_path["canonicalSourcePath"] = serde_json::json!("books/relative.epub");
        let linked_relative_path: DeviceBinding =
            serde_json::from_value(linked_relative_path).unwrap();
        assert!(linked_relative_path.resolve_source(&root).is_err());

        let hash = "a".repeat(64);
        let mut managed_with_path = binding_json_value();
        managed_with_path["storageKind"] = serde_json::json!("managed");
        let managed_with_path: DeviceBinding = serde_json::from_value(managed_with_path).unwrap();
        assert!(managed_with_path.resolve_source(&root).is_err());

        let mut managed_without_path = binding_json_value();
        managed_without_path["storageKind"] = serde_json::json!("managed");
        managed_without_path
            .as_object_mut()
            .unwrap()
            .remove("canonicalSourcePath");
        let managed_without_path: DeviceBinding =
            serde_json::from_value(managed_without_path).unwrap();
        assert_eq!(
            managed_without_path.resolve_source(&root).unwrap(),
            BindingSource::Managed(root.join("books").join(format!("{hash}.epub")))
        );

        let mut managed_bad_hash = binding_json_value();
        managed_bad_hash["storageKind"] = serde_json::json!("managed");
        managed_bad_hash["contentHash"] = serde_json::json!("A".repeat(64));
        managed_bad_hash
            .as_object_mut()
            .unwrap()
            .remove("canonicalSourcePath");
        let managed_bad_hash: DeviceBinding = serde_json::from_value(managed_bad_hash).unwrap();
        assert!(managed_bad_hash.resolve_source(&root).is_err());
    }

    #[test]
    fn bk1_managed_binding_serializes_without_a_persisted_path_and_round_trips() {
        let root = std::env::temp_dir();
        let hash = "b".repeat(64);
        let binding = DeviceBinding {
            content_hash: hash.clone(),
            storage_kind: StorageKind::Managed,
            canonical_source_path: None,
            file_size: 1,
            source_mtime_ns: 2,
            cover_zip_path: None,
            cover_mime: "image/jpeg".into(),
            last_verified_at_ms: 3,
        };
        let serialized = serde_json::to_value(&binding).unwrap();
        assert_eq!(serialized["storageKind"], "managed");
        assert!(serialized.get("canonicalSourcePath").is_none());
        assert_eq!(
            binding.resolve_source(&root).unwrap(),
            BindingSource::Managed(root.join("books").join(format!("{hash}.epub")))
        );
        let round_trip: DeviceBinding = serde_json::from_value(serialized).unwrap();
        assert_eq!(round_trip, binding);
    }

    #[test]
    fn bk1_managed_verify_reads_only_the_derived_library_path() {
        let root = organization_temp_dir("managed-source");
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let hash = "c".repeat(64);
        let path = books.join(format!("{hash}.epub"));
        fs::write(&path, b"epub-bytes").unwrap();
        let snapshot = snapshot(&path).unwrap();
        let mut binding = sample_managed_binding(&hash, snapshot);
        let verification = verify_binding(&mut binding, &root).unwrap();
        assert!(verification.available);
        assert!(!verification.changed);
        assert_eq!(
            binding.resolve_source(&root).unwrap().path(),
            path.as_path()
        );
        let _ = fs::remove_dir_all(&root);
    }


    #[test]
    fn linked_library_hashes_are_lowercase_only() {
        assert!(valid_content_hash(&"a".repeat(64)));
        assert!(!valid_content_hash(&"A".repeat(64)));
        assert!(!valid_content_hash(&"g".repeat(64)));
    }

    #[test]
    fn portable_text_anchors_are_bounded_unicode_code_points() {
        assert!(valid_optional_anchor_text(Some(7), &Some("😀正文".into())));
        assert!(valid_optional_anchor_text(None, &None));
        assert!(!valid_optional_anchor_text(None, &Some("正文".into())));
        assert!(!valid_optional_anchor_text(
            Some(1),
            &Some("has space".into())
        ));
        assert!(!valid_optional_anchor_text(
            Some(1),
            &Some("😀".repeat(MAX_ANCHOR_SNIPPET_CODE_POINTS + 1)),
        ));
        assert!(!valid_optional_anchor_text(
            MAX_ANCHOR_TEXT_OFFSET.checked_add(1),
            &None
        ));
    }


    #[test]
    fn records_do_not_serialize_device_path() {
        let record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: "zh-CN".into(),
            file_name: "book.epub".into(),
            added_at_ms: 1,
            last_read_at_ms: 1,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("sourcePath"));
        assert!(!json.contains("canonicalSourcePath"));
    }

    #[test]
    fn media_anchor_roundtrips_through_record_dto() {
        let mut record = bk2_record(&"a".repeat(64), 0);
        record.media_anchor = Some(LinkedLibraryMediaAnchor {
            index: 1,
            tag: "img".to_string(),
            signature: "img|cover".to_string(),
            ratio: 0.25,
        });
        record.bookmarks[0].media_anchor = Some(LinkedLibraryMediaAnchor {
            index: 2,
            tag: "svg".to_string(),
            signature: "svg|figure".to_string(),
            ratio: 0.75,
        });
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("\"mediaAnchor\""));
        let restored: LinkedLibraryRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.media_anchor, record.media_anchor);
        assert_eq!(
            restored.bookmarks[0].media_anchor,
            record.bookmarks[0].media_anchor
        );
    }

    #[test]
    fn old_records_without_language_default_to_empty_string() {
        let json = format!(
            r#"{{"contentHash":"{}","title":"T","creator":"C","fileName":"book.epub","addedAtMs":1,"lastReadAtMs":1,"spineIndex":0,"page":0,"progressPct":0,"anchorIndex":null,"anchorRatio":null,"isNew":true}}"#,
            "a".repeat(64)
        );
        let record: LinkedLibraryRecord = serde_json::from_str(&json).unwrap();
        assert!(record.language.is_empty());
    }

    #[test]
    fn progress_update_clears_new_mark_and_preserves_position() {
        let mut record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: String::new(),
            file_name: "book.epub".into(),
            added_at_ms: 10,
            last_read_at_ms: 0,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        apply_progress_update(
            &mut record,
            20,
            2,
            3,
            101,
            Some(4),
            Some(0.5),
            Some(7),
            Some("正文".into()),
            None,
        );
        assert_eq!(record.last_read_at_ms, 20);
        assert_eq!(record.spine_index, 2);
        assert_eq!(record.page, 3);
        assert_eq!(record.progress_pct, 100);
        assert_eq!(record.anchor_index, Some(4));
        assert!(!record.is_new);
    }

    #[test]
    fn notes_validate_unicode_range_and_limits() {
        let valid = LinkedLibraryNote {
            id: "note-1".into(),
            spine_index: 2,
            chapter_path: "Text/chapter.xhtml".into(),
            start_text_offset: 10,
            end_text_offset: 14,
            start_text_snippet: "开始文字".into(),
            end_text_snippet: "结束文字".into(),
            selected_text: "开始 文字".into(),
            content: "值得回看".into(),
            created_at_ms: 100,
            updated_at_ms: 100,
        };
        assert!(valid_note(&valid));
        let mut invalid = valid.clone();
        invalid.end_text_offset = 13;
        assert!(!valid_note(&invalid));
        invalid = valid.clone();
        invalid.end_text_snippet = "有 空格".into();
        assert!(!valid_note(&invalid));
        invalid = valid;
        invalid.content = "x".repeat(MAX_NOTE_CONTENT_CODE_POINTS + 1);
        assert!(!valid_note(&invalid));
        invalid = LinkedLibraryNote {
            id: " \t".into(),
            spine_index: 2,
            chapter_path: "Text/chapter.xhtml".into(),
            start_text_offset: 10,
            end_text_offset: 14,
            start_text_snippet: "开始文字".into(),
            end_text_snippet: "结束文字".into(),
            selected_text: "开始 文字".into(),
            content: "值得回看".into(),
            created_at_ms: 100,
            updated_at_ms: 100,
        };
        assert!(!valid_note(&invalid));
        invalid.id = "note-1".into();
        invalid.chapter_path = " \n".into();
        assert!(!valid_note(&invalid));
        invalid.chapter_path = "Text/chapter.xhtml".into();
        invalid.content = " \n".into();
        assert!(!valid_note(&invalid));
    }

    #[test]
    fn portable_replace_rejects_duplicate_or_invalid_progress() {
        let mut record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: String::new(),
            file_name: "book.epub".into(),
            added_at_ms: 1,
            last_read_at_ms: 1,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        assert!(validate_portable_records(&[record.clone()]).is_ok());
        assert!(validate_portable_records(&[record.clone(), record.clone()]).is_err());
        record.progress_pct = 101;
        assert!(validate_portable_records(&[record]).is_err());
    }

    #[test]
    fn portable_records_reject_device_paths_and_invalid_ratios() {
        let mut record = LinkedLibraryRecord {
            content_hash: "a".repeat(64),
            title: "T".into(),
            creator: "C".into(),
            language: String::new(),
            file_name: "C:\\Books\\book.epub".into(),
            added_at_ms: 1,
            last_read_at_ms: 1,
            spine_index: 0,
            page: 0,
            progress_pct: 0,
            anchor_index: None,
            anchor_ratio: None,
            anchor_text_offset: None,
            anchor_text_snippet: None,
            media_anchor: None,
            bookmarks: vec![],
            notes: vec![],
            is_new: true,
        };
        assert!(validate_portable_records(&[record.clone()]).is_err());
        record.file_name = "book.epub".into();
        record.anchor_ratio = Some(1.5);
        assert!(validate_portable_records(&[record]).is_err());
    }

    #[test]
    fn thumbnail_cache_only_recognizes_valid_hash_files() {
        let hash = "a".repeat(64);
        assert_eq!(
            thumbnail_hash_from_file_name(&format!("{hash}.thumb")),
            Some(hash.as_str())
        );
        assert_eq!(thumbnail_hash_from_file_name(&format!("{hash}.tmp")), None);
        assert_eq!(thumbnail_hash_from_file_name("index.json"), None);
        assert_eq!(thumbnail_hash_from_file_name("AA.thumb"), None);
    }

    const TEST_DEVICE_ID: &str = "0a0a0a0a-0000-4000-8000-00000000000a";

    /// 每个用例自己的临时目录，避免和真实书库文件或并发用例互相影响。
    fn organization_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "epub-reader-organization-{label}-{}-{}",
            std::process::id(),
            TEMP_FILE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_organization(counter: u64, content_hash: &str, value: bool) -> OrganizationEnvelope {
        let mut state = library_organization::empty_organization();
        state.books.insert(
            content_hash.to_string(),
            library_organization::BookOrganization {
                favorite: Some(library_organization::Register {
                    value,
                    stamp: library_organization::Stamp {
                        counter: 1,
                        device_id: TEST_DEVICE_ID.into(),
                    },
                }),
                folder_id: None,
            },
        );
        OrganizationEnvelope {
            device_id: TEST_DEVICE_ID.into(),
            counter,
            state,
        }
    }

    #[test]
    fn organization_file_missing_reads_none_and_round_trips() {
        let dir = organization_temp_dir("round-trip");
        let path = dir.join("library-organization.json");
        assert!(load_organization_file(&path).unwrap().is_none());
        let envelope = sample_organization(4, &"a".repeat(64), true);
        save_organization_file(&path, &envelope).unwrap();
        assert_eq!(load_organization_file(&path).unwrap(), Some(envelope));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_or_invalid_organization_file_is_an_error_and_is_not_replaced() {
        let dir = organization_temp_dir("corrupt");
        let path = dir.join("library-organization.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(load_organization_file(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        // An unknown schema version is corrupt data, not an empty organization.
        let wrong_version = format!(
            r#"{{"deviceId":"{TEST_DEVICE_ID}","counter":0,"state":{{"schemaVersion":2,"folders":{{}},"books":{{}}}}}}"#
        );
        fs::write(&path, &wrong_version).unwrap();
        assert!(load_organization_file(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), wrong_version);
        // A zero clock in a register is rejected at the storage boundary.
        let bad_stamp = format!(
            r#"{{"deviceId":"{TEST_DEVICE_ID}","counter":0,"state":{{"schemaVersion":1,"folders":{{}},"books":{{"{}":{{"favorite":{{"value":true,"stamp":{{"counter":0,"deviceId":"{TEST_DEVICE_ID}"}}}}}}}}}}}}"#,
            "a".repeat(64)
        );
        fs::write(&path, &bad_stamp).unwrap();
        assert!(load_organization_file(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 缺失的字段和显式 `null` 不是同一种数据：坏文件必须报错并保持逐字节不变，
    /// 只有内层 `folderId.value:null`（明确移出到未归类）和字段省略才合法。
    #[test]
    fn organization_file_rejects_json_null_optional_objects_byte_for_byte() {
        const FOLDER_ID: &str = "00000000-0000-4000-8000-0000000000f0";
        let dir = organization_temp_dir("null-optional");
        let path = dir.join("library-organization.json");
        let hash = "a".repeat(64);
        let empty_state = serde_json::json!({
            "schemaVersion": 1,
            "folders": {},
            "books": {},
        });
        let book_slot = |book: serde_json::Value| {
            let mut envelope = serde_json::json!({
                "deviceId": TEST_DEVICE_ID,
                "counter": 9,
                "state": empty_state.clone(),
            });
            envelope["state"]["books"][hash.as_str()] = book;
            envelope
        };
        // A newer register with no value must not update the stored ownership.
        let missing_value = book_slot(
            serde_json::json!({"folderId": {"stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}}}),
        );
        let favorite_null = book_slot(serde_json::json!({"favorite": null}));
        let folder_id_null = book_slot(serde_json::json!({"folderId": null}));
        let deleted_null = serde_json::json!({
            "deviceId": TEST_DEVICE_ID,
            "counter": 1,
            "state": {
                "schemaVersion": 1,
                "folders": {
                    "00000000-0000-4000-8000-0000000000f0": {
                        "name": {"value": "科幻", "stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}},
                        "deleted": null,
                    }
                },
                "books": {},
            },
        });
        let cases = [
            missing_value.to_string(),
            favorite_null.to_string(),
            folder_id_null.to_string(),
            deleted_null.to_string(),
        ];
        for case in cases {
            fs::write(&path, &case).unwrap();
            assert!(load_organization_file(&path).is_err(), "应当拒绝：{case}");
            assert_eq!(fs::read_to_string(&path).unwrap(), case);
        }
        // Omitted optional objects and an explicit inner null stay valid.
        let mut valid = serde_json::json!({
            "deviceId": TEST_DEVICE_ID,
            "counter": 9,
            "state": empty_state.clone(),
        });
        valid["state"]["folders"][FOLDER_ID] = serde_json::json!({
            "name": {"value": "科幻", "stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}}
        });
        valid["state"]["books"][hash.as_str()] = serde_json::json!({
            "folderId": {"value": null, "stamp": {"counter": 1, "deviceId": TEST_DEVICE_ID}}
        });
        let valid = valid.to_string();
        fs::write(&path, &valid).unwrap();
        let loaded = load_organization_file(&path).unwrap().unwrap();
        assert_eq!(loaded.state.folders[FOLDER_ID].deleted, None);
        assert_eq!(loaded.state.books[&hash].favorite, None);
        assert_eq!(
            loaded.state.books[&hash].folder_id.as_ref().unwrap().value,
            None
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 首次调用创建身份并落盘，之后每次调用都复用同一个身份，不重新生成也不改写文件。
    #[test]
    fn organization_is_initialized_once_and_never_regenerated() {
        let dir = organization_temp_dir("init-once");
        let path = dir.join("library-organization.json");
        let first = load_or_init_organization_at(&path).unwrap();
        assert!(library_organization::valid_canonical_uuid(&first.device_id));
        assert_eq!(first.counter, 0);
        assert_eq!(first.state, library_organization::empty_organization());
        let written = fs::read_to_string(&path).unwrap();
        let second = load_or_init_organization_at(&path).unwrap();
        assert_eq!(second, first);
        assert_eq!(fs::read_to_string(&path).unwrap(), written);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn failed_organization_write_keeps_the_previous_file() {
        use std::os::unix::fs::PermissionsExt;

        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            if fs::metadata("/proc/self")
                .map(|meta| meta.uid())
                .unwrap_or(1)
                == 0
            {
                // Root ignores the read-only directory, so the failure cannot be provoked.
                return;
            }
        }
        let dir = organization_temp_dir("write-failure");
        let path = dir.join("library-organization.json");
        let hash = "a".repeat(64);
        let original = sample_organization(2, &hash, true);
        save_organization_file(&path, &original).unwrap();
        let mut permissions = fs::metadata(&dir).unwrap().permissions();
        let original_mode = permissions.mode();
        permissions.set_mode(0o555);
        fs::set_permissions(&dir, permissions.clone()).unwrap();
        let failed = save_organization_file(&path, &sample_organization(9, &hash, false));
        permissions.set_mode(original_mode);
        fs::set_permissions(&dir, permissions).unwrap();
        assert!(failed.is_err());
        assert_eq!(load_organization_file(&path).unwrap(), Some(original));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn organization_counter_continues_after_reload() {
        let dir = organization_temp_dir("reload");
        let path = dir.join("library-organization.json");
        let hash = "a".repeat(64);
        save_organization_file(&path, &sample_organization(0, &hash, true)).unwrap();
        let first = {
            let loaded = load_organization_file(&path).unwrap().unwrap();
            let updated = library_organization::apply_command(
                &loaded,
                &OrganizationCommand::SetFavorite {
                    content_hashes: vec![hash.clone()],
                    value: false,
                },
                &HashSet::from([hash.clone()]),
            )
            .unwrap();
            save_organization_file(&path, &updated).unwrap();
            updated
        };
        // A restart reloads the file and must continue the clock, not reset it.
        let second = {
            let reloaded = load_organization_file(&path).unwrap().unwrap();
            library_organization::apply_command(
                &reloaded,
                &OrganizationCommand::SetFavorite {
                    content_hashes: vec![hash.clone()],
                    value: true,
                },
                &HashSet::from([hash.clone()]),
            )
            .unwrap()
        };
        assert_eq!(second.counter, first.counter + 1);
        assert_eq!(second.device_id, TEST_DEVICE_ID);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn device_identity_is_a_fresh_canonical_uuid_v4() {
        let first = random_uuid_v4().unwrap();
        let second = random_uuid_v4().unwrap();
        assert!(library_organization::valid_canonical_uuid(&first));
        assert_eq!(first.as_bytes()[14], b'4');
        assert_ne!(first, second);
    }
    #[test]
    fn bk2_document_request_validation_rejects_invalid_whole_requests() {
        assert!(validate_document_request(
            "req-1",
            &[DocumentSelection {
                uri: "content://provider/book.epub".into(),
                file_name: Some("book.epub".into()),
            }],
        )
        .is_ok());

        let missing_id = validate_document_request(
            " ",
            &[DocumentSelection {
                uri: "content://provider/book.epub".into(),
                file_name: None,
            }],
        )
        .unwrap_err();
        assert_eq!(missing_id.code, "invalid_request");

        let empty = validate_document_request("req-1", &[]).unwrap_err();
        assert_eq!(empty.code, "invalid_request");

        let non_content = validate_document_request(
            "req-1",
            &[DocumentSelection {
                uri: "/sdcard/book.epub".into(),
                file_name: None,
            }],
        )
        .unwrap_err();
        assert_eq!(non_content.code, "invalid_request");

        let path_name = validate_document_request(
            "req-1",
            &[DocumentSelection {
                uri: "content://provider/book.epub".into(),
                file_name: Some("../book.epub".into()),
            }],
        )
        .unwrap_err();
        assert_eq!(path_name.code, "invalid_request");
    }

    #[cfg(unix)]
    #[test]
    fn bk2_streaming_reader_hashes_only_the_declared_range() {
        use std::os::unix::io::IntoRawFd;

        let root = organization_temp_dir("bk2-stream-range");
        let source = root.join("source.bin");
        fs::write(&source, b"0123456789").unwrap();
        let staging = root.join("staged-range.part");
        let file = File::open(&source).unwrap();
        let mut reader = RestrictedReader::from_raw_fd(file.into_raw_fd(), 3, 4).unwrap();

        let staged = stream_restricted_reader_to_staging(&mut reader, &staging, &|| false).unwrap();
        assert_eq!(staged.content_hash, hash_bytes(b"3456"));
        assert_eq!(fs::read(&staging).unwrap(), b"3456");
        let file_snapshot = snapshot(&staging).unwrap();
        assert_eq!(file_snapshot.size, 4);
        assert_eq!(file_snapshot.mtime_ns, snapshot(&staging).unwrap().mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn bk2_cancel_after_final_read_prevents_staging_success() {
        use std::os::unix::io::IntoRawFd;
        use std::sync::atomic::AtomicUsize;

        let root = organization_temp_dir("bk2-final-cancel");
        let source = root.join("one-byte.bin");
        fs::write(&source, b"x").unwrap();
        let staging = root.join("staged-cancel.part");
        let file = File::open(&source).unwrap();
        let mut reader = RestrictedReader::from_raw_fd(file.into_raw_fd(), 0, 1).unwrap();

        // `copy_limited_to` checks cancellation before the single read; the
        // import layer must check once more after a successful copy to catch a
        // cancel requested during the final read. Returning false only on the
        // first call models exactly that race.
        let calls = AtomicUsize::new(0);
        let error = stream_restricted_reader_to_staging(&mut reader, &staging, &|| {
            calls.fetch_add(1, Ordering::SeqCst) >= 4
        })
        .unwrap_err();
        match error {
            PrepareError::Cancelled { content_hash } => {
                assert_eq!(content_hash.as_deref(), Some(hash_bytes(b"x").as_str()));
            }
            other => panic!("unexpected prepare error: {other:?}"),
        }
        assert!(staging.exists());

        let _ = fs::remove_dir_all(&root);
    }

    fn bk2_prepared_document(
        root: &Path,
        content_hash: &str,
        input_index: usize,
        bytes: &[u8],
        title: &str,
    ) -> PreparedDocument {
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let staging_path = books.join(format!("{content_hash}.{input_index}.part"));
        fs::write(&staging_path, bytes).unwrap();
        PreparedDocument {
            input_index,
            content_hash: content_hash.to_string(),
            staging_path,
            file_name: "book.epub".to_string(),
            metadata: ImportedMetadata {
                title: title.to_string(),
                creator: "Author".to_string(),
                language: "zh-CN".to_string(),
                spine: vec!["Text/chapter.xhtml".to_string()],
                cover_zip_path: None,
                cover_mime: String::new(),
            },
        }
    }

    fn bk2_record(hash: &str, progress: u32) -> LinkedLibraryRecord {
        LinkedLibraryRecord {
            content_hash: hash.to_string(),
            title: "Latest title".to_string(),
            creator: "Latest author".to_string(),
            language: "zh".to_string(),
            file_name: "latest.epub".to_string(),
            added_at_ms: 10,
            last_read_at_ms: 20,
            spine_index: 2,
            page: 3,
            progress_pct: progress,
            anchor_index: Some(4),
            anchor_ratio: Some(0.5),
            anchor_text_offset: Some(7),
            anchor_text_snippet: Some("正文".to_string()),
            media_anchor: None,
            bookmarks: vec![LinkedLibraryBookmark {
                id: "bookmark-1".to_string(),
                spine_index: 2,
                page: 3,
                anchor_index: None,
                anchor_ratio: None,
                anchor_text_offset: None,
                anchor_text_snippet: None,
                media_anchor: None,
                text: "mark".to_string(),
                created_at_ms: 11,
            }],
            notes: vec![LinkedLibraryNote {
                id: "note-1".to_string(),
                spine_index: 2,
                chapter_path: "Text/chapter.xhtml".to_string(),
                start_text_offset: 10,
                end_text_offset: 11,
                start_text_snippet: "a".to_string(),
                end_text_snippet: "b".to_string(),
                selected_text: "a".to_string(),
                content: "note".to_string(),
                created_at_ms: 11,
                updated_at_ms: 11,
            }],
            is_new: false,
        }
    }

    #[test]
    fn c7_display_name_prefers_provider_without_decoding_uri_paths() {
        assert_eq!(
            import_display_name(Some("原書 %20 #?.epub"), Some("selected.epub")),
            "原書 %20 #?.epub"
        );
        assert_eq!(
            import_display_name(Some("../bad.epub"), Some("selected.epub")),
            "selected.epub"
        );
        assert_eq!(import_display_name(Some("\n"), None), "book.epub");
        assert_eq!(import_display_name(None, None), "book.epub");
    }

    #[test]
    fn c7_duplicate_import_repairs_only_placeholder_and_keeps_reading_data() {
        for old_name in ["book.epub", "original.epub"] {
            let root = organization_temp_dir("c7-duplicate-name");
            let hash = hash_bytes(b"source");
            let mut existing = bk2_record(&hash, 77);
            existing.file_name = old_name.into();
            let mut store = crate::portable_state::PortableStore::open_in_memory().unwrap();
            store.publish_linked_imports(vec![serde_json::to_value(&existing).unwrap()],
                Vec::new(), vec![hash.clone()], Vec::new()).unwrap();
            let before = store.snapshot().unwrap();
            let mut expected = existing.clone();
            if old_name == "book.epub" {
                expected.file_name = "原書.epub".into();
            }
            let mut records = vec![existing];
            let mut bindings = Vec::new();
            let mut document = bk2_prepared_document(&root, &hash, 0, b"source", "Different title");
            document.file_name = "原書.epub".into();
            let result = publish_prepared_documents(
                &root,
                &mut records,
                &mut bindings,
                &[PreparedItem::Ready(document)],
            )
            .unwrap();
            assert_eq!(result.statuses[&hash], "duplicate");
            assert_eq!(result.records_changed, old_name == "book.epub");
            assert_eq!(
                serde_json::to_value(&records[0]).unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            let unbound = store.publish_linked_imports(
                records.iter().map(|r| serde_json::to_value(r).unwrap()).collect(),
                Vec::new(), vec![hash.clone()], Vec::new()).unwrap();
            assert_eq!(unbound.books[&hash].metadata.value.file_name, old_name);
            let after = store.publish_linked_imports(
                records.iter().map(|r| serde_json::to_value(r).unwrap()).collect(),
                bindings.iter().map(|b| (b.content_hash.clone(), serde_json::to_string(b).unwrap())).collect(),
                vec![hash.clone()], Vec::new()).unwrap();
            assert_eq!(after.books[&hash].metadata.value.file_name, expected.file_name);
            assert_eq!(after.books[&hash].progress, before.books[&hash].progress);
            assert_eq!(after.books[&hash].bookmarks, before.books[&hash].bookmarks);
            assert_eq!(after.books[&hash].notes, before.books[&hash].notes);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn bk2_publish_duplicate_keeps_latest_record_and_replaces_managed_file() {
        let root = organization_temp_dir("bk2-publish-duplicate");
        let hash = "b".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, b"old-bytes").unwrap();
        let old_snapshot = snapshot(&target).unwrap();

        let mut records = vec![bk2_record(&hash, 77)];
        let mut bindings = vec![DeviceBinding {
            content_hash: hash.clone(),
            storage_kind: StorageKind::Managed,
            canonical_source_path: None,
            file_size: old_snapshot.size,
            source_mtime_ns: old_snapshot.mtime_ns,
            cover_zip_path: None,
            cover_mime: "image/jpeg".to_string(),
            last_verified_at_ms: 1,
        }];
        let document = bk2_prepared_document(&root, &hash, 0, b"new-bytes", "New title");

        let outcome = publish_prepared_documents(
            &root,
            &mut records,
            &mut bindings,
            &[PreparedItem::Ready(document)],
        )
        .unwrap();

        assert_eq!(
            outcome.statuses.get(&hash).map(String::as_str),
            Some("duplicate")
        );
        assert!(outcome.failures.is_empty());
        assert!(!outcome.records_changed);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].progress_pct, 77);
        assert_eq!(records[0].title, "Latest title");
        assert_eq!(records[0].bookmarks.len(), 1);
        assert_eq!(records[0].notes.len(), 1);
        assert_eq!(records[0].notes[0].content, "note");
        assert_eq!(fs::read(&target).unwrap(), b"new-bytes");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].storage_kind, StorageKind::Managed);
        assert!(bindings[0].canonical_source_path.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_publish_same_batch_hash_once_and_marks_duplicates() {
        let root = organization_temp_dir("bk2-publish-same-batch");
        let bytes = b"same bytes";
        let hash = hash_bytes(bytes);
        let mut records = Vec::new();
        let mut bindings = Vec::new();
        let prepared = vec![
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 0, bytes, "First")),
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, bytes, "Second")),
        ];
        let second_staging = match &prepared[1] {
            PreparedItem::Ready(document) => document.staging_path.clone(),
            _ => unreachable!(),
        };

        let outcome =
            publish_prepared_documents(&root, &mut records, &mut bindings, &prepared).unwrap();
        let result = build_committed_results(
            prepared,
            outcome,
            &records,
            &bindings,
            &ThumbnailIndex::default(),
            &root,
        );

        assert_eq!(result.results.len(), 2);
        assert_eq!(result.results[0].input_index, 0);
        assert_eq!(result.results[0].status, "saved");
        assert_eq!(
            result.results[0].content_hash.as_deref(),
            Some(hash.as_str())
        );
        assert!(result.results[0].record.is_some());
        assert_eq!(result.results[1].input_index, 1);
        assert_eq!(result.results[1].status, "duplicate");
        assert_eq!(
            result.results[1].content_hash.as_deref(),
            Some(hash.as_str())
        );
        assert!(result.results[1].record.is_some());

        assert_eq!(records.len(), 1);
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            fs::read(root.join("books").join(format!("{hash}.epub")))
                .unwrap()
                .as_slice(),
            bytes.as_slice()
        );
        // The duplicate input's staging is intentionally still present; the
        // task guard owns its cleanup in the real pipeline.
        assert!(second_staging.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_committed_results_existing_hash_returns_duplicate_for_each_input() {
        let root = organization_temp_dir("bk2-existing-hash-duplicates");
        let bytes = b"existing bytes";
        let hash = hash_bytes(bytes);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, bytes).unwrap();
        let target_snapshot = snapshot(&target).unwrap();

        let mut records = vec![bk2_record(&hash, 66)];
        let mut bindings = vec![sample_managed_binding(&hash, target_snapshot)];
        let prepared = vec![
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 0, bytes, "Existing A")),
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, bytes, "Existing B")),
        ];

        let outcome =
            publish_prepared_documents(&root, &mut records, &mut bindings, &prepared).unwrap();
        let result = build_committed_results(
            prepared,
            outcome,
            &records,
            &bindings,
            &ThumbnailIndex::default(),
            &root,
        );

        assert_eq!(result.results.len(), 2);
        assert_eq!(result.results[0].status, "duplicate");
        assert_eq!(result.results[1].status, "duplicate");
        assert!(result.results[0].record.is_some());
        assert!(result.results[1].record.is_some());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].progress_pct, 66);
        assert_eq!(bindings.len(), 1);
        assert_eq!(fs::read(&target).unwrap().as_slice(), bytes.as_slice());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_committed_results_same_hash_publish_failure_returns_failed_for_each_input() {
        let root = organization_temp_dir("bk2-same-hash-publish-failure");
        let bytes = b"failure bytes";
        let hash = hash_bytes(bytes);
        let mut records = Vec::new();
        let mut bindings = Vec::new();
        let prepared = vec![
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 0, bytes, "First")),
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, bytes, "Second")),
        ];
        let first_staging = match &prepared[0] {
            PreparedItem::Ready(document) => document.staging_path.clone(),
            _ => unreachable!(),
        };
        fs::remove_file(&first_staging).unwrap();

        let outcome =
            publish_prepared_documents(&root, &mut records, &mut bindings, &prepared).unwrap();
        let result = build_committed_results(
            prepared,
            outcome,
            &records,
            &bindings,
            &ThumbnailIndex::default(),
            &root,
        );

        assert_eq!(result.results.len(), 2);
        for item in &result.results {
            assert_eq!(item.status, "failed");
            assert_eq!(item.content_hash.as_deref(), Some(hash.as_str()));
            assert!(item.record.is_none());
            assert!(item
                .error
                .as_deref()
                .unwrap_or("")
                .contains("无法发布正式副本"));
        }
        assert!(records.is_empty());
        assert!(bindings.is_empty());
        assert!(!root.join("books").join(format!("{hash}.epub")).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_persist_import_indexes_reports_records_failure_without_rollback() {
        let root = organization_temp_dir("bk2-record-write-failure");
        let hash = "a".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, b"published book").unwrap();
        // Make the second atomic replace fail after bindings have been written.
        fs::create_dir_all(records_path_at(&root)).unwrap();

        let target_snapshot = snapshot(&target).unwrap();
        let outcome = PublishOutcome {
            statuses: HashMap::from([(hash.clone(), "saved".to_string())]),
            failures: HashMap::new(),
            bindings_changed: true,
            records_changed: true,
        };
        let records = vec![bk2_record(&hash, 0)];
        let bindings = vec![sample_managed_binding(&hash, target_snapshot)];

        let error = persist_import_indexes(&root, &outcome, &records, &bindings).unwrap_err();
        assert_eq!(error.code, "commit_failed");
        assert!(error.requires_reload);
        assert!(
            error.message.contains("保存书库记录失败"),
            "{}",
            error.message
        );

        assert!(target.exists());
        assert!(bindings_path_at(&root).is_file());
        let persisted_bindings: Vec<DeviceBinding> =
            serde_json::from_slice(&fs::read(bindings_path_at(&root)).unwrap()).unwrap();
        assert_eq!(persisted_bindings.len(), 1);
        assert_eq!(persisted_bindings[0].content_hash, hash);
        assert!(fs::metadata(records_path_at(&root)).unwrap().is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk2_publish_rename_failure_is_per_hash_and_other_input_continues() {
        let root = organization_temp_dir("bk2-publish-rename-failure");
        let good_hash = "d".repeat(64);
        let bad_hash = "e".repeat(64);
        let mut records = Vec::new();
        let mut bindings = Vec::new();
        let good = bk2_prepared_document(&root, &good_hash, 0, b"good", "Good");
        let mut bad = bk2_prepared_document(&root, &bad_hash, 1, b"bad", "Bad");
        fs::remove_file(&bad.staging_path).unwrap();

        let outcome = publish_prepared_documents(
            &root,
            &mut records,
            &mut bindings,
            &[PreparedItem::Ready(good), PreparedItem::Ready(bad)],
        )
        .unwrap();

        assert_eq!(
            outcome.statuses.get(&good_hash).map(String::as_str),
            Some("saved")
        );
        assert!(outcome.failures.contains_key(&bad_hash));
        assert_eq!(records.len(), 1);
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            fs::read(root.join("books").join(format!("{good_hash}.epub"))).unwrap(),
            b"good"
        );
        assert!(!root.join("books").join(format!("{bad_hash}.epub")).exists());

        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn bk2_no_commit_results_cover_failed_prepared_and_unprocessed_cancel() {
        let root = organization_temp_dir("bk2-no-commit");
        let hash = "f".repeat(64);
        let prepared = vec![
            PreparedItem::Failed {
                input_index: 0,
                content_hash: None,
                message: "bad".to_string(),
            },
            PreparedItem::Ready(bk2_prepared_document(&root, &hash, 1, b"bytes", "Title")),
            PreparedItem::Cancelled {
                input_index: 2,
                content_hash: None,
            },
        ];

        let result = build_no_commit_results(prepared);
        let statuses: Vec<&str> = result
            .results
            .iter()
            .map(|item| item.status.as_str())
            .collect();
        assert_eq!(statuses, vec!["failed", "cancelled", "cancelled"]);
        assert_eq!(result.results[0].error.as_deref(), Some("bad"));
        assert_eq!(
            result.results[1].content_hash.as_deref(),
            Some(hash.as_str())
        );
        assert!(result.results[1].record.is_none());
        assert!(result.results[2].content_hash.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_read_finalize_preserves_concurrent_progress_and_updates_binding() {
        let root = organization_temp_dir("bk3-read-finalize");
        let bytes = b"epub-bytes";
        let hash = hash_bytes(bytes);
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let actual_snapshot = snapshot(&path).unwrap();
        let mut bindings = vec![sample_linked_binding(
            &hash,
            &path,
            FileSnapshot {
                size: 1,
                mtime_ns: 1,
            },
        )];
        let mut records = vec![bk2_record(&hash, 77)];

        let pending = prepare_source_read(&root, &records, &bindings, &hash).unwrap();
        // This models a progress save that commits after the short lock is
        // released and before the read result is finalized.
        records[0].progress_pct = 88;
        records[0].last_read_at_ms = 123;
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        let changed = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(read.bytes, bytes.to_vec());
        assert_eq!(records[0].progress_pct, 88);
        assert_eq!(records[0].last_read_at_ms, 123);
        assert_eq!(bindings[0].file_size, actual_snapshot.size);
        assert_eq!(bindings[0].source_mtime_ns, actual_snapshot.mtime_ns);
        assert!(bindings[0].last_verified_at_ms > 0);

        // The next unchanged read sees the same signatures and must not write
        // or refresh the verification timestamp again.
        let verified_at = bindings[0].last_verified_at_ms;
        let changed_again = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(!changed_again);
        assert_eq!(bindings[0].last_verified_at_ms, verified_at);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_finalize_unchanged_signature_does_not_write_or_update_time() {
        let root = organization_temp_dir("bk3-finalize-unchanged");
        let bytes = b"epub-bytes";
        let hash = hash_bytes(bytes);
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let snapshot = snapshot(&path).unwrap();
        let records = vec![bk2_record(&hash, 1)];
        let mut bindings = vec![sample_linked_binding(&hash, &path, snapshot.clone())];
        let pending = prepare_source_read(&root, &records, &bindings, &hash).unwrap();
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        let changed = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(bindings[0].file_size, snapshot.size);
        assert_eq!(bindings[0].source_mtime_ns, snapshot.mtime_ns);
        assert_eq!(bindings[0].last_verified_at_ms, 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_stale_read_result_is_rejected_after_delete_change_or_relink() {
        let root = organization_temp_dir("bk3-read-stale");
        let bytes = b"epub-bytes";
        let hash = hash_bytes(bytes);
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let records = vec![bk2_record(&hash, 77)];
        let bindings = vec![sample_linked_binding(
            &hash,
            &path,
            snapshot(&path).unwrap(),
        )];
        let pending = prepare_source_read(&root, &records, &bindings, &hash).unwrap();
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        let mut after_delete = bindings.clone();
        assert!(finalize_source_read(
            &root,
            &[],
            &mut after_delete,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        fs::write(&path, b"changed-after-read").unwrap();
        let mut after_change = bindings.clone();
        assert!(finalize_source_read(
            &root,
            &records,
            &mut after_change,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        let other = root.join("relinked.epub");
        fs::write(&other, bytes).unwrap();
        let mut after_relink = bindings.clone();
        after_relink[0].canonical_source_path = Some(other.to_string_lossy().into_owned());
        assert!(finalize_source_read(
            &root,
            &records,
            &mut after_relink,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        fs::remove_file(&path).unwrap();
        let mut after_missing = bindings.clone();
        assert!(finalize_source_read(
            &root,
            &records,
            &mut after_missing,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_managed_same_hash_reimport_keeps_new_binding_stat() {
        use std::io::Write as _;

        let root = organization_temp_dir("bk3-managed-reimport");
        let bytes = b"managed-epub-bytes";
        let hash = hash_bytes(bytes);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        fs::write(&target, bytes).unwrap();
        let old_snapshot = snapshot(&target).unwrap();
        let records = vec![bk2_record(&hash, 42)];
        let old_bindings = vec![sample_managed_binding(&hash, old_snapshot.clone())];
        let pending = prepare_source_read(&root, &records, &old_bindings, &hash).unwrap();
        let read = read_source_bytes_and_hash(&pending.file, &hash).unwrap();

        // Same-hash reimport atomically replaces the managed file and publishes
        // a newer binding signature while the old fd read is still finishing.
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&target)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let new_snapshot = snapshot(&target).unwrap();
        assert_ne!(new_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let mut fresh_bindings = vec![sample_managed_binding(&hash, new_snapshot.clone())];
        let changed = finalize_source_read(
            &root,
            &records,
            &mut fresh_bindings,
            &pending.identity,
            &pending.old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(read.bytes, bytes.to_vec());
        assert_eq!(fresh_bindings[0].file_size, new_snapshot.size);
        assert_eq!(fresh_bindings[0].source_mtime_ns, new_snapshot.mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_managed_list_refresh_is_stat_only_and_leaves_binding_unchanged() {
        let root = organization_temp_dir("bk3-managed-list-stat");
        let hash = "c".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let target = books.join(format!("{hash}.epub"));
        let bytes = b"managed-bytes";
        fs::write(&target, bytes).unwrap();
        let old_snapshot = snapshot(&target).unwrap();
        let mut binding = sample_managed_binding(&hash, old_snapshot.clone());

        // The file has the same valid bytes but a newer stat signature.  The
        // old explicit-verify path would hash and rewrite the binding; list
        // refresh must neither hash nor rewrite it.
        let file = OpenOptions::new().write(true).open(&target).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let touched_snapshot = snapshot(&target).unwrap();
        assert_ne!(touched_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let verification = verify_binding_for_list_refresh(&mut binding, &root).unwrap();
        assert!(!verification.available);
        assert!(!verification.changed);
        assert_eq!(binding.file_size, old_snapshot.size);
        assert_eq!(binding.source_mtime_ns, old_snapshot.mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_read_rejects_hash_mismatch_on_opened_handle() {
        let root = organization_temp_dir("bk3-read-hash-mismatch");
        let bytes = b"epub-bytes";
        let path = root.join("book.epub");
        fs::write(&path, bytes).unwrap();
        let expected_hash = "a".repeat(64);
        let records = vec![bk2_record(&expected_hash, 77)];
        let bindings = vec![sample_linked_binding(
            &expected_hash,
            &path,
            snapshot(&path).unwrap(),
        )];
        let pending = prepare_source_read(&root, &records, &bindings, &expected_hash).unwrap();
        assert_eq!(read_source_bytes_and_hash(&pending.file, &expected_hash).err().unwrap().code, "source-changed");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_cover_reader_reads_exact_entry_and_enforces_limit() {
        let root = organization_temp_dir("bk3-cover-read");
        let archive_path = root.join("book.epub");
        write_test_cover_zip(&archive_path, b"cover-bytes");
        let (hash, snapshot) = hash_file(&archive_path).unwrap();

        let file = File::open(&archive_path).unwrap();
        let read =
            read_cover_from_opened_file(&file, "OPS/cover.jpg", MAX_COVER_BYTES, &hash, &snapshot)
                .unwrap();
        assert_eq!(read.bytes, b"cover-bytes".to_vec());

        let file = File::open(&archive_path).unwrap();
        let error =
            read_cover_from_opened_file(&file, "OPS/cover.jpg", 4, &hash, &snapshot).unwrap_err();
        assert_eq!(error.code, "failed");
        assert!(error.message.contains("超过允许大小"));

        let file = File::open(&archive_path).unwrap();
        assert!(read_cover_from_opened_file(
            &file,
            "OPS/missing.jpg",
            MAX_COVER_BYTES,
            &hash,
            &snapshot,
        )
        .is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_cover_signature_change_requires_same_handle_whole_book_hash() {
        let root = organization_temp_dir("bk3-cover-verify");
        let path = root.join("book.epub");
        write_test_cover_zip(&path, b"cover-a");
        let (old_hash, old_snapshot) = hash_file(&path).unwrap();

        // Same cover entry name, different whole book.  The stat changed, so
        // the cover slow path must hash this exact handle and reject before
        // any local ZIP success can update the binding.
        write_test_cover_zip(&path, b"cover-b-different");
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let replacement_snapshot = snapshot(&path).unwrap();
        assert_ne!(replacement_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let file = File::open(&path).unwrap();
        assert!(read_cover_from_opened_file(
            &file,
            "OPS/cover.jpg",
            MAX_COVER_BYTES,
            &old_hash,
            &old_snapshot,
        )
        .is_err());

        let mut binding = sample_linked_binding(&old_hash, &path, old_snapshot.clone());
        let verification = verify_binding_for_list_refresh(&mut binding, &root).unwrap();
        assert!(!verification.available);
        assert!(!verification.changed);
        assert_eq!(binding.file_size, old_snapshot.size);
        assert_eq!(binding.source_mtime_ns, old_snapshot.mtime_ns);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk3_cover_same_bytes_stat_change_verifies_once_and_updates_binding() {
        let root = organization_temp_dir("bk3-cover-same-bytes");
        let path = root.join("book.epub");
        write_test_cover_zip(&path, b"cover-a");
        let (hash, old_snapshot) = hash_file(&path).unwrap();

        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        drop(file);
        let touched_snapshot = snapshot(&path).unwrap();
        assert_ne!(touched_snapshot.mtime_ns, old_snapshot.mtime_ns);

        let file = File::open(&path).unwrap();
        let read = read_cover_from_opened_file(
            &file,
            "OPS/cover.jpg",
            MAX_COVER_BYTES,
            &hash,
            &old_snapshot,
        )
        .unwrap();
        assert_eq!(read.bytes, b"cover-a".to_vec());
        assert_eq!(read.read_snapshot, touched_snapshot);

        let records = vec![bk2_record(&hash, 1)];
        let mut bindings = vec![sample_linked_binding(&hash, &path, old_snapshot.clone())];
        let identity = SourceIdentity::from_binding(&bindings[0], &root).unwrap();
        let changed = finalize_source_read(
            &root,
            &records,
            &mut bindings,
            &identity,
            &old_snapshot,
            &read.read_snapshot,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(bindings[0].file_size, touched_snapshot.size);
        assert_eq!(bindings[0].source_mtime_ns, touched_snapshot.mtime_ns);
        assert!(bindings[0].last_verified_at_ms > 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_managed_delete_removes_file_then_indexes_and_missing_targets_are_noop() {
        let root = organization_temp_dir("bk4-managed-delete");
        let hash = "1".repeat(64);
        let missing_hash = "f".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let source = books.join(format!("{hash}.epub"));
        fs::write(&source, b"managed-bytes").unwrap();
        let source_snapshot = snapshot(&source).unwrap();
        save_records_at(&root, &[bk2_record(&hash, 5)]).unwrap();
        save_bindings_at(&root, &[sample_managed_binding(&hash, source_snapshot)]).unwrap();

        // The already-missing target is a no-op; the remaining record must
        // still be deleted instead of rejecting the whole batch.
        delete_records_at(&root, &[missing_hash.clone(), hash.clone()], |_| Ok(())).unwrap();
        assert!(!source.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());

        // All requested records are gone now. Retrying the command is a
        // successful no-op, not the old "书库中没有所选书籍" error.
        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(!source.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reveal_points_at_the_linked_original_or_the_library_copy_and_reports_missing_files() {
        let root = organization_temp_dir("reveal-target");
        let snapshot = FileSnapshot { size: 1, mtime_ns: 2 };
        let linked_hash = "3".repeat(64);
        let managed_hash = "4".repeat(64);
        let original = root.join("用户的书 01.epub");
        fs::write(&original, b"x").unwrap();
        let copy = managed_source_path(&root, &managed_hash).unwrap();
        fs::create_dir_all(copy.parent().unwrap()).unwrap();
        fs::write(&copy, b"x").unwrap();
        let bindings = vec![
            sample_linked_binding(&linked_hash, &original, snapshot.clone()),
            sample_managed_binding(&managed_hash, snapshot.clone()),
        ];

        assert_eq!(reveal_target(&root, &bindings, &linked_hash), RevealTarget::File(original.clone()));
        assert_eq!(reveal_target(&root, &bindings, &managed_hash), RevealTarget::File(copy.clone()));
        assert_eq!(reveal_target(&root, &bindings, &"5".repeat(64)), RevealTarget::Missing);

        fs::remove_file(&original).unwrap();
        fs::remove_file(&copy).unwrap();
        assert_eq!(reveal_target(&root, &bindings, &linked_hash), RevealTarget::Missing);
        assert_eq!(reveal_target(&root, &bindings, &managed_hash), RevealTarget::Missing);
    }

    #[test]
    fn bk4_managed_delete_treats_not_found_as_complete() {
        let root = organization_temp_dir("bk4-managed-not-found");
        let hash = "2".repeat(64);
        save_records_at(&root, &[bk2_record(&hash, 1)]).unwrap();
        save_bindings_at(
            &root,
            &[sample_managed_binding(
                &hash,
                FileSnapshot {
                    size: 12,
                    mtime_ns: 34,
                },
            )],
        )
        .unwrap();

        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(!managed_source_path(&root, &hash).unwrap().exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_linked_source_file_is_never_deleted() {
        let root = organization_temp_dir("bk4-linked-source");
        let hash = "3".repeat(64);
        let source = root.join("user-book.epub");
        fs::write(&source, b"linked-bytes").unwrap();
        let source_snapshot = snapshot(&source).unwrap();
        save_records_at(&root, &[bk2_record(&hash, 1)]).unwrap();
        save_bindings_at(
            &root,
            &[sample_linked_binding(&hash, &source, source_snapshot)],
        )
        .unwrap();

        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(source.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_record_without_binding_does_not_delete_bare_hash_file() {
        let root = organization_temp_dir("bk4-record-without-binding");
        let hash = "4".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let bare_hash_file = books.join(format!("{hash}.epub"));
        fs::write(&bare_hash_file, b"not-owned-without-binding").unwrap();
        save_records_at(&root, &[bk2_record(&hash, 1)]).unwrap();

        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();
        assert!(bare_hash_file.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_batch_file_failure_keeps_indexes_for_retry() {
        let root = organization_temp_dir("bk4-batch-file-failure");
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let source_a = books.join(format!("{hash_a}.epub"));
        fs::write(&source_a, b"managed-a").unwrap();
        let source_b = books.join(format!("{hash_b}.epub"));
        fs::create_dir_all(&source_b).unwrap();

        let snapshot_a = snapshot(&source_a).unwrap();
        save_records_at(&root, &[bk2_record(&hash_a, 1), bk2_record(&hash_b, 2)]).unwrap();
        save_bindings_at(
            &root,
            &[
                sample_managed_binding(&hash_a, snapshot_a),
                sample_managed_binding(
                    &hash_b,
                    FileSnapshot {
                        size: 7,
                        mtime_ns: 8,
                    },
                ),
            ],
        )
        .unwrap();

        let error =
            delete_records_at(&root, &[hash_a.clone(), hash_b.clone()], |_| Ok(())).unwrap_err();
        assert!(
            error.contains("无法删除托管书籍源文件"),
            "unexpected error: {error}"
        );
        assert!(!source_a.exists());
        assert!(source_b.exists());
        assert_eq!(load_records_at(&root).unwrap().len(), 2);
        assert_eq!(load_bindings_at(&root).unwrap().len(), 2);

        // Fix the second target and retry: the first missing file is now
        // NotFound (accepted), and the batch converges without stale indexes.
        fs::remove_dir(&source_b).unwrap();
        fs::write(&source_b, b"managed-b").unwrap();
        delete_records_at(&root, &[hash_a.clone(), hash_b.clone()], |_| Ok(())).unwrap();
        assert!(!source_a.exists());
        assert!(!source_b.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bk4_partial_index_commit_retry_removes_record_and_keeps_organization() {
        let root = organization_temp_dir("bk4-partial-index-retry");
        let hash = "5".repeat(64);
        let books = root.join("books");
        fs::create_dir_all(&books).unwrap();
        let source = books.join(format!("{hash}.epub"));
        fs::write(&source, b"managed-bytes").unwrap();
        let source_snapshot = snapshot(&source).unwrap();
        save_records_at(&root, &[bk2_record(&hash, 9)]).unwrap();
        save_bindings_at(&root, &[sample_managed_binding(&hash, source_snapshot)]).unwrap();

        let folder_id = "11111111-1111-4111-8111-111111111111";
        let mut organization = sample_organization(7, &hash, true);
        organization.state.folders.insert(
            folder_id.to_string(),
            library_organization::FolderState {
                name: library_organization::Register {
                    value: "收藏夹".to_string(),
                    stamp: library_organization::Stamp {
                        counter: 2,
                        device_id: TEST_DEVICE_ID.to_string(),
                    },
                },
                deleted: None,
            },
        );
        organization.state.books.get_mut(&hash).unwrap().folder_id =
            Some(library_organization::Register {
                value: Some(folder_id.to_string()),
                stamp: library_organization::Stamp {
                    counter: 3,
                    device_id: TEST_DEVICE_ID.to_string(),
                },
            });
        let organization_path = root.join("library-organization.json");
        save_organization_file(&organization_path, &organization).unwrap();
        let organization_before = fs::read(&organization_path).unwrap();

        let records_path = records_path_at(&root);
        let records_backup = root.join("library-records.json.bak");
        let error = delete_records_at(&root, &[hash.clone()], |_| {
            // The callback runs after records/bindings are loaded but before
            // the source file and index commits.  Make the records atomic
            // replacement fail exactly at the final commit step.
            fs::rename(&records_path, &records_backup)
                .map_err(|error| format!("无法备份测试 records：{error}"))?;
            fs::create_dir(&records_path)
                .map_err(|error| format!("无法创建测试 records 故障目录：{error}"))?;
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("原子替换"), "unexpected error: {error}");
        assert!(!source.exists());
        assert!(records_path.is_dir());
        let backup_records =
            load_json_or_default::<Vec<LinkedLibraryRecord>>(&records_backup, "测试记录备份")
                .unwrap();
        assert_eq!(backup_records.len(), 1);
        assert_eq!(backup_records[0].content_hash, hash);
        assert!(load_bindings_at(&root).unwrap().is_empty());
        assert_eq!(fs::read(&organization_path).unwrap(), organization_before);
        assert_eq!(
            load_organization_file(&organization_path).unwrap(),
            Some(organization.clone())
        );

        // Undo only the test fault injection, then run the same production
        // deletion path again.  The already-committed bindings are gone, so
        // the retry removes the remaining record without touching any file.
        fs::remove_dir(&records_path).unwrap();
        fs::rename(&records_backup, &records_path).unwrap();
        delete_records_at(&root, &[hash.clone()], |_| Ok(())).unwrap();

        assert!(!source.exists());
        assert!(load_records_at(&root).unwrap().is_empty());
        assert!(load_bindings_at(&root).unwrap().is_empty());
        assert_eq!(fs::read(&organization_path).unwrap(), organization_before);
        assert_eq!(
            load_organization_file(&organization_path).unwrap(),
            Some(organization)
        );
        let _ = fs::remove_dir_all(&root);
    }
