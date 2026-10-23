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
| `conversation.ts` | Bounded model/tool loop and explicit strict-evidence comparison |
| `prompts.ts` | Role, reading policy, source rules and automatic message assembly |
| `tools.ts` | Tool schemas, dispatch and per-turn activity records |
| `evidence.ts` | Original text identity, citation binding and scoped history reuse |
| `retrieval.ts` | Active book/library scope and retrieval coordination |
| `retrieval/currentBook.ts` | Selective chapter extraction with a small text cache |
| `retrieval/nativeIndex.ts` | Existing native index metadata and experiment IPC adapters |
| `retrieval/ranking.ts` | Query preparation, lexical ranking, RRF and overlap removal |
| `retrieval/contracts.ts` | Interfaces used by the real adapters and focused tests |
| `transport.ts` | Standard streaming chat protocol and cancellation |
| `storage.ts` | AI-only settings, history and explicitly edited memories |

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
evidence. Summaries, semantic retrieval and autonomous memory writes are not
implemented by this experiment.

## Local development

`pnpm dev:ai` starts a browser preview. `scripts/dev-windows-companion.ps1` prepares
a dedicated Windows source copy and starts an AI debug app; it runs no tests and
does not install or stop Core. It requires Node, pnpm and the Rust/MSVC toolchain.

The sample model and Cubism Core stay in ignored `.ai-companion-local/`. Preserve
their upstream licenses. They are served only by the AI dev middleware and are
never copied into production assets. Do not add them to Git or release bundles.
API credentials stay in application memory and are never stored with history.
