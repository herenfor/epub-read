import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const help = `EPUB Reader tools (development)
  node scripts/reader-cli.mjs --connection-file <file> tools --json
  node scripts/reader-cli.mjs --connection-file <file> books find --query <text> --json
  node scripts/reader-cli.mjs --connection-file <file> book get --book <id> --json
  node scripts/reader-cli.mjs --connection-file <file> chapters list --book <id> --json
  node scripts/reader-cli.mjs --connection-file <file> text search --book <id> --query <text> --json
  node scripts/reader-cli.mjs --connection-file <file> text read --book <id> --chapter <id> --json
  node scripts/reader-cli.mjs --connection-file <file> call <tool> --input-file <json-file or -> --json
Connection files are written to .cache/reader-tools-<port>.json by the opt-in AI dev host.
This client reads books; it does not call a model or access conversation memory.
`;
const fail = (code, message, retryable = false) => ({ apiVersion: '1', ok: false, error: { code, message, retryable } });
export async function runReaderCli(argv, { fetcher = fetch, stdin = process.stdin } = {}) {
  if (argv.includes('--help') || argv.length === 0) return { help, exitCode: 0 };
  const flags = {}; const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') continue;
    if (argv[i].startsWith('--')) {
      if (!['connection-file', 'book', 'chapter', 'query', 'cursor', 'around-chunk', 'folder-id', 'limit', 'favorite', 'input-file'].includes(argv[i].slice(2))) {
        return { result: fail('INVALID_ARGUMENTS', `Unknown option ${argv[i]}`), exitCode: 2 };
      }
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { result: fail('INVALID_ARGUMENTS', `${argv[i]} needs a value`), exitCode: 2 };
      flags[argv[i].slice(2)] = argv[++i];
    } else words.push(argv[i]);
  }
  const path = flags['connection-file'] ?? process.env.EPUB_READER_CONNECTION_FILE;
  if (!path) return { result: fail('CONNECTION_REQUIRED', 'Pass --connection-file or EPUB_READER_CONNECTION_FILE'), exitCode: 2 };
  let connection;
  try { connection = JSON.parse(await readFile(path, 'utf8')); }
  catch { return { result: fail('CONNECTION_UNAVAILABLE', 'The local reader connection file is unavailable'), exitCode: 2 }; }
  const endpoint = new URL(connection.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !connection.token) {
    return { result: fail('INVALID_CONNECTION', 'Expected an authenticated loopback reader endpoint'), exitCode: 2 };
  }
  let name; const args = {};
  const command = words.join(' ');
  if (command === 'books find') name = 'reader_find_books';
  else if (command === 'book get') name = 'reader_get_book';
  else if (command === 'chapters list') name = 'reader_list_chapters';
  else if (command === 'text search') name = 'reader_search_text';
  else if (command === 'text read') name = 'reader_read_passages';
  else if (words[0] === 'call' && words.length === 2) {
    name = words[1];
    if (!flags['input-file']) return { result: fail('INVALID_ARGUMENTS', 'call requires --input-file'), exitCode: 2 };
    let text;
    if (flags['input-file'] === '-') { const chunks = []; for await (const chunk of stdin) chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); }
    else text = await readFile(flags['input-file'], 'utf8');
    const input = JSON.parse(text);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { result: fail('INVALID_ARGUMENTS', 'Tool input must be an object'), exitCode: 2 };
    Object.assign(args, input);
  } else if (command !== 'tools') return { result: fail('INVALID_ARGUMENTS', 'Unknown command; use --help'), exitCode: 2 };
  for (const [flag, field] of Object.entries({ book: 'bookId', chapter: 'chapterId', query: 'query', cursor: 'cursor', 'around-chunk': 'aroundChunkId', 'folder-id': 'folderId' })) {
    if (flags[flag] !== undefined) args[field] = flags[flag];
  }
  if (flags.limit !== undefined) args.limit = Number(flags.limit);
  if (flags.favorite !== undefined) args.favorite = flags.favorite === 'true' ? true : flags.favorite === 'false' ? false : flags.favorite;
  const controller = new AbortController();
  const interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
  const timer = setTimeout(interrupt, 125000);
  try {
    const response = await fetcher(`${connection.endpoint}/${name ? 'call' : 'tools'}`, { method: name ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, signal: controller.signal, redirect: 'error',
      ...(name ? { body: JSON.stringify({ requestId: randomUUID(), name, arguments: args }) } : {}) });
    const result = await response.json();
    return { result, exitCode: response.ok && result.ok ? 0 : 1 };
  } catch {
    return { result: fail(controller.signal.aborted ? 'CANCELLED' : 'APP_NOT_RUNNING',
      controller.signal.aborted ? 'Reader call cancelled' : 'The AI reader host is not reachable', !controller.signal.aborted), exitCode: 1 };
  } finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reply = await runReaderCli(process.argv.slice(2));
    process.stdout.write(reply.help ?? JSON.stringify(reply.result) + '\n'); process.exitCode = reply.exitCode;
  } catch { process.stdout.write(JSON.stringify(fail('INVALID_ARGUMENTS', 'Invalid connection or input JSON')) + '\n'); process.exitCode = 2; }
}
