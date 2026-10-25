import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Agent from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Session from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Controls from './bot-controls/index.mjs';
import { replyChunks } from './projection.mjs';

// Real native loop and prompt admission, but no model/API, real bot or user data.
test('persona prefix precedes the role; post-history follows user and tool results and can be cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-controls-prompt-'));
  const ctx = new Context(), fibers = [], requests = [], errors = [];
  let handle, unregister;
  const text = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    for (const service of [Projections, Session, Llm, Prompt, Tools, Agent, AgentLoop]) fibers.push(await ctx.plugin(service));
    const directory = join(root, 'persona-prompts');
    await mkdir(directory);
    await writeFile(join(directory, 'fixture-bot.json'), JSON.stringify({ revision: 'fixture-1', prefix: 'SYNTHETIC PREFIX', suffix: 'SYNTHETIC SUFFIX' }));
    ctx.provide('botharness', {
      rootDir: join(root, 'bots'),
      registry: { get: id => id === 'fixture-bot' ? { slug: id, displayName: 'Fixture Character' } : undefined },
      channels: { getOrCreateDm: () => ({ id: 'fixture-dm' }), humanNickname: () => 'Fixture User' },
      ownership: { resolve: id => id === 'fixture-session' ? { botSlug: 'fixture-bot', rootRole: 'orchestrator' } : undefined },
    });
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    ctx.provide('webServer', { register: () => () => {} });
    fibers.push(await ctx.plugin(Controls));
    class FixtureAdapter extends LlmAdapter {
      async *stream(request) {
        requests.push(request.messages);
        if (requests.length > 3) throw new Error('Fixture request limit');
        yield* replyChunks(requests.length === 1 ? { tool_calls: [{ id: 'fixture-call', function: { name: 'fixture_lookup', arguments: '{}' } }] }
          : { content: 'SYNTHETIC ANSWER' });
      }
    }
    unregister = ctx.llm.registerAdapter(['bot-controls-fixture'], new FixtureAdapter());
    handle = await ctx.agents.create({ sessionId: 'fixture-session', meta: { cwd: root },
      agentOptions: { provider: 'bot-controls-fixture', model: 'fixture' }, setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: 'fixture-role', order: 0, interpolate: false, text: 'SYNTHETIC SOUL' });
        agentCtx.tools.register({ name: 'fixture_lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return 'SYNTHETIC TOOL RESULT'; } });
        agentCtx.on('agent/error', ({ error }) => errors.push(error));
      } });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'SYNTHETIC QUESTION' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2);
    for (const messages of requests) {
      const system = messages.filter(m => m.role === 'system').map(text).join('\n');
      assert.ok(system.includes('SYNTHETIC PREFIX'));
      assert.ok(system.indexOf('SYNTHETIC PREFIX') < system.indexOf('SYNTHETIC SOUL'));
      assert.equal(messages.at(-1).role, 'user');
      assert.equal(messages.at(-1).source.kind, 'runtime-context');
      assert.match(text(messages.at(-1)), /SYNTHETIC SUFFIX/);
    }
    assert.ok(requests[1].some(m => m.role === 'tool' && text(m).includes('SYNTHETIC TOOL RESULT')));
    assert.notEqual(text(requests[0].at(-1)), text(requests[1].at(-1)));
    // Removing the preset must supersede its old runtime snapshot as well.
    await writeFile(join(directory, 'fixture-bot.json'), JSON.stringify({ revision: 'fixture-2', prefix: '', suffix: '' }));
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'SECOND SYNTHETIC QUESTION' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 3);
    const current = requests[2];
    assert.doesNotMatch(text(current.at(-1)), /SYNTHETIC SUFFIX/);
    assert.ok(current.some(m => m.role === 'user' && text(m) === 'SECOND SYNTHETIC QUESTION'));
  } finally {
    await handle?.dispose(); await unregister?.();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
