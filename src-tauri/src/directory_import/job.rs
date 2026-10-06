//! In-process FI job registry and page cursors.
//!
//! A job owns only its light scanned manifest and native source locators.  It
//! never retains EPUB bytes.  Temporary staging belongs to one running worker
//! and is removed before `dispose` can release the slot.

use super::planner::directory_group_key;
use super::scanner::{scan_path_root_cancellable, ScanOutput};
use super::types::{
    CancelStatus, DirectoryBinding, DirectoryCancelReply, DirectorySource, ImportIssue,
    InputPage, IssuePage, ScanResult, ScannedEntry, ScannedEpub,
    PAGE_MAX_ITEMS, PAGE_MAX_JSON_BYTES,
};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::AppHandle;

pub struct DirectoryImportJob {
    id: String,
    source: DirectorySource,
    gate: Arc<super::policy::DirectoryJobGate>,
    root: Mutex<Option<super::types::ImportRoot>>,
    entries: Mutex<Vec<ScannedEntry>>,
    scan_result: Mutex<Option<ScanResult>>,
    issues: Mutex<Vec<ImportIssue>>,
    active_workers: Mutex<usize>,
    worker_done: Condvar,
    active_phase: AtomicU8,
    disposing: AtomicBool,
    import_started: AtomicBool,
    result: Mutex<Option<super::types::DirectoryImportResult>>,
}

const PHASE_NONE: u8 = 0;
const PHASE_SCANNING: u8 = 1;
const PHASE_IMPORTING: u8 = 2;

