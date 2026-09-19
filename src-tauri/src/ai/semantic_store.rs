//! Real semantic index storage: recoverable per-book jobs, atomic published
//! generations and bounded snapshot reads.
//!
//! Additive `semantic_*` tables only.  This module never reinterprets
//! `PRAGMA user_version` and never touches the mock preparation tables, the
//! full-text index, bookmarks or the user's EPUB.  TypeScript decides *what*
//! to embed; Rust re-validates row count, vector shape, corpus identity and
//! generation fencing so a buggy or hostile front end cannot publish a mixed
//! or partial generation.
use super::{normalize_content_hash, AiStore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumping this refuses to reinterpret old component rows instead of guessing.
const COMPONENT_VERSION: u32 = 1;
const LEASE_MS: i64 = 30_000;
/// Hard bounds shared with the TypeScript pipeline.
const MAX_BATCH_ROWS: usize = 32;
const MAX_BATCH_BYTES: usize = 512 * 1024;
const MAX_BOOK_ROWS: i64 = 100_000;
const MAX_BOOK_BYTES: i64 = 128 * 1024 * 1024;
const MAX_VECTOR_DIMENSIONS: usize = 4096;
/// Query-time cursor pages must stay small enough for one IPC round trip.
const MAX_SNAPSHOT_ROWS: i64 = 32;
const MAX_TEXT_BYTES: usize = 16 * 1024;
/// A crashed snapshot pin is reclaimed after this long.
const SNAPSHOT_PIN_MS: i64 = 600_000;

fn db<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|e| format!("语义索引存储失败：{e}"))
}

/// Output-affecting identity of the embedding profile.  Field order is part of
/// the encoding: the TypeScript `profileKey` serializes the same order, and the
/// two keys must match byte for byte or a build is refused.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EmbeddingProfile {
    pub model_id: String,
    pub model_digest: String,
    pub tokenizer_digest: String,
    pub runtime_version: String,
    pub dimensions: usize,
    pub max_tokens: usize,
    pub pooling: String,
    pub normalization: String,
    pub query_prefix: String,
    pub passage_prefix: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SemanticManifest {
    pub component_version: u32,
    pub book_fingerprint: String,
    pub parser_version: String,
    pub normalizer_version: String,
    pub chunker_version: String,
    pub profile: EmbeddingProfile,
}

/// Batch boundaries are part of the recoverable job identity: resuming must
/// split the corpus exactly like the interrupted run did, so an old checkpoint
/// can never be re-used with different boundaries.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BatchPolicy {
    pub max_rows: usize,
    pub max_tokens: usize,
    pub max_bytes: usize,
}

impl BatchPolicy {
    fn validate(&self) -> Result<(), String> {
        if self.max_rows < 1
            || self.max_rows > MAX_BATCH_ROWS
            || self.max_tokens < 1
            || self.max_tokens > 8192
            || self.max_bytes < 1
            || self.max_bytes > MAX_BATCH_BYTES
        {
            return Err("语义批次规则越界".into());
        }
        Ok(())
    }
}

impl EmbeddingProfile {
    fn validate(&self) -> Result<(), String> {
        if !is_digest(&self.model_digest) || !is_digest(&self.tokenizer_digest) {
            return Err("模型或 tokenizer 摘要无效".into());
        }
        if !valid_text(&self.model_id, 128) || !valid_text(&self.runtime_version, 128) {
            return Err("模型标识或运行库版本无效".into());
        }
        if self.dimensions < 1
            || self.dimensions > MAX_VECTOR_DIMENSIONS
            || self.max_tokens < 2
            || self.max_tokens > 8192
        {
            return Err("向量维度或最大 token 无效".into());
        }
        if !["cls", "mean"].contains(&self.pooling.as_str()) || self.normalization != "l2" {
            return Err("不支持的 pooling 策略".into());
        }
        for prefix in [&self.query_prefix, &self.passage_prefix] {
            if prefix.chars().count() > 1024 {
                return Err("检索前缀过长".into());
            }
        }
        Ok(())
    }
}

impl SemanticManifest {
    fn validate(&self) -> Result<(), String> {
        if self.component_version != COMPONENT_VERSION {
            return Err("不支持的语义组件版本，未修改数据".into());
        }
        if normalize_content_hash(&self.book_fingerprint)? != self.book_fingerprint {
            return Err("需要规范化书籍指纹".into());
        }
        for value in [
            &self.parser_version,
            &self.normalizer_version,
            &self.chunker_version,
        ] {
            if !valid_text(value, 128) {
                return Err("无效语料版本".into());
            }
        }
        self.profile.validate()
    }

    fn encoded(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("manifest 序列化失败：{e}"))
    }
}

fn valid_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(|c| c.is_control())
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn owner_valid(owner: &str) -> Result<(), String> {
    if owner.len() < 8
        || owner.len() > 128
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("无效任务 owner".into());
    }
    Ok(())
}

