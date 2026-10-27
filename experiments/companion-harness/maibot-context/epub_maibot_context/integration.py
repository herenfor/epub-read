"""Narrow native hooks. All content handling stays inside the local process."""
import asyncio
from dataclasses import replace
import inspect
import weakref

from .settings import load
from .policy import SessionPolicy
from .store import Store

_policies = {}
_runtimes = weakref.WeakValueDictionary()


def install_runtime(cls):
    settings = load()
    if settings is None or settings.context_mode != "managed" or getattr(cls, "_epub_context_installed", False):
        return
    restore_native = cls._restore_recent_context_from_db
    restore_limit_native = cls._get_context_restore_limit
    stop_native = cls.stop
    size_native = cls._max_context_size.fget

    async def restore(runtime):
        settings = load()
        policy = SessionPolicy(settings, runtime.session_id)
        _policies[runtime.session_id] = policy
        _runtimes[runtime.session_id] = runtime
        await restore_native(runtime)
        restored = await asyncio.to_thread(policy.restore, list(runtime._chat_history))
        from src.maisaka.context.messages import SessionBackedMessage
        from src.maisaka.runtime import MAX_RETAINED_MESSAGE_CACHE_SIZE
        runtime._chat_history = restored
        runtime._quote_counter = type(runtime._quote_counter)(runtime.session_id)
        for message in restored:
            if isinstance(message, SessionBackedMessage):
                runtime._quote_counter.record(message.original_message)
        runtime.message_cache = [m.original_message for m in restored
                                 if isinstance(m, SessionBackedMessage) and m.source_kind == "user"][-MAX_RETAINED_MESSAGE_CACHE_SIZE:]
        runtime._last_processed_index = len(runtime.message_cache)

    async def stop(runtime):
        try:
            return await stop_native(runtime)
        finally:
            _policies.pop(runtime.session_id, None)
            _runtimes.pop(runtime.session_id, None)

    async def retro_history(runtime):
        # Native retro replies otherwise query 60% of the count limit from DB.
        # Share the bounded, summary-bearing working history with the planner.
        return list(runtime._chat_history)

    cls._restore_recent_context_from_db = restore
    cls._get_context_restore_limit = lambda runtime: load().restore_fallback_messages if load() else restore_limit_native(runtime)
    # Disable count-based prompt slicing. Actual limits are enforced on the
    # assembled request; this is not a million-token setting.
    cls._max_context_size = property(lambda runtime: 10**9 if load() else size_native(runtime))
    cls.build_retro_reply_history = retro_history
    cls.stop = stop
    cls._epub_context_installed = True


def install_engine(cls):
    settings = load()
    if settings is None or settings.context_mode != "managed" or getattr(cls, "_epub_context_installed", False):
        return
    native = cls._post_process_chat_history_after_cycle

    async def after(engine, cycle_detail, **kwargs):
        policy = _policies.get(engine._runtime.session_id)
        if policy is None:
            return await native(engine, cycle_detail, **kwargs)
        return await policy.after_cycle(engine, cycle_detail, **kwargs)

    cls._post_process_chat_history_after_cycle = after
    cls._epub_context_installed = True


def _assemble(items, settings):
    from src.config.config import global_config
    from src.llm_models.payload_content.context_item import (
        ContextItemMeta, ContextTextPart, SystemMessageItem, UserMessageItem)
    prefix, suffix = settings.prompts()
    clean = [item for item in items if item.meta.item_id not in {"epub:prefix", "epub:suffix"}]
    if not prefix.strip() and not suffix.strip():
        return clean
    native = global_config.personality
    names = [global_config.bot.nickname, *global_config.bot.alias_names]
    values = [native.personality.strip(), native.behavior_style.strip(), native.reply_style.strip()]
    cleaned = []
    for item in clean:
        if isinstance(item, SystemMessageItem):
            parts = []
            for part in item.parts:
                if not isinstance(part, ContextTextPart):
                    parts.append(part)
                    continue
                text = part.text
                for value in values:
                    if value:
                        text = text.replace(value, "")
                for name in names:
                    if name:
                        text = text.replace("你的名字是" + name, "角色身份以附加设定为准")
                        text = text.replace("你是" + name, "角色身份以附加设定为准")
                if text.strip():
                    parts.append(ContextTextPart(text))
            if parts:
                item = replace(item, parts=tuple(parts))
            else:
                continue
        cleaned.append(item)
    if prefix.strip():
        cleaned.insert(0, SystemMessageItem(meta=ContextItemMeta.create(item_id="epub:prefix"),
                                            parts=(ContextTextPart(prefix),)))
    if suffix.strip():
        cleaned.append(UserMessageItem(meta=ContextItemMeta.create(item_id="epub:suffix"),
                                        parts=(ContextTextPart(suffix),)))
    return cleaned


