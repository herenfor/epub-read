//! Process service and Tauri boundary. No network starts before an explicit
//! confirmed connection plus a trigger; a status query never opens the library.
use super::{
    engine::{self, Repository},
    model::*,
    remote::*,
    scheduler::Schedule,
    secrets,
    storage::{Disk, Identity, Session},
    Space, FORMAT_VERSION, SPACE_FORMAT,
};
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, OwnedMutexGuard};

struct Ticket {
    preview: ConnectionPreview,
    created: Instant,
    settings: Settings,
    password: String,
}

struct Control {
    loaded: bool,
    admin_busy: bool,
    epoch: u64,
    status: Status,
    schedule: Schedule,
    devices: Vec<DeviceInfo>,
    ticket: Option<Ticket>,
    round_cancel: Cancel,
    timer_cancel: Cancel,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            loaded: false,
            admin_busy: false,
            epoch: 0,
            status: Status::default(),
            schedule: Schedule::default(),
            devices: Vec::new(),
            ticket: None,
            round_cancel: Cancel::default(),
            timer_cancel: Cancel::default(),
        }
    }
}

pub struct CloudSyncManager {
    gate: Arc<tokio::sync::Mutex<()>>,
    control: Mutex<Control>,
    activity: watch::Sender<Activity>,
}

impl Default for CloudSyncManager {
    fn default() -> Self {
        Self {
            gate: Arc::new(tokio::sync::Mutex::new(())),
            control: Mutex::new(Control::default()),
            activity: watch::channel(Activity::default()).0,
        }
    }
}

impl CloudSyncManager {
    fn lock(&self) -> Result<MutexGuard<'_, Control>> {
        self.control
            .lock()
            .map_err(|_| Failure::new(FailureCode::LocalStateInvalid))
    }
}

fn disk(app: &AppHandle) -> Result<Disk> {
    Ok(Disk {
        root: app
            .path()
            .app_local_data_dir()
            .map_err(|_| Failure::new(FailureCode::StorageError))?
            .join("cloud-sync"),
    })
}

/// Apply a completed metadata round only when it still belongs to the current
/// lifecycle generation. A late round must not overwrite a newer connection,
/// phase or schedule, and it must not clear a newer round's `running` flag.
fn finish_round(control: &mut Control, epoch: u64, result: &Result<engine::Outcome>) -> bool {
    if control.epoch != epoch {
        return false;
    }
    match result {
        Ok(outcome) => {
            control.status.connection = Some(outcome.session.info());
            control.status.last_success_at_ms = outcome.session.last_success_at_ms;
            control.status.last_error = None;
            control.status.issues = outcome.issues.clone();
            control.status.local_changed = outcome.changed;
            control.status.cloud_only_book_count = outcome.cloud_only_count;
            control.devices = outcome.session.devices.clone();
            control.status.device_count = control.devices.len();
            control.status.phase = Phase::Idle;
        }
        Err(error) => {
            control.status.last_error = Some(error.clone());
            control.status.phase = if error.code == FailureCode::Cancelled {
                Phase::Idle
            } else {
                Phase::Error
            };
        }
    }
    control.schedule.finish(now_ms(), result.as_ref().err());
    true
}

fn status(control: &Control) -> Status {
    let mut status = control.status.clone();
    status.native_ready = secrets::available();
    status.pending = control.schedule.pending;
    status.retry_at_ms = control.schedule.retry_at;
    status
}

