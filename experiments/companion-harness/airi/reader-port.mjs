import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { selectReaderTools } from './reader-policy.mjs';

export async function createReaderPort(execution, reader) {
  const catalog = await reader('/tools');
  if (!catalog.ok) throw new Error('Reader tools are not ready');
  const permitted = selectReaderTools(catalog.data.tools);
  const allowed = new Set(permitted.map(tool => tool.name));
  const child = spawn(execution.command, execution.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  const callbacks = new Map();
  const calls = new Set();
  let queue = Promise.resolve();
  let closed = false;
  let failed;
  let resolveReady; let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const send = event => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(event) + '\n'); };
  const exited = new Promise(resolve => child.once('close', resolve));
  const fail = () => {
    failed = new Error('DSH reader host is unavailable');
    rejectReady(failed);
    for (const item of waiting.values()) item.reject(failed);
    waiting.clear();
    for (const controller of callbacks.values()) controller.abort();
  };
  child.on('error', fail);
  child.on('close', fail);
  child.stdin.on('error', fail);
  child.stderr.resume(); // SDK diagnostics never enter a conversation or tool output.
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { fail(); child.kill(); return; }
    if (event.type === 'ready') resolveReady(event.tools);
    else if (event.type === 'request') {
      if (!allowed.has(event.name)) { send({ type: 'reply', id: event.id, error: true }); return; }
      const controller = new AbortController();
      callbacks.set(event.id, controller);
      void reader('/call', { name: event.name, arguments: event.arguments }, controller.signal)
        .then(value => send({ type: 'reply', id: event.id, value }),
          () => send({ type: 'reply', id: event.id, error: true }))
        .finally(() => callbacks.delete(event.id));
    } else if (event.type === 'cancel-request') callbacks.get(event.id)?.abort();
    else if (event.type === 'result' || event.type === 'error') {
      const item = waiting.get(event.id);
      if (!item) { if (!event.id && event.type === 'error') rejectReady(new Error('DSH initialization failed')); return; }
      waiting.delete(event.id);
      if (event.type === 'error') item.reject(new Error('Reader dispatch failed'));
      else item.resolve(event.result);
    }
  });
  send({ type: 'init', tools: permitted });
  const startupTimer = setTimeout(() => { fail(); child.kill(); }, 15_000);
  let tools;
  try { tools = await ready; } catch (error) { child.stdin.end(); await exited; throw error; }
  finally { clearTimeout(startupTimer); }

  async function cancelAll() {
    const owned = [...calls];
    for (const operation of owned) operation.controller.abort();
    await Promise.allSettled(owned.map(operation => operation.done));
    return { ok: true, cancelled: owned.length };
  }
  return {
    tools,
    call(name, args, signal) {
      if (closed || failed) return Promise.reject(failed ?? new Error('Reader port is closed'));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) controller.abort();
      const operation = { controller };
      calls.add(operation);
      operation.done = queue.then(async () => {
        controller.signal.throwIfAborted();
        if (failed) throw failed;
        const id = randomUUID();
        const abort = () => send({ type: 'cancel', id });
        const result = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
        controller.signal.addEventListener('abort', abort, { once: true });
        send({ type: 'call', id, name, arguments: args });
        try {
          const outcome = await result;
          controller.signal.throwIfAborted();
          if (outcome.isError) throw new Error(outcome.error?.message ?? 'DSH rejected the reader call');
          return outcome.value;
        } finally { controller.signal.removeEventListener('abort', abort); }
      }).finally(() => { calls.delete(operation); signal?.removeEventListener('abort', cancel); });
      queue = operation.done.catch(() => {});
      return operation.done;
    },
    cancelAll,
    status() { return { available: !closed && !failed, pending: calls.size, inFlight: callbacks.size, tools: tools.map(tool => tool.name) }; },
    async dispose() {
      if (closed) return;
      closed = true;
      await cancelAll();
      send({ type: 'shutdown' });
      child.stdin.end();
      await exited;
      lines.close();
    },
  };
}
