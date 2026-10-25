# EPUB Reader tools for a DSH chat host

This optional native plugin connects a DSH-owned conversation to the reader's
authorized local service. DSH owns the model loop, provider configuration,
conversation UI and native session log. The plugin owns only reader tool
registration and HTTP calls. It creates no second agent, memory store, model
request, shell tool, timer or automatic indexing task.

DSH is one adapter for the reader's framework-neutral HTTP/CLI contract. Other
clients do not need this host's bot, persona or memory. AIRI is not needed.
Core/Android do not import this package.

## Install in a dedicated host

The tested native registry API is DSH **0.2.1-rc.3**. The package intentionally
declares that exact engine/peer range; do not bypass a compatibility refusal or
silently upgrade a daily DSH installation. Use a separate DSH home for this
experiment so model, persona and plugin settings do not affect ordinary work.

From the trusted DSH executable for that installation:

```sh
dsh plugin --profile web add file:/absolute/path/to/reader-plugin
```

The package's bundle registers `epub-reader-tools`. Use `file:` so pnpm installs
the package with its peer dependencies in the target profile; a plain directory
can become a link that instead resolves peers from the source workspace.
The native-registry check below is independent of the live-host acceptance
described in `../chat-host/README.md`.

On Windows the plugin discovers the reader's private `local` connection file
automatically. The AI reader service must be explicitly enabled as described in
`src/features/ai/reader-tools/README.md`. The reading panel need not be open.
For another client set the **host environment** `EPUB_READER_CONNECTION_FILE`,
or set `connectionFile` on the plugin's profile row. Never put the connection
file's contents or its token into a prompt. Both processes must be able to reach
the connection's loopback endpoint; a Windows localhost address is not a claim
that a separate WSL/network namespace can reach it.

To configure the row explicitly, use the host profile's `cordis.patch.yml`:

```yaml
- id: epub-reader-tools
  name: epub-reader-dsh-tools
  config:
    connectionFile: /absolute/private/reader-connection.json
    maxResponseBytes: 16384
```

The standard bundle supplies the default row; a profile patch replaces that row.
Do not register both this plugin and the old AIRI reader port in the same tool
registry. The example uses a placeholder path, not a shipped user configuration.

## Interaction

- `reader_connection_status` reports only readiness, registered names and the
  reply budget; it does not claim the last connected service is still alive.
- `reader_refresh_tools` connects/reconnects and discovers authorized tools.
  Startup attempts discovery once with a three-second deadline. A missing or
  closed reader does not fail the chat plugin. There is no polling.
- Discovery is the intersection of the host's catalog, `readOnly: true` and
  seven known read capabilities. Unknown tools, index preparation/cancellation
  and write tools are never registered. Native book grants remain authoritative.
- Calls re-read discovery credentials, so reader restarts do not require copying
  a token into the chat host. Refresh updates the catalog after a grant/schema
  change. A failed refresh removes stale reader tools, retaining the two controls.
- The default complete JSON reply budget is 16 KiB, configurable from 1–256 KiB.
  Each reader call receives that budget in the request envelope. The transport
  also refuses a larger reply from an older host; it never truncates original
  text to make a response fit. Ask for fewer items or a narrower scope.
- Native caller cancellation and plugin unload abort this plugin's HTTP work.
  The reader remains responsible for its own remote cleanup before another
  foreground operation proceeds. A local disconnect is not proof of teardown.
- Guidance describes targeted search and expansion, source fidelity, incomplete
  index coverage, and ordinary conversation without the reader. It does not
  invent a persona, publish memories or replace the host's prompt.

The plugin does **not** enforce a conversation token policy. Byte-limited tool
results cannot prove the complete model request fits. The host adapter must
admit the final assembled request, including history/tools/reasoning reserves;
`scripts/reader-model-context.mjs` is the separate reusable gate.

## Focused verification

From the reader workspace, with existing experiment dependencies:

```sh
node --import tsx --test experiments/companion-harness/reader-native-plugin.test.mjs
```

One check uses the real DSH registry, this plugin, authenticated HTTP and the
reader's actual TS service with a synthetic backend. It covers offline startup,
reconnection, grants, native schema validation, source identity, budget forwarding,
credential rotation, cancellation/drain/reuse, and unregistering on unload.
It does not call a model, inspect private books, validate session persistence,
install a package into a real profile, or prove Windows native SQLite/IPC works.

The transport lives here as a framework-neutral module. The old AIRI import is
a compatibility re-export; the paused AIRI integration is not resumed.
