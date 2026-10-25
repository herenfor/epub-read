import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installReaderToolDevBridge } from './reader-tool-dev-bridge.mjs';

test('cancelled clients do not release the archive queue before the provider drains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-tools-'));
  const previous = process.env.EPUB_READER_TOOLS; process.env.EPUB_READER_TOOLS = '1';
  let handle;
  const server = http.createServer((req, res) => { req.url = req.url.slice('/__reader-tools'.length); void handle(req, res); });
  installReaderToolDevBridge({ config: { root }, httpServer: server, middlewares: { use: (_path, callback) => { handle = callback; } } });
  if (previous === undefined) delete process.env.EPUB_READER_TOOLS; else process.env.EPUB_READER_TOOLS = previous;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const connection = JSON.parse(await readFile(join(root, '.cache', `reader-tools-${port}.json`), 'utf8'));
  const endpoint = connection.endpoint;
  const providerAbort = new AbortController();
  let reader;
  try {
    const response = await fetch(`${endpoint}/provider/connect`, { method: 'POST', signal: providerAbort.signal,
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-Reader-Provider': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ definitions: [] }) });
    reader = response.body.getReader();
    let buffer = ''; const decode = new TextDecoder();
    async function frame() {
      while (!buffer.includes('\n')) { const part = await reader.read(); if (part.done) throw new Error('Closed'); buffer += decode.decode(part.value); }
      const at = buffer.indexOf('\n'); const value = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); return value;
    }
    const ready = await frame();
    const clientHeaders = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const firstAbort = new AbortController();
    const call = (id, signal) => fetch(`${endpoint}/call`, { method: 'POST', headers: clientHeaders, signal,
      body: JSON.stringify({ requestId: id, name: 'reader_find_books', arguments: {} }) }).then(r => r.json());
    const first = call('first', firstAbort.signal).catch(() => undefined);
    const active = await frame(); assert.equal(active.request.requestId, 'first');
    firstAbort.abort(); await first;
    assert.deepEqual(await frame(), { type: 'cancel', id: active.id });
    const second = call('second');
    const nextFrame = frame();
    const eventBeforeDrain = await Promise.race([nextFrame.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30))]);
    assert.equal(eventBeforeDrain, false);
    async function reply(id, result) { await fetch(`${endpoint}/provider/reply`, { method: 'POST',
      headers: { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, reply: result }) }); }
    await reply(active.id, { apiVersion: '1', requestId: 'first', ok: false, error: { code: 'CANCELLED' } });
    const next = await nextFrame; assert.equal(next.request.requestId, 'second');
    await reply(next.id, { apiVersion: '1', requestId: 'second', ok: true, data: [] });
    assert.equal((await second).ok, true);
  } finally {
    providerAbort.abort(); await reader?.cancel().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
