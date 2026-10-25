import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderExtension } from './airi/extension.mjs';
import { bindReaderStop } from './airi/stop-bridge.mjs';

test('plugin preserves reader data, strips only synthetic nulls and cancels its DSH callback', { timeout: 15_000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'reader-plugin-'));
  const schema = { type: 'object', properties: { query: { type: 'string' },
    folderId: { type: ['string', 'null'] }, favorite: { type: 'boolean' } }, additionalProperties: false };
  const declarations = ['reader_find_books', 'reader_search_text', 'reader_prepare_index'].map(name => ({
    name, description: name, inputSchema: schema, readOnly: name !== 'reader_prepare_index',
  }));
  const calls = [];
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let disconnected = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(403); res.end('{}'); return; }
    if (req.url === '/tools') { res.end(JSON.stringify({ ok: true, data: { tools: declarations } })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(body);
    if (body.name === 'reader_search_text') {
      res.on('close', () => { disconnected = true; });
      resolveStarted();
    } else res.end(JSON.stringify({ apiVersion: '1', ok: true, data: { arguments: body.arguments,
      originalText: 'Fixture text', chunkId: 'fixture-chunk', corpusVersion: 'fixture-v1', anchor: { start: 0, end: 12 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connectionFile = join(fixture, 'connection.json');
  await writeFile(connectionFile, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'fixture' }));
  const definitions = new Map();
  const disposables = [];
  let unbind;
  try {
    const extension = createReaderExtension(async () => ({ connectionFile, execution: {
      command: process.execPath, args: [fileURLToPath(new URL('./reader-host.mjs', import.meta.url))],
    } }));
    await extension.setup({ subscriptions: { add: value => disposables.push(value) }, kits: { async use(kit) {
      assert.equal(kit.id, 'kit.tool');
      return { registerTool: definition => definitions.set(definition.id, definition), registerToolsetPrompt() {} };
    } } });
    assert.equal(definitions.has('reader_prepare_index'), false);
    assert.equal(definitions.has('shell'), false);
    const result = await definitions.get('reader_find_books').execute({ query: 'fixture', favorite: null, folderId: null });
    assert.deepEqual(result.data.arguments, { query: 'fixture', folderId: null });
    assert.equal(result.data.originalText, 'Fixture text');
    assert.equal(result.data.chunkId, 'fixture-chunk');
    const failed = definitions.get('reader_find_books').execute({ unexpected: null });
    await assert.rejects(failed);
    assert.equal(calls.length, 1, 'Invalid arguments never reach the native endpoint');

    let onAction;
    const controls = { tools: [{ id: 'plugin:epub-reader-tools:reader_stop_lookup' }] };
    const lookup = definitions.get('reader_search_text').execute({ query: 'fixture' });
    // Attach the rejection handler before issuing cancellation.
    const cancelled = assert.rejects(lookup);
    await started;
    unbind = bindReaderStop({ $onAction: callback => { onAction = callback; return () => { onAction = undefined; }; } },
      controls, input => definitions.get(input.name).execute(input.input));
    onAction({ name: 'cancelPendingSends' });
    await cancelled;
    const next = await definitions.get('reader_find_books').execute({ query: 'next' });
    assert.equal(next.ok, true);
    assert.equal(disconnected, true);
    assert.equal((await definitions.get('reader_bridge_status').execute({})).pending, 0);
    unbind(); unbind = undefined;
    assert.equal(onAction, undefined);
  } finally {
    unbind?.();
    for (const item of disposables.reverse()) await item.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
