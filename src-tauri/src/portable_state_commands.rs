//! CP-I registration for the frozen S0 portable-state repository wire.
//!
//! The repository algorithms live in `portable_state`; this module owns the
//! process-lifetime `PortableStore`, the one-time legacy migration and the
//! Tauri command boundary. Migration failure returns an error and removes the
//! just-created database file so callers can keep the complete legacy mode.

use crate::library_organization::{LibraryOrganization, OrganizationCommand};
use crate::portable_state::{
    AdoptSelection, BookmarkValue, EntityRef, MigrationOutcome, NoteValue, PortableError,
    PortableResult, PortableStateV3, PortableStore, ProgressValue, ReleaseTarget, WriteIntent,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Default)]
pub struct PortableStateManager {
    store: Mutex<Option<PortableStore>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableActivationResult {
    pub status: String,
    pub books: usize,
    pub annotations: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableRuntimeStatus {
    pub repository_generation: String,
    pub repository_ready: bool,
}

fn storage_error(message: impl Into<String>) -> PortableError {
    PortableError::storage_error(message)
}

fn data_root<R: Runtime>(app: &AppHandle<R>) -> PortableResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("linked-library"))
        .map_err(|error| storage_error(format!("无法取得应用本地数据目录：{error}")))
}

fn open_and_activate<R: Runtime>(
    app: &AppHandle<R>,
) -> PortableResult<(PortableStore, PortableActivationResult)> {
    let root = data_root(app)?;
    let path = root.join("library.sqlite3");
    let mut store = PortableStore::open(&path)?;
    if store.migration_completed()? {
        let state = store.snapshot()?;
        let annotations = state
            .books
            .values()
            .map(|book| book.bookmarks.len() + book.notes.len())
            .sum();
        return Ok((
            store,
            PortableActivationResult {
                status: "already-migrated".to_string(),
                books: state.books.len(),
                annotations,
            },
        ));
    }
    match store.migrate_legacy(&root) {
        Ok(MigrationOutcome::Migrated { books, annotations }) => {
            let state = store.snapshot()?;
            Ok((
                store,
                PortableActivationResult {
                    status: if books == 0 { "fresh".to_string() } else { "migrated".to_string() },
                    books: state.books.len(),
                    annotations,
                },
            ))
        }
        Ok(MigrationOutcome::AlreadyMigrated) => {
            let state = store.snapshot()?;
            let annotations = state
                .books
                .values()
                .map(|book| book.bookmarks.len() + book.notes.len())
                .sum();
            Ok((
                store,
                PortableActivationResult {
                    status: "already-migrated".to_string(),
                    books: state.books.len(),
                    annotations,
                },
            ))
        }
        Err(error) => {
            drop(store);
            let _ = std::fs::remove_file(&path);
            Err(error)
        }
    }
}

pub(crate) fn activate_store<R: Runtime>(
    app: &AppHandle<R>,
) -> PortableResult<PortableActivationResult> {
    let manager = app.state::<PortableStateManager>();
    let mut guard = manager
        .store
        .lock()
        .map_err(|_| storage_error("可移植资料仓储锁已损坏"))?;
    if let Some(store) = guard.as_ref() {
        let state = store.snapshot()?;
        let annotations = state
            .books
            .values()
            .map(|book| book.bookmarks.len() + book.notes.len())
            .sum();
        return Ok(PortableActivationResult {
            status: "already-migrated".to_string(),
            books: state.books.len(),
            annotations,
        });
    }
    let (store, result) = open_and_activate(app)?;
    *guard = Some(store);
    Ok(result)
}

/// Run `work` only when the one-time portable activation has already happened.
/// Linked-library commands use this to keep the complete old JSON mode when the
/// activation never succeeded.
pub(crate) fn with_existing_store<R: Runtime, T>(
    app: &AppHandle<R>,
    work: impl FnOnce(&mut PortableStore) -> PortableResult<T>,
) -> PortableResult<Option<T>> {
    let manager = app.state::<PortableStateManager>();
    let mut guard = manager
        .store
        .lock()
        .map_err(|_| storage_error("可移植资料仓储锁已损坏"))?;
    match guard.as_mut() {
        Some(store) => work(store).map(Some),
        None => Ok(None),
    }
}

