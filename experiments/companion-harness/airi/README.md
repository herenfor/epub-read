# AIRI reader extension

This opt-in extension targets AIRI 0.12.0. It does not bundle AIRI, a model,
avatar assets, or its private workspace SDK. The public `kit.tool` contract
registers tools with AIRI's host. The reader's Core and Android code do not
import the extension.

## Responsibilities

```text
AIRI tool invocation
  -> reader-port (private child-process protocol)
  -> DSH tool registry and argument validation (reader-host/reader-kernel)
  -> parent callback (Windows native HTTP client)
  -> authenticated reader capability service
  -> unchanged original text, chunks and anchors
```

For this experiment, AIRI owns the dialogue loop. DSH owns tool dispatch and
has no model or agent loop here. The parent and DSH both allow only the six
read-only reader tools. Cache preparation, arbitrary native calls, shell and
desktop actions are not registered. `reader_bridge_status` and
`reader_stop_lookup` are local lifecycle controls, not book mutations.

The reader service remains the book authorization boundary. Its credential is
read from its private discovery file per HTTP call, never sent to the DSH
child or added to a prompt. Re-reading allows credential rotation when the
reader restarts. DSH can run under WSL while the native reader client stays
in Windows; the connection uses stdin/stdout, not another public server.
Raw schema type arrays are translated to DSH rc.3's supported `oneOf` form
only for validation. AIRI receives the original schemas. Synthetic nulls
introduced by AIRI's strict-schema projection are removed only for optional,
non-nullable parameters; the real `folderId: null` filter is preserved.

The shell sandbox checked in the other entry does not confine this HTTP
callback. Authorization for that callback comes from the native reader. Do
not describe either as authorization for external Windows actions.

Neither the extension nor the DSH port reads/writes conversation or memory.
AIRI's own test-profile conversation storage is still AIRI-owned; the
reader's existing conversation has not been migrated or connected to it.
Connecting the independent session/memory service is a subsequent step.

## Install and start

Install the parent experiment's pinned dependencies once, as described in its
README. Use Windows Node 22.23+ to run `install.mjs`; pass an explicit private
data directory. No API key is required.

```text
node airi/install.mjs --airi-data <private Windows data directory>
  --harness-dir <Linux companion-harness directory>
  --wsl-distro <distribution name> --node <absolute Linux Node executable>
  --airi-app <absolute Windows airi.exe>
```

Pass these arguments on one command line. Without `--wsl-distro`, the execution
host runs locally using `--node` or the installer's Node executable. On other
platforms pass `--connection-file` explicitly. On Windows the default is the
native AI reader's private `reader-tools/local.json`. A named client with a
narrower book grant may be selected by supplying its discovery file.

The installer copies only this extension into `extensions/v1/epub-reader-tools`
and merges its own enablement into `extensions-v1.json`, preserving other
extensions and settings. Its configuration holds paths and launch arguments,
not copied credentials. Stop AIRI before updating extension files: its module
loader can otherwise retain old imported dependencies. This prototype does
not promise hot reload.

When `--airi-app` is supplied, double-click the generated `start-airi.cmd` in
the selected private directory. It selects that profile without changing
global environment variables and starts AIRI without a debugging port. Start
the native AI reader capability service first; a missing reader makes plugin
activation fail visibly. Once the reader is ready, reload the extension from
AIRI's extension settings. Do not use the Core reader as a substitute service.

The installed Windows manifest uses an ESM URL pathname such as `/D:/...` to
work around AIRI 0.12's absolute-path import bug. The source manifest remains
portable; generated paths/configuration must not enter Git or a release.
Keep auto-reload disabled with this pinned compatibility path.

## Cancellation

Calls are serialized. A stop aborts this port's active and queued calls. DSH
keeps an outstanding callback until its owner acknowledges its HTTP request's
closure; unloading the extension cancels and joins its owned child. The native
reader separately holds its serial lease until provider teardown, including
ZIP ownership, is acknowledged. Closing HTTP alone is not a remote teardown
acknowledgement; the native service enforces that boundary.

**Stock AIRI 0.12 does not forward chat cancellation to plugin execution.**
`reader_stop_lookup` or disabling/unloading the plugin works independently.
To connect the normal chat stop button, apply `reader-stop.patch` to the pinned
AIRI source and rebuild AIRI. It adds the small `stop-bridge.mjs` action hook
at the renderer integration point; it does not change memory or a model loop.
Until that rebuilt app is installed, normal chat stop is not a verified
persistent plugin-cancellation path. A diagnostic runtime hook used to check
the same logic is not a deployed source build.

This bridge currently targets one foreground conversation and cancels this
extension's pending lookups as a group. Bind task/session IDs before enabling
parallel background conversations. No global click/key observer or private
Vue-state injection is part of the installed plugin.

## Focused verification

`pnpm check:reader` runs one small test through the actual DSH child with a
fixture reader endpoint: read-only discovery, unchanged text/anchor metadata,
nullable argument compatibility, invalid-input rejection, stop forwarding,
transport closure and subsequent reuse. It does not test model answers.

For native acceptance, use AIRI's registered tool proxy against the actual
reader service and compare returned passage data with a direct call. Check an
in-flight search cancellation and a following query. Temporary inspector
access is development tooling, never a plugin dependency or a launcher default.

The API shape is based on AIRI's MIT-licensed
[plugin SDK](https://github.com/moeru-ai/airi/tree/v0.12.0/packages/plugin-sdk)
and [tool kit](https://github.com/moeru-ai/airi/tree/v0.12.0/packages/plugin-sdk-tamagotchi).
Keep this version-specific adapter separate when upgrading AIRI.
