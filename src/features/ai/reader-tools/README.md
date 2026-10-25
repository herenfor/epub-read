# Reader capability tools

Standard agent integration is available through the optional
[MCP stdio adapter](../../../../integrations/reader-tools/README.md). It discovers
the same authorized schemas, preserves original data and reports structured
tool errors. DSH and the CLI remain alternative clients; the reader API does
not depend on a bot's persona, conversation or memory.

`catalog.ts` defines discoverable JSON schemas; `service.ts` validates calls,
filters the host's book grant and binds pagination to the source/query.
`shelfBackend.ts` and `bookAccess.ts` reuse the existing repository, selective ZIP
adapter and canonical corpus parser. They do not mark books opened, change
progress, call a model, or read/write conversation memory. Modern book IDs are
content hashes; legacy local IDs remain device-local.

## Windows native development host

The Windows AI debug application owns the authenticated loopback listener and
its lifetime. Enable it explicitly with `-EnableReaderTools` in
`scripts/dev-windows-companion.ps1`, alongside the required local
`-TestDirectory`. Core and release builds do not expose the service. The app
may remain at the shelf or minimized; no book or companion panel must be open.
The main application WebView still performs canonical extraction through IPC;
this is not a standalone headless daemon or an independently packaged service.

The process writes a stable per-client discovery file:
`%LOCALAPPDATA%/dev.epubreader.ai/reader-tools/<clientId>.json`. It contains the
current ephemeral port, credential, grant and service identity. Credentials
rotate on app restart. The file lives with private app settings, not compiler
caches; do not commit, log or distribute it. Other origins, non-loopback peers,
and unauthenticated requests are refused. All requests are bounded JSON; the
service offers no arbitrary file access or general native invoke endpoint.

Default opt-in grants client `local` read access to the visible library,
including later chapters. It does not alter the companion chat's spoiler
settings. Cache preparation requires a separate grant. To name clients and
restrict books, pass `-ReaderToolConfig <local-json-file>` with, for example:

```json
{
  "clients": [
    { "clientId": "pet", "bookIds": null, "prepareIndex": true },
    { "clientId": "reviewer", "bookIds": ["<bookId>"], "prepareIndex": false }
  ]
}
```

`bookIds: null` grants the current visible library; `[]` grants no books.
Permissions are frozen for this process; restart after editing the config.
Each client gets its own credential. Request filters cannot enlarge its grant;
book discovery, metadata and index coverage are filtered as well as original
text. Cache mutation tools are absent from read-only clients' discovery.

The native process serializes foreground calls. A cancelled/timed-out client
keeps its slot until the provider acknowledges source teardown. Capability ZIP
handles and cache tasks belong to that provider; disconnect reclaims only those
handles/tasks, preserving the active reader. A reload explicitly retires the
previous provider identity. Queued calls cannot drift into a different provider.

## CLI

```sh
node scripts/reader-cli.mjs tools --json
node scripts/reader-cli.mjs status --json
node scripts/reader-cli.mjs books find --query "title" --json
node scripts/reader-cli.mjs library search --query "term alternative" --limit 8 --max-response-bytes 16384 --json
node scripts/reader-cli.mjs chapters list --book <bookId> --json
node scripts/reader-cli.mjs text search --book <bookId> --query "term" --json
node scripts/reader-cli.mjs text read --book <bookId> --chapter <chapterId> --json
node scripts/reader-cli.mjs index status --book <bookId> --json
node scripts/reader-cli.mjs index prepare --book <bookId> --json
node scripts/reader-cli.mjs index cancel --book <bookId> --task <taskId> --json
node scripts/reader-cli.mjs call reader_read_passages --input-file <request.json> --json
```

On Windows the CLI discovers native client `local` automatically. Use
`--client <id>`, `--connection-file <file>` or `EPUB_READER_CONNECTION_FILE` to
select a different connection. `--input-file -` reads an argument object from
stdin. JSON goes to stdout; errors use nonzero exit codes. Ctrl+C cancels an
ordinary call. No model key, AIRI, DSH or memory store is needed.

The CLI and optional agent adapters share `integrations/reader-tools/client.mjs`:
it bounds bytes while receiving, rejects oversized legacy replies without
truncating text, checks API/request identity, preserves structured reader errors,
uses a total deadline and rereads credentials per call. The caller still owns
admission of the complete model request.

