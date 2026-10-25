import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createReaderToolService } from '../../src/features/ai/reader-tools/service.ts';
import { runReaderCli } from '../../scripts/reader-cli.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'reader-adapter-'));
  const connectionFile = join(dir, 'connection.json');
  const state = { token: 'test-only-credential', ready: false, legacyOversize: false };
  const book = { bookId: 'allowed', contentHash: 'hash', title: 'Fixture', creator: '', available: true, favorite: false, folderId: null };
  const passage = { bookId: book.bookId, contentHash: book.contentHash, chapterId: 'chapter', spineIndex: 0,
    chunkId: 'chunk', corpusVersion: 'fixture-v1', originalText: '目标原文🙂'.repeat(130), anchor: { start: 0, end: 780, snippet: '目标原文' } };
  let started; let drained;
  const slowStarted = new Promise(resolve => { started = resolve; });
  const slowDrained = new Promise(resolve => { drained = resolve; });
  const service = createReaderToolService({
    list: async () => [book, { ...book, bookId: 'hidden' }],
    chapters: async () => [{ chapterId: 'chapter', title: 'Fixture chapter', spineIndex: 0 }],
    async read(_id, chapter, signal) {
      if (chapter !== 'slow') return [passage];
      started();
      try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
      finally { drained(); }
    },
    search: async () => ({ items: [passage], truncated: false, scannedChapters: 1 }),
    searchLibrary: async () => ({ items: [{ ...passage, title: book.title, creator: '' }], candidateLimitReached: false,
      coverage: { scopeBooks: 1, indexedBooks: 1, missingIndexBooks: 0, outdatedIndexBooks: 0, unavailableBooks: 0, complete: true } }),
    indexStatus: async () => [{ bookId: book.bookId, state: 'current', chunkCount: 1 }],
  }, { clientId: 'test', bookIds: ['allowed'], prepareIndex: false });
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(403); res.end(JSON.stringify({ apiVersion: '1', ok: false, error: { code: 'ACCESS_DENIED' } })); return; }
    const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let reply;
    if (!state.ready) reply = { apiVersion: '1', ok: false, error: { code: 'READER_NOT_READY', message: 'Not ready', retryable: true } };
    else if (req.url === '/tools') reply = { apiVersion: '1', ok: true, data: { tools: service.definitions } };
    else {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      reply = state.legacyOversize ? { apiVersion: '1', requestId: input.requestId, ok: true, data: { originalText: 'x'.repeat(100000) } }
        : await service.call(input, controller.signal);
    }
    if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function save() { await writeFile(connectionFile, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: state.token })); }
  await save();
  return { state, connectionFile, passage, slowStarted, slowDrained, save,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); } };
}

test('official MCP client discovers and calls reader tools over stdio with sources, errors, budgets and cancellation', { timeout: 15000 }, async () => {
  const f = await fixture();
  const client = new Client({ name: 'reader-adapter-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, EPUB_READER_CONNECTION_FILE: f.connectionFile, EPUB_READER_MCP_MAX_BYTES: '8192' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['reader_connection_status', 'reader_refresh_tools']);
    f.state.ready = true;
    await client.callTool({ name: 'reader_refresh_tools', arguments: {} });
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 9);
    assert.equal(tools.some(t => t.name === 'reader_prepare_index'), false);
    const books = await client.callTool({ name: 'reader_find_books', arguments: {} });
    assert.deepEqual(books.structuredContent.data.items.map(b => b.bookId), ['allowed']);
    assert.equal(books.content[0].text, JSON.stringify(books.structuredContent));
    const invalid = await client.callTool({ name: 'reader_find_books', arguments: { limit: 0 } });
    assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENTS');
    const hit = await client.callTool({ name: 'reader_search_library', arguments: { queries: ['目标'] } });
    const source = hit.structuredContent.data.items[0];
    const read = await client.callTool({ name: 'reader_read_passages', arguments: { bookId: source.bookId, chapterId: source.chapterId, aroundChunkId: source.chunkId, limit: 1 } });
    // This small preset cannot fit the entire passage. Refuse, never shorten it.
    assert.equal(read.isError, true); assert.equal(read.structuredContent.error.code, 'RESPONSE_BUDGET_EXCEEDED');
    const denied = await client.callTool({ name: 'reader_get_book', arguments: { bookId: 'hidden' } });
    assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'BOOK_NOT_FOUND');
    const controller = new AbortController();
    const slow = client.callTool({ name: 'reader_read_passages', arguments: { bookId: 'allowed', chapterId: 'slow' } }, undefined, { signal: controller.signal });
    await f.slowStarted; controller.abort();
    await assert.rejects(slow); await f.slowDrained;
    f.state.token = 'rotated-test-credential'; await f.save();
    const resumed = await client.callTool({ name: 'reader_get_book', arguments: { bookId: 'allowed' } });
    assert.equal(resumed.isError, false); assert.equal(resumed.structuredContent.data.bookId, 'allowed');
    f.state.legacyOversize = true;
    const oversized = await client.callTool({ name: 'reader_get_book', arguments: { bookId: 'allowed' } });
    assert.equal(oversized.isError, true); assert.equal(oversized.structuredContent.error.code, 'RESPONSE_BUDGET_EXCEEDED');
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 8192);
  } finally { await client.close(); await f.close(); }
});

test('CLI rejects oversized legacy replies and preserves structured failures through the shared transport', { timeout: 5000 }, async () => {
  const f = await fixture(); f.state.ready = true;
  const args = ['--connection-file', f.connectionFile];
  try {
    const invalid = await runReaderCli([...args, 'books', 'find', '--max-response-bytes', 'NaN']);
    assert.equal(invalid.exitCode, 2);
    const read = await runReaderCli([...args, 'text', 'read', '--book', 'allowed', '--chapter', 'chapter', '--max-response-bytes', '8192']);
    assert.deepEqual(read.result.data.items[0], f.passage);
    const denied = await runReaderCli([...args, 'book', 'get', '--book', 'hidden']);
    assert.equal(denied.exitCode, 1); assert.equal(denied.result.error.code, 'BOOK_NOT_FOUND');
    f.state.legacyOversize = true;
    const oversized = await runReaderCli([...args, 'book', 'get', '--book', 'allowed', '--max-response-bytes', '1024']);
    assert.equal(oversized.exitCode, 1); assert.equal(oversized.result.error.code, 'RESPONSE_BUDGET_EXCEEDED');
    f.state.legacyOversize = false;
    const stdin = Readable.from([Buffer.from(JSON.stringify({ bookId: 'allowed' }))]);
    const input = await runReaderCli([...args, 'call', 'reader_get_book', '--input-file', '-'], { stdin });
    assert.equal(input.exitCode, 0);
  } finally { await f.close(); }
});
