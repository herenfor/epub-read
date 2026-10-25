import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createReaderClient, readerConnectionFile, readerFailure as fail } from '../integrations/reader-tools/client.mjs';

const help = `EPUB Reader tools (Windows AI development)
  node scripts/reader-cli.mjs --connection-file <file> tools --json
  node scripts/reader-cli.mjs --connection-file <file> books find --query <text> --json
  node scripts/reader-cli.mjs --connection-file <file> book get --book <id> --json
  node scripts/reader-cli.mjs --connection-file <file> chapters list --book <id> --json
  node scripts/reader-cli.mjs --connection-file <file> library search --query <text> --json
  node scripts/reader-cli.mjs --connection-file <file> text search --book <id> --query <text> --json
  node scripts/reader-cli.mjs --connection-file <file> text read --book <id> --chapter <id> --json
  node scripts/reader-cli.mjs --connection-file <file> call <tool> --input-file <json-file or -> --json
  node scripts/reader-cli.mjs status --json
  node scripts/reader-cli.mjs index status --book <id> --json
  node scripts/reader-cli.mjs index prepare --book <id> --json
  node scripts/reader-cli.mjs index cancel --book <id> --task <id> --json
Windows native default: %LOCALAPPDATA%/dev.epubreader.ai/reader-tools/<client>.json (client=local).
Use --client <id> or --connection-file <file>. Browser development still writes .cache/reader-tools-<port>.json.
Use --max-response-bytes <1024..262144> to bound a complete tool reply (default 32768).
This client provides reading and optional index preparation; it does not call a model or access conversation memory.
`;
export async function runReaderCli(argv, { stdin = process.stdin } = {}) {
  if (argv.includes('--help') || argv.length === 0) return { help, exitCode: 0 };
  const flags = {}; const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') continue;
    if (argv[i].startsWith('--')) {
      if (!['connection-file', 'client', 'max-response-bytes', 'task', 'book', 'chapter', 'query', 'cursor', 'around-chunk', 'folder-id', 'limit', 'favorite', 'input-file'].includes(argv[i].slice(2))) {
        return { result: fail('INVALID_ARGUMENTS', `Unknown option ${argv[i]}`), exitCode: 2 };
      }
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { result: fail('INVALID_ARGUMENTS', `${argv[i]} needs a value`), exitCode: 2 };
      flags[argv[i].slice(2)] = argv[++i];
    } else words.push(argv[i]);
  }
  const client = flags.client ?? 'local';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(client)) return { result: fail('INVALID_ARGUMENTS', 'Invalid client ID'), exitCode: 2 };
  const path = flags['connection-file'] ?? readerConnectionFile(client);
  const maxResponseBytes = flags['max-response-bytes'] === undefined ? 32768 : Number(flags['max-response-bytes']);
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 262144)
    return { result: fail('INVALID_ARGUMENTS', 'Response budget must be an integer from 1024 to 262144 bytes'), exitCode: 2 };
  let name; const args = {};
  const command = words.join(' ');
  if (command === 'library search') name = 'reader_search_library';
  else if (command === 'index status') name = 'reader_get_index_status';
  else if (command === 'index prepare') name = 'reader_prepare_index';
  else if (command === 'index cancel') name = 'reader_cancel_index';
  else if (command === 'books find') name = 'reader_find_books';
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
  } else if (!['tools', 'status'].includes(command)) return { result: fail('INVALID_ARGUMENTS', 'Unknown command; use --help'), exitCode: 2 };
  for (const [flag, field] of Object.entries({ task: 'taskId', book: 'bookId', chapter: 'chapterId', query: 'query', cursor: 'cursor', 'around-chunk': 'aroundChunkId', 'folder-id': 'folderId' })) {
    if (flags[flag] !== undefined) args[field] = flags[flag];
  }
  if (name === 'reader_search_library' && flags.query !== undefined) { args.queries = [flags.query]; delete args.query; }
  if (name === 'reader_search_library' && flags.book !== undefined) { args.bookIds = [flags.book]; delete args.bookId; }
  if (flags.limit !== undefined) args.limit = Number(flags.limit);
  if (flags.favorite !== undefined) args.favorite = flags.favorite === 'true' ? true : flags.favorite === 'false' ? false : flags.favorite;
  const controller = new AbortController();
  const interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
  try {
    const route = name ? '/call' : command === 'status' ? '/status' : '/tools';
    const call = createReaderClient(path, { maxResponseBytes: name ? maxResponseBytes : 262144 });
    const result = await call(route, name ? { name, arguments: args } : undefined, controller.signal);
    return { result, exitCode: result.ok ? 0 : 1 };
  } catch (error) {
    return { result: fail(error.code ?? 'READER_UNAVAILABLE', error.message, error.retryable ?? false), exitCode: 1 };
  } finally { process.removeListener('SIGINT', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reply = await runReaderCli(process.argv.slice(2));
    process.stdout.write(reply.help ?? JSON.stringify(reply.result) + '\n'); process.exitCode = reply.exitCode;
  } catch { process.stdout.write(JSON.stringify(fail('INVALID_ARGUMENTS', 'Invalid connection or input JSON')) + '\n'); process.exitCode = 2; }
}
