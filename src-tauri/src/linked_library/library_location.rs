//! Managed-book relocation. Settings are the single durable commit point;
//! copies/journal can be recovered without rewriting bindings or the database.
use super::*;
use std::time::{Duration, Instant};

type Error = LinkedLibraryError;
type Result<T> = std::result::Result<T, Error>;
const JOURNAL: &str = "library-move.json";
const OWNER: &str = ".reader-library-move";
const MARGIN: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub struct LibraryLocationState(Arc<Mutex<Slot>>);
#[derive(Default)]
struct Slot {
    job: Option<(String, Arc<ImportGate>)>,
    readers: usize,
}

pub(super) struct SourceLease(Arc<Mutex<Slot>>);
impl Drop for SourceLease {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            slot.readers -= 1;
        }
    }
}
pub(super) fn source_lease(app: &AppHandle) -> Result<Option<SourceLease>> {
    let Some(state) = app.try_state::<LibraryLocationState>() else {
        return Ok(None);
    };
    let mut slot = state.0.lock().map_err(|_| io_error("书库位置锁已损坏"))?;
    if slot.job.is_some() {
        return Err(busy());
    }
    slot.readers += 1;
    Ok(Some(SourceLease(Arc::clone(&state.0))))
}
struct JobLease {
    slot: Arc<Mutex<Slot>>,
    id: String,
}
impl Drop for JobLease {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            if slot.job.as_ref().is_some_and(|(id, _)| id == &self.id) {
                slot.job = None;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocationMode {
    Move,
    Reconnect,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationPlan {
    source_directory: String,
    target_directory: String,
    book_count: usize,
    total_bytes: u64,
    available_bytes: u64,
    recovery_pending: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationProgress {
    job_id: String,
    phase: &'static str,
    completed_bytes: u64,
    total_bytes: u64,
    completed_books: usize,
    total_books: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationResult {
    job_id: String,
    status: &'static str,
    library_directory: String,
    book_count: usize,
    cleanup_pending_count: usize,
}
#[derive(Debug, Serialize)]
pub struct LocationCancel {
    status: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookFile {
    name: String,
    hash: String,
    size: u64,
    mtime_ns: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    job_id: String,
    source_base: Option<String>,
    target_base: Option<String>,
    files: Vec<BookFile>,
}
impl Journal {
    fn paths(&self, root: &Path) -> Result<(PathBuf, PathBuf, PathBuf)> {
        if self.version != 1
            || !crate::portable_state::valid_canonical_uuid(&self.job_id)
            || self
                .files
                .iter()
                .any(|f| !valid_content_hash(&f.hash) || !valid_library_file_name(&f.name))
            || [self.source_base.as_deref(), self.target_base.as_deref()]
                .into_iter()
                .flatten()
                .any(|p| !Path::new(p).is_absolute())
        {
            return Err(io_error("书库迁移日志无效，未删除任何文件"));
        }
        let settings = |base| {
            let mut value = LibrarySettings::default();
            value.custom_base_directory = base;
            value
        };
        let source = books_for_settings(root, &settings(self.source_base.clone()))?;
        let target = books_for_settings(root, &settings(self.target_base.clone()))?;
        if paths_overlap(&resolved(&source)?, &resolved(&target)?) {
            return Err(io_error("迁移日志的源和目标重叠，未删除任何文件"));
        }
        let stage = target.with_file_name(format!(
            "{}.moving-{}",
            target.file_name().unwrap().to_string_lossy(),
            self.job_id
        ));
        Ok((source, target, stage))
    }
}

fn busy() -> Error {
    Error::new("busy", "请关闭阅读器并等待导入、互传和导出完成")
}
fn io_error(message: impl Into<String>) -> Error {
    Error::new("library-location-io-error", message)
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new("invalid-request", message)
}
fn cancelled() -> Error {
    Error::new("cancelled", "书库搬迁已取消，原位置保持不变")
}
fn local(root: &Path) -> Result<&Path> {
    root.parent().ok_or_else(|| io_error("书库根目录无效"))
}
fn journal_path(root: &Path) -> Result<PathBuf> {
    Ok(local(root)?.join(JOURNAL))
}
pub(super) fn recovery_pending(root: &Path) -> bool {
    journal_path(root).is_ok_and(|p| p.exists())
}

fn resolved(path: &Path) -> Result<PathBuf> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .ok_or_else(|| invalid("目标目录必须是绝对路径"))?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .ok_or_else(|| invalid("目标目录必须是绝对路径"))?;
    }
    let mut output = fs::canonicalize(ancestor).map_err(|e| io_error(e.to_string()))?;
    for part in suffix.into_iter().rev() {
        output.push(part);
    }
    Ok(output)
}
fn paths_overlap(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    let (a, b) = (
        PathBuf::from(a.to_string_lossy().to_lowercase()),
        PathBuf::from(b.to_string_lossy().to_lowercase()),
    );
    a.starts_with(&b) || b.starts_with(&a)
}
fn book_files(bindings: &[DeviceBinding]) -> Result<Vec<BookFile>> {
    let mut names = HashSet::new();
    bindings
        .iter()
        .filter(|b| b.storage_kind == StorageKind::Managed)
        .map(|b| {
            let name = b
                .managed_file_name
                .clone()
                .unwrap_or_else(|| format!("{}.epub", b.content_hash));
            if !valid_library_file_name(&name)
                || !valid_content_hash(&b.content_hash)
                || !names.insert(name.to_lowercase())
            {
                return Err(io_error("托管绑定包含无效或重复文件名，未开始迁移"));
            }
            Ok(BookFile {
                name,
                hash: b.content_hash.clone(),
                size: b.file_size,
                mtime_ns: b.source_mtime_ns,
            })
        })
        .collect()
}
fn selected_settings(root: &Path, base: Option<String>) -> Result<LibrarySettings> {
    let mut settings = load_library_settings(local(root)?)?;
    settings.custom_base_directory = base
        .map(|raw| {
            let path = Path::new(&raw);
            if !path.is_absolute() {
                return Err(invalid("目标目录必须是绝对路径"));
            }
            let path =
                fs::canonicalize(path).map_err(|e| io_error(format!("目标目录不可用：{e}")))?;
            if !path.is_dir() {
                return Err(invalid("目标必须是目录"));
            }
            Ok(path.to_string_lossy().into_owned())
        })
        .transpose()?;
    Ok(settings)
}
fn plan_at(
    root: &Path,
    bindings: &[DeviceBinding],
    base: Option<String>,
    mode: LocationMode,
) -> Result<(LocationPlan, LibrarySettings, Vec<BookFile>)> {
    let settings = selected_settings(root, base)?;
    let source = managed_books_directory(root)?;
    let target = books_for_settings(root, &settings)?;
    if paths_overlap(&resolved(&source)?, &resolved(&target)?) {
        return Err(Error::new(
            "library-target-overlap",
            "新书库和当前书库不能相同或相互嵌套",
        ));
    }
    let files = book_files(bindings)?;
    let total = files
        .iter()
        .try_fold(0u64, |n, f| n.checked_add(f.size))
        .ok_or_else(|| invalid("书库总大小溢出"))?;
    match mode {
        LocationMode::Move => {
            if !files.is_empty() && !source.is_dir() {
                return Err(Error::new(
                    "library-folder-unavailable",
                    "当前书库不可用，请重新连接",
                ));
            }
            if target.exists()
                && (!target.is_dir()
                    || fs::read_dir(&target)
                        .map_err(|e| io_error(e.to_string()))?
                        .next()
                        .is_some())
            {
                return Err(Error::new(
                    "library-target-not-empty",
                    "目标书库不为空，请选择重新连接或另一个目录",
                ));
            }
        }
        LocationMode::Reconnect if !target.is_dir() => {
            return Err(Error::new(
                "library-folder-unavailable",
                "所选位置没有现有书库",
            ))
        }
        _ => {}
    }
    let available =
        crate::save_file::available_space_for(&target).map_err(|e| io_error(e.message))?;
    if mode == LocationMode::Move && total.saturating_add(MARGIN) > available {
        return Err(Error::new(
            "library-insufficient-space",
            "目标盘空间不足，未开始复制",
        ));
    }
    Ok((
        LocationPlan {
            source_directory: source.to_string_lossy().into_owned(),
            target_directory: target.to_string_lossy().into_owned(),
            book_count: files.len(),
            total_bytes: total,
            available_bytes: available,
            recovery_pending: recovery_pending(root),
        },
        settings,
        files,
    ))
}

fn hash_checked(path: &Path, file: &BookFile, gate: &ImportGate) -> Result<()> {
    let before = snapshot(path)?;
    if before.size != file.size {
        return Err(Error::new(
            "library-verification-failed",
            format!("副本大小不一致：{}", file.name),
        ));
    }
    let mut source = File::open(path)
        .map_err(|e| io_error(e.to_string()))?
        .take(file.size.saturating_add(1));
    let mut buffer = [0u8; 64 * 1024];
    let mut digest = Sha256::new();
    loop {
        if gate.is_cancelled() {
            return Err(cancelled());
        }
        let count = source
            .read(&mut buffer)
            .map_err(|e| io_error(e.to_string()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != file.hash || snapshot(path)? != before {
        return Err(Error::new(
            "library-verification-failed",
            format!("副本内容校验失败：{}", file.name),
        ));
    }
    Ok(())
}
fn preserve_binding_time(path: &Path, file: &BookFile) -> Result<()> {
    let time = UNIX_EPOCH + Duration::from_nanos(file.mtime_ns);
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|f| {
            f.set_times(fs::FileTimes::new().set_modified(time))?;
            f.sync_all()
        })
        .map_err(|e| io_error(format!("无法保留副本修改时间：{e}")))?;
    if snapshot(path)?.mtime_ns != file.mtime_ns {
        return Err(io_error(
            "目标文件系统无法保留当前书库所需的时间精度，未切换位置",
        ));
    }
    Ok(())
}
struct Progress<'a> {
    value: LocationProgress,
    last: Instant,
    sink: &'a mut dyn FnMut(LocationProgress),
}
impl Progress<'_> {
    fn emit(&mut self, phase: &'static str, force: bool) {
        if force || self.last.elapsed() >= Duration::from_millis(100) {
            self.value.phase = phase;
            (self.sink)(self.value.clone());
            self.last = Instant::now();
        }
    }
}
fn copy_one(
    source: &Path,
    target: &Path,
    file: &BookFile,
    gate: &ImportGate,
    progress: &mut Progress<'_>,
) -> Result<()> {
    let before = snapshot(source)?;
    if before.size != file.size {
        return Err(Error::new(
            "library-verification-failed",
            "源书大小已变化，未开始复制",
        ));
    }
    let mut input = File::open(source)
        .map_err(|e| io_error(e.to_string()))?
        .take(file.size.saturating_add(1));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| io_error(e.to_string()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if gate.is_cancelled() {
            return Err(cancelled());
        }
        let n = input
            .read(&mut buffer)
            .map_err(|e| io_error(e.to_string()))?;
        if n == 0 {
            break;
        }
        output
            .write_all(&buffer[..n])
            .map_err(|e| io_error(e.to_string()))?;
        progress.value.completed_bytes = progress.value.completed_bytes.saturating_add(n as u64);
        progress.emit("copying", false);
    }
    output.sync_all().map_err(|e| io_error(e.to_string()))?;
    if snapshot(source)? != before {
        return Err(Error::new(
            "library-verification-failed",
            "源书在复制中发生变化，未切换位置",
        ));
    }
    progress.emit("verifying", true);
    hash_checked(target, file, gate)?;
    preserve_binding_time(target, file)
}

fn owned(directory: &Path, journal: &Journal) -> bool {
    fs::read_to_string(directory.join(OWNER)).is_ok_and(|id| id == journal.job_id)
}
fn clean_prepared(directory: &Path, journal: &Journal, partial: bool) -> usize {
    match directory.try_exists() {
        Ok(false) => return 0,
        Err(_) => return 1,
        Ok(true) => {}
    }
    if !owned(directory, journal) {
        return usize::from(fs::remove_dir(directory).is_err());
    }
    let mut pending = 0;
    for file in &journal.files {
        let path = directory.join(&file.name);
        if !path.exists() {
            continue;
        }
        // Only the private staging directory may contain partial bytes. Once
        // published, preserve any file somebody has since modified.
        if (!partial && hash_checked(&path, file, &ImportGate::default()).is_err())
            || fs::remove_file(&path).is_err()
        {
            pending += 1;
        }
    }
    let unknown = fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(std::result::Result::ok)
                .any(|e| e.file_name() != OWNER)
        })
        .unwrap_or(true);
    if pending == 0 && !unknown {
        if fs::remove_file(directory.join(OWNER)).is_err() || fs::remove_dir(directory).is_err() {
            pending += 1;
        }
    } else if unknown && pending == 0 {
        pending = 1;
    }
    pending
}
fn clean_old(source: &Path, target: &Path, journal: &Journal) -> usize {
    let mut pending = 0;
    for file in &journal.files {
        let old = source.join(&file.name);
        match old.try_exists() {
            Ok(false) => continue,
            Err(_) => {
                pending += 1;
                continue;
            }
            Ok(true) => {}
        }
        let gate = ImportGate::default();
        // Verify the *new* copy before deleting the old one, including recovery
        // after a crash. A changed or inaccessible old file is also preserved.
        if hash_checked(&target.join(&file.name), file, &gate).is_err()
            || hash_checked(&old, file, &gate).is_err()
            || fs::remove_file(&old).is_err()
        {
            pending += 1;
        }
    }
    if owned(target, journal) {
        let _ = fs::remove_file(target.join(OWNER));
    }
    pending
}
fn remove_journal(root: &Path) -> Result<()> {
    fs::remove_file(journal_path(root)?).map_err(|e| io_error(format!("无法清理迁移日志：{e}")))
}

// Directory publication must be no-replace too. A normal POSIX rename can
// replace a directory another process created after our preflight.
#[cfg(windows)]
fn publish_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let a: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(target_os = "linux")]
fn publish_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn renameat2(
            olddir: i32,
            old: *const std::ffi::c_char,
            newdir: i32,
            new: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let a = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let b = std::ffi::CString::new(target.as_os_str().as_bytes())?;
    if unsafe { renameat2(-100, a.as_ptr(), -100, b.as_ptr(), 1) } != 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(any(windows, target_os = "linux")))]
