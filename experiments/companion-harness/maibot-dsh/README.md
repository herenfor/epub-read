# MaiBot chat with native DSH tasks

Optional local experiment. MaiBot owns QQ routing, persona, conversation and
memory; DSH owns one isolated execution task at a time. Nothing here is imported
by the reader's Core/Android bundles or changes Tobs conversations.

The plugin registers three QQ-private tools: `dsh_submit_task`,
`dsh_task_status`, and `dsh_cancel_task`. Submission immediately returns a job
ID. Completed, failed and cancelled results enter MaiBot's native proactive
queue for the initiating stream, so ordinary chat can continue during a task.
The owner stream is checked against the SDK's actual nested lookup response.
Deploy an owner-only inbound QQ policy as well; do not expose computer tools to
arbitrary groups/users. WebUI chat is a different platform and is not silently
granted these QQ tools or merged with the QQ conversation.

## Deployment

Install MaiBot and its official unified QQ adapter separately, then copy
`plugin.py`, `jobs.py`, `driver.py`, and `_manifest.json` into one plugin folder.
Create a **private, untracked** `bridge-settings.json` beside those files:

```json
{
  "owner_qq": "your-owner-account",
  "connection_file": "/absolute/private/connection.toml",
  "node": "/absolute/node",
  "dsh_entry": "/absolute/installed/dsh/lib/bin.js",
  "dsh_home": "/absolute/private/dsh-worker-home",
  "workspace": "/absolute/task-workspace"
}
```

`connection.toml` supplies `[model].api_key`. The driver passes it as
`MAIBOT_DSH_API_KEY` only in the worker environment, never argv or tool output.
The same setup file can provision MaiBot's model separately. Do not commit it,
the worker home, the QQ login directory, or the job ledger. Updating a model
endpoint/ID requires updating both the MaiBot route and worker overlay; editing
only one product's model panel does not update the other automatically.

Use the installed CLI's ordinary **headless** profile and a private overlay to:

- select the model route and an API-key environment reference;
- set `sandbox-policy` to `workspace-write` with the fixed task workspace;
- keep escalation unavailable (`approval.policy: never`); this does not disable
  the sandbox or grant access outside its policy;
- disable model-facing plugin management and runtime config editing in the
  execution profile, keeping its configured boundary operator-owned;
- disable telemetry/optional title generation, and add wanted reader tools.

No exact DSH release check, SDK source patch, shell string interpolation,
second model loop in the bridge, or changes to the daily Web profile are needed.
The command is `node <dsh-entry> headless --json -`, with objective on stdin.
The native JSON stream provides Session ID, tool-call progress and final result.
Only exit zero **and** an explicit final event count as success.

The native tools and policies in that selected profile determine what can run.
A WSL worker does not acquire Windows screen/mouse control simply by connecting
QQ; a Windows executor or platform tools are a later explicit capability.
This is an execution boundary, not a sandbox around the entire MaiBot/QQ client.

## Lifecycle and storage

`Jobs` owns a small atomic local ledger, one running task and a FIFO wait queue.
Cancellation drains the worker before reporting cancelled. Stopping/reloading
the plugin interrupts its workers; startup marks unfinished records interrupted
and never automatically repeats an operation. State/result queries remain
bound to the original stream.

The ledger records job identity, original stream, native Session ID, latest tool,
tool count and a bounded final result. It does not copy persona, memory,
reasoning or tool bodies. Results over 12,000 characters are marked truncated;
the native DSH Session remains the full execution record. Keep at most 100
terminal records already handed off, while retaining pending handoffs.

`handed_off` means MaiBot accepted the proactive request, **not** proof of a QQ
message reaching the user. There is no cross-process exactly-once claim: a crash
between enqueue and local acknowledgement can duplicate a notice, and a MaiBot
crash after enqueue can lose that queued notice. The persisted task result can
still be queried, and the operation is never rerun to repair notification.
Results go through the native queue instead of appending history before restore,
which could otherwise suppress MaiBot's database context restoration.

## Narrow verification

Two lifecycle cases and one synthetic SDK owner/notification case are separate
from real QQ acceptance:

```sh
python -m unittest -v maibot-dsh.test_jobs.Lifecycle
python -m unittest -v maibot-dsh.test_plugin.PluginBoundary
```

Run these from the parent folder, using the MaiBot Python environment for the
SDK case. Local acceptance also used one real DSH headless task to read a
synthetic file and check its answer. Login, friend metadata, loaded components
and HTTP health alone do not establish a successful real QQ conversation or
end-to-end background notification. User-visible acceptance is a short QQ
request, continued chat and its eventual task result; do not run full reader
tests/builds for this isolated integration.

References: [MaiBot](https://github.com/Mai-with-u/MaiBot),
[unified QQ connector](https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter),
[DSH](https://github.com/deepseek-ai/deepseek-harness).
