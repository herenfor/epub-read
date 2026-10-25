import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class ReaderClientError extends Error {
  constructor(code, message, retryable = false) {
    super(message); this.name = 'ReaderClientError'; this.code = code; this.retryable = retryable;
  }
}
export const readerFailure = (code, message, retryable = false, requestId = '') =>
  ({ apiVersion: '1', requestId, ok: false, error: { code, message, retryable } });

export function readerConnectionFile(client = 'local') {
  return process.env.EPUB_READER_CONNECTION_FILE ?? (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'dev.epubreader.ai', 'reader-tools', `${client}.json`) : undefined);
}

/** Shared Node transport only. No model, conversation, SDK or framework imports. */
export function createReaderClient(connectionFile, { maxResponseBytes = 32768, timeoutMs = 125000 } = {}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 4 * 1024 * 1024)
    throw new ReaderClientError('INVALID_ARGUMENTS', 'Invalid reader response byte budget');
  return async function call(path, input, signal) {
    if (signal?.aborted) throw new ReaderClientError('CANCELLED', 'Reader call cancelled');
    if (!connectionFile) throw new ReaderClientError('CONNECTION_REQUIRED', 'Configure a local reader connection file');
    let connection;
    try { connection = JSON.parse(await readFile(connectionFile, 'utf8')); }
    catch { throw new ReaderClientError('CONNECTION_UNAVAILABLE', 'Start the AI reader service and refresh its tools', true); }
    let endpoint;
    try { endpoint = new URL(connection.endpoint); }
    catch { throw new ReaderClientError('INVALID_CONNECTION', 'Invalid local reader connection'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || typeof connection.token !== 'string' || !connection.token
      || !['/tools', '/call', '/status'].includes(path))
      throw new ReaderClientError('INVALID_CONNECTION', 'Expected an authenticated IPv4 loopback reader endpoint');
    // Development endpoints can have a path prefix; native endpoints have none.
    const url = new URL(connection.endpoint.replace(/\/$/, '') + path);
    const id = input?.requestId ?? randomUUID();
    const envelope = input ? { ...input, requestId: id, maxResponseBytes } : undefined;
    const body = envelope ? JSON.stringify(envelope) : undefined;
    if (body && Buffer.byteLength(body) > 65536) throw new ReaderClientError('INVALID_ARGUMENTS', 'Reader request exceeds 64 KiB');
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => { clearTimeout(timer); reject(error); };
      // Native HTTP deliberately bypasses ambient fetch proxies. Credentials are
      // re-read for every call so app restarts do not require prompt/config edits.
      const req = request(url, { method: body ? 'POST' : 'GET', signal,
        headers: { Authorization: `Bearer ${connection.token}`, ...(body ? {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        } : {}) } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            const error = new ReaderClientError('RESPONSE_BUDGET_EXCEEDED', 'Reader reply exceeds the byte budget; request fewer items or increase the configured budget');
            finish(error); res.destroy(); req.destroy();
          } else chunks.push(chunk);
        });
        res.once('error', () => finish(new ReaderClientError('READER_DISCONNECTED', 'Reader response was interrupted', true)));
        res.once('end', () => {
          clearTimeout(timer);
          let reply;
          try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(new ReaderClientError('INVALID_RESPONSE', 'Reader returned invalid JSON', true)); return; }
          if ([401, 403].includes(res.statusCode)) {
            finish(new ReaderClientError('ACCESS_DENIED', 'Reader authorization was refused; check the local client grant')); return;
          }
          if (reply?.apiVersion !== '1' || typeof reply.ok !== 'boolean'
            || (body && reply.requestId !== id)
            || (reply.ok ? !reply.data || typeof reply.data !== 'object'
              : typeof reply.error?.code !== 'string' || typeof reply.error.message !== 'string' || typeof reply.error.retryable !== 'boolean')) {
            finish(new ReaderClientError('INVALID_RESPONSE', 'Reader reply does not match API version 1', true)); return;
          }
          if (res.statusCode !== 200 && reply.ok) {
            finish(new ReaderClientError('READER_UNAVAILABLE', 'Reader host refused the request', true)); return;
          }
          resolve(reply);
        });
      });
      timer = setTimeout(() => {
        finish(new ReaderClientError('TIMEOUT', 'Reader call timed out', true)); req.destroy();
      }, timeoutMs);
      req.once('error', () => finish(new ReaderClientError(signal?.aborted ? 'CANCELLED' : 'APP_NOT_RUNNING',
        signal?.aborted ? 'Reader call cancelled' : 'The local AI reader host is not reachable', !signal?.aborted)));
      req.end(body);
    });
  };
}
