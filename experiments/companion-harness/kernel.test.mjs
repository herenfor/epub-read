import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from './kernel.mjs';

const input = id => ({ id, model: 'fixture', system: 'Fixture role', question: 'Fixture question', tools: [
  { type: 'function', function: { name: 'read_chapter', description: 'Fixture reader',
    parameters: { type: 'object', properties: { chapter: { type: 'string' } }, required: ['chapter'] } } },
] });

test('native tool round replays reasoning and strict steering without duplicating app context', async () => {
  const kernel = await createKernel();
  const calls = [];
  let models = 0;
  let checks = 0;
  try {
    const result = await kernel.run(input('native-fixture'), async (kind, data) => {
      calls.push(kind);
      if (kind === 'tool') {
        assert.equal(data.id, 'call-1');
        assert.equal(data.function.name, 'read_chapter');
        assert.deepEqual(JSON.parse(data.function.arguments), { chapter: 'c1' });
        return { evidence: [{ id: 'E1', text: 'Fixture passage' }] };
      }
      if (kind === 'finalize') return ++checks === 1 ? { continueWith: 'Please cite [E1].' } : {};
      if (++models === 1) {
        assert.deepEqual(data.protocol, []);
        return { role: 'assistant', content: null, reasoning_content: '', tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read_chapter', arguments: '{"chapter":"c1"}' } },
        ] };
      }
      assert.ok(Object.hasOwn(data.protocol[0], 'reasoning_content'));
      assert.equal(data.protocol[0].reasoning_content, '');
      assert.equal(data.protocol[1].tool_call_id, 'call-1');
      assert.match(data.protocol[1].content, /Fixture passage/);
      if (models === 3) assert.deepEqual(data.protocol.at(-1), { role: 'user', content: 'Please cite [E1].' });
      return { role: 'assistant', content: models === 2 ? 'Uncited answer' : 'Final answer [E1]' };
    }, new AbortController().signal);
    assert.deepEqual(result, { answer: 'Final answer [E1]', modelRequests: 3, toolCalls: 1 });
    assert.deepEqual(calls, ['model', 'tool', 'model', 'finalize', 'model', 'finalize']);
  } finally { await kernel.dispose(); }
});

test('cancelling a pending provider drains the turn and allows a clean subsequent turn', async () => {
  const kernel = await createKernel();
  const controller = new AbortController();
  try {
    const cancelled = kernel.run(input('cancel-fixture'), async (_kind, _data, signal) => {
      controller.abort();
      signal.throwIfAborted();
    }, controller.signal);
    await assert.rejects(cancelled, { name: 'AbortError' });
    const result = await kernel.run(input('next-fixture'), async kind => kind === 'model'
      ? { role: 'assistant', content: 'Next answer' } : {}, new AbortController().signal);
    assert.equal(result.answer, 'Next answer');
    assert.equal(result.toolCalls, 0);
  } finally { await kernel.dispose(); }
});
