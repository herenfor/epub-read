# Reading companion runtime experiment

This optional AI development host composes DSH 0.2.1-rc.3's native agent,
model and tool services. It does not install the DSH CLI or use its global
profile. Its dependency graph and lockfile are separate from the reader.
Core and Android do not import or bundle this host.

Use Windows Node 22.23 or newer. From a dedicated local AI development copy:

```powershell
Push-Location experiments/companion-harness
pnpm install --frozen-lockfile --ignore-scripts --store-dir ../../.pnpm-store
Pop-Location
```

The Windows companion launcher also supports `-InstallHarness` alongside its
required `-TestDirectory`. Installing the host does not change the selected
runtime. In the companion's API settings, choose **DSH** to use it, or
**Direct** for the existing executor. A running Vite server must be restarted
after adding the host middleware. This experiment is available only through
the local AI development server; it is not a packaged release feature.

## Ownership

- DSH owns the current model/tool loop and its native tool registry. Only the
  reader's five declared tools are installed, never shell or filesystem tools.
- The app owns the persistent visible conversation, role, context policy,
  evidence, summaries and memory. Both executors use `turnSession.ts`.
- A custom model adapter delegates each generation to the existing application
  transport. The API key never crosses into this host. Actual messages and tool
  schemas are assembled and counted by the app once per provider request.
- DSH's transient protocol session contains the current turn only. No DSH
  persistence, automatic compaction or global configuration plugins are loaded.
  In-turn reasoning can be replayed to the provider, but is never written to a
  conversation, diagnostic file or memory. The session is disposed at turn end.
- The native host is warm between completed turns. Closing/cancelling a stream
  terminates it and cancels the app callbacks; a subsequent turn starts a fresh
  host. There is no automatic fallback or retry that would make another API call.

## Ports and verification

The AI-only Vite middleware exposes loopback/same-origin routes under
`/__ai-companion/harness`: `GET /status`, `POST /run` (NDJSON events), and
`POST /reply`. Each run has a random capability token; replies require both the
token and a live request ID. There is one active turn per development host.
No endpoint accepts an API key or provider configuration file.

`node --test kernel.test.mjs` runs a small, deterministic native DSH tool-loop
and cancellation check without connecting to a model API. It does not test
model quality, memory generation, long context or native platform rendering.

DSH packages and the Cordis fork are used under MIT; see the package license
files installed by pnpm. No AIRI runtime or model asset is redistributed here.
