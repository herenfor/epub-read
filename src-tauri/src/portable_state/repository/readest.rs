//! One local transaction for confirmed, normalized Readest records.
//! External clocks never enter this path. Existing annotations, including local
//! edits and deletion markers, win over a repeated one-time migration.
use super::*;
use crate::portable_state::Progress;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub(crate) struct ReadestTarget {
    pub book_hash: String,
    pub metadata_stamp: Stamp,
    pub binding: String,
    pub progress_revision: u64,
    pub progress: ProgressProjection,
    pub generation: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadestAnnotation<T> {
    pub source_key: String,
    pub value: T,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadestBookImport {
    pub book_hash: String,
    pub readest_hash: String,
    pub target_token: String,
    /// Omission means don't replace progress; explicit null is not a value.
    #[serde(default, deserialize_with = "super::super::dto::deserialize_present")]
    pub progress: Option<Progress>,
    pub bookmarks: Vec<ReadestAnnotation<BookmarkValue>>,
    pub notes: Vec<ReadestAnnotation<NoteValue>>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadestImportOutcome {
    pub imported_books: usize,
    pub bookmarks_added: usize,
    pub notes_added: usize,
    pub progress_written: usize,
    pub skipped_existing: usize,
    pub progress_unchanged: usize,
}

pub(crate) fn import_error(code: &'static str, message: &str) -> PortableError {
    PortableError {
        code: code.into(),
        message: message.into(),
        legacy_fallback_allowed: None,
    }
}
pub(crate) fn valid_readest_hash(hash: &str) -> bool {
    hash.len() == 32
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn annotation_id(book: &str, hash: &str, kind: &str, key: &str) -> PortableResult<String> {
    let prefix = format!("readest:{hash}:");
    let id = key
        .strip_prefix(&prefix)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
        })
        .ok_or_else(|| PortableError::invalid_data("Readest sourceKey 无效"))?;
    let mut digest = Sha256::new();
    for part in ["selis/readest/annotation/v1", book, hash, kind, id] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    let mut bytes: [u8; 16] = digest.finalize()[..16].try_into().unwrap();
    // UUID v8: application-defined SHA-256 identity, not a foreign device ID.
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
fn receipt_key(book: &str, hash: &str) -> String {
    format!("readest-import:{book}:{hash}:progress-v1")
}

impl PortableStore {
    pub(crate) fn readest_target(&self, hash: &str) -> PortableResult<ReadestTarget> {
        if !dto::valid_content_hash(hash) {
            return Err(PortableError::invalid_entity("书籍指纹无效"));
        }
        let metadata = load_book_meta_row(&self.connection, hash)?
            .ok_or_else(|| PortableError::invalid_entity("本机没有这本书"))?;
        if !metadata
            .value
            .file_name
            .to_ascii_lowercase()
            .ends_with(".epub")
        {
            return Err(import_error("unsupported-format", "首版只迁入 EPUB 资料"));
        }
        let binding = self
            .binding_raw(hash)?
            .ok_or_else(|| import_error("source-unbound", "本机没有原书绑定"))?;
        let (progress, revision) = load_progress_row(&self.connection, hash)?
            .unwrap_or((ProgressState { versions: vec![] }, 0));
        let versions = super::super::merge::merge_versions(&[&progress.versions])?;
        let display = versions.last().cloned();
        Ok(ReadestTarget {
            book_hash: hash.into(),
            metadata_stamp: metadata.stamp,
            binding,
            progress_revision: revision,
            progress: ProgressProjection {
                conflict: versions.len() > 1,
                versions,
                display,
            },
            generation: self.runtime_generation.clone(),
        })
    }

    /// Caller keeps the active shelf lock. `finish` linearizes cancel versus the
    /// actual SQLite commit; failure drops this transaction and rolls it back.
    pub(crate) fn import_readest(
        &mut self,
        books: &[(ReadestTarget, ReadestBookImport)],
        now: u64,
        cancelled: &dyn Fn() -> bool,
        finish: impl FnOnce(rusqlite::Transaction<'_>) -> PortableResult<()>,
    ) -> PortableResult<ReadestImportOutcome> {
        let record_count: usize = books
            .iter()
            .map(|(_, b)| b.bookmarks.len() + b.notes.len() + usize::from(b.progress.is_some()))
            .sum();
        if books.is_empty() || books.len() > 128 || record_count > 20000 || !dto::safe_time(now) {
            return Err(PortableError::invalid_data("迁入批次超出范围"));
        }
        let mut seen = BTreeSet::new();
        for (target, book) in books {
            if target.book_hash != book.book_hash
                || !seen.insert(&book.book_hash)
                || !valid_readest_hash(&book.readest_hash)
            {
                return Err(PortableError::invalid_data("重复或无效的迁入书籍"));
            }
            if book.progress.is_some() && self.bases.values().any(|basis| matches!(basis, StoredBasis::Progress(b) if b.entity.book_hash() == book.book_hash)) {
                return Err(import_error("reader-busy", "请先退出这本书的所有阅读会话，再迁入进度"));
            }
        }
        let transaction = self.connection.unchecked_transaction()?;
        let device_id = ensure_installation_id(&transaction)?;
        let mut counter = load_counter(&transaction)?;
        let mut outcome = ReadestImportOutcome::default();
        let mut changed = BTreeSet::new();
        let mut progress_changed = BTreeSet::new();
        for (target, book) in books {
            if cancelled() {
                return Err(import_error("cancelled", "迁入已取消"));
            }
            let current = load_book_meta_row(&transaction, &book.book_hash)?;
            let binding: Option<String> = transaction
                .query_row(
                    "SELECT json FROM device_bindings WHERE hash=?1",
                    [&book.book_hash],
                    |row| row.get(0),
                )
                .optional()?;
            if target.generation != self.runtime_generation
                || current.as_ref().map(|m| &m.stamp) != Some(&target.metadata_stamp)
                || binding.as_ref() != Some(&target.binding)
            {
                return Err(PortableError::stale_basis(
                    "书籍或原书绑定已变化，请重新预览",
                ));
            }
            let mut book_changed = false;
            if let Some(value) = &book.progress {
                dto::validate_progress(&Some(value.clone()))?;
                let (current, revision) = load_progress_row(&transaction, &book.book_hash)?
                    .unwrap_or((ProgressState { versions: vec![] }, 0));
                if revision != target.progress_revision {
                    return Err(PortableError::stale_basis("本机进度已变化，请重新预览"));
                }
                let key = receipt_key(&book.book_hash, &book.readest_hash);
                // Pagination-derived percentage is not the identity of a position.
                let fingerprint = format!(
                    "{:x}",
                    Sha256::digest(serialize_json(&value.locator)?.as_bytes())
                );
                let prior: Option<String> = load_meta_json(&transaction, &key)?;
                let unchanged = prior.as_ref() == Some(&fingerprint)
                    || (current.versions.len() == 1
                        && current.versions[0]
                            .value
                            .as_ref()
                            .is_some_and(|p| p.locator == value.locator));
                if unchanged {
                    outcome.progress_unchanged += 1;
                } else {
                    counter = next_local_counter(
                        counter.max(maximum_received_counter(&current.versions, &[], &[])?),
                        0,
                    )?;
                    let stamp = Stamp {
                        device_id: device_id.clone(),
                        counter,
                    };
                    let versions = super::super::merge::write_observed(
                        &current.versions,
                        &current.versions,
                        stamp,
                        Some(value.clone()),
                        now,
                    )?;
                    save_progress_row(
                        &transaction,
                        &book.book_hash,
                        &ProgressState { versions },
                        counter,
                    )?;
                    outcome.progress_written += 1;
                    progress_changed.insert(book.book_hash.clone());
                    book_changed = true;
                }
                put_meta_json(&transaction, &key, &fingerprint)?;
            }
            macro_rules! append {
                ($items:expr, $kind:literal, $validate:path, $load:path, $save:path, $count:ident) => {
                    for item in $items {
                        if cancelled() {
                            return Err(import_error("cancelled", "迁入已取消"));
                        }
                        $validate(&item.value)?;
                        let id = annotation_id(
                            &book.book_hash,
                            &book.readest_hash,
                            $kind,
                            &item.source_key,
                        )?;
                        if $load(&transaction, &book.book_hash, &id)?.is_some() {
                            outcome.skipped_existing += 1;
                            continue;
                        }
                        counter = next_local_counter(counter, 0)?;
                        let stamp = Stamp {
                            device_id: device_id.clone(),
                            counter,
                        };
                        let versions = super::super::merge::write_observed(
                            &[],
                            &[],
                            stamp,
                            item.value.clone(),
                            now,
                        )?;
                        $save(
                            &transaction,
                            &book.book_hash,
                            &id,
                            &Annotation {
                                versions,
                                deleted: None,
                            },
                            counter,
                        )?;
                        outcome.$count += 1;
                        book_changed = true;
                    }
                };
            }
            append!(
                &book.bookmarks,
                "bookmark",
                dto::validate_bookmark,
                load_bookmark_row,
                save_bookmark_row,
                bookmarks_added
            );
            append!(
                &book.notes,
                "note",
                dto::validate_note,
                load_note_row,
                save_note_row,
                notes_added
            );
            if book_changed {
                changed.insert(book.book_hash.clone());
            }
        }
        store_counter(&transaction, counter)?;
        if cancelled() {
            return Err(import_error("cancelled", "迁入已取消"));
        }
        finish(transaction)?;
        outcome.imported_books = changed.len();
        // New annotations leave unrelated live editor/reader bases intact.
        // Only replaced progress makes prior read snapshots obsolete.
        self.reads
            .retain(|_, snapshot| !progress_changed.contains(&snapshot.book_hash));
        Ok(outcome)
    }
}