fn with_store<R: Runtime, T>(
    app: &AppHandle<R>,
    manager: &State<'_, PortableStateManager>,
    work: impl FnOnce(&mut PortableStore) -> PortableResult<T>,
) -> PortableResult<T> {
    let mut guard = manager
        .store
        .lock()
        .map_err(|_| storage_error("可移植资料仓储锁已损坏"))?;
    if guard.is_none() {
        let (store, _) = open_and_activate(app)?;
        *guard = Some(store);
    }
    work(guard.as_mut().expect("portable store initialized"))
}

fn to_value<T: Serialize>(value: &T) -> PortableResult<serde_json::Value> {
    serde_json::to_value(value).map_err(|error| storage_error(format!("资料结果无法序列化：{error}")))
}

#[tauri::command]
pub fn portable_state_activate(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
) -> PortableResult<PortableActivationResult> {
    let _ = manager;
    activate_store(&app)
}

fn runtime_status_for_manager(
    manager: &PortableStateManager,
) -> PortableResult<PortableRuntimeStatus> {
    let guard = manager
        .store
        .lock()
        .map_err(|_| storage_error("可移植资料仓储锁已损坏"))?;
    let (repository_generation, repository_ready) = match guard.as_ref() {
        Some(store) => (store.runtime_generation().to_string(), true),
        // Do not activate, snapshot or migrate from a health check.
        None => ("runtime-uninitialized".to_string(), false),
    };
    Ok(PortableRuntimeStatus {
        repository_generation,
        repository_ready,
    })
}

#[tauri::command]
pub async fn portable_state_runtime_status(
    app: AppHandle,
) -> PortableResult<PortableRuntimeStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<PortableStateManager>();
        runtime_status_for_manager(&manager)
    })
    .await
    .map_err(|error| storage_error(format!("运行时状态检查线程失败：{error}")))?
}

#[tauri::command]
pub fn portable_state_read(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    book_hash: String,
) -> PortableResult<serde_json::Value> {
    let (read_id, book) = with_store(&app, &manager, |store| store.read(&book_hash))?;
    Ok(serde_json::json!({ "readId": read_id, "book": book }))
}

#[tauri::command]
pub fn portable_state_adopt(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    read_id: String,
    entity: EntityRef,
    selection: AdoptSelection,
) -> PortableResult<serde_json::Value> {
    let basis_id = with_store(&app, &manager, |store| store.adopt(&read_id, entity, selection))?;
    Ok(serde_json::json!({ "basisId": basis_id }))
}

#[tauri::command]
pub fn portable_state_write(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    basis_id: String,
    intent: WriteIntent,
    value: serde_json::Value,
    updated_at_ms: u64,
) -> PortableResult<serde_json::Value> {
    with_store(&app, &manager, |store| {
        let entity = store.basis_entity(&basis_id)?;
        match entity {
            EntityRef::Progress { .. } => {
                let value: ProgressValue = serde_json::from_value(value)
                    .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
                let outcome = store.write_progress(&basis_id, intent, value, updated_at_ms)?;
                to_value(&outcome)
            }
            EntityRef::Bookmark { .. } => {
                let value: BookmarkValue = serde_json::from_value(value)
                    .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
                let outcome = store.write_bookmark(&basis_id, intent, value, updated_at_ms)?;
                to_value(&outcome)
            }
            EntityRef::Note { .. } => {
                let value: NoteValue = serde_json::from_value(value)
                    .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
                let outcome = store.write_note(&basis_id, intent, value, updated_at_ms)?;
                to_value(&outcome)
            }
        }
    })
}

#[tauri::command]
pub fn portable_state_create_annotation(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    book_hash: String,
    kind: String,
    id: String,
    value: serde_json::Value,
    updated_at_ms: u64,
) -> PortableResult<serde_json::Value> {
    with_store(&app, &manager, |store| match kind.as_str() {
        "bookmark" => {
            let value: BookmarkValue = serde_json::from_value(value)
                .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
            let outcome = store.create_bookmark(&book_hash, &id, value, updated_at_ms)?;
            to_value(&outcome)
        }
        "note" => {
            let value: NoteValue = serde_json::from_value(value)
                .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
            let outcome = store.create_note(&book_hash, &id, value, updated_at_ms)?;
            to_value(&outcome)
        }
        _ => Err(PortableError::invalid_data("invalid-data：未知注解类型")),
    })
}