/// One row exactly as the TypeScript pipeline produced it after validation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SemanticRow {
    pub ordinal: i64,
    pub chunk: Value,
    pub vector: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Request {
    Begin {
        manifest: SemanticManifest,
        manifest_key: String,
        owner: String,
        corpus_digest: String,
        policy: BatchPolicy,
        force: bool,
    },
    Append {
        book: String,
        owner: String,
        sequence: i64,
        rows: Vec<SemanticRow>,
    },
    Replay {
        book: String,
        owner: String,
        sequence: i64,
        chunks: Vec<Value>,
    },
    Heartbeat {
        book: String,
        owner: String,
    },
    Pause {
        book: String,
        owner: String,
    },
    Commit {
        book: String,
        owner: String,
        batches: i64,
        total: i64,
    },
    Status {
        book: String,
    },
    /// Pins one published generation while the caller reads it in pages.
    OpenSnapshot {
        book: String,
    },
    ReadSnapshot {
        book: String,
        generation: i64,
        after: i64,
        limit: i64,
    },
    CloseSnapshot {
        book: String,
        generation: i64,
    },
    /// Book-scoped cleanup.  Fails while another session still owns the job.
    Clear {
        book: String,
        owner: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobState {
    pub owner: String,
    pub manifest_key: String,
    pub corpus_digest: String,
    pub next_batch: i64,
    pub staged_rows: i64,
    pub staged_bytes: i64,
    pub complete: bool,
    /// Present only when a job exists, so the caller can verify identity.
    pub manifest: Option<SemanticManifest>,
    pub policy: Option<BatchPolicy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationState {
    pub generation: i64,
    pub total: i64,
    pub manifest_key: String,
    pub manifest: SemanticManifest,
    pub published_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotPage {
    pub generation: i64,
    pub manifest: SemanticManifest,
    pub manifest_key: String,
    /// Total rows in the pinned generation.  The caller re-checks it on every
    /// page so a rebuild cannot silently change what it is reading.
    pub total: i64,
    pub rows: Vec<SemanticRow>,
    /// True once this page reached the end of the generation.
    pub done: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub schema: u32,
    pub supported_schema: u32,
    pub component_version: u32,
    pub busy_timeout_ms: u32,
    pub job: Option<JobState>,
    pub published: Option<GenerationState>,
    pub generations: Vec<GenerationState>,
    pub snapshot: Option<SnapshotPage>,
    /// Restored corpus for a replayed batch; never serialized to the front end.
    #[serde(skip)]
    pub(crate) chunks: Vec<Value>,
}

impl Reply {
    fn empty(connection: &Connection) -> Result<Self, String> {
        Ok(Self {
            schema: db(connection.query_row("PRAGMA user_version", [], |r| r.get(0)))?,
            supported_schema: super::MAX_SUPPORTED_SCHEMA_VERSION as u32,
            component_version: COMPONENT_VERSION,
            busy_timeout_ms: db(connection.query_row("PRAGMA busy_timeout", [], |r| r.get(0)))?,
            job: None,
            published: None,
            generations: Vec::new(),
            snapshot: None,
            chunks: Vec::new(),
        })
    }
}

fn initialize(connection: &mut Connection) -> Result<(), String> {
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    db(tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS semantic_components (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
         INSERT OR IGNORE INTO semantic_components VALUES ('semantic-index',1);
         CREATE TABLE IF NOT EXISTS semantic_jobs (
            book TEXT PRIMARY KEY, manifest TEXT NOT NULL, manifest_key TEXT NOT NULL,
            owner TEXT NOT NULL, lease_until INTEGER NOT NULL, corpus_digest TEXT NOT NULL,
            policy TEXT NOT NULL, next_batch INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS semantic_staging (
            book TEXT NOT NULL, ordinal INTEGER NOT NULL, batch INTEGER NOT NULL,
            chunk_id TEXT NOT NULL, chunk TEXT NOT NULL, vector TEXT NOT NULL,
            bytes INTEGER NOT NULL, PRIMARY KEY(book,batch,ordinal), UNIQUE(book,batch,chunk_id));
         CREATE TABLE IF NOT EXISTS semantic_generations (
            book TEXT NOT NULL, generation INTEGER NOT NULL, manifest TEXT NOT NULL,
            manifest_key TEXT NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(book,generation));
         CREATE TABLE IF NOT EXISTS semantic_vectors (
            book TEXT NOT NULL, generation INTEGER NOT NULL, ordinal INTEGER NOT NULL,
            chunk_id TEXT NOT NULL, chunk TEXT NOT NULL, vector TEXT NOT NULL,
            bytes INTEGER NOT NULL, PRIMARY KEY(book,generation,ordinal),
            FOREIGN KEY(book,generation) REFERENCES semantic_generations(book,generation) ON DELETE CASCADE);
         CREATE INDEX IF NOT EXISTS semantic_vectors_chunk
            ON semantic_vectors(book,generation,chunk_id);
         CREATE TABLE IF NOT EXISTS semantic_snapshots (
            book TEXT NOT NULL, generation INTEGER NOT NULL, pinned_at INTEGER NOT NULL,
            PRIMARY KEY(book,generation));",
    ))?;
    let version: u32 = db(tx.query_row(
        "SELECT version FROM semantic_components WHERE id='semantic-index'",
        [],
        |r| r.get(0),
    ))?;
    if version != COMPONENT_VERSION {
        return Err("不支持的语义组件版本，未修改数据".into());
    }
    // Snapshot pins are process-local.  A crashed session must not retain a
    // generation forever, so stale pins are dropped at open time.
    let stale_before = now_ms()? - SNAPSHOT_PIN_MS;
    db(tx.execute(
        "DELETE FROM semantic_snapshots WHERE pinned_at < ?1",
        [stale_before],
    ))?;
    db(tx.commit())
}

fn now_ms() -> Result<i64, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64)
}

fn manifest_from(encoded: &str) -> Result<SemanticManifest, String> {
    let manifest: SemanticManifest =
        serde_json::from_str(encoded).map_err(|e| format!("manifest 已损坏：{e}"))?;
    manifest.validate()?;
    Ok(manifest)
}

fn policy_from(encoded: &str) -> Result<BatchPolicy, String> {
    let policy: BatchPolicy =
        serde_json::from_str(encoded).map_err(|e| format!("批次规则已损坏：{e}"))?;
    policy.validate()?;
    Ok(policy)
}

/// Validates one chunk JSON value against the manifest and returns
/// `(chunkId, canonical-json, bytes)`.
fn validate_chunk(
    chunk: &Value,
    manifest: &SemanticManifest,
) -> Result<(String, String, i64), String> {
    for (key, expected) in [
        ("bookFingerprint", manifest.book_fingerprint.as_str()),
        ("parserVersion", manifest.parser_version.as_str()),
        ("normalizerVersion", manifest.normalizer_version.as_str()),
        ("chunkerVersion", manifest.chunker_version.as_str()),
    ] {
        if chunk[key].as_str() != Some(expected) {
            return Err("正文块与语义索引身份不一致".into());
        }
    }
    for field in ["chunkId", "chapterPath", "originalText", "normalizedText"] {
        let text = chunk[field].as_str().ok_or("正文块字段缺失")?;
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err("正文块字段超限".into());
        }
    }
    let path = chunk["chapterPath"].as_str().unwrap();
    if path.starts_with('/') || path.contains('\\') || path.split('/').any(|p| p == "..") {
        return Err("无效章节路径".into());
    }
    let anchor = chunk
        .get("textAnchor")
        .ok_or_else(|| "正文块缺少文本锚点".to_string())?;
    let start = anchor["start"].as_u64().ok_or("文本锚点缺失")?;
    let end = anchor["end"].as_u64().ok_or("文本锚点缺失")?;
    if start > end
        || end > 1_000_000_000
        || chunk["spineIndex"]
            .as_u64()
            .filter(|v| *v < 1_000_000)
            .is_none()
        || anchor["snippet"]
            .as_str()
            .filter(|s| !s.is_empty() && s.chars().count() <= 32)
            .is_none()
    {
        return Err("文本锚点无效".into());
    }
    let chunk_id = chunk["chunkId"].as_str().unwrap().to_owned();
    let encoded = chunk.to_string();
    Ok((chunk_id, encoded.clone(), encoded.len() as i64))
}

fn validate_vector(vector: &[f64], dimensions: usize) -> Result<String, String> {
    if vector.len() != dimensions
        || vector
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 1.0)
    {
        return Err("向量维度或数值无效".into());
    }
    serde_json::to_string(vector).map_err(|e| format!("向量序列化失败：{e}"))
}

/// Owner+lease fencing.  An expired lease can never keep writing.
struct Owned {
    manifest: SemanticManifest,
    next_batch: i64,
    total: i64,
    bytes: i64,
    policy: BatchPolicy,
}

fn owned(connection: &Connection, book: &str, owner: &str, now: i64) -> Result<Owned, String> {
    let row = db(connection
        .query_row(
            "SELECT manifest,policy,next_batch,total,bytes FROM semantic_jobs
             WHERE book=?1 AND owner=?2 AND lease_until>?3",
            params![book, owner, now],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional())?
    .ok_or("任务租约已失效或属于其他会话")?;
    Ok(Owned {
        manifest: manifest_from(&row.0)?,
        policy: policy_from(&row.1)?,
        next_batch: row.2,
        total: row.3,
        bytes: row.4,
    })
}

fn job_state(connection: &Connection, book: &str) -> Result<Option<JobState>, String> {
    let row = db(connection
        .query_row(
            "SELECT manifest,manifest_key,owner,corpus_digest,policy,next_batch,total,bytes
             FROM semantic_jobs WHERE book=?1",
            [book],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            },
        )
        .optional())?;
    let Some(row) = row else { return Ok(None) };
    let manifest = manifest_from(&row.0)?;
    let policy = policy_from(&row.4)?;
    // Published jobs are deleted at commit. Every persisted job is unfinished,
    // including a paused rebuild that still has an older published generation.
    let complete = false;
    Ok(Some(JobState {
        owner: row.2,
        manifest_key: row.1,
        corpus_digest: row.3,
        next_batch: row.5,
        staged_rows: row.6,
        staged_bytes: row.7,
        complete,
        manifest: Some(manifest),
        policy: Some(policy),
    }))
}

fn generation_state(
    connection: &Connection,
    book: &str,
) -> Result<Option<GenerationState>, String> {
    let row = db(connection
        .query_row(
            "SELECT generation,manifest,manifest_key,total,updated_at FROM semantic_generations
             WHERE book=?1 ORDER BY generation DESC LIMIT 1",
            [book],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional())?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(GenerationState {
        generation: row.0,
        total: row.3,
        manifest_key: row.2,
        manifest: manifest_from(&row.1)?,
        published_at_ms: row.4,
    }))
}

fn generations(connection: &Connection, book: &str) -> Result<Vec<GenerationState>, String> {
    let mut statement = db(connection.prepare(
        "SELECT generation,manifest,manifest_key,total,updated_at FROM semantic_generations
         WHERE book=?1 ORDER BY generation DESC",
    ))?;
    let rows = db(statement.query_map([book], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    }))?;
    let mut result = Vec::new();
    for row in rows {
        let row = db(row)?;
        result.push(GenerationState {
            generation: row.0,
            total: row.3,
            manifest_key: row.2,
            manifest: manifest_from(&row.1)?,
            published_at_ms: row.4,
        });
    }
    Ok(result)
}

