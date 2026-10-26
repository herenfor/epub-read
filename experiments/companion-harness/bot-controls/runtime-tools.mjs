// Resolve the active runtime's tools scheduler, including profile peer copies.
// This adapter does not pin or reject DSH releases. Only copies of the same
// tools version are unified; unrelated runtime versions keep their own loader.
import * as modules from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const versionOf = entry => JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
try {
  let loop;
  if (process.env.DSH_RUNTIME_ENTRY) {
    const runtime = realpathSync(process.env.DSH_RUNTIME_ENTRY);
    const sdk = modules.createRequire(runtime).resolve('@deepseek-ai/dsh-sdk-app');
    loop = modules.createRequire(sdk).resolve('@deepseek-ai/dsh-agent-loop');
  } else {
    loop = realpathSync(process.env.BOT_CONTROLS_LOOP_ENTRY);
  }
  const tools = realpathSync(modules.createRequire(loop).resolve('@deepseek-ai/dsh-tools'));
  const version = versionOf(tools);
  if (version !== versionOf(loop) || typeof modules.registerHooks !== 'function') {
    process.emitWarning('DSH tools adapter is unavailable; using the native loader.');
  } else {
    const canonical = pathToFileURL(tools).href;
    modules.registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (!result.url.startsWith('file:')) return result;
      const file = fileURLToPath(result.url);
      if (!file.replaceAll('\\', '/').endsWith('/@deepseek-ai/dsh-tools/lib/index.js')) return result;
      return versionOf(file) === version ? { ...result, url: canonical } : result;
    } });
  }
} catch {
  process.emitWarning('DSH tools adapter could not resolve this runtime; using the native loader.');
}
