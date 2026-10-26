"""Completed-cycle compaction and durable, source-linked context checkpoints."""
import asyncio
import uuid

from . import codec
from .budget import Budget
from .store import Store, commit_io


class SessionPolicy:
    def __init__(self, settings, session_id):
        self.settings = settings
        self.session_id = session_id
        self.store = Store(settings.state_dir, session_id)
        self.budget = Budget(settings)
        self.revision = None
        self.overhead = 0
        self.overheads = {}

    def status(self, state, **counts):
        self.store.write("status.json", {"state": state, "soft_tokens": self.settings.soft_tokens,
            "target_tokens": self.settings.target_tokens, "request_limit_tokens": self.settings.request_limit_tokens,
            "estimator": self.settings.tokenizer, "usage": self.budget.usage, **counts})

    def history_tokens(self, history):
        from src.llm_models.payload_content.context_snapshot import serialize_context_items_snapshot
        items = [item for message in history if (item := message.to_context_item(enable_visual_message=True)) is not None]
        return self.budget.estimate(serialize_context_items_snapshot(items))

    def checkpoint(self, history, *, revision=None, segment=None):
        entries = [codec.encode(m) for m in history]
        message_ids = [m.message_id for m in history if getattr(m, "message_id", None) and m.count_in_context]
        latest = max((m.timestamp.timestamp() for m in history if m.count_in_context), default=0)
        value = {"schema": 1, "session_id": self.session_id, "history": entries,
                 "message_ids": message_ids, "latest_raw_timestamp": latest,
                 "revision": revision or self.revision, "usage": self.budget.usage,
                 "overhead": self.overhead, "overheads": self.overheads}
        if segment is not None:
            self.store.write("segment-" + revision + ".json", segment)
        self.store.write("checkpoint.json", value)

    def restore(self, recent):
        value = self.store.read()
        if value is None:
            return list(recent)
        if value["session_id"] != self.session_id:
            raise ValueError("Checkpoint belongs to another session; original file preserved")
        restored = [codec.decode(m) for m in value["history"]]
        seen = set(value["message_ids"])
        # DB messages received after the last completed cycle remain real messages,
        # not fabricated assistant/tool protocol. Earlier covered messages stay summarized.
        for message in recent:
            message_id = getattr(message, "message_id", None)
            if (message.count_in_context and message_id not in seen
                    and message.timestamp.timestamp() >= value["latest_raw_timestamp"]):
                restored.append(message)
                seen.add(message_id)
        self.budget.usage = dict(value.get("usage", {}))
        self.revision = value.get("revision")
        self.overhead = value.get("overhead", 0)
        self.overheads = dict(value.get("overheads", {}))
        self.status("restored", history_entries=len(restored), revision=self.revision)
        return restored

    async def after_cycle(self, engine, cycle_detail, *, enable_compaction=True, consume_references=True):
        from src.maisaka.context.post_processor import process_chat_history_after_cycle, _trim_history_to_context_target
        from src.maisaka.context.compaction import ContextSummaryMessage, build_context_summary
        runtime = engine._runtime
        # Steering/incomplete tool cycles are not compaction or checkpoint boundaries.
        pending = runtime._get_pending_wait_tool_call_ids()
        if not consume_references or pending:
            return
        original = list(runtime._chat_history)
        processed = process_chat_history_after_cycle(original, max_context_size=10**9,
                                                       pending_call_ids=pending, consume_references=True).history
        estimate = self.history_tokens(processed) + self.overhead
        state = "ready"
        candidate = list(processed)
        removed = []
        revision = None
        segment = None
        if enable_compaction and estimate >= self.settings.soft_tokens:
            count = sum(m.count_in_context for m in processed)
            low, high = 5, max(5, count - 1)
            # The native prefix planner protects the latest user turn and whole
            # tool-call/result spans. Token estimates choose among those safe cuts.
            while low <= high:
                target = (low + high) // 2
                trial = list(processed)
                cut = _trim_history_to_context_target(trial, target_context_count=target, pending_call_ids=pending)
                remaining = self.history_tokens(trial) + self.overhead
                if cut and remaining <= self.settings.target_tokens:
                    candidate, removed = trial, cut
                    low = target + 1
                else:
                    high = target - 1
            snapshot = runtime._chat_loop_service.planner_request_snapshot
            if removed and snapshot is not None:
                previous = next((m for m in reversed(processed) if isinstance(m, ContextSummaryMessage)), None)
                try:
                    from src.config.config import global_config
                    summary = await build_context_summary(removed, planner_snapshot=snapshot,
                        previous_summary=previous, recent_messages=candidate,
                        session_id=self.session_id, max_summary_chars=global_config.chat.context_compaction_summary_max_chars)
                    candidate = [summary, *[m for m in candidate if not isinstance(m, ContextSummaryMessage)]]
                    revision = uuid.uuid4().hex
                    segment = {"schema": 1, "revision": revision, "parent_revision": self.revision,
                        "source_ids": [getattr(m, "message_id", None) or getattr(m, "context_item_id", None)
                                       or getattr(getattr(m, "output_item", None), "meta", None).item_id
                                       for m in removed],
                        "removed": [codec.encode(m) for m in removed], "summary": codec.encode(summary)}
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # The same originals and previous summary remain available for
                    # a later cycle. Never publish the native lossy failure fallback.
                    candidate, removed, segment = processed, [], None
                    state = "compaction_failed_preserved"
            else:
                candidate, removed = processed, []
                state = "protected_or_cold_snapshot"
        if len(runtime._chat_history) != len(original) or any(a is not b for a, b in zip(runtime._chat_history, original)):
            return
        try:
            await commit_io(lambda: self.checkpoint(candidate, revision=revision, segment=segment))
        except asyncio.CancelledError:
            raise
        except Exception:
            self.status("checkpoint_failed_preserved", history_entries=len(original))
            return
        if len(runtime._chat_history) != len(original) or any(a is not b for a, b in zip(runtime._chat_history, original)):
            self.status("new_input_preserved", history_entries=len(runtime._chat_history))
            return
        # Persist first, then replace the active history. No awaited operation in
        # this commit section can race a new arrival or /clear.
        runtime._chat_history = candidate
        if removed:
            runtime._chat_loop_service.planner_request_snapshot = None
            self.revision = revision
        self.status(state, history_entries=len(candidate), estimated_input_tokens=estimate,
                    removed_entries=len(removed), revision=self.revision)
