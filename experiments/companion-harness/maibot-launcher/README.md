# One-command MaiBot startup

This optional WSL launcher coordinates existing local services. It does not
install QQ, download models, edit personas, merge conversations, or start the
daily DSH Web/Tobs host. No reader Core/Android code imports this directory.

Deploy a copy of `launcher.py` into the private runtime directory and
`windows/ensure-napcat.ps1` beside the existing Windows QQ launcher. This keeps
the installed command independent of future Git checkout changes. Create a
private JSON settings file with the fields from `Settings` in
`launcher.py`. Paths and credentials belong outside the product repository.
The Windows directory must already contain `start-bot-background.vbs`,
`start-bot.cmd` and the configured NapCat shell. The existing service script
must support `start`, `stop`, and reuse of an existing MaiBot process; `start`
must also ensure its configured embedding service when MaiBot is already up.

Run the coordinator with the installed MaiBot Python environment (Python 3.11+
and `websockets` supporting `proxy=None`):

```sh
python launcher.py --settings /private/launcher.json
python launcher.py --settings /private/launcher.json status
python launcher.py --settings /private/launcher.json --no-open
```

A local `maibot` wrapper can supply the interpreter and private settings path.
Default startup reuses the matching Windows NapCat process, starts the existing
MaiBot/embedding service, verifies the local WebUI, reads QQ login state using
the read-only OneBot `get_status` action and opens the management page. When QQ
is not ready it also opens the login page; QR confirmation remains a user action.
Repeated startup does not restart MaiBot or QQ. The working directory for
Windows commands is local to Windows, avoiding the CMD UNC-directory warning.

Native DSH ACP remains managed by MaiBot. This script reports the native Agent
enabled/paused/error/runtime state, and does not create another worker or change
task/permission settings. MaiBot's `connected` status field refers to the optional
desktop bridge; it does not establish an ACP connection and is not used here.
Port readiness and plugin load state do not prove model replies or IM delivery.
No chat messages, persona text, memory or keys are printed or written by the
coordinator. Existing services retain their own original logging policies.

Exit `0` means MaiBot, embedding, QQ login and the QQ adapter are ready, and an
enabled native Agent is running without a reported error or pause; `2`
means some services are up but login/connection/readiness needs attention; `1`
means the launcher failed. This does not test an actual DSH/model task.
`restart` restarts MaiBot and preserves QQ. `stop` stops MaiBot only and leaves
QQ and its independent embedding manager alone. It never kills unrelated QQ
processes. This is an explicit launcher, not a watchdog or boot-time task.
