import { join } from 'node:path';
import { createReaderArgumentValidator } from 'epub-reader-agent-tools/validation';
import { createReaderClient } from './client.mjs';
import { dshSchema, selectReadTools, READING_GUIDANCE } from './policy.mjs';

export const name = 'epub-reader-tools';
export const inject = ['tools', 'systemPrompt'];
const output = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

/** Register into the host's native registry. No inner Context, agent loop,
 * conversation store, provider credentials, background polling or shell. */
export async function apply(ctx, config = {}) {
  const connectionFile = config.connectionFile ?? process.env.EPUB_READER_CONNECTION_FILE
    ?? (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'dev.epubreader.ai', 'reader-tools', 'local.json') : undefined);
  const maxResponseBytes = config.maxResponseBytes ?? 16_384;
  if (connectionFile !== undefined && (typeof connectionFile !== 'string' || !connectionFile)) throw new Error('connectionFile must be a local discovery file');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 262_144) throw new Error('maxResponseBytes must be 1024..262144');
  const lifetime = new AbortController();
  const registrations = new Map();
  let state = connectionFile ? 'unavailable' : 'not_configured';
  let refreshing = false;
  const status = () => ({ state, tools: [...registrations.keys()], maxResponseBytes, refreshing });
  const signalFor = (signal, timeout) => AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(timeout)].filter(Boolean));
  const clear = () => { for (const dispose of registrations.values()) dispose(); registrations.clear(); };
  ctx.effect(() => () => { lifetime.abort(); clear(); });
  ctx.effect(() => ctx.systemPrompt.section({ name: 'epub-reader-guidance', order: 60, text: READING_GUIDANCE }));

  async function refresh(signal) {
    if (!connectionFile || refreshing) return status();
    refreshing = true;
    try {
      const reply = await createReaderClient(connectionFile, { maxResponseBytes: 262_144 })('/tools', undefined, signalFor(signal, 3000));
      if (!reply.ok || reply.apiVersion !== '1' || !Array.isArray(reply.data?.tools)) throw new Error('Unsupported reader tool catalog');
      const declarations = selectReadTools(reply.data.tools);
      lifetime.signal.throwIfAborted();
      clear();
      for (const tool of declarations) {
        const parameters = dshSchema(tool.inputSchema);
        const accepts = createReaderArgumentValidator(parameters);
        const dispose = ctx.tools.register({ name: tool.name, description: tool.description, parameters, output,
          async execute(args, exec) {
            if (!accepts(args)) throw new Error('Invalid reader tool arguments');
            return createReaderClient(connectionFile, { maxResponseBytes })('/call', {
              name: tool.name, arguments: args, maxResponseBytes,
            }, signalFor(exec.signal, 125_000));
          },
        });
        registrations.set(tool.name, dispose);
      }
      state = 'ready';
    } catch (error) {
      clear();
      state = 'unavailable';
      if (signal?.aborted || lifetime.signal.aborted) throw error;
      // Return a useful state, never discovery paths or native credentials.
    } finally { refreshing = false; }
    return status();
  }
  const acceptsNoArgs = createReaderArgumentValidator(noArgs);
  for (const [toolName, description, execute] of [
    ['reader_connection_status', 'Check this optional reader connection and its currently registered read tools. Does not access conversation memory.', async () => status()],
    ['reader_refresh_tools', 'Reconnect to the local EPUB Reader after it starts or restarts; discover its authorized read-only tools. Does not open books or build indices.', (_args, exec) => refresh(exec.signal)],
  ]) ctx.tools.register({ name: toolName, description, parameters: noArgs, output,
    async execute(args, exec) {
      if (!acceptsNoArgs(args)) throw new Error('This reader control takes no arguments');
      return execute(args, exec);
    },
  });
  await refresh();
}