fn pinned(connection: &Connection, book: &str) -> Result<Vec<i64>, String> {
    let mut statement =
        db(connection.prepare("SELECT generation FROM semantic_snapshots WHERE book=?1"))?;
    let rows = db(statement.query_map([book], |r| r.get::<_, i64>(0)))?;
    let mut pins = Vec::new();
    for row in rows {
        pins.push(db(row)?);
    }
    Ok(pins)
}

/// Reclaims every generation strictly behind `keep` for this book once no
/// snapshot still pins it.  Callers hold the write transaction.
fn reclaim_behind(connection: &Connection, book: &str, keep: i64) -> Result<(), String> {
    let pins = pinned(connection, book)?;
    let stale: Vec<i64> = {
        let mut statement = db(connection.prepare(
            "SELECT generation FROM semantic_generations WHERE book=?1 AND generation<?2",
        ))?;
        let rows = db(statement.query_map(params![book, keep], |r| r.get::<_, i64>(0)))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(db(row)?);
        }
        ids
    };
    for generation in stale {
        if pins.contains(&generation) {
            continue;
        }
        db(connection.execute(
            "DELETE FROM semantic_vectors WHERE book=?1 AND generation=?2",
            params![book, generation],
        ))?;
        db(connection.execute(
            "DELETE FROM semantic_generations WHERE book=?1 AND generation=?2",
            params![book, generation],
        ))?;
    }
    Ok(())
}

impl AiStore {
    pub(crate) fn semantic(&self, input: Request) -> Result<Reply, String> {
        let now = now_ms()?;
        self.with_connection(|connection| dispatch(connection, input, now))
    }
}

fn book_of(input: &Request) -> Result<String, String> {
    let book = match input {
        Request::Begin { manifest, .. } => manifest.book_fingerprint.clone(),
        Request::Append { book, .. }
        | Request::Replay { book, .. }
        | Request::Heartbeat { book, .. }
        | Request::Pause { book, .. }
        | Request::Commit { book, .. }
        | Request::Status { book }
        | Request::OpenSnapshot { book }
        | Request::ReadSnapshot { book, .. }
        | Request::CloseSnapshot { book, .. }
        | Request::Clear { book, .. } => book.clone(),
    };
    if normalize_content_hash(&book)? != book {
        return Err("需要规范化书籍指纹".into());
    }
    Ok(book)
}

