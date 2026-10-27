# Native MaiBot → DSH ACP worker

This optional launcher replaces the legacy task-queue plugin with MaiBot's
native Agent connection. MaiBot owns persona, chat, memory and IM delivery;
DSH owns its tool loop and separate persistent ACP session. The reader remains
an independently registered DSH tool. No second queue or reply controller is added.

`worker.py --settings /private/worker.json --profile acp` reads these settings:

- `node`, `dsh_entry`: absolute paths to the installed Node and DSH CLI.
- `dsh_home`: a dedicated worker home, separate from the daily Web profile.
- `workspace`: the standing execution directory.
- `connection_file`: the local TOML with `model.api_key` already configured.

The launcher reads the key privately and passes it through
`MAIBOT_DSH_API_KEY`. It replaces itself with DSH; stdout stays exclusively ACP.
The worker does not copy chat, persona, memory, or credentials into arguments.

Prepare an ACP profile with the installed CLI, then set its private overlay:

- `agent-default-model` **and `acp`** must select the configured worker provider
  and model. Configuring only the former leaves ACP using its shipped default.
- `llm-pi-ai.providers` uses that provider's endpoint/model, with
  `apiKeyEnv: MAIBOT_DSH_API_KEY` instead of a literal secret.
- `sandbox-policy` is `workspace-write` at the standing workspace;
  `approval.policy` is `never`. Disable `tool-working-directory`, model-facing
  plugin/config editing, telemetry, and automatic title-model requests.
- Retain the previously configured reader-tool plugin, if installed.

In native MaiBot Agent settings enable the DSH connection, point `acp_command`
to an executable wrapper for this launcher, and set `acp_cwd` to the same
workspace. Leave `acp_model` empty to use the worker profile. The native preset
passes `--profile acp`, which is the only forwarded option this launcher accepts.
This WSL setup leaves `computer_tools` off; it does not provide Windows desktop
observation or control. Native IM admission rules remain responsible for callers.

Stop MaiBot before activating this configuration and disabling the legacy
plugin through its reserved `[plugin] enabled = false` marker. Preserve its
ledger and code for rollback. Do not keep both task routes active.

The installed MaiBot permission handler automatically accepts `allow_once`.
The worker deliberately uses `approval: never`, preserving the prior execution
boundary instead of depending on that automatic permission answer. A real ACP
task verified inside writes and rejected an outside write with zero permission
requests. The file sandbox constrains modifications; it does not promise host
file-read or network isolation.

Also verified with the actual native `AcpAgent`: HTTP MCP mounting, tool
discovery, a read-only `agent_status` invocation and session resume. No QQ test
messages were sent. IM task → agent → actual IM result delivery still needs a
user-initiated task. A queued native `agent_talk` receipt means acceptance;
it is not proof of task completion or IM delivery. Tool evidence must establish
those separately. No reader regression suite or app build is required here.
