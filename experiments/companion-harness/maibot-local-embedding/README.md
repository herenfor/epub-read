# Local MaiBot embedding service

This optional experiment serves downloaded embedding GGUFs with an official
Windows llama.cpp CUDA build. It does not install a reader model or modify the
Core/Android app, persona, chat history, or DSH configuration.

Copy `service.ps1` beside a private `service.json` containing `runtimeExe`,
`modelsDirectory`, `port`, `idleSeconds` and `apiKeyFile` (Windows paths).
Run `service.ps1 start|stop|status`. The router binds only to localhost, checks
an API key, loads at most one model, and sleeps its worker after the configured
idle period. Stop terminates the owned router and its workers. Weights, CUDA
runtime, configuration, keys and runtime logs stay outside Git.

`configure.py` runs under MaiBot's Python environment **while MaiBot is stopped**:

```sh
python configure.py --instance /absolute/instance --settings /private/models.json \
  --profile small --enable-memory
```

The private settings document has `endpoint` (OpenAI-compatible `/v1` URL),
`api_key_file`, `provider_name`, and `models.small` / `models.large`, each with
`name`, `id`, `dimension`. Use `--profile large` to select the other model;
restart MaiBot afterward. The script backs up the two original TOML files,
registers both models and selects exactly one embedding route. Text-model routes,
persona and other native memory settings are preserved. `--enable-memory` is
explicit; without it the existing memory switch is preserved.

The current host's native A_Memorix already fingerprints models and maintains
separate vector spaces. Retain those spaces when switching; the first use of a
new model must encode existing memories. Never make different embedding models
automatic fallbacks, even when they have the same dimension. This component
does not read or migrate another bot's memories.

Native recovery probes run every ten minutes and can briefly wake the selected
worker. Native startup synchronizes its model space; no full re-encoding is
requested just to switch back. This host version's vector-space listing API
is missing actions in its native admin allowlist; the selector does not depend
on that listing API or bypass its restrictions.

Requests use native full dimensions and last-token pooling. Service context is
bounded to 8192 tokens, one slot, physical batches of 512. MaiBot uses batches
of four and one concurrent request. These are inference resource limits, not
the bot's conversation-context budget. Plain native text input is used; no
query/document instruction adapter or retrieval-quality benchmark is claimed.

Verified locally with synthetic bilingual embedding requests and MaiBot's own
embedding adapter. Actual long-term recall quality requires normal user use.
The default Jina v5 small retrieval weights are CC-BY-NC-4.0; Qwen3 4B weights
are Apache-2.0. Download them from their official repositories; neither weights
nor user configuration are included here.
