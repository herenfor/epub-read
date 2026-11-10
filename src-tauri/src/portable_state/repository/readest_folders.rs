//! Readest classification is published in the same transaction as its books.
use super::*;
use crate::library_organization::{
    project_folder_tree, BookOrganization, FolderState, Register as FolderRegister,
    MAX_FOLDER_DEPTH,
};

pub(super) fn apply<'a>(
    transaction: &rusqlite::Transaction<'_>,
    paths: impl Iterator<Item = (&'a str, &'a [String])>,
    device_id: &str,
    counter: &mut u64,
) -> PortableResult<BTreeSet<String>> {
    let mut state = load_organization(transaction)?;
    let tree = project_folder_tree(&state);
    // Reuse only same-name siblings, never a name from a different parent.
    let mut folders: BTreeMap<(Option<String>, String), String> = tree
        .parent_by_id
        .iter()
        .rev()
        .map(|(id, parent)| {
            (
                (parent.clone(), state.folders[id].name.value.clone()),
                id.clone(),
            )
        })
        .collect();
    let mut changed = BTreeSet::new();
    for (hash, path) in paths {
        if path.is_empty() || path.len() > MAX_FOLDER_DEPTH {
            return Err(PortableError::invalid_data("Readest 文件夹层级无效"));
        }
        for name in path {
            if name.contains('\0')
                || crate::library_organization::normalize_folder_name(name).is_err()
                || name.trim() != name
            {
                return Err(PortableError::invalid_data(
                    "Readest 文件夹名称需为 1-40 个字符",
                ));
            }
        }
        // Includes promotion to a surviving ancestor after local folder deletion.
        if effective_folder_id(&state, hash).is_some() {
            continue;
        }
        let mut parent = None;
        for name in path {
            let key = (parent.clone(), name.clone());
            let id = if let Some(id) = folders.get(&key) {
                id.clone()
            } else {
                let id = legacy::random_uuid_v4()?;
                *counter = next_local_counter(*counter, 0)?;
                let stamp = OrganizationStamp {
                    device_id: device_id.into(),
                    counter: *counter,
                };
                state.folders.insert(
                    id.clone(),
                    FolderState {
                        name: FolderRegister {
                            value: name.clone(),
                            stamp: stamp.clone(),
                        },
                        parent_id: Some(FolderRegister {
                            value: parent.clone(),
                            stamp,
                        }),
                        deleted: None,
                    },
                );
                folders.insert(key, id.clone());
                id
            };
            parent = Some(id);
        }
        *counter = next_local_counter(*counter, 0)?;
        state
            .books
            .entry(hash.into())
            .or_insert_with(|| BookOrganization {
                favorite: None,
                folder_id: None,
            })
            .folder_id = Some(FolderRegister {
            value: parent,
            stamp: OrganizationStamp {
                device_id: device_id.into(),
                counter: *counter,
            },
        });
        changed.insert(hash.to_owned());
    }
    if !changed.is_empty() {
        store_organization(transaction, &state)?;
    }
    Ok(changed)
}