def _tool_snapshot(tools):
    from src.llm_models.payload_content.tool_option import normalize_tool_options
    from src.llm_models.request_snapshot import serialize_tool_options_snapshot
    # The service facade accepts raw function dictionaries; ResponseRequest
    # snapshots contain ToolOption objects. Normalize only this projection.
    return serialize_tool_options_snapshot(normalize_tool_options(tools))


def install_service(cls):
    if load() is None or getattr(cls, "_epub_context_installed", False):
        return
    native_context = cls.generate_response_with_context
    native_snapshot = cls.generate_response_from_snapshot

    async def generate(service, context_factory, options=None, *, session_id=""):
        sid = session_id or service.session_id
        settings = load()
        policy = _policies.get(sid) if settings.context_mode == "managed" else None
        if service.task_name not in {"planner", "replyer"}:
            return await native_context(service, context_factory, options, session_id=session_id)
        from src.llm_models.payload_content.context_snapshot import serialize_context_items_snapshot
        measured = {}

        async def factory(client, model_info=None):
            value = context_factory(client, model_info) if len(inspect.signature(context_factory).parameters) >= 2 else context_factory(client)
            items = await value if inspect.isawaitable(value) else value
            prepared = _assemble(list(items), settings)
            if policy is None:
                return prepared
            projection = {"items": serialize_context_items_snapshot(prepared),
                          "tools": _tool_snapshot(getattr(options, "tool_options", None))}
            estimate = await asyncio.to_thread(policy.budget.estimate, projection)
            policy.budget.guard(estimate, getattr(options, "max_tokens", None))
            measured["estimate"] = estimate
            runtime = _runtimes.get(sid)
            if runtime is not None:
                history = await asyncio.to_thread(policy.history_tokens, list(runtime._chat_history))
                policy.overheads[service.task_name] = max(0, estimate - history)
                policy.overhead = max(policy.overheads.values(), default=0)
            return prepared

        result = await native_context(service, factory, options, session_id=session_id)
        if policy is not None:
            policy.budget.observe(measured.get("estimate", 0), getattr(result, "prompt_tokens", 0))
        return result

    async def snapshot(service, request):
        policy = _policies.get(service.session_id)
        if service.request_type == "maisaka.context_compaction":
            request = request.detached_snapshot()
            request.context_items = [item for item in request.context_items
                                    if item.meta.item_id not in {"epub:prefix", "epub:suffix"}]
        if load().context_mode == "managed" and policy is not None:
            from src.llm_models.payload_content.context_snapshot import serialize_context_items_snapshot
            estimate = await asyncio.to_thread(policy.budget.estimate,
                {"items": serialize_context_items_snapshot(request.context_items),
                 "tools": _tool_snapshot(request.tool_options)})
            policy.budget.guard(estimate, getattr(request, "max_tokens", None))
        # Native compaction reuses an already assembled snapshot: do not inject
        # the character twice or turn private reasoning into a memory prompt.
        return await native_snapshot(service, request)

    cls.generate_response_with_context = generate
    cls.generate_response_from_snapshot = snapshot
    cls._epub_context_installed = True


def install_manager(cls):
    if load() is None or getattr(cls, "_epub_context_installed", False):
        return
    native_clear = cls.clear_chat_history_context

    async def clear(manager, session_id):
        result = await native_clear(manager, session_id)
        Store(load().state_dir, session_id).clear()
        return result

    cls.clear_chat_history_context = clear
    cls._epub_context_installed = True


def install_deletion(namespace):
    if load() is None or namespace.get("_epub_context_delete_installed"):
        return
    native = namespace["_delete_chat_session_scope"]

    def delete(session_id):
        result = native(session_id)
        # A generation fence also revokes any old runtime's in-flight writer.
        Store(load().state_dir, session_id).purge()
        return result

    namespace["_delete_chat_session_scope"] = delete
    namespace["_epub_context_delete_installed"] = True


def install_diagnostics(namespace):
    if load() is None or namespace.get("_epub_private_diagnostics_installed"):
        return

    def private_failure(**kwargs):
        # Upstream normally writes complete failed requests even when prompt
        # previews are off. Keep only its in-memory attempt metadata here.
        trace = kwargs.get("trace_context")
        if trace is not None:
            namespace["record_failed_generation_attempt"](**{key: kwargs[key] for key in
                ["api_provider", "client_type", "error", "model_info", "operation", "trace_context"]})
        return None

    namespace["save_failed_request_snapshot"] = private_failure
    namespace["_epub_private_diagnostics_installed"] = True