impl DirectoryImportJob {
    fn new(id: String, source: DirectorySource) -> Self {
        Self {
            id,
            source,
            gate: Arc::new(super::policy::DirectoryJobGate::default()),
            root: Mutex::new(None),
            entries: Mutex::new(Vec::new()),
            scan_result: Mutex::new(None),
            issues: Mutex::new(Vec::new()),
            active_workers: Mutex::new(0),
            worker_done: Condvar::new(),
            active_phase: AtomicU8::new(PHASE_NONE),
            disposing: AtomicBool::new(false),
            import_started: AtomicBool::new(false),
            result: Mutex::new(None),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn source(&self) -> &DirectorySource {
        &self.source
    }

    pub fn gate(&self) -> Arc<super::policy::DirectoryJobGate> {
        Arc::clone(&self.gate)
    }

    pub fn begin_worker(&self) {
        let mut active = self.active_workers.lock().unwrap();
        *active += 1;
    }

    pub fn end_worker(&self) {
        let mut active = self.active_workers.lock().unwrap();
        *active = active.saturating_sub(1);
        self.worker_done.notify_all();
    }

    pub fn wait_for_workers(&self) {
        let mut active = self.active_workers.lock().unwrap();
        while *active > 0 {
            active = self.worker_done.wait(active).unwrap();
        }
    }

    pub fn set_scan(&self, output: ScanOutput) -> ScanResult {
        let result = ScanResult {
            job_id: self.id.clone(),
            root: output.root.clone(),
            input_count: output.entries.len(),
            skipped_directory_count: output.skipped_directory_count,
            unreadable_directory_count: output.unreadable_directory_count,
        };
        *self.root.lock().unwrap() = Some(output.root);
        *self.entries.lock().unwrap() = output.entries;
        *self.scan_result.lock().unwrap() = Some(result.clone());
        result
    }

    pub fn scan_result(&self) -> Option<ScanResult> {
        self.scan_result.lock().unwrap().clone()
    }

    pub fn root(&self) -> Option<super::types::ImportRoot> {
        self.root.lock().unwrap().clone()
    }

    pub fn entries(&self) -> Vec<ScannedEntry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn begin_scan(&self) -> bool {
        if self.disposing.load(Ordering::Acquire) || self.import_started.load(Ordering::Acquire) {
            return false;
        }
        self.active_phase
            .compare_exchange(PHASE_NONE, PHASE_SCANNING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn end_scan(&self) {
        let _ = self.active_phase.compare_exchange(
            PHASE_SCANNING,
            PHASE_NONE,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub fn begin_import(&self) -> bool {
        if self.disposing.load(Ordering::Acquire) {
            return false;
        }
        if self.import_started.swap(true, Ordering::AcqRel) {
            return false;
        }
        if self
            .active_phase
            .compare_exchange(PHASE_NONE, PHASE_IMPORTING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.import_started.store(false, Ordering::Release);
            return false;
        }
        true
    }

    pub fn end_import(&self) {
        let _ = self.active_phase.compare_exchange(
            PHASE_IMPORTING,
            PHASE_NONE,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub fn request_dispose(&self) {
        self.disposing.store(true, Ordering::Release);
    }

    pub fn set_result(&self, result: super::types::DirectoryImportResult) {
        *self.result.lock().unwrap() = Some(result);
    }

    pub fn result(&self) -> Option<super::types::DirectoryImportResult> {
        self.result.lock().unwrap().clone()
    }

    pub fn add_issue(&self, issue: ImportIssue) {
        self.issues.lock().unwrap().push(issue);
    }

    pub fn page(&self, cursor: Option<&str>, app: &AppHandle) -> Result<InputPage, String> {
        let root = self
            .root()
            .ok_or_else(|| "目录扫描尚未完成".to_string())?;
        let entries = self.entries.lock().unwrap();
        let start = parse_cursor(cursor)?.min(entries.len());
        if start == entries.len() {
            return Ok(InputPage {
                items: Vec::new(),
                bindings: Vec::new(),
                next_cursor: None,
            });
        }

        let bindings_map = directory_bindings(app)?;
        let mut count = (entries.len() - start).min(PAGE_MAX_ITEMS);
        loop {
            let end = start + count;
            let items: Vec<ScannedEpub> = entries[start..end]
                .iter()
                .map(|entry| entry.epub.clone())
                .collect();
            let bindings = page_bindings(&root, &items, &bindings_map, start == 0);
            let next_cursor = (end < entries.len()).then(|| end.to_string());
            let mut page = InputPage {
                items,
                bindings,
                next_cursor,
            };
            let fits = serde_json::to_vec(&page)
                .map(|raw| raw.len() <= PAGE_MAX_JSON_BYTES)
                .unwrap_or(false);
            if fits || count == 1 {
                if !fits {
                    // A single item is never larger than the page budget, so
                    // only the page-local binding list can be the overflow.
                    page.bindings.clear();
                }
                return Ok(page);
            }
            count -= 1;
        }
    }

    pub fn issues_page(&self, cursor: Option<&str>) -> Result<IssuePage, String> {
        let issues = self.issues.lock().unwrap();
        let start = parse_cursor(cursor)?.min(issues.len());
        let mut count = (issues.len() - start).min(PAGE_MAX_ITEMS);
        loop {
            let end = start + count;
            let items = issues[start..end].to_vec();
            let next_cursor = (end < issues.len()).then(|| end.to_string());
            let page = IssuePage { items, next_cursor };
            if serde_json::to_vec(&page)
                .map(|raw| raw.len() <= PAGE_MAX_JSON_BYTES)
                .unwrap_or(false)
                || count == 0
            {
                return Ok(page);
            }
            count -= 1;
        }
    }
}

pub fn parse_cursor(cursor: Option<&str>) -> Result<usize, String> {
    match cursor {
        None => Ok(0),
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| "分页游标无效".to_string()),
    }
}

fn page_bindings(
    root: &super::types::ImportRoot,
    items: &[ScannedEpub],
    known: &BTreeMap<String, String>,
    include_root: bool,
) -> Vec<DirectoryBinding> {
    let mut keys: Vec<String> = Vec::new();
    if include_root {
        keys.push(directory_group_key(root, &[]));
    }
    for item in items {
        let key = directory_group_key(root, &item.relative_parent_segments);
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys.into_iter()
        .filter_map(|group_key| {
            known.get(&group_key).map(|folder_id| DirectoryBinding {
                group_key,
                folder_id: folder_id.clone(),
            })
        })
        .collect()
}

fn directory_bindings(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    crate::portable_state_commands::with_existing_store(app, |store| store.directory_bindings())
        .map_err(|error| error.to_string())
        .map(|value| value.unwrap_or_default())
}

#[derive(Default)]
pub struct DirectoryImportState {
    jobs: Mutex<HashMap<String, Arc<DirectoryImportJob>>>,
}

impl DirectoryImportState {
    pub fn register(
        &self,
        job_id: &str,
        source: DirectorySource,
    ) -> Result<Arc<DirectoryImportJob>, String> {
        if job_id.trim().is_empty() {
            return Err("jobId 不能为空".to_string());
        }
        let mut jobs = self.jobs.lock().map_err(|_| "目录导入作业表已损坏")?;
        if jobs.contains_key(job_id) {
            return Err("该目录导入作业已注册".to_string());
        }
        let job = Arc::new(DirectoryImportJob::new(job_id.to_string(), source));
        jobs.insert(job_id.to_string(), Arc::clone(&job));
        Ok(job)
    }

    pub fn get(&self, job_id: &str) -> Result<Option<Arc<DirectoryImportJob>>, String> {
        let jobs = self.jobs.lock().map_err(|_| "目录导入作业表已损坏")?;
        Ok(jobs.get(job_id).cloned())
    }

    pub fn remove(&self, job_id: &str) -> Result<Option<Arc<DirectoryImportJob>>, String> {
        let mut jobs = self.jobs.lock().map_err(|_| "目录导入作业表已损坏")?;
        Ok(jobs.remove(job_id))
    }
}

pub fn cancel_reply(gate: &super::policy::DirectoryJobGate) -> DirectoryCancelReply {
    let status = match gate.cancel() {
        super::policy::CancelReply::Requested => CancelStatus::Requested,
        super::policy::CancelReply::Settling => CancelStatus::Settling,
        super::policy::CancelReply::AlreadyFinished => CancelStatus::AlreadyFinished,
    };
    DirectoryCancelReply { status }
}

#[cfg(target_os = "android")]
use super::scanner::{scan_android_tree_cancellable, AndroidTreeBridge};

#[cfg(target_os = "android")]
struct AppAndroidTreeBridge<'a> {
    app: &'a AppHandle,
}

#[cfg(target_os = "android")]
impl AndroidTreeBridge for AppAndroidTreeBridge<'_> {
    fn query_directory(
        &self,
        tree_uri: &str,
        parent_document_id: Option<&str>,
    ) -> Result<(String, Vec<super::scanner::AndroidEntry>), String> {
        let response = crate::android_uri_bridge::query_tree_directory(
            self.app,
            tree_uri,
            parent_document_id,
        )?;
        Ok((
            response.parent_display_name,
            response
                .entries
                .into_iter()
                .map(|entry| super::scanner::AndroidEntry {
                    document_id: entry.document_id,
                    uri: entry.uri,
                    display_name: entry.display_name,
                    mime_type: entry.mime_type,
                    size: entry.size,
                    is_directory: entry.is_directory,
                })
                .collect(),
        ))
    }
}

pub fn scan_job(
    app: &AppHandle,
    job: &DirectoryImportJob,
    on_progress: &tauri::ipc::Channel<super::types::DirectoryProgress>,
 ) -> Result<ScanResult, String> {
    let _ = app;
    let progress = |scanned: usize| {
        let _ = on_progress.send(super::types::DirectoryProgress {
            job_id: job.id().to_string(),
            phase: super::types::ProgressPhase::Scanning,
            scanned_inputs: scanned,
            total_inputs: None,
            counts: Default::default(),
        });
    };
    progress(0);
    let cancelled = || job.gate().cancelled();
    let output = match job.source() {
        DirectorySource::Path { path } => {
            let path = PathBuf::from(path);
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("所选文件夹")
                .to_string();
            scan_path_root_cancellable(&path, name, &cancelled)?
        }
        DirectorySource::TreeUri { uri } => {
            #[cfg(target_os = "android")]
            {
                let bridge = AppAndroidTreeBridge { app };
                scan_android_tree_cancellable(&bridge, uri, &cancelled)?
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = uri;
                return Err("Android 树 URI 扫描仅可在 Android 上运行".to_string());
            }
        }
    };
    if output.cancelled {
        return Err("目录扫描已取消".to_string());
    }
    let result = job.set_scan(output);
    progress(result.input_count);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::ImportRoot;

    #[test]
    fn page_bindings_include_root_and_page_groups_without_names() {
        let root = ImportRoot {
            source_root_key: "root".to_string(),
            name: "全部".to_string(),
        };
        let items = vec![
            ScannedEpub {
                input_id: "a".to_string(),
                relative_parent_segments: vec!["小说".to_string()],
                file_name: "a.epub".to_string(),
                size_hint: None,
            },
            ScannedEpub {
                input_id: "b".to_string(),
                relative_parent_segments: vec!["小说".to_string()],
                file_name: "b.epub".to_string(),
                size_hint: None,
            },
        ];
        let mut known = BTreeMap::new();
        known.insert(directory_group_key(&root, &[]), "root-folder".to_string());
        known.insert(
            directory_group_key(&root, &["小说".to_string()]),
            "novel-folder".to_string(),
        );
        let bindings = page_bindings(&root, &items, &known, true);
        assert_eq!(bindings.len(), 2);
        assert!(bindings.iter().any(|binding| binding.folder_id == "root-folder"));
        assert!(bindings.iter().any(|binding| binding.folder_id == "novel-folder"));
    }

    #[test]
    fn cursor_rejects_non_numeric_input() {
        assert!(parse_cursor(Some("1x")).is_err());
        assert_eq!(parse_cursor(Some("12")).unwrap(), 12);
        assert_eq!(parse_cursor(None).unwrap(), 0);
    }
    #[test]
    fn scan_import_and_dispose_have_mutually_exclusive_admission() {
        let state = DirectoryImportState::default();
        let job = state
            .register(
                "job-1",
                DirectorySource::Path {
                    path: "/tmp/books".to_string(),
                },
            )
            .unwrap();
        assert!(job.begin_scan());
        assert!(!job.begin_scan());
        assert!(!job.begin_import());
        job.end_scan();
        assert!(job.begin_import());
        assert!(!job.begin_import());
        assert!(!job.begin_scan());
        job.end_import();
        job.request_dispose();
        assert!(!job.begin_scan());
        assert!(!job.begin_import());
    }

}
