//! Application-owned transport state. It has no shelf, prompt or memory database.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::{oneshot, watch, Semaphore};

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Grant {
    pub client_id: String,
    /// None grants the visible library; an empty list grants no books.
    #[serde(deserialize_with = "required_scope")]
    pub book_ids: Option<Vec<String>>,
    #[serde(default)]
    pub prepare_index: bool,
}

fn required_scope<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    Option::deserialize(deserializer)
}

fn permitted(tool: &Value, grant: &Grant) -> bool {
    tool["readOnly"] == true
        || grant.prepare_index
            && matches!(
                tool["name"].as_str(),
                Some("reader_prepare_index" | "reader_cancel_index")
            )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Client {
    pub token: String,
    pub grant: Grant,
}

pub(super) type SendFrame = Box<dyn Fn(Value) -> Result<(), String> + Send + Sync>;
struct Provider {
    id: String,
    send: SendFrame,
    definitions: Vec<Value>,
    archives: Vec<String>,
    tasks: Vec<String>,
}
struct Pending {
    provider_id: String,
    reply: oneshot::Sender<Value>,
}
#[derive(Default)]
struct State {
    provider: Option<Provider>,
    provider_error: Option<String>,
    pending: HashMap<String, Pending>,
}

pub(super) struct Host {
    pub instance: String,
    pub clients: Vec<Client>,
    pub serial: Semaphore,
    pub connections: Arc<Semaphore>,
    pub stopped: watch::Sender<bool>,
    state: Mutex<State>,
    sources: RwLock<()>,
    cleanup: Box<dyn Fn(Vec<String>, Vec<String>) + Send + Sync>,
    changed: Box<dyn Fn(&str) + Send + Sync>,
}

pub(super) fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法创建阅读工具凭据")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn failure(id: &str, code: &str, message: &str, retryable: bool) -> Value {
    json!({"apiVersion":"1", "requestId":id, "ok":false,
        "error":{"code":code,"message":message,"retryable":retryable}})
}

