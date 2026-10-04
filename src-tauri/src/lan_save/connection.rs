use super::error::LanSaveError;
use super::protocol::{
    read_control_message, write_control_message, ControlMessage, COPY_BUFFER_BYTES,
};
use super::session::LanSession;
use tokio::fs::File;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Notify;

const FLOW_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

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

    /// Drop both TLS halves after all workers have drained. This is the only
    /// place that releases the split halves; `stop` only wakes blocked I/O.
    pub(crate) async fn close_halves(&self) {
        self.reader.lock().await.take();
        self.writer.lock().await.take();
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
            result = tokio::time::timeout(FLOW_IDLE, read_control_message(reader)) => {
                match result {
                    Ok(result) => result,
                    Err(_) => Err(LanSaveError::new("timeout", "控制帧读取空闲超过 30 秒")),
                }
            },
            _ = self.wait_stopped() => Err(LanSaveError::cancelled()),
        }
    }

    /// Cancel-safe control read with a caller-owned frame buffer. A single
    /// pending `read` future never consumes bytes when it is dropped, so a
    /// select with local actions cannot eat half a frame.
    pub(crate) async fn read_control_buffered(
        &self,
        buffer: &mut Vec<u8>,
        idle_timeout: std::time::Duration,
    ) -> Result<ControlMessage, LanSaveError> {
        if self.is_stopped() {
            return Err(LanSaveError::cancelled());
        }
        let mut guard = self.reader.lock().await;
        let reader = guard
            .as_mut()
            .ok_or_else(|| LanSaveError::network("TLS 读取端已关闭"))?;
        loop {
            if buffer.len() >= 4 {
                let length = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
                if length > super::protocol::CONTROL_MAX_BYTES {
                    return Err(LanSaveError::protocol("控制帧超过 64KiB"));
                }
                let total = 4 + length;
                if buffer.len() >= total {
                    let payload = buffer[4..total].to_vec();
                    buffer.drain(..total);
                    return serde_json::from_slice(&payload).map_err(|error| {
                        LanSaveError::protocol(format!("控制帧 JSON 无法解析：{error}"))
                    });
                }
            }
            let mut chunk = [0_u8; 4096];
            let read = tokio::select! {
                result = tokio::time::timeout(
                    idle_timeout,
                    tokio::io::AsyncReadExt::read(reader, &mut chunk),
                ) => {
                    match result {
                        Ok(Ok(read)) => read,
                        Ok(Err(error)) => return Err(LanSaveError::network(format!("读取控制帧失败：{error}"))),
                        Err(_) => return Err(LanSaveError::new("timeout", "控制帧读取空闲超时")),
                    }
                }
                _ = self.wait_stopped() => return Err(LanSaveError::cancelled()),
            };
            if read == 0 {
                return Err(LanSaveError::network("控制连接 EOF"));
            }
            buffer.extend_from_slice(&chunk[..read]);
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
            result = tokio::time::timeout(FLOW_IDLE, write_control_message(writer, message)) => {
                match result {
                    Ok(result) => result,
                    Err(_) => Err(LanSaveError::new("timeout", "控制帧写入空闲超过 30 秒")),
                }
            },
            _ = self.wait_stopped() => Err(LanSaveError::cancelled()),
        }
    }

    pub(crate) async fn send_archive_from_path(
        &self,
        path: &Path,
        total: u64,
        session: &Arc<LanSession>,
    ) -> Result<(), LanSaveError> {
        let mut source = File::open(path).await?;
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
            let read = tokio::io::AsyncReadExt::read(&mut source, &mut buffer)
                .await
                .map_err(|error| LanSaveError::storage(format!("读取待发送存档失败：{error}")))?;
            if read == 0 {
                break;
            }
            if (read as u64) > total.saturating_sub(sent) {
                return Err(LanSaveError::invalid_data(
                    "发送存档超过 Offer 声明长度",
                ));
            }
            tokio::select! {
                result = tokio::time::timeout(FLOW_IDLE, writer.write_all(&buffer[..read])) => {
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => return Err(LanSaveError::network(format!("发送存档失败：{error}"))),
                        Err(_) => return Err(LanSaveError::new("timeout", "ZIP 写入空闲超过 30 秒")),
                    }
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
            result = tokio::time::timeout(FLOW_IDLE, writer.flush()) => {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => return Err(LanSaveError::network(format!("刷新存档流失败：{error}"))),
                    Err(_) => return Err(LanSaveError::new("timeout", "ZIP 刷新空闲超过 30 秒")),
                }
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
        let mut file = File::create(path).await?;
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
            let limit = remaining.min(buffer.len() as u64) as usize;
            let read = tokio::select! {
                result = tokio::time::timeout(
                    FLOW_IDLE,
                    tokio::io::AsyncReadExt::read(reader, &mut buffer[..limit]),
                ) => {
                    match result {
                        Ok(Ok(read)) => read,
                        Ok(Err(error)) => return Err(LanSaveError::network(format!("接收存档失败：{error}"))),
                        Err(_) => return Err(LanSaveError::new("timeout", "ZIP 读取空闲超过 30 秒")),
                    }
                }
                _ = self.wait_stopped() => return Err(LanSaveError::cancelled()),
            };
            if read == 0 {
                return Err(LanSaveError::invalid_data(format!(
                    "存档流提前 EOF：已收到 {received}/{total} 字节"
                )));
            }
            file.write_all(&buffer[..read])
                .await
                .map_err(|error| LanSaveError::storage(format!("写入接收临时文件失败：{error}")))?;
            received = received.saturating_add(read as u64);
            if last_report.elapsed() >= std::time::Duration::from_millis(100) {
                session.emit_progress("receiving", received, Some(total));
                last_report = std::time::Instant::now();
            }
        }
        file.sync_all()
            .await
            .map_err(|error| LanSaveError::storage(format!("同步接收临时文件失败：{error}")))?;
        session.emit_progress("receiving", received, Some(total));
        Ok(())
    }
}
