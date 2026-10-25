# Optional reading-companion client preset

This experiment configures one selected Tobs client. It is **not a reader API
requirement**: the reader HTTP service and CLI work without this package, Tobs,
a persona, a model key or a conversation database. Further work prioritizes
portable reading tools rather than expanding this bot deployment.

The tested adapter targets DSH **0.2.1-rc.3** and Tobs **1.5.2**. Install only in
an isolated host, after deliberately selecting those compatible versions:

```sh
dsh plugin --profile web add file:/absolute/path/to/chat-policy
```

Its default profile row has `botIds: []` and affects no bot. Replace that row
with explicit test-bot IDs when enabling it; never target every existing bot by
default. Core/Android do not import this package. It adds no model loop, memory
database or product dependency.

## Policy and ownership

- `preset.json` holds the independent policy preset: a **256,000-token soft
  threshold** and coding/file tools deferred until needed.
- `reading-partner.md` contains the approved neutral role base. Apply role text
  through the host's normal persona editor/save API. The policy plugin does not
  write persona or memory files. No character biography is invented.
- `policy.mjs` holds prompt projection and the soft-maintenance scheduler;
  `index.mjs` contains the Tobs/DSH adapter. A future platform can use its own
  persona/context policy without changing any reader contract.
- Existing group-chat and management tools remain available. `companion_tools`
  can expand or collapse existing work tools; expansion grants no permissions.
  Unchanged tool schemas and native reply-delivery guidance are preserved.

This is an independent configuration preset, **not a newly installed selectable
native AgentPreset**. Existing populated sessions retain their `deepseekbot`
preset and history. A model-routing preset is a separate provider setting.

### Separate character profiles

A private preset file may supply `promptProfile.identity` and
`promptProfile.coordination` to replace the default companion framing for only
the configured bot IDs. `omitSections` and `omitTools` hide explicitly named
prompt sections/tool schemas. Existing presets keep their previous behavior;
native delivery guidance and required context are preserved. These are trusted
host settings, not fields imported from a role card or new permissions.

Keep character text in the selected bot's `SOUL.md`, separate from runtime
delivery guidance. Tobs pins that text per session; editing the file does not
immediately replace an existing session snapshot. Apply an approved change via
the host's save/persona-refresh APIs, preserving the conversation. A file preview
is not an interactive persona editor. The optional
[local bot controls](../bot-controls/README.md) now provide a dedicated form
using native human-save and persona-refresh APIs, plus separate main and
post-history prompt fields. This policy remains independent of that UI.

## Soft context maintenance

After a completed turn, measured pressure at the soft threshold may schedule
one native compaction, provided the bot has no active turn, pending inbox or
working/stopping assignment. New input aborts this optional maintenance. A
failure or interruption stays pending until a later completed turn; there is no
polling or retry loop. Native compaction owns the summary transaction, source
history and recent tail. The native model-window admission/recovery remains
active: 256K is not a replacement hard limit or a guarantee every provider has
enough capacity. There is no fixed post-compaction target in this adapter.

Tobs pins a persona snapshot per native session. For an explicitly approved
human role update, `refreshPersonaOnApply: true` uses its public persona-refresh
API when attaching that session. Turn the flag off afterward. This does not
compact the conversation; it must not become an every-turn refresh or a
model-accessible role-writing tool.

Optional `statusFile` writes counts and scheduler status only, never prompts,
conversation text, reasoning or keys. Keep it in the private experiment home.

## Verification boundary

Two focused policy cases passed: prompt/tool projection, and soft-pressure
deferral/interruption/lifecycle handling. Two real client turns verified the
approved role and tool expansion/collapse; request tool counts were **54 → 83 →
54**. No coding/file tool executed in those checks.

The observed context was about 32.5K, with zero compaction attempts. **Real 256K
compaction, summary quality and long-term memory portability remain untested.**
This optional client is now held at that scope; reader-tool acceptance is
tracked separately from persona and conversation behavior.
