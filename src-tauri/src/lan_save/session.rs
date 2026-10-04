use super::error::LanSaveError;
use super::protocol::{ControlMessage, WireOffer};
use crate::save_file::commands::FileTask;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Notify};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanProgressEvent {
    pub phase: String,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanSaveEvent {
    pub event: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<LanProgressEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<serde_json::Value>,
}

pub(crate) type LanEventSink = Arc<dyn Fn(LanSaveEvent) + Send + Sync + 'static>;

pub(crate) enum ReceiverAction {
    Accept {
        part_path: PathBuf,
        archive_bytes: u64,
        reply: oneshot::Sender<Result<(), LanSaveError>>,
    },
    PhaseChanged,
}

#[derive(Default)]
struct WorkState {
    closing: bool,
    running: usize,
}

#[derive(Default)]
pub(crate) struct WorkerOwner {
    state: Mutex<WorkState>,
    changed: Notify,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WorkerClosed;

pub(crate) struct WorkerLease {
    owner: Arc<WorkerOwner>,
}

impl WorkerOwner {
    pub(crate) fn enter(self: &Arc<Self>) -> Result<WorkerLease, WorkerClosed> {
        let mut state = self.state.lock().expect("worker ownership lock");
        if state.closing {
            return Err(WorkerClosed);
        }
        state.running += 1;
        Ok(WorkerLease {
            owner: self.clone(),
        })
    }

    pub(crate) fn request_close(&self) -> bool {
        let mut state = self.state.lock().expect("worker ownership lock");
        let first = !state.closing;
        state.closing = true;
        drop(state);
        self.changed.notify_waiters();
        first
    }

    pub(crate) async fn drain_closed(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let state = self.state.lock().expect("worker ownership lock");
                if state.closing && state.running == 0 {
                    return;
                }
            }
            notified.await;
        }
    }
}

impl WorkerLease {
    pub(crate) fn while_open<T>(&self, operation: impl FnOnce() -> T) -> Result<T, WorkerClosed> {
        let state = self.owner.state.lock().expect("worker ownership lock");
        if state.closing {
            return Err(WorkerClosed);
        }
        let result = operation();
        drop(state);
        Ok(result)
    }

    pub(crate) fn child(&self) -> Result<Self, WorkerClosed> {
        self.owner.enter()
    }
}

impl Drop for WorkerLease {
    fn drop(&mut self) {
        let mut state = self.owner.state.lock().expect("worker ownership lock");
        state.running -= 1;
        let drained = state.closing && state.running == 0;
        drop(state);
        if drained {
            self.owner.changed.notify_waiters();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Pairing,
    Ready,
    Exporting,
    OfferPending,
    Sending,
    Receiving,
    Preparing,
    Preview,
    Committing,
    Finished,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GateClose {
    Cancelled,
    CommitInProgress,
    AlreadyFinished,
}

#[derive(Debug)]
struct GateInner {
    phase: Phase,
    link_closed: bool,
}

#[derive(Debug)]
pub(crate) struct SessionGate {
    state: Mutex<GateInner>,
}

impl Default for SessionGate {
    fn default() -> Self {
        Self {
            state: Mutex::new(GateInner {
                phase: Phase::Pairing,
                link_closed: false,
            }),
        }
    }
}

impl SessionGate {
    pub(crate) fn phase(&self) -> Result<Phase, LanSaveError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| LanSaveError::invalid_state("会话状态锁已损坏"))?
            .phase)
    }

    fn step(&self, expected: Phase, next: Phase) -> Result<(), LanSaveError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| LanSaveError::invalid_state("会话状态锁已损坏"))?;
        if state.link_closed {
            return Err(LanSaveError::invalid_state("会话已经关闭"));
        }
        if state.phase != expected {
            return Err(LanSaveError::invalid_state(format!(
                "会话阶段不允许该操作：当前 {:?}",
                state.phase
            )));
        }
        state.phase = next;
        Ok(())
    }

    pub(crate) fn paired(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Pairing, Phase::Ready)
    }

    pub(crate) fn begin_export(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Ready, Phase::Exporting)
    }

    pub(crate) fn export_ready(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Exporting, Phase::OfferPending)
    }

    pub(crate) fn peer_accepts_download(&self) -> Result<(), LanSaveError> {
        self.step(Phase::OfferPending, Phase::Sending)
    }

    pub(crate) fn accept_download(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Ready, Phase::Receiving)
    }

    pub(crate) fn received_exact_archive(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Receiving, Phase::Preparing)
    }

    pub(crate) fn import_prepared(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Preparing, Phase::Preview)
    }

    pub(crate) fn begin_commit(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Preview, Phase::Committing)
    }

    pub(crate) fn commit_finished(&self) -> Result<bool, LanSaveError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| LanSaveError::invalid_state("会话状态锁已损坏"))?;
        if state.phase != Phase::Committing {
            return Err(LanSaveError::invalid_state("提交未在进行"));
        }
        state.phase = Phase::Finished;
        Ok(!state.link_closed)
    }

    pub(crate) fn receiver_reports_committed(&self) -> Result<(), LanSaveError> {
        self.step(Phase::Sending, Phase::Finished)
    }

    pub(crate) fn close(&self) -> Result<GateClose, LanSaveError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| LanSaveError::invalid_state("会话状态锁已损坏"))?;
        state.link_closed = true;
        match state.phase {
            Phase::Committing => Ok(GateClose::CommitInProgress),
            Phase::Finished | Phase::Closed => Ok(GateClose::AlreadyFinished),
            _ => {
                state.phase = Phase::Closed;
                Ok(GateClose::Cancelled)
            }
        }
    }
}

