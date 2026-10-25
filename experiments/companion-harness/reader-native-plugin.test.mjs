import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as ReaderPlugin from './reader-plugin/index.mjs';
import { createReaderToolService } from '../../src/features/ai/reader-tools/service.ts';

test('native DSH plugin reconnects, reads authorized original data and drains cancellation without owning chat', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reader-native-plugin-'));
  const connectionFile = join(directory, 'connection.json');
  const ctx = new Context();
  const fibers = [];
  let online = true;
  let token = 'fixture-one';
  let seen;
  let started;
  let released;
  const searching = new Promise(resolve => { started = resolve; });
  const drained = new Promise(resolve => { released = resolve; });
  const passage = { bookId: 'allowed', contentHash: 'fixture-source', chapterId: 'one.xhtml', spineIndex: 0,
    chunkId: 'original-chunk', corpusVersion: 'fixture-v1', originalText: '这是保留来源的原文。',
    anchor: { start: 0, end: 11, snippet: '保留来源' } };
  const service = createReaderToolService({
    list: async () => ['allowed', 'hidden'].map(bookId => ({ bookId, title: bookId, creator: '', available: true, favorite: false, folderId: null })),
    chapters: async () => [{ chapterId: 'one.xhtml', title: 'Fixture', spineIndex: 0 }],
    read: async () => [passage],
    search: async (_book, _query, _limit, signal) => {
      started();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { released(); reject(signal.reason); }, { once: true }));
    },
    searchLibrary: async () => ({ coverage: { scopeBooks: 1, indexedBooks: 1, missingIndexBooks: 0, outdatedIndexBooks: 0,
      unavailableBooks: 0, complete: true }, candidateLimitReached: false, items: [{ ...passage, title: 'allowed', creator: '' }] }),
    prepareIndex: async () => { throw new Error('Must remain unavailable to this plugin'); },
  }, { clientId: 'fixture', bookIds: ['allowed'], prepareIndex: true });
  const server = createServer(async (req, res) => {
    if (!online || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(503); res.end('{}'); return; }
    if (req.url === '/tools') { res.end(JSON.stringify({ apiVersion: '1', ok: true, data: { tools: service.definitions } })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const reply = await service.call(seen, controller.signal);
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connect = () => writeFile(connectionFile, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token }));
  let plugin;
  try {
    fibers.push(await ctx.plugin(Prompt));
    fibers.push(await ctx.plugin(Tools));
    const disposeChat = ctx.tools.register({ name: 'fixture_chat', description: 'Unrelated host capability',
      parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ alive: true }) });
    plugin = await ctx.plugin(ReaderPlugin, { connectionFile, maxResponseBytes: 2048 });
    const call = (name, args = {}, signal = new AbortController().signal) => ctx.tools.execute({ callId: crypto.randomUUID(), name, arguments: args, signal });
    assert.equal((await call('reader_connection_status')).value.state, 'unavailable');
    assert.equal((await call('fixture_chat')).value.alive, true);
    await connect();
    assert.equal((await call('reader_refresh_tools')).value.state, 'ready');
    assert.equal(ctx.tools.schemas().some(tool => tool.name === 'reader_prepare_index'), false);
    assert.equal(ctx.tools.schemas().some(tool => tool.name === 'reader_search_library'), true);
    const books = await call('reader_find_books', { folderId: null });
    assert.deepEqual(books.value.data.items.map(book => book.bookId), ['allowed']);
    assert.equal(seen.maxResponseBytes, 2048);
    const requestCount = seen.requestId;
    assert.equal((await call('reader_find_books', { favorite: null })).isError, true);
    assert.equal(seen.requestId, requestCount, 'Invalid model arguments never reach the reader');
    const hit = await call('reader_search_library', { queries: ['原文'] });
    assert.equal(hit.value.data.items[0].chunkId, passage.chunkId);
    token = 'fixture-two'; await connect();
    const text = await call('reader_read_passages', { bookId: 'allowed', chapterId: 'one.xhtml' });
    assert.deepEqual(text.value.data.items[0], passage, 'Rotated credentials do not change original data');
    const cancellation = new AbortController();
    const pending = call('reader_search_text', { bookId: 'allowed', query: 'hold' }, cancellation.signal);
    await searching;
    cancellation.abort();
    assert.equal((await pending).isError, true);
    await drained;
    assert.equal((await call('reader_find_books')).value.ok, true);
    online = false;
    assert.equal((await call('reader_refresh_tools')).value.state, 'unavailable');
    assert.equal(ctx.tools.schemas().some(tool => tool.name === 'reader_read_passages'), false);
    assert.equal((await call('fixture_chat')).value.alive, true);
    await plugin.dispose(); plugin = undefined;
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['fixture_chat']);
    disposeChat();
  } finally {
    await plugin?.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