fn publish_directory(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "此平台尚不支持书库搬迁",
    ))
}

fn run_at(
    root: &Path,
    bindings: &[DeviceBinding],
    id: &str,
    base: Option<String>,
    mode: LocationMode,
    gate: &ImportGate,
    sink: &mut dyn FnMut(LocationProgress),
) -> Result<LocationResult> {
    if recovery_pending(root) {
        return Err(Error::new(
            "library-recovery-required",
            "先处理上次搬迁的残留，再更换位置",
        ));
    }
    let (plan, settings, files) = plan_at(root, bindings, base, mode)?;
    let source = PathBuf::from(&plan.source_directory);
    let target = PathBuf::from(&plan.target_directory);
    let mut progress = Progress {
        value: LocationProgress {
            job_id: id.into(),
            phase: "copying",
            completed_bytes: 0,
            total_bytes: plan.total_bytes,
            completed_books: 0,
            total_books: files.len(),
        },
        last: Instant::now(),
        sink,
    };
    if mode == LocationMode::Reconnect {
        for file in &files {
            progress.emit("verifying", true);
            hash_checked(&target.join(&file.name), file, gate)?;
            preserve_binding_time(&target.join(&file.name), file)?;
            progress.value.completed_books += 1;
            progress.value.completed_bytes += file.size;
        }
        let _permit = gate.begin_commit().ok_or_else(cancelled)?;
        progress.emit("committing", true);
        save_library_settings(local(root)?, &settings)?;
        return Ok(LocationResult {
            job_id: id.into(),
            status: "completed",
            library_directory: plan.target_directory,
            book_count: files.len(),
            cleanup_pending_count: 0,
        });
    }
    let journal = Journal {
        version: 1,
        job_id: id.into(),
        source_base: load_library_settings(local(root)?)?.custom_base_directory,
        target_base: settings.custom_base_directory.clone(),
        files,
    };
    let (_, _, stage) = journal.paths(root)?;
    atomic_write_bytes(
        &journal_path(root)?,
        &serde_json::to_vec(&journal).map_err(|e| io_error(e.to_string()))?,
    )?;
    let prepare = (|| {
        fs::create_dir_all(stage.parent().unwrap()).map_err(|e| io_error(e.to_string()))?;
        fs::create_dir(&stage).map_err(|e| io_error(e.to_string()))?;
        let mut owner = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.join(OWNER))
            .map_err(|e| io_error(e.to_string()))?;
        owner
            .write_all(id.as_bytes())
            .and_then(|_| owner.sync_all())
            .map_err(|e| io_error(e.to_string()))?;
        for file in &journal.files {
            progress.emit("copying", true);
            copy_one(
                &source.join(&file.name),
                &stage.join(&file.name),
                file,
                gate,
                &mut progress,
            )?;
            progress.value.completed_books += 1;
        }
        Ok(())
    })();
    if let Err(error) = prepare {
        if clean_prepared(&stage, &journal, true) == 0 {
            remove_journal(root)?;
        }
        return Err(error);
    }
    let Some(_permit) = gate.begin_commit() else {
        if clean_prepared(&stage, &journal, true) == 0 {
            remove_journal(root)?;
        }
        return Err(cancelled());
    };
    progress.emit("committing", true);
    if target.exists() {
        fs::remove_dir(&target).map_err(|e| io_error(format!("目标不再为空：{e}")))?;
    }
    publish_directory(&stage, &target)
        .map_err(|e| io_error(format!("无法发布新书库，旧位置保留：{e}")))?;
    save_library_settings(local(root)?, &settings)?;
    progress.emit("cleaning", true);
    let pending = clean_old(&source, &target, &journal);
    if pending == 0 {
        remove_journal(root)?;
    }
    Ok(LocationResult {
        job_id: id.into(),
        status: if pending == 0 {
            "completed"
        } else {
            "cleanup-pending"
        },
        library_directory: plan.target_directory,
        book_count: journal.files.len(),
        cleanup_pending_count: pending,
    })
}

