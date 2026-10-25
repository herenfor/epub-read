import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createReaderClient, readerConnectionFile, readerFailure } from './client.mjs';
import { selectReadTools, READING_GUIDANCE } from './policy.mjs';

const noArgs = { type: 'object', properties: {}, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const controls = [
  { name: 'reader_connection_status', description: 'Check the optional local reader connection without opening a book.', inputSchema: noArgs, annotations },
  { name: 'reader_refresh_tools', description: 'Reconnect/discover authorized read tools after the reader starts, restarts or changes. No indexing or writes.', inputSchema: noArgs, annotations },
];
function outputSchema(data) {
  return { type: 'object', properties: { apiVersion: { const: '1' }, requestId: { type: 'string' }, ok: { type: 'boolean' },
    responseBudget: { type: 'object', properties: { maxBytes: { type: 'integer' }, limited: { type: 'boolean' } } },
    data, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } }, required: ['code', 'message', 'retryable'] } },
    required: ['apiVersion', 'ok'], oneOf: [
      { properties: { ok: { const: true } }, required: ['data'] },
      { properties: { ok: { const: false } }, required: ['error'] },
    ] };
}

/** Standard MCP transport around the existing reader API, not another backend. */
export function createReaderMcpServer({ connectionFile = readerConnectionFile(), maxResponseBytes = 65536 } = {}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 4096 || maxResponseBytes > 1024 * 1024)
    throw new Error('MCP reply budget must be an integer from 4096 to 1048576 bytes');
  // MCP sends both text and structured JSON. Reserve space for both copies,
  // escaping and protocol wrappers, then check the completed result as well.
  const nativeBudget = Math.min(262144, Math.floor((maxResponseBytes - 1024) / 3));
  const lifetime = new AbortController();
  const native = createReaderClient(connectionFile, { maxResponseBytes: nativeBudget });
  const discovery = createReaderClient(connectionFile, { maxResponseBytes: 262144, timeoutMs: 3000 });
  const server = new Server({ name: 'epub-reader', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } }, instructions: READING_GUIDANCE });
  let tools = [];
  let connectionError;
  const status = () => ({ apiVersion: '1', ok: true, data: { ready: !connectionError, tools: tools.map(t => t.name),
    maxResponseBytes, readerResponseBytes: nativeBudget, ...(connectionError ? { connectionError } : {}) } });
  const signalFor = signal => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  async function discover(signal) {
    try {
      const reply = await discovery('/tools', undefined, signalFor(signal));
      if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
      if (!Array.isArray(reply.data.tools)) throw new Error('Invalid reader catalog');
      tools = selectReadTools(reply.data.tools); connectionError = undefined;
    } catch (error) {
      if (signal?.aborted || lifetime.signal.aborted) throw error;
      tools = []; connectionError = { code: error.code ?? 'INVALID_RESPONSE', message: 'Reader unavailable; start its service and refresh tools', retryable: error.retryable ?? true };
    }
    return status();
  }
  function render(reply) {
    const result = { content: [{ type: 'text', text: JSON.stringify(reply) }], structuredContent: reply, isError: !reply.ok };
    if (Buffer.byteLength(JSON.stringify(result)) <= maxResponseBytes - 128) return result;
    const failure = readerFailure('RESPONSE_BUDGET_EXCEEDED', 'MCP reply budget exceeded; request fewer items');
    return { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true };
  }
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    if (request.params?.cursor) throw new McpError(ErrorCode.InvalidParams, 'This tool catalog fits in one page');
    await discover(extra.signal);
    return { tools: [...controls, ...tools.map(tool => ({ name: tool.name, description: tool.description,
      inputSchema: tool.inputSchema, outputSchema: outputSchema(tool.outputSchema), annotations }))] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (controls.some(t => t.name === name)) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
        return render(readerFailure('INVALID_ARGUMENTS', 'This connection control takes no arguments'));
      const old = JSON.stringify(tools);
      const result = await discover(extra.signal);
      if (name === 'reader_refresh_tools' && old !== JSON.stringify(tools)) await server.sendToolListChanged();
      return render(result);
    }
    await discover(extra.signal);
    if (connectionError) return render(readerFailure(connectionError.code, connectionError.message, connectionError.retryable));
    if (!tools.some(tool => tool.name === name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown or unauthorized reader tool; refresh tools/list');
    try { return render(await native('/call', { name, arguments: args }, signalFor(extra.signal))); }
    catch (error) { return render(readerFailure(error.code ?? 'READER_UNAVAILABLE', error.message, error.retryable ?? false)); }
  });
  const originalClose = server.close.bind(server);
  server.close = async () => { lifetime.abort(); await originalClose(); };
  server.onclose = () => lifetime.abort();
  return server;
}
