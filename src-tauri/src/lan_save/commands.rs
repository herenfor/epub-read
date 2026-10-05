use super::address_selection::LanAddressInfo;
use super::error::LanSaveError;
use super::manager::{
    accept, close, commit, event_sink, host_with_bind_ip, join, list_local_addresses, send,
    LanCloseResult, LanHostResult, LanJoinResult, LanSendResult,
};
use super::session::LanSaveEvent;
use crate::save_file::{SaveExportScope, SaveFileCommitResult, SaveFilePrepareResult};
use tauri::ipc::Channel;
use tauri::AppHandle;

#[tauri::command]
pub async fn lan_save_host(
    app: AppHandle,
    on_event: Channel<LanSaveEvent>,
    bind_ip: Option<String>,
) -> Result<LanHostResult, LanSaveError> {
    host_with_bind_ip(&app, event_sink(on_event), bind_ip).await
}

#[tauri::command]
pub async fn lan_save_list_addresses(app: AppHandle) -> Result<Vec<LanAddressInfo>, LanSaveError> {
    list_local_addresses(&app).await
}

#[tauri::command]
pub async fn lan_save_join(
    app: AppHandle,
    pairing_info: String,
    on_event: Channel<LanSaveEvent>,
) -> Result<LanJoinResult, LanSaveError> {
    join(&app, &pairing_info, event_sink(on_event)).await
}

#[tauri::command]
pub async fn lan_save_send(
    app: AppHandle,
    session_id: String,
    scope: SaveExportScope,
    include_books: bool,
) -> Result<LanSendResult, LanSaveError> {
    send(&app, &session_id, scope, include_books).await
}

#[tauri::command]
pub async fn lan_save_accept(
    app: AppHandle,
    session_id: String,
    transfer_id: String,
) -> Result<SaveFilePrepareResult, LanSaveError> {
    accept(&app, &session_id, &transfer_id).await
}

#[tauri::command]
pub async fn lan_save_commit(
    app: AppHandle,
    session_id: String,
    transfer_id: String,
    apply_preferences: bool,
) -> Result<SaveFileCommitResult, LanSaveError> {
    commit(&app, &session_id, &transfer_id, apply_preferences).await
}

#[tauri::command]
pub async fn lan_save_close(
    app: AppHandle,
    session_id: String,
) -> Result<LanCloseResult, LanSaveError> {
    close(&app, &session_id).await
}
