use super::{commands::catalog, source, state::*};
use crate::{native_zip_session::NativeZipSession, portable_state::*};
use serde_json::json;
use std::{
    io::{Cursor, Read, Seek, SeekFrom, Write},
    sync::Arc,
};

const ID: &str = "00000000-0000-4000-8000-000000000001";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn active() -> Arc<Session> {
    ReadestImportState::default()
        .reserve(ID.into(), ImportScope::Public)
        .unwrap()
}
fn archive(entries: &[(&str, &[u8])]) -> Arc<NativeZipSession> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    let reader = zip.finish().unwrap();
    Arc::new(
        NativeZipSession::from_verified_reader(Cursor::new(reader.into_inner()), || Ok(()))
            .unwrap(),
    )
}
fn store() -> PortableStore {
    let state = serde_json::from_value(json!({
        "schemaVersion":3, "books": { HASH: {
            "metadata":{"value":{"title":"Synthetic", "creator":"", "fileName":"book.epub", "addedAtMs":1},"stamp":{"deviceId":ID,"counter":1}},
            "progress":{"versions":[]}, "bookmarks":{}, "notes":{}
        }}, "organization":{"schemaVersion":1,"folders":{},"books":{}}
    })).unwrap();
    let mut store = PortableStore::open_in_memory().unwrap();
    store
        .merge_validated_import(state, vec![(HASH.into(), "{}".into())], false)
        .unwrap();
    store
}
fn plan(offset: u64) -> ReadestBookImport {
    let locator = json!({"locatorVersion":1,"chapterPath":"Text/chapter.xhtml","spineIndexHint":0,
        "target":{"kind":"text","textProfile":TEXT_PROFILE,"offset":offset,"snippet":"abc"}});
    serde_json::from_value(json!({
        "bookHash":HASH, "readestHash":REMOTE, "targetToken":"token",
        "progress":{"locator":locator,"progressPctHint":10},
        "bookmarks":[{"sourceKey":format!("readest:{REMOTE}:bookmark-1"),"value":{"locator":locator,"text":"abc","createdAtMs":10}}],
        "notes":[{"sourceKey":format!("readest:{REMOTE}:note-1"),"value":{
            "chapterPath":"Text/chapter.xhtml","spineIndexHint":0,"textProfile":TEXT_PROFILE,
            "startTextOffset":0,"endTextOffset":3,"startTextSnippet":"abc","endTextSnippet":"abc",
            "selectedText":"abc","content":"Synthetic note","createdAtMs":10}}]
    })).unwrap()
}
fn commit(store: &mut PortableStore, book: ReadestBookImport) -> ReadestImportOutcome {
    let target = store.readest_target(&book.book_hash).unwrap();
    let session = active();
    store
        .import_readest(&[(target, book)], 100, &|| false, |tx| {
            session.finish(tx, &|| true, &[])
        })
        .unwrap()
}

fn folder_plan(hash: &str, path: &[&str]) -> ReadestBookImport {
    let mut book = plan(0);
    book.book_hash = hash.into();
    book.progress = None;
    book.bookmarks.clear();
    book.notes.clear();
    book.folder_path = Some(path.iter().map(|s| (*s).into()).collect());
    book
}

#[test]
fn readest_folders_preserve_five_levels_and_repeat_without_reclassifying_local_books() {
    let mut store = store();
    let book = folder_plan(HASH, &["Root", "Child", "3", "4", "5"]);
    let outcome = commit(&mut store, book.clone());
    assert_eq!(outcome.imported_books, 1);
    assert_eq!(outcome.books_classified, 1);
    let state = store.snapshot().unwrap();
    let leaf = crate::library_organization::effective_folder_id(&state.organization, HASH).unwrap();
    assert_eq!(state.organization.folders.len(), 5);
    assert_eq!(crate::library_organization::effective_folder_depth(&state.organization, leaf), Some(5));
    assert_eq!(commit(&mut store, book).imported_books, 0);
    // An existing local assignment wins even when a later Readest import differs.
    assert_eq!(commit(&mut store, folder_plan(HASH, &["Different"])).imported_books, 0);
    assert_eq!(store.snapshot().unwrap(), state);
}