fn validate_request(input: &Request) -> Result<(), String> {
    match input {
        Request::Begin {
            manifest,
            manifest_key,
            owner,
            corpus_digest,
            policy,
            ..
        } => {
            manifest.validate()?;
            if !is_digest(manifest_key) || !is_digest(corpus_digest) {
                return Err("索引身份摘要无效".into());
            }
            owner_valid(owner)?;
            policy.validate()
        }
        Request::Append { owner, rows, .. } => {
            owner_valid(owner)?;
            if rows.is_empty() || rows.len() > MAX_BATCH_ROWS {
                return Err("语义批次越界".into());
            }
            Ok(())
        }
        Request::Replay { owner, chunks, .. } => {
            owner_valid(owner)?;
            if chunks.is_empty() || chunks.len() > MAX_BATCH_ROWS {
                return Err("恢复批次越界".into());
            }
            Ok(())
        }
        Request::Heartbeat { owner, .. }
        | Request::Pause { owner, .. }
        | Request::Commit { owner, .. } => owner_valid(owner),
        Request::Clear { owner, .. } => owner_valid(owner),
        Request::ReadSnapshot { limit, after, .. } => {
            if *limit < 1 || *limit > MAX_SNAPSHOT_ROWS || *after < 0 {
                return Err("快照游标越界".into());
            }
            Ok(())
        }
        Request::Status { .. } | Request::OpenSnapshot { .. } | Request::CloseSnapshot { .. } => {
            Ok(())
        }
    }
}

fn append(
    tx: &Connection,
    book: &str,
    owner: &str,
    sequence: i64,
    rows: Vec<SemanticRow>,
    now: i64,
) -> Result<(), String> {
    let state = owned(tx, book, owner, now)?;
    if sequence != state.next_batch || rows.len() > state.policy.max_rows {
        return Err("语义批次顺序或数量无效".into());
    }
    let mut staged = Vec::with_capacity(rows.len());
    let mut batch_bytes = 0i64;
    let mut ids = std::collections::HashSet::new();
    for (index, row) in rows.iter().enumerate() {
        let ordinal = state.total + index as i64;
        if row.ordinal != ordinal {
            return Err("语义批次序号不连续".into());
        }
        let (chunk_id, chunk, chunk_bytes) = validate_chunk(&row.chunk, &state.manifest)?;
        if !ids.insert(chunk_id.clone()) {
            return Err("批次正文块重复".into());
        }
        let vector = validate_vector(&row.vector, state.manifest.profile.dimensions)?;
        let row_bytes = chunk_bytes + vector.len() as i64 + chunk_id.len() as i64;
        batch_bytes += row_bytes;
        staged.push((ordinal, chunk_id, chunk, vector, row_bytes));
    }
    // Per-batch token budget is enforced by the caller with the native
    // tokenizer; Rust enforces the byte ceiling it can verify on its own.
    if batch_bytes > state.policy.max_bytes as i64
        || state.bytes + batch_bytes > MAX_BOOK_BYTES
        || state.total + staged.len() as i64 > MAX_BOOK_ROWS
    {
        return Err("语义索引容量超限".into());
    }
    for (ordinal, chunk_id, chunk, vector, row_bytes) in staged.iter() {
        db(tx.execute(
            "INSERT INTO semantic_staging VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![book, ordinal, sequence, chunk_id, chunk, vector, row_bytes],
        ))?;
    }
    db(tx.execute(
        "UPDATE semantic_jobs SET next_batch=next_batch+1,total=total+?2,bytes=bytes+?3,lease_until=?4
         WHERE book=?1",
        params![book, staged.len() as i64, batch_bytes, now + LEASE_MS],
    ))?;
    Ok(())
}

