# Local MaiBot plain prompts and optional context continuity

Optional adapter for the standalone MaiBot instance. It does not change the
reader, Core/Android, daily DSH/Tobs, their prompts, or their memory. Long-term
memory and embedding are separate features and are not enabled by this module.

## Current default: native context

`context_mode` defaults to `native`. Runtime history selection, compaction and
restart recovery are MaiBot's original implementations. No local token counter,
request ceiling or custom checkpoint restoration runs in this mode. The plain
prefix/suffix and private failure diagnostics remain active. Existing custom
checkpoints/source archives are preserved, but not imported by native mode.

Use MaiBot's own `chat.max_private_context_size` (private messages),
`chat.max_context_size` (groups), and `chat.context_compaction_summary_max_chars`
settings. These are message counts and summary characters, not token limits.
In the currently inspected native release, compaction starts at 1.2 times the
message setting and targets 0.2 times; restart recovery uses 0.5 times. Complete
tool spans and minimum recent messages can change the actual retained count.
Native summaries are not persisted by this adapter in native mode.

Changing context mode requires a process restart. It does not rewrite native
history, role text or long-term memory. Switching back to `managed` requires an
explicit decision about potentially stale checkpoints; do not silently re-enable
it after newer native-only conversation.

## Optional managed context contract (currently disabled)

The native 60-message trimming/slicing rule is bypassed for this instance. The
adapter uses the assembled planner/replyer input, tools, and output reservation:

| Setting | Default |
| --- | ---: |
| Soft input estimate | 256,000 tokens |
| Target after compaction | 192,000 tokens |
| Request ceiling, including output reserve | 320,000 tokens |
| Minimum output reservation | 16,384 tokens |
| No-checkpoint initial DB recovery | At most 4,096 recent messages |

These are **estimates**, using configurable `o200k_base`, upward calibration
from provider usage and a conservative image allowance. They are not exact
DeepSeek/provider token counts or certification of a model's context window.
Keep the request ceiling within the selected model's capacity. All settings are
editable; native messages/tool schemas are included, not just conversation text.

Only completed cycles without pending wait-tool calls may compact. Native safe
prefix selection protects the latest user turn, the minimum recent messages and
whole tool-call/result spans. A successful native summary and a durable JSON
checkpoint must both exist before those originals leave active context.
Compression failure preserves the originals and previous summary. Too-large
requests are refused before the backend call, rather than sent over budget or
silently trimmed. If protected recent content itself is too large, narrow that
content or adjust the explicitly configured capacity; no automatic data loss
fallback is provided.

Checkpoints preserve native message types, identities, completed tool protocols,
raw IM/media metadata, and summaries using existing MaiBot codecs. Native
process-only provider replay/signature fields are deliberately not reconstructed
or fabricated. Actual protocol reasoning, where present in a checkpoint, remains
private protocol state, not a user fact or long-term memory. Unknown checkpoint
types/schema fail without replacing the existing file.

Every successful compaction retains a private source segment, source IDs,
summary revision and parent revision. The latest checkpoint retains the bounded
working context; source segments are audit records and are not automatically
retrieved as long-term memory. Original IM history remains in MaiBot's database.
Archives are not given a destructive automatic retention rule in this experiment.
The retro reply path also uses this same working history, rather than issuing
another count-based database query that could bypass the summary.

Restart restores the full saved working context, then merges newer real DB
messages without resurrecting messages already covered by the summary. It does
not execute old tool calls. No checkpoint means initial bounded native DB
recovery; this is not a full-history migration for an existing huge conversation.
`/clear` invalidates the working checkpoint; native WebUI session deletion also
purges this adapter's source segments. A generation fence prevents a stopped
runtime's late writer from recreating cleared/deleted context.

## Plain prefix and suffix

Provide two ordinary UTF-8 files. They are read locally per request, inserted
before the original prompt and after current history respectively, and excluded
from the stored conversation. No template engine, `user`/`char` substitution or
separate character-card format is required. Identical input text reaches planner
and replyer. Native configured personality/style text is removed from their
system sections while custom text is active; workflow/tool instructions remain.
The platform nickname is still a separate native setting.

Empty files preserve the current native character. Existing Tobs text is never
guessed, opened by the assistant, or automatically selected among multiple bots.
Users can paste unchanged source text or point the configuration at their chosen
files. Background summary requests omit these character sections. Changing the
role does not retroactively rewrite or erase previous conversation.

## Installation

Install `requirements.txt` in a dedicated MaiBot environment. Run:

```sh
python install.py --site-packages /absolute/private/site-packages --backup /absolute/private/native-backups
```

Create private JSON settings and set `EPUB_MAIBOT_CONTEXT_SETTINGS` only for that
MaiBot process. Required fields are `state_dir`, `prefix_file`, and `suffix_file`;
set `context_mode` to `managed` only to opt into the budget contract above.
The budget defaults above may be overridden. Set `TIKTOKEN_CACHE_DIR` to the
selected local cache directory. Restart after editing budget settings; the two
text files themselves can be edited without restarting.

Why native hooks: ordinary MaiBot extensions run in another process and cannot
own the host's history commit/recovery transaction. The installer adds a small
marked footer at six native boundaries (runtime, cycle engine, LLM facade,
clear manager, WebUI deletion helper, failure diagnostics). Original native
files are backed up; policy/codec/storage logic lives here, not in giant native
files. The hooks activate only with the explicit environment setting. There is
no exact release lock. After an upstream upgrade, rerun the installer and verify
the changed native interfaces; hook absence is not silently treated as acceptance.

Disable native detailed prompt previews/cache diagnostics for this deployment.
The adapter suppresses upstream full failed-request snapshots, retaining only
in-memory failure-attempt metadata. Its own status files contain counts, budget
estimates and state only. Checkpoints, source segments, prompt files and settings
are private data, not diagnostics and never source-control content. `/clear`
does not purge source archives; deleting the native session does.

To disable this adapter, remove its environment setting and restart. Keep the
data and backups until an explicit retention decision. A native-only restart
does not automatically import its summaries; do not call that a lossless rollback.

## Verification limits

The original three targeted native-object fixtures cover restart beyond 30 messages with
summary/tool identity, summary failure preservation and source-linked success,
both prompt routes, and pre-send refusal without a backend call. They use only
synthetic data and mocked summary generation. No real private prompt, chat,
memory, paid 256K request, QQ message, full reader tests or platform build is
needed. Real long-dialogue compression quality and live QQ continuity still
need user acceptance; a loaded hook or health endpoint is not that proof.
The native-mode fixture additionally checks that runtime/cycle hooks remain
original while both prompt routes preserve raw function-tool definitions. It
does not send a real message or make a paid model request.
