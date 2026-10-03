//! Preparation-only portable save foundation (`CP-N`).
//!
//! No command is registered and no startup path opens this module yet.  The
//! module contains the frozen v3 DTO/parser, the Rust causal merge, the
//! trusted local read-basis surface, the SQLite repository and the one-shot
//! migration reader for the legacy JSON files.

#![allow(dead_code)]
#![allow(unused_imports)]

mod dto;
mod error;
mod legacy;
mod merge;
mod repository;

pub use dto::{
    code_point_count, normalized_code_point_count, parse_portable_state_json,
    parse_portable_state_value, safe_counter, safe_time, valid_anchor_snippet,
    valid_canonical_uuid, valid_chapter_path, valid_content_hash, validate_annotation,
    validate_book_metadata, validate_bookmark, validate_bookmark_version, validate_clock,
    validate_locator, validate_note, validate_note_version, validate_portable_book,
    validate_portable_state, validate_preferences, validate_progress, validate_progress_version,
    validate_stamp, validate_version_shape, Annotation, BookMetadata, BookmarkValue, LegacyLocator,
    LegacyMediaAnchor, Locator, LocatorTarget, MediaTag, ModernLocator, NoteValue, PortableBook,
    PortablePreferences, PortableStateV3, Progress, ProgressState, ProgressValue, Register, Stamp,
    Theme, Version, MAX_ANCHOR_SNIPPET_CODE_POINTS, MAX_NOTE_CONTENT_CODE_POINTS,
    MAX_NOTE_SELECTED_CODE_POINTS, MAX_SAFE_COUNTER, TEXT_PROFILE,
};
pub use error::{PortableError, PortableResult};
pub use merge::{
    capture_read_basis, compare_stamps, dominates, join_clocks, maximum_received_counter,
    maximum_received_counter_from_state, merge_annotation, merge_books, merge_portable_states,
    merge_progress_states, merge_register, merge_versions, next_local_counter,
    prepare_observed_write, same_event_frontier, write_observed, AdoptSelection, BasisSelection,
    EntityRef, PreparedWrite, ReadBasis, WriteIntent,
};
pub use repository::{
    AnnotationProjection, AnnotationWriteOutcome, DeleteOutcome, DeleteStatus, MigrationOutcome,
    PortableStore, ProgressProjection, ReleaseTarget, ShelfBookProjection, ShelfProjection,
    WriteOutcome, WriteStatus,
};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const C: &str = "00000000-0000-4000-8000-000000000003";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const OLD_BOOKMARK_ID: &str = "bm_legacy_1";
    const OLD_NOTE_ID: &str = "note_legacy_1";
    const NEW_ID: &str = "00000000-0000-4000-8000-0000000000aa";

    static TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "epub-reader-portable-{label}-{}-{nonce}",
                std::process::id()
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

    fn test_stamp(device_id: &str, counter: u64) -> Stamp {
        Stamp {
            device_id: device_id.to_string(),
            counter,
        }
    }

    fn minimal_organization_json() -> Value {
        json!({
            "schemaVersion": 1,
            "folders": {},
            "books": {}
        })
    }

    fn legacy_note_json() -> Value {
        json!({
            "id": OLD_NOTE_ID,
            "spineIndex": 1,
            "chapterPath": "Text/chapter.xhtml",
            "startTextOffset": 0,
            "endTextOffset": 5,
            "startTextSnippet": "Hello",
            "endTextSnippet": "world",
            "selectedText": "Hello",
            "content": "旧笔记",
            "createdAtMs": 9000,
            "updatedAtMs": 1000
        })
    }

    fn legacy_bookmark_json() -> Value {
        json!({
            "id": OLD_BOOKMARK_ID,
            "spineIndex": 1,
            "page": 2,
            "anchorIndex": 1,
            "anchorRatio": 0.5,
            "anchorTextOffset": 3,
            "anchorTextSnippet": "abc",
            "text": "旧书签",
            "createdAtMs": 8000
        })
    }

    fn legacy_record_json() -> Value {
        json!({
            "contentHash": HASH,
            "title": "旧书",
            "creator": "旧作者",
            "language": "zh",
            "fileName": "old.epub",
            "addedAtMs": 1000,
            "lastReadAtMs": 2000,
            "spineIndex": 1,
            "page": 2,
            "progressPct": 10,
            "anchorIndex": 1,
            "anchorRatio": 0.5,
            "anchorTextOffset": 3,
            "anchorTextSnippet": "abc",
            "mediaAnchor": null,
            "bookmarks": [legacy_bookmark_json()],
            "notes": [legacy_note_json()],
            "isNew": false
        })
    }

    fn state_json_with_one_book() -> Value {
        json!({
            "schemaVersion": 3,
            "books": {
                HASH: {
                    "metadata": {
                        "value": {
                            "title": "书",
                            "creator": "作者",
                            "language": "zh",
                            "fileName": "book.epub",
                            "addedAtMs": 1000
                        },
                        "stamp": { "deviceId": A, "counter": 1 }
                    },
                    "progress": {
                        "versions": [{
                            "stamp": { "deviceId": A, "counter": 2 },
                            "clock": { A: 2 },
                            "value": {
                                "locator": {
                                    "locatorVersion": 1,
                                    "chapterPath": "Text/chapter.xhtml",
                                    "spineIndexHint": 1,
                                    "target": {
                                        "kind": "text",
                                        "textProfile": "visible-codepoints-no-whitespace-v1",
                                        "offset": 3,
                                        "snippet": "abc"
                                    }
                                },
                                "progressPctHint": 10
                            },
                            "updatedAtMs": 2000
                        }]
                    },
                    "bookmarks": {},
                    "notes": {}
                }
            },
            "organization": minimal_organization_json()
        })
    }

    fn legacy_repository_fixture(root: &Path) {
        fs::write(
            root.join("library-records.json"),
            serde_json::to_string(&json!([legacy_record_json()])).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("library-organization.json"),
            serde_json::to_string(&json!({
                "deviceId": C,
                "counter": 7,
                "state": minimal_organization_json()
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("device-bindings.json"),
            serde_json::to_string(&json!([{
                "contentHash": HASH,
                "storageKind": "linked",
                "canonicalSourcePath": "/tmp/old-source/book.epub",
                "fileSize": 123,
                "sourceMtimeNs": 456,
                "coverZipPath": null,
                "coverMime": "image/jpeg",
                "lastVerifiedAtMs": 789
            }]))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn dto_accepts_minimal_state_and_rejects_unknown_or_invalid_fields() {
        let valid: Value = json!({
            "schemaVersion": 3,
            "books": {},
            "organization": minimal_organization_json()
        });
        let state: PortableStateV3 = serde_json::from_value(valid.clone()).unwrap();
        validate_portable_state(&state).unwrap();

        let mut explicit_null_language = state_json_with_one_book();
        explicit_null_language["books"][HASH]["metadata"]["value"]["language"] = json!(null);
        assert!(serde_json::from_value::<PortableStateV3>(explicit_null_language).is_err());

        let mut unknown = state_json_with_one_book();
        unknown["books"][HASH]["metadata"]["value"]["sourcePath"] = json!("/secret");
        assert!(serde_json::from_value::<PortableStateV3>(unknown).is_err());

        let mut bad_locator = state_json_with_one_book();
        bad_locator["books"][HASH]["progress"]["versions"][0]["value"]["locator"]
            ["locatorVersion"] = json!(9);
        assert!(serde_json::from_value::<PortableStateV3>(bad_locator).is_err());

        let mut bad_profile = state_json_with_one_book();
        bad_profile["books"][HASH]["progress"]["versions"][0]["value"]["locator"]["target"]
            ["textProfile"] = json!("other-profile");
        assert!(serde_json::from_value::<PortableStateV3>(bad_profile).is_err());
    }

    #[test]
    fn dto_allows_legacy_wall_clock_rollback_in_note_versions() {
        let mut value = state_json_with_one_book();
        value["books"][HASH]["notes"] = json!({
            "note_legacy_1": {
                "versions": [{
                    "stamp": { "deviceId": A, "counter": 3 },
                    "clock": { A: 3 },
                    "updatedAtMs": 1000,
                    "value": {
                        "chapterPath": "Text/chapter.xhtml",
                        "spineIndexHint": 1,
                        "textProfile": "visible-codepoints-no-whitespace-v1",
                        "startTextOffset": 0,
                        "endTextOffset": 5,
                        "startTextSnippet": "Hello",
                        "endTextSnippet": "world",
                        "selectedText": "Hello",
                        "content": "旧笔记",
                        "createdAtMs": 9000
                    }
                }]
            }
        });
        let state: PortableStateV3 = serde_json::from_value(value).unwrap();
        validate_portable_state(&state).unwrap();
    }

    #[test]
    fn causal_merge_and_trusted_basis_match_the_frozen_core() {
        let initial =
            write_observed(&[], &[], test_stamp(A, 1), json!({ "offset": 100 }), 3000).unwrap();
        let left = write_observed(
            &initial,
            &initial,
            test_stamp(A, 2),
            json!({ "offset": 200 }),
            4000,
        )
        .unwrap();
        let right = write_observed(
            &initial,
            &initial,
            test_stamp(B, 2),
            json!({ "offset": 300 }),
            2000,
        )
        .unwrap();

        let next = write_observed(
            &left,
            &left,
            test_stamp(A, 3),
            json!({ "offset": 20 }),
            1000,
        )
        .unwrap();
        assert_eq!(merge_versions(&[&left, &next]).unwrap(), next);

        let branches = merge_versions(&[&left, &right]).unwrap();
        assert_eq!(branches.len(), 2);
        assert_eq!(merge_versions(&[&right, &left]).unwrap(), branches);

        let current = branches.clone();
        let chosen = capture_read_basis(
            EntityRef::Progress {
                book_hash: HASH.to_string(),
            },
            &left,
            2,
            AdoptSelection::Chosen {
                stamp: left[0].stamp.clone(),
            },
        )
        .unwrap();
        let prepared = prepare_observed_write(
            EntityRef::Progress {
                book_hash: HASH.to_string(),
            },
            &current,
            2,
            &chosen,
            WriteIntent::Auto,
            test_stamp(A, 3),
            json!({ "offset": 220 }),
            1000,
        )
        .unwrap();
        match prepared {
            PreparedWrite::Write {
                versions,
                next_basis,
            } => {
                assert_eq!(versions.len(), 2);
                assert_eq!(next_basis.observed.len(), 1);
                assert!(versions
                    .iter()
                    .any(|version| version.stamp == test_stamp(B, 2)));
            }
            PreparedWrite::Unchanged => panic!("a real movement must write"),
        }

        let shown = capture_read_basis(
            EntityRef::Progress {
                book_hash: HASH.to_string(),
            },
            &branches,
            2,
            AdoptSelection::ShownAll,
        )
        .unwrap();
        let advanced = write_observed(
            &right,
            &right,
            test_stamp(B, 3),
            json!({ "offset": 400 }),
            5000,
        )
        .unwrap();
        let prepared = prepare_observed_write(
            EntityRef::Progress {
                book_hash: HASH.to_string(),
            },
            &merge_versions(&[&left, &advanced]).unwrap(),
            2,
            &shown,
            WriteIntent::Resolve,
            test_stamp(A, 4),
            json!({ "offset": 200 }),
            5000,
        );
        assert!(prepared.is_err());
        assert_eq!(prepared.unwrap_err().code, "stale-choice");
    }

    #[test]
    fn tombstone_survives_stale_import_and_stale_raw_clock_bounds_allocation() {
        let initial =
            write_observed(&[], &[], test_stamp(A, 1), json!({ "text": "note" }), 1000).unwrap();
        let edited = write_observed(
            &[],
            &[],
            test_stamp(B, 80),
            json!({ "text": "edited" }),
            1000,
        )
        .unwrap();
        let deleted = merge_annotation(
            &Annotation {
                versions: Vec::new(),
                deleted: Some(test_stamp(A, 3)),
            },
            &Annotation {
                versions: edited.clone(),
                deleted: None,
            },
        )
        .unwrap();
        assert_eq!(deleted.versions.len(), 0);
        assert!(merge_annotation(
            &deleted,
            &Annotation {
                versions: initial,
                deleted: None,
            }
        )
        .unwrap()
        .versions
        .is_empty());
        assert_eq!(
            maximum_received_counter(&edited, &[test_stamp(A, 90)], &[test_stamp(B, 7)]).unwrap(),
            90
        );
        assert_eq!(next_local_counter(4, 90).unwrap(), 91);
    }

    #[test]
    fn repository_migration_reads_old_sample_then_reopens_with_same_identity() {
        let root = TempDir::new("migration");
        legacy_repository_fixture(root.path());
        let database = root.path().join("library.sqlite3");

        let mut store = PortableStore::open(&database).unwrap();
        assert_eq!(
            store.migrate_legacy(root.path()).unwrap(),
            MigrationOutcome::Migrated {
                books: 1,
                annotations: 2
            }
        );
        let installation_id = store.installation_id().unwrap().unwrap();
        assert_eq!(installation_id, C);

        let binding = store.binding_raw(HASH).unwrap().unwrap();
        assert!(binding.contains("/tmp/old-source/book.epub"));
        assert!(store
            .local_visible_hashes()
            .unwrap()
            .contains(&HASH.to_string()));

        let state = store.snapshot().unwrap();
        let book = state.books.get(HASH).unwrap();
        assert_eq!(book.metadata.value.title, "旧书");
        assert_eq!(book.metadata.value.added_at_ms, 1000);
        assert!(book.bookmarks.contains_key(OLD_BOOKMARK_ID));
        assert!(book.notes.contains_key(OLD_NOTE_ID));
        let note = &book.notes[OLD_NOTE_ID].versions[0].value;
        assert_eq!(note.created_at_ms, 9000);
        assert_eq!(book.notes[OLD_NOTE_ID].versions[0].updated_at_ms, 1000);
        assert!(matches!(
            book.progress.versions[0].value,
            Some(Progress {
                locator: Locator::Legacy(_),
                ..
            })
        ));
        drop(store);

        let mut reopened = PortableStore::open(&database).unwrap();
        assert_eq!(reopened.installation_id().unwrap().unwrap(), C);
        assert_eq!(
            reopened.migrate_legacy(root.path()).unwrap(),
            MigrationOutcome::AlreadyMigrated
        );
    }

    #[test]
    fn repository_merge_is_idempotent_and_collision_rolls_back() {
        let mut store = PortableStore::open_in_memory().unwrap();
        let incoming: PortableStateV3 = serde_json::from_value(state_json_with_one_book()).unwrap();
        let merged = store.merge_validated_state(incoming.clone()).unwrap();
        assert_eq!(merged.books.len(), 1);
        let once = store.snapshot().unwrap();
        store.merge_validated_state(incoming.clone()).unwrap();
        assert_eq!(store.snapshot().unwrap(), once);

        let mut collision = incoming;
        let progress = collision
            .books
            .get_mut(HASH)
            .unwrap()
            .progress
            .versions
            .first_mut()
            .unwrap();
        progress.value = Some(Progress {
            locator: progress.value.as_ref().unwrap().locator.clone(),
            progress_pct_hint: 99,
        });
        let before = store.snapshot().unwrap();
        let error = store.merge_validated_state(collision).unwrap_err();
        assert_eq!(error.code, "invalid-data");
        assert_eq!(store.snapshot().unwrap(), before);
    }

    #[test]
    fn repository_progress_basis_write_and_annotation_lifecycle_work() {
        let mut store = PortableStore::open_in_memory().unwrap();
        let incoming: PortableStateV3 = serde_json::from_value(state_json_with_one_book()).unwrap();
        store.merge_validated_state(incoming).unwrap();

        let (read_id, book) = store.read(HASH).unwrap();
        assert!(book.is_some());
        let entity = EntityRef::Progress {
            book_hash: HASH.to_string(),
        };
        let basis_id = store
            .adopt(
                &read_id,
                entity.clone(),
                AdoptSelection::Chosen {
                    stamp: test_stamp(A, 2),
                },
            )
            .unwrap();
        let written = store
            .write_progress(
                &basis_id,
                WriteIntent::Auto,
                Some(Progress {
                    locator: Locator::Modern(ModernLocator {
                        locator_version: 1,
                        chapter_path: "Text/chapter.xhtml".to_string(),
                        spine_index_hint: 1,
                        target: LocatorTarget::Text {
                            text_profile: TEXT_PROFILE.to_string(),
                            offset: 99,
                            snippet: "xyz".to_string(),
                        },
                    }),
                    progress_pct_hint: 55,
                }),
                9500,
            )
            .unwrap();
        assert_eq!(written.status, WriteStatus::Written);
        assert!(store
            .snapshot()
            .unwrap()
            .books
            .get(HASH)
            .unwrap()
            .progress
            .versions
            .iter()
            .any(|version| version.updated_at_ms == 9500));

        let bookmark = BookmarkValue {
            locator: Locator::Modern(ModernLocator {
                locator_version: 1,
                chapter_path: "Text/chapter.xhtml".to_string(),
                spine_index_hint: 1,
                target: LocatorTarget::ChapterStart,
            }),
            text: "new".to_string(),
            created_at_ms: 9500,
        };
        let created = store.create_bookmark(HASH, NEW_ID, bookmark, 9500).unwrap();
        assert_eq!(created.status, WriteStatus::Written);
        assert!(store
            .snapshot()
            .unwrap()
            .books
            .get(HASH)
            .unwrap()
            .bookmarks
            .contains_key(NEW_ID));

        let deleted = store.delete_bookmark(HASH, NEW_ID).unwrap();
        assert_eq!(deleted.status, DeleteStatus::Deleted);
        let book = store.snapshot().unwrap().books.get(HASH).unwrap().clone();
        let tombstone = book.bookmarks.get(NEW_ID).unwrap();
        assert!(tombstone.versions.is_empty());
        assert!(tombstone.deleted.is_some());
        assert!(store
            .create_bookmark(HASH, NEW_ID, created.state.versions[0].value.clone(), 9600)
            .is_err());
    }

    #[test]
    fn project_shelf_hides_tombstones_and_keeps_folder_effective_projection() {
        let mut store = PortableStore::open_in_memory().unwrap();
        let incoming: PortableStateV3 = serde_json::from_value(state_json_with_one_book()).unwrap();
        store.merge_validated_state(incoming).unwrap();
        let bookmark = BookmarkValue {
            locator: Locator::Modern(ModernLocator {
                locator_version: 1,
                chapter_path: "Text/chapter.xhtml".to_string(),
                spine_index_hint: 1,
                target: LocatorTarget::ChapterStart,
            }),
            text: "new".to_string(),
            created_at_ms: 9500,
        };
        store.create_bookmark(HASH, NEW_ID, bookmark, 9500).unwrap();
        store.delete_bookmark(HASH, NEW_ID).unwrap();
        let projection = store.project_shelf().unwrap();
        let book = projection
            .books
            .iter()
            .find(|book| book.book_hash == HASH)
            .unwrap();
        assert!(!book.bookmarks.iter().any(|bookmark| bookmark.id == NEW_ID));
        assert!(book.progress.display.is_some());
    }
    #[test]
    fn migration_transaction_failure_leaves_no_half_state() {
        let root = TempDir::new("migration-rollback");
        legacy_repository_fixture(root.path());
        let database = root.path().join("library.sqlite3");
        let mut store = PortableStore::open(&database).unwrap();
        {
            let installer = rusqlite::Connection::open(&database).unwrap();
            installer
                .execute_batch(
                    "CREATE TRIGGER fail_progress
                     BEFORE INSERT ON progress
                     BEGIN
                         SELECT RAISE(FAIL, 'intentional migration failure');
                     END;",
                )
                .unwrap();
        }
        let error = store.migrate_legacy(root.path()).unwrap_err();
        assert_eq!(error.code, "storage-error");
        assert!(!store.migration_completed().unwrap());
        assert!(store.snapshot().unwrap().books.is_empty());
        assert!(store.installation_id().unwrap().is_none());
    }
    #[test]
    fn repository_rejects_unknown_book_adopt_and_write_without_corrupting_snapshot() {
        let root = TempDir::new("unknown-book");
        let database = root.path().join("library.sqlite3");
        let mut store = PortableStore::open(&database).unwrap();
        let state: PortableStateV3 = serde_json::from_value(state_json_with_one_book()).unwrap();
        store.merge_validated_state(state).unwrap();

        let (read_id, book) = store.read(HASH).unwrap();
        let book = book.expect("known book snapshot");
        let stamp = book.progress.versions[0].stamp.clone();
        let value = book.progress.versions[0].value.clone();
        let basis_id = store
            .adopt(
                &read_id,
                EntityRef::Progress {
                    book_hash: HASH.to_string(),
                },
                AdoptSelection::Chosen { stamp },
            )
            .unwrap();

        let (unknown_read_id, unknown_book) = store.read(HASH_2).unwrap();
        assert!(unknown_book.is_none());
        let error = store
            .adopt(
                &unknown_read_id,
                EntityRef::Progress {
                    book_hash: HASH_2.to_string(),
                },
                AdoptSelection::Empty,
            )
            .unwrap_err();
        assert_eq!(error.code, "invalid-entity");
        let after_unknown = store.snapshot().unwrap();
        assert!(after_unknown.books.contains_key(HASH));
        assert!(!after_unknown.books.contains_key(HASH_2));

        // Simulate an interrupted legacy import that removed the book rows
        // behind a still-live basis: the write path rechecks metadata and must
        // not create orphan progress or advance the counter.
        {
            let racer = rusqlite::Connection::open(&database).unwrap();
            racer.execute("DELETE FROM book_meta", []).unwrap();
            racer.execute("DELETE FROM progress", []).unwrap();
            racer.execute("DELETE FROM annotations", []).unwrap();
            racer.execute("DELETE FROM organization", []).unwrap();
        }
        let error = store
            .write_progress(&basis_id, WriteIntent::Auto, value, 3000)
            .unwrap_err();
        assert_eq!(error.code, "invalid-entity");
        assert!(store.snapshot().unwrap().books.is_empty());
    }

    #[test]
    fn dto_requires_version_value_but_accepts_explicit_null_progress_reset() {
        let mut missing = state_json_with_one_book();
        missing["books"][HASH]["progress"]["versions"][0]
            .as_object_mut()
            .unwrap()
            .remove("value");
        assert!(serde_json::from_value::<PortableStateV3>(missing).is_err());

        let mut explicit_null = state_json_with_one_book();
        explicit_null["books"][HASH]["progress"]["versions"][0]["value"] = json!(null);
        let state: PortableStateV3 = serde_json::from_value(explicit_null).unwrap();
        validate_portable_state(&state).unwrap();
    }

    #[test]
    fn review_linked_import_rolls_back_book_binding_flags_and_counter() {
        let root = TempDir::new("linked-import-rollback");
        legacy_repository_fixture(root.path());
        let database = root.path().join("library.sqlite3");
        let mut store = PortableStore::open(&database).unwrap();
        store.migrate_legacy(root.path()).unwrap();
        let before = store.snapshot().unwrap();
        let counter = store.counter().unwrap();
        let visible = store.local_visible_hashes().unwrap();
        let is_new = store.local_is_new_hashes().unwrap();
        let bindings = store.bindings_raw().unwrap();
        let mut record = legacy_record_json();
        record["contentHash"] = json!(HASH_2);
        let binding = json!({ "contentHash": HASH_2, "storageKind": "managed" }).to_string();
        {
            let installer = rusqlite::Connection::open(&database).unwrap();
            installer
                .execute_batch(
                    "CREATE TRIGGER fail_import_binding BEFORE INSERT ON device_bindings
                 BEGIN SELECT RAISE(FAIL, 'intentional binding failure'); END;",
                )
                .unwrap();
        }
        let error = store
            .publish_linked_imports(
                vec![record.clone()],
                vec![(HASH_2.to_string(), binding.clone())],
                vec![HASH_2.to_string()],
                vec![HASH_2.to_string()],
            )
            .unwrap_err();
        assert_eq!(error.code, "storage-error");
        assert_eq!(store.snapshot().unwrap(), before);
        assert_eq!(store.counter().unwrap(), counter);
        assert_eq!(store.local_visible_hashes().unwrap(), visible);
        assert_eq!(store.local_is_new_hashes().unwrap(), is_new);
        assert_eq!(store.bindings_raw().unwrap(), bindings);
        {
            let installer = rusqlite::Connection::open(&database).unwrap();
            installer
                .execute_batch("DROP TRIGGER fail_import_binding;")
                .unwrap();
        }
        store
            .publish_linked_imports(
                vec![record],
                vec![(HASH_2.to_string(), binding)],
                vec![HASH_2.to_string()],
                vec![HASH_2.to_string()],
            )
            .unwrap();
        drop(store);
        let store = PortableStore::open(&database).unwrap();
        assert!(store.snapshot().unwrap().books.contains_key(HASH_2));
        assert!(store.binding_raw(HASH_2).unwrap().is_some());
        assert!(store
            .local_visible_hashes()
            .unwrap()
            .contains(&HASH_2.to_string()));
        assert!(store
            .local_is_new_hashes()
            .unwrap()
            .contains(&HASH_2.to_string()));
    }

    #[test]
    fn review_linked_batch_removal_is_atomic_and_preserves_unrelated_books() {
        let root = TempDir::new("linked-removal");
        let database = root.path().join("library.sqlite3");
        let mut store = PortableStore::open(&database).unwrap();
        let mut other = legacy_record_json();
        other["contentHash"] = json!(HASH_2);
        let hashes = vec![HASH.to_string(), HASH_2.to_string()];
        store
            .publish_linked_imports(
                vec![legacy_record_json(), other],
                hashes
                    .iter()
                    .map(|hash| (hash.clone(), json!({"contentHash": hash}).to_string()))
                    .collect(),
                hashes.clone(),
                hashes.clone(),
            )
            .unwrap();
        store.set_local_is_new(HASH, false).unwrap();
        assert_eq!(
            store.local_is_new_hashes().unwrap(),
            vec![HASH_2.to_string()]
        );
        {
            let installer = rusqlite::Connection::open(&database).unwrap();
            installer
                .execute_batch(&format!(
                    "CREATE TRIGGER fail_second_delete BEFORE DELETE ON device_bindings
                 WHEN OLD.hash = '{HASH_2}'
                 BEGIN SELECT RAISE(FAIL, 'intentional removal failure'); END;"
                ))
                .unwrap();
        }
        assert!(store.hide_linked_records(&hashes).is_err());
        assert_eq!(store.local_visible_hashes().unwrap(), hashes);
        assert!(store.binding_raw(HASH).unwrap().is_some());
        assert!(store.binding_raw(HASH_2).unwrap().is_some());
        {
            let installer = rusqlite::Connection::open(&database).unwrap();
            installer
                .execute_batch("DROP TRIGGER fail_second_delete;")
                .unwrap();
        }
        store.hide_linked_records(&[HASH.to_string()]).unwrap();
        assert_eq!(
            store.local_visible_hashes().unwrap(),
            vec![HASH_2.to_string()]
        );
        assert_eq!(
            store.local_is_new_hashes().unwrap(),
            vec![HASH_2.to_string()]
        );
        assert!(store.binding_raw(HASH).unwrap().is_none());
        assert!(store.binding_raw(HASH_2).unwrap().is_some());
        let state = store.snapshot().unwrap();
        assert_eq!(state.books.len(), 2);
        assert!(state.books[HASH].notes.contains_key(OLD_NOTE_ID));
        assert_eq!(state.books[HASH].progress.versions.len(), 1);
    }

    #[test]
    fn repository_linked_snapshot_binding_visibility_and_is_new_work() {
        let mut store = PortableStore::open_in_memory().unwrap();
        store
            .publish_linked_records_snapshot(
                vec![legacy_record_json()],
                vec![HASH.to_string()],
                vec![HASH.to_string()],
            )
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        assert!(snapshot.books.contains_key(HASH));
        assert!(snapshot.books[HASH].notes.contains_key(OLD_NOTE_ID));
        assert!(store
            .local_visible_hashes()
            .unwrap()
            .contains(&HASH.to_string()));
        assert!(store
            .local_is_new_hashes()
            .unwrap()
            .contains(&HASH.to_string()));

        let binding_raw = serde_json::to_string(&json!({
            "contentHash": HASH,
            "storageKind": "linked",
            "canonicalSourcePath": "/tmp/linked/book.epub",
            "fileSize": 1,
            "sourceMtimeNs": 2,
            "coverZipPath": null,
            "coverMime": "",
            "lastVerifiedAtMs": 3
        }))
        .unwrap();
        store
            .replace_bindings_snapshot(vec![(HASH.to_string(), binding_raw)])
            .unwrap();
        assert!(store.binding_raw(HASH).unwrap().is_some());

        store.hide_linked_record(HASH).unwrap();
        assert!(store.binding_raw(HASH).unwrap().is_none());
        assert!(!store
            .local_visible_hashes()
            .unwrap()
            .contains(&HASH.to_string()));
        assert!(!store
            .local_is_new_hashes()
            .unwrap()
            .contains(&HASH.to_string()));
        // Local removal keeps the portable metadata for future sync.
        assert!(store.snapshot().unwrap().books.contains_key(HASH));
    }

    #[test]
    fn repository_legacy_import_merges_missing_annotations_without_replacing_v3_progress() {
        let mut store = PortableStore::open_in_memory().unwrap();
        let state: PortableStateV3 = serde_json::from_value(state_json_with_one_book()).unwrap();
        let merged = store.merge_validated_state(state).unwrap();
        let organization = merged.organization.clone();

        let imported = store
            .import_legacy_records_json(vec![legacy_record_json()], organization)
            .unwrap();
        let book = &imported.books[HASH];
        assert_eq!(book.metadata.value.title, "书");
        assert_eq!(book.progress.versions.len(), 1);
        assert_eq!(
            book.progress.versions[0]
                .value
                .as_ref()
                .unwrap()
                .progress_pct_hint,
            10
        );
        assert_eq!(book.progress.versions[0].stamp.counter, 2);
        assert!(book.bookmarks.contains_key(OLD_BOOKMARK_ID));
        assert!(book.notes.contains_key(OLD_NOTE_ID));
        assert!(store
            .local_visible_hashes()
            .unwrap()
            .contains(&HASH.to_string()));
    }
}