fn emit(app: &AppHandle) {
    let snapshot = app.state::<CloudSyncManager>().lock().map(|c| status(&c));
    if let Ok(snapshot) = snapshot {
        #[derive(Clone, serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Event<'a> {
            connection_id: Option<&'a str>,
            phase: Phase,
            pending: bool,
            last_success_at_ms: Option<u64>,
            retry_at_ms: Option<u64>,
            local_changed: bool,
            last_error: &'a Option<Failure>,
            device_count: usize,
            cloud_only_book_count: usize,
            issue_count: usize,
        }
        // Broadcast lifecycle only. Saved account/server configuration remains
        // in the explicit get_status reply, never in global event payloads.
        let event = Event {
            connection_id: snapshot
                .connection
                .as_ref()
                .map(|c| c.connection_id.as_str()),
            phase: snapshot.phase,
            pending: snapshot.pending,
            last_success_at_ms: snapshot.last_success_at_ms,
            retry_at_ms: snapshot.retry_at_ms,
            local_changed: snapshot.local_changed,
            last_error: &snapshot.last_error,
            device_count: snapshot.device_count,
            cloud_only_book_count: snapshot.cloud_only_book_count,
            issue_count: snapshot.issues.len(),
        };
        let _ = app.emit("cloud-sync-status", event);
    }
}

pub(super) fn current_connection<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<ConnectionInfo>> {
    let manager = app.state::<CloudSyncManager>();
    let result = manager.lock()?.status.connection.clone();
    Ok(result)
}

#[cfg(test)]
pub(crate) fn test_set_connection<R: tauri::Runtime>(
    app: &AppHandle<R>,
    connection: ConnectionInfo,
) {
    let manager = app.state::<CloudSyncManager>();
    if let Ok(mut control) = manager.lock() {
        control.loaded = true;
        control.status.connection = Some(connection);
    };
}

/// Capture the lifecycle generation before an upload invocation starts any
/// disk, credential or Android-bridge preparation. Admin operations and broad
/// cancel already advance this same generation.
pub(super) fn upload_start_epoch<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<u64> {
    let manager = app.state::<CloudSyncManager>();
    let epoch = manager.lock()?.epoch;
    Ok(epoch)
}

/// Re-check the real lifecycle at the existing lock boundary before and after
/// registering an upload job. A stale invocation must not create a fresh,
/// uncancelled token after the context has left the foreground or the
/// connection/administration generation changed.
pub(super) fn check_upload_start<R: tauri::Runtime>(
    app: &AppHandle<R>,
    connection_id: &str,
    epoch: u64,
) -> Result<()> {
    let manager = app.state::<CloudSyncManager>();
    let control = manager.lock()?;
    if control.admin_busy {
        return Err(Failure::new(FailureCode::Busy));
    }
    if control.epoch != epoch || !manager.activity.borrow().foreground {
        return Err(Failure::new(FailureCode::Cancelled));
    }
    match control.status.connection.as_ref() {
        Some(connection) if connection.connection_id == connection_id => Ok(()),
        _ => Err(Failure::new(FailureCode::ConnectionRequired)),
    }
}

#[cfg(test)]
pub(crate) fn test_apply_context<R: tauri::Runtime>(
    app: &AppHandle<R>,
    context: Activity,
) -> Result<()> {
    apply_context(app, context).map(|_| ())
}

#[cfg(test)]
pub(crate) fn test_set_admin_busy<R: tauri::Runtime>(app: &AppHandle<R>, busy: bool) {
    if let Ok(mut control) = app.state::<CloudSyncManager>().lock() {
        control.admin_busy = busy;
    }
}

fn install(control: &mut Control, session: Option<&Session>) {
    control.loaded = true;
    control.schedule = Schedule::default();
    control.status = Status::default();
    control.devices = Vec::new();
    if let Some(session) = session {
        control.status.connection = Some(session.info());
        control.status.phase = Phase::Idle;
        control.status.last_success_at_ms = session.last_success_at_ms;
        control.status.device_count = session.devices.len();
        control.status.cloud_only_book_count = session.cloud_only_book_count;
        control.devices = session.devices.clone();
    }
}

/// Android readies its Keystore bridge and certificate verifier on first use;
/// Linux probes the Secret Service without unlocking it. Until that succeeds
/// nothing may connect. Windows answers at once.
pub(super) async fn native_ready(app: &AppHandle) -> bool {
    native_ready_inner(app, false).await
}

/// Explicit test/connect/upload is allowed to bypass the Linux status probe
/// cooldown after the user starts or unlocks the keyring.
pub(super) async fn native_ready_force(app: &AppHandle) -> bool {
    native_ready_inner(app, true).await
}

