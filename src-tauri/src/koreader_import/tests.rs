use super::state::*;
use crate::readest_import::ImportScope;
use crate::{
    native_zip_session::Fault,
    portable_state::*,
    readest_import::source::{self, Guard},
};
use serde_json::json;
use std::sync::Arc;

const ID: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn active() -> Arc<Session> {
    KoreaderImportState::default()
        .reserve(ID.into(), ImportScope::Public)
        .unwrap()
}

fn store_with(progress: serde_json::Value) -> PortableStore {
    let state = serde_json::from_value(json!({
        "schemaVersion": 3,
        "books": { HASH: {
            "metadata": {"value": {"title": "Synthetic", "creator": "", "fileName": "book.epub", "addedAtMs": 1}, "stamp": {"deviceId": ID, "counter": 1}},
            "progress": progress,
            "bookmarks": {},
            "notes": {}
        }},
        "organization": {"schemaVersion": 1, "folders": {}, "books": {}}
    }))
    .unwrap();
    let mut store = PortableStore::open_in_memory().unwrap();
    store
        .merge_validated_import(state, vec![(HASH.into(), "{}".into())], false)
        .unwrap();
    store
}

fn store() -> PortableStore {
    store_with(json!({"versions": []}))
}

fn progress(offset: u64, hint: u64) -> Progress {
    serde_json::from_value(json!({
        "locator": {
            "locatorVersion": 1,
            "chapterPath": "OEBPS/Text/c2.xhtml",
            "spineIndexHint": 1,
            "target": {"kind": "text", "textProfile": TEXT_PROFILE, "offset": offset, "snippet": "同一句话。"}
        },
        "progressPctHint": hint
    }))
    .unwrap()
}

fn book(offset: u64, hint: u64) -> KoreaderProgressImport {
    KoreaderProgressImport {
        book_hash: HASH.into(),
        target_token: "token".into(),
        progress: progress(offset, hint),
    }
}

fn commit(store: &mut PortableStore, offset: u64, hint: u64) -> KoreaderProgressOutcome {
    let target = store.readest_target(HASH).unwrap();
    let session = active();
    store
        .import_koreader_progress(&target, &book(offset, hint), 100, &|| false, |tx| {
            session.finish(tx, &|| true, &[])
        })
        .unwrap()
}

fn hint_of(store: &PortableStore) -> u64 {
    store.snapshot().unwrap().books[HASH].progress.versions[0]
        .value
        .as_ref()
        .unwrap()
        .progress_pct_hint
}

