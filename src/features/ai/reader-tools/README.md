# Reader capability tools

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
extraction; library-wide indexed search is a separate subsequent capability.

## Browser development fallback

The opt-in Vite adapter (`EPUB_READER_TOOLS=1`) remains for browser-only work and
writes `.cache/reader-tools-<port>.json`. Pass that file explicitly to the CLI.
It exposes the original five read tools, requires one connected AI development
page and has no native persistent-index operations. Native windows use the
application service instead of registering with this fallback. Both transports
share the same dispatcher and framework-neutral results.