async fn native_ready_inner(app: &AppHandle, force: bool) -> bool {
    #[cfg(target_os = "linux")]
    {
        if secrets::available() {
            return true;
        }
        let app = app.clone();
        return engine::blocking(move || {
            Ok(if force {
                secrets::prepare_force(&app)
            } else {
                secrets::prepare(&app)
            })
        })
        .await
        .unwrap_or(false);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = force;
        if !cfg!(target_os = "android") || secrets::available() {
            return secrets::available();
        }
        let app = app.clone();
        engine::blocking(move || Ok(secrets::prepare(&app)))
            .await
            .unwrap_or(false)
    }
}

pub(super) async fn load_once(app: &AppHandle) -> Result<()> {
    let manager = app.state::<CloudSyncManager>();
    if manager.lock()?.loaded {
        return Ok(());
    }
    let _gate = manager.gate.lock().await;
    if manager.lock()?.loaded {
        return Ok(());
    }
    let disk = disk(app)?;
    let session = engine::blocking(move || disk.load(&Cancel::default())).await;
    let mut control = manager.lock()?;
    match session {
        Ok(session) => install(&mut control, session.as_ref()),
        Err(error) => {
            control.loaded = true;
            control.status.phase = Phase::Error;
            control.status.last_error = Some(error);
            control.schedule.blocked = true;
        }
    }
    Ok(())
}

struct Administrative {
    app: AppHandle,
    gate: Option<OwnedMutexGuard<()>>,
    cancel: Cancel,
}

impl Drop for Administrative {
    fn drop(&mut self) {
        self.gate.take();
        if let Ok(mut control) = self.app.state::<CloudSyncManager>().lock() {
            control.admin_busy = false;
        }
        arm(&self.app);
        emit(&self.app);
    }
}

async fn administration(app: &AppHandle, cancel_round: bool) -> Result<Administrative> {
    let manager = app.state::<CloudSyncManager>();
    {
        let mut control = manager.lock()?;
        if control.admin_busy {
            return Err(Failure::new(FailureCode::Busy));
        }
        control.admin_busy = true;
        control.timer_cancel.cancel();
        if cancel_round {
            control.round_cancel.cancel();
            control.epoch = control.epoch.wrapping_add(1);
            control.schedule.cancel();
            if control.status.connection.is_some() {
                control.status.phase = Phase::Idle;
            }
        }
    }
    // The job slot may have been claimed after the caller's early
    // cancel_active and before admin_busy became visible. admin_busy now
    // rejects new registrations, so cancel any token that already exists.
    if cancel_round {
        super::books::cancel_active(app);
    }
    // Construct before waiting: a dropped invocation cannot strand admin_busy.
    let mut operation = Administrative {
        app: app.clone(),
        gate: None,
        cancel: Cancel::default(),
    };
    operation.gate = Some(manager.gate.clone().lock_owned().await);
    if !manager.activity.borrow().foreground {
        operation.cancel.cancel();
    }
    manager.lock()?.round_cancel = operation.cancel.clone();
    Ok(operation)
}

