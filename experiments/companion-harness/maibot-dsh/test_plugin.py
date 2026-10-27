"""One SDK-envelope/notification case, using synthetic platform metadata only."""
import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from maibot_sdk.context import PluginContext

from .jobs import Jobs
from .plugin import DshBridgePlugin


class PluginBoundary(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_unwrapped_owner_and_handoff_keep_original_session(self):
        calls = []
        handed_off = asyncio.Event()

        async def lookup(*args, **kwargs):
            return PluginContext._normalize_capability_result(
                "chat.get_stream_by_user_id",
                {"success": True, "stream": {"session_id": "original-session"}})

        async def trigger(stream, intent, **kwargs):
            calls.append((stream, intent, kwargs))
            handed_off.set()
            return {"success": True, "task_id": "synthetic-native-task"}

        class Driver:
            async def run(self, objective, update):
                return "synthetic task result"

        with tempfile.TemporaryDirectory() as temp:
            plugin = DshBridgePlugin()
            plugin.settings = {"owner_qq": "synthetic-owner"}
            plugin._set_context(SimpleNamespace(
                chat=SimpleNamespace(get_stream_by_user_id=lookup),
                maisaka=SimpleNamespace(proactive=SimpleNamespace(trigger=trigger))))
            plugin.jobs = Jobs(Path(temp) / "jobs.json", Driver())
            context = {"platform": "qq", "user_id": "synthetic-owner", "stream_id": "original-session"}
            denied = await plugin.submit("do nothing", **{**context, "user_id": "someone-else"})
            self.assertFalse(denied["success"])
            wrong_session = await plugin.submit("do nothing", **{**context, "stream_id": "another-session"})
            self.assertFalse(wrong_session["success"])
            self.assertEqual(len(plugin.jobs.rows), 0)
            accepted = await plugin.submit("synthetic task", **context)
            self.assertTrue(accepted["success"])
            job_id = accepted["job"]["id"]
            await plugin.jobs.tasks[job_id]
            task = asyncio.create_task(plugin._notifications())
            await asyncio.wait_for(handed_off.wait(), 1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.assertEqual(calls[0][0], "original-session")
            self.assertIn("synthetic task result", calls[0][1])
            self.assertEqual(calls[0][2]["metadata"]["job_id"], job_id)
            self.assertTrue(plugin.jobs.get(job_id, "original-session")["handed_off"])
