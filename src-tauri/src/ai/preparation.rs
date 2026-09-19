//! Debug-only mock index component. Additive tables do not reinterpret user_version.
use super::{normalize_content_hash, AiState, AiStore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

const COMPONENT_VERSION: u32 = 1;
const LEASE_MS: i64 = 30_000;
const BATCH_SIZE: usize = 32;
const MAX_BYTES: usize = 512 * 1024;
const MAX_TOTAL_BYTES: i64 = 128 * 1024 * 1024;
fn db<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|e| format!("mock 索引存储失败：{e}"))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IndexManifest {
    component_version: u32,
    book_fingerprint: String,
    parser_version: String,
    normalizer_version: String,
    chunker_version: String,
    model_id: String,
    model_digest: String,
    provider_version: String,
    embedding_version: String,
    dimensions: usize,
    metric: String,
    storage_version: u32,
    batch_size: usize,
}
impl IndexManifest {
    fn validate(&self) -> Result<(), String> {
        if normalize_content_hash(&self.book_fingerprint)? != self.book_fingerprint
            || self.component_version != COMPONENT_VERSION
            || self.storage_version != 1
            || self.batch_size != BATCH_SIZE
            || self.dimensions != 8
            || self.metric != "cosine"
            || self.model_id != "mock-model"
            || self.model_digest != "mock-deterministic-v1"
            || self.provider_version != "0.1.0"
            || self.embedding_version != "mock-char-v1"
        {
            return Err("不支持的 mock 索引 manifest".into());
        }
        for v in [
            &self.parser_version,
            &self.normalizer_version,
            &self.chunker_version,
        ] {
            if v.is_empty() || v.len() > 128 {
                return Err("无效的语料版本".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VectorRow {
    chunk: Value,
    vector: Vec<f64>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Request {
    Begin {
        manifest: IndexManifest,
        owner: String,
        force: bool,
    },
    Append {
        book: String,
        owner: String,
        sequence: i64,
        rows: Vec<VectorRow>,
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
    Clear {
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
    Citations {
        book: String,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    next_batch: i64,
    staged_chunks: i64,
    published_chunks: i64,
    complete: bool,
    sqlite_version: String,
    database_schema: u32,
    supported_database_schema: u32,
    component_version: u32,
    busy_timeout_ms: u32,
}
#[derive(Debug, Serialize)]
pub(crate) struct Reply {
    status: Status,
    citations: Vec<Value>,
}

fn initialize(c: &mut Connection) -> Result<(), String> {
    let tx = db(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    db(tx.execute_batch("CREATE TABLE IF NOT EXISTS rag_prep_components (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
        INSERT OR IGNORE INTO rag_prep_components VALUES ('mock-index',1);"))?;
    let version: u32 = db(tx.query_row(
        "SELECT version FROM rag_prep_components WHERE id='mock-index'",
        [],
        |r| r.get(0),
    ))?;
    if version != COMPONENT_VERSION {
        return Err("不支持的 mock 组件版本，未修改数据".into());
    }
    db(tx.execute_batch("CREATE TABLE IF NOT EXISTS rag_prep_jobs (
        book TEXT PRIMARY KEY, manifest TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        next_batch INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS rag_prep_staging (
        book TEXT NOT NULL, ordinal INTEGER NOT NULL, batch INTEGER NOT NULL, chunk_id TEXT NOT NULL,
        chunk TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(book,ordinal), UNIQUE(book,chunk_id));
        CREATE TABLE IF NOT EXISTS rag_prep_indexes (book TEXT PRIMARY KEY, manifest TEXT NOT NULL, total INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS rag_prep_chunks (
        book TEXT NOT NULL, ordinal INTEGER NOT NULL, chunk_id TEXT NOT NULL, chunk TEXT NOT NULL, vector TEXT NOT NULL,
        PRIMARY KEY(book,ordinal), UNIQUE(book,chunk_id));"))?;
    db(tx.commit())
}
fn reply(
    c: &Connection,
    book: &str,
    complete: bool,
    citations: Vec<Value>,
) -> Result<Reply, String> {
    let (next_batch, staged_chunks) = db(c
        .query_row(
            "SELECT next_batch,total FROM rag_prep_jobs WHERE book=?1",
            [book],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?
    .unwrap_or((0, 0));
    let published_chunks = db(c
        .query_row(
            "SELECT total FROM rag_prep_indexes WHERE book=?1",
            [book],
            |r| r.get(0),
        )
        .optional())?
    .unwrap_or(0);
    Ok(Reply {
        status: Status {
            next_batch,
            staged_chunks,
            published_chunks,
            complete,
            sqlite_version: db(c.query_row("SELECT sqlite_version()", [], |r| r.get(0)))?,
            database_schema: db(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?,
            supported_database_schema: 6,
            component_version: COMPONENT_VERSION,
            busy_timeout_ms: db(c.query_row("PRAGMA busy_timeout", [], |r| r.get(0)))?,
        },
        citations,
    })
}
fn owned(
    c: &Connection,
    book: &str,
    owner: &str,
    now: i64,
) -> Result<(IndexManifest, i64, i64, i64), String> {
    let data = db(c.query_row("SELECT manifest,next_batch,total,bytes FROM rag_prep_jobs WHERE book=?1 AND owner=?2 AND lease_until>?3", params![book,owner,now], |r| Ok((r.get::<_,String>(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?
        .ok_or("任务租约已失效或属于其他会话")?;
    let manifest = serde_json::from_str(&data.0).map_err(|e| format!("manifest 已损坏：{e}"))?;
    Ok((manifest, data.1, data.2, data.3))
}
fn validate_chunk(chunk: &Value, manifest: &IndexManifest) -> Result<String, String> {
    for (key, value) in [
        ("bookFingerprint", manifest.book_fingerprint.as_str()),
        ("parserVersion", manifest.parser_version.as_str()),
        ("normalizerVersion", manifest.normalizer_version.as_str()),
        ("chunkerVersion", manifest.chunker_version.as_str()),
    ] {
        if chunk[key].as_str() != Some(value) {
            return Err("正文块与 manifest 不匹配".into());
        }
    }
    for field in ["chunkId", "chapterPath", "originalText", "normalizedText"] {
        let text = chunk[field].as_str().ok_or("正文块字段缺失")?;
        if text.is_empty() || text.len() > 16 * 1024 {
            return Err("正文块字段超限".into());
        }
    }
    let path = chunk["chapterPath"].as_str().unwrap();
    if path.starts_with('/') || path.contains('\\') || path.split('/').any(|p| p == "..") {
        return Err("无效章节路径".into());
    }
    let anchor = &chunk["textAnchor"];
    let start = anchor["start"].as_u64().ok_or("缺少文本锚点")?;
    let end = anchor["end"].as_u64().ok_or("缺少文本锚点")?;
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
    Ok(chunk.to_string())
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

impl AiStore {
    pub(crate) fn preparation(&self, input: Request) -> Result<Reply, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;
        self.with_connection(|c| dispatch(c, input, now))
    }
}
fn dispatch(c: &mut Connection, input: Request, now: i64) -> Result<Reply, String> {
    let book = match &input {
        Request::Begin { manifest, .. } => &manifest.book_fingerprint,
        Request::Append { book, .. }
        | Request::Replay { book, .. }
        | Request::Heartbeat { book, .. }
        | Request::Pause { book, .. }
        | Request::Clear { book, .. }
        | Request::Commit { book, .. }
        | Request::Status { book }
        | Request::Citations { book } => book,
    }
    .clone();
    if normalize_content_hash(&book)? != book {
        return Err("需要规范化书籍指纹".into());
    }
    if let Request::Begin {
        manifest, owner, ..
    } = &input
    {
        manifest.validate()?;
        owner_valid(owner)?;
    }
    initialize(c)?;
    let tx = db(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let mut complete = false;
    let mut citations = Vec::new();
    match input {
        Request::Begin {
            manifest,
            owner,
            force,
        } => {
            let existing = db(tx
                .query_row(
                    "SELECT manifest,owner,lease_until FROM rag_prep_jobs WHERE book=?1",
                    [&book],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional())?;
            if existing
                .as_ref()
                .is_some_and(|(_, o, t)| !o.is_empty() && *t > now)
            {
                return Err("另一个会话正在处理此书，请稍后继续".into());
            }
            let encoded = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
            let published = db(tx
                .query_row(
                    "SELECT manifest FROM rag_prep_indexes WHERE book=?1",
                    [&book],
                    |r| r.get::<_, String>(0),
                )
                .optional())?;
            if !force && existing.is_none() && published.as_ref() == Some(&encoded) {
                complete = true;
            } else {
                if existing.as_ref().is_some_and(|(m, _, _)| m != &encoded) {
                    db(tx.execute("DELETE FROM rag_prep_staging WHERE book=?1", [&book]))?;
                    db(tx.execute("DELETE FROM rag_prep_jobs WHERE book=?1", [&book]))?;
                }
                db(tx.execute("INSERT INTO rag_prep_jobs(book,manifest,owner,lease_until) VALUES (?1,?2,?3,?4)
                    ON CONFLICT(book) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until",params![book,encoded,owner,now+LEASE_MS]))?;
            }
        }
        Request::Append {
            owner,
            sequence,
            rows,
            ..
        } => {
            let (manifest, next, total, bytes) = owned(&tx, &book, &owner, now)?;
            if sequence != next
                || rows.is_empty()
                || rows.len() > BATCH_SIZE
                || total != next * BATCH_SIZE as i64
            {
                return Err("批次顺序或数量无效".into());
            }
            let mut encoded = Vec::new();
            let mut size = 0usize;
            for row in rows {
                let chunk = validate_chunk(&row.chunk, &manifest)?;
                if row.vector.len() != manifest.dimensions
                    || row.vector.iter().any(|v| !v.is_finite() || v.abs() > 1.0)
                {
                    return Err("向量维度或数值无效".into());
                }
                let vector = serde_json::to_string(&row.vector).map_err(|e| e.to_string())?;
                size += chunk.len() + vector.len();
                encoded.push((
                    row.chunk["chunkId"].as_str().unwrap().to_owned(),
                    chunk,
                    vector,
                ));
            }
            if size > MAX_BYTES
                || bytes + size as i64 > MAX_TOTAL_BYTES
                || total + encoded.len() as i64 > 100_000
            {
                return Err("mock 索引容量超限".into());
            }
            for (i, (id, chunk, vector)) in encoded.iter().enumerate() {
                db(tx.execute(
                    "INSERT INTO rag_prep_staging VALUES (?1,?2,?3,?4,?5,?6)",
                    params![book, total + i as i64, sequence, id, chunk, vector],
                ))?;
            }
            db(tx.execute("UPDATE rag_prep_jobs SET next_batch=next_batch+1,total=total+?2,bytes=bytes+?3,lease_until=?4 WHERE book=?1",params![book,encoded.len() as i64,size as i64,now+LEASE_MS]))?;
        }
        Request::Replay {
            owner,
            sequence,
            chunks,
            ..
        } => {
            let (manifest, next, _, _) = owned(&tx, &book, &owner, now)?;
            if sequence < 0 || sequence >= next || chunks.is_empty() || chunks.len() > BATCH_SIZE {
                return Err("无效恢复批次".into());
            }
            let mut stmt = db(tx.prepare(
                "SELECT chunk FROM rag_prep_staging WHERE book=?1 AND batch=?2 ORDER BY ordinal",
            ))?;
            let saved = db(stmt.query_map(params![book, sequence], |r| r.get::<_, String>(0)))?
                .collect::<rusqlite::Result<Vec<_>>>();
            let saved = db(saved)?;
            let actual = chunks
                .iter()
                .map(|c| validate_chunk(c, &manifest))
                .collect::<Result<Vec<_>, _>>()?;
            if actual != saved {
                return Err("恢复语料与 checkpoint 不一致，请清理后重建".into());
            }
            db(tx.execute(
                "UPDATE rag_prep_jobs SET lease_until=?2 WHERE book=?1",
                params![book, now + LEASE_MS],
            ))?;
        }
        Request::Heartbeat { owner, .. } => {
            owned(&tx, &book, &owner, now)?;
            db(tx.execute(
                "UPDATE rag_prep_jobs SET lease_until=?2 WHERE book=?1",
                params![book, now + LEASE_MS],
            ))?;
        }
        Request::Pause { owner, .. } => {
            // Idempotent after commit/clear and unable to pause a newer owner.
            db(tx.execute(
                "UPDATE rag_prep_jobs SET owner='',lease_until=0 WHERE book=?1 AND owner=?2",
                params![book, owner],
            ))?;
        }
        Request::Commit {
            owner,
            batches,
            total,
            ..
        } => {
            let (manifest, next, count, _) = owned(&tx, &book, &owner, now)?;
            let actual: i64 = db(tx.query_row(
                "SELECT count(*) FROM rag_prep_staging WHERE book=?1",
                [&book],
                |r| r.get(0),
            ))?;
            if total <= 0 || total != count || total != actual || batches != next {
                return Err("索引未完整提交".into());
            }
            db(tx.execute("DELETE FROM rag_prep_chunks WHERE book=?1", [&book]))?;
            db(tx.execute("INSERT INTO rag_prep_chunks SELECT book,ordinal,chunk_id,chunk,vector FROM rag_prep_staging WHERE book=?1",[&book]))?;
            let encoded = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
            db(tx.execute("INSERT INTO rag_prep_indexes VALUES (?1,?2,?3) ON CONFLICT(book) DO UPDATE SET manifest=excluded.manifest,total=excluded.total",params![book,encoded,total]))?;
            db(tx.execute("DELETE FROM rag_prep_staging WHERE book=?1", [&book]))?;
            db(tx.execute("DELETE FROM rag_prep_jobs WHERE book=?1", [&book]))?;
            complete = true;
        }
        Request::Clear { owner, .. } => {
            owner_valid(&owner)?;
            let busy:bool=db(tx.query_row("SELECT EXISTS(SELECT 1 FROM rag_prep_jobs WHERE book=?1 AND owner<>'' AND lease_until>?2)",params![book,now],|r|r.get(0)))?;
            if busy {
                return Err("请先取消活动任务再清理".into());
            }
            for table in [
                "rag_prep_staging",
                "rag_prep_jobs",
                "rag_prep_chunks",
                "rag_prep_indexes",
            ] {
                db(tx.execute(&format!("DELETE FROM {table} WHERE book=?1"), [&book]))?;
            }
        }
        Request::Citations { .. } => {
            let mut stmt = db(tx.prepare(
                "SELECT chunk FROM rag_prep_chunks WHERE book=?1 ORDER BY ordinal LIMIT 20",
            ))?;
            let rows = db(stmt.query_map([&book], |r| r.get::<_, String>(0)))?;
            for row in rows {
                citations.push(
                    serde_json::from_str(&db(row)?).map_err(|e| format!("引用数据损坏：{e}"))?,
                );
            }
        }
        Request::Status { .. } => {}
    }
    let result = reply(&tx, &book, complete, citations)?;
    db(tx.commit())?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn ai_preparation(
    app: AppHandle,
    state: State<'_, AiState>,
    input: Request,
) -> Result<Reply, String> {
    if !cfg!(debug_assertions) {
        return Err("mock 索引仅在 AI debug 构建可用".into());
    }
    let store = state.ensure(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.preparation(input))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "epub-prep-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn manifest() -> IndexManifest {
        IndexManifest {
            component_version: 1,
            book_fingerprint: "a".repeat(64),
            parser_version: "parser-v1".into(),
            normalizer_version: "normal-v1".into(),
            chunker_version: "chunk-v1".into(),
            model_id: "mock-model".into(),
            model_digest: "mock-deterministic-v1".into(),
            provider_version: "0.1.0".into(),
            embedding_version: "mock-char-v1".into(),
            dimensions: 8,
            metric: "cosine".into(),
            storage_version: 1,
            batch_size: 32,
        }
    }
    fn row(i: usize) -> VectorRow {
        let m = manifest();
        VectorRow {
            chunk: serde_json::json!({"bookFingerprint":m.book_fingerprint,"chunkId":format!("chunk-{i}"),"chapterPath":"book/chapter.xhtml","chapterTitle":"章","spineIndex":0,"contentType":"body","originalText":format!("正文{i}"),"normalizedText":format!("正文{i}"),"textAnchor":{"start":i*3,"end":i*3+3,"snippet":format!("正文{i}")},"parserVersion":m.parser_version,"normalizerVersion":m.normalizer_version,"chunkerVersion":m.chunker_version}),
            vector: vec![0.125; 8],
        }
    }
    fn call(store: &AiStore, r: Request, t: i64) -> Result<Reply, String> {
        store.with_connection(|c| dispatch(c, r, t))
    }
    fn begin(store: &AiStore, owner: &str, t: i64, force: bool) -> Result<Reply, String> {
        call(
            store,
            Request::Begin {
                manifest: manifest(),
                owner: owner.into(),
                force,
            },
            t,
        )
    }
    fn append(
        store: &AiStore,
        owner: &str,
        sequence: i64,
        rows: Vec<VectorRow>,
        t: i64,
    ) -> Result<Reply, String> {
        call(
            store,
            Request::Append {
                book: manifest().book_fingerprint,
                owner: owner.into(),
                sequence,
                rows,
            },
            t,
        )
    }
    fn count(store: &AiStore, table: &str) -> i64 {
        store
            .with_connection(|c| {
                db(c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)))
            })
            .unwrap()
    }

    #[test]
    fn resumes_after_reopen_fences_old_owner_and_publishes_atomically() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        let status = begin(&store, "owner-old", 100, false).unwrap().status;
        assert_eq!(status.database_schema, 6);
        assert_eq!(status.component_version, 1);
        assert_eq!(status.busy_timeout_ms, 5000);
        assert!(!status.sqlite_version.is_empty());
        append(&store, "owner-old", 0, (0..32).map(row).collect(), 101).unwrap();
        assert_eq!(count(&store, "rag_prep_chunks"), 0);
        assert!(begin(&store, "owner-new", 102, false).is_err());
        drop(store);
        let store = AiStore::open(&dir).unwrap();
        let status = begin(&store, "owner-new", 40_000, false).unwrap().status;
        assert_eq!(status.next_batch, 1);
        assert_eq!(status.staged_chunks, 32);
        assert!(append(&store, "owner-old", 1, vec![row(32)], 40_001).is_err());
        call(
            &store,
            Request::Replay {
                book: manifest().book_fingerprint,
                owner: "owner-new".into(),
                sequence: 0,
                chunks: (0..32).map(|i| row(i).chunk).collect(),
            },
            40_001,
        )
        .unwrap();
        append(&store, "owner-new", 1, vec![row(32)], 40_002).unwrap();
        call(
            &store,
            Request::Commit {
                book: manifest().book_fingerprint,
                owner: "owner-new".into(),
                batches: 2,
                total: 33,
            },
            40_003,
        )
        .unwrap();
        assert_eq!(count(&store, "rag_prep_chunks"), 33);
        assert_eq!(count(&store, "rag_prep_staging"), 0);
        assert!(
            begin(&store, "owner-later", 40_004, false)
                .unwrap()
                .status
                .complete
        );
        let citations = call(
            &store,
            Request::Citations {
                book: manifest().book_fingerprint,
            },
            40_005,
        )
        .unwrap()
        .citations;
        assert_eq!(citations.len(), 20);
        assert_eq!(citations[0]["textAnchor"]["snippet"], "正文0");
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_invalid_batches_and_preserves_published_index_on_failed_rebuild() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-one", 100, false).unwrap();
        let mut bad = row(0);
        bad.vector = vec![0.1; 7];
        assert!(append(&store, "owner-one", 0, vec![bad], 101).is_err());
        assert!(append(&store, "owner-one", 0, vec![row(0), row(0)], 101).is_err());
        assert_eq!(count(&store, "rag_prep_staging"), 0);
        append(&store, "owner-one", 0, vec![row(0)], 101).unwrap();
        call(
            &store,
            Request::Commit {
                book: manifest().book_fingerprint,
                owner: "owner-one".into(),
                batches: 1,
                total: 1,
            },
            102,
        )
        .unwrap();
        begin(&store, "owner-two", 103, true).unwrap();
        append(&store, "owner-two", 0, vec![row(1)], 104).unwrap();
        assert!(call(
            &store,
            Request::Commit {
                book: manifest().book_fingerprint,
                owner: "owner-two".into(),
                batches: 2,
                total: 2
            },
            105
        )
        .is_err());
        let saved = call(
            &store,
            Request::Citations {
                book: manifest().book_fingerprint,
            },
            106,
        )
        .unwrap()
        .citations;
        assert_eq!(saved[0]["chunkId"], "chunk-0");
        call(
            &store,
            Request::Pause {
                book: manifest().book_fingerprint,
                owner: "owner-two".into(),
            },
            107,
        )
        .unwrap();
        assert_eq!(count(&store, "rag_prep_staging"), 1);
        let resumed = begin(&store, "owner-new", 108, false).unwrap().status;
        assert!(!resumed.complete);
        assert_eq!(resumed.staged_chunks, 1);
        assert_eq!(resumed.published_chunks, 1);
        assert!(call(
            &store,
            Request::Replay {
                book: manifest().book_fingerprint,
                owner: "owner-new".into(),
                sequence: 0,
                chunks: vec![row(0).chunk]
            },
            109
        )
        .is_err());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manifest_change_resets_staging_but_clear_and_book_delete_preserve_other_data() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-one", 100, false).unwrap();
        append(&store, "owner-one", 0, vec![row(0)], 101).unwrap();
        let mut m = manifest();
        m.parser_version = "parser-v2".into();
        let r = call(
            &store,
            Request::Begin {
                manifest: m,
                owner: "owner-two".into(),
                force: false,
            },
            40_000,
        )
        .unwrap();
        assert_eq!(r.status.staged_chunks, 0);
        assert!(call(
            &store,
            Request::Clear {
                book: manifest().book_fingerprint,
                owner: "clear-owner".into()
            },
            40_001
        )
        .is_err());
        call(
            &store,
            Request::Pause {
                book: manifest().book_fingerprint,
                owner: "owner-two".into(),
            },
            40_002,
        )
        .unwrap();
        store.insert_book_for_test(&"b".repeat(64)).unwrap();
        for _ in 0..2 {
            call(
                &store,
                Request::Clear {
                    book: manifest().book_fingerprint,
                    owner: "clear-owner".into(),
                },
                40_003,
            )
            .unwrap();
        }
        assert_eq!(store.status().unwrap().books, 1);
        begin(&store, "owner-three", 50_000, false).unwrap();
        append(&store, "owner-three", 0, vec![row(0)], 50_001).unwrap();
        store
            .delete_book_derived_data(&manifest().book_fingerprint)
            .unwrap();
        assert_eq!(count(&store, "rag_prep_staging"), 0);
        assert_eq!(count(&store, "rag_prep_jobs"), 0);
        assert_eq!(store.status().unwrap().books, 1);
        assert!(append(&store, "owner-three", 1, vec![row(32)], 50_002).is_err());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn future_component_version_is_rejected_without_resetting_data() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-one", 100, false).unwrap();
        store
            .with_connection(|c| db(c.execute("UPDATE rag_prep_components SET version=99", [])))
            .unwrap();
        assert!(begin(&store, "owner-two", 40_000, false).is_err());
        assert_eq!(count(&store, "rag_prep_jobs"), 1);
        assert_eq!(store.status().unwrap().schema_version, 6);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn fts_clear_preserves_mock_but_explicit_all_data_clear_removes_it() {
        let dir = root();
        let store = AiStore::open(&dir).unwrap();
        begin(&store, "owner-one", 100, false).unwrap();
        append(&store, "owner-one", 0, vec![row(0)], 101).unwrap();
        store.clear_all_indexes().unwrap();
        assert_eq!(count(&store, "rag_prep_staging"), 1);
        store.clear_all_derived_data().unwrap();
        assert_eq!(count(&store, "rag_prep_staging"), 0);
        assert_eq!(count(&store, "rag_prep_jobs"), 0);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lease_child() {
        let Ok(path) = std::env::var("EPUB_PREP_CHILD_DB") else {
            return;
        };
        let store = AiStore::open(path).unwrap();
        begin(&store, "child-owner", 100, false).unwrap();
        append(&store, "child-owner", 0, (0..32).map(row).collect(), 101).unwrap();
        use std::io::Write;
        println!("PREP_READY");
        std::io::stdout().flush().unwrap();
        // Parent competes while this process is alive, then kills it without Pause.
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }
    #[test]
    fn another_process_checkpoint_survives_exit_and_requires_lease_expiry() {
        let dir = root();
        use std::io::BufRead;
        use std::process::Stdio;
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ai::preparation::tests::lease_child",
                "--nocapture",
            ])
            .env("EPUB_PREP_CHILD_DB", &dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let ready = std::io::BufReader::new(child.stdout.take().unwrap())
            .lines()
            .any(|line| line.unwrap().contains("PREP_READY"));
        if !ready {
            let _ = child.wait();
            panic!("child did not persist its checkpoint");
        }
        let store = AiStore::open(&dir).unwrap();
        let rejected_while_alive = begin(&store, "parent-owner", 102, false).is_err();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(rejected_while_alive);
        assert!(begin(&store, "parent-owner", 103, false).is_err());
        assert_eq!(
            begin(&store, "parent-owner", 40_000, false)
                .unwrap()
                .status
                .staged_chunks,
            32
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
