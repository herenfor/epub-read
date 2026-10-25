import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

console.log = console.warn = console.error = () => {};
const { createReaderKernel } = await import('./reader-kernel.mjs');
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const lines = createInterface({ input: process.stdin });
const pending = new Map();
let kernel;
let initializing = false;
let active;
let closing;

function invoke(name, args, signal) {
  signal.throwIfAborted();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    // Unlike aborting only the wait, retain the callback until the owner has
    // cancelled its HTTP request and acknowledged it. Do not start another call.
    const cancel = () => send({ type: 'cancel-request', id });
    pending.set(id, { resolve, reject, cleanup: () => signal.removeEventListener('abort', cancel) });
    signal.addEventListener('abort', cancel, { once: true });
    send({ type: 'request', id, name, arguments: args });
  });
}
const stop = () => closing ??= (async () => {
  active?.controller.abort();
  // EOF means the capability owner is gone. There can be no callback left to await.
  for (const item of pending.values()) { item.cleanup(); item.reject(new Error('Reader owner disconnected')); }
  pending.clear();
  await active?.done;
  await kernel?.dispose();
  send({ type: 'closed' });
  lines.close(); process.stdin.destroy();
})();

lines.on('line', line => {
  void (async () => {
    let event;
    try {
      if (Buffer.byteLength(line) > 5 * 1024 * 1024) throw new Error('Request too large');
      event = JSON.parse(line);
      if (event.type === 'reply') {
        const item = pending.get(event.id);
        if (!item) return;
        pending.delete(event.id); item.cleanup();
        if (event.error) item.reject(new Error('Reader callback did not complete'));
        else item.resolve(event.value);
        return;
      }
      if (closing) return;
      if (event.type === 'init') {
        if (kernel || initializing) throw new Error('Already initialized');
        initializing = true;
        kernel = await createReaderKernel(event.tools, invoke);
        send({ type: 'ready', protocol: 1, tools: kernel.tools, loopOwner: 'airi', memory: 'external' });
      } else if (event.type === 'cancel') {
        if (active?.id === event.id) active.controller.abort();
      } else if (event.type === 'shutdown') {
        void stop();
      } else if (event.type === 'call') {
        if (!kernel) throw new Error('Not initialized');
        if (active) throw new Error('Another reader operation is active');
        if (typeof event.id !== 'string' || !event.id || event.id.length > 128) throw new Error('Invalid call id');
        const operation = { id: event.id, controller: new AbortController() };
        active = operation;
        operation.done = kernel.call(event.id, event.name, event.arguments, operation.controller.signal).then(result => {
          active = undefined; send({ type: 'result', id: event.id, result });
        }, () => {
          active = undefined; send({ type: 'error', id: event.id, message: 'Reader dispatch did not complete' });
        });
      } else throw new Error('Unknown request');
    } catch (error) { send({ type: 'error', id: event?.id, message: error.message }); }
  })();
});
lines.on('close', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
