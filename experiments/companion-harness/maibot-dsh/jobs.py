"""Small persistent job ledger. Conversation/persona/memory stay with MaiBot."""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


class Jobs:
    def __init__(self, path: Path, driver):
        self.path, self.driver = path, driver
        self.tasks: dict[str, asyncio.Task] = {}
        self.gate = asyncio.Semaphore(1)
        self.closing = False
        self.rows = json.loads(path.read_text()) if path.exists() else {}
        for row in self.rows.values():
            if row["state"] not in TERMINAL:
                row.update(state="interrupted", updated_at=time.time(),
                           result="执行服务已重启，原任务已中断，未自动重试。")
        self.save()

    def save(self):
        # Keep a bounded terminal history, retaining every result not handed off.
        delivered = sorted((r for r in self.rows.values()
                            if r["state"] in TERMINAL and r.get("handed_off")),
                           key=lambda r: r["updated_at"], reverse=True)
        for row in delivered[100:]:
            self.rows.pop(row["id"], None)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.rows, ensure_ascii=False))
        temp.chmod(0o600)
        os.replace(temp, self.path)

    def get(self, job_id: str, stream_id: str):
        row = self.rows.get(job_id)
        if row is None or row["stream_id"] != stream_id:
            raise ValueError("当前会话没有这个任务。")
        return dict(row)

    def submit(self, objective: str, stream_id: str):
        if self.closing:
            raise ValueError("执行服务正在停止。")
        objective = objective.strip()
        if not objective or len(objective) > 16000:
            raise ValueError("任务描述须为 1～16000 个字符；只传本次任务所需背景。")
        job_id = str(uuid.uuid4())
        row = {"id": job_id, "stream_id": stream_id, "state": "queued",
               "created_at": time.time(), "updated_at": time.time(),
               "title": objective[:120], "session_id": None, "last_tool": "",
               "tool_calls": 0, "handed_off": False, "result": "", "result_truncated": False}
        self.rows[job_id] = row
        self.save()
        self.tasks[job_id] = asyncio.create_task(self._run(row, objective))
        return dict(row)

    async def _run(self, row: dict, objective: str):
        def update(**values):
            if values.pop("tool_call", False):
                row["tool_calls"] += 1
            row.update(values, updated_at=time.time())
            self.save()

        try:
            async with self.gate:
                update(state="running")
                result = await self.driver.run(objective, update)
                update(state="completed", result=result)
        except asyncio.CancelledError:
            update(state="interrupted" if self.closing else "cancelled",
                   result="服务停止，任务已中断，未自动重试。" if self.closing else "任务已取消。")
        except Exception as error:
            update(state="failed", result=str(error)[:2000])
        finally:
            self.tasks.pop(row["id"], None)

    async def cancel(self, job_id: str, stream_id: str):
        row = self.get(job_id, stream_id)
        task = self.tasks.get(job_id)
        if row["state"] not in TERMINAL and task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            # A queued coroutine cancelled before first execution has no finally.
            if self.rows[job_id]["state"] not in TERMINAL:
                self.rows[job_id].update(state="cancelled", result="任务已取消。", updated_at=time.time())
                self.tasks.pop(job_id, None)
                self.save()
        return self.get(job_id, stream_id)

    def pending(self):
        return [dict(r) for r in self.rows.values()
                if r["state"] in TERMINAL and not r.get("handed_off")]

    def handed_off(self, job_id: str):
        self.rows[job_id]["handed_off"] = True
        self.save()

    async def close(self):
        self.closing = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for row in self.rows.values():
            if row["state"] not in TERMINAL:
                row.update(state="interrupted", result="服务停止，原任务未自动重试。", updated_at=time.time())
        self.tasks.clear()
        self.save()
