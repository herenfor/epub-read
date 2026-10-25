import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: {
  'airi-data': { type: 'string' }, 'harness-dir': { type: 'string' },
  'wsl-distro': { type: 'string' }, node: { type: 'string' }, 'connection-file': { type: 'string' },
  'airi-app': { type: 'string' },
} });
const directory = values['airi-data'];
if (!directory || !isAbsolute(directory) || !values['harness-dir']) {
  throw new Error('Pass --airi-data <absolute private directory> and --harness-dir <execution-host directory>');
}
if (values['wsl-distro'] && (process.platform !== 'win32' || !values.node || !values['harness-dir'].startsWith('/'))) {
  throw new Error('WSL mode requires Windows Node, --node <absolute Linux Node> and a Linux harness directory');
}
const connectionFile = values['connection-file'] ?? (process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'dev.epubreader.ai', 'reader-tools', 'local.json') : undefined);
if (!connectionFile || !isAbsolute(connectionFile)) throw new Error('Pass --connection-file <native reader discovery file>');
const target = join(directory, 'extensions', 'v1', 'epub-reader-tools');
await mkdir(target, { recursive: true });
for (const file of ['extension.mjs', 'reader-port.mjs', 'reader-client.mjs', 'reader-policy.mjs']) {
  await copyFile(fileURLToPath(new URL(file, import.meta.url)), join(target, file));
}
const manifest = JSON.parse(await readFile(new URL('extension.airi.json', import.meta.url), 'utf8'));
// AIRI 0.12's filesystem loader passes absolute paths straight to import().
// /D:/... is an ESM URL path; D:\... is incorrectly treated as the d: scheme.
// Only the installed private manifest contains this machine-specific path.
if (process.platform === 'win32') manifest.entrypoints.electron = pathToFileURL(join(target, 'extension.mjs')).pathname;
await writeFile(join(target, 'extension.airi.json'), JSON.stringify(manifest, null, 2) + '\n');
const host = values['wsl-distro'] ? values['harness-dir'].replace(/\/$/, '') + '/reader-host.mjs'
  : join(values['harness-dir'], 'reader-host.mjs');
const execution = values['wsl-distro']
  ? { command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'),
    args: ['-d', values['wsl-distro'], '--exec', values.node, host] }
  : { command: values.node ?? process.execPath, args: [host] };
await writeFile(join(target, 'config.json'), JSON.stringify({ connectionFile, execution }, null, 2) + '\n');
const configPath = join(directory, 'extensions-v1.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; config = { enabled: [], autoReload: [], known: {} }; }
config.enabled = [...new Set([...config.enabled, 'epub-reader-tools'])];
config.known['epub-reader-tools'] = { path: join(target, 'extension.airi.json') };
await writeFile(configPath + '.tmp', JSON.stringify(config, null, 2) + '\n');
await rename(configPath + '.tmp', configPath);
if (values['airi-app']) {
  if (process.platform !== 'win32' || !isAbsolute(values['airi-app'])) throw new Error('--airi-app requires an absolute Windows executable path');
  const executable = relative(directory, values['airi-app']);
  if (/[\r\n%]/.test(executable)) throw new Error('The launcher path cannot contain newlines or percent signs');
  await writeFile(join(directory, 'start-airi.cmd'), '@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\n'
    + 'set "APP_USER_DATA_PATH=%~dp0"\r\n' + `start "" "%~dp0${executable}"\r\n`);
}
process.stdout.write('Reader extension installed. Start AIRI with APP_USER_DATA_PATH set to the selected directory.\n');