#[test]
fn koreader_sidecar_read_is_bounded_and_does_not_execute_lua() {
    let dir = std::env::temp_dir().join(format!(
        "koreader-sidecar-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("metadata.epub.lua");
    let script = b"os.execute(\"rm\")";
    std::fs::write(&path, script).unwrap();
    let (bytes, guard) = source::read_bounded_file(&path, 64, &|| false).unwrap();
    assert_eq!(bytes, script);
    std::fs::write(&path, b"changed-sidecar").unwrap();
    assert!(matches!(guard().unwrap_err(), Fault::SourceChanged));
    std::fs::write(&path, b"12345").unwrap();
    assert!(matches!(
        source::read_bounded_file(&path, 4, &|| false),
        Err(err) if err.code == "too-large"
    ));
    assert!(matches!(
        source::read_bounded_file(&path, 64, &|| true),
        Err(err) if err.code == "cancelled"
    ));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn koreader_progress_commit_is_idempotent_for_the_same_locator() {
    let mut store = store();
    assert_eq!(commit(&mut store, 11, 10).progress_written, 1);
    assert_eq!(
        store.snapshot().unwrap().books[HASH].progress.versions.len(),
        1
    );
    assert_eq!(hint_of(&store), 10);
    assert_eq!(commit(&mut store, 11, 99).progress_unchanged, 1);
    assert_eq!(
        store.snapshot().unwrap().books[HASH].progress.versions.len(),
        1
    );
    assert_eq!(hint_of(&store), 10);
}

#[test]
fn koreader_cancel_and_source_change_do_not_write() {
    let mut store = store();
    let target = store.readest_target(HASH).unwrap();
    let before = store.snapshot().unwrap();
    let counter = store.reserve_stamps(1).unwrap().counter;
    let session = active();
    let cancelled = store.import_koreader_progress(&target, &book(11, 0), 100, &|| false, |tx| {
        assert_eq!(session.close()?, "closed");
        session.finish(tx, &|| true, &[])
    });
    assert_eq!(cancelled.unwrap_err().code, "cancelled");
    assert_eq!(store.snapshot().unwrap(), before);
    assert_eq!(store.reserve_stamps(1).unwrap().counter, counter + 1);

    commit(&mut store, 11, 0);
    let written = store.snapshot().unwrap();
    let target = store.readest_target(HASH).unwrap();
    let session = active();
    let guard: Guard = Arc::new(|| Err(Fault::SourceChanged));
    let changed = store.import_koreader_progress(&target, &book(12, 0), 200, &|| false, |tx| {
        session.finish(tx, &|| true, &[guard])
    });
    assert_eq!(changed.unwrap_err().code, "source-changed");
    assert_eq!(store.snapshot().unwrap(), written);
}

#[test]
fn koreader_live_reader_and_existing_conflict_do_not_write() {
    let mut store = store();
    let (read, _) = store.read(HASH).unwrap();
    store
        .adopt(
            &read,
            EntityRef::Progress {
                book_hash: HASH.into(),
            },
            AdoptSelection::Empty,
        )
        .unwrap();
    let target = store.readest_target(HASH).unwrap();
    let session = active();
    assert_eq!(
        store
            .import_koreader_progress(&target, &book(11, 0), 100, &|| false, |tx| {
                session.finish(tx, &|| true, &[])
            })
            .unwrap_err()
            .code,
        "reader-busy"
    );

    let mut conflicted = store_with(json!({"versions": [
        {"stamp": {"deviceId": ID, "counter": 1}, "clock": {ID: 1}, "value": {"locator": {"locatorVersion": 1, "chapterPath": "OEBPS/Text/c2.xhtml", "spineIndexHint": 1, "target": {"kind": "text", "textProfile": TEXT_PROFILE, "offset": 1, "snippet": "a"}}, "progressPctHint": 10}, "updatedAtMs": 1},
        {"stamp": {"deviceId": OTHER, "counter": 1}, "clock": {OTHER: 1}, "value": {"locator": {"locatorVersion": 1, "chapterPath": "OEBPS/Text/c2.xhtml", "spineIndexHint": 1, "target": {"kind": "text", "textProfile": TEXT_PROFILE, "offset": 2, "snippet": "b"}}, "progressPctHint": 90}, "updatedAtMs": 1}
    ]}));
    let before = conflicted.snapshot().unwrap();
    assert!(conflicted.readest_target(HASH).unwrap().progress.conflict);
    let target = conflicted.readest_target(HASH).unwrap();
    let session = active();
    assert_eq!(
        conflicted
            .import_koreader_progress(&target, &book(11, 90), 100, &|| false, |tx| {
                session.finish(tx, &|| true, &[])
            })
            .unwrap_err()
            .code,
        "progress-conflict"
    );
    assert_eq!(conflicted.snapshot().unwrap(), before);
    assert_eq!(before.books[HASH].progress.versions.len(), 2);
}

#[test]
fn koreader_commit_rejects_a_stale_token_and_foreign_fields() {
    let preview = store();
    let target = preview.readest_target(HASH).unwrap();
    let mut data = SessionData::default();
    let unread = accept_commit(&data, &book(11, 0));
    assert!(matches!(unread, Err(err) if err.code == "invalid-request"));
    data.fetched = true;
    data.targets.insert(
        HASH.into(),
        StoredTarget {
            token: "token".into(),
            target,
        },
    );
    let stale = accept_commit(
        &data,
        &KoreaderProgressImport {
            book_hash: HASH.into(),
            target_token: "old".into(),
            progress: progress(11, 0),
        },
    );
    assert!(matches!(stale, Err(err) if err.code == "stale-basis"));

    let locator = json!({"locatorVersion": 1, "chapterPath": "OEBPS/Text/c2.xhtml", "spineIndexHint": 1, "target": {"kind": "text", "textProfile": TEXT_PROFILE, "offset": 11, "snippet": "同一句话。"}});
    let mut value = json!({"bookHash": HASH, "targetToken": "token", "progress": {"locator": locator, "progressPctHint": 0}});
    assert!(serde_json::from_value::<KoreaderProgressImport>(value.clone()).is_ok());
    value["progress"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<KoreaderProgressImport>(value.clone()).is_err());
    value["stamp"] = json!({"deviceId": ID, "counter": 9});
    value["docPath"] = json!("/tmp/book.epub");
    assert!(serde_json::from_value::<KoreaderProgressImport>(value).is_err());

    let mut fresh = store();
    let legacy = serde_json::from_value(json!({
        "bookHash": HASH,
        "targetToken": "token",
        "progress": {"locator": {"locatorVersion": 0, "spineIndex": 0, "pageHint": 3, "anchorIndex": null, "anchorRatio": null, "anchorTextOffset": null, "anchorTextSnippet": null, "mediaAnchor": null}, "progressPctHint": 40}
    }))
    .unwrap();
    let target = fresh.readest_target(HASH).unwrap();
    let session = active();
    assert_eq!(
        fresh
            .import_koreader_progress(&target, &legacy, 100, &|| false, |tx| {
                session.finish(tx, &|| true, &[])
            })
            .unwrap_err()
            .code,
        "unsupported-locator"
    );
}
