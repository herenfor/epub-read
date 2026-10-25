# Persistent chat-host experiment

This entry uses **DSH 0.2.1-rc.3 + Tobs 1.5.2** with the optional native reader
plugin. It does not create another chat UI or model loop. It is an experimental
deployment, separate from the reader's Core/Android builds and the user's daily
DSH home. AIRI is not a dependency.

## Reproduce the deployment

Use a trusted, explicitly selected DSH 0.2.1-rc.3 installation. Set `DSH_HOME`
to a new absolute experiment directory **for these commands only**. Do not copy
the daily host's credential store, settings or conversation database. Keep
Windows workspaces and compilation caches in the chosen D-drive directory;
this experiment can also run in WSL with its Web UI opened on Windows.

```sh
dsh plugin --profile web add @botharness/tobs@1.5.2
dsh plugin --profile web add file:/absolute/path/to/reader-plugin
dsh --profile web --port 3092 --no-open
```

These commands assume that the selected `dsh` executable and process-local
`DSH_HOME` are already set. A local plugin needs `file:` so its peer dependencies
resolve from the installed profile, rather than a linked source workspace.

Before launch, put this directory's `cordis.patch.yml` into the experiment's
profile override (merge deliberately if that profile already has settings).
It selects Tobs' preset and keeps this text-chat experiment free of browser,
computer and external-messaging modules. Use another free loopback port if
3092 is occupied; do not stop a daily DSH listener to take its port.

For WSL hosting a Windows reader connection, set the host's
`EPUB_READER_CONNECTION_FILE` to the Windows reader's private discovery file
accessible through WSL. Verify that the actual loopback endpoint is reachable;
cross-OS localhost access depends on the deployment. On a Windows host the
reader plugin has native discovery defaults. Never paste discovery credentials
or model keys into a prompt.

Configure the model in this experiment's own DSH settings. A new Tobs Bot also
needs its Model Plan set: configuring an API alone does not select its route.
Use the UI, or Tobs' `model-catalog`, `model-plan-customize` and `model-plan`
commands. Do not guess model IDs or reuse an unrelated Bot's plan.

The native Web launch URL contains a private login token. Open it locally and
do not commit or share it. The stable loopback origin alone may show a login
page; a 401 without credentials does not mean the server failed.

## What was accepted

The isolated WSL host and Windows browser were used with a user-configured real
DeepSeek route. Tobs' native trace confirmed `reader_connection_status`, followed
by refresh/discovery and real Windows reader calls to find the EPUB guide, list
chapters and read one original passage. Dynamic reader tools became available
within the same native Bot session, with no second agent loop.

After a graceful host restart, the same Bot, Channel and native Session were
restored. With the reader closed, the next real reply recalled the temporary
conversation marker and the previously read chapter without reader, memory
lookup or filesystem calls. This is a short continuity check, not a long-context
or long-term-memory acceptance test.

The complete model-facing passage in the native session log was compared with
the direct reader API: the data object, original text and anchor were equal.
Only that one passage was reread; no full-book or library-wide test was run.

The native reader was an **existing Windows AI debug snapshot** exposing six
read tools. This does not validate the latest seven-tool native catalog or a
fresh release build. The plugin takes the read-only intersection it actually
discovers; absent indexed-library search was not fabricated.

Use Tobs' native CLI for observation instead of screenshots:

```sh
tobs list --host <private-loopback-origin> --token-file <private-token-file>
tobs bot-sessions <bot-id> --host <private-loopback-origin> --token-file <private-token-file>
tobs bot-trace <bot-id> --turns 1 --host <private-loopback-origin> --token-file <private-token-file>
```

Trace results are short previews. They are **not** complete JSON tool results;
do not parse the preview as a source record or use it to prove full-text parity.
The reader returns full, bounded results and the native DSH session records the
model-facing tool message. Receipt IDs and source-event IDs tie a send to its
committed reply. On an uncertain send, use `send-status` for the original
message ID instead of automatically resubmitting it.

## Ownership and verification scope

Tobs currently owns the experimental Bot identity, Channel and native sessions;
its memory is a Git repository in the **new experiment home**. No old companion
history or memory has been migrated. The reader plugin never writes that memory.

Tobs 1.5.2's exported memory helpers and plain files support inspection/export,
but its mounted core does not expose a configurable external MemoryService in
its published Config. This is not yet our replaceable memory implementation.
Before adopting it as the permanent memory owner, design a supported adapter or
keep this deployment as a disposable product-experience carrier. Do not patch
private compaction methods or let two services independently write the same
memory files.

The reader response budget is independent of a client's conversation budget.
An optional [client policy](../chat-policy/README.md) now applies the approved
reading-partner base, deferred coding tools and a 256K soft context threshold to
one test bot. Real high-pressure compaction and independent memory portability
remain untested. Native model-window safeguards remain in effect.

Tobs is one verification client. Prioritize the reader's discoverable schemas,
authorization, original sources, pagination, cancellation and bounded results;
another agent or platform must not require this bot's identity, persona, memory
or internal session format. The generic reader CLI can exercise that contract
without a model. The user subsequently requested the optional
[local bot controls](../bot-controls/README.md): selected/all chat-content purge
and a three-field persona editor on this host's existing origin. That narrow
client convenience does not change reader contracts or resume task delivery,
proactivity, independent memory or AIRI work.

References: [Tobs 1.5.2](https://github.com/BotHarness/DeepSeekBot/tree/v1.5.2),
[DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md),
[native reader plugin](../reader-plugin/README.md).
