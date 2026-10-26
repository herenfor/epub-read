"""Explicit JSON checkpoints using MaiBot's existing protocol/media codecs."""
from dataclasses import fields
from datetime import datetime


def encode(message):
    from src.maisaka.context import messages as m
    from src.maisaka.context.compaction import ContextSummaryMessage
    from src.plugin_runtime.host.message_utils import PluginMessageUtils as io
    from src.llm_models.payload_content.context_snapshot import serialize_context_item_snapshot
    kind = type(message).__name__
    allowed = {c.__name__: c for c in [m.ContentContextMessage, m.InternalContextMessage,
        m.ToolResultMediaMessage, m.SessionBackedMessage, m.ComplexSessionMessage,
        m.ReferenceMessage, m.ModelOutputContextMessage, m.ToolResultMessage, ContextSummaryMessage]}
    if type(message) is not allowed.get(kind):
        raise ValueError("Unsupported context entry type; checkpoint not replaced")
    if isinstance(message, m.ModelOutputContextMessage):
        return {"kind": kind, "source_kind": message.source_kind,
                "item": serialize_context_item_snapshot(message.output_item)}
    data = {f.name: getattr(message, f.name) for f in fields(message)}
    data["timestamp"] = message.timestamp.isoformat()
    if isinstance(message, m.ReferenceMessage):
        data["reference_type"] = message.reference_type.value
    if isinstance(message, m.ContentContextMessage):
        data["raw_message"] = io._message_sequence_to_dict(message.raw_message, include_binary_data=True)
    if isinstance(message, m.SessionBackedMessage):
        data["original_message"] = io._session_message_to_dict(message.original_message, include_binary_data=True)
        data["original_message"]["platform_message_id"] = message.original_message.platform_message_id
    return {"kind": kind, "data": data}


def decode(record):
    from src.maisaka.context import messages as m
    from src.maisaka.context.compaction import ContextSummaryMessage
    from src.plugin_runtime.host.message_utils import PluginMessageUtils as io
    from src.llm_models.payload_content.context_snapshot import deserialize_context_item_snapshot
    kinds = {c.__name__: c for c in [m.ContentContextMessage, m.InternalContextMessage,
        m.ToolResultMediaMessage, m.SessionBackedMessage, m.ComplexSessionMessage,
        m.ReferenceMessage, m.ModelOutputContextMessage, m.ToolResultMessage, ContextSummaryMessage]}
    cls = kinds[record["kind"]]
    if cls is m.ModelOutputContextMessage:
        return cls(output_item=deserialize_context_item_snapshot(record["item"]), source_kind=record["source_kind"])
    data = dict(record["data"])
    data["timestamp"] = datetime.fromisoformat(data["timestamp"])
    if issubclass(cls, m.ReferenceMessage):
        data["reference_type"] = m.ReferenceMessageType(data["reference_type"])
        data["jargon_entries"] = tuple(tuple(x) for x in data.get("jargon_entries", []))
    if issubclass(cls, m.ContentContextMessage):
        data["raw_message"] = io._message_sequence_from_dict(data["raw_message"])
    if issubclass(cls, m.SessionBackedMessage):
        original = data["original_message"]
        restored = io._build_session_message_from_dict(original)
        restored.platform_message_id = original.get("platform_message_id")
        if original.get("received_at"):
            restored.received_at = datetime.fromisoformat(original["received_at"])
        data["original_message"] = restored
    return cls(**data)
