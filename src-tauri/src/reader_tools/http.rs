//! One bounded JSON request per loopback connection. No CORS, streaming files or arbitrary RPC.
use super::host::{failure, Host};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};

pub(super) async fn serve(listener: std::net::TcpListener, host: Arc<Host>) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        host.stop();
        return;
    };
    let mut stopped = host.stopped.subscribe();
    loop {
        tokio::select! {
            _ = stopped.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { break };
                if !peer.ip().is_loopback() { continue; }
                let Ok(permit) = host.connections.clone().try_acquire_owned() else { continue };
                let host = host.clone();
                tauri::async_runtime::spawn(async move { let _permit = permit; let _ = handle(stream, host).await; });
            }
        }
    }
    host.stop();
}

struct Request {
    path: String,
    authorization: String,
    body: Value,
}
async fn read_request(stream: &mut TcpStream) -> Result<Request, ()> {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        if bytes.len() >= 16 * 1024 {
            return Err(());
        }
        let mut buffer = [0u8; 2048];
        let count = stream.read(&mut buffer).await.map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|_| ())?;
    let mut lines = headers.split("\r\n");
    let line = lines.next().ok_or(())?;
    let parts: Vec<_> = line.split(' ').collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" {
        return Err(());
    }
    let path = match (parts[0], parts[1]) {
        ("GET", "/tools") => "/tools",
        ("GET", "/status") => "/status",
        ("POST", "/call") => "/call",
        _ => return Err(()),
    }
    .to_string();
    let mut authorization = None;
    let mut host_header = None;
    let mut length = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(())?;
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "authorization" => {
                if authorization.replace(value.to_owned()).is_some() {
                    return Err(());
                }
            }
            "host" => {
                if host_header.replace(value.to_owned()).is_some() {
                    return Err(());
                }
            }
            "content-length" => {
                if length
                    .replace(value.parse::<usize>().map_err(|_| ())?)
                    .is_some()
                {
                    return Err(());
                }
            }
            "origin" | "transfer-encoding" => return Err(()),
            _ => {}
        }
    }
    let host = host_header.ok_or(())?;
    let port = stream.local_addr().map_err(|_| ())?.port();
    if host != format!("127.0.0.1:{port}") {
        return Err(());
    }
    let size = length.unwrap_or(0);
    if size > 64 * 1024 || (path == "/call" && size == 0) || (path != "/call" && size != 0) {
        return Err(());
    }
    let total = header_end + size;
    if bytes.len() > total {
        return Err(());
    }
    let received = bytes.len();
    bytes.resize(total, 0);
    stream
        .read_exact(&mut bytes[received..])
        .await
        .map_err(|_| ())?;
    let body = if size == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..]).map_err(|_| ())?
    };
    Ok(Request {
        path,
        authorization: authorization.unwrap_or_default(),
        body,
    })
}

async fn respond(stream: &mut TcpStream, status: u16, body: Value) -> Result<(), ()> {
    let bytes = serde_json::to_vec(&body).map_err(|_| ())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(());
    }
    let header = format!("HTTP/1.1 {status} Reply\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nCross-Origin-Resource-Policy: same-origin\r\n\r\n", bytes.len());
    timeout(Duration::from_secs(10), async {
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(&bytes).await?;
        stream.shutdown().await
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn handle(mut stream: TcpStream, host: Arc<Host>) -> Result<(), ()> {
    let request = match timeout(Duration::from_secs(10), read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        _ => {
            return respond(
                &mut stream,
                400,
                failure("", "INVALID_REQUEST", "调用格式不正确或请求过大", false),
            )
            .await
        }
    };
    let credential = request.authorization.strip_prefix("Bearer ").unwrap_or("");
    let client = match host
        .clients
        .iter()
        .find(|client| credential.as_bytes().ct_eq(client.token.as_bytes()).into())
    {
        Some(client) => client,
        None => {
            return respond(
                &mut stream,
                403,
                failure("", "ACCESS_DENIED", "缺少本机阅读工具凭据", false),
            )
            .await
        }
    };
    let owner = host.provider_id();
    if request.path == "/status" {
        return respond(&mut stream, 200, json!({"apiVersion":"1", "ok":true, "data":{"ready":owner.is_some(),"serviceInstance":host.instance,"grant":client.grant}})).await;
    }
    let Some(owner) = owner else {
        return respond(
            &mut stream,
            503,
            failure("", "READER_NOT_READY", "请等待AI应用书库就绪", true),
        )
        .await;
    };
    if request.path == "/tools" {
        return respond(&mut stream, 200, json!({"apiVersion":"1", "ok":true, "data":{"tools":host.tools(&client.grant),"grant":client.grant,"development":true}})).await;
    }
    let input = request.body;
    let request_id = input["requestId"].as_str().unwrap_or("");
    if request_id.is_empty()
        || request_id.len() > 128
        || !input["name"].is_string()
        || !input["arguments"].is_object()
    {
        return respond(
            &mut stream,
            400,
            failure(request_id, "INVALID_REQUEST", "调用格式不正确", false),
        )
        .await;
    }
    let mut probe = [0u8; 1];
    let mut stopped = host.stopped.subscribe();
    let permit = tokio::select! {
        permit = host.serial.acquire() => permit.map_err(|_| ())?,
        _ = stream.read(&mut probe) => return Ok(()),
        _ = stopped.changed() => return Ok(()),
        _ = tokio::time::sleep(Duration::from_secs(120)) => return respond(&mut stream, 503, failure(request_id, "BUSY", "阅读工具队列繁忙，请稍后重试", true)).await,
    };
    let (id, mut reply) = match host.dispatch(&owner, input.clone(), &client.grant) {
        Ok(call) => call,
        Err(error) => return respond(&mut stream, 200, error).await,
    };
    tokio::select! {
        reply = &mut reply => {
            respond(&mut stream, 200, reply.unwrap_or_else(|_| failure(request_id, "READER_DISCONNECTED", "阅读工具提供方已断开", true))).await?;
        }
        _ = stopped.changed() => return Ok(()),
        _ = stream.read(&mut probe) => {
            host.cancel(&owner, &id);
            let _ = reply.await; // Archive/staging teardown acknowledgement owns the serial slot.
        }
        _ = tokio::time::sleep(Duration::from_secs(120)) => {
            host.cancel(&owner, &id);
            let _ = respond(&mut stream, 200, failure(request_id, "TIMEOUT", "本次阅读工具调用超时", true)).await;
            let _ = reply.await;
        }
    }
    drop(permit);
    Ok(())
}