#[test]
fn readest_folders_reuse_only_matching_siblings_and_rollback_with_the_originals() {
    let mut store = store();
    commit(&mut store, folder_plan(HASH, &["Root", "Child"]));
    let before = store.snapshot().unwrap();
    let hash = "c".repeat(64);
    let book = folder_plan(&hash, &["Other", "Child"]);
    let pending = pending_target(&store, &hash);
    let session = active();
    let result = store.import_readest_bundle(&[(pending.clone(), book.clone())], &[bundle_original(&hash)], 100, &|| false, |tx, _| {
        session.close()?;
        session.finish(tx, &|| true, &[])
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert_eq!(store.snapshot().unwrap(), before);
    assert!(store.binding_raw(&hash).unwrap().is_none());
    store.import_readest_bundle(&[(pending, book)], &[bundle_original(&hash)], 101, &|| false, |tx, _| { tx.commit()?; Ok(()) }).unwrap();
    let state = store.snapshot().unwrap();
    assert_eq!(state.organization.folders.len(), 4);
    assert_ne!(crate::library_organization::effective_folder_id(&state.organization, HASH), crate::library_organization::effective_folder_id(&state.organization, &hash));
    let hash2 = "d".repeat(64);
    let pending2 = pending_target(&store, &hash2);
    store.import_readest_bundle(&[(pending2, folder_plan(&hash2, &["Root", "Child"]))], &[bundle_original(&hash2)], 102, &|| false, |tx, _| { tx.commit()?; Ok(()) }).unwrap();
    let state = store.snapshot().unwrap();
    assert_eq!(state.organization.folders.len(), 4);
    assert_eq!(crate::library_organization::effective_folder_id(&state.organization, HASH), crate::library_organization::effective_folder_id(&state.organization, &hash2));
}

#[test]
fn readest_partial_md5_matches_ranges_and_bounds_large_source_reads() {
    assert_eq!(
        source::partial(&mut Cursor::new(b"hello"), 5, &|| false).unwrap(),
        "5d41402abc4b2a76b9719d911017c592"
    );
    let bytes = (0..50000).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    // Independently computed with Python hashlib and the published ranges.
    assert_eq!(
        source::partial(&mut Cursor::new(bytes), 50000, &|| false).unwrap(),
        "04a4d10f5e5583d7173cce0782769cb1"
    );
    struct Sparse {
        position: u64,
        reads: usize,
    }
    impl Read for Sparse {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads += buffer.len();
            buffer.fill(0);
            self.position += buffer.len() as u64;
            Ok(buffer.len())
        }
    }
    impl Seek for Sparse {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            let SeekFrom::Start(position) = position else {
                panic!()
            };
            self.position = position;
            Ok(position)
        }
    }
    let mut sparse = Sparse {
        position: 0,
        reads: 0,
    };
    source::partial(&mut sparse, 8_000_000_000, &|| false).unwrap();
    assert_eq!(sparse.reads, 12 * 1024);
    assert_eq!(
        source::partial(&mut sparse, 8_000_000_000, &|| true)
            .unwrap_err()
            .code,
        "cancelled"
    );
}

#[test]
fn readest_backup_whitelists_json_and_closes_during_chunked_read() {
    let session = active();
    let name = format!("{REMOTE}/config.json");
    let config = vec![b' '; crate::native_zip_session::CHUNK_BYTES + 3];
    let library = catalog(
        &session,
        archive(&[
            ("library.json", b"[]"),
            (&name, &config),
            ("settings.json", b"secret"),
        ]),
    )
    .unwrap();
    assert_eq!(session.read_json(library.entry_index, 0).unwrap(), b"[]");
    assert_eq!(session.read_json(2, 0).unwrap_err().code, "invalid-request");
    assert_eq!(
        session.read_json(1, 0).unwrap().len(),
        crate::native_zip_session::CHUNK_BYTES
    );
    assert!(!session.data.lock().unwrap().configs_read.contains(REMOTE));
    session
        .read_json(1, crate::native_zip_session::CHUNK_BYTES as u64)
        .unwrap();
    assert!(session.data.lock().unwrap().configs_read.contains(REMOTE));
    assert_eq!(session.close().unwrap(), "closed");
    assert_eq!(session.read_json(1, 0).unwrap_err().code, "cancelled");
    assert!(session.data.lock().unwrap().archive.is_none());
}