fn replay(
    tx: &Connection,
    book: &str,
    owner: &str,
    sequence: i64,
    chunks: Vec<Value>,
    now: i64,
) -> Result<Vec<Value>, String> {
    let state = owned(tx, book, owner, now)?;
    if sequence < 0 || sequence >= state.next_batch {
        return Err("无效恢复批次".into());
    }
    let saved: Vec<Value> = {
        let mut statement = db(tx.prepare(
            "SELECT chunk FROM semantic_staging WHERE book=?1 AND batch=?2 ORDER BY ordinal",
        ))?;
        let rows = db(statement.query_map(params![book, sequence], |r| r.get::<_, String>(0)))?;
        let mut decoded = Vec::new();
        for row in rows {
            decoded.push(
                serde_json::from_str(&db(row)?).map_err(|e| format!("checkpoint 已损坏：{e}"))?,
            );
        }
        decoded
    };
    let actual: Vec<Value> = chunks
        .iter()
        .map(|chunk| {
            validate_chunk(chunk, &state.manifest).map(|(_, encoded, _)| {
                serde_json::from_str(&encoded).unwrap_or_else(|_| chunk.clone())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if actual != saved {
        return Err("恢复语料与 checkpoint 不一致，请清理后重建".into());
    }
    db(tx.execute(
        "UPDATE semantic_jobs SET lease_until=?2 WHERE book=?1",
        params![book, now + LEASE_MS],
    ))?;
    Ok(saved)
}

fn commit(
    tx: &Connection,
    book: &str,
    owner: &str,
    batches: i64,
    total: i64,
    now: i64,
) -> Result<(), String> {
    let state = owned(tx, book, owner, now)?;
    let actual: i64 = db(tx.query_row(
        "SELECT count(*) FROM semantic_staging WHERE book=?1",
        [book],
        |r| r.get(0),
    ))?;
    if total <= 0 || total != state.total || total != actual || batches != state.next_batch {
        return Err("语义索引未完整提交".into());
    }
    let manifest_key: String = db(tx.query_row(
        "SELECT manifest_key FROM semantic_jobs WHERE book=?1",
        [book],
        |r| r.get(0),
    ))?;
    let next_generation: i64 = db(tx.query_row(
        "SELECT COALESCE(MAX(generation),0)+1 FROM semantic_generations WHERE book=?1",
        [book],
        |r| r.get(0),
    ))?;
    let encoded = state.manifest.encoded()?;
    db(tx.execute(
        "INSERT INTO semantic_generations(book,generation,manifest,manifest_key,total,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![book, next_generation, encoded, manifest_key, total, now],
    ))?;
    db(tx.execute(
        "INSERT INTO semantic_vectors(book,generation,ordinal,chunk_id,chunk,vector,bytes)
         SELECT book,?2,ordinal,chunk_id,chunk,vector,bytes FROM semantic_staging WHERE book=?1",
        params![book, next_generation],
    ))?;
    let copied: i64 = db(tx.query_row(
        "SELECT count(*) FROM semantic_vectors WHERE book=?1 AND generation=?2",
        params![book, next_generation],
        |r| r.get(0),
    ))?;
    if copied != total {
        return Err("语义代次发布不完整，已回滚".into());
    }
    db(tx.execute("DELETE FROM semantic_staging WHERE book=?1", [book]))?;
    db(tx.execute("DELETE FROM semantic_jobs WHERE book=?1", [book]))?;
    reclaim_behind(tx, book, next_generation)
}

fn read_snapshot(
    tx: &Connection,
    book: &str,
    generation: i64,
    after: i64,
    limit: i64,
) -> Result<SnapshotPage, String> {
    let manifest_key: String = db(tx
        .query_row(
            "SELECT manifest_key FROM semantic_generations WHERE book=?1 AND generation=?2",
            params![book, generation],
            |r| r.get(0),
        )
        .optional())?
    .ok_or("已发布代次不存在")?;
    let manifest_encoded: String = db(tx.query_row(
        "SELECT manifest FROM semantic_generations WHERE book=?1 AND generation=?2",
        params![book, generation],
        |r| r.get(0),
    ))?;
    let manifest = manifest_from(&manifest_encoded)?;
    let total: i64 = db(tx.query_row(
        "SELECT total FROM semantic_generations WHERE book=?1 AND generation=?2",
        params![book, generation],
        |r| r.get(0),
    ))?;
    let mut statement = db(tx.prepare(
        "SELECT ordinal,chunk,vector FROM semantic_vectors
         WHERE book=?1 AND generation=?2 AND ordinal>=?3 ORDER BY ordinal LIMIT ?4",
    ))?;
    let rows = db(
        statement.query_map(params![book, generation, after, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }),
    )?;
    let mut decoded = Vec::new();
    for row in rows {
        let (ordinal, chunk, vector) = db(row)?;
        decoded.push(SemanticRow {
            ordinal,
            chunk: serde_json::from_str(&chunk).map_err(|e| format!("向量行已损坏：{e}"))?,
            vector: serde_json::from_str(&vector).map_err(|e| format!("向量已损坏：{e}"))?,
        });
    }
    let done = decoded
        .last()
        .map(|row| row.ordinal + 1 >= total)
        .unwrap_or(after >= total);
    Ok(SnapshotPage {
        generation,
        manifest,
        manifest_key,
        total,
        rows: decoded,
        done,
    })
}

fn dispatch(connection: &mut Connection, input: Request, now: i64) -> Result<Reply, String> {
    let book = book_of(&input)?;
    validate_request(&input)?;
    initialize(connection)?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let mut reply = Reply::empty(&tx)?;
    match input {
        Request::Begin {
            manifest,
            manifest_key,
            owner,
            corpus_digest,
            policy,
            force,
        } => {
            let existing = db(tx
                .query_row(
                    "SELECT manifest_key,owner,lease_until,corpus_digest,policy FROM semantic_jobs WHERE book=?1",
                    [&book],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional())?;
            if existing
                .as_ref()
                .is_some_and(|(_, owner, lease, _, _)| !owner.is_empty() && *lease > now)
            {
                return Err("另一个会话正在为此书建立语义索引，请稍后继续".into());
            }
            // Reuse only a matching published generation with no unfinished
            // job. Return a synthetic completed state without claiming a lease.
            if !force && existing.is_none() {
                if let Some(published) = generation_state(&tx, &book)? {
                    if published.manifest_key == manifest_key && published.total > 0 {
                        reply.job = Some(JobState {
                            owner: String::new(),
                            manifest_key,
                            corpus_digest,
                            next_batch: 0,
                            staged_rows: 0,
                            staged_bytes: 0,
                            complete: true,
                            manifest: Some(manifest),
                            policy: Some(policy),
                        });
                        reply.published = Some(published);
                        reply.generations = generations(&tx, &book)?;
                        db(tx.commit())?;
                        return Ok(reply);
                    }
                }
            }
            let policy_encoded =
                serde_json::to_string(&policy).map_err(|e| format!("批次规则序列化失败：{e}"))?;
            // A checkpoint only belongs to the corpus that produced it.  When
            // the same identity resumes against a different corpus, refuse
            // instead of silently discarding confirmed batches; the caller
            // must clear and rebuild explicitly.
            // A paused job (empty owner) still owns a valid checkpoint.
            let unfinished_same_profile = existing.as_ref().is_some_and(|(key, _, _, _, saved)| {
                key == &manifest_key && saved == &policy_encoded
            });
            if !force && unfinished_same_profile {
                let staged: i64 = db(tx.query_row(
                    "SELECT count(*) FROM semantic_staging WHERE book=?1",
                    [&book],
                    |r| r.get(0),
                ))?;
                let stored_digest: String = db(tx.query_row(
                    "SELECT corpus_digest FROM semantic_jobs WHERE book=?1",
                    [&book],
                    |r| r.get(0),
                ))?;
                if staged > 0 && stored_digest != corpus_digest {
                    return Err("正文语料已变化，需要清理后重建语义索引".into());
                }
            }
            let same_identity = existing.as_ref().is_some_and(|(key, _, _, digest, saved)| {
                key == &manifest_key && digest == &corpus_digest && saved == &policy_encoded
            });
            if force || !same_identity {
                // A forced rebuild or any identity change invalidates the
                // checkpoint: staging and sequence both restart at zero.
                db(tx.execute("DELETE FROM semantic_staging WHERE book=?1", [&book]))?;
                db(tx.execute("DELETE FROM semantic_jobs WHERE book=?1", [&book]))?;
            }
            db(tx.execute(
                "INSERT INTO semantic_jobs(book,manifest,manifest_key,owner,lease_until,corpus_digest,policy,next_batch,total,bytes)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,0,0,0)
                 ON CONFLICT(book) DO UPDATE SET manifest=excluded.manifest,manifest_key=excluded.manifest_key,
                    owner=excluded.owner,lease_until=excluded.lease_until,corpus_digest=excluded.corpus_digest,
                    policy=excluded.policy",
                params![
                    book,
                    manifest.encoded()?,
                    manifest_key,
                    owner,
                    now + LEASE_MS,
                    corpus_digest,
                    policy_encoded
                ],
            ))?;
            reply.job = job_state(&tx, &book)?;
        }
        Request::Append {
            owner,
            sequence,
            rows,
            ..
        } => append(&tx, &book, &owner, sequence, rows, now)?,
        Request::Replay {
            owner,
            sequence,
            chunks,
            ..
        } => {
            reply.chunks = replay(&tx, &book, &owner, sequence, chunks, now)?;
        }
        Request::Heartbeat { owner, .. } => {
            let state = owned(&tx, &book, &owner, now)?;
            db(tx.execute(
                "UPDATE semantic_jobs SET lease_until=?2 WHERE book=?1",
                params![book, now + LEASE_MS],
            ))?;
            let _ = state;
        }
        Request::Pause { owner, .. } => {
            // Idempotent, and unable to release a newer owner's job.
            db(tx.execute(
                "UPDATE semantic_jobs SET owner='',lease_until=0 WHERE book=?1 AND owner=?2",
                params![book, owner],
            ))?;
        }
        Request::Commit {
            owner,
            batches,
            total,
            ..
        } => {
            commit(&tx, &book, &owner, batches, total, now)?;
        }
        Request::OpenSnapshot { .. } => {
            let published = generation_state(&tx, &book)?.ok_or("此书尚未发布语义索引")?;
            db(tx.execute(
                "INSERT OR IGNORE INTO semantic_snapshots(book,generation,pinned_at) VALUES (?1,?2,?3)",
                params![book, published.generation, now],
            ))?;
            // The initial IPC response obeys the same bound as subsequent pages.
            let page = read_snapshot(&tx, &book, published.generation, 0, MAX_SNAPSHOT_ROWS)?;
            reply.snapshot = Some(page);
        }
        Request::ReadSnapshot {
            generation,
            after,
            limit,
            ..
        } => {
            let pin: bool = db(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM semantic_snapshots WHERE book=?1 AND generation=?2)",
                params![book, generation],
                |r| r.get(0),
            ))?;
            if !pin {
                return Err("快照未打开或已释放".into());
            }
            reply.snapshot = Some(read_snapshot(&tx, &book, generation, after, limit)?);
        }
        Request::CloseSnapshot { generation, .. } => {
            db(tx.execute(
                "DELETE FROM semantic_snapshots WHERE book=?1 AND generation=?2",
                params![book, generation],
            ))?;
            // Only reclaim once the reader released the pin.
            let latest = db(tx
                .query_row(
                    "SELECT MAX(generation) FROM semantic_generations WHERE book=?1",
                    [&book],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .optional())?
            .flatten();
            if let Some(latest) = latest {
                reclaim_behind(&tx, &book, latest)?;
            }
        }
        Request::Clear { owner, .. } => {
            owner_valid(&owner)?;
            let busy: bool = db(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM semantic_jobs WHERE book=?1 AND owner<>'' AND lease_until>?2)",
                params![book, now],
                |r| r.get(0),
            ))?;
            let pinned_now: bool = db(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM semantic_snapshots WHERE book=?1)",
                [&book],
                |r| r.get(0),
            ))?;
            if busy || pinned_now {
                return Err("请先取消活动任务并关闭查询后再清理".into());
            }
            db(tx.execute("DELETE FROM semantic_staging WHERE book=?1", [&book]))?;
            db(tx.execute("DELETE FROM semantic_jobs WHERE book=?1", [&book]))?;
            db(tx.execute("DELETE FROM semantic_vectors WHERE book=?1", [&book]))?;
            db(tx.execute("DELETE FROM semantic_generations WHERE book=?1", [&book]))?;
        }
        Request::Status { .. } => {}
    }
    reply.job = job_state(&tx, &book)?;
    reply.published = generation_state(&tx, &book)?;
    reply.generations = generations(&tx, &book)?;
    db(tx.commit())?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "epub-semantic-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn profile() -> EmbeddingProfile {
        EmbeddingProfile {
            model_id: "bge-small-zh-v1.5".into(),
            model_digest: "b".repeat(64),
            tokenizer_digest: "c".repeat(64),
            runtime_version: "onnxruntime-1.28.0/directml".into(),
            dimensions: 4,
            max_tokens: 512,
            pooling: "cls".into(),
            normalization: "l2".into(),
            query_prefix: "为这个句子生成表示以用于检索相关文章：".into(),
            passage_prefix: String::new(),
        }
    }

    fn manifest() -> SemanticManifest {
        SemanticManifest {
            component_version: 1,
            book_fingerprint: "a".repeat(64),
            parser_version: "parser-v1".into(),
            normalizer_version: "normal-v1".into(),
            chunker_version: "chunk-v1".into(),
            profile: profile(),
        }
    }

    fn policy() -> BatchPolicy {
        BatchPolicy {
            max_rows: 32,
            max_tokens: 400,
            max_bytes: MAX_BATCH_BYTES,
        }
    }

    const KEY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const CORPUS: &str = "aa3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85";

    fn chunk_for(i: usize, chunker_version: &str) -> Value {
        serde_json::json!({
            "bookFingerprint": "a".repeat(64), "chunkId": format!("chunk-{i}"),
            "chapterPath": "book/chapter.xhtml", "chapterTitle": "章", "spineIndex": 0,
            "contentType": "body", "originalText": format!("正文{i}"),
            "normalizedText": format!("正文{i}"), "textAnchor": {"start": i, "end": i + 3, "snippet": format!("正文{i}")},
            "parserVersion": "parser-v1", "normalizerVersion": "normal-v1", "chunkerVersion": chunker_version,
        })
    }

    fn chunk(i: usize, fingerprint: &str) -> Value {
        let mut value = chunk_for(i, "chunk-v1");
        value["bookFingerprint"] = Value::String(fingerprint.to_string());
        value
    }

    fn rows(range: std::ops::Range<usize>) -> Vec<SemanticRow> {
        range
            .map(|i| SemanticRow {
                ordinal: i as i64,
                chunk: chunk(i, &"a".repeat(64)),
                vector: vec![0.5, 0.5, 0.5, 0.5],
            })
            .collect()
    }

    fn call(store: &AiStore, request: Request) -> Result<Reply, String> {
        let now = now_ms().unwrap();
        store.with_connection(|connection| dispatch(connection, request, now))
    }

    fn begin(store: &AiStore, owner: &str, force: bool) -> Result<Reply, String> {
        call(
            store,
            Request::Begin {
                manifest: manifest(),
                manifest_key: KEY.into(),
                owner: owner.into(),
                corpus_digest: CORPUS.into(),
                policy: policy(),
                force,
            },
        )
    }

    fn append(
        store: &AiStore,
        owner: &str,
        sequence: i64,
        rows: Vec<SemanticRow>,
    ) -> Result<Reply, String> {
        call(
            store,
            Request::Append {
                book: "a".repeat(64),
                owner: owner.into(),
                sequence,
                rows,
            },
        )
    }

    fn commit(store: &AiStore, owner: &str, batches: i64, total: i64) -> Result<Reply, String> {
        call(
            store,
            Request::Commit {
                book: "a".repeat(64),
                owner: owner.into(),
                batches,
                total,
            },
        )
    }

    fn build(store: &AiStore, owner: &str, count: usize) -> Result<Reply, String> {
        // This helper explicitly publishes a new generation, even if one exists.
        begin(store, owner, true)?;
        append(store, owner, 0, rows(0..count))?;
        commit(store, owner, 1, count as i64)
    }

    #[test]
    fn append_commit_publishes_one_generation_and_clears_the_job() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        let reply = build(&store, "owner-aaaa", 3).unwrap();
        assert_eq!(reply.published.as_ref().unwrap().total, 3);
        assert_eq!(reply.published.as_ref().unwrap().generation, 1);
        assert!(reply.job.is_none());
        assert_eq!(reply.schema, 6);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expired_owner_cannot_keep_writing_and_other_session_is_refused() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        assert!(begin(&store, "owner-bbbb", false).is_err());
        // An expired lease is fenced off even for the original owner.
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE semantic_jobs SET lease_until=0 WHERE book=?1",
                        ["a".repeat(64)],
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(append(&store, "owner-aaaa", 0, rows(0..1)).is_err());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn duplicate_and_out_of_order_batches_are_rejected_without_partial_rows() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        assert!(append(&store, "owner-aaaa", 1, rows(0..1)).is_err());
        assert!(append(&store, "owner-aaaa", 0, rows(0..1)).is_ok());
        assert!(append(&store, "owner-aaaa", 0, rows(0..1)).is_err());
        assert!(append(&store, "owner-aaaa", 1, rows(1..2)).is_ok());
        // A live lease is not re-entered by the same owner; an interrupted run
        // resumes from the stored checkpoint instead of a second begin.
        assert!(begin(&store, "owner-aaaa", false).is_err());
        // Duplicate chunk identity inside one batch is refused as a whole.
        let duplicate = vec![rows(2..3)[0].clone(), rows(2..3)[0].clone()];
        let duplicate = duplicate
            .into_iter()
            .enumerate()
            .map(|(index, mut row)| {
                row.ordinal = 2 + index as i64;
                row
            })
            .collect();
        assert!(append(&store, "owner-aaaa", 2, duplicate).is_err());
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.job.unwrap().staged_rows, 2);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bad_vectors_and_foreign_chunks_never_reach_staging() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        let mut wrong_dimensions = rows(0..1);
        wrong_dimensions[0].vector = vec![1.0, 0.0];
        assert!(append(&store, "owner-aaaa", 0, wrong_dimensions).is_err());
        let mut not_finite = rows(0..1);
        not_finite[0].vector = vec![f64::NAN, 0.0, 0.0, 0.0];
        assert!(append(&store, "owner-aaaa", 0, not_finite).is_err());
        let mut foreign = rows(0..1);
        foreign[0].chunk = chunk(0, &"d".repeat(64));
        assert!(append(&store, "owner-aaaa", 0, foreign).is_err());
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.job.unwrap().staged_rows, 0);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn incomplete_commit_rolls_back_and_keeps_the_checkpoint() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        append(&store, "owner-aaaa", 0, rows(0..2)).unwrap();
        assert!(commit(&store, "owner-aaaa", 1, 3).is_err());
        assert!(commit(&store, "owner-aaaa", 0, 2).is_err());
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert!(status.published.is_none());
        assert_eq!(status.job.unwrap().staged_rows, 2);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replay_validates_the_checkpoint_and_refuses_a_changed_corpus() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        append(&store, "owner-aaaa", 0, rows(0..2)).unwrap();
        let chunks: Vec<Value> = (0..2).map(|i| chunk(i, &"a".repeat(64))).collect();
        let replayed = call(
            &store,
            Request::Replay {
                book: "a".repeat(64),
                owner: "owner-aaaa".into(),
                sequence: 0,
                chunks: chunks.clone(),
            },
        )
        .unwrap();
        assert_eq!(replayed.chunks, chunks);
        let mut tampered = chunks;
        tampered[1] = chunk(9, &"a".repeat(64));
        assert!(call(
            &store,
            Request::Replay {
                book: "a".repeat(64),
                owner: "owner-aaaa".into(),
                sequence: 0,
                chunks: tampered,
            },
        )
        .is_err());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changed_manifest_clears_the_old_checkpoint_and_publishes_a_new_generation() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        append(&store, "owner-aaaa", 0, rows(0..2)).unwrap();
        call(
            &store,
            Request::Pause {
                book: "a".repeat(64),
                owner: "owner-aaaa".into(),
            },
        )
        .unwrap();
        let mut changed = manifest();
        changed.chunker_version = "chunk-v2".into();
        call(
            &store,
            Request::Begin {
                manifest: changed,
                manifest_key: "f".repeat(64),
                owner: "owner-bbbb".into(),
                corpus_digest: CORPUS.into(),
                policy: policy(),
                force: false,
            },
        )
        .unwrap();
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.job.unwrap().staged_rows, 0);
        let changed_rows = vec![SemanticRow {
            ordinal: 0,
            chunk: chunk_for(0, "chunk-v2"),
            vector: vec![0.5, 0.5, 0.5, 0.5],
        }];
        append(&store, "owner-bbbb", 0, changed_rows).unwrap();
        commit(&store, "owner-bbbb", 1, 1).unwrap();
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.published.unwrap().total, 1);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_rebuild_keeps_the_previous_generation_readable() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        build(&store, "owner-aaaa", 2).unwrap();
        begin(&store, "owner-bbbb", true).unwrap();
        append(&store, "owner-bbbb", 0, rows(0..1)).unwrap();
        // Abandon the rebuild without committing.
        call(
            &store,
            Request::Pause {
                book: "a".repeat(64),
                owner: "owner-bbbb".into(),
            },
        )
        .unwrap();
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.published.unwrap().total, 2);
        assert_eq!(status.generations.len(), 1);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn snapshot_first_page_and_following_pages_are_bounded_and_complete() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-aaaa", false).unwrap();
        for (sequence, start) in [0, 32, 64].into_iter().enumerate() {
            append(
                &store,
                "owner-aaaa",
                sequence as i64,
                rows(start..(start + 32).min(65)),
            )
            .unwrap();
        }
        commit(&store, "owner-aaaa", 3, 65).unwrap();
        let mut page = call(
            &store,
            Request::OpenSnapshot {
                book: "a".repeat(64),
            },
        )
        .unwrap()
        .snapshot
        .unwrap();
        assert_eq!(page.rows.len(), 32);
        assert!(!page.done);
        let mut ordinals = Vec::new();
        loop {
            assert!(page.rows.len() <= MAX_SNAPSHOT_ROWS as usize);
            assert_eq!(page.total, 65);
            ordinals.extend(page.rows.iter().map(|row| row.ordinal));
            if page.done {
                break;
            }
            page = call(
                &store,
                Request::ReadSnapshot {
                    book: "a".repeat(64),
                    generation: page.generation,
                    after: ordinals.last().unwrap() + 1,
                    limit: MAX_SNAPSHOT_ROWS,
                },
            )
            .unwrap()
            .snapshot
            .unwrap();
        }
        assert_eq!(ordinals, (0..65).collect::<Vec<i64>>());
        call(
            &store,
            Request::CloseSnapshot {
                book: "a".repeat(64),
                generation: page.generation,
            },
        )
        .unwrap();
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn snapshot_is_pinned_across_a_rebuild_and_reclaimed_after_close() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        build(&store, "owner-aaaa", 3).unwrap();
        let opened = call(
            &store,
            Request::OpenSnapshot {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        let snapshot = opened.snapshot.unwrap();
        assert_eq!(snapshot.generation, 1);
        assert_eq!(snapshot.total, 3);
        assert_eq!(snapshot.rows.len(), 3);
        assert!(snapshot.done);
        // Rebuild into generation 2 while the snapshot is pinned.
        build(&store, "owner-bbbb", 1).unwrap();
        let page = |after: i64, limit: i64| {
            call(
                &store,
                Request::ReadSnapshot {
                    book: "a".repeat(64),
                    generation: 1,
                    after,
                    limit,
                },
            )
            .unwrap()
            .snapshot
            .unwrap()
        };
        let first = page(0, 2);
        assert_eq!(first.rows.len(), 2);
        assert!(!first.done);
        assert_eq!(first.total, 3);
        let second = page(2, 2);
        assert_eq!(second.rows.len(), 1);
        assert!(second.done);
        // Pinned generation 1 still exists after the rebuild.
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.generations.len(), 2);
        call(
            &store,
            Request::CloseSnapshot {
                book: "a".repeat(64),
                generation: 1,
            },
        )
        .unwrap();
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert_eq!(status.generations.len(), 1);
        assert_eq!(status.published.unwrap().generation, 2);
        assert!(call(
            &store,
            Request::ReadSnapshot {
                book: "a".repeat(64),
                generation: 1,
                after: 0,
                limit: 1,
            },
        )
        .is_err());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clear_refuses_while_a_job_is_active_then_removes_only_semantic_rows() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        build(&store, "owner-aaaa", 2).unwrap();
        // Unrelated component tables must survive semantic cleanup.
        store
            .with_connection(|connection| {
                connection
                    .execute_batch("CREATE TABLE IF NOT EXISTS survivor (id TEXT PRIMARY KEY); INSERT OR IGNORE INTO survivor VALUES ('keep');")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        begin(&store, "owner-bbbb", true).unwrap();
        assert!(call(
            &store,
            Request::Clear {
                book: "a".repeat(64),
                owner: "owner-cccc".into()
            },
        )
        .is_err());
        call(
            &store,
            Request::Pause {
                book: "a".repeat(64),
                owner: "owner-bbbb".into(),
            },
        )
        .unwrap();
        call(
            &store,
            Request::Clear {
                book: "a".repeat(64),
                owner: "owner-cccc".into(),
            },
        )
        .unwrap();
        let status = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert!(status.published.is_none());
        assert!(status.job.is_none());
        let survivors: i64 = store
            .with_connection(|connection| {
                connection
                    .query_row("SELECT count(*) FROM survivor", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(survivors, 1);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn begin_without_force_reports_an_existing_generation_as_complete() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        build(&store, "owner-aaaa", 2).unwrap();
        let reply = begin(&store, "owner-bbbb", false).unwrap();
        assert!(reply.job.as_ref().unwrap().complete);
        assert_eq!(reply.published.unwrap().total, 2);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn begin_and_resume_never_report_an_unpublished_job_complete() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        let first = begin(&store, "owner-aaaa", false).unwrap();
        assert!(!first.job.unwrap().complete);
        assert!(first.published.is_none());
        append(&store, "owner-aaaa", 0, rows(0..2)).unwrap();
        call(
            &store,
            Request::Pause {
                book: "a".repeat(64),
                owner: "owner-aaaa".into(),
            },
        )
        .unwrap();
        let resumed = begin(&store, "owner-bbbb", false).unwrap();
        let job = resumed.job.unwrap();
        assert!(!job.complete);
        assert_eq!(job.next_batch, 1);
        assert_eq!(job.staged_rows, 2);
        append(&store, "owner-bbbb", 1, rows(2..3)).unwrap();
        assert_eq!(
            commit(&store, "owner-bbbb", 2, 3)
                .unwrap()
                .published
                .unwrap()
                .total,
            3
        );
        // Repeated reuse must not leave a lease that blocks the next begin.
        for owner in ["owner-cccc", "owner-dddd"] {
            let ready = begin(&store, owner, false).unwrap();
            assert!(ready.job.unwrap().complete);
            assert!(call(
                &store,
                Request::Status {
                    book: "a".repeat(64)
                }
            )
            .unwrap()
            .job
            .is_none());
        }
        // A paused rebuild is unfinished even though the old generation exists.
        assert!(
            !begin(&store, "owner-eeee", true)
                .unwrap()
                .job
                .unwrap()
                .complete
        );
        append(&store, "owner-eeee", 0, rows(0..1)).unwrap();
        call(
            &store,
            Request::Pause {
                book: "a".repeat(64),
                owner: "owner-eeee".into(),
            },
        )
        .unwrap();
        let paused = call(
            &store,
            Request::Status {
                book: "a".repeat(64),
            },
        )
        .unwrap();
        assert!(!paused.job.unwrap().complete);
        let resumed = begin(&store, "owner-ffff", false).unwrap();
        assert!(!resumed.job.unwrap().complete);
        assert_eq!(resumed.published.unwrap().total, 3);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn identity_and_bounds_are_validated_before_any_write() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        let mut bad_profile = manifest();
        bad_profile.profile.model_digest = "mock-v1".into();
        assert!(call(
            &store,
            Request::Begin {
                manifest: bad_profile,
                manifest_key: KEY.into(),
                owner: "owner-aaaa".into(),
                corpus_digest: CORPUS.into(),
                policy: policy(),
                force: false,
            },
        )
        .is_err());
        assert!(call(
            &store,
            Request::ReadSnapshot {
                book: "a".repeat(64),
                generation: 1,
                after: 0,
                limit: 4096,
            },
        )
        .is_err());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
