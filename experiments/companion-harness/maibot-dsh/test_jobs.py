"""Focused task lifecycle checks; no QQ, credentials, or model requests."""
import asyncio
import tempfile
import unittest
from pathlib import Path

from .jobs import Jobs


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_queued_and_running_cancel_drain_before_terminal(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        class Driver:
            async def run(self, objective, update):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    await asyncio.sleep(0)
                    stopped.set()

        with tempfile.TemporaryDirectory() as temp:
            jobs = Jobs(Path(temp) / "jobs.json", Driver())
            first = jobs.submit("slow", "owner-session")
            await started.wait()
            queued = jobs.submit("queued", "owner-session")
            self.assertEqual((await jobs.cancel(queued["id"], "owner-session"))["state"], "cancelled")
            result = await jobs.cancel(first["id"], "owner-session")
            self.assertTrue(stopped.is_set())
            self.assertEqual(result["state"], "cancelled")
            self.assertFalse(jobs.tasks)

    async def test_result_origin_and_restart_do_not_repeat_execution(self):
        calls = []

        class Driver:
            async def run(self, objective, update):
                calls.append(objective)
                update(session_id="synthetic-dsh-session")
                return "synthetic result"

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "jobs.json"
            jobs = Jobs(path, Driver())
            row = jobs.submit("one task", "origin-A")
            await jobs.tasks[row["id"]]
            with self.assertRaises(ValueError):
                jobs.get(row["id"], "origin-B")
            restored = Jobs(path, Driver())
            self.assertEqual(restored.pending()[0]["stream_id"], "origin-A")
            self.assertEqual(calls, ["one task"])
            restored.handed_off(row["id"])
            self.assertEqual(Jobs(path, Driver()).pending(), [])


if __name__ == "__main__":
    unittest.main()
