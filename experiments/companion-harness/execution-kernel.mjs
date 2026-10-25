import { realpath, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Projections from '@deepseek-ai/dsh-session-projection';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import SandboxBash from '@deepseek-ai/dsh-bash-sandbox';

// This is an execution port, not another model loop. The parent fixes its
// authority at startup; tool arguments cannot replace this policy or cwd.
export async function createExecutionKernel({ workspace, mode = 'read-only' }) {
  if (!['read-only', 'workspace-write'].includes(mode)) throw new Error('Unsupported file policy');
  if (!workspace || !isAbsolute(workspace)) throw new Error('An absolute workspace is required');
  workspace = await realpath(workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
  const ctx = new Context();
  const fibers = [];
  const dispose = async () => { for (const fiber of fibers.splice(0).reverse()) await fiber.dispose(); };
  try {
    for (const [plugin, config] of [
      [Projections], [SandboxPolicy, { mode, workspaceRoot: workspace }],
      [LocalSandbox], [LocalSubprocess],
      [SandboxBash, { cwd: workspace, timeoutMs: 30_000, maxTimeoutMs: 30_000,
        maxOutputBytes: 64 * 1024, maxSpillBytes: 64 * 1024, graceMs: 200 }],
    ]) fibers.push(await ctx.plugin(plugin, config));
    // Uses the real provider's functional runner probe; no custom runner or
    // unconfined fallback. This prepares argv, it does not run a second task.
    const prepared = await ctx.sandbox.confine(['true'], ctx.sandboxPolicy.resolve());
    const boundary = Object.freeze({ mode, workspace, runner: basename(prepared.argv[0]),
      enforcement: prepared.enforcement, scope: 'file-effects' });
    return {
      boundary,
      async run(command, signal) {
        const execution = await ctx.shell.execute(ctx.shell.resolve({ command, signal }));
        const result = await execution.result(); // includes managed-range quiescence
        try {
          return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
            aborted: result.aborted, stdout: { text: result.stdout.text, truncated: result.stdout.truncated },
            stderr: { text: result.stderr.text, truncated: result.stderr.truncated },
            // The startup probe is not proof that this particular run started.
            // In particular, a cancelled preparation has no enforcement fact.
            sandbox: { workspace, scope: boundary.scope, ...result.sandbox } };
        } finally {
          // This port returns bounded tails, never spill paths or persistent logs.
          await Promise.all([result.stdout.spillPath, result.stderr.spillPath].filter(Boolean)
            .map(path => unlink(path)));
        }
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
