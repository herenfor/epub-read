import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConversationControls, ControlError } from './service.mjs';
import { createPersonaControls, addMainPrompt, expandPersonaPrompt, postHistoryText } from './prompts.mjs';

export const name = 'epub-local-bot-controls';
export const inject = ['connection', 'webServer', 'botharness', 'systemPrompt'];
export function apply(ctx) {
  const controls = createConversationControls(ctx.botharness);
  const personas = createPersonaControls(ctx.botharness, join(ctx.botharness.rootDir, '..', 'persona-prompts'));
  const steps = new Map();
  const owner = context => {
    const agent = context.agent ?? context.scope;
    const row = agent?.session?.id && ctx.botharness.ownership.resolve(agent.session.id);
    return row ? { id: row.botSlug, session: agent.session.id,
      orchestrator: row.rootRole === 'orchestrator' && !row.parentSessionId } : undefined;
  };
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next(); const bot = owner(context); if (!bot) return result;
    // Tobs defaults its SOUL/MEMORY section to native DSH interpolation. Card
    // macros belong to this adapter instead; leave other card syntax literal.
    const projected = expandPersonaPrompt(result, text => personas.expand(bot.id, text));
    if (!bot.orchestrator) return projected;
    const config = personas.settings(bot.id);
    return addMainPrompt(projected, personas.expand(bot.id, config.prefix));
  }, { global: true });
  // Native runtime context is committed after the admitted user batch. Refresh
  // the step stamp so post-history remains last on tool-loop generations too;
  // this is logged and included in the engine's normal context admission.
  ctx.effect(() => ctx.systemPrompt.context({ name: 'bot-controls:post-history', order: 100000,
    required: true, interpolate: false, text(context) {
      const bot = owner(context); if (!bot?.orchestrator) return '';
      const config = personas.settings(bot.id); const phase = steps.get(bot.session);
      return postHistoryText(personas.expand(bot.id, config.suffix), config.revision, phase?.turn, phase?.step);
    } }));
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => { steps.set(agent.session.id, { turn, step }); return next(); }, { global: true });
  ctx.on('agent/disposed', ({ agent }) => steps.delete(agent.session.id), { global: true });
  const assets = new Map([['', ['ui.html', 'text/html']], ['/app.js', ['ui.js', 'text/javascript']], ['/style.css', ['ui.css', 'text/css']]]);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  for (const [path, [file, type]] of assets) ctx.effect(() => ctx.connection.fetch.register({ path: '/api/bot-controls' + path, methods: ['GET'], requestBody: 'buffered',
    async fetch() { return new Response(await readFile(new URL(file, import.meta.url)), { headers: { ...headers, 'Content-Type': type + '; charset=utf-8' } }); } }));
  for (const path of ['bots', 'messages', 'preview', 'confirm', 'persona']) ctx.effect(() => ctx.connection.fetch.register({ path: '/api/bot-controls/' + path,
    methods: path === 'persona' ? ['GET', 'POST'] : ['bots', 'messages'].includes(path) ? ['GET'] : ['POST'], requestBody: 'buffered', async fetch(request) {
      try {
        let value; const url = new URL(request.url);
        if (path === 'bots') value = { bots: controls.bots() };
        else if (path === 'messages') value = controls.messages(url.searchParams.get('bot'), url.searchParams.get('before') ?? undefined);
        else if (path === 'persona' && request.method === 'GET') value = personas.load(url.searchParams.get('bot'));
        else { const text = await request.text(); if (text.length > 100000) throw new ControlError('请求过大'); const input = JSON.parse(text);
          value = path === 'preview' ? controls.preview(input) : path === 'persona' ? personas.save(input) : controls.confirm(input); }
        return Response.json(value, { headers });
      } catch (error) { return Response.json({ error: error instanceof ControlError ? error.message : '操作未完成，请刷新后重试' }, { status: error.status ?? 409, headers }); }
    } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/bot-controls', handler(req, res) {
    if (!ctx.connection.authorizeIndex(req, res)) return;
    res.writeHead(302, { Location: '/api/bot-controls', 'Cache-Control': 'no-store' }); res.end();
  } }));
}
