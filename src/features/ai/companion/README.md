# Reading companion experiment

This subtree belongs to the Windows AI debug edition. Core does not import its
runtime. The browser development preview can exercise the same frontend with an
API that permits CORS. No production AI actions or Android entry are enabled here.

## Responsibilities

| Module | Owns |
| --- | --- |
| `CompanionPanel.tsx` | Settings, history UI and the active request lifecycle |
| `CompanionAvatar.tsx` | Local Live2D renderer and GPU cleanup |
| `InvestigationTrace.tsx` | Actual tool activity, not model reasoning or accuracy certification |
| `conversation.ts` | Direct executor's bounded model/tool loop |
| `turnSession.ts` | Shared context assembly, budget, evidence policy, tool dispatch and diagnostics |
| `harness/runtime.ts` | DSH executor using the same app-owned turn state |
| `harness/channel.ts` | Cancellable development-host stream and callback port |
| `prompts.ts` | Role, reading policy, source rules and automatic message assembly |
| `tools.ts` | Tool schemas, dispatch and per-turn activity records |
| `evidence.ts` | Original text identity, citation binding and scoped history reuse |
| `retrieval.ts` | Active book/library scope and retrieval coordination |
| `retrieval/currentBook.ts` | Selective chapter extraction with a small text cache |
| `retrieval/nativeIndex.ts` | Existing native index metadata and experiment IPC adapters |
| `retrieval/ranking.ts` | Query preparation, lexical ranking, RRF and overlap removal |
| `retrieval/contracts.ts` | Interfaces used by the real adapters and focused tests |
| `transport.ts` | Standard streaming chat protocol and cancellation |
| `requestPolicy.ts` | Provider request parameters and low-thinking defaults |
| `diagnostics.ts` | Selected request metadata, returned passages and actual evidence delivery |
| `eventLog.ts` | Timestamped, bounded metadata timeline in the AI database; no text or credentials |
| `storage.ts` | AI-only settings, database upgrade and explicitly edited memories |
| `conversationStore.ts` | Append-only conversation timeline, bounded reads and source-checked derived records |
| `contextBudget.ts` | Replaceable token estimates, request ledger and capacity guard |
| `memoryContext.ts` | Relevant derived summaries/memories and supersession selection |
| `memoryMaintenance.ts` | One cancellable batch summarization/candidate job and provenance validation |
| `runtime.ts` | Replaceable runtime boundary and the direct-API adapter |
| `avatarModel.ts` | Local avatar interface, emotion names and registered motion lookup |

The Rust counterpart is `src-tauri/src/ai/companion.rs` (commands and HTTP stream)
with `companion/retrieval.rs` (read-only SQL and scope before top-k). Do not expand
`App.tsx`, the renderer or a shared library store for AI-specific orchestration.

## Reading behavior

Automatic mode lets the model answer directly or select tools. Strict mode is a
comparison setting that requires supplied original evidence. Prompt policy should
encourage source-grounded book facts without forcing a search for every message.
The application verifies source identity and read scope; this does not establish
that a generated claim follows from the source.

Separate queries are alternatives. Whitespace-separated terms within one query
must occur in the same passage. Native trigram FTS finds longer terms, with literal
filters for short names. Query rankings are fused with RRF; this is currently
lexical retrieval, not a semantic embedding or learned reranking service.

Small retrieval hits remain canonical original text. The model can expand their
chapter context with `aroundEvidenceId`. Every page states its actual chunk range;
a page reaching the chapter end does not imply the chapter was read from the start.

Recent, version-matching original evidence can be reused if it is still inside
the active book/chapter scope. Model answers and user memories do not become book
evidence. One persistent timeline survives book/scope changes. Existing scoped
histories migrate into individual records; UI pagination never deletes originals.
Context tiers are 100K/200K/400K estimated input tokens, with 200K the default.
Unknown provider capacity is not assumed to be 1M. Protocol reasoning is included
in request accounting, never in diagnostics or persistent conversation records.

After about 24 exchanges or 16K new dialogue tokens, one background request can
produce a sourced segment and memory candidates. Foreground input cancels it;
publication verifies source revisions transactionally. Disabling automatic memory
also excludes derived context. Originals remain available through the
`recall_conversation` keyword tool. Memory retrieval is currently lexical, not a
semantic embedding service. Generated memory quality is not established by
schema/provenance validation.

