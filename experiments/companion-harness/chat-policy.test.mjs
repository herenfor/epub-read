import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSoftContextPolicy, projectChatAssembly } from './chat-policy/policy.mjs';

test('chat projection keeps group delivery, management and exact schemas while work tools remain discoverable', async () => {
  const preset = JSON.parse(await readFile(new URL('./chat-policy/preset.json', import.meta.url)));
  assert.equal(preset.softTokens, 256000);
  const parameters = { type: 'object', properties: { source_event_id: { type: 'string' } }, required: ['source_event_id'] };
  const input = { sections: [{ name: 'deployment:persona-prefix', text: 'coding' },
    { name: 'botharness:orchestrator-role', text: 'management guide'.repeat(1500) },
    { name: 'botharness:persona', text: 'user role and memory' },
    { name: 'botharness:reply-delivery', text: 'native delivery and group peer contract' }],
    contexts: [{ name: 'permission', required: true, text: 'native policy' }], variables: {},
    tools: ['bash', 'read', 'bot_send_message', 'group_create', 'group_invite_bot', 'bot_create', 'reader_find_books', 'companion_tools'].map(name => ({ name, parameters })) };
  const actual = projectChatAssembly(input, false);
  assert.ok(JSON.stringify(actual.sections).length < JSON.stringify(input.sections).length / 2);
  assert.deepEqual(actual.contexts, input.contexts);
  assert.deepEqual(actual.sections.slice(2), input.sections.slice(2));
  assert.deepEqual(actual.tools.map(tool => tool.name), ['bot_send_message', 'group_create', 'group_invite_bot', 'bot_create', 'reader_find_books', 'companion_tools']);
  assert.ok(actual.tools.every(tool => tool.parameters === parameters));
  assert.deepEqual(projectChatAssembly(input, true).tools, input.tools);
  assert.equal(input.sections[0].text, 'coding');
  const character = projectChatAssembly({ ...input, sections: [...input.sections,
    { name: 'epub-reader-guidance', text: 'reading advice' }] }, false, {
    identity: 'Independent character identity', coordination: 'Native chat delivery only',
    omitSections: ['epub-reader-guidance'], omitTools: ['reader_find_books'],
  });
  assert.equal(character.sections[0].text, 'Independent character identity');
  assert.equal(character.sections[1].text, 'Native chat delivery only');
  assert.equal(character.sections.some(s => s.name === 'epub-reader-guidance'), false);
  assert.equal(character.tools.some(t => t.name === 'reader_find_books'), false);
  assert.deepEqual(character.contexts, input.contexts);
  assert.equal(character.sections.find(s => s.name === 'botharness:reply-delivery'), input.sections[3]);
});

test('soft pressure waits for finished work, aborts maintenance for new input and does not loop below 256K', async () => {
  let tokens = 255999; let busy = false; let attempts = 0; let started;
  const begun = new Promise(resolve => { started = resolve; });
  const policy = createSoftContextPolicy({ softTokens: 256000, measure: () => tokens, busy: () => busy,
    async compact(_id, signal) {
      attempts++;
      if (attempts === 1) {
        started();
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      tokens = 120000;
      return { nativeSummary: true };
    },
  });
  await policy.completed('session');
  assert.equal(attempts, 0);
  tokens = 260000; busy = true;
  await policy.completed('session');
  assert.equal(attempts, 0);
  assert.equal(policy.snapshot('session').pending, true);
  busy = false;
  const first = policy.completed('session'); await begun;
  policy.input('session'); await first;
  assert.equal(policy.snapshot('session').lastOutcome, 'interrupted');
  assert.equal(policy.snapshot('session').pending, true);
  assert.equal(tokens, 260000);
  await policy.completed('session');
  assert.equal(attempts, 2);
  assert.equal(policy.snapshot('session').pending, false);
  await policy.completed('session');
  assert.equal(attempts, 2);
  policy.forget('session');
  assert.equal(policy.snapshot('session').tokens, null);
  policy.dispose();
});
