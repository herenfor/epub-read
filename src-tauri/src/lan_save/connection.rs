use super::error::LanSaveError;
use super::protocol::{
    read_control_message, write_control_message, ControlMessage, COPY_BUFFER_BYTES,
};
use super::session::LanSession;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Notify;

pub(crate) enum LanIo {
    Client(tokio_rustls::client::TlsStream<TcpStream>),
    Server(tokio_rustls::server::TlsStream<TcpStream>),
}

impl AsyncRead for LanIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match &mut *self {
            LanIo::Client(stream) => Pin::new(stream).poll_read(cx, buffer),
            LanIo::Server(stream) => Pin::new(stream).poll_read(cx, buffer),
        }
    }
}

impl AsyncWrite for LanIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match &mut *self {
            LanIo::Client(stream) => Pin::new(stream).poll_write(cx, buffer),
            LanIo::Server(stream) => Pin::new(stream).poll_write(cx, buffer),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            LanIo::Client(stream) => Pin::new(stream).poll_flush(cx),
            LanIo::Server(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            LanIo::Client(stream) => Pin::new(stream).poll_shutdown(cx),
            LanIo::Server(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

pub(crate) struct LanConnection {
    reader: tokio::sync::Mutex<Option<ReadHalf<LanIo>>>,
    writer: tokio::sync::Mutex<Option<WriteHalf<LanIo>>>,
    stopped: AtomicBool,
    notify: Notify,
}

impl LanConnection {
    pub(crate) fn new(io: LanIo) -> Self {
        let (reader, writer) = tokio::io::split(io);
        Self {
            reader: tokio::sync::Mutex::new(Some(reader)),
            writer: tokio::sync::Mutex::new(Some(writer)),
            stopped: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    async fn wait_stopped(&self) {
        loop {
            if self.is_stopped() {
                return;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_stopped() {
                return;
            }
            notified.await;
        }
    }

    pub(crate) async fn read_control(&self) -> Result<ControlMessage, LanSaveError> {
        if self.is_stopped() {
            return Err(LanSaveError::cancelled());
        }
        let mut guard = self.reader.lock().await;
        let reader = guard
            .as_mut()
            .ok_or_else(|| LanSaveError::network("TLS 读取端已关闭"))?;
        tokio::select! {
            result = read_control_message(reader) => result,
            _ = self.wait_stopped() => Err(LanSaveError::cancelled()),
        }
    }

    pub(crate) async fn write_control(&self, message: &ControlMessage) -> Result<(), LanSaveError> {
        if self.is_stopped() {
            return Err(LanSaveError::cancelled());
        }
        let mut guard = self.writer.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| LanSaveError::network("TLS 写入端已关闭"))?;
        tokio::select! {
            result = write_control_message(writer, message) => result,
            _ = self.wait_stopped() => Err(LanSaveError::cancelled()),
        }
    }

    pub(crate) async fn send_archive_from_path(
        &self,
        path: &Path,
        total: u64,
        session: &Arc<LanSession>,
    ) -> Result<(), LanSaveError> {
        let mut source = File::open(path)?;
        let mut guard = self.writer.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| LanSaveError::network("TLS 写入端已关闭"))?;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        let mut sent = 0_u64;
        let mut last_report = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(100))
            .unwrap_or_else(std::time::Instant::now);
        loop {
            if self.is_stopped() {
                return Err(LanSaveError::cancelled());
            }
            let read = source.read(&mut buffer).map_err(|error| {
                LanSaveError::storage(format!("读取待发送存档失败：{error}"))
            })?;
            if read == 0 {
                break;
            }
            if (read as u64) > total.saturating_sub(sent) {
                return Err(LanSaveError::invalid_data(
                    "发送存档超过 Offer 声明长度",
                ));
            }
            tokio::select! {
                result = writer.write_all(&buffer[..read]) => {
                    result.map_err(|error| LanSaveError::network(format!("发送存档失败：{error}")))?;
                }
                _ = self.wait_stopped() => return Err(LanSaveError::cancelled()),
            }
            sent = sent.saturating_add(read as u64);
            if last_report.elapsed() >= std::time::Duration::from_millis(100) {
                session.emit_progress("sending", sent, Some(total));
                last_report = std::time::Instant::now();
            }
        }
        if sent != total {
            return Err(LanSaveError::invalid_data(format!(
                "发送存档长度 {sent} 与 Offer {total} 不一致"
            )));
        }
        // tokio-rustls keeps an internal buffer; a successful write loop alone
        // does not mean the peer has received the archive.
        tokio::select! {
            result = writer.flush() => {
                result.map_err(|error| LanSaveError::network(format!("刷新存档流失败：{error}")))?;
            }
            _ = self.wait_stopped() => return Err(LanSaveError::cancelled()),
        }
        session.emit_progress("sending", sent, Some(total));
        Ok(())
    }

    pub(crate) async fn receive_archive_to_path(
        &self,
        path: &Path,
        total: u64,
        session: &Arc<LanSession>,
    ) -> Result<(), LanSaveError> {
        let mut file = File::create(path)?;
        let mut guard = self.reader.lock().await;
        let reader = guard
            .as_mut()
            .ok_or_else(|| LanSaveError::network("TLS 读取端已关闭"))?;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        let mut received = 0_u64;
        let mut last_report = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(100))
            .unwrap_or_else(std::time::Instant::now);
        while received < total {
            if self.is_stopped() {
                return Err(LanSaveError::cancelled());
            }
            let remaining = total - received;
            let limit = buffer.len().min(remaining as usize);
            let read = tokio::select! {
                result = tokio::io::AsyncReadExt::read(reader, &mut buffer[..limit]) => {
                    result.map_err(|error| LanSaveError::network(format!("接收存档失败：{error}")))?
                }
                _ = self.wait_stopped() => return Err(LanSaveError::cancelled()),
            };
            if read == 0 {
                return Err(LanSaveError::invalid_data(format!(
                    "存档流提前 EOF：已收到 {received}/{total} 字节"
                )));
            }
            file.write_all(&buffer[..read]).map_err(|error| {
                LanSaveError::storage(format!("写入接收临时文件失败：{error}"))
            })?;
            received = received.saturating_add(read as u64);
            if last_report.elapsed() >= std::time::Duration::from_millis(100) {
                session.emit_progress("receiving", received, Some(total));
                last_report = std::time::Instant::now();
            }
        }
        file.sync_all()
            .map_err(|error| LanSaveError::storage(format!("同步接收临时文件失败：{error}")))?;
        session.emit_progress("receiving", received, Some(total));
        Ok(())
    }
}
