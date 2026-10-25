# Reader capability tools — development slice

This module exposes five read-only reader tools independently of the companion
panel, current book, model runtime and conversation memory. `catalog.ts` is the
shared discovery/schema source; `service.ts` handles calls and source-bound
pagination; `shelfBackend.ts` adapts the existing repository and canonical EPUB
parser. It never marks a book opened, updates progress or writes conversation
data. Book IDs come from the existing shelf; modern IDs are content hashes,
while legacy local IDs remain device-local.

The first slice provides book discovery/metadata, chapter listing, paged original
passages and single-book lexical search. Search reads chapters on demand and
returns bounded top results, with `truncated` and actual scan coverage. It does
not create a persistent index or claim semantic retrieval. Library-wide indexed
search, index jobs, live reading state, navigation and mutations are subsequent
capabilities and are absent from discovery today.

Native hosts use the existing selective archive port. Browser previews keep one
compressed book in a worker. Both load metadata/navigation first, disable cover
preloading, release scanned chapter bytes and close their owned archive on exit
or cancellation. Calls share a serial queue; cancellation does not release that
queue until the provider confirms teardown.

## Development connection

The optional Vite bridge is an adapter for development, not a packaged API
server. Start an explicit AI dev preview with `EPUB_READER_TOOLS=1`. The Windows
companion launcher has an equivalent `-EnableReaderTools` switch, in addition to
its required local `-TestDirectory`. The switch grants read access to the local
library, including later chapters; it does not change the separate companion
chat's spoiler settings. It is off by default. Core loads no provider.

After successful AI app bootstrap, the provider connects from the shelf page;
no book or companion panel must be open. Only one provider may own a host.
The bridge writes `.cache/reader-tools-<port>.json` in the selected workspace.
This private file contains a loopback address and client credential: do not
commit, log or share it. Other origins and unauthenticated calls are refused.

```sh
node scripts/reader-cli.mjs --connection-file <connection-file> tools --json
node scripts/reader-cli.mjs --connection-file <connection-file> books find --query "title" --json
node scripts/reader-cli.mjs --connection-file <connection-file> chapters list --book <bookId> --json
node scripts/reader-cli.mjs --connection-file <connection-file> text search --book <bookId> --query "term" --json
node scripts/reader-cli.mjs --connection-file <connection-file> text read --book <bookId> --chapter <chapterId> --json
node scripts/reader-cli.mjs --connection-file <connection-file> call reader_read_passages --input-file <request.json> --json
```

`--input-file -` reads an argument object from stdin. Set
`EPUB_READER_CONNECTION_FILE` to omit the repeated connection flag. Machine
results go to stdout as JSON, failures use nonzero exit codes, and `--help`
documents aliases. No model, API key, AIRI or DSH installation is necessary for
these calls. Runtime adapters can consume the same discovered schemas.

The CLI/HTTP contract is intended to survive replacing the development bridge
with a native application host. Packaged/headless service startup and independent
client grants are not implemented by this first slice. A development provider
still requires an open AI app WebView/browser page; it can stay at the shelf.
