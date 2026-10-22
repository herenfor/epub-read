use super::*;
use crate::portable_state::{AdoptSelection, EntityRef, WriteIntent};

fn epub() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in [
        ("mimetype", b"application/epub+zip".as_slice()),
        ("META-INF/container.xml", br#"<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>"#.as_slice()),
        ("OPS/content.opf", br#"<package><metadata><title>Synthetic</title></metadata><manifest><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>"#.as_slice()),
        ("OPS/t.xhtml", b"<html><body>Synthetic</body></html>".as_slice()),
    ] {
        zip.start_file(path, zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip, bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn set_progress(app: &TestApp, hash: &str, pct: u64) {
    with_existing_store(&app.handle(), |store| {
        let (read, book) = store.read(hash)?;
        let mut value = book.unwrap().progress.versions[0].value.clone();
        value.as_mut().unwrap().progress_pct_hint = pct;
        let basis = store.adopt(
            &read,
            EntityRef::Progress {
                book_hash: hash.into(),
            },
            AdoptSelection::ShownAll,
        )?;
        store.write_progress(&basis, WriteIntent::Resolve, value, pct * 1000)?;
        Ok(())
    })
    .unwrap()
    .unwrap();
}

fn progress(app: &TestApp, hash: &str) -> u64 {
    with_existing_store(&app.handle(), |store| {
        let state = store.snapshot()?;
        assert_eq!(state.books[hash].progress.versions.len(), 1);
        Ok(state.books[hash].progress.versions[0]
            .value
            .as_ref()
            .unwrap()
            .progress_pct_hint)
    })
    .unwrap()
    .unwrap()
}

fn assert_clean(app: &TestApp, sid: &str) {
    let handle = app.handle();
    assert!(!handle
        .path()
        .app_cache_dir()
        .unwrap()
        .join("lan-save-staging")
        .join(sid)
        .exists());
    let staging = app.root.join("linked-library/books/.staging");
    if staging.exists() {
        assert_eq!(std::fs::read_dir(staging).unwrap().count(), 0);
    }
    let reservation = reserve_job(&handle, &new_uuid().unwrap()).expect("each batch releases F-N");
    finish_task(&handle, &reservation);
    assert!(
        handle
            .state::<super::super::LanSaveManager>()
            .get(sid)
            .is_ok(),
        "connection survives cleanup"
    );
}

async fn ready(a: &EventLog, b: &EventLog, old: &str) -> String {
    let first = wait_event(a, "ready", Duration::from_secs(5)).await;
    let second = wait_event(b, "ready", Duration::from_secs(5)).await;
    assert_eq!(first.summary.as_ref().unwrap()["previousTransferId"], old);
    assert_eq!(first.transfer_id, second.transfer_id);
    let next = first.transfer_id.unwrap();
    assert_ne!(next, old);
    next
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_reuse_same_connection_for_three_batches_and_reverse_direction() {
    let a = TestApp::new("reuse-host");
    let b = TestApp::new("reuse-guest");
    let bytes = epub();
    let hash = hex_digest(&bytes);
    seed_book(&a, &hash, &bytes);
    let alog = EventLog::default();
    let blog = EventLog::default();
    let ah = a.handle();
    let bh = b.handle();
    let host = start_host(&ah, Ipv4Addr::LOCALHOST, alog.sink())
        .await
        .unwrap();
    let pairing = LanPairing::parse(&host.pairing_info).unwrap();
    assert_eq!(pairing.version, 3);
    let mut wrong = pairing.clone();
    wrong.version = 2;
    assert_eq!(
        LanPairing::parse(&wrong.encode().unwrap())
            .unwrap_err()
            .code,
        "protocol-unsupported"
    );
    wrong.version = 4;
    assert_eq!(
        LanPairing::parse(&wrong.encode().unwrap())
            .unwrap_err()
            .code,
        "protocol-too-new"
    );
    join(&bh, &host.pairing_info, blog.sink()).await.unwrap();
    let sid = host.session_id;
    let external = reserve_job(&ah, &new_uuid().unwrap()).unwrap();
    assert_eq!(
        send(&ah, &sid, SaveExportScope::All, true)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    finish_task(&ah, &external);
    let mut previous = None;
    for i in 0..3 {
        let (source, receiver, receiver_log) = if i == 2 {
            (&b, &a, &alog)
        } else {
            (&a, &b, &blog)
        };
        if i > 0 {
            set_progress(source, &hash, 10 + i * 30);
        }
        let sh = source.handle();
        let sending_sid = sid.clone();
        let sending =
            tokio::spawn(async move { send(&sh, &sending_sid, SaveExportScope::All, true).await });
        let offered = wait_event(receiver_log, "offered", Duration::from_secs(5)).await;
        let tid = offered.transfer_id.unwrap();
        if let Some(expected) = previous.take() {
            assert_eq!(tid, expected);
        }
        if i == 0 {
            let external = reserve_job(&receiver.handle(), &new_uuid().unwrap()).unwrap();
            assert_eq!(
                accept(&receiver.handle(), &sid, &tid)
                    .await
                    .unwrap_err()
                    .code,
                "busy"
            );
            finish_task(&receiver.handle(), &external);
        }
        accept(&receiver.handle(), &sid, &tid).await.unwrap();
        let committed = commit(&receiver.handle(), &sid, &tid, false).await.unwrap();
        assert_eq!(committed.status, "committed");
        let result = tokio::time::timeout(Duration::from_secs(5), sending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result.status, "completed", "{result:?}");
        let next = ready(&alog, &blog, &tid).await;
        assert_eq!(progress(receiver, &hash), 10 + i * 30);
        for app in [&a, &b] {
            assert_clean(app, &sid);
        }
        // Old UI commands are rejected without consuming the current batch.
        assert_eq!(
            accept(&bh, &sid, &tid).await.unwrap_err().code,
            "invalid-state"
        );
        assert_eq!(
            commit(&bh, &sid, &tid, false).await.unwrap_err().code,
            "invalid-state"
        );
        // A delayed terminal frame cannot terminate a later batch or repaint
        // it as complete. Real TCP framing is used, not a mocked dispatcher.
        ah.state::<super::super::LanSaveManager>()
            .get(&sid)
            .unwrap()
            .connection()
            .unwrap()
            .write_control(&super::super::protocol::ControlMessage::Cancel {
                session_id: sid.clone(),
                transfer_id: tid,
                reason: "old batch".into(),
            })
            .await
            .unwrap();
        previous = Some(next);
    }
    assert_eq!(
        std::fs::read(b.root.join(format!("linked-library/books/{hash}.epub"))).unwrap(),
        bytes
    );
    close(&ah, &sid).await.unwrap();
    close(&bh, &sid).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_reuse_decline_and_preview_cancel_release_files_without_repairing() {
    let a = TestApp::new("reuse-cancel-host");
    let b = TestApp::new("reuse-cancel-guest");
    let bytes = epub();
    seed_book(&a, &hex_digest(&bytes), &bytes);
    let ah = a.handle();
    let bh = b.handle();
    let alog = EventLog::default();
    let blog = EventLog::default();
    let host = start_host(&ah, Ipv4Addr::LOCALHOST, alog.sink())
        .await
        .unwrap();
    join(&bh, &host.pairing_info, blog.sink()).await.unwrap();
    let sid = host.session_id;
    for preview in [false, true] {
        let sh = ah.clone();
        let id = sid.clone();
        let sending = tokio::spawn(async move { send(&sh, &id, SaveExportScope::All, true).await });
        let offer = wait_event(&blog, "offered", Duration::from_secs(5)).await;
        let tid = offer.transfer_id.unwrap();
        if preview {
            accept(&bh, &sid, &tid).await.unwrap();
        }
        let cancelled = super::super::manager::cancel_transfer(&bh, &sid, &tid)
            .await
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), sending)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .status,
            "cancelled"
        );
        ready(&alog, &blog, &tid).await;
        assert!(snapshot_books(&b).is_empty());
        for app in [&a, &b] {
            assert_clean(app, &sid);
        }
    }
    close(&ah, &sid).await.unwrap();
    close(&bh, &sid).await.unwrap();
}
