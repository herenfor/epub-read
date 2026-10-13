//! Device-local linked library binding operations.

use super::*;

pub(super) fn binding_view(
    record: LinkedLibraryRecord,
    binding: Option<&DeviceBinding>,
    thumbnail_mime: String,
    library_root: &Path,
) -> LinkedLibraryRecordView {
    let (available, file_size, cover_mime) = binding
        .map(|binding| {
            let available = binding
                .resolve_source(library_root)
                .ok()
                .and_then(|source| snapshot(source.path()).ok())
                .map(|current| {
                    current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns
                })
                .unwrap_or(false);
            (available, binding.file_size, binding.cover_mime.clone())
        })
        .unwrap_or((false, 0, String::new()));
    LinkedLibraryRecordView {
        id: record.content_hash.clone(),
        content_hash: record.content_hash,
        title: record.title,
        creator: record.creator,
        language: record.language,
        file_name: record.file_name,
        added_at_ms: record.added_at_ms,
        last_read_at_ms: record.last_read_at_ms,
        spine_index: record.spine_index,
        page: record.page,
        progress_pct: record.progress_pct,
        anchor_index: record.anchor_index,
        anchor_ratio: record.anchor_ratio,
        anchor_text_offset: record.anchor_text_offset,
        anchor_text_snippet: record.anchor_text_snippet,
        media_anchor: record.media_anchor,
        bookmarks: record.bookmarks,
        notes: record.notes,
        is_new: record.is_new,
        available,
        file_size,
        cover_mime,
        thumbnail_mime,
    }
}

pub(super) fn view_by_hash(
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
    thumbnails: &ThumbnailIndex,
    hash: &str,
    library_root: &Path,
) -> Option<LinkedLibraryRecordView> {
    records
        .iter()
        .find(|record| record.content_hash == hash)
        .cloned()
        .map(|record| {
            binding_view(
                record,
                bindings.iter().find(|binding| binding.content_hash == hash),
                thumbnails
                    .entries
                    .iter()
                    .find(|entry| entry.content_hash == hash)
                    .map(|entry| entry.mime.clone())
                    .unwrap_or_default(),
                library_root,
            )
        })
}

pub(super) fn upsert_binding(bindings: &mut Vec<DeviceBinding>, binding: DeviceBinding) {
    bindings.retain(|existing| existing.content_hash != binding.content_hash);
    bindings.push(binding);
}

pub(crate) fn make_binding(
    hash: String,
    path: &Path,
    snapshot: FileSnapshot,
    metadata: &ImportedMetadata,
) -> DeviceBinding {
    DeviceBinding {
        content_hash: hash,
        storage_kind: StorageKind::Linked,
        canonical_source_path: Some(path.to_string_lossy().into_owned()),
        file_size: snapshot.size,
        source_mtime_ns: snapshot.mtime_ns,
        cover_zip_path: metadata.cover_zip_path.clone(),
        cover_mime: metadata.cover_mime.clone(),
        last_verified_at_ms: now_ms(),
    }
}

/// Verifies an already-bound source only when its cheap stat signature
/// changes.  A different hash never replaces the binding: the portable record
/// keeps its identity and is reported unavailable until the user explicitly
/// relinks.  A managed source is always resolved from root + hash, never from
/// a persisted path.
pub(super) fn verify_binding(
    binding: &mut DeviceBinding,
    library_root: &Path,
) -> Result<BindingVerification, String> {
    let source = binding.resolve_source(library_root)?;
    let source_path = source.path();
    let current = snapshot(source_path)?;
    if current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns {
        return Ok(BindingVerification {
            available: true,
            changed: false,
        });
    }
    let (actual_hash, verified_snapshot) = hash_file(source_path)?;
    if actual_hash != binding.content_hash {
        return Ok(BindingVerification {
            available: false,
            changed: false,
        });
    }
    binding.file_size = verified_snapshot.size;
    binding.source_mtime_ns = verified_snapshot.mtime_ns;
    binding.last_verified_at_ms = now_ms();
    Ok(BindingVerification {
        available: true,
        changed: true,
    })
}

/// Refresh-list semantics.  Linked sources keep the existing verification
/// behavior, including a full hash after a stat change.  Managed sources are
/// application-owned and usually refreshed from `stat` only: a mismatched
/// signature is reported unavailable until the user opens the book (explicit
/// verification) or reimports it.  A managed refresh must never trigger an
/// unconditional whole-book hash or rewrite the stored signature by itself.
pub(crate) fn verify_binding_for_list_refresh(
    binding: &mut DeviceBinding,
    library_root: &Path,
) -> Result<BindingVerification, String> {
    if binding.storage_kind == StorageKind::Managed {
        let source = binding.resolve_source(library_root)?;
        let available = snapshot(source.path())
            .map(|current| {
                current.size == binding.file_size && current.mtime_ns == binding.source_mtime_ns
            })
            .unwrap_or(false);
        return Ok(BindingVerification {
            available,
            changed: false,
        });
    }
    verify_binding(binding, library_root)
}
