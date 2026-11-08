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
