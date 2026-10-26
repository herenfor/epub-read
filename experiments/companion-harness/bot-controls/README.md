# Local bot settings

Optional UI for an isolated **DSH 0.2.1-rc.3 / Tobs 1.5.2** host. This package
does not enter the reader, Core/Android bundles, or another DSH profile. It adds
no dependencies, model loop, telemetry or separate listening port.

It borrows SillyTavern's separation of **main prompt, character, post-history
instructions** ([prompt manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)),
not SillyTavern code or its full card/macro ecosystem.

## Install in a private profile

```sh
dsh plugin --profile web add file:/absolute/path/to/bot-controls
node /absolute/private/profile/node_modules/epub-local-bot-controls/patch-native.mjs /absolute/private/profile
```

Use the same deliberately selected `DSH_HOME` for installation and startup.
Run the patch helper before each cold start, after checking that the host is
stopped. It is idempotent. Then restart that host and visit **`/bot-controls`**
on its existing web address. The page uses the host's normal owner login and
same-origin authenticated routes. It is not an unauthenticated public panel.

Tobs normally offers selected-message purge only for ended groups. The helper
adds canonical local Human/Bot DMs to that selector, leaving native ownership,
membership, preview/token, ledger and attachment checks in place. It checks the
exact version and source anchor and refuses unfamiliar implementations. It
replaces the private profile file atomically rather than modifying a shared
pnpm hard link. Upgrading Tobs requires reviewing this small patch again.
Reinstalling the private Tobs package restores upstream code; disable this UI
and its startup hook when removing the feature.

## Chat records

Select a bot, select up to 100 messages, and review **Delete selected**; or
review **Clear this bot's chat**. A responding bot must finish first. Clear
uses the fixed preview cutoff and that bot's DM, batching through native purge
without collecting unrelated or newly arrived messages. Shared sources are
reported in the selected-message confirmation; clearing a whole DM refuses
sources shared with other chats rather than silently clearing those chats.

This is native **chat-content purge**, not an undo or a model-memory reset:

- Source bodies and associated attachments are cleared through the native
  purge ledger. Audit records and “content cleared” placeholders can remain.
- Persona, long-term memory, native session history/context and completed
  external actions are not erased by this UI. Previously admitted content can
  still be present in model context or derived memory.
- No direct SQLite deletion or fabricated history rewrite is used.

## Persona and prompts

Open **Persona & prompts**, explicitly load, edit, then **Save and apply**.
SOUL is saved with the native human-edit/CAS API and existing session persona
snapshots are refreshed. The separate per-bot configuration is stored in
`<DSH_HOME>/botharness/persona-prompts/<bot-slug>.json`; it contains only main
and post-history prompt settings. Private role text and prompt JSON must never
be committed to the reader repository.

- **Main/prefix:** a system-prompt section before character material.
- **Persona:** the bot's existing `SOUL.md`, with its native standing limit.
- **Post-history:** the last native runtime-context contribution, after the
  admitted user messages and tool results. This is a logged **user-role**
  instruction, not a system override or a new visible chat message.

Prefix/post-history accept `{{char}}` and `{{user}}`, expanded from the selected
bot and Human names. Other macros remain literal. Empty fields preserve the
native preset; clearing a configured field supersedes its previous snapshot.
Each prefix/post-history field allows 16,000 UTF-16 units. Native permissions
and tools are unchanged.

The same card macros also expand in Tobs' native `botharness:persona` section
(the SOUL/MEMORY snapshot), including already-existing sessions. Expansion is
one pass at prompt assembly; the original files and snapshots are not rewritten.
Native DSH variable interpolation is disabled only for that persona section,
so unsupported card macros stay literal rather than stopping a reply with
`unknown prompt variable`. Framework/tool sections keep their normal rendering.

To keep post-history last across tool steps, its step identity causes the
native runtime-context snapshot to refresh for each generation when nonempty.
That snapshot is recorded and counted by the normal admission/compaction
system; it adds context/input overhead. Keep the field concise. No provider
request, reasoning content or hidden conversation log is patched.

Saving refuses busy bots and stale revisions. SOUL's native Git commit and
the prompt JSON are separate writes: on a partial failure, the page reports
what may already have saved and asks to reload, never silently overwrites
another editor or resets memory. External uncommitted memory-file changes may
need resolving through the native memory editor before a new SOUL commit.

## Focused verification

From the parent experiment directory:

```sh
node --test bot-controls.test.mjs
```

This uses the real DSH loop with a fake model, proving prompt placement before
the role and after user/tool history, including removal of post-history.
Native storage/deletion and browser interaction were checked with isolated
synthetic bots. Do not use real personas, conversations or model API calls for
routine UI tests. No reader test suite or platform build is required.
