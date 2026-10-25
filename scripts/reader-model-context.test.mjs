import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitReaderModelInput } from './reader-model-context.mjs';

test('checks the complete assembled input and rejects an oversized request before model dispatch', async () => {
  const messages = [{ role: 'system', content: 'rules and tools' }, { role: 'user', content: 'history' },
    { role: 'tool', content: 'reader original text and metadata' }];
  const request = { model: 'fixture', messages, tools: [{ name: 'reader_search_library', parameters: { type: 'object' } }] };
  let seen;
  const allowed = await admitReaderModelInput({ request, countInputTokens: input => { seen = input; return 500; },
    contextTokens: 1024, reservedTokens: 300, safetyTokens: 100 });
  assert.deepEqual(seen, request);
  assert.notEqual(allowed.request, request);
  assert.equal(Object.isFrozen(allowed.request.messages[2]), true);
  messages[2].content = 'Changed after admission';
  assert.equal(JSON.parse(allowed.body).messages[2].content, 'reader original text and metadata');
  assert.equal(allowed.remainingTokens, 124);
  let dispatched = false;
  await assert.rejects(async () => {
    await admitReaderModelInput({ request, countInputTokens: () => 800, contextTokens: 1024, reservedTokens: 300, safetyTokens: 100 });
    dispatched = true;
  }, { code: 'MODEL_CONTEXT_LIMIT' });
  assert.equal(dispatched, false);
});