fn arm(app: &AppHandle) {
    let manager = app.state::<CloudSyncManager>();
    let armed = (|| {
        let mut control = manager.lock()?;
        control.timer_cancel.cancel();
        if control.admin_busy
            || control.schedule.running
            || control.status.connection.is_none()
            || control.schedule.blocked
            || !manager.activity.borrow().foreground
        {
            return Ok(None);
        }
        let Some(due) = control.schedule.due_at else {
            return Ok(None);
        };
        let cancel = Cancel::default();
        control.timer_cancel = cancel.clone();
        if control.schedule.retry_at.is_some() {
            control.status.phase = Phase::Waiting;
        } else {
            control.status.phase = Phase::Queued;
        }
        Ok(Some((due, control.epoch, cancel)))
    })();
    let Ok(Some((due, epoch, timer))): Result<Option<(u64, u64, Cancel)>> = armed else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            biased;
            _=timer.cancelled()=>return,
            _=tokio::time::sleep(Duration::from_millis(due.saturating_sub(now_ms())))=>{}
        }
        let manager = app.state::<CloudSyncManager>();
        let mut activity = manager.activity.subscribe();
        if engine::idle(&mut activity, &timer).await.is_err() {
            return;
        }
        let job = (|| {
            let mut control = manager.lock()?;
            if control.epoch != epoch
                || timer.check().is_err()
                || control.admin_busy
                || !control.schedule.start(now_ms())
            {
                return Ok(None);
            }
            let cancel = Cancel::default();
            control.round_cancel = cancel.clone();
            control.status.phase = Phase::Syncing;
            control.status.local_changed = false;
            Ok(Some(cancel))
        })();
        let Ok(Some(cancel)): Result<Option<Cancel>> = job else {
            return;
        };
        emit(&app);
        let _gate = manager.gate.lock().await;
        let result = perform(&app, activity, &cancel).await;
        let completed = {
            let Ok(mut control) = manager.lock() else {
                return;
            };
            finish_round(&mut control, epoch, &result)
        };
        if !completed {
            return;
        }
        drop(_gate);
        arm(&app);
        emit(&app);
    });
}

struct AppRepository(AppHandle);

impl Repository for AppRepository {
    async fn snapshot(&self) -> Result<LocalSnapshot> {
        let app = self.0.clone();
        engine::blocking(move || {
            crate::portable_state_commands::with_existing_store(&app, |store| {
                Ok(LocalSnapshot {
                    state: store.snapshot()?,
                    bound: store.locally_bound_hashes()?,
                    event_device_id: store.installation_id()?,
                })
            })?
            .ok_or_else(|| Failure::new(FailureCode::RepositoryNotReady))
        })
        .await
    }

    async fn apply(&self, full: crate::portable_state::PortableStateV3) -> Result<Applied> {
        let app = self.0.clone();
        let result = engine::blocking(move || {
            crate::portable_state_commands::with_existing_store(&app, |store| {
                let before = store.snapshot()?;
                let outcome =
                    store.merge_local_import_ref(&full, Vec::new(), &Default::default(), false)?;
                let changed = before != outcome.state;
                Ok(Applied {
                    snapshot: LocalSnapshot {
                        state: outcome.state,
                        bound: store.locally_bound_hashes()?,
                        event_device_id: store.installation_id()?,
                    },
                    changed,
                })
            })?
            .ok_or_else(|| Failure::new(FailureCode::RepositoryNotReady))
        })
        .await?;
        if result.changed {
            let _ = self.0.emit("cloud-sync-library-changed", ());
        }
        Ok(result)
    }
}

async fn perform(
    app: &AppHandle,
    activity: watch::Receiver<Activity>,
    cancel: &Cancel,
) -> Result<engine::Outcome> {
    let data = disk(app)?;
    let app_clone = app.clone();
    let load = data.clone();
    let (session, identity, password) = engine::blocking(move || {
        let session = load
            .load(&Cancel::default())?
            .ok_or_else(|| Failure::new(FailureCode::InvalidConfig))?;
        let password = secrets::load(&app_clone, &session.connection_id)?;
        Ok((session, load.identity()?, password))
    })
    .await?;
    cancel.check()?;
    let remote = WebDavRemote::new(
        &session.settings.base_url,
        &session.settings.remote_root,
        Credentials {
            username: session.settings.username.clone(),
            app_password: password,
        },
    )?;
    engine::run(
        &remote,
        &AppRepository(app.clone()),
        &data,
        session,
        identity,
        activity,
        cancel,
    )
    .await
}

#[tauri::command]
pub async fn cloud_sync_get_status(app: AppHandle) -> Result<Status> {
    load_once(&app).await?;
    native_ready(&app).await;
    let manager = app.state::<CloudSyncManager>();
    let result = status(&*manager.lock()?);
    Ok(result)
}