impl Host {
    pub fn new(
        grants: Vec<Grant>,
        cleanup: Box<dyn Fn(Vec<String>, Vec<String>) + Send + Sync>,
        changed: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let clients = grants
            .into_iter()
            .map(|grant| {
                Ok(Client {
                    token: random_id()?,
                    grant,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Arc::new(Self {
            instance: random_id()?,
            clients,
            serial: Semaphore::new(1),
            connections: Arc::new(Semaphore::new(16)),
            stopped: watch::channel(false).0,
            state: Mutex::new(State::default()),
            sources: RwLock::new(()),
            cleanup,
            changed,
        }))
    }

    pub fn connect(&self, send: SendFrame, definitions: Vec<Value>) -> Result<String, String> {
        let mut state = self.state.lock().map_err(|_| "阅读工具状态不可用")?;
        if *self.stopped.borrow() || state.provider_error.is_some() {
            return Err("阅读工具提供方需要显式重试".into());
        }
        // Reload must explicitly disconnect the old provider first. Never let a
        // second WebView silently take over work admitted to another provider.
        if state.provider.is_some() {
            return Err("已有阅读工具提供方连接；请先断开或重启AI应用".into());
        }
        let id = random_id()?;
        state.provider = Some(Provider {
            id: id.clone(),
            send,
            definitions,
            archives: Vec::new(),
            tasks: Vec::new(),
        });
        drop(state);
        (self.changed)(&self.instance);
        Ok(id)
    }

    pub fn disconnect(&self, id: &str, reason: Option<&str>) {
        let Ok(_sources) = self.sources.write() else {
            return;
        };
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.provider.as_ref().map(|p| p.id.as_str()) != Some(id) {
            return;
        }
        let (archives, tasks) = state
            .provider
            .take()
            .map(|p| (p.archives, p.tasks))
            .unwrap_or_default();
        // Close only this provider's native sessions before releasing admitted calls.
        (self.cleanup)(archives, tasks);
        state.pending.clear();
        state.provider_error = reason.map(provider_error);
        drop(state);
        (self.changed)(&self.instance);
    }

    pub fn provider_status(&self) -> (&'static str, Option<String>) {
        let state = self.state.lock().expect("reader provider state");
        if state.provider.is_some() {
            ("ready", None)
        } else if let Some(error) = &state.provider_error {
            ("failed", Some(error.clone()))
        } else {
            ("waiting", None)
        }
    }

    pub fn report_error(&self, reason: &str) {
        let mut state = self.state.lock().expect("reader provider state");
        if state.provider.is_some() || state.provider_error.is_some() || *self.stopped.borrow() {
            return;
        }
        state.provider_error = Some(provider_error(reason));
        drop(state);
        (self.changed)(&self.instance);
    }

    pub fn retry_provider(&self) {
        let mut state = self.state.lock().expect("reader provider state");
        if state.provider_error.take().is_none() {
            return;
        }
        drop(state);
        (self.changed)(&self.instance);
    }

    /// Stop/reload waits for in-flight native acquisitions, including late opens.
    pub fn source_operation<T>(
        &self,
        owner: &str,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _sources = self.sources.read().map_err(|_| "阅读工具状态不可用")?;
        if *self.stopped.borrow() || !self.owns_session(owner) {
            return Err("阅读工具会话已失效".into());
        }
        work()
    }

    pub fn owns_session(&self, id: &str) -> bool {
        self.provider_id().as_deref() == Some(id)
    }

    pub fn own_archive(&self, owner: &str, id: String) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(provider) = state.provider.as_mut().filter(|p| p.id == owner) else {
            return false;
        };
        provider.archives.push(id);
        true
    }

    pub fn own_task(&self, owner: &str, id: String) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(provider) = state.provider.as_mut().filter(|p| p.id == owner) else {
            return false;
        };
        provider.tasks.push(id);
        true
    }

    pub fn close_archive(&self, owner: &str, id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(provider) = state.provider.as_mut().filter(|p| p.id == owner) {
            if let Some(index) = provider.archives.iter().position(|archive| archive == id) {
                let id = provider.archives.swap_remove(index);
                (self.cleanup)(vec![id], Vec::new());
            }
        }
    }

    pub fn provider_id(&self) -> Option<String> {
        self.state
            .lock()
            .ok()?
            .provider
            .as_ref()
            .map(|p| p.id.clone())
    }

    pub fn tools(&self, grant: &Grant) -> Vec<Value> {
        self.state
            .lock()
            .ok()
            .and_then(|state| {
                state.provider.as_ref().map(|p| {
                    p.definitions
                        .iter()
                        .filter(|tool| permitted(tool, grant))
                        .cloned()
                        .collect()
                })
            })
            .unwrap_or_default()
    }

    pub fn dispatch(
        &self,
        owner: &str,
        request: Value,
        grant: &Grant,
    ) -> Result<(String, oneshot::Receiver<Value>), Value> {
        let request_id = request["requestId"].as_str().unwrap_or("");
        let mut state = self
            .state
            .lock()
            .map_err(|_| failure(request_id, "READER_UNAVAILABLE", "阅读工具状态不可用", true))?;
        let provider = state
            .provider
            .as_ref()
            .filter(|p| p.id == owner)
            .ok_or_else(|| {
                failure(
                    request_id,
                    "READER_DISCONNECTED",
                    "原阅读工具提供方已断开，请重新调用",
                    true,
                )
            })?;
        let definition = provider
            .definitions
            .iter()
            .find(|tool| tool["name"] == request["name"])
            .ok_or_else(|| {
                failure(
                    request_id,
                    "TOOL_NOT_SUPPORTED",
                    "此版本未提供该工具",
                    false,
                )
            })?;
        if !permitted(definition, grant) {
            return Err(failure(
                request_id,
                "ACCESS_DENIED",
                "此客户端未获索引准备权限",
                false,
            ));
        }
        if let (Some(ids), Some(book)) = (&grant.book_ids, request["arguments"]["bookId"].as_str())
        {
            if !ids.iter().any(|id| id == book) {
                return Err(failure(
                    request_id,
                    "ACCESS_DENIED",
                    "此书不在客户端授权范围",
                    false,
                ));
            }
        }
        let id = random_id()
            .map_err(|_| failure(request_id, "READER_UNAVAILABLE", "无法创建调用", true))?;
        let (tx, rx) = oneshot::channel();
        let frame = json!({"type":"call", "id":id, "request":request, "grant":grant});
        if (provider.send)(frame).is_err() {
            let (archives, tasks) = state
                .provider
                .take()
                .map(|p| (p.archives, p.tasks))
                .unwrap_or_default();
            (self.cleanup)(archives, tasks);
            state.pending.clear();
            state.provider_error = Some(provider_error("provider-channel-failed"));
            drop(state);
            (self.changed)(&self.instance);
            return Err(failure(
                request_id,
                "READER_DISCONNECTED",
                "阅读工具提供方已断开",
                true,
            ));
        }
        state.pending.insert(
            id.clone(),
            Pending {
                provider_id: owner.into(),
                reply: tx,
            },
        );
        Ok((id, rx))
    }

    pub fn cancel(&self, owner: &str, id: &str) {
        let Ok(state) = self.state.lock() else { return };
        if let Some(provider) = state.provider.as_ref().filter(|p| p.id == owner) {
            let _ = (provider.send)(json!({"type":"cancel", "id":id}));
        }
    }

    pub fn reply(&self, owner: &str, id: &str, reply: Value) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "阅读工具状态不可用")?;
        if state.provider.as_ref().map(|p| p.id.as_str()) != Some(owner) {
            return Err("阅读工具会话已失效".into());
        }
        if state.pending.get(id).map(|p| p.provider_id.as_str()) == Some(owner) {
            if let Some(pending) = state.pending.remove(id) {
                let _ = pending.reply.send(reply);
            }
        }
        Ok(())
    }

    pub fn stop(&self) {
        self.stopped.send_replace(true);
        if let Some(id) = self.provider_id() {
            self.disconnect(&id, None);
        } else {
            // A failed channel may already have removed the provider, while a
            // source acquisition admitted to it is still finishing.
            drop(self.sources.write());
        }
    }
}

fn provider_error(reason: &str) -> String {
    // IPC/JS errors may embed private input. Publish only recognized categories.
    match reason {
        "provider-connect-failed" => "provider-connect-failed",
        "provider-reply-failed" => "provider-reply-failed",
        _ => "provider-channel-failed",
    }
    .into()
}
