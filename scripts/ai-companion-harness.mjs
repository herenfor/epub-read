import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LIMIT = 16 * 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('Harness frame too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** AI development only. Warm native Node host; transient turn protocol never
 * reaches a global DSH profile or a file. The key stays in the browser transport. */
export function installCompanionHarness(server) {
  const directory = resolve(server.config.root, 'experiments/companion-harness');
  let child;
  let ready;
  let active;

  const send = frame => child?.stdin.write(JSON.stringify(frame) + '\n');
  const publish = frame => active?.response.write(JSON.stringify(frame) + '\n');
  function stop() {
    const old = child;
    child = undefined; ready = undefined;
    if (active) { publish({ type: 'error', message: 'DSH宿主已停止；可重新发问' }); active.response.end(); active = undefined; }
    old?.kill();
  }
  function start() {
    if (ready) return ready;
    if (!existsSync(resolve(directory, 'node_modules/@deepseek-ai/dsh-agent-loop'))) {
      throw new Error('尚未安装DSH实验宿主，请按模块说明安装');
    }
    const processHandle = spawn(process.execPath, ['--disable-warning=UNDICI-EHPA', 'host.mjs'], {
      cwd: directory, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      // Do not inherit a user's DSH connection credentials/profile selection.
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DEEPSEEK_API_KEY$|OPENAI_API_KEY$)/i.test(name))),
    });
    child = processHandle;
    ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { reject(new Error('DSH宿主启动超时')); stop(); }, 15000);
      const fail = () => {
        clearTimeout(timer); reject(new Error('DSH宿主未能启动'));
        if (child === processHandle) stop();
      };
      processHandle.once('error', fail);
      processHandle.once('exit', fail);
      processHandle.stdin.on('error', () => { if (child === processHandle) stop(); });
      const lines = createInterface({ input: processHandle.stdout });
      lines.on('line', line => {
        if (child !== processHandle) return;
        let frame;
        try { frame = JSON.parse(line); } catch { stop(); return; }
        if (frame.type === 'ready') { clearTimeout(timer); resolveReady(frame); return; }
        if (!active || frame.runId !== active.id) return;
        if (frame.type === 'request') active.pending.add(frame.id);
        publish(frame);
        if (frame.type === 'complete' || frame.type === 'error') {
          const response = active.response;
          active = undefined;
          response.end();
        }
      });
    });
    return ready;
  }
  server.httpServer?.once('close', stop);
  server.middlewares.use('/__ai-companion/harness', async (request, response) => {
    const origin = `http://${request.headers.host}`;
    if (!loopback.has(request.socket.remoteAddress) || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '')
      || request.headers.origin && request.headers.origin !== origin) {
      response.writeHead(403); response.end(); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const path = new URL(request.url ?? '/', origin).pathname;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (path === '/status' && request.method === 'GET') {
        response.end(JSON.stringify({ installed: existsSync(resolve(directory, 'node_modules/@deepseek-ai/dsh-agent-loop')),
          running: Boolean(child), busy: Boolean(active), version: '0.2.1-rc.3', platform: process.platform })); return;
      }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const token = request.headers['x-companion-token'];
      if (typeof token !== 'string' || token.length < 32) { response.writeHead(403); response.end(); return; }
      const body = await readBody(request);
      if (path === '/run') {
        if (active) { response.writeHead(409); response.end(JSON.stringify({ message: 'DSH正忙，请等上一轮停止' })); return; }
        if (typeof body.id !== 'string' || typeof body.question !== 'string' || typeof body.system !== 'string'
          || typeof body.model !== 'string' || !Array.isArray(body.tools)) throw new Error('无效的运行参数');
        // Reserve before async startup so two windows cannot take the same host.
        active = { id: body.id, token, response, pending: new Set() };
        const owner = active;
        response.once('close', () => { if (active === owner) stop(); });
        await start();
        if (active !== owner || response.destroyed) return;
        response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        response.flushHeaders();
        send({ type: 'run', input: body }); return;
      }
      if (!active || body.runId !== active.id || token !== active.token) { response.writeHead(409); response.end(); return; }
      if (path === '/reply' && active.pending.delete(body.id)) {
        send({ type: 'result', id: body.id, ...(body.error ? { error: true } : { value: body.value }) });
        response.writeHead(204); response.end(); return;
      }
      response.writeHead(404); response.end();
    } catch (error) {
      if (active?.response === response) { active = undefined; stop(); }
      if (!response.headersSent) response.writeHead(400);
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'DSH连接未完成' }));
    }
  });
}
