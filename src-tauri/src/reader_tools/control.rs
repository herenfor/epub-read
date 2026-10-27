//! Process-local management. Snapshots never contain discovery credentials.
use super::host::{Grant, Host};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub(super) type Cleanup = Arc<dyn Fn(Vec<String>, Vec<String>) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ServiceState {
    Off,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ServiceError {
    pub code: &'static str,
    pub message: &'static str,
}

impl ServiceError {
    fn config() -> Self {
        Self {
            code: "invalid-config",
            message: "无法读取有效的阅读工具授权配置",
        }
    }
    fn write() -> Self {
        Self {
            code: "write-failed",
            message: "无法更新阅读工具连接文件",
        }
    }
    fn bind() -> Self {
        Self {
            code: "bind-failed",
            message: "无法启动本机阅读工具监听",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Books {
    All,
    Listed { count: usize },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientStatus {
    client_id: String,
    books: Books,
    prepare_index: bool,
    connection_file: Option<PathBuf>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub supported: bool,
    unsupported_reason: Option<&'static str>,
    pub service: ServiceState,
    error: Option<ServiceError>,
    pub provider: &'static str,
    service_instance: Option<String>,
    provider_error: Option<String>,
    initial_from_env: bool,
    grants_source: &'static str,
    connection_directory: Option<PathBuf>,
    clients: Vec<ClientStatus>,
    pub revision: u64,
}

struct Running {
    host: Arc<Host>,
    paths: Vec<PathBuf>,
    finished: std::sync::mpsc::Receiver<()>,
}
struct State {
    service: ServiceState,
    error: Option<ServiceError>,
    grants: Vec<Grant>,
    running: Option<Running>,
    revision: u64,
}

pub(super) struct Controller {
    operation: Mutex<()>,
    state: Mutex<State>,
    directory: Option<PathBuf>,
    config: Option<PathBuf>,
    initial_from_env: bool,
    unsupported_reason: Option<&'static str>,
    identifier: String,
    cleanup: Cleanup,
    notify: Box<dyn Fn(Status) + Send + Sync>,
}

impl Controller {
    pub fn new(
        directory: Option<PathBuf>,
        config: Option<PathBuf>,
        initial_from_env: bool,
        unsupported_reason: Option<&'static str>,
        identifier: String,
        cleanup: Cleanup,
        notify: Box<dyn Fn(Status) + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            operation: Mutex::new(()),
            state: Mutex::new(State {
                service: ServiceState::Off,
                error: None,
                grants: Vec::new(),
                running: None,
                revision: 0,
            }),
            directory,
            config,
            initial_from_env,
            unsupported_reason,
            identifier,
            cleanup,
            notify,
        })
    }

    fn snapshot(&self, state: &State) -> Status {
        let (provider, provider_error) = state
            .running
            .as_ref()
            .map(|running| running.host.provider_status())
            .unwrap_or(("waiting", None));
        Status {
            supported: self.unsupported_reason.is_none(),
            unsupported_reason: self.unsupported_reason,
            service: state.service.clone(),
            error: state.error.clone(),
            provider,
            provider_error,
            service_instance: state
                .running
                .as_ref()
                .map(|running| running.host.instance.clone()),
            initial_from_env: self.initial_from_env,
            grants_source: if self.config.is_some() {
                "env-config"
            } else {
                "default"
            },
            connection_directory: self.directory.clone(),
            revision: state.revision,
            clients: state
                .grants
                .iter()
                .map(|grant| ClientStatus {
                    client_id: grant.client_id.clone(),
                    books: match &grant.book_ids {
                        None => Books::All,
                        Some(ids) => Books::Listed { count: ids.len() },
                    },
                    prepare_index: grant.prepare_index,
                    connection_file: state.running.as_ref().and_then(|_| {
                        self.directory
                            .as_ref()
                            .map(|dir| dir.join(format!("{}.json", grant.client_id)))
                    }),
                })
                .collect(),
        }
    }

    fn update(&self, change: impl FnOnce(&mut State)) -> Status {
        let status = {
            let mut state = self.state.lock().expect("reader management state");
            change(&mut state);
            state.revision += 1;
            self.snapshot(&state)
        };
        (self.notify)(status.clone());
        status
    }

    pub fn status(&self) -> Status {
        self.snapshot(&self.state.lock().expect("reader management state"))
    }

    pub fn refresh(&self) -> Status {
        let _operation = self.operation.lock().expect("reader management operation");
        if self.unsupported_reason.is_none() && self.host().is_none() {
            self.read_configuration();
        }
        self.status()
    }

    fn read_configuration(&self) -> bool {
        match load_grants(self.config.as_deref()) {
            Ok(grants) => {
                let unchanged =
                    self.state.lock().expect("reader management state").grants == grants;
                if !unchanged {
                    self.update(|state| state.grants = grants);
                }
                true
            }
            Err(error) => {
                let unchanged = self
                    .state
                    .lock()
                    .expect("reader management state")
                    .error
                    .as_ref()
                    == Some(&error);
                if !unchanged {
                    self.update(|state| {
                        state.grants.clear();
                        state.service = ServiceState::Failed;
                        state.error = Some(error);
                    });
                }
                false
            }
        }
    }

    pub fn host(&self) -> Option<Arc<Host>> {
        self.state
            .lock()
            .expect("reader management state")
            .running
            .as_ref()
            .map(|running| running.host.clone())
    }

    pub fn set_enabled(self: &Arc<Self>, enabled: bool) -> Status {
        let _operation = self.operation.lock().expect("reader management operation");
        if self.unsupported_reason.is_some() {
            return self.status();
        }
        if enabled {
            if self.host().is_some() {
                return self.status();
            }
            self.update(|state| {
                state.service = ServiceState::Starting;
                state.error = None;
            });
            if !self.read_configuration() {
                return self.status();
            }
            match self.launch() {
                Ok((running, listener, finished)) => {
                    let host = running.host.clone();
                    self.update(|state| {
                        state.running = Some(running);
                        state.service = ServiceState::Running;
                    });
                    let weak = Arc::downgrade(self);
                    tauri::async_runtime::spawn(async move {
                        super::http::serve(listener, host.clone()).await;
                        let _ = finished.send(());
                        if let Some(controller) = weak.upgrade() {
                            controller.listener_ended(&host.instance);
                        }
                    });
                }
                Err(error) => {
                    self.update(|state| {
                        state.service = ServiceState::Failed;
                        state.error = Some(error);
                    });
                }
            }
        } else {
            let running = {
                let mut state = self.state.lock().expect("reader management state");
                state.running.take()
            };
            if let Some(running) = running {
                self.update(|state| state.service = ServiceState::Stopping);
                running.host.stop();
                // Listener has dropped its socket before Off is published.
                let _ = running.finished.recv();
                let removed = remove_owned(&running.paths, &running.host.instance);
                self.update(|state| {
                    state.service = if removed {
                        ServiceState::Off
                    } else {
                        ServiceState::Failed
                    };
                    state.error = if removed {
                        None
                    } else {
                        Some(ServiceError::write())
                    };
                });
            } else if self.status().service != ServiceState::Off {
                self.update(|state| {
                    state.service = ServiceState::Off;
                    state.error = None;
                });
            }
        }
        self.status()
    }

    fn launch(
        self: &Arc<Self>,
    ) -> Result<(Running, std::net::TcpListener, std::sync::mpsc::Sender<()>), ServiceError> {
        let grants = self
            .state
            .lock()
            .expect("reader management state")
            .grants
            .clone();
        let weak = Arc::downgrade(self);
        let cleanup = self.cleanup.clone();
        let host = Host::new(
            grants,
            Box::new(move |archives, tasks| cleanup(archives, tasks)),
            Box::new(move |instance| {
                if let Some(controller) = weak.upgrade() {
                    controller.host_changed(instance);
                }
            }),
        )
        .map_err(|_| ServiceError {
            code: "failed",
            message: "无法创建阅读工具服务",
        })?;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| ServiceError::bind())?;
        listener
            .set_nonblocking(true)
            .map_err(|_| ServiceError::bind())?;
        let port = listener
            .local_addr()
            .map_err(|_| ServiceError::bind())?
            .port();
        let directory = self.directory.as_ref().ok_or_else(ServiceError::write)?;
        let paths = publish_connections(directory, &host, &self.identifier, port)?;
        let (finished, receiver) = std::sync::mpsc::channel();
        Ok((
            Running {
                host,
                paths,
                finished: receiver,
            },
            listener,
            finished,
        ))
    }

    fn host_changed(&self, instance: &str) {
        let matches = self.host().is_some_and(|host| host.instance == instance);
        if matches {
            self.update(|_| {});
        }
    }

    fn listener_ended(&self, instance: &str) {
        // A deliberate stop removes the runtime before stopping its listener.
        let _operation = self.operation.lock().expect("reader management operation");
        if !self.host().is_some_and(|host| host.instance == instance) {
            return;
        }
        let mut owned = None;
        self.update(|state| {
            owned = state.running.take();
            state.service = ServiceState::Failed;
            state.error = Some(ServiceError::bind());
        });
        if let Some(owned) = owned {
            remove_owned(&owned.paths, &owned.host.instance);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    clients: Vec<Grant>,
}

fn load_grants(path: Option<&Path>) -> Result<Vec<Grant>, ServiceError> {
    let grants = if let Some(path) = path {
        use std::io::Read;
        let file = std::fs::File::open(path).map_err(|_| ServiceError::config())?;
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ServiceError::config())?;
        if bytes.len() > 64 * 1024 {
            return Err(ServiceError::config());
        }
        serde_json::from_slice::<Configuration>(&bytes)
            .map_err(|_| ServiceError::config())?
            .clients
    } else {
        vec![Grant {
            client_id: "local".into(),
            book_ids: None,
            prepare_index: false,
        }]
    };
    let mut ids = HashSet::new();
    if grants.is_empty()
        || grants.len() > 16
        || grants.iter().any(|grant| {
            grant.client_id.is_empty()
                || grant.client_id.len() > 64
                || !grant
                    .client_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                || !ids.insert(grant.client_id.clone())
                || grant
                    .book_ids
                    .as_ref()
                    .is_some_and(|ids| ids.len() > 10_000)
        })
    {
        return Err(ServiceError::config());
    }
    Ok(grants)
}

fn publish_connections(
    directory: &Path,
    host: &Host,
    identifier: &str,
    port: u16,
) -> Result<Vec<PathBuf>, ServiceError> {
    std::fs::create_dir_all(directory).map_err(|_| ServiceError::write())?;
    let mut paths = Vec::new();
    for client in &host.clients {
        let path = directory.join(format!("{}.json", client.grant.client_id));
        let data = json!({"apiVersion":"1", "endpoint":format!("http://127.0.0.1:{port}"),
            "token":client.token, "grant":client.grant, "serviceInstance":host.instance,
            "appIdentifier":identifier, "development":true});
        if crate::linked_library::atomic_write_bytes(
            &path,
            &serde_json::to_vec(&data).map_err(|_| ServiceError::write())?,
        )
        .is_err()
        {
            remove_owned(&paths, &host.instance);
            return Err(ServiceError::write());
        }
        paths.push(path);
    }
    Ok(paths)
}

fn remove_owned(paths: &[PathBuf], instance: &str) -> bool {
    let mut success = true;
    for path in paths {
        let ours = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|data| data["serviceInstance"] == instance);
        if ours && std::fs::remove_file(path).is_err() {
            success = false;
        }
    }
    success
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "epub-reader-control-{}",
                super::super::host::random_id().unwrap()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn control(directory: &Path, config: Option<PathBuf>, cleanup: Cleanup) -> Arc<Controller> {
        Controller::new(
            Some(directory.into()),
            config,
            false,
            None,
            "test.reader".into(),
            cleanup,
            Box::new(|_| {}),
        )
    }

    #[test]
    fn repeated_enable_and_stop_preserve_foreign_files_and_reject_old_replies() {
        let temporary = Temporary::new();
        let reclaimed = Arc::new(Mutex::new(Vec::new()));
        let output = reclaimed.clone();
        let control = control(
            &temporary.0,
            None,
            Arc::new(move |archives, tasks| output.lock().unwrap().push((archives, tasks))),
        );
        control.set_enabled(true);
        let host = control.host().unwrap();
        let instance = host.instance.clone();
        let revision = control.status().revision;
        control.set_enabled(true);
        assert_eq!(control.host().unwrap().instance, instance);
        assert_eq!(control.status().revision, revision);
        let session = host
            .connect(
                Box::new(|_| Ok(())),
                vec![json!({"name":"read", "readOnly":true})],
            )
            .unwrap();
        assert!(host.own_archive(&session, "owned-archive".into()));
        assert!(host.own_task(&session, "owned-index".into()));
        let (id, _reply) = host
            .dispatch(
                &session,
                json!({"requestId":"r", "name":"read", "arguments":{}}),
                &host.clients[0].grant,
            )
            .unwrap();
        let path = temporary.0.join("local.json");
        std::fs::write(&path, br#"{"serviceInstance":"another-instance"}"#).unwrap();
        assert_eq!(control.set_enabled(false).service, ServiceState::Off);
        assert!(path.exists());
        assert!(host.reply(&session, &id, json!({})).is_err());
        assert_eq!(
            *reclaimed.lock().unwrap(),
            vec![(
                vec!["owned-archive".to_string()],
                vec!["owned-index".to_string()]
            )]
        );
        control.set_enabled(false);
        control.set_enabled(true);
        assert_ne!(control.host().unwrap().instance, instance);
        control.set_enabled(false);
        assert!(!path.exists());
    }

    #[test]
    fn configuration_projection_is_bounded_and_never_exposes_credentials() {
        let temporary = Temporary::new();
        let config = temporary.0.join("grants.json");
        std::fs::write(&config, br#"{"clients":[{"clientId":"all","bookIds":null},{"clientId":"empty","bookIds":[],"prepareIndex":true}]}"#).unwrap();
        let control = control(
            &temporary.0.join("connections"),
            Some(config),
            Arc::new(|_, _| {}),
        );
        let off = serde_json::to_value(control.refresh()).unwrap();
        assert_eq!(off["clients"][0]["books"], json!({"kind":"all"}));
        assert_eq!(
            off["clients"][1]["books"],
            json!({"kind":"listed","count":0})
        );
        assert!(off["clients"][0]["connectionFile"].is_null());
        let snapshot = serde_json::to_string(&control.set_enabled(true)).unwrap();
        let discovery: Value = serde_json::from_slice(
            &std::fs::read(temporary.0.join("connections/all.json")).unwrap(),
        )
        .unwrap();
        assert!(!snapshot.contains(discovery["token"].as_str().unwrap()));
        assert!(!snapshot.contains(discovery["endpoint"].as_str().unwrap()));
        assert!(!snapshot.contains("\"port\""));
        assert!(!snapshot.contains("\"token\""));
        control.set_enabled(false);
    }

    #[test]
    fn failed_configuration_and_partial_publication_are_visible_and_cleaned() {
        let temporary = Temporary::new();
        let config = temporary.0.join("grants.json");
        std::fs::write(&config, b"bad-json").unwrap();
        let directory = temporary.0.join("connections");
        let control = control(&directory, Some(config.clone()), Arc::new(|_, _| {}));
        let failed = serde_json::to_value(control.set_enabled(true)).unwrap();
        assert_eq!(failed["service"], "failed");
        assert_eq!(failed["error"]["code"], "invalid-config");
        std::fs::write(&config, br#"{"clients":[{"clientId":"first","bookIds":null},{"clientId":"second","bookIds":null}]}"#).unwrap();
        std::fs::create_dir_all(directory.join("second.json")).unwrap();
        let failed = serde_json::to_value(control.set_enabled(true)).unwrap();
        assert_eq!(failed["error"]["code"], "write-failed");
        assert!(control.host().is_none());
        assert!(!directory.join("first.json").exists());
        assert!(directory.join("second.json").is_dir());
    }

    #[test]
    fn provider_failure_requires_explicit_retry_and_does_not_leak_raw_errors() {
        let temporary = Temporary::new();
        let control = control(&temporary.0, None, Arc::new(|_, _| {}));
        control.set_enabled(true);
        let host = control.host().unwrap();
        let session = host.connect(Box::new(|_| Ok(())), vec![]).unwrap();
        host.disconnect(&session, Some("private-token-and-source-text"));
        assert_eq!(control.status().provider, "failed");
        assert_eq!(
            control.status().provider_error.as_deref(),
            Some("provider-channel-failed")
        );
        assert!(!serde_json::to_string(&control.status())
            .unwrap()
            .contains("private-token"));
        control.set_enabled(true);
        assert_eq!(control.status().provider, "failed");
        assert!(host.connect(Box::new(|_| Ok(())), vec![]).is_err());
        host.retry_provider();
        assert_eq!(control.status().provider, "waiting");
        host.connect(Box::new(|_| Ok(())), vec![]).unwrap();
        host.disconnect(&session, Some("stale-error"));
        assert_eq!(control.status().provider, "ready");
        control.set_enabled(false);
    }

    #[test]
    fn stop_waits_for_admitted_native_source_acquisition() {
        let host = Host::new(vec![], Box::new(|_, _| {}), Box::new(|_| {})).unwrap();
        let session = host.connect(Box::new(|_| Ok(())), vec![]).unwrap();
        let source_host = host.clone();
        let (entered, entry) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let source = std::thread::spawn(move || {
            source_host.source_operation(&session, || {
                entered.send(()).unwrap();
                wait.recv().unwrap();
                Ok(())
            })
        });
        entry.recv().unwrap();
        let (stopped, completion) = std::sync::mpsc::channel();
        let stop = std::thread::spawn(move || {
            host.stop();
            stopped.send(()).unwrap();
        });
        assert!(completion.recv_timeout(Duration::from_millis(20)).is_err());
        release.send(()).unwrap();
        completion.recv_timeout(Duration::from_secs(2)).unwrap();
        source.join().unwrap().unwrap();
        stop.join().unwrap();
    }
}
