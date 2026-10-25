//! A bounded preparation pool. The coordinator alone admits work and commits
//! results; workers can keep preparing while that coordinator writes a batch.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

type Reply<T> = (usize, Result<T, String>);

pub(super) struct PreparationPool<I, O> {
    tasks: Option<mpsc::SyncSender<(usize, I)>>,
    results: Option<mpsc::Receiver<Reply<O>>>,
    stopping: Arc<AtomicBool>,
    peak_active: Arc<AtomicUsize>,
}

impl<I, O> PreparationPool<I, O> {
    pub fn dispatch(&self, index: usize, input: I) -> Result<(), String> {
        self.tasks
            .as_ref()
            .expect("live preparation pool")
            .send((index, input))
            .map_err(|_| "目录导入准备队列已关闭".to_string())
    }

    pub fn receive(&self) -> Result<(usize, O), String> {
        let (index, result) = self
            .results
            .as_ref()
            .expect("live preparation pool")
            .recv()
            .map_err(|_| "目录导入准备线程已退出".to_string())?;
        result.map(|output| (index, output))
    }

    pub fn try_receive(&self) -> Result<Option<(usize, O)>, String> {
        match self
            .results
            .as_ref()
            .expect("live preparation pool")
            .try_recv()
        {
            Ok((index, result)) => result.map(|output| Some((index, output))),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err("目录导入准备线程已退出".to_string()),
        }
    }

    pub fn peak_active(&self) -> usize {
        self.peak_active.load(Ordering::Relaxed)
    }
}

impl<I, O> Drop for PreparationPool<I, O> {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        // Close both directions before joining: workers must not block on a
        // full result queue if commit failed or the user cancelled.
        self.tasks.take();
        self.results.take();
    }
}

pub(super) fn with_preparation_pool<I, O, R>(
    width: usize,
    capacity: usize,
    prepare: impl Fn(I) -> O + Sync,
    coordinate: impl FnOnce(&PreparationPool<I, O>) -> Result<R, String>,
) -> Result<R, String>
where
    I: Send,
    O: Send,
{
    assert!(width > 0 && capacity >= width);
    std::thread::scope(|scope| {
        let (task_tx, task_rx) = mpsc::sync_channel::<(usize, I)>(capacity);
        let (result_tx, result_rx) = mpsc::sync_channel::<Reply<O>>(capacity);
        let task_rx = Arc::new(Mutex::new(task_rx));
        let stopping = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicUsize::new(0));
        let peak_active = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::with_capacity(width);
        for _ in 0..width {
            let tasks = Arc::clone(&task_rx);
            let results = result_tx.clone();
            let stopping = Arc::clone(&stopping);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak_active);
            let prepare = &prepare;
            workers.push(scope.spawn(move || loop {
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                let task = tasks.lock().expect("preparation queue lock").recv();
                let Ok((index, input)) = task else { break };
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                let count = active.fetch_add(1, Ordering::Relaxed) + 1;
                peak.fetch_max(count, Ordering::Relaxed);
                let output = catch_unwind(AssertUnwindSafe(|| prepare(input)))
                    .map_err(|_| "目录导入准备线程异常".to_string());
                active.fetch_sub(1, Ordering::Relaxed);
                if results.send((index, output)).is_err() {
                    break;
                }
            }));
        }
        drop(result_tx);
        let pool = PreparationPool {
            tasks: Some(task_tx),
            results: Some(result_rx),
            stopping,
            peak_active,
        };
        let result = coordinate(&pool);
        drop(pool);
        for worker in workers {
            if worker.join().is_err() && result.is_ok() {
                return Err("目录导入准备线程异常".to_string());
            }
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::super::policy::OrderedWindow;
    use super::*;

    #[test]
    fn rolling_pool_prepares_during_commit_and_keeps_input_order() {
        let (released, wait) = mpsc::sync_channel(0);
        let (prepared_next, next_prepared) = mpsc::sync_channel(1);
        let wait = Mutex::new(wait);
        with_preparation_pool(
            2,
            4,
            |n: usize| {
                if n == 0 {
                    wait.lock().unwrap().recv().unwrap();
                }
                if n == 4 {
                    prepared_next.send(()).unwrap();
                }
                n
            },
            |pool| {
                let mut order = OrderedWindow::new(5, 4);
                for _ in 0..4 {
                    let n = order.dispatch().unwrap();
                    pool.dispatch(n, n)?;
                }
                // One slow first item does not impose a wave barrier: the other
                // worker prepares queued items while the head is still blocked.
                for _ in 0..3 {
                    let (n, value) = pool.receive()?;
                    assert_ne!(n, 0);
                    order.complete(n, value);
                }
                assert!(order.pop_next().is_none());
                assert!(order.dispatch().is_none()); // ready + running are bounded
                released.send(()).unwrap();
                let (n, value) = pool.receive()?;
                order.complete(n, value);
                assert_eq!(order.pop_next(), Some((0, 0)));
                let next = order.dispatch().unwrap();
                pool.dispatch(next, next)?;
                // Stand-in for a database commit: no result is consumed while
                // this waits, but preparation must complete independently.
                next_prepared
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                let (n, value) = pool.receive()?;
                assert_eq!(n, 4);
                order.complete(n, value);
                for n in 1..5 {
                    assert_eq!(order.pop_next(), Some((n, n)));
                }
                assert!(order.finished());
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn failed_commit_stops_admission_and_drops_owned_results() {
        let drops = Arc::new(AtomicUsize::new(0));
        struct Owned(Arc<AtomicUsize>);
        impl Drop for Owned {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let result = with_preparation_pool(
            2,
            4,
            |owned: Owned| owned,
            |pool| -> Result<(), String> {
                for n in 0..4 {
                    pool.dispatch(n, Owned(Arc::clone(&drops)))?;
                }
                let (_, first) = pool.receive()?;
                drop(first);
                Err("commit failed".into())
            },
        );
        assert_eq!(result.unwrap_err(), "commit failed");
        assert_eq!(drops.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn worker_panic_returns_an_error_instead_of_waiting_for_missing_head() {
        let result = with_preparation_pool(
            1,
            1,
            |_: ()| -> () { panic!("synthetic") },
            |pool| {
                pool.dispatch(0, ())?;
                pool.receive()
            },
        );
        assert!(result.unwrap_err().contains("准备线程异常"));
    }
}
