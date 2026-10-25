import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('real execution port confines writes and cancellation settles descendants before the next call', { timeout: 30_000 }, async t => {
  // Outside /tmp: bwrap deliberately mounts a private temporary filesystem.
  const cache = join(here, '../../.cache');
  await mkdir(cache, { recursive: true });
  const fixture = await mkdtemp(join(cache, 'execution-boundary-'));
  const workspace = join(fixture, 'workspace');
  await mkdir(workspace);
  const child = spawn(process.execPath, ['execution-host.mjs', '--workspace', workspace, '--mode', 'workspace-write'],
    { cwd: here, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const waiters = new Set();
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const event = JSON.parse(line);
    events.push(event);
    for (const notify of waiters) notify();
  });
  const wait = (type, id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Missing ${type}/${id ?? '*'}: ${JSON.stringify(events)} ${stderr}`));
    }, 10_000);
    const check = () => {
      const index = events.findIndex(event => event.type === type && (id === undefined || event.id === id));
      if (index < 0) return;
      clearTimeout(timer); waiters.delete(check); resolve(events.splice(index, 1)[0]);
    };
    waiters.add(check); check();
  });
  const send = event => child.stdin.write(JSON.stringify(event) + '\n');
  const call = async (id, command) => { send({ type: 'call', id, command }); return wait('result', id); };
  try {
    const ready = await wait('ready');
    assert.equal(ready.sandbox.enforcement, 'full');
    t.diagnostic(`Actual runner: ${ready.sandbox.runner}; enforcement: ${ready.sandbox.enforcement}`);
    const inside = await call('inside', 'printf fixture > inside.txt');
    assert.equal(inside.exitCode, 0);
    assert.equal(inside.sandbox.mode, 'workspace-write');
    assert.equal(inside.sandbox.enforcement, 'full');
    assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'fixture');

    const outside = await call('outside', 'printf forbidden > ../outside.txt');
    assert.notEqual(outside.exitCode, 0);
    assert.equal(outside.sandbox.denied, true);
    await assert.rejects(access(join(fixture, 'outside.txt')), { code: 'ENOENT' });

    send({ type: 'call', id: 'override', command: 'true', mode: 'danger-full-access' });
    assert.equal((await wait('error', 'override')).code, 'INVALID_REQUEST');

    const descendant = 'const fs=require("node:fs");fs.writeFileSync("child-started.txt",String(Date.now()));'
      + 'setTimeout(()=>fs.writeFileSync("late.txt","leaked"),1500);setInterval(()=>{},1000);';
    const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}]);setInterval(()=>{},1000);`;
    send({ type: 'call', id: 'cancel-me', command: `${quote(process.execPath)} -e ${quote(parent)}` });
    let startedAt;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { startedAt = Number(await readFile(join(workspace, 'child-started.txt'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(20); }
    }
    assert.ok(startedAt, 'The actual descendant started before cancellation');
    send({ type: 'status', id: 'running' });
    assert.equal((await wait('status', 'running')).active.id, 'cancel-me');
    send({ type: 'cancel', id: 'cancel-me' });
    assert.equal((await wait('cancelling', 'cancel-me')).accepted, true);
    const cancelled = await wait('result', 'cancel-me');
    assert.equal(cancelled.aborted, true);
    assert.equal(cancelled.timedOut, false);
    assert.equal((await call('after-cancel', 'printf next')).stdout.text, 'next');
    await delay(Math.max(0, startedAt + 1700 - Date.now()));
    await assert.rejects(access(join(workspace, 'late.txt')), { code: 'ENOENT' });
    send({ type: 'status', id: 'idle' });
    assert.equal((await wait('status', 'idle')).active, null);
    send({ type: 'shutdown', id: 'stop' });
    await wait('closed');
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    lines.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