const ROLE_IDLE: u8 = 0;
const ROLE_OUTGOING: u8 = 1;
const ROLE_INCOMING: u8 = 2;

pub(crate) struct LanSession {
    pub(crate) session_id: String,
    host_token: Option<String>,
    transfer_id: Mutex<Option<String>>,
    gate: SessionGate,
    event_sink: Mutex<Option<LanEventSink>>,
    connection: Mutex<Option<Arc<super::connection::LanConnection>>>,
    inbox: Mutex<VecDeque<ControlMessage>>,
    notify: Notify,
    close_requested: AtomicBool,
    closed_event_sent: AtomicBool,
    role: AtomicU8,
    offer: Mutex<Option<WireOffer>>,
    file_task: Mutex<Option<Arc<FileTask>>>,
    file_job_id: Mutex<Option<String>>,
    receiver_action_tx: mpsc::Sender<ReceiverAction>,
    receiver_action_rx: Mutex<Option<mpsc::Receiver<ReceiverAction>>>,
    workers: Arc<WorkerOwner>,
    finalize_started: AtomicBool,
    finalize_finished: AtomicBool,
    outgoing_bytes: AtomicU64,
}

impl LanSession {
    pub(crate) fn new_host(
        session_id: String,
        token: String,
        transfer_id: String,
        event_sink: LanEventSink,
    ) -> Self {
        Self::new_inner(session_id, Some(token), Some(transfer_id), event_sink)
    }

    pub(crate) fn new_join(
        session_id: String,
        transfer_id: String,
        event_sink: LanEventSink,
    ) -> Self {
        Self::new_inner(session_id, None, Some(transfer_id), event_sink)
    }

    pub(crate) fn new_pending_join(session_id: String, event_sink: LanEventSink) -> Self {
        Self::new_inner(session_id, None, None, event_sink)
    }

    fn new_inner(
        session_id: String,
        host_token: Option<String>,
        transfer_id: Option<String>,
        event_sink: LanEventSink,
    ) -> Self {
        let (receiver_action_tx, receiver_action_rx) = mpsc::channel(4);
        Self {
            session_id,
            host_token,
            transfer_id: Mutex::new(transfer_id),
            gate: SessionGate::default(),
            event_sink: Mutex::new(Some(event_sink)),
            connection: Mutex::new(None),
            inbox: Mutex::new(VecDeque::new()),
            notify: Notify::new(),
            close_requested: AtomicBool::new(false),
            closed_event_sent: AtomicBool::new(false),
            role: AtomicU8::new(ROLE_IDLE),
            offer: Mutex::new(None),
            file_task: Mutex::new(None),
            file_job_id: Mutex::new(None),
            receiver_action_tx,
            receiver_action_rx: Mutex::new(Some(receiver_action_rx)),
            workers: Arc::new(WorkerOwner::default()),
            finalize_started: AtomicBool::new(false),
            finalize_finished: AtomicBool::new(false),
            outgoing_bytes: AtomicU64::new(0),
        }
    }

    pub(crate) fn gate(&self) -> &SessionGate {
        &self.gate
    }

    pub(crate) fn set_outgoing_bytes(&self, bytes: u64) {
        self.outgoing_bytes.store(bytes, Ordering::Release);
    }

    pub(crate) fn outgoing_bytes(&self) -> u64 {
        self.outgoing_bytes.load(Ordering::Acquire)
    }

    pub(crate) fn enter_worker(&self) -> Result<WorkerLease, LanSaveError> {
        self.workers.enter().map_err(|_| LanSaveError::cancelled())
    }

