# EPUB Reader tools for agents

This optional package exposes the existing authorized reader API over **MCP
stdio**, using the official SDK 1.32.2. It adds no book database, retrieval
engine, model loop, persona or memory store. Core/Android do not import it.

## Install and connect

Requirements: Node.js 22.19+, pnpm, and the explicitly enabled Windows AI reader
development service. The reader can stay at the shelf or minimized. Current
Core/release applications do not expose this service by default.

From this source checkout:

```sh
pnpm --dir integrations/reader-tools install --frozen-lockfile
```

An MCP host starts `main.mjs`. Many hosts use the following configuration shape;
use the equivalent command/args/env fields for other hosts:

```json
{
  "mcpServers": {
    "epub-reader": {
      "command": "node",
      "args": ["/absolute/reader-checkout/integrations/reader-tools/main.mjs"],
      "env": {
        "EPUB_READER_CONNECTION_FILE": "/absolute/private/reader-tools/local.json",
        "EPUB_READER_MCP_MAX_BYTES": "65536"
      }
    }
  }
}
```

On Windows the connection file defaults to
`%LOCALAPPDATA%/dev.epubreader.ai/reader-tools/local.json`; omit that env entry
when using the native default. A WSL adapter needs the corresponding WSL file
path and actual connectivity to Windows loopback. Configure a **file path, not
a copied token**. Credentials are reread for every call and may rotate.

stdout belongs exclusively to MCP JSON-RPC; diagnostics use stderr. Host exit
or caller cancellation aborts local HTTP requests. The reader owns source
teardown and its serial operation slot; disconnect alone does not prove cleanup.

## Contract

- The official SDK handles initialize, tools/list, tools/call and cancellation.
  Connection status/refresh controls work offline. List/call refresh discovery;
  there is no polling. Explicit refresh notifies changes to the tool catalog.
- Only seven known read tools intersected with the actual authorized read-only
  catalog are exposed. Old servers do not acquire unsupported capabilities.
  This adapter exposes no indexing mutations, arbitrary files or native commands.
- Original input schemas are preserved. Output schemas describe the full API
  envelope: `apiVersion`, `ok`, `requestId`, optional budget metadata and `data`
  or `error`. `structuredContent` equals the serialized JSON text content.
  Original text, source identities, anchors and cursors are never rewritten.
- Reader/transport failures use `isError: true`, an error code and retryability.
  Unknown/ungranted tools produce protocol parameter errors; the reader validates
  arguments to known tools. Reads do not change progress, notes or memory.

The default **complete MCP tool-result JSON** budget is 64 KiB; configure 4 KiB
to 1 MiB with `EPUB_READER_MCP_MAX_BYTES`. This excludes discovery schemas and
the outer JSON-RPC request ID. Native results get a smaller budget for the two
content representations and escaping; the completed MCP result is checked too.
The shared transport rejects an older reader's oversized reply rather than
forwarding or truncating it. Increase the configured budget when an intact
source chunk cannot fit. Byte limits do not replace model-context admission.

Guidance favors locating books, searching clues and expanding source passages.
Do not read entire books/libraries by default or equate incomplete search with
absence. Provider limits, conversation, persona and memory belong to the agent.

## Maintenance and focused verification

`client.mjs` is the framework-neutral Node transport reused by the CLI and DSH
plugin; the CLI does not load the MCP SDK. `policy.mjs` holds the common read
whitelist/guidance. `server.mjs` translates MCP only. Keep book/search logic in
the existing reader backend, and install optional integrations separately.

From a development checkout with the existing root dependencies:

```sh
node --import tsx --test integrations/reader-tools/adapter.test.mjs
```

Two focused checks exercise an official MCP client over stdio, authenticated HTTP
and the actual TS service with synthetic source data, plus CLI compatibility.
A separate real-Windows short check verified original/anchor parity and rejection
of oversized legacy replies. That snapshot offered six read tools; the newest
indexed-search/native-budget chain still needs a newer reader build. No model
calls or full suites are needed for this adapter check.

References: [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[official SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[reader API](../../src/features/ai/reader-tools/README.md).
