import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installReaderToolDevBridge } from './reader-tool-dev-bridge.mjs';
import { runReaderCli } from './reader-cli.mjs';
import { createReaderToolService } from '../src/features/ai/reader-tools/service.ts';

test('CLI discovery and bounded library search traverse the real authenticated development transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-library-flow-'));
  const previous = process.env.EPUB_READER_TOOLS;
  process.env.EPUB_READER_TOOLS = '1';
  let handle;
  const server = http.createServer((req, res) => { req.url = req.url.slice('/__reader-tools'.length); void handle(req, res); });
  installReaderToolDevBridge({ config: { root }, httpServer: server, middlewares: { use: (_path, callback) => { handle = callback; } } });
  if (previous === undefined) delete process.env.EPUB_READER_TOOLS; else process.env.EPUB_READER_TOOLS = previous;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const file = join(root, '.cache', `reader-tools-${port}.json`);
  const { endpoint } = JSON.parse(await readFile(file, 'utf8'));
  let requestSeen;
  let scopeSeen;
  const service = createReaderToolService({
    list: async () => ['allowed', 'hidden'].map(bookId => ({ bookId, title: bookId, creator: '', available: true, favorite: false, folderId: null })),
    chapters: async () => [], read: async () => { throw new Error('Must not reopen EPUB'); },
    search: async () => { throw new Error('Must not scan EPUB'); },
    searchLibrary: async (books, queries) => {
      scopeSeen = books.map(book => book.bookId);
      return { coverage: { scopeBooks: 1, indexedBooks: 1, missingIndexBooks: 0, outdatedIndexBooks: 0, unavailableBooks: 0, complete: true },
        candidateLimitReached: false, items: [{ bookId: 'allowed', contentHash: 'source', title: 'fixture', creator: '',
          chapterId: 'c.xhtml', spineIndex: 0, chunkId: 'source-chunk', corpusVersion: 'fixture-v1',
          originalText: queries[0] + '原文'.repeat(300), anchor: { start: 0, end: 602, snippet: '线索原文' } }] };
    },
  }, { clientId: 'fixture', bookIds: ['allowed'], prepareIndex: false });
  const stop = new AbortController();
  let reader; let loop;
  try {
    const response = await fetch(`${endpoint}/provider/connect`, { method: 'POST', signal: stop.signal,
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-Reader-Provider': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ definitions: service.definitions }) });
    reader = response.body.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    async function frame() {
      while (!buffer.includes('\n')) { const part = await reader.read(); if (part.done) return; buffer += decoder.decode(part.value); }
      const at = buffer.indexOf('\n'); const event = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); return event;
    }
    const ready = await frame();
    loop = (async () => {
      const event = await frame();
      requestSeen = event.request;
      const reply = await service.call(event.request, new AbortController().signal);
      await fetch(`${endpoint}/provider/reply`, { method: 'POST', headers: { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: event.id, reply }) });
    })();
    const discovered = await runReaderCli(['--connection-file', file, 'tools', '--json']);
    assert.equal(discovered.result.data.tools.some(tool => tool.name === 'reader_search_library'), true);
    const result = await runReaderCli(['--connection-file', file, 'library', 'search', '--query', '线索', '--book', 'allowed', '--max-response-bytes', '2048', '--json']);
    await loop;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(requestSeen.arguments, { queries: ['线索'], bookIds: ['allowed'] });
    assert.equal(requestSeen.maxResponseBytes, 2048);
    assert.deepEqual(scopeSeen, ['allowed']);
    assert.equal(result.result.data.items[0].chunkId, 'source-chunk');
    assert.equal(result.result.data.items[0].excerptTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.result)) <= 2048);
  } finally {
    stop.abort(); await reader?.cancel().catch(() => {}); await loop?.catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