fn recover_at(root: &Path) -> Result<LocationResult> {
    let path = journal_path(root)?;
    let bytes = fs::read(&path).map_err(|e| io_error(format!("无法读取迁移日志：{e}")))?;
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|e| io_error(format!("迁移日志损坏，未删除文件：{e}")))?;
    let (source, target, stage) = journal.paths(root)?;
    let current = load_library_settings(local(root)?)?;
    // A disconnected drive is not proof that its temporary/old files are
    // gone. Retain the journal until both participating locations return.
    if [
        journal.source_base.as_deref(),
        journal.target_base.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|base| !Path::new(base).is_dir())
    {
        return Ok(LocationResult {
            job_id: journal.job_id,
            status: "cleanup-pending",
            library_directory: managed_books_directory(root)?
                .to_string_lossy()
                .into_owned(),
            book_count: journal.files.len(),
            cleanup_pending_count: 1,
        });
    }
    let pending = if current.custom_base_directory == journal.target_base {
        clean_old(&source, &target, &journal)
    } else if current.custom_base_directory == journal.source_base {
        clean_prepared(&stage, &journal, true) + clean_prepared(&target, &journal, false)
    } else {
        return Err(Error::new(
            "library-recovery-required",
            "当前设置与迁移日志不一致，未删除任何文件",
        ));
    };
    if pending == 0 {
        remove_journal(root)?;
    }
    Ok(LocationResult {
        job_id: journal.job_id,
        status: if pending == 0 {
            "completed"
        } else {
            "cleanup-pending"
        },
        library_directory: managed_books_directory(root)?
            .to_string_lossy()
            .into_owned(),
        book_count: journal.files.len(),
        cleanup_pending_count: pending,
    })
}

