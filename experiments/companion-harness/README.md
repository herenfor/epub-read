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

## Independent execution port

`execution-host.mjs` is a separate, opt-in entry. The original `host.mjs` above
still has only the reader tools. This entry uses DSH's sandbox policy, local
sandbox provider, sandboxed bash executor and managed subprocess runtime, with
no agent/model loop or session/memory persistence. It neither reads the global
DSH profile nor exposes a network server. It is not wired into the reader UI.

After installing the experiment dependencies, a trusted parent starts it with
an **existing absolute directory** and a fixed file policy:

```sh
node execution-host.mjs --workspace /absolute/task/workspace --mode workspace-write
```

`read-only` is the default; `workspace-write` is the only other accepted mode.
Workspace identity is resolved at startup. Command requests cannot override
the workspace, policy, environment, timeout or escalation. One operation is
active at a time. Timeout is 30 seconds; each output stream retains at most
64 KiB of its tail, reports truncation, and returns no spill path. Any spill
returned by DSH is removed before returning the result. No execution journal
or long-term memory is written by the host.

The private parent/child channel is one JSON object per line on stdin/stdout:

| Input | Output |
| --- | --- |
| Startup | `ready` with protocol/version, capability and probed sandbox facts |
| `{"type":"call","id":"op-1","command":"printf hello"}` | `started`, then one `result` or `error` |
| `{"type":"status","id":"query-1"}` | `status` with active operation and last outcome metadata |
| `{"type":"cancel","id":"op-1"}` | `cancelling` acknowledgement; the operation's terminal event follows cleanup |
| `{"type":"shutdown","id":"stop-1"}` or stdin EOF | Cancel, await the active operation, dispose managed processes, then `closed` |

Use a fresh operation ID for each call. `started` acknowledges acceptance,
not that the inner command has executed. `cancelling` also is not completion.
Only the terminal event releases the slot. `result` includes exitCode, signal,
aborted, timedOut, bounded stdout/stderr, and actual per-run sandbox facts.
Check all these facts: a command failure is not a successful tool action.
`status` holds only the last outcome metadata, not output or a durable result
queue. The caller owns any user-visible events or evidence it chooses to keep.

No usable sandbox fails with `SANDBOX_UNAVAILABLE`; it never retries without
confinement. `ready` reports a functional backend probe, not proof that an
arbitrary command will succeed. DSH may report partial enforcement on some
platforms; callers must decide whether that satisfies their policy.

**Scope:** the sandbox constrains file effects. Workspace-write may also allow
platform temporary areas. This entry does not restrict network access, make
host files unreadable, or authorize Windows desktop observation/actions.
Commands can still read host-accessible files; do not attach this port to an
untrusted caller or describe it as a general hostile-code isolation service.
External Windows tools need their own permissions at the Windows endpoint.

`pnpm check:execution` is one real-entry short check using disposable files:
inside write, outside denial, rejected policy override, cancellation of a
started descendant, no delayed write, and reuse/shutdown. It requires a real
usable local sandbox and does not skip or substitute a fake runner. It does
not call a model, start AIRI, or run the reader regression suite.

## AIRI reader extension

[airi/README.md](airi/README.md) describes the opt-in AIRI 0.12 extension and its
independent DSH reader port. It uses the same DSH tool registry but exposes only
the reader's six read tools, not this package's shell execution port. AIRI owns
the experimental dialogue loop; neither the port nor the extension creates a
second model loop or stores memory. The reader's native service keeps book
authorization and archive ownership. The stock AIRI stop button needs the
small source bridge documented there; plugin cancellation and unload already
have their own execution lifecycle.
