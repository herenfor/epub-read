//! Receiving policy only; archive DTOs and transport versions stay unchanged.
use super::{PortableResult, PortableStateV3};
use crate::library_organization::{folder_stored_lineage, merge_organization, normalize_organization};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImportBook {
    pub content_hash: String,
    pub title: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub struct LocalImportSelection {
    pub state: PortableStateV3,
    pub skipped_books: Vec<SkippedImportBook>,
}

/// `eligible` is proven from local book+binding rows or bindings published by
/// this commit, never from whether an external source file currently exists.
pub fn select_local_import(
    local: &PortableStateV3,
    incoming: &PortableStateV3,
    eligible: &BTreeSet<String>,
    failed_attachments: &BTreeSet<String>,
) -> PortableResult<LocalImportSelection> {
    let mut skipped_books = Vec::new();
    let books = incoming
        .books
        .iter()
        .filter_map(|(hash, book)| {
            let reason = if failed_attachments.contains(hash) {
                Some("attachment-import-failed")
            } else if !eligible.contains(hash) {
                Some("not-local")
            } else {
                None
            };
            if let Some(reason) = reason {
                skipped_books.push(SkippedImportBook {
                    content_hash: hash.clone(),
                    title: book.metadata.value.title.clone(),
                    reason: reason.into(),
                    message: None,
                });
                None
            } else {
                Some((hash.clone(), book.clone()))
            }
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut organization = normalize_organization(incoming.organization.clone())
        .map_err(super::PortableError::invalid_data)?;
    organization
        .books
        .retain(|hash, _| books.contains_key(hash));
    // Evaluate the winning placement, so a stale placement cannot create an
    // unused folder. Existing folder rename/deletion events still apply.
    let projected = merge_organization(&local.organization, &organization)
        .map_err(super::PortableError::invalid_data)?;
    // Keep the raw folder reference and every stored ancestor, including a
    // tombstoned folder: promotion to a live ancestor without that tombstone
    // would change where the retained book lands.
    let needed: BTreeSet<String> = local
        .books
        .keys()
        .chain(books.keys())
        .flat_map(|hash| {
            projected
                .books
                .get(hash)
                .and_then(|book| book.folder_id.as_ref())
                .and_then(|register| register.value.as_deref())
                .map(|folder_id| folder_stored_lineage(&projected, folder_id))
                .unwrap_or_default()
        })
        .collect();
    organization
        .folders
        .retain(|id, _| local.organization.folders.contains_key(id) || needed.contains(id));
    Ok(LocalImportSelection {
        state: PortableStateV3 {
            schema_version: super::dto::portable_schema_version(&books, &organization),
            books,
            organization,
            preferences: incoming.preferences.clone(),
        },
        skipped_books,
    })
}
