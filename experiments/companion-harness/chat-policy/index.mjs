import { readFileSync, writeFileSync } from 'node:fs';
import { createSoftContextPolicy, projectChatAssembly, WORK_TOOLS } from './policy.mjs';

export const name = 'epub-companion-chat-policy';
export const inject = ['agents', 'sessions', 'systemPrompt', 'tools', 'tokenMeter', 'botharness', 'agentPresets'];

export function apply(ctx, config = {}) {
  const preset = JSON.parse(readFileSync(config.presetFile ?? new URL('./preset.json', import.meta.url), 'utf8'));
  const softTokens = config.softTokens ?? preset.softTokens;
  if (!Number.isSafeInteger(softTokens) || softTokens < 1024) throw new Error('softTokens must be a positive token budget');
  const bots = new Set(config.botIds ?? []);
  const attached = new Map();
  const timers = new Set();
  const stats = new Map();
  const ownerOf = agent => agent?.session?.id && ctx.botharness.ownership.resolve(agent.session.id);
  const botOf = agent => ownerOf(agent)?.botSlug;
  const target = agent => { const owner = ownerOf(agent); return owner?.rootRole === 'orchestrator'
    && owner.parentSessionId === undefined && bots.has(owner.botSlug); };
  const getAgent = id => ctx.agents.list().find(agent => agent.session.id === id);
  const save = () => {
    if (config.statusFile) writeFileSync(config.statusFile, JSON.stringify({ preset: preset.id, softTokens,
      sessions: [...stats.values()] }), { mode: 0o600 });
  };
  const policy = createSoftContextPolicy({ softTokens,
    measure(id) { const agent = getAgent(id); return agent ? ctx.tokenMeter.measure(agent.session).totalTokens : 0; },
    busy(id) {
      const agent = getAgent(id); const bot = botOf(agent);
      return !agent || agent.status !== 'idle' || ctx.botharness.runtime.turnRunning?.(bot)
        || ctx.botharness.runtime.hasPendingInbox?.(bot)
        || ctx.botharness.runtime.listAssignments(bot).some(item => !item.archivedAt && ['working', 'stopping'].includes(item.activity));
    },
    async compact(id, signal) {
      const agent = getAgent(id);
      const engine = ctx.agentPresets.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction');
      if (!engine) throw new Error('Native compaction service is unavailable');
      return engine.compactNow(agent, signal);
    },
    report(id, value) { stats.set(id, { ...stats.get(id), sessionId: id, ...value }); save(); },
  });

  function attach(agent) {
    if (!target(agent) || attached.has(agent.session.id)) return;
    // Tobs pins persona text per session. Refresh only for an explicit human
    // role update, never as a side effect of every turn or tool expansion.
    if (config.refreshPersonaOnApply === true) ctx.botharness.memory.refreshPersonaAfterCompaction(botOf(agent), agent.session.id);
    const state = { workExpanded: preset.deferWorkTools === false, disposers: [] };
    attached.set(agent.session.id, state);
    state.disposers.push(agent.ctx.tools.guard(exec => !state.workExpanded && WORK_TOOLS.has(exec.name)
      ? 'Use companion_tools(action=expand_work) to discover this existing capability first; host permissions still apply.' : undefined));
    const parameters = { type: 'object', properties: { action: { type: 'string', enum: ['status', 'expand_work', 'collapse_work'] } },
      required: ['action'], additionalProperties: false };
    state.disposers.push(agent.ctx.tools.register({ name: 'companion_tools',
      description: '查看当前会话预设；按需展开或收起编码、文件和工作流工具。群聊与管理工具不受此开关影响，展开不增加权限。', parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) {
        if (!args || Object.keys(args).some(key => key !== 'action') || !['status', 'expand_work', 'collapse_work'].includes(args.action)) throw new Error('Invalid companion_tools action');
        if (args.action !== 'status') state.workExpanded = args.action === 'expand_work';
        return { preset: preset.id, workExpanded: state.workExpanded, context: policy.snapshot(agent.session.id) };
      },
    }));
  }
  for (const agent of ctx.agents.list()) attach(agent);
  ctx.effect(() => ctx.botharness.contributeBotAgentSetup((_agentCtx, agent) => attach(agent)));
  ctx.on('agent/pre-step', async ({ agent }, next) => { attach(agent); return next(); }, { global: true });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next(); const agent = context.agent ?? context.scope;
    if (!target(agent)) return result;
    attach(agent);
    const projected = projectChatAssembly(result, attached.get(agent.session.id).workExpanded, preset.promptProfile);
    const chars = parts => parts.reduce((count, part) => count + part.text.length, 0);
    stats.set(agent.session.id, { ...stats.get(agent.session.id), sessionId: agent.session.id,
      systemBefore: chars(result.sections), systemAfter: chars(projected.sections),
      toolsBefore: result.tools.length, toolsAfter: projected.tools.length,
      toolCharsBefore: JSON.stringify(result.tools).length, toolCharsAfter: JSON.stringify(projected.tools).length });
    save();
    return projected;
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    const agent = getAgent(session.id);
    if (!target(agent)) return;
    if (event.type === 'agent/inbox/spliced') policy.input(session.id);
    if (event.type !== 'turn/end' || event.data.reason?.kind !== 'completed') return;
    // Let the caller finish its turn bookkeeping before considering idle maintenance.
    const timer = setTimeout(() => {
      timers.delete(timer);
      policy.completed(session.id).catch(() => { /* Failure is recorded, history remains native-owned. */ });
    }, 0);
    timers.add(timer);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const state = attached.get(agent.session.id);
    if (!state) return;
    policy.forget(agent.session.id);
    for (const dispose of state.disposers.reverse()) dispose();
    attached.delete(agent.session.id); stats.delete(agent.session.id); save();
  }, { global: true });
  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer);
    policy.dispose();
    for (const state of attached.values()) for (const dispose of state.disposers.reverse()) dispose();
  });
}
