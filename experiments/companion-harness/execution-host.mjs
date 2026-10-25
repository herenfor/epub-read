import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';

// Private parent/child NDJSON only. No HTTP listener, model, global DSH home,
// reader service credentials, or application memory is loaded by this entry.
console.log = console.warn = console.error = () => {};
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
let kernel;
try {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, mode: { type: 'string' } } });
  const { createExecutionKernel } = await import('./execution-kernel.mjs');
  kernel = await createExecutionKernel(values);
} catch (error) {
  send({ type: 'error', code: error.code ?? 'START_FAILED', message: error.message });
  process.exitCode = 1;
}

if (kernel) {
  const lines = createInterface({ input: process.stdin });
  let active;
  let last;
  let closing;
  const stop = () => closing ??= (async () => {
    active?.controller.abort();
    await active?.done;
    await kernel.dispose();
    send({ type: 'closed' });
    lines.close();
    process.stdin.destroy();
  })();

  lines.on('line', line => {
    if (closing) return;
    let event;
    try {
      if (Buffer.byteLength(line) > 24 * 1024) throw new Error('Request too large');
      event = JSON.parse(line);
      if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 128) throw new Error('An operation id is required');
      const keys = event.type === 'call' ? ['type', 'id', 'command'] : ['type', 'id'];
      if (Object.keys(event).some(key => !keys.includes(key))) throw new Error('Unsupported request fields');
      if (event.type === 'status') {
        send({ type: 'status', id: event.id, active: active ? { id: active.id,
          state: active.controller.signal.aborted ? 'cancelling' : 'running' } : null, last });
      } else if (event.type === 'cancel') {
        const accepted = active?.id === event.id;
        if (accepted) active.controller.abort();
        send({ type: 'cancelling', id: event.id, accepted: !!accepted });
      } else if (event.type === 'shutdown') {
        void stop();
      } else if (event.type === 'call') {
        if (typeof event.command !== 'string' || !event.command.trim()) throw new Error('A command is required');
        if (active) { send({ type: 'error', id: event.id, code: 'BUSY', message: 'Another operation is active' }); return; }
        const operation = { id: event.id, controller: new AbortController() };
        active = operation;
        send({ type: 'started', id: event.id });
        operation.done = kernel.run(event.command, operation.controller.signal).then(result => {
          last = { id: operation.id, state: result.aborted ? 'cancelled' : result.timedOut ? 'timed-out' : 'completed',
            exitCode: result.exitCode };
          active = undefined;
          send({ type: 'result', id: operation.id, ...result });
        }, error => {
          last = { id: operation.id, state: operation.controller.signal.aborted ? 'cancelled' : 'failed' };
          active = undefined;
          send({ type: 'error', id: operation.id, code: error.code ?? (operation.controller.signal.aborted ? 'CANCELLED' : 'EXECUTION_FAILED'),
            message: error.message });
        });
      } else throw new Error('Unknown request type');
    } catch (error) { send({ type: 'error', id: event?.id, code: 'INVALID_REQUEST', message: error.message }); }
  });
  lines.on('close', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  send({ type: 'ready', protocol: 1, version: '0.2.1-rc.3', capability: 'shell.exec', sandbox: kernel.boundary });
}
