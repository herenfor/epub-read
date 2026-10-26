"""One task through the official DSH headless profile; no model loop here."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import tomllib
from pathlib import Path


class DshDriver:
    def __init__(self, settings: dict):
        self.settings = settings

    async def run(self, objective: str, update):
        cfg = self.settings
        # Resolve credentials only inside the trusted adapter, never tool arguments.
        connection = tomllib.loads(Path(cfg["connection_file"]).read_text())
        key = connection["model"]["api_key"]
        if not key:
            raise ValueError("请先在本机配置中填写模型 API Key。")
        env = {**os.environ, "DSH_HOME": cfg["dsh_home"],
               "MAIBOT_DSH_API_KEY": key, "DSH_PERMISSION_MODE": "workspace-write",
               "DO_NOT_TRACK": "1"}
        proc = await asyncio.create_subprocess_exec(
            cfg["node"], cfg["dsh_entry"], "headless", "--json", "-",
            cwd=cfg["workspace"], env=env, start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=1024 * 1024)
        stderr_tail = bytearray()

        async def drain_errors():
            while chunk := await proc.stderr.read(4096):
                stderr_tail.extend(chunk)
                del stderr_tail[:-4096]

        errors = asyncio.create_task(drain_errors())
        final = None
        try:
            proc.stdin.write(objective.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()
            async for line in proc.stdout:
                event = json.loads(line)
                kind = event.get("type")
                if kind == "session":
                    update(session_id=event["sessionId"])
                elif kind == "tool_call":
                    update(last_tool=event.get("tool", ""), tool_call=True)
                elif kind == "final":
                    final = str(event.get("text", "")).replace(key, "[redacted]")
                # Reasoning, tool bodies and streamed chat are not copied to job metadata.
            code = await proc.wait()
            await errors
            if code != 0 or final is None:
                detail = stderr_tail.decode("utf-8", "replace").replace(key, "[redacted]")
                raise RuntimeError("DSH 未正常完成任务。" + detail[-1500:])
            update(result_truncated=len(final) > 12000)
            return final[:12000]
        finally:
            # Complete process cleanup before the manager publishes a cancelled state.
            if proc.returncode is None:
                for sig, seconds in [(signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 2)]:
                    try:
                        os.killpg(proc.pid, sig)
                    except ProcessLookupError:
                        break
                    try:
                        await asyncio.wait_for(proc.wait(), seconds)
                        break
                    except asyncio.TimeoutError:
                        pass
            await asyncio.gather(errors, return_exceptions=True)