struct Reservation {
    app: AppHandle,
    task: Arc<crate::save_file::commands::FileTask>,
    _activity: Option<ImportActivityGuard>,
    _job: JobLease,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        crate::save_file::commands::finish_task(&self.app, &self.task);
    }
}
fn reserve(app: &AppHandle, id: &str, gate: Arc<ImportGate>) -> Result<Reservation> {
    let writes = app.state::<LinkedLibraryWriteState>();
    let _guard = writes.0.try_lock().map_err(|_| busy())?;
    ensure_import_idle(app).map_err(|_| busy())?;
    let state = app.state::<LibraryLocationState>();
    let mut slot = state.0.lock().map_err(|_| io_error("书库位置锁已损坏"))?;
    if slot.job.is_some() || slot.readers != 0 {
        return Err(busy());
    }
    if !app
        .state::<NativeArchiveState>()
        .0
        .lock()
        .map_err(|_| busy())?
        .is_empty()
    {
        return Err(busy());
    }
    let task = crate::save_file::commands::reserve_job(app, id)
        .map_err(|e| Error::new(&e.code, e.message))?;
    let activity = match acquire_import_activity(app, format!("library-location:{id}")) {
        Ok(activity) => activity,
        Err(_) => {
            crate::save_file::commands::finish_task(app, &task);
            return Err(busy());
        }
    };
    slot.job = Some((id.into(), gate));
    Ok(Reservation {
        app: app.clone(),
        task,
        _activity: activity,
        _job: JobLease {
            slot: Arc::clone(&state.0),
            id: id.into(),
        },
    })
}
fn supported() -> Result<()> {
    #[cfg(target_os = "android")]
    return Err(Error::new(
        "unsupported-platform",
        "Android 暂不提供更换书库位置",
    ));
    #[cfg(not(target_os = "android"))]
    Ok(())
}

