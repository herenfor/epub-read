import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const failure = (requestId, code, message, retryable = false) => ({ apiVersion: '1', requestId, ok: false, error: { code, message, retryable } });
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function bodyFor(request, maximum = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Development transport only. One reader provider owns the existing repository;
 * clients never open the database. A packaged host can replace this transport. */
export function installReaderToolDevBridge(server) {
  const enabled = process.env.EPUB_READER_TOOLS === '1';
  const clientToken = randomBytes(32).toString('hex');
  let provider;
  let tail = Promise.resolve();
  let connectionFile;
  const pending = new Map();
  const closeProvider = () => {
    const previous = provider; provider = undefined;
    previous?.response.end();
    for (const call of pending.values()) call.finish(failure(call.requestId, 'READER_DISCONNECTED', '阅读器连接已断开', true));
  };
  server.httpServer?.once('listening', () => {
    if (!enabled) return;
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') return;
    const directory = resolve(server.config.root, '.cache');
    mkdirSync(directory, { recursive: true });
    connectionFile = resolve(directory, `reader-tools-${address.port}.json`);
    writeFileSync(connectionFile, JSON.stringify({ apiVersion: '1', endpoint: `http://127.0.0.1:${address.port}/__reader-tools`,
      token: clientToken, grant: 'read-library', development: true }) + '\n', { mode: 0o600 });
  });
  server.httpServer?.once('close', () => {
    closeProvider();
    if (connectionFile) {
      try { if (JSON.parse(readFileSync(connectionFile, 'utf8')).token === clientToken) unlinkSync(connectionFile); } catch { /* Already removed. */ }
    }
  });
  server.middlewares.use('/__reader-tools', async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const origin = `http://${request.headers.host}`;
    if (!loopback.has(request.socket.remoteAddress) || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '')
      || request.headers.origin && request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
    const path = new URL(request.url ?? '/', origin).pathname;
    if (path === '/status' && request.method === 'GET') { response.end(JSON.stringify({ enabled, connected: Boolean(provider), development: true })); return; }
    if (!enabled) { response.writeHead(404); response.end(JSON.stringify(failure('', 'TOOLS_DISABLED', '本次开发入口未开启阅读工具'))); return; }
    let input;
    try {
      const credential = request.headers.authorization?.replace(/^Bearer /, '');
      if (path === '/provider/connect' && request.method === 'POST') {
        // A non-simple same-origin request is necessary to enroll a provider.
        if (request.headers.origin !== origin || request.headers['x-reader-provider'] !== '1') { response.writeHead(403); response.end(); return; }
        input = await bodyFor(request);
        if (!Array.isArray(input.definitions)) throw new Error('Missing tools');
        if (provider) { response.writeHead(409); response.end(); return; }
        const owner = { token: randomBytes(32).toString('hex'), response, definitions: input.definitions };
        provider = owner;
        response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); response.flushHeaders();
        response.write(JSON.stringify({ type: 'ready', token: owner.token }) + '\n');
        response.once('close', () => { if (provider === owner) closeProvider(); });
        return;
      }
      if (path === '/provider/reply' && request.method === 'POST') {
        if (!provider || !same(credential, provider.token)) { response.writeHead(403); response.end(); return; }
        input = await bodyFor(request, 4 * 1024 * 1024);
        const call = pending.get(input.id);
        if (call) call.finish(input.reply);
        response.writeHead(204); response.end(); return;
      }
      if (!same(credential, clientToken)) { response.writeHead(403); response.end(JSON.stringify(failure('', 'ACCESS_DENIED', '缺少本机阅读工具凭据'))); return; }
      if (!provider) { response.writeHead(503); response.end(JSON.stringify(failure('', 'READER_NOT_READY', '请保持AI开发窗口打开并等待书库就绪', true))); return; }
      if (path === '/tools' && request.method === 'GET') {
        response.end(JSON.stringify({ apiVersion: '1', ok: true, data: { tools: provider.definitions,
          grant: 'read-library', development: true } })); return;
      }
      if (path !== '/call' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      input = await bodyFor(request);
      if (typeof input.requestId !== 'string' || typeof input.name !== 'string' || !input.arguments || Array.isArray(input.arguments)
        || typeof input.arguments !== 'object') throw new Error('Invalid call');
      const controller = new AbortController();
      const admittedProvider = provider;
      response.once('close', () => controller.abort());
      const execute = () => new Promise(resolveReply => {
        if (controller.signal.aborted) { resolveReply(); return; }
        if (!provider || provider !== admittedProvider) { response.end(JSON.stringify(failure(input.requestId, 'READER_DISCONNECTED', '原阅读器连接已断开，请重新调用', true))); resolveReply(); return; }
        const id = randomUUID();
        const owner = provider;
        let delivered = false;
        const cancel = (code, message) => {
          if (delivered) return;
          delivered = true; clearTimeout(timer);
          controller.signal.removeEventListener('abort', abort);
          if (provider === owner) owner.response.write(JSON.stringify({ type: 'cancel', id }) + '\n');
          if (!response.destroyed) response.end(JSON.stringify(failure(input.requestId, code, message, code === 'TIMEOUT')));
          // Keep the queue slot until the provider confirms resource teardown.
          // A cancelled client is not evidence that its archive has closed.
        };
        const abort = () => cancel('CANCELLED', '调用已取消');
        const timer = setTimeout(() => cancel('TIMEOUT', '本次阅读工具调用超时'), 120000);
        const finish = reply => {
          if (!pending.delete(id)) return;
          clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
          if (!delivered && !response.destroyed) response.end(JSON.stringify(reply));
          resolveReply();
        };
        pending.set(id, { requestId: input.requestId, finish });
        controller.signal.addEventListener('abort', abort, { once: true });
        owner.response.write(JSON.stringify({ type: 'call', id, request: input }) + '\n');
      });
      // One archive operation at a time, shared across clients. No full-book
      // resource multiplication when several agents query the same host.
      const done = tail.then(execute, execute); tail = done.catch(() => {});
      await done;
    } catch {
      response.writeHead(400); response.end(JSON.stringify(failure(input?.requestId ?? '', 'INVALID_REQUEST', '调用格式不正确或请求过大')));
    }
  });
}
