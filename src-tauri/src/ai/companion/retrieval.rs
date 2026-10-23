//! AI experiment retrieval: apply book/chapter/version scope before ranking and limiting.
use crate::ai::{normalize_content_hash, store::read_search_hit, AiSearchHit};
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexedScope {
    hash: String,
    max_spine_index: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchInput {
    queries: Vec<String>,
    scopes: Vec<IndexedScope>,
    parser_version: String,
    normalizer_version: String,
    chunker_version: String,
}

const COLUMNS: &str = "c.content_hash, b.title, b.creator, b.language, c.chunk_id, c.spine_index,
    c.chapter_path, c.chapter_title, c.content_type, c.original_text, c.normalized_text, c.anchor_json";
const SCOPE: &str =
    "JOIN json_each(?2) allowed ON c.content_hash=json_extract(allowed.value, '$.hash')";
const FILTER: &str = "AND (json_extract(allowed.value, '$.maxSpineIndex') IS NULL
       OR c.spine_index<=json_extract(allowed.value, '$.maxSpineIndex'))
    AND b.parser_version=?3 AND b.normalizer_version=?4 AND b.chunker_version=?5";

pub(crate) fn search(
    connection: &Connection,
    mut input: SearchInput,
) -> Result<Vec<Vec<AiSearchHit>>, String> {
    if input.queries.len() > 6 {
        return Err("一次至多6条检索线索".into());
    }
    for scope in &mut input.scopes {
        scope.hash = normalize_content_hash(&scope.hash)?;
    }
    let scopes = serde_json::to_string(&input.scopes).map_err(|error| error.to_string())?;
    input.queries.iter().map(|query| {
        let terms: Vec<_> = query.split_whitespace().collect();
        if terms.is_empty() { return Ok(Vec::new()); }
        if terms.len() > 8 || query.chars().count() > 256 { return Err("请拆成较短的检索线索".into()); }
        let term_json = serde_json::to_string(&terms).map_err(|error| error.to_string())?;
        // Use trigram FTS for sufficiently long terms; keep short CJK names as literal filters.
        let indexed_terms: Vec<_> = terms.iter().filter(|term| term.chars().count() >= 3)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\""))).collect();
        let mut values = vec![Value::Text(term_json.clone()), Value::Text(scopes.clone()),
            Value::Text(input.parser_version.clone()), Value::Text(input.normalizer_version.clone()),
            Value::Text(input.chunker_version.clone())];
        let (from, predicate, order) = if indexed_terms.is_empty() {
            ("chunks c JOIN books b ON b.content_hash=c.content_hash",
             "NOT EXISTS(SELECT 1 FROM json_each(?1) term WHERE instr(c.normalized_text, term.value)=0)",
             "c.content_hash, c.spine_index, c.chunk_id")
        } else {
            values[0] = Value::Text(indexed_terms.join(" AND "));
            values.push(Value::Text(term_json));
            ("chunk_fts f JOIN chunks c ON c.content_hash=f.content_hash AND c.chunk_id=f.chunk_id
               JOIN books b ON b.content_hash=c.content_hash",
             "chunk_fts MATCH ?1 AND NOT EXISTS(SELECT 1 FROM json_each(?6) term WHERE instr(c.normalized_text, term.value)=0)",
             "bm25(chunk_fts), c.content_hash, c.spine_index, c.chunk_id")
        };
        // Only fixed SQL fragments are interpolated; query text and scopes are bound parameters.
        let sql = format!("SELECT {COLUMNS} FROM {from} {SCOPE} WHERE {predicate} {FILTER} ORDER BY {order} LIMIT 80");
        let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(values), read_search_hit).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadChapterInput {
    content_hash: String,
    chapter_path: String,
    offset: u32,
    parser_version: String,
    normalizer_version: String,
    chunker_version: String,
    around_chunk_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChapterPage {
    hits: Vec<AiSearchHit>,
    offset: u32,
    next_offset: Option<u32>,
}

pub(crate) fn read(
    connection: &Connection,
    input: ReadChapterInput,
) -> Result<ChapterPage, String> {
    let hash = normalize_content_hash(&input.content_hash)?;
    let offset = if let Some(chunk_id) = &input.around_chunk_id {
        let index: u32 = connection
            .query_row(
                "WITH ordered AS (
               SELECT c.chunk_id, ROW_NUMBER() OVER (
                 ORDER BY CAST(json_extract(c.anchor_json, '$.start') AS INTEGER), c.chunk_id
               ) - 1 AS position FROM chunks c JOIN books b ON b.content_hash=c.content_hash
               WHERE c.content_hash=?1 AND c.chapter_path=?2
                 AND b.parser_version=?3 AND b.normalizer_version=?4 AND b.chunker_version=?5
             ) SELECT position FROM ordered WHERE chunk_id=?6",
                params![
                    hash,
                    input.chapter_path,
                    input.parser_version,
                    input.normalizer_version,
                    input.chunker_version,
                    chunk_id
                ],
                |row| row.get(0),
            )
            .map_err(|_| "命中段落已失效，请重新检索".to_string())?;
        index.saturating_sub(2)
    } else {
        input.offset
    };
    let sql = format!("SELECT {COLUMNS} FROM chunks c JOIN books b ON b.content_hash=c.content_hash
        WHERE c.content_hash=?1 AND c.chapter_path=?2
          AND b.parser_version=?4 AND b.normalizer_version=?5 AND b.chunker_version=?6
        ORDER BY CAST(json_extract(c.anchor_json, '$.start') AS INTEGER), c.chunk_id LIMIT 9 OFFSET ?3");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                hash,
                input.chapter_path,
                offset,
                input.parser_version,
                input.normalizer_version,
                input.chunker_version
            ],
            read_search_hit,
        )
        .map_err(|error| error.to_string())?;
    let mut hits = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let next_offset = (hits.len() > 8).then_some(offset + 8);
    hits.truncate(8);
    Ok(ChapterPage {
        hits,
        offset,
        next_offset,
    })
}

#[cfg(test)]
mod tests;