#[tauri::command]
pub async fn cloud_sync_test_connection(
    app: AppHandle,
    input: ConnectionInput,
) -> Result<ConnectionPreview> {
    if !native_ready_force(&app).await {
        return Err(Failure::new(FailureCode::NativeBridgeUnavailable));
    }
    load_once(&app).await?;
    let admin = administration(&app, false).await?;
    app.state::<CloudSyncManager>().lock()?.ticket = None;
    let settings = Settings {
        base_url: input.base_url.trim().into(),
        remote_root: input.remote_root.trim().into(),
        username: input.username.trim().into(),
    };
    if settings.base_url.len() > 4096
        || settings.remote_root.len() > 2048
        || settings.username.len() > 512
        || input.app_password.len() > 2560
    {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let remote = WebDavRemote::new(
        &settings.base_url,
        &settings.remote_root,
        Credentials {
            username: settings.username.clone(),
            app_password: input.app_password.clone(),
        },
    )?;
    let cancel = admin.cancel.clone();
    let capabilities = probe(&remote, &cancel).await?;
    if !capabilities.move_file || !capabilities.move_no_replace {
        return Err(RemoteError::new(RemoteErrorCode::Unsupported).into());
    }
    let (space, cloud_book_count, devices, issues) = engine::preview(&remote, &cancel).await?;
    let preview = ConnectionPreview {
        probe_id: uuid()?,
        existing_space_id: space.map(|s| s.space_id),
        cloud_book_count,
        devices,
        issues,
        capabilities,
    };
    app.state::<CloudSyncManager>().lock()?.ticket = Some(Ticket {
        preview: preview.clone(),
        created: Instant::now(),
        settings,
        password: input.app_password,
    });
    let expiry_app = app.clone();
    let probe_id = preview.probe_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        if let Ok(mut control) = expiry_app.state::<CloudSyncManager>().lock() {
            if control
                .ticket
                .as_ref()
                .is_some_and(|t| t.preview.probe_id == probe_id)
            {
                control.ticket = None;
            }
        }
    });
    Ok(preview)
}