#[tauri::command]
pub async fn linked_library_location_plan(
    app: AppHandle,
    base_directory: Option<String>,
    mode: LocationMode,
) -> Result<LocationPlan> {
    supported()?;
    tauri::async_runtime::spawn_blocking(move || {
        let writes = app.state::<LinkedLibraryWriteState>();
        let _guard = writes.0.try_lock().map_err(|_| busy())?;
        Ok(plan_at(
            &library_root(&app)?,
            &load_bindings(&app)?,
            base_directory,
            mode,
        )?
        .0)
    })
    .await
    .map_err(|e| io_error(e.to_string()))?
}
#[tauri::command]
pub async fn linked_library_location_start(
    app: AppHandle,
    job_id: String,
    base_directory: Option<String>,
    mode: LocationMode,
    on_progress: Channel<LocationProgress>,
) -> Result<LocationResult> {
    supported()?;
    if !crate::portable_state::valid_canonical_uuid(&job_id) {
        return Err(invalid("jobId 必须为规范 UUID"));
    }
    let gate = Arc::new(ImportGate::default());
    let reservation = reserve(&app, &job_id, gate.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _reservation = reservation;
        let root = library_root(&app)?;
        let result = run_at(
            &root,
            &load_bindings(&app)?,
            &job_id,
            base_directory,
            mode,
            &gate,
            &mut |value| {
                let _ = on_progress.send(value);
            },
        );
        match result {
            Err(error) if error.code == "cancelled" => Ok(LocationResult {
                job_id,
                status: "cancelled",
                library_directory: managed_books_directory(&root)?
                    .to_string_lossy()
                    .into_owned(),
                book_count: 0,
                cleanup_pending_count: usize::from(recovery_pending(&root)),
            }),
            other => other,
        }
    })
    .await
    .map_err(|e| io_error(e.to_string()))?
}
#[tauri::command]
pub fn linked_library_location_cancel(app: AppHandle, job_id: String) -> Result<LocationCancel> {
    let state = app.state::<LibraryLocationState>();
    let slot = state.0.lock().map_err(|_| busy())?;
    let status = match slot
        .job
        .as_ref()
        .filter(|(id, _)| id == &job_id)
        .map(|(_, gate)| gate.cancel())
    {
        Some(ImportCancelReply::Requested) => "requested",
        Some(ImportCancelReply::TooLate) => "too-late",
        _ => "not-running",
    };
    Ok(LocationCancel { status })
}
#[tauri::command]
pub async fn linked_library_location_recover(app: AppHandle) -> Result<LocationResult> {
    supported()?;
    let id = random_uuid_v4()?;
    let reservation = reserve(&app, &id, Arc::new(ImportGate::default()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _reservation = reservation;
        recover_at(&library_root(&app)?)
    })
    .await
    .map_err(|e| io_error(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        dir: PathBuf,
        root: PathBuf,
        base: PathBuf,
        bindings: Vec<DeviceBinding>,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("library-location-{}", random_uuid_v4().unwrap()));
            let root = dir.join("dev.reader.location-test/linked-library");
            let base = dir.join("destination");
            fs::create_dir_all(root.join("books")).unwrap();
            fs::create_dir_all(&base).unwrap();
            let meta = ImportedMetadata {
                title: "synthetic".into(),
                creator: String::new(),
                language: String::new(),
                spine: vec!["c.xhtml".into()],
                cover_zip_path: None,
                cover_mime: String::new(),
            };
            let mut bindings = Vec::new();
            for (i, bytes) in [
                b"first book bytes".as_slice(),
                b"second book bytes".as_slice(),
            ]
            .into_iter()
            .enumerate()
            {
                let hash = hash_bytes(bytes);
                let name = if i == 0 {
                    "原书 (2).epub".into()
                } else {
                    format!("{hash}.epub")
                };
                let path = root.join("books").join(&name);
                fs::write(&path, bytes).unwrap();
                let mut binding = make_managed_binding(hash, snapshot(&path).unwrap(), &meta);
                if i == 0 {
                    binding = binding.with_managed_file_name(name);
                }
                bindings.push(binding);
            }
            Self {
                dir,
                root,
                base,
                bindings,
            }
        }
        fn target(&self) -> PathBuf {
            self.base.join("dev.reader.location-test/books-v1")
        }
        fn base_arg(&self) -> Option<String> {
            Some(self.base.to_string_lossy().into_owned())
        }
        fn run(
            &self,
            mode: LocationMode,
            gate: &ImportGate,
            sink: &mut dyn FnMut(LocationProgress),
        ) -> Result<LocationResult> {
            run_at(
                &self.root,
                &self.bindings,
                &random_uuid_v4().unwrap(),
                self.base_arg(),
                mode,
                gate,
                sink,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn location_move_unifies_named_legacy_export_staging_and_missing_drive() {
        let f = Fixture::new();
        fs::write(f.root.join("library.sqlite3"), b"database untouched").unwrap();
        fs::write(f.root.join("books/foreign.txt"), b"not ours").unwrap();
        let mut events = Vec::new();
        let result = f
            .run(LocationMode::Move, &ImportGate::default(), &mut |e| {
                events.push(e)
            })
            .unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(managed_books_directory(&f.root).unwrap(), f.target());
        for binding in &f.bindings {
            let path = binding
                .resolve_source(&f.root)
                .unwrap()
                .path()
                .to_path_buf();
            assert!(path.starts_with(f.target()));
            assert!(
                verify_binding_for_list_refresh(&mut binding.clone(), &f.root)
                    .unwrap()
                    .available
            );
            assert!(!f
                .root
                .join("books")
                .join(path.file_name().unwrap())
                .exists());
            let exported: crate::save_file::LocalBinding =
                serde_json::from_value(serde_json::to_value(binding).unwrap()).unwrap();
            assert_eq!(exported.source_path(&f.root).unwrap(), path);
        }
        assert!(crate::save_file::staging_root(&f.root)
            .unwrap()
            .starts_with(f.target()));
        assert!(new_staging_path(&f.root).unwrap().starts_with(f.target()));
        assert!(
            crate::save_file::managed_book_path(&f.root, &"a".repeat(64))
                .unwrap()
                .starts_with(f.target())
        );
        assert_eq!(
            fs::read(f.root.join("library.sqlite3")).unwrap(),
            b"database untouched"
        );
        assert_eq!(
            fs::read(f.root.join("books/foreign.txt")).unwrap(),
            b"not ours"
        );
        assert!(!recovery_pending(&f.root));
        assert!(events.iter().any(|e| e.phase == "committing"));
        // Disconnected custom location cannot be recreated by any writer.
        fs::rename(f.target(), f.base.join("disconnected")).unwrap();
        assert!(new_staging_path(&f.root)
            .unwrap_err()
            .contains("unavailable"));
        assert!(crate::save_file::staging_root(&f.root).is_err());
        assert!(!f.target().exists());
    }

    #[test]
    fn location_cancel_corruption_space_and_overlap_keep_originals() {
        let f = Fixture::new();
        let before = fs::read(f.root.join("books/原书 (2).epub")).unwrap();
        let gate = ImportGate::default();
        assert_eq!(
            f.run(LocationMode::Move, &gate, &mut |_| {
                gate.cancel();
            })
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(!recovery_pending(&f.root));
        assert!(!f.target().exists());
        fs::write(f.root.join("books/原书 (2).epub"), b"wrong book bytes").unwrap();
        assert_eq!(
            f.run(LocationMode::Move, &ImportGate::default(), &mut |_| {})
                .unwrap_err()
                .code,
            "library-verification-failed"
        );
        assert_eq!(
            managed_books_directory(&f.root).unwrap(),
            f.root.join("books")
        );
        assert!(!recovery_pending(&f.root));
        fs::write(f.root.join("books/原书 (2).epub"), &before).unwrap();
        crate::save_file::set_available_space_override(Some(0));
        let space = plan_at(&f.root, &f.bindings, f.base_arg(), LocationMode::Move)
            .unwrap_err()
            .code;
        crate::save_file::clear_available_space_override();
        assert_eq!(space, "library-insufficient-space");
        assert_eq!(
            plan_at(
                &f.root,
                &f.bindings,
                Some(f.root.join("books").to_string_lossy().into_owned()),
                LocationMode::Move
            )
            .unwrap_err()
            .code,
            "library-target-overlap"
        );
        fs::create_dir_all(f.target()).unwrap();
        fs::write(f.target().join("foreign.txt"), b"untouched").unwrap();
        assert_eq!(
            f.run(LocationMode::Move, &ImportGate::default(), &mut |_| {})
                .unwrap_err()
                .code,
            "library-target-not-empty"
        );
        assert_eq!(
            fs::read(f.root.join("books/原书 (2).epub")).unwrap(),
            before
        );
        assert_eq!(
            fs::read(f.target().join("foreign.txt")).unwrap(),
            b"untouched"
        );
    }

    #[test]
    fn location_reconnect_checks_hash_even_with_matching_name_and_size() {
        let f = Fixture::new();
        fs::create_dir_all(f.target()).unwrap();
        for file in book_files(&f.bindings).unwrap() {
            fs::copy(
                f.root.join("books").join(&file.name),
                f.target().join(&file.name),
            )
            .unwrap();
        }
        let first = f.target().join("原书 (2).epub");
        let correct = fs::read(&first).unwrap();
        fs::write(&first, vec![b'x'; correct.len()]).unwrap();
        assert_eq!(
            f.run(LocationMode::Reconnect, &ImportGate::default(), &mut |_| {})
                .unwrap_err()
                .code,
            "library-verification-failed"
        );
        assert_eq!(
            managed_books_directory(&f.root).unwrap(),
            f.root.join("books")
        );
        fs::write(&first, correct).unwrap();
        assert_eq!(
            f.run(LocationMode::Reconnect, &ImportGate::default(), &mut |_| {})
                .unwrap()
                .status,
            "completed"
        );
        assert!(
            verify_binding_for_list_refresh(&mut f.bindings[0].clone(), &f.root)
                .unwrap()
                .available
        );
        assert!(f.root.join("books/原书 (2).epub").exists()); // reconnect never deletes source
    }

    #[test]
    fn location_recovery_handles_before_and_after_settings_commit() {
        let f = Fixture::new();
        // Simulate process loss with a published directory but old settings.
        let journal = Journal {
            version: 1,
            job_id: random_uuid_v4().unwrap(),
            source_base: None,
            target_base: f.base_arg(),
            files: book_files(&f.bindings).unwrap(),
        };
        let (_, _, stage) = journal.paths(&f.root).unwrap();
        fs::create_dir_all(&stage).unwrap();
        for file in &journal.files {
            fs::copy(
                f.root.join("books").join(&file.name),
                stage.join(&file.name),
            )
            .unwrap();
        }
        fs::write(stage.join(OWNER), &journal.job_id).unwrap();
        atomic_write_bytes(
            &journal_path(&f.root).unwrap(),
            &serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        publish_directory(&stage, &f.target()).unwrap();
        let offline = f.dir.join("offline-drive");
        fs::rename(&f.base, &offline).unwrap();
        assert_eq!(recover_at(&f.root).unwrap().status, "cleanup-pending");
        assert!(recovery_pending(&f.root));
        fs::rename(&offline, &f.base).unwrap();
        fs::write(f.target().join("foreign.txt"), b"keep").unwrap();
        assert_eq!(recover_at(&f.root).unwrap().status, "cleanup-pending");
        assert_eq!(fs::read(f.target().join("foreign.txt")).unwrap(), b"keep");
        fs::remove_file(f.target().join("foreign.txt")).unwrap();
        assert_eq!(recover_at(&f.root).unwrap().status, "completed");
        assert!(!f.target().exists());
        assert!(f.root.join("books/原书 (2).epub").exists());
        // A modified source at cleanup is retained; new settings are already committed.
        let old = f.root.join("books/原书 (2).epub");
        let original = fs::read(&old).unwrap();
        let outcome = f
            .run(LocationMode::Move, &ImportGate::default(), &mut |e| {
                if e.phase == "cleaning" {
                    fs::write(&old, b"external change").unwrap();
                }
            })
            .unwrap();
        assert_eq!(outcome.status, "cleanup-pending");
        assert_eq!(
            fs::read(f.target().join("原书 (2).epub")).unwrap(),
            original
        );
        assert_eq!(fs::read(&old).unwrap(), b"external change");
        assert_eq!(recover_at(&f.root).unwrap().status, "cleanup-pending");
        fs::write(&old, original).unwrap();
        assert_eq!(recover_at(&f.root).unwrap().status, "completed");
        assert!(!old.exists());
        assert!(!recovery_pending(&f.root));
    }
}
