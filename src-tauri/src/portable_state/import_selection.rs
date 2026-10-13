//! Receiving policy only; archive DTOs and transport versions stay unchanged.
use super::{PortableResult, PortableStateV3};
use crate::library_organization::{effective_folder_id, merge_organization};
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
    let mut organization = incoming.organization.clone();
    organization
        .books
        .retain(|hash, _| books.contains_key(hash));
    // Evaluate the winning placement, so a stale placement cannot create an
    // unused folder. Existing folder rename/deletion events still apply.
    let projected = merge_organization(&local.organization, &organization)
        .map_err(super::PortableError::invalid_data)?;
    let needed: BTreeSet<String> = local
        .books
        .keys()
        .chain(books.keys())
        .filter_map(|hash| effective_folder_id(&projected, hash).map(str::to_string))
        .collect();
    organization
        .folders
        .retain(|id, _| local.organization.folders.contains_key(id) || needed.contains(id));
    Ok(LocalImportSelection {
        state: PortableStateV3 {
            schema_version: incoming.schema_version,
            books,
            organization,
            preferences: incoming.preferences.clone(),
        },
        skipped_books,
    })
}