#[tauri::command]
pub async fn cloud_sync_connect(
    app: AppHandle,
    probe_id: String,
    merge_existing: bool,
    device_label: String,
) -> Result<Status> {
    super::books::cancel_active(&app);
    if !native_ready_force(&app).await {
        return Err(Failure::new(FailureCode::NativeBridgeUnavailable));
    }
    load_once(&app).await?;
    let admin = administration(&app, true).await?;
    let ticket = {
        let manager = app.state::<CloudSyncManager>();
        let mut control = manager.lock()?;
        let ticket = control
            .ticket
            .as_ref()
            .filter(|t| {
                t.preview.probe_id == probe_id && t.created.elapsed() < Duration::from_secs(600)
            })
            .ok_or_else(|| Failure::new(FailureCode::ProbeExpired))?;
        if ticket.preview.existing_space_id.is_some() && !merge_existing {
            return Err(Failure::new(FailureCode::ConfirmationRequired));
        }
        control.ticket.take().unwrap()
    };
    let label = device_label.trim().to_string();
    if label.is_empty() || label.chars().count() > 128 {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let cancel = admin.cancel.clone();
    let remote = WebDavRemote::new(
        &ticket.settings.base_url,
        &ticket.settings.remote_root,
        Credentials {
            username: ticket.settings.username.clone(),
            app_password: ticket.password.clone(),
        },
    )?;
    let existing = engine::read_space(&remote, &cancel).await?;
    match (
        existing.as_ref().map(|s| s.space_id.as_str()),
        ticket.preview.existing_space_id.as_deref(),
    ) {
        (Some(actual), Some(expected)) if actual == expected => {}
        (None, None) => {}
        (Some(_), None) => return Err(Failure::new(FailureCode::ConfirmationRequired)),
        _ => return Err(Failure::new(FailureCode::SpaceChanged)),
    }
    let candidate = match existing {
        Some(space) => space,
        None => Space {
            format: SPACE_FORMAT.into(),
            format_version: FORMAT_VERSION,
            space_id: uuid()?,
            created_at_ms: now_ms(),
        },
    };
    let space = ensure_space(
        &remote,
        &candidate,
        true,
        ticket.preview.capabilities,
        &cancel,
    )
    .await?;
    if space.space_id != candidate.space_id {
        return Err(Failure::new(FailureCode::ConfirmationRequired));
    }
    remote
        .create_collection(&RemotePath::new("devices")?, &cancel)
        .await?;
    let mut session = Session {
        schema_version: 1,
        connection_id: uuid()?,
        settings: ticket.settings,
        space,
        capabilities: ticket.preview.capabilities,
        device_label: label,
        remote_view: None,
        last_success_at_ms: None,
        devices: Vec::new(),
        cloud_only_book_count: 0,
        seen: Default::default(),
        pending_upload: false,
    };
    let store = disk(&app)?;
    let saved_app = app.clone();
    let password = ticket.password;
    cancel.check()?;
    let (session, old_credential_id) = engine::blocking(move || {
        let old = store.load(&Cancel::default())?;
        if let Some(old) = &old {
            if old.settings == session.settings && old.space.space_id == session.space.space_id {
                session.remote_view = old.remote_view.clone();
                session.devices = old.devices.clone();
                session.last_success_at_ms = old.last_success_at_ms;
                session.cloud_only_book_count = old.cloud_only_book_count;
                session.seen = old.seen.clone();
            }
        }
        store.identity()?;
        secrets::save(&saved_app, &session.connection_id, &password)?;
        if let Err(error) = store.save(&session, &Cancel::default()) {
            let _ = secrets::delete(&saved_app, &session.connection_id);
            return Err(error);
        }
        Ok((session, old.map(|s| s.connection_id)))
    })
    .await?;
    {
        let manager = app.state::<CloudSyncManager>();
        let mut control = manager.lock()?;
        install(&mut control, Some(&session));
    }
    if let Some(id) = old_credential_id {
        let saved_app = app.clone();
        if engine::blocking(move || secrets::delete(&saved_app, &id))
            .await
            .is_err()
        {
            let error = Failure::new(FailureCode::CredentialCleanupFailed);
            app.state::<CloudSyncManager>().lock()?.status.last_error = Some(error.clone());
            return Err(error);
        }
    }
    drop(admin);
    cloud_sync_trigger(app, Trigger::Manual).await
}

#[tauri::command]
pub async fn cloud_sync_trigger(app: AppHandle, reason: Trigger) -> Result<Status> {
    load_once(&app).await?;
    {
        let manager = app.state::<CloudSyncManager>();
        let mut control = manager.lock()?;
        if control.status.connection.is_none() {
            return Ok(status(&control));
        }
        control.schedule.request(reason, now_ms());
    }
    arm(&app);
    emit(&app);
    cloud_sync_get_status(app).await
}

fn apply_context<R: tauri::Runtime>(app: &AppHandle<R>, context: Activity) -> Result<Activity> {
    let manager = app.state::<CloudSyncManager>();
    let previous = manager.activity.send_replace(context);
    if !context.foreground {
        super::books::cancel_active(app);
        let mut control = manager.lock()?;
        if previous.foreground {
            // Backgrounding starts a new lifecycle generation. This also
            // invalidates an upload invocation that captured the old
            // generation while it was still preparing.
            control.epoch = control.epoch.wrapping_add(1);
        }
        if control.schedule.running {
            // The already-running metadata round will be rejected by its
            // generation check when it finishes, so settle the shared
            // Schedule here. Otherwise `running` would stay true and the
            // foreground/manual request could never start another round.
            // A new round cannot exist yet: backgrounding happens first.
            control.schedule.cancel();
        }
        if control.status.phase == Phase::Syncing {
            control.status.phase = Phase::Idle;
        }
        control.timer_cancel.cancel();
        control.round_cancel.cancel();
    }
    Ok(previous)
}

#[tauri::command]
pub async fn cloud_sync_set_context(app: AppHandle, context: Activity) -> Result<Status> {
    load_once(&app).await?;
    let previous = apply_context(&app, context)?;
    if context.foreground && !previous.foreground {
        let manager = app.state::<CloudSyncManager>();
        if manager.lock()?.status.connection.is_some() {
            manager
                .lock()?
                .schedule
                .request(Trigger::Foreground, now_ms());
        }
    }
    arm(&app);
    emit(&app);
    cloud_sync_get_status(app).await
}

#[tauri::command]
pub async fn cloud_sync_cancel(app: AppHandle) -> Result<Status> {
    super::books::cancel_active(&app);
    load_once(&app).await?;
    {
        let manager = app.state::<CloudSyncManager>();
        let mut control = manager.lock()?;
        control.epoch = control.epoch.wrapping_add(1);
        control.round_cancel.cancel();
        control.timer_cancel.cancel();
        control.schedule.cancel();
        if control.status.connection.is_some() {
            control.status.phase = Phase::Idle;
        }
        // Cancel while the generation lock is held. An upload invocation that
        // registered after the early cancel but before this epoch bump is
        // caught here; a genuinely new invocation cannot register until the
        // lock is released and will capture the new generation.
        super::books::cancel_active(&app);
    }
    emit(&app);
    cloud_sync_get_status(app).await
}

#[tauri::command]
pub async fn cloud_sync_disconnect(app: AppHandle) -> Result<Status> {
    super::books::cancel_active(&app);
    load_once(&app).await?;
    let _admin = administration(&app, true).await?;
    let store = disk(&app)?;
    let saved_app = app.clone();
    let recovered = engine::blocking(move || {
        match store.load(&Cancel::default()) {
            Ok(Some(session)) => secrets::delete(&saved_app, &session.connection_id)?,
            Ok(None) => {}
            Err(error) if error.code == FailureCode::LocalStateInvalid => {
                store.quarantine()?;
                store.clear_sources()?;
                // Unconfirmed pending paths stay owned by their server/space
                // scope. Disconnecting without network must not lose that
                // cleanup debt; a later upload to the same origin can retry.
                return Ok(true);
            }
            Err(error) => return Err(error),
        }
        store.disconnect()?;
        Ok(false)
    })
    .await?;
    let manager = app.state::<CloudSyncManager>();
    let mut control = manager.lock()?;
    control.ticket = None;
    install(&mut control, None);
    control.status.local_recovery_saved = recovered;
    Ok(status(&control))
}

#[tauri::command]
pub async fn cloud_sync_reset_identity(app: AppHandle) -> Result<Status> {
    super::books::cancel_active(&app);
    load_once(&app).await?;
    let admin = administration(&app, true).await?;
    let store = disk(&app)?;
    engine::blocking(move || {
        store.identity()?;
        store.save_identity(&Identity::fresh()?)
    })
    .await?;
    app.state::<CloudSyncManager>().lock()?.schedule = Schedule::default();
    drop(admin);
    cloud_sync_trigger(app, Trigger::Manual).await
}

#[tauri::command]
pub async fn cloud_sync_devices(app: AppHandle) -> Result<Vec<DeviceInfo>> {
    load_once(&app).await?;
    let manager = app.state::<CloudSyncManager>();
    let result = manager.lock()?.devices.clone();
    Ok(result)
}

/// Display-only lookup. Does not contact WebDAV, merge progress, or create a
/// library. The portable event identity is distinct from the cloud identity.
#[tauri::command]
pub async fn cloud_sync_progress_sources(
    app: AppHandle,
    event_device_ids: Vec<String>,
) -> Result<Vec<super::sources::ProgressSource>> {
    load_once(&app).await?;
    let connection = app
        .state::<CloudSyncManager>()
        .lock()?
        .status
        .connection
        .clone();
    let store = disk(&app)?;
    engine::blocking(move || {
        let local =
            crate::portable_state_commands::with_existing_store(&app, |db| db.installation_id())?
                .ok_or_else(|| Failure::new(FailureCode::RepositoryNotReady))?;
        super::sources::query(
            &store,
            connection.as_ref(),
            local.as_deref(),
            event_device_ids,
        )
    })
    .await
}

#[tauri::command]
pub async fn cloud_sync_cloud_books(app: AppHandle) -> Result<Vec<CloudBook>> {
    load_once(&app).await?;
    let store = disk(&app)?;
    let session = engine::blocking(move || store.load(&Cancel::default())).await?;
    let Some(full) = session.and_then(|s| s.remote_view) else {
        return Ok(Vec::new());
    };
    let local = AppRepository(app).snapshot().await?;
    Ok(full
        .books
        .into_iter()
        .filter(|(hash, _)| !local.bound.contains(hash))
        .map(|(hash, book)| CloudBook {
            content_hash: hash,
            title: book.metadata.value.title,
            creator: book.metadata.value.creator,
        })
        .collect())
}

pub fn shutdown(app: &AppHandle) {
    let manager = app.state::<CloudSyncManager>();
    manager.activity.send_replace(Activity {
        foreground: false,
        interaction_busy: false,
    });
    // Mark background first, then cancel: a job registering in between is
    // either rejected by the startup gate or caught by this cancellation.
    super::books::cancel_active(app);
    if let Ok(mut control) = manager.lock() {
        control.timer_cancel.cancel();
        control.round_cancel.cancel();
        control.ticket = None;
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> ConnectionInfo {
        ConnectionInfo {
            connection_id: "00000000-0000-4000-8000-000000000301".into(),
            settings: Settings {
                base_url: "https://nas.invalid/dav/".into(),
                remote_root: "test dir".into(),
                username: "test".into(),
            },
            space_id: "00000000-0000-4000-8000-000000000302".into(),
            device_label: "Test".into(),
        }
    }

    #[test]
    fn background_settles_old_round_and_late_completion_cannot_override_new_generation() {
        let app = tauri::test::mock_builder()
            .manage(CloudSyncManager::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        test_set_connection(&handle, connection());
        let manager = handle.state::<CloudSyncManager>();
        let old_epoch;
        {
            let mut control = manager.lock().unwrap();
            control.epoch = 41;
            old_epoch = control.epoch;
            control.schedule.running = true;
            control.status.phase = Phase::Syncing;
            control.status.last_success_at_ms = Some(11);
        }

        apply_context(
            &handle,
            Activity {
                foreground: false,
                interaction_busy: false,
            },
        )
        .unwrap();
        {
            let control = manager.lock().unwrap();
            assert_eq!(control.epoch, old_epoch + 1);
            assert!(!control.schedule.running);
            assert_eq!(control.status.phase, Phase::Idle);
        }

        // A new generation may already have updated the visible state. The
        // late old completion must not touch it or finish the new schedule.
        {
            let mut control = manager.lock().unwrap();
            control.status.phase = Phase::Queued;
            control.status.last_success_at_ms = Some(22);
            control.status.local_changed = true;
            control.schedule.running = true;
        }
        let stale: std::result::Result<engine::Outcome, Failure> =
            Err(Failure::new(FailureCode::Cancelled));
        {
            let mut control = manager.lock().unwrap();
            assert!(!finish_round(&mut control, old_epoch, &stale));
            assert_eq!(control.status.phase, Phase::Queued);
            assert_eq!(control.status.last_success_at_ms, Some(22));
            assert!(control.status.local_changed);
            assert!(control.schedule.running);
            control.schedule.cancel();
        }

        let previous = apply_context(
            &handle,
            Activity {
                foreground: true,
                interaction_busy: false,
            },
        )
        .unwrap();
        assert!(!previous.foreground);
        {
            let mut control = manager.lock().unwrap();
            let now = now_ms();
            control.schedule.request(Trigger::Foreground, now);
            assert!(control.schedule.start(now));
            control.schedule.cancel();
            control.schedule.request(Trigger::Manual, now);
            assert!(control.schedule.start(now));
        }
    }
}
