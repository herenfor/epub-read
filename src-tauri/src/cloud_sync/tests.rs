use super::*;
use crate::portable_state::parse_portable_state_value;
use serde_json::json;

const SPACE: &str = "00000000-0000-4000-8000-000000000010";
const A: &str = "00000000-0000-4000-8000-000000000001";
const B: &str = "00000000-0000-4000-8000-000000000002";
const C: &str = "00000000-0000-4000-8000-000000000003";
const NONCE: &str = "00000000-0000-4000-8000-000000000020";

fn empty() -> PortableStateV3 {
    parse_portable_state_value(json!({
        "schemaVersion": 3, "books": {},
        "organization": { "schemaVersion": 1, "folders": {}, "books": {} }
    }))
    .unwrap()
}

fn book(owner: &str, hash: &str, pct: u64) -> PortableStateV3 {
    parse_portable_state_value(json!({
        "schemaVersion": 3,
        "books": { hash: {
            "metadata": { "value": { "title": "Synthetic book", "creator": "Test",
                "fileName": "test.epub", "addedAtMs": 1000 },
                "stamp": { "deviceId": owner, "counter": 1 } },
            "progress": { "versions": [{
                "stamp": { "deviceId": owner, "counter": 2 }, "clock": { owner: 2 },
                "value": { "locator": { "locatorVersion": 1, "chapterPath": "Text/chapter.xhtml",
                    "spineIndexHint": 0, "target": { "kind": "chapter-start" } }, "progressPctHint": pct },
                "updatedAtMs": 1000
            }] }, "bookmarks": {}, "notes": {}
        } },
        "organization": { "schemaVersion": 1, "folders": {}, "books": {} }
    })).unwrap()
}

fn writer(id: &str) -> Writer<'_> {
    Writer {
        space_id: SPACE,
        installation_id: id,
        nonce: NONCE,
        label: "Synthetic device",
        app_version: "0.3.5",
        now_ms: 1000,
    }
}

fn file(id: &str, state: PortableStateV3) -> Vec<u8> {
    plan_round(
        &writer(id),
        None,
        &state,
        &state.books.keys().cloned().collect(),
        OwnRemote::Absent,
        &[],
    )
    .unwrap()
    .publication
    .unwrap()
}

#[test]
fn three_devices_converge_without_republishing_unchanged_state() {
    let hash = "a".repeat(64);
    let a = book(A, &hash, 20);
    let b = book(B, &hash, 70);
    let fa = file(A, a.clone());
    let fb = file(B, b.clone());
    let bounds = BTreeSet::from([hash.clone()]);
    let remotes = [
        RemoteFile {
            installation_id: B,
            json: &fb,
        },
        RemoteFile {
            installation_id: A,
            json: &fa,
        },
    ];
    let c = plan_round(
        &writer(C),
        None,
        &empty(),
        &BTreeSet::new(),
        OwnRemote::Absent,
        &remotes,
    )
    .unwrap();
    assert_eq!(c.full.books[&hash].progress.versions.len(), 2);
    assert!(!c.apply_to_local);
    let fc = c.publication.unwrap();
    let next_a = plan_round(
        &writer(A),
        None,
        &a,
        &bounds,
        OwnRemote::Present(&fa),
        &[
            RemoteFile {
                installation_id: C,
                json: &fc,
            },
            RemoteFile {
                installation_id: B,
                json: &fb,
            },
        ],
    )
    .unwrap();
    let next_b = plan_round(
        &writer(B),
        None,
        &b,
        &bounds,
        OwnRemote::Present(&fb),
        &[
            RemoteFile {
                installation_id: A,
                json: &fa,
            },
            RemoteFile {
                installation_id: C,
                json: &fc,
            },
        ],
    )
    .unwrap();
    assert_eq!(next_a.state_digest, next_b.state_digest);
    assert_eq!(next_a.full, c.full);
    assert!(next_a.apply_to_local);
    let published = next_a.publication.unwrap();
    let quiet = plan_round(
        &writer(A),
        Some(&next_a.full),
        &next_a.full,
        &bounds,
        OwnRemote::Present(&published),
        &[],
    )
    .unwrap();
    assert!(quiet.publication.is_none());
    assert!(!quiet.apply_to_local);
    let normalized = parse_device(&published, SPACE, A).unwrap();
    assert!(normalized.state.preferences.is_none());
    assert!(
        serde_json::from_slice::<serde_json::Value>(&published).unwrap()["state"]
            .get("preferences")
            .is_none()
    );
}

#[test]
fn own_cloud_history_survives_cache_loss_local_delete_and_reimport() {
    let hash = "a".repeat(64);
    let mut value = serde_json::to_value(book(A, &hash, 70)).unwrap();
    let folder = "00000000-0000-4000-8000-000000000030";
    value["organization"] = json!({ "schemaVersion": 1,
        "folders": { folder: { "name": { "value": "Synthetic folder", "stamp": { "deviceId": A, "counter": 1 } } } },
        "books": { &hash: {
            "favorite": { "value": true, "stamp": { "deviceId": A, "counter": 1 } },
            "folderId": { "value": folder, "stamp": { "deviceId": A, "counter": 1 } }
        } }
    });
    let state = parse_portable_state_value(value.clone()).unwrap();
    value["preferences"] = json!({ "theme": "dark", "fontSizePx": 22.0 });
    let with_preferences = parse_portable_state_value(value).unwrap();
    let own = file(A, with_preferences.clone());
    assert!(with_preferences.preferences.is_some());
    let recovered = plan_round(
        &writer(A),
        None,
        &empty(),
        &BTreeSet::new(),
        OwnRemote::Present(&own),
        &[],
    )
    .unwrap();
    assert_eq!(recovered.full, state);
    assert!(recovered.publication.is_none());
    assert!(!recovered.apply_to_local);
    // An older locally restored progress is superseded by the cloud event.
    let mut older = state.clone();
    let version = &mut older.books.get_mut(&hash).unwrap().progress.versions[0];
    version.stamp.counter = 1;
    version.clock.insert(A.into(), 1);
    let reimport = plan_round(
        &writer(A),
        None,
        &older,
        &BTreeSet::from([hash]),
        OwnRemote::Present(&own),
        &[],
    )
    .unwrap();
    assert_eq!(reimport.full, state);
    assert!(reimport.apply_to_local);
    assert!(reimport.publication.is_none());
    // A remembered digest must not hide a remote file that has disappeared.
    let absent = plan_round(
        &writer(A),
        Some(&state),
        &empty(),
        &BTreeSet::new(),
        OwnRemote::Absent,
        &[],
    )
    .unwrap();
    assert!(absent.publication.is_some());
}

