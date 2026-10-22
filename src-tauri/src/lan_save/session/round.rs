//! A connection owns many strictly sequential transfers. Only the current
//! transfer's workers are drained between batches; the control pump survives.
use super::*;

#[derive(Default)]
pub(super) struct Turnover {
    pub workers: Arc<WorkerOwner>,
    finishing: bool,
    local_done: bool,
    peer_done: bool,
    next: Option<String>,
    previous: Option<String>,
}

impl LanSession {
    pub(crate) fn enter_transfer_worker(&self) -> Result<WorkerLease, LanSaveError> {
        // A session close bars transfer registrations too. The temporary
        // connection lease serializes this check against request_workers_close.
        let connection = self.enter_worker()?;
        connection
            .while_open(|| {
                let turn = self
                    .turnover
                    .lock()
                    .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?;
                if turn.finishing {
                    return Err(LanSaveError::new("busy", "上一批正在收尾"));
                }
                turn.workers.enter().map_err(|_| LanSaveError::cancelled())
            })
            .map_err(|_| LanSaveError::cancelled())?
    }

    pub(crate) fn begin_turnover(&self, id: &str) -> Result<Arc<WorkerOwner>, LanSaveError> {
        if self.transfer_id()? != id || self.is_close_requested() {
            return Err(LanSaveError::invalid_state("收尾批次已经失效"));
        }
        let mut turn = self
            .turnover
            .lock()
            .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?;
        if turn.finishing {
            return Err(LanSaveError::new("busy", "批次已经在收尾"));
        }
        turn.finishing = true;
        turn.workers.request_close();
        Ok(turn.workers.clone())
    }

    pub(crate) fn mark_local_done(&self) -> Result<(), LanSaveError> {
        self.turnover
            .lock()
            .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?
            .local_done = true;
        self.notify.notify_waiters();
        Ok(())
    }

    pub(crate) fn mark_peer_done(&self) -> Result<(), LanSaveError> {
        self.turnover
            .lock()
            .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?
            .peer_done = true;
        self.notify.notify_waiters();
        Ok(())
    }

    pub(crate) async fn wait_peer_done(&self) -> Result<(), LanSaveError> {
        loop {
            let changed = self.notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .turnover
                .lock()
                .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?
                .peer_done
            {
                return Ok(());
            }
            tokio::select! {
                _ = self.wait_until_closed() => return Err(LanSaveError::cancelled()),
                _ = changed => {}
            }
        }
    }

    pub(crate) fn set_next_transfer(&self, id: String) -> Result<(), LanSaveError> {
        let mut turn = self
            .turnover
            .lock()
            .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?;
        if !turn.local_done || !turn.peer_done || !turn.finishing || turn.next.is_some() {
            return Err(LanSaveError::protocol("双方未完成收尾，不能分配下一批"));
        }
        turn.next = Some(id);
        Ok(())
    }

    pub(crate) fn is_previous_transfer(&self, id: &str) -> bool {
        self.turnover
            .lock()
            .is_ok_and(|turn| turn.previous.as_deref() == Some(id))
    }

    /// Called only by the control pump on NextTransfer/NextTransferAck, so
    /// following frames can never overtake the locally installed generation.
    pub(crate) fn install_next_transfer(
        &self,
        old: &str,
        next: &str,
        is_ack: bool,
    ) -> Result<(), LanSaveError> {
        if !crate::save_file::valid_job_id(next) || next == old || self.transfer_id()? != old {
            return Err(LanSaveError::protocol("下一批编号非法或不匹配"));
        }
        let connection = self.enter_worker()?;
        connection
            .while_open(|| {
                let mut turn = self
                    .turnover
                    .lock()
                    .map_err(|_| LanSaveError::invalid_state("批次状态锁已损坏"))?;
                if !turn.finishing
                    || !turn.local_done
                    || !turn.peer_done
                    || (is_ack && turn.next.as_deref() != Some(next))
                    || self.gate().phase()? != Phase::Finished
                {
                    return Err(LanSaveError::protocol("双方收尾尚未确认或下一批确认不匹配"));
                }
                self.set_transfer_id(next.to_owned())?;
                self.gate().step(Phase::Finished, Phase::Ready)?;
                let previous = Some(old.to_owned());
                *turn = Turnover {
                    previous,
                    ..Turnover::default()
                };
                if is_ack {
                    self.role.store(ROLE_IDLE, Ordering::Release);
                }
                self.notify.notify_waiters();
                Ok(())
            })
            .map_err(|_| LanSaveError::cancelled())?
    }

    pub(crate) fn activate_next_transfer(&self) -> Result<(), LanSaveError> {
        let connection = self.enter_worker()?;
        connection
            .while_open(|| self.role.store(ROLE_IDLE, Ordering::Release))
            .map_err(|_| LanSaveError::cancelled())
    }

    pub(crate) async fn wait_next_transfer(&self, old: &str) -> Result<(), LanSaveError> {
        loop {
            let changed = self.notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.transfer_id()? != old {
                return Ok(());
            }
            tokio::select! {
                _ = self.wait_until_closed() => return Err(LanSaveError::cancelled()),
                _ = changed => {}
            }
        }
    }

    pub(crate) fn clear_transfer_data(&self) -> Result<(), LanSaveError> {
        self.clear_remote_wait();
        self.clear_file_task()?;
        self.inbox
            .lock()
            .map_err(|_| LanSaveError::invalid_state("控制队列锁已损坏"))?
            .clear();
        self.offer
            .lock()
            .map_err(|_| LanSaveError::invalid_state("Offer锁已损坏"))?
            .take();
        self.inventory
            .lock()
            .map_err(|_| LanSaveError::invalid_state("核对状态锁已损坏"))?
            .take();
        self.outgoing_bytes.store(0, Ordering::Release);
        // Processing sequence numbers belong to the connection, never reset.
        Ok(())
    }
}
