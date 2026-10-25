import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// Stdout is the ephemeral IPC channel. Never forward a host logger's object
// inspection or raw error into the application console or a file.
console.log = console.warn = console.error = () => {};
const { createKernel } = await import('./kernel.mjs');
const kernel = await createKernel();
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const pending = new Map();
let active;

function request(kind, data, signal) {
  signal?.throwIfAborted();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); reject(new DOMException('Cancelled', 'AbortError')); };
    pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
    signal?.addEventListener('abort', abort, { once: true });
    send({ type: 'request', runId: active.id, id, kind, data });
  });
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'result') {
    const item = pending.get(event.id);
    if (!item) return;
    pending.delete(event.id); item.cleanup();
    if (event.error) item.reject(new Error('应用侧调用未完成')); else item.resolve(event.value);
  } else if (event.type === 'cancel' && active?.id === event.id) {
    active.controller.abort();
  } else if (event.type === 'run') {
    if (active) { send({ type: 'error', runId: event.input.id, message: 'DSH正在处理另一个轮次' }); return; }
    const controller = new AbortController(); active = { id: event.input.id, controller };
    void kernel.run(event.input, request, controller.signal).then(result => send({ type: 'complete', runId: event.input.id, ...result }))
      .catch(() => send({ type: 'error', runId: event.input.id, message: controller.signal.aborted ? '对话已停止' : 'DSH执行未完成，请检查本轮事件' }))
      .finally(() => { for (const item of pending.values()) { item.cleanup(); item.reject(new Error('Turn ended')); } pending.clear(); active = undefined; });
  }
});
lines.on('close', () => { active?.controller.abort(); void kernel.dispose().finally(() => process.exit(0)); });
send({ type: 'ready', version: '0.2.1-rc.3', toolMode: 'native', persistence: 'application-owned' });
