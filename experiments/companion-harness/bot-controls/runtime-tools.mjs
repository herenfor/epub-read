/** Private-host preload for DSH 0.2.1-rc.3. Its scheduler key uses Symbol(),
 * so pnpm peer copies of dsh-tools cannot exchange tools with one another.
 * Resolve them to the loop's one module instance without editing installed SDK
 * files or changing another host/process. */
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const loopEntry = process.env.BOT_CONTROLS_LOOP_ENTRY;
if (!loopEntry) throw new Error('Bot controls preload requires BOT_CONTROLS_LOOP_ENTRY from the selected private host');
const versionOf = entry => JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
if (versionOf(loopEntry) !== '0.2.1-rc.3') throw new Error('Review the tools preload before upgrading the selected DSH loop');
const toolsEntry = realpathSync(createRequire(loopEntry).resolve('@deepseek-ai/dsh-tools'));
if (versionOf(toolsEntry) !== '0.2.1-rc.3') throw new Error('The selected loop and tools versions must match');
const canonical = pathToFileURL(toolsEntry).href;

registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (!result.url.startsWith('file:')) return result;
  const file = fileURLToPath(result.url);
  if (!file.replaceAll('\\', '/').endsWith('/@deepseek-ai/dsh-tools/lib/index.js')) return result;
  if (versionOf(file) !== '0.2.1-rc.3') throw new Error('Mixed DSH tools versions are not supported by this private host');
  return { ...result, url: canonical };
} });