`CompanionRuntime.runTurn` has Direct and optional DSH adapters, selected in the
AI settings. Direct remains the default. DSH owns its complete model/tool loop;
it never calls `answerWithBooks`. Both use the same app-owned context assembly,
evidence, tool execution and strict-evidence policy. `CompanionToolPort` keeps
descriptions and permission-checked execution independent of the executor.

The separate [native host](../../../../experiments/companion-harness/README.md)
is installed only on request, outside the root dependency graph. Its transient
per-turn protocol sessions are disposed; app history and memory remain the only
persistent authority. It has no shell/filesystem tools, global DSH profile,
automatic compactor, MCP server or fallback that silently repeats a model call.
The existing API transport stays in the app, so its key never enters the host.
The bridge is served only by the local AI development middleware; this does not
enable a packaged production AI feature or Android entry.

The AI-only event log retains the latest 1000 metadata events across reloads:
conversation saves, request/tool timing, context compaction and memory job states.
It includes IDs/counts, never prompt/answer text, API credentials or hidden
reasoning. Writes run off the foreground path; failed logging is reported by the
diagnostic snapshot. This is an operational timeline, not a backup of messages.
The local diagnostic endpoint exposes it as `eventLog`; it starts collecting when
the companion panel is opened after the AI development bootstrap succeeds.

Low thinking is enabled by default (8192 completion tokens); the checkbox turns
it off for DeepSeek (4096 tokens). Other endpoints receive `reasoning_effort: low`
when checked and use their own defaults when unchecked. They must support that
parameter. Credentials are not part of request-policy or diagnostic objects.

Saved exchanges are quoted as reference data in the next turn, preserving
original passage IDs. They are not fabricated assistant protocol messages with
missing thinking fields. Actual assistant reasoning is preserved within the
current tool loop and is never persisted or exported in diagnostics.

## Local development

`pnpm dev:ai` starts a browser preview. `scripts/dev-windows-companion.ps1` prepares
a dedicated Windows source copy and starts an AI debug app; it runs no tests and
does not install or stop Core. It requires Node, pnpm and the Rust/MSVC toolchain.
Pass `-TestDirectory <local-Windows-build-directory>` explicitly, using a dedicated
build copy separate from Core. There is no implicit AppData destination. Rust
artifacts stay in `src-tauri/target-ai`, pnpm's store in `.pnpm-store`, and frontend
caches/logs under this selected workspace; application library data is unchanged.
The copied snapshot disables Rust file watching so Cargo output cannot restart
its own build. Rerun the launcher to copy later source changes.

The sample model and Cubism Core stay in ignored `.ai-companion-local/`. Preserve
their upstream licenses. They are served only by the AI dev middleware and are
never copied into production assets. Do not add them to Git or release bundles.
API credentials stay in application memory and are never stored with history.

To install a local Cubism export with `airi-interface.json` version 1, run:

```sh
node scripts/install-companion-avatar.mjs <model-export-directory> <display-name>
```

The installer validates the referenced resources and emotion mappings, copies
them into ignored `.ai-companion-local/avatar/`, and publishes `avatar.json` last.
It leaves the source export unchanged and does not copy an accompanying ZIP.
The Windows launcher copies this local directory into its development snapshot.
The avatar starts with the declared default emotion and idle group; its optional
preview lists only the contract's static emotions. Motion files are matched to
registered groups. Without a local selection the existing Hiyori sample remains
available. TTS, speaking variants and model-generated ACT commands are not wired
by this installation. The model never supplies character identity or chat memory.

The AI dev server exposes `GET /__ai-companion/diagnostics` on loopback only.
Opening the companion panel publishes the last six saved exchanges (cited
passages only). New conversations retain the last three detailed turn records:
tool arguments/results, uncited original passages with canonical anchors, and
the evidence IDs supplied to each actual request. Missing historical tool
results are explicitly marked; a citation list cannot establish input coverage.
The frontend serially publishes snapshots to the same-origin dev middleware;
reads never invoke a model. Snapshots stay in memory, exclude credentials and
reasoning text, and disappear when the dev server closes. This is a development
interface, not a public API or a Core/release/Android feature.
