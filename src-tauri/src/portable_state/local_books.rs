//! Local book removal shared by explicit deletion and the one-time v2 conversion.
use super::{PortableError, PortableResult};
use crate::library_organization::LibraryOrganization;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeSet;

/// Caller owns the transaction. Folders and installation-wide state survive.
pub(super) fn purge(connection: &Connection, hashes: &[String]) -> PortableResult<()> {
    if hashes.is_empty() {
        return Ok(());
    }
    let removed: BTreeSet<&str> = hashes.iter().map(String::as_str).collect();
    let organization: Option<String> = connection
        .query_row("SELECT json FROM organization WHERE key='state'", [], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(raw) = organization {
        let mut state: LibraryOrganization = serde_json::from_str(&raw)
            .map_err(|e| PortableError::storage_error(format!("分类资料无法读取：{e}")))?;
        state
            .books
            .retain(|hash, _| !removed.contains(hash.as_str()));
        let raw = serde_json::to_string(&state)
            .map_err(|e| PortableError::storage_error(format!("分类资料无法保存：{e}")))?;
        connection.execute("UPDATE organization SET json=?1 WHERE key='state'", [raw])?;
    }
    for key in ["visibleHashes", "isNewHashes"] {
        let raw: Option<String> = connection
            .query_row("SELECT json FROM local_meta WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(raw) = raw {
            let mut values: BTreeSet<String> = serde_json::from_str(&raw)
                .map_err(|e| PortableError::storage_error(format!("本机标记无法读取：{e}")))?;
            values.retain(|hash| !removed.contains(hash.as_str()));
            let raw = serde_json::to_string(&values)
                .map_err(|e| PortableError::storage_error(format!("本机标记无法保存：{e}")))?;
            connection.execute(
                "UPDATE local_meta SET json=?1 WHERE key=?2",
                params![raw, key],
            )?;
        }
    }
    for table in ["annotations", "progress", "device_bindings", "book_meta"] {
        let mut delete = connection.prepare(&format!("DELETE FROM {table} WHERE hash=?1"))?;
        for hash in hashes {
            delete.execute([hash])?;
        }
    }
    Ok(())
}

/// A binding makes a book visible in the real shelf projection even when its
/// file is missing or its old visibleHashes flag was absent. Never stat sources.
pub(super) fn purge_unbound(connection: &Connection) -> PortableResult<()> {
    let mut query = connection.prepare(
        "SELECT hash FROM book_meta UNION SELECT hash FROM progress UNION SELECT hash FROM annotations",
    )?;
    let mut candidates = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let organization: Option<String> = connection
        .query_row("SELECT json FROM organization WHERE key='state'", [], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(raw) = organization {
        let state: LibraryOrganization = serde_json::from_str(&raw)
            .map_err(|e| PortableError::storage_error(format!("分类资料无法读取：{e}")))?;
        candidates.extend(state.books.into_keys());
    }
    for key in ["visibleHashes", "isNewHashes"] {
        let raw: Option<String> = connection
            .query_row("SELECT json FROM local_meta WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(raw) = raw {
            candidates.extend(
                serde_json::from_str::<BTreeSet<String>>(&raw)
                    .map_err(|e| PortableError::storage_error(format!("本机标记无法读取：{e}")))?,
            );
        }
    }
    // A dangling binding without metadata is not an actual shelf book either.
    let mut query = connection.prepare("SELECT hash FROM device_bindings")?;
    candidates.extend(
        query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?,
    );
    let mut query = connection
        .prepare("SELECT b.hash FROM book_meta b JOIN device_bindings d ON b.hash=d.hash")?;
    let retained = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    candidates.retain(|hash| !retained.contains(hash));
    purge(connection, &candidates.into_iter().collect::<Vec<_>>())
}