    pub(crate) fn request_workers_close(&self) -> bool {
        self.workers.request_close()
    }

    pub(crate) async fn drain_workers(&self) {
        self.workers.drain_closed().await
    }

    pub(crate) fn receiver_action_sender(&self) -> mpsc::Sender<ReceiverAction> {
        self.receiver_action_tx.clone()
    }

    pub(crate) fn take_receiver_action_receiver(&self) -> Option<mpsc::Receiver<ReceiverAction>> {
        self.receiver_action_rx
            .lock()
            .ok()
            .and_then(|mut receiver| receiver.take())
    }

    pub(crate) fn begin_finalize(&self) -> bool {
        self.finalize_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn finish_finalize(&self) {
        self.finalize_finished.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub(crate) async fn wait_finalize(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.finalize_finished.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    pub(crate) fn host_token(&self) -> Option<&str> {
        self.host_token.as_deref()
    }

    pub(crate) fn transfer_id(&self) -> Result<String, LanSaveError> {
        self.transfer_id
            .lock()
            .map_err(|_| LanSaveError::invalid_state("transferId 锁已损坏"))?
            .clone()
            .ok_or_else(|| LanSaveError::invalid_state("会话尚未分配 transferId"))
    }

    pub(crate) fn set_transfer_id(&self, transfer_id: String) -> Result<(), LanSaveError> {
        *self
            .transfer_id
            .lock()
            .map_err(|_| LanSaveError::invalid_state("transferId 锁已损坏"))? = Some(transfer_id);
        Ok(())
    }

    pub(crate) fn set_connection(
        &self,
        connection: Arc<super::connection::LanConnection>,
    ) -> Result<(), LanSaveError> {
        *self
            .connection
            .lock()
            .map_err(|_| LanSaveError::invalid_state("连接锁已损坏"))? = Some(connection);
        Ok(())
    }

    pub(crate) fn connection(&self) -> Result<Arc<super::connection::LanConnection>, LanSaveError> {
        self.connection
            .lock()
            .map_err(|_| LanSaveError::invalid_state("连接锁已损坏"))?
            .clone()
            .ok_or_else(|| LanSaveError::invalid_state("会话尚未建立 TLS 连接"))
    }

    pub(crate) fn claim_outgoing(&self) -> bool {
        self.role
            .compare_exchange(
                ROLE_IDLE,
                ROLE_OUTGOING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn claim_incoming(&self) -> bool {
        self.role
            .compare_exchange(
                ROLE_IDLE,
                ROLE_INCOMING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn is_outgoing(&self) -> bool {
        self.role.load(Ordering::Acquire) == ROLE_OUTGOING
    }

    pub(crate) fn set_offer(&self, offer: WireOffer) -> Result<(), LanSaveError> {
        *self
            .offer
            .lock()
            .map_err(|_| LanSaveError::invalid_state("Offer 锁已损坏"))? = Some(offer);
        Ok(())
    }

    pub(crate) fn offer_snapshot(&self) -> Result<Option<WireOffer>, LanSaveError> {
        Ok(self
            .offer
            .lock()
            .map_err(|_| LanSaveError::invalid_state("Offer 锁已损坏"))?
            .clone())
    }

    pub(crate) fn take_offer(&self) -> Result<Option<WireOffer>, LanSaveError> {
        Ok(self
            .offer
            .lock()
            .map_err(|_| LanSaveError::invalid_state("Offer 锁已损坏"))?
            .take())
    }

    pub(crate) fn push_inbox(&self, message: ControlMessage) -> Result<(), LanSaveError> {
        let mut inbox = self
            .inbox
            .lock()
            .map_err(|_| LanSaveError::invalid_state("控制消息队列锁已损坏"))?;
        if inbox.len() >= 8 {
            return Err(LanSaveError::invalid_state("控制消息队列已满"));
        }
        inbox.push_back(message);
        drop(inbox);
        self.notify.notify_waiters();
        Ok(())
    }

    fn take_matching<F>(&self, predicate: &F) -> Result<Option<ControlMessage>, LanSaveError>
    where
        F: Fn(&ControlMessage) -> bool,
    {
        let mut inbox = self
            .inbox
            .lock()
            .map_err(|_| LanSaveError::invalid_state("控制消息队列锁已损坏"))?;
        if let Some(index) = inbox.iter().position(predicate) {
            return Ok(inbox.remove(index));
        }
        Ok(None)
    }

    pub(crate) async fn wait_for_message<F>(
        &self,
        timeout: Duration,
        predicate: F,
    ) -> Result<ControlMessage, LanSaveError>
    where
        F: Fn(&ControlMessage) -> bool,
    {
        let started = Instant::now();
        loop {
            if self.close_requested.load(Ordering::Acquire) {
                return Err(LanSaveError::cancelled());
            }
            if let Some(message) = self.take_matching(&predicate)? {
                return Ok(message);
            }
            let remaining = timeout
                .checked_sub(started.elapsed())
                .ok_or_else(|| LanSaveError::expired("等待对端控制消息超时"))?;
            let mut notified = Box::pin(self.notify.notified());
            notified.as_mut().enable();
            if self.is_close_requested() {
                return Err(LanSaveError::cancelled());
            }
            if let Some(message) = self.take_matching(&predicate)? {
                return Ok(message);
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep(remaining) => {
                    return Err(LanSaveError::expired("等待对端控制消息超时"));
                }
            }
        }
    }

    pub(crate) fn set_file_task(
        &self,
        job_id: String,
        task: Arc<FileTask>,
    ) -> Result<(), LanSaveError> {
        *self
            .file_job_id
            .lock()
            .map_err(|_| LanSaveError::invalid_state("文件任务锁已损坏"))? = Some(job_id);
        *self
            .file_task
            .lock()
            .map_err(|_| LanSaveError::invalid_state("文件任务锁已损坏"))? = Some(task);
        Ok(())
    }

    pub(crate) fn file_task(&self) -> Result<Option<Arc<FileTask>>, LanSaveError> {
        Ok(self
            .file_task
            .lock()
            .map_err(|_| LanSaveError::invalid_state("文件任务锁已损坏"))?
            .clone())
    }

    pub(crate) fn file_job_id(&self) -> Result<Option<String>, LanSaveError> {
        Ok(self
            .file_job_id
            .lock()
            .map_err(|_| LanSaveError::invalid_state("文件任务锁已损坏"))?
            .clone())
    }

    pub(crate) fn is_role_idle(&self) -> bool {
        self.role.load(Ordering::Acquire) == ROLE_IDLE
    }

    pub(crate) fn clear_event_sink(&self) {
        if let Ok(mut sink) = self.event_sink.lock() {
            *sink = None;
        }
    }

    pub(crate) async fn take_connection(&self) -> Option<Arc<super::connection::LanConnection>> {
        let connection = self
            .connection
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        connection
    }

    pub(crate) fn request_close(&self) {
        self.close_requested.store(true, Ordering::Release);
        self.push_inbox(ControlMessage::Error {
            session_id: self.session_id.clone(),
            transfer_id: None,
            code: "closed".to_string(),
            message: "会话已关闭".to_string(),
        })
        .ok();
        self.notify.notify_waiters();
    }

    pub(crate) fn is_close_requested(&self) -> bool {
        self.close_requested.load(Ordering::Acquire)
    }

    pub(crate) async fn wait_until_closed(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.close_requested.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    pub(crate) fn emit_event(
        &self,
        event: &str,
        transfer_id: Option<&str>,
        code: Option<&str>,
        message: Option<&str>,
        summary: Option<serde_json::Value>,
    ) {
        let sink = match self.event_sink.lock() {
            Ok(sink) => sink.clone(),
            Err(_) => None,
        };
        let Some(sink) = sink else { return };
        if event == "closed" {
            if self.closed_event_sent.swap(true, Ordering::AcqRel) {
                return;
            }
        }
        sink(LanSaveEvent {
            event: event.to_string(),
            session_id: self.session_id.clone(),
            transfer_id: transfer_id.map(str::to_string),
            code: code.map(str::to_string),
            message: message.map(str::to_string),
            progress: None,
            summary,
        });
    }

    pub(crate) fn emit_progress(
        &self,
        phase: &str,
        processed_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        let event = match phase {
            "reading" | "extracting" => "preparing",
            "preparing" | "writing" | "finalizing" | "exporting" => "exporting",
            "copying" | "receiving" => "receiving",
            "committing" => "committing",
            other => other,
        };
        let sink = match self.event_sink.lock() {
            Ok(sink) => sink.clone(),
            Err(_) => None,
        };
        let Some(sink) = sink else { return };
        sink(LanSaveEvent {
            event: event.to_string(),
            session_id: self.session_id.clone(),
            transfer_id: self.transfer_id().ok(),
            code: None,
            message: None,
            progress: Some(LanProgressEvent {
                phase: phase.to_string(),
                processed_bytes,
                total_bytes,
            }),
            summary: None,
        });
    }
}