#[tauri::command]
pub fn portable_state_delete_annotation(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    entity: EntityRef,
) -> PortableResult<serde_json::Value> {
    with_store(&app, &manager, |store| match entity {
        EntityRef::Progress { .. } => Err(PortableError::invalid_entity(
            "invalid-entity：delete_annotation 只接受 bookmark/note",
        )),
        EntityRef::Bookmark { book_hash, id } => {
            let outcome = store.delete_bookmark(&book_hash, &id)?;
            to_value(&outcome)
        }
        EntityRef::Note { book_hash, id } => {
            let outcome = store.delete_note(&book_hash, &id)?;
            to_value(&outcome)
        }
    })
}

#[tauri::command]
pub fn portable_state_release(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    basis_id: Option<String>,
    read_id: Option<String>,
    book_hash: Option<String>,
) -> PortableResult<()> {
    let target = match (basis_id, read_id, book_hash) {
        (Some(basis_id), None, None) => ReleaseTarget::BasisId(basis_id),
        (None, Some(read_id), None) => ReleaseTarget::ReadId(read_id),
        (None, None, Some(book_hash)) => ReleaseTarget::BookHash(book_hash),
        _ => {
            return Err(PortableError::invalid_data(
                "invalid-data：release 需要且只能提供一种目标",
            ))
        }
    };
    with_store(&app, &manager, |store| store.release(target))
}

#[tauri::command]
pub fn portable_state_snapshot(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
) -> PortableResult<PortableStateV3> {
    with_store(&app, &manager, |store| store.snapshot())
}

#[tauri::command]
pub fn portable_state_merge_state(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    state: serde_json::Value,
    apply_preferences: Option<bool>,
    migration_mark: Option<String>,
) -> PortableResult<PortableStateV3> {
    let _ = (apply_preferences, migration_mark);
    let incoming: PortableStateV3 = serde_json::from_value(state)
        .map_err(|error| PortableError::invalid_data(format!("invalid-data：{error}")))?;
    with_store(&app, &manager, |store| store.merge_validated_state(incoming))
}

#[tauri::command]
pub fn portable_state_get_organization(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
) -> PortableResult<LibraryOrganization> {
    with_store(&app, &manager, |store| Ok(store.snapshot()?.organization))
}

#[tauri::command]
pub fn portable_state_apply_organization(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    command: OrganizationCommand,
) -> PortableResult<LibraryOrganization> {
    with_store(&app, &manager, |store| store.apply_organization_command(&command))
}

#[tauri::command]
pub fn portable_state_merge_organization(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    incoming: LibraryOrganization,
) -> PortableResult<LibraryOrganization> {
    with_store(&app, &manager, |store| store.merge_organization_state(&incoming))
}

#[tauri::command]
pub fn portable_state_merge_legacy_records(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    records: Vec<serde_json::Value>,
    organization: Option<LibraryOrganization>,
) -> PortableResult<PortableStateV3> {
    with_store(&app, &manager, |store| {
        let organization = match organization {
            Some(organization) => organization,
            None => store.snapshot()?.organization,
        };
        store.import_legacy_records_json(records, organization)
    })
}

#[tauri::command]
pub fn portable_state_list_local_visible(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
) -> PortableResult<Vec<String>> {
    with_store(&app, &manager, |store| store.local_visible_hashes())
}

#[tauri::command]
pub fn portable_state_set_local_visible(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    hash: String,
    visible: bool,
) -> PortableResult<()> {
    with_store(&app, &manager, |store| store.set_local_visible(&hash, visible))
}

#[tauri::command]
pub fn portable_state_reserve_stamps(
    app: AppHandle,
    manager: State<'_, PortableStateManager>,
    count: u64,
) -> PortableResult<serde_json::Value> {
    let stamp = with_store(&app, &manager, |store| store.reserve_stamps(count))?;
    to_value(&stamp)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::portable_state::PortableStore;

    #[test]
    fn runtime_status_is_read_only_and_reports_store_generation() {
        let manager = PortableStateManager::default();
        let before = runtime_status_for_manager(&manager).unwrap();
        assert!(!before.repository_ready);
        assert_eq!(before.repository_generation, "runtime-uninitialized");

        // Populate the manager exactly as activation would; the status check
        // must then see the live repository without snapshotting it.
        {
            let mut guard = manager.store.lock().unwrap();
            *guard = Some(PortableStore::open_in_memory().unwrap());
        }
        let after = runtime_status_for_manager(&manager).unwrap();
        assert!(after.repository_ready);
        assert!(!after.repository_generation.is_empty());
        assert_ne!(after.repository_generation, "runtime-uninitialized");
        // The test-only store remains present; no hidden activation replaced it.
        assert!(manager.store.lock().unwrap().is_some());
    }
}