#[test]
fn readest_backup_rejects_own_format_and_late_adoption() {
    let s = active();
    assert_eq!(
        catalog(
            &s,
            archive(&[("manifest.json", b"{}"), ("library.json", b"[]")])
        )
        .err()
        .unwrap()
        .code,
        "not-readest"
    );
    let s = active();
    s.close().unwrap();
    assert_eq!(
        catalog(&s, archive(&[("library.json", b"[]")]))
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    assert!(s.data.lock().unwrap().archive.is_none());
    let manager = ReadestImportState::default();
    manager.reserve(ID.into(), ImportScope::Public).unwrap();
    assert!(manager.reserve(ID.into(), ImportScope::Public).is_err());
    assert_eq!(manager.close(ID).unwrap(), "closed");
    manager.reserve(ID.into(), ImportScope::Public).unwrap();
    manager.shutdown();
    assert!(manager.get(ID).is_err());
}

#[test]
fn readest_repeat_keeps_local_edit_and_deletion_but_new_progress_can_import() {
    let mut store = store();
    let first = commit(&mut store, plan(2));
    assert_eq!(
        (
            first.imported_books,
            first.bookmarks_added,
            first.notes_added,
            first.progress_written
        ),
        (1, 1, 1, 1)
    );
    let state = store.snapshot().unwrap();
    let id = state.books[HASH].bookmarks.keys().next().unwrap().clone();
    assert!(valid_canonical_uuid(&id));
    let note_id = state.books[HASH].notes.keys().next().unwrap().clone();
    let (read, _) = store.read(HASH).unwrap();
    let basis = store
        .adopt(
            &read,
            EntityRef::Bookmark {
                book_hash: HASH.into(),
                id: id.clone(),
            },
            AdoptSelection::Chosen {
                stamp: state.books[HASH].bookmarks[&id].versions[0].stamp.clone(),
            },
        )
        .unwrap();
    let mut value = state.books[HASH].bookmarks[&id].versions[0].value.clone();
    value.text = "Local edit".into();
    store
        .write_bookmark(&basis, WriteIntent::Edit, value, 101)
        .unwrap();
    store.delete_note(HASH, &note_id).unwrap();
    let repeated = commit(&mut store, plan(2));
    assert_eq!(
        (
            repeated.imported_books,
            repeated.skipped_existing,
            repeated.progress_unchanged
        ),
        (0, 2, 1)
    );
    let state = store.snapshot().unwrap();
    assert_eq!(
        state.books[HASH].bookmarks[&id].versions[0].value.text,
        "Local edit"
    );
    assert!(state.books[HASH].notes[&note_id].deleted.is_some());
    assert_eq!(commit(&mut store, plan(8)).progress_written, 1);
    // A changed percentage for the same canonical locator is still unchanged.
    let mut same = plan(8);
    same.progress.as_mut().unwrap().progress_pct_hint = 99;
    assert_eq!(commit(&mut store, same).progress_unchanged, 1);
}

#[test]
fn readest_cancel_at_sql_commit_rolls_back_data_receipt_and_clock() {
    let mut store = store();
    let target = store.readest_target(HASH).unwrap();
    let before = store.snapshot().unwrap();
    let counter = store.reserve_stamps(1).unwrap().counter;
    let session = active();
    let result = store.import_readest(&[(target, plan(2))], 100, &|| false, |tx| {
        assert_eq!(session.close()?, "closed");
        session.finish(tx, &|| true, &[])
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert_eq!(store.snapshot().unwrap(), before);
    assert_eq!(store.reserve_stamps(1).unwrap().counter, counter + 1);
    assert_eq!(commit(&mut store, plan(2)).progress_written, 1);
}

#[test]
fn readest_commit_gate_reports_committed_if_cancel_loses() {
    let mut store = store();
    let target = store.readest_target(HASH).unwrap();
    let session = active();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let peer = session.clone();
    let other = barrier.clone();
    let closer = std::thread::spawn(move || {
        other.wait();
        peer.close().unwrap()
    });
    let guard: source::Guard = Arc::new(move || {
        barrier.wait();
        Ok(())
    });
    store
        .import_readest(&[(target, plan(2))], 100, &|| false, |tx| {
            session.finish(tx, &|| true, &[guard])
        })
        .unwrap();
    assert_eq!(closer.join().unwrap(), "committed");
    assert_eq!(store.snapshot().unwrap().books[HASH].notes.len(), 1);
}

#[test]
fn readest_stale_progress_live_reader_and_changed_source_do_not_write() {
    let mut store = store();
    let stale = store.readest_target(HASH).unwrap();
    commit(&mut store, plan(3));
    let before = store.snapshot().unwrap();
    let session = active();
    assert_eq!(
        store
            .import_readest(&[(stale, plan(2))], 100, &|| false, |tx| session.finish(
                tx,
                &|| true,
                &[]
            ))
            .unwrap_err()
            .code,
        "stale-basis"
    );
    let target = store.readest_target(HASH).unwrap();
    let guard: source::Guard = Arc::new(|| Err(crate::native_zip_session::Fault::SourceChanged));
    assert_eq!(
        store
            .import_readest(&[(target, plan(5))], 100, &|| false, |tx| session.finish(
                tx,
                &|| true,
                &[guard]
            ))
            .unwrap_err()
            .code,
        "source-changed"
    );
    assert_eq!(store.snapshot().unwrap(), before);
    let (read, _) = store.read(HASH).unwrap();
    store
        .adopt(
            &read,
            EntityRef::Progress {
                book_hash: HASH.into(),
            },
            AdoptSelection::ShownAll,
        )
        .unwrap();
    let target = store.readest_target(HASH).unwrap();
    assert_eq!(
        store
            .import_readest(&[(target, plan(2))], 100, &|| false, |tx| session.finish(
                tx,
                &|| true,
                &[]
            ))
            .unwrap_err()
            .code,
        "reader-busy"
    );
}

#[test]
fn readest_invalid_record_rolls_back_and_deletion_clears_receipt() {
    let mut store = store();
    let before = store.snapshot().unwrap();
    let mut invalid = plan(2);
    invalid.notes[0].value.end_text_offset = 0;
    let target = store.readest_target(HASH).unwrap();
    let session = active();
    assert!(store
        .import_readest(&[(target, invalid)], 100, &|| false, |tx| session.finish(
            tx,
            &|| true,
            &[]
        ))
        .is_err());
    assert_eq!(store.snapshot().unwrap(), before);
    commit(&mut store, plan(2));
    store.hide_linked_record(HASH).unwrap();
    store
        .merge_validated_import(before, vec![(HASH.into(), "{}".into())], false)
        .unwrap();
    assert_eq!(commit(&mut store, plan(2)).progress_written, 1);
}

#[test]
fn readest_annotations_only_keep_the_live_reader_basis() {
    let mut store = store();
    let (read, _) = store.read(HASH).unwrap();
    let basis = store
        .adopt(
            &read,
            EntityRef::Progress {
                book_hash: HASH.into(),
            },
            AdoptSelection::Empty,
        )
        .unwrap();
    let mut annotations = plan(2);
    annotations.progress = None;
    commit(&mut store, annotations);
    let outcome = store
        .write_progress(&basis, WriteIntent::Auto, plan(8).progress, 101)
        .unwrap();
    assert_eq!(outcome.status, WriteStatus::Written);
}

#[test]
fn readest_lock_intent_during_final_source_guard_rolls_back() {
    let mut store = store();
    let before = store.snapshot().unwrap();
    let target = store.readest_target(HASH).unwrap();
    let session = active();
    let epoch = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let guard_epoch = epoch.clone();
    let guard: source::Guard = Arc::new(move || {
        guard_epoch.store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    });
    let result = store.import_readest(&[(target, plan(2))], 100, &|| false, |tx| {
        session.finish(
            tx,
            &|| epoch.load(std::sync::atomic::Ordering::Acquire),
            &[guard],
        )
    });
    assert_eq!(result.unwrap_err().code, "locked");
    assert_eq!(store.snapshot().unwrap(), before);
}

#[test]
fn readest_dto_rejects_foreign_clock_and_null_progress() {
    let mut value = json!({"bookHash":HASH,"readestHash":REMOTE,"targetToken":"token","bookmarks":[],"notes":[]});
    assert!(serde_json::from_value::<ReadestBookImport>(value.clone()).is_ok());
    value["progress"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<ReadestBookImport>(value.clone()).is_err());
    value.as_object_mut().unwrap().remove("progress");
    value["stamp"] = json!({"deviceId":ID,"counter":9000});
    assert!(serde_json::from_value::<ReadestBookImport>(value).is_err());
}

fn readest_folder(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("selis-readest-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn readest_backup_lists_book_files_and_stages_one_without_touching_others() {
    let other = "cccccccccccccccccccccccccccccccc";
    let book = (0..700_000).map(|i| (i % 253) as u8).collect::<Vec<_>>();
    let session = active();
    let zip = archive(&[
        ("library.json", b"[]"),
        (&format!("{REMOTE}/config.json"), b"{}"),
        (&format!("{REMOTE}/cover.png"), b"png"),
        (&format!("{REMOTE}/nav.json"), b"{}"),
        (&format!("{REMOTE}/Synthetic Book.epub"), &book),
        (&format!("{REMOTE}/audiobook/part.epub"), b"nested"),
        (&format!("{other}/Scan.pdf"), b"pdf"),
        ("settings.json", b"{}"),
    ]);
    catalog(&session, zip).unwrap();
    let (found, origin) = {
        let data = session.data.lock().unwrap();
        (data.books.clone(), data.archive.clone().unwrap())
    };
    // Only the supported book beside a config counts: no sidecar, audiobook or PDF.
    assert_eq!(found.keys().collect::<Vec<_>>(), [REMOTE]);
    let file = &found[REMOTE];
    assert_eq!((file.name.as_str(), file.bytes), ("Synthetic Book.epub", book.len() as u64));
    let (Origin::Zip(zip), BookAt::Zip(index)) = (origin, file.at.clone()) else {
        panic!("a backup book must come from the archive");
    };
    let dir = readest_folder("stage");
    let dest = dir.join("1").join(super::books::safe_name(&file.name));
    let mut seen = 0;
    super::books::extract(&zip, index, file.bytes, &dest, &|| Ok(()), &mut |step| seen += step).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), book);
    assert_eq!(seen, book.len() as u64);
    // A cancelled extraction leaves no partial file behind.
    let partial = dir.join("2").join("book.epub");
    let calls = std::cell::Cell::new(0);
    let cancelled = super::books::extract(&zip, index, file.bytes, &partial, &|| {
        calls.set(calls.get() + 1);
        if calls.get() > 1 { Err(super::error("cancelled", "x")) } else { Ok(()) }
    }, &mut |_| {});
    assert_eq!(cancelled.unwrap_err().code, "cancelled");
    assert!(!partial.exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn readest_staged_names_are_plain_and_portable() {
    use super::books::safe_name;
    assert_eq!(safe_name("三体：黑暗森林?.epub"), "三体：黑暗森林_.epub");
    assert_eq!(safe_name("a/b\\What: a \"test\".mobi"), "What_ a _test_.mobi");
    assert_eq!(safe_name("..epub"), "book.epub");
    assert_eq!(safe_name(".azw3"), "book.azw3");
    assert_eq!(safe_name(&format!("{}.epub", "长".repeat(200))).len(), 180 + ".epub".len());
}

#[test]
fn readest_library_folder_is_found_at_any_level_and_read_like_a_backup() {
    let root = readest_folder("folder");
    let books = root.join("Readest").join("Books");
    let own = books.join(REMOTE);
    std::fs::create_dir_all(&own).unwrap();
    std::fs::create_dir_all(books.join("not-a-hash")).unwrap();
    std::fs::write(books.join("library.json"), b"[]").unwrap();
    std::fs::write(own.join("config.json"), b"{\"v\":1}").unwrap();
    std::fs::write(own.join("cover.png"), b"png").unwrap();
    std::fs::write(own.join("Book.epub"), b"epub-bytes").unwrap();
    std::fs::write(root.join("Readest").join("settings.json"), b"{\"secret\":1}").unwrap();
    for picked in [root.clone(), root.join("Readest"), books.clone()] {
        assert_eq!(super::folder::locate(&picked), Some(books.clone()));
    }
    assert_eq!(super::folder::locate(&own), None);
    assert_eq!(
        super::folder::default_roots(Some("/data".into()), Some("/home/u".into())),
        [
            std::path::PathBuf::from("/data/com.bilingify.readest"),
            std::path::PathBuf::from("/home/u/.var/app/com.bilingify.readest/data/com.bilingify.readest"),
        ]
    );

    let session = active();
    let library = super::commands::catalog_folder(&session, &books).unwrap();
    assert_eq!(session.read_json(library.entry_index, 0).unwrap(), b"[]");
    {
        let data = session.data.lock().unwrap();
        assert_eq!(data.books.keys().collect::<Vec<_>>(), [REMOTE]);
        assert!(matches!(&data.books[REMOTE].at, BookAt::File(path) if path == &own.join("Book.epub")));
        // Settings are outside the catalogue and can never be requested.
        assert_eq!(data.entries.len(), 2);
    }
    // Readest rewrote the config after the scan: the lookup serves the new bytes whole.
    std::fs::write(own.join("config.json"), b"{\"v\":2,\"more\":true}").unwrap();
    let config = session.config_entry(REMOTE).unwrap().unwrap();
    assert_eq!(config.bytes, 19);
    assert_eq!(session.read_json(config.entry_index, 0).unwrap(), b"{\"v\":2,\"more\":true}");
    assert!(session.data.lock().unwrap().configs_read.contains(REMOTE));
    // A change between the lookup and a fresh read is reported, never mixed.
    std::fs::write(own.join("config.json"), b"{}").unwrap();
    assert_eq!(session.read_json(config.entry_index, 0).unwrap_err().code, "source-changed");
    assert_eq!(session.read_json(99, 0).unwrap_err().code, "invalid-request");
    assert!(session.config_entry("dddddddddddddddddddddddddddddddd").unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn readest_session_commits_in_batches_until_cancelled() {
    let mut store = store();
    let session = active();
    for offset in [1, 2] {
        let target = store.readest_target(HASH).unwrap();
        store
            .import_readest(&[(target, plan(offset))], 100 + offset, &|| false, |tx| {
                session.finish(tx, &|| true, &[])
            })
            .unwrap();
    }
    assert_eq!(session.close().unwrap(), "committed");
    let target = store.readest_target(HASH).unwrap();
    let late = store.import_readest(&[(target, plan(3))], 200, &|| false, |tx| {
        session.finish(tx, &|| true, &[])
    });
    assert_eq!(late.unwrap_err().code, "cancelled");
}

fn bundle_original(hash: &str) -> (serde_json::Value, String, String, Option<String>) {
    let metadata = crate::linked_library::ImportedMetadata { title: "New synthetic".into(), creator: "".into(), language: "".into(), spine: vec!["chapter.xhtml".into()], cover_zip_path: None, cover_mime: "".into() };
    (serde_json::to_value(crate::linked_library::make_managed_record(hash.into(), "new.epub".into(), &metadata)).unwrap(), hash.into(), "{}".into(), None)
}
fn pending_target(store: &PortableStore, hash: &str) -> ReadestTarget {
    ReadestTarget { book_hash: hash.into(), metadata_stamp: Stamp { device_id: ID.into(), counter: 0 }, binding: "{}".into(), progress_revision: 0,
        progress: ProgressProjection { versions: vec![], display: None, conflict: false }, generation: store.runtime_generation().into() }
}
#[test]
fn readest_bundle_rolls_back_new_book_and_existing_records_on_invalid_note_or_cancel() {
    let mut store = store();
    let hash = "c".repeat(64);
    let before = store.snapshot().unwrap();
    let visible = store.local_visible_hashes().unwrap();
    let mut bad = plan(9); bad.book_hash = hash.clone(); bad.notes[0].value.selected_text = "".into();
    let existing = (store.readest_target(HASH).unwrap(), plan(5));
    let pending = pending_target(&store, &hash);
    let originals = vec![bundle_original(&hash)];
    let result = store.import_readest_bundle(&[existing.clone(), (pending.clone(), bad)], &originals, 100, &|| false, |tx, _| { tx.commit()?; Ok(()) });
    assert!(result.is_err());
    assert_eq!(store.snapshot().unwrap(), before);
    assert_eq!(store.local_visible_hashes().unwrap(), visible);
    assert!(store.binding_raw(&hash).unwrap().is_none());
    let mut new = plan(9); new.book_hash = hash.clone();
    let session = active();
    let result = store.import_readest_bundle(&[existing, (pending, new)], &originals, 100, &|| false, |tx, _| {
        session.close()?;
        session.finish(tx, &|| true, &[])
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert_eq!(store.snapshot().unwrap(), before);
    assert!(store.binding_raw(&hash).unwrap().is_none());
}
#[test]
fn readest_bundle_publishes_book_binding_and_records_together_and_preserves_duplicates() {
    let mut store = store();
    let hash = "c".repeat(64);
    let mut book = plan(9); book.book_hash = hash.clone();
    let pending = pending_target(&store, &hash);
    let session = active();
    let outcome = store.import_readest_bundle(&[(pending, book.clone())], &[bundle_original(&hash)], 100, &|| false, |tx, _| session.finish(tx, &|| true, &[])).unwrap();
    assert_eq!(outcome.books_added, 1);
    assert_eq!(outcome.notes_added, 1);
    assert!(store.binding_raw(&hash).unwrap().is_some());
    assert!(store.local_visible_hashes().unwrap().contains(&hash));
    let before = store.snapshot().unwrap();
    let target = store.readest_target(&hash).unwrap();
    let outcome = store.import_readest_bundle(&[(target, book)], &[bundle_original(&hash)], 101, &|| false, |tx, _| { tx.commit()?; Ok(()) }).unwrap();
    assert_eq!(outcome.books_added, 0);
    assert_eq!(outcome.skipped_existing, 2);
    assert_eq!(store.snapshot().unwrap(), before);
}
#[test]
fn readest_prepared_original_rejects_wrong_digest_and_cancellation_before_publication() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("original.txt");
    std::fs::write(&path, b"hello").unwrap();
    let correct = "5d41402abc4b2a76b9719d911017c592";
    let (hash, _) = super::intake::verify_original(&path, correct, &|| false).unwrap();
    assert_eq!(hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert_eq!(super::intake::verify_original(&path, REMOTE, &|| false).unwrap_err().code, "source-mismatch");
    assert_eq!(super::intake::verify_original(&path, correct, &|| true).unwrap_err().code, "cancelled");
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn readest_bundle_repairs_a_missing_binding_without_replacing_existing_records() {
    let mut store = store();
    commit(&mut store, plan(4));
    let before = store.snapshot().unwrap();
    let mut replacement = bundle_original(HASH);
    replacement.2 = "{\"managedFileName\":\"new-copy.epub\"}".into();
    replacement.3 = store.binding_raw(HASH).unwrap();
    let result = store.import_readest_bundle(&[], &[replacement.clone()], 101, &|| false, |tx, published| {
        assert!(published.contains(HASH));
        tx.commit()?; Ok(())
    }).unwrap();
    assert_eq!(result.books_added, 0);
    assert_eq!(store.snapshot().unwrap(), before);
    assert_eq!(store.binding_raw(HASH).unwrap(), Some(replacement.2.clone()));
    // A stale repair cannot overwrite a binding another operation has since changed.
    assert_eq!(store.import_readest_bundle(&[], &[replacement], 102, &|| false, |tx, _| { tx.commit()?; Ok(()) }).unwrap_err().code, "stale-basis");
}

#[test]
fn readest_match_token_cannot_be_reused_for_another_source_identity() {
    let store = store();
    let target = store.readest_target(HASH).unwrap();
    let mut data = SessionData::default();
    let mut book = plan(3);
    data.targets.insert(HASH.into(), StoredTarget { token: book.target_token.clone(), partial_md5: REMOTE.into(), target });
    assert!(matched_target(&data, &book).is_ok());
    book.readest_hash = "d".repeat(32);
    assert_eq!(matched_target(&data, &book).err().unwrap().code, "source-mismatch");
    book.readest_hash = REMOTE.into();
    book.target_token = "old-token".into();
    assert_eq!(matched_target(&data, &book).err().unwrap().code, "stale-basis");
}
