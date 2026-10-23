use super::*;
use crate::ai::{store::AiStore, AiIndexBookInput, AiIndexChunkInput};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn fixture() -> (AiStore, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "epub-companion-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    (AiStore::open(&path).unwrap(), path)
}
fn chunk(id: &str, spine: u32, text: &str) -> AiIndexChunkInput {
    AiIndexChunkInput {
        chunk_id: id.into(),
        spine_index: spine,
        chapter_path: "c.xhtml".into(),
        chapter_title: Some("章".into()),
        content_type: "paragraph".into(),
        original_text: text.into(),
        normalized_text: text.into(),
        anchor_json: r#"{"start":0,"end":12,"snippet":"测试"}"#.into(),
    }
}
fn book(hash: char, chunks: Vec<AiIndexChunkInput>) -> AiIndexBookInput {
    AiIndexBookInput {
        content_hash: hash.to_string().repeat(64),
        title: "书".into(),
        creator: "作者".into(),
        language: None,
        parser_version: "p1".into(),
        normalizer_version: "n1".into(),
        chunker_version: "c1".into(),
        chunks,
    }
}
fn input(queries: &[&str]) -> SearchInput {
    SearchInput {
        queries: queries.iter().map(|query| query.to_string()).collect(),
        scopes: vec![IndexedScope {
            hash: "b".repeat(64),
            max_spine_index: Some(1),
        }],
        parser_version: "p1".into(),
        normalizer_version: "n1".into(),
        chunker_version: "c1".into(),
    }
}
#[test]
fn scope_is_applied_before_top_k_for_unread_and_unavailable_books() {
    let (store, root) = fixture();
    store
        .replace_book_index(book(
            'a',
            (0..100)
                .map(|i| chunk(&format!("outside-{i}"), 0, "测试线索"))
                .collect(),
        ))
        .unwrap();
    let mut chunks: Vec<_> = (0..100)
        .map(|i| chunk(&format!("unread-{i}"), 9, "测试线索"))
        .collect();
    chunks.push(chunk("z-allowed", 1, "测试线索"));
    store.replace_book_index(book('b', chunks)).unwrap();
    let result = store
        .with_connection(|connection| search(connection, input(&["测试线索"])))
        .unwrap();
    assert_eq!(result[0].len(), 1);
    assert_eq!(result[0][0].chunk_id, "z-allowed");
    let mut stale = input(&["测试线索"]);
    stale.parser_version = "old".into();
    assert!(store
        .with_connection(|connection| search(connection, stale))
        .unwrap()[0]
        .is_empty());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn compound_terms_keep_short_names_and_long_phrases_in_the_same_passage() {
    let (store, root) = fixture();
    store
        .replace_book_index(book(
            'b',
            vec![
                chunk("both", 1, "甲决定离开，因为约定的归期已到。"),
                chunk("name-only", 1, "甲留下照顾花园。"),
                chunk("action-only", 1, "乙决定离开小镇。"),
            ],
        ))
        .unwrap();
    let result = store
        .with_connection(|connection| search(connection, input(&["甲 离开", "甲 约定的归期"])))
        .unwrap();
    for list in result {
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].chunk_id, "both");
    }
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
