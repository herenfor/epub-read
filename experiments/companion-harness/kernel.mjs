import { Context } from '@deepseek-ai/cordis';
import Agent from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Session from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { projectProtocol, replyChunks } from './projection.mjs';

/** A standalone native DSH composition: no global home/profile, persistence,
 * shell, filesystem tools, telemetry, automatic compactor or second model loop. */
export async function createKernel() {
  const ctx = new Context();
  const fibers = [];
  for (const service of [Projections, Session, Llm, Prompt, Tools, Agent, AgentLoop]) fibers.push(await ctx.plugin(service));
  return {
    async run(input, request, signal) {
      let lastReply;
      let continuation;
      let failure;
      let outcome;
      let models = 0;
      let tools = 0;
      class ReaderAdapter extends LlmAdapter {
        async *stream(options) {
          options.signal?.throwIfAborted();
          if (++models > 6) throw new Error('Model request limit reached');
          lastReply = await request('model', { protocol: projectProtocol(options.messages) }, options.signal);
          continuation = undefined;
          if (!lastReply.tool_calls?.length) {
            const check = await request('finalize', { answer: lastReply.content ?? '' }, options.signal);
            continuation = check.continueWith;
          }
          yield* replyChunks(lastReply);
        }
      }
      const route = `epub-${input.id}`;
      const registration = ctx.llm.registerAdapter([route], new ReaderAdapter());
      let handle;
      const cancel = () => handle?.agent.cancel({ kind: 'user' });
      try {
        handle = await ctx.agents.create({
          sessionId: input.id, meta: { cwd: process.cwd() },
          agentOptions: { provider: route, model: input.model, maxTokens: input.maxTokens },
          setup(agentCtx) {
            agentCtx.systemPrompt.section({ name: 'epub-role', order: 0, complete: true, interpolate: false, text: input.system });
            for (const { function: definition } of input.tools) agentCtx.tools.register({
              ...definition,
              output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
              async execute(args, exec) {
                if (++tools > 12) throw new Error('Tool request limit reached');
                const value = await request('tool', { id: exec.callId, type: 'function',
                  function: { name: definition.name, arguments: JSON.stringify(args) } }, exec.signal);
                return JSON.stringify(value);
              },
            });
            agentCtx.on('agent/turn-stopping', ({ agent }) => {
              if (continuation) {
                agent.steer(createUserMessage({ content: [{ type: 'text', text: continuation }], source: { kind: 'epub-policy' } }));
                continuation = undefined;
              }
            });
            agentCtx.on('agent/error', ({ error }) => { failure = new Error('DSH执行失败；本轮未保存为完整回答', { cause: error }); });
            agentCtx.on('session/event', (_session, event) => { if (event.type === 'turn/end') outcome = event.data.reason.kind; });
          },
        });
        signal.addEventListener('abort', cancel, { once: true });
        signal.throwIfAborted();
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.question }], source: { kind: 'user' } }));
        await handle.agent.whenIdle();
        signal.throwIfAborted();
        if (failure || outcome !== 'completed' || !lastReply?.content || lastReply.tool_calls?.length) {
          throw failure ?? new Error('DSH未完整结束本轮回答');
        }
        return { answer: lastReply.content, modelRequests: models, toolCalls: tools };
      } finally {
        signal.removeEventListener('abort', cancel);
        try { await handle?.dispose(); } finally { await registration(); }
      }
    },
    async dispose() { for (const fiber of fibers.reverse()) await fiber.dispose(); },
  };
}