#[test]
fn corrupt_files_are_isolated_but_future_versions_and_own_identity_block_writes() {
    let hash = "a".repeat(64);
    let good = file(B, book(B, &hash, 10));
    let input = [
        RemoteFile {
            installation_id: A,
            json: b"{broken",
        },
        RemoteFile {
            installation_id: B,
            json: &good,
        },
    ];
    let plan = plan_round(
        &writer(C),
        None,
        &empty(),
        &BTreeSet::new(),
        OwnRemote::Absent,
        &input,
    )
    .unwrap();
    assert_eq!(
        plan.issues,
        [FileIssue {
            installation_id: A.into(),
            code: SyncError::InvalidData
        }]
    );
    assert_eq!(plan.accepted_devices, [B]);
    assert!(plan.full.books.contains_key(&hash));
    for path in ["formatVersion", "stateSchemaVersion", "nestedStateVersion"] {
        let mut value: serde_json::Value = serde_json::from_slice(&good).unwrap();
        if path == "nestedStateVersion" {
            value["state"]["schemaVersion"] = json!(4);
        } else {
            value[path] = json!(99);
        }
        value["unknownFutureField"] = json!(true);
        let future = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            plan_round(
                &writer(C),
                None,
                &empty(),
                &BTreeSet::new(),
                OwnRemote::Absent,
                &[RemoteFile {
                    installation_id: B,
                    json: &future
                }]
            ),
            Err(SyncError::UnsupportedSyncVersion)
        ));
    }
    let mut conflict = writer(B);
    conflict.nonce = A;
    assert!(matches!(
        plan_round(
            &conflict,
            None,
            &empty(),
            &BTreeSet::new(),
            OwnRemote::Present(&good),
            &[]
        ),
        Err(SyncError::WriterIdentityConflict)
    ));
    assert!(matches!(
        plan_round(
            &writer(B),
            None,
            &empty(),
            &BTreeSet::new(),
            OwnRemote::Unread,
            &[]
        ),
        Err(SyncError::OwnFileUnread)
    ));
    assert!(matches!(
        plan_round(
            &writer(B),
            None,
            &empty(),
            &BTreeSet::new(),
            OwnRemote::Present(b"{broken"),
            &[]
        ),
        Err(SyncError::InvalidData)
    ));
    let mut space = json!({ "format": SPACE_FORMAT, "formatVersion": 1, "spaceId": SPACE, "createdAtMs": 1000 });
    assert!(parse_space(&serde_json::to_vec(&space).unwrap()).is_ok());
    space["formatVersion"] = json!(2);
    space["newField"] = json!(true);
    assert_eq!(
        parse_space(&serde_json::to_vec(&space).unwrap()),
        Err(SyncError::UnsupportedSyncVersion)
    );
}

#[test]
fn conflicting_remote_event_does_not_discard_other_devices() {
    let hash = "a".repeat(64);
    let first = book(A, &hash, 10);
    let mut conflicting = first.clone();
    conflicting
        .books
        .get_mut(&hash)
        .unwrap()
        .metadata
        .value
        .title = "Conflicting event".into();
    let a = file(A, first.clone());
    let b = file(B, conflicting);
    let c = file(C, book(C, &"b".repeat(64), 50));
    let me = "00000000-0000-4000-8000-000000000004";
    let plan = plan_round(
        &writer(me),
        None,
        &empty(),
        &BTreeSet::new(),
        OwnRemote::Absent,
        &[
            RemoteFile {
                installation_id: C,
                json: &c,
            },
            RemoteFile {
                installation_id: B,
                json: &b,
            },
            RemoteFile {
                installation_id: A,
                json: &a,
            },
        ],
    )
    .unwrap();
    assert_eq!(
        plan.issues,
        [FileIssue {
            installation_id: B.into(),
            code: SyncError::EventCollision
        }]
    );
    assert_eq!(plan.full.books.len(), 2);
    assert_eq!(plan.full.books[&hash], first.books[&hash]);
    assert_eq!(plan.accepted_devices, [A, C]);
    let against_local = plan_round(
        &writer(me),
        None,
        &first,
        &BTreeSet::from([hash]),
        OwnRemote::Absent,
        &[
            RemoteFile {
                installation_id: B,
                json: &b,
            },
            RemoteFile {
                installation_id: C,
                json: &c,
            },
        ],
    )
    .unwrap();
    assert_eq!(against_local.issues, plan.issues);
    assert_eq!(against_local.full, plan.full);
    assert_eq!(against_local.accepted_devices, [C]);
}
