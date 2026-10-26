"""Small native-object fixtures. No user data, real models or QQ requests."""
import asyncio
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from epub_maibot_context.settings import Settings
from epub_maibot_context.policy import SessionPolicy
from epub_maibot_context.budget import BudgetExceeded
from epub_maibot_context import codec, integration

from src.chat.message_receive.message import SessionMessage
from src.common.data_models.mai_message_data_model import MessageInfo, UserInfo
from src.common.data_models.message_component_data_model import MessageSequence, TextComponent
from src.maisaka.context.messages import SessionBackedMessage, ModelOutputContextMessage, ToolResultMessage
from src.maisaka.context.compaction import ContextSummaryMessage
from src.llm_models.payload_content.context_item import ContextItemMeta, ContextToolCall, FunctionCallItem
from src.llm_models.payload_content.context_item import ContextItemBuilder, RoleType


def message(index, text="synthetic recent text"):
    stamp = datetime(2026, 1, 1) + timedelta(seconds=index)
    raw = SessionMessage(message_id=f"synthetic-{index}", timestamp=stamp, platform="qq")
    raw.account_id = "10000"
    raw.session_id = "synthetic-session"
    raw.message_info = MessageInfo(UserInfo("20000", "synthetic-user", ""))
    raw.raw_message = MessageSequence([TextComponent(text)])
    raw.processed_plain_text = text
    return SessionBackedMessage.from_session_message(raw, raw_message=raw.raw_message, visible_text=text)


class ContextCases(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.prefix = self.root / "prefix.md"
        self.suffix = self.root / "suffix.md"
        self.prefix.write_text("")
        self.suffix.write_text("")
        self.cfg = Settings(str(self.root / "state"), str(self.prefix), str(self.suffix),
                            soft_tokens=2000, target_tokens=1000, request_limit_tokens=5000, output_reserve_tokens=100)

    def tearDown(self):
        self.temp.cleanup()

    async def test_restart_keeps_summary_recent_over_30_and_closed_tool_identity(self):
        policy = SessionPolicy(self.cfg, "synthetic-session")
        history = [ContextSummaryMessage(content="synthetic earlier summary", timestamp=datetime(2025, 12, 31))]
        history += [message(i) for i in range(80)]
        call = ModelOutputContextMessage(FunctionCallItem(
            meta=ContextItemMeta.create(logical_turn_id="turn-one"),
            tool_call=ContextToolCall.create(call_id="call-one", func_name="synthetic_tool", args={"x": 1})))
        result = ToolResultMessage(content="synthetic result", timestamp=datetime(2026, 1, 1),
                                   tool_call_id="call-one", logical_turn_id="turn-one", tool_name="synthetic_tool")
        history += [call, result]
        policy.checkpoint(history)
        restored = SessionPolicy(self.cfg, "synthetic-session").restore([message(79), message(80)])
        self.assertIsInstance(restored[0], ContextSummaryMessage)
        self.assertEqual(sum(m.count_in_context for m in restored), 81)
        self.assertEqual(restored[-3].tool_calls[0].call_id, "call-one")
        self.assertEqual(restored[-2].tool_call_id, "call-one")
        self.assertEqual(restored[-1].message_id, "synthetic-80")
        from epub_maibot_context.store import Store
        Store(self.cfg.state_dir, "synthetic-session").clear()
        with self.assertRaises(RuntimeError):
            policy.checkpoint(history)
        self.assertEqual(SessionPolicy(self.cfg, "synthetic-session").restore([]), [])

    async def test_failed_summary_retains_originals_then_success_links_sources(self):
        policy = SessionPolicy(self.cfg, "synthetic-session")
        history = [message(i, ("distinct synthetic words " + str(i) + " ") * 20) for i in range(40)]
        runtime = SimpleNamespace(session_id="synthetic-session", _chat_history=history,
            _get_pending_wait_tool_call_ids=lambda: set(),
            _chat_loop_service=SimpleNamespace(planner_request_snapshot=object()))
        engine = SimpleNamespace(_runtime=runtime)
        with patch("src.maisaka.context.compaction.build_context_summary", new=AsyncMock(side_effect=ValueError("synthetic failure"))):
            await policy.after_cycle(engine, SimpleNamespace())
        self.assertEqual([m.message_id for m in runtime._chat_history], [m.message_id for m in history])
        self.assertEqual(json.loads((policy.store.root / "status.json").read_text())["state"], "compaction_failed_preserved")
        summary = ContextSummaryMessage(content="synthetic completed summary", timestamp=datetime(2026, 1, 1))
        with patch("src.maisaka.context.compaction.build_context_summary", new=AsyncMock(return_value=summary)):
            await policy.after_cycle(engine, SimpleNamespace())
        self.assertIs(runtime._chat_history[0], summary)
        saved = policy.store.read()
        segment = json.loads((policy.store.root / ("segment-" + saved["revision"] + ".json")).read_text())
        self.assertTrue(segment["source_ids"])
        self.assertGreater(len(segment["removed"]), 0)
        self.assertGreaterEqual(sum(m.count_in_context for m in runtime._chat_history), 5)

    async def test_plain_prompts_both_routes_and_oversize_request_never_sent(self):
        self.prefix.write_text("synthetic prefix {{char}} remains literal")
        self.suffix.write_text("synthetic suffix {{user}} remains literal")
        settings = self.root / "settings.json"
        from dataclasses import asdict
        settings.write_text(json.dumps(asdict(self.cfg)))
        calls = []

        class Service:
            async def generate_response_with_context(self, factory, options=None, *, session_id=""):
                items = await factory(None)
                calls.append(items)
                return SimpleNamespace(prompt_tokens=100)

            async def generate_response_from_snapshot(self, snapshot):
                calls.append(snapshot.context_items)
                return SimpleNamespace(prompt_tokens=100)

        policy = SessionPolicy(self.cfg, "synthetic-session")
        integration._policies["synthetic-session"] = policy
        with patch.dict(os.environ, {"EPUB_MAIBOT_CONTEXT_SETTINGS": str(settings)}):
            integration.install_service(Service)
            for task in ["planner", "replyer"]:
                service = Service()
                service.task_name, service.session_id, service.request_type = task, "synthetic-session", "maisaka.chat"
                async def factory(client):
                    return [ContextItemBuilder().set_role(RoleType.User).add_text_content("synthetic question").build()]
                await service.generate_response_with_context(factory)
                self.assertEqual(calls[-1][0].parts[0].text, self.prefix.read_text())
                self.assertEqual(calls[-1][-1].parts[0].text, self.suffix.read_text())
            async def oversized(client):
                return [ContextItemBuilder().set_role(RoleType.User).add_text_content("oversize-token " * 20000).build()]
            with self.assertRaises(BudgetExceeded):
                await service.generate_response_with_context(oversized)
            prepared = list(calls[0])
            service.request_type = "maisaka.context_compaction"
            request = SimpleNamespace(context_items=prepared, tool_options=None, max_tokens=100)
            request.detached_snapshot = lambda: SimpleNamespace(context_items=list(prepared), tool_options=None, max_tokens=100)
            await service.generate_response_from_snapshot(request)
            self.assertFalse(any(item.meta.item_id in {"epub:prefix", "epub:suffix"} for item in calls[-1]))
            self.assertEqual(prepared[0].meta.item_id, "epub:prefix")
        self.assertEqual(len(calls), 3)
        integration._policies.pop("synthetic-session", None)