The five original read tools provide book discovery/metadata, chapter listing,
paged original passages and single-book lexical search. Search extracts chapters
on demand, returns bounded top hits and reports scan coverage. It does not claim
semantic comprehension or enumerate every match. Source availability and empty
chapters are explicit. Read results preserve contentHash, corpusVersion, chunkId
and text anchors shared with the reader's other retrieval paths.

Native hosts additionally provide index coverage and explicit per-book cache
preparation/cancellation. Preparation returns a durable background task; query
`index status` for progress. Same-version completed indices and a running same-book
preparation are reused. Only one preparation runs at a time; it cannot adopt or
cancel the UI's existing library-index job. The existing staging transaction
publishes atomically. Cancellation removes temporary data, preserving a previous
published index. Fixed-layout/text-empty preparation fails without claiming a
usable index. Ordinary queries never initiate a full-library rebuild.

These tasks populate the existing persistent corpus used by library/companion
retrieval. The original `reader_search_text` contract still uses chapter
extraction. `reader_search_library` searches current, available, authorized
books through the existing persistent index; it never opens EPUBs or silently
prepares missing indices. `queries` accepts up to six alternative short clues;
space-separated terms within a clue must occur together. Optional `bookIds`
narrows the granted library, and an empty array searches no books.

Search returns at most 20 short, exact-substring previews (eight by default),
not full chunks. Use a hit's bookId, chapterId and chunkId with
`reader_read_passages`/`aroundChunkId` to inspect its original context. The
anchor identifies the source chunk; `excerpt` is only a preview and is never
substituted into `originalText`.

`coverage` counts scoped/current/missing/outdated/unavailable books. Its
`complete` flag concerns index coverage, not whether every matching passage
was returned or read. `truncated` and `candidateLimitReached` describe result
limits separately. An empty result with incomplete coverage cannot establish
that the entire library has no answer. Scope is passed to SQL before ranking
and Top-K. The browser development provider does not advertise indexed search
unless an implementation is attached.

## Response and model-context budgets

Tool calls accept optional `maxResponseBytes` on the request envelope, outside
model-generated `arguments`: 1024–262144 bytes, default 32768. The bound covers
the complete serialized UTF-8 reply, including identities, cursors and budget
metadata. `responseBudget.limited` indicates that the byte cap reduced the
requested item count. Passage text is never silently shortened; the next
cursor advances by the number actually returned. If even one item cannot fit,
the service reports `RESPONSE_BUDGET_EXCEEDED` rather than an empty looping page.
The discovery/status endpoints are not tool-call response budgets.

Byte limits are not token counts. An agent must also check its assembled model
input, including history and tool definitions. The independent helper
`scripts/reader-model-context.mjs` provides that last gate without owning a
model, conversation, tokenizer or memory:

```js
const admitted = await admitReaderModelInput({
  request: assembledProviderRequest,
  countInputTokens: providerInputCounter,
  contextTokens: configuredModelWindow,
  reservedTokens: outputAndReasoningReserve,
  safetyTokens: 256,
});
// Send admitted.body unchanged only after admission succeeds.
```

Supply a provider-aware tokenizer/counting API or a proven conservative upper
bound; the helper supplies no character-to-token guess. It snapshots and freezes
the complete JSON request before counting, so concurrent history changes cannot
replace the counted payload. Overflow throws `MODEL_CONTEXT_LIMIT` before any
model dispatch. The caller can then reduce response size or compact its own
context. Output and reasoning reserves follow the provider's accounting rules.
Other agents must implement the same final check; the reader cannot determine
their private remaining context. There is no fixed per-question chapter quota.

Tool descriptions recommend searching and reading relevant surrounding text
first, with broader reading when evidence requires it. This API does not replace
original text with generated summaries or claim that reading a preview means
having read a chapter/book.

The design follows the separation of useful tool operations, concise results
and descriptive schemas in [Anthropic's tool design guidance](https://www.anthropic.com/research/writing-tools-for-agents)
and the [MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
These are design references; this module does not implement an MCP server or
adopt a separate retrieval framework.

## Browser development fallback

The opt-in Vite adapter (`EPUB_READER_TOOLS=1`) remains for browser-only work and
writes `.cache/reader-tools-<port>.json`. Pass that file explicitly to the CLI.
It exposes the original five read tools, requires one connected AI development
page and has no native persistent-index operations. Native windows use the
application service instead of registering with this fallback. Both transports
share the same dispatcher and framework-neutral results.
