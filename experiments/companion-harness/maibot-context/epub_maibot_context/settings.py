from dataclasses import dataclass
from pathlib import Path
import json
import os


@dataclass(frozen=True)
class Settings:
    state_dir: str
    prefix_file: str
    suffix_file: str
    context_mode: str = "native"
    soft_tokens: int = 256000
    target_tokens: int = 192000
    request_limit_tokens: int = 320000
    output_reserve_tokens: int = 16384
    restore_fallback_messages: int = 4096
    tokenizer: str = "o200k_base"

    def __post_init__(self):
        if self.context_mode not in {"native", "managed"}:
            raise ValueError("context_mode must be native or managed")
        if self.context_mode == "managed" and not 0 < self.target_tokens < self.soft_tokens < self.request_limit_tokens:
            raise ValueError("Context budgets must satisfy target < soft < request limit")

    def prompts(self):
        # User text is opaque data, with no format/macro evaluation.
        return tuple(Path(p).read_text() if Path(p).exists() else ""
                     for p in [self.prefix_file, self.suffix_file])


def load():
    path = os.environ.get("EPUB_MAIBOT_CONTEXT_SETTINGS")
    return Settings(**json.loads(Path(path).read_text())) if path else None
