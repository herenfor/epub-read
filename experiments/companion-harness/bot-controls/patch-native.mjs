import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const original = 'if (!isChannelRecord(record, channelId) || ended && (record.type !== "group" || !record.deletedAt)) throw unsupported();';
const patched = 'if (!isChannelRecord(record, channelId) || ended && !(record.type === "dm" && record.botSlug && record.id === "dm-" + record.botSlug) && (record.type !== "group" || !record.deletedAt)) throw unsupported(); // local-bot-controls:active-owner-dm-v1';

/** Preserve all native purge authority/ledger checks, adding only the owner's
 * canonical private Bot DMs to the existing ended-group selection operation. */
export function patchNativeSource(source) {
  if (source.includes(patched)) return source;
  if (source.split(original).length !== 2) throw new Error('Unsupported native purge implementation');
  return source.replace(original, patched);
}
export async function installNativePatch(profile) {
  const profileRoot = await realpath(resolve(profile));
  const root = await realpath(join(profileRoot, 'node_modules/@botharness/core'));
  const local = relative(profileRoot, root);
  if (!local || local === '..' || local.startsWith('..' + sep)) throw new Error('Native core must be inside the selected private profile');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '1.5.2') throw new Error('Bot controls require reviewed Tobs core 1.5.2');
  const file = join(root, 'dist/index.mjs');
  const before = await readFile(file, 'utf8'); const after = patchNativeSource(before);
  if (after !== before) {
    // Atomic replacement breaks pnpm's hard link. Never write into its shared
    // content-addressed store or change the daily DSH installation.
    const temporary = file + '.bot-controls.tmp';
    await writeFile(temporary, after); await rename(temporary, file);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await installNativePatch(process.argv[2]); }
  catch { console.error('Bot controls: incompatible local Tobs installation; no startup.'); process.exitCode = 1; }
}
