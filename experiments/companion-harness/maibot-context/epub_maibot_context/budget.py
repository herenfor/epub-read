"""Full-input estimates, calibrated upward with provider usage. No content logs."""
import json
import math
import tiktoken


class BudgetExceeded(ValueError):
    pass


class Budget:
    def __init__(self, settings, usage=None):
        self.settings = settings
        self.encoder = tiktoken.get_encoding(settings.tokenizer)
        self.usage = dict(usage or {})

    def estimate(self, value):
        image_cost = 0

        def project(obj):
            nonlocal image_cost
            if isinstance(obj, dict):
                out = {}
                for key, val in obj.items():
                    if key == "image_base64":
                        image_cost += 8192
                    elif key not in {"replay", "encrypted_content", "thought_signature"}:
                        out[key] = project(val)
                return out
            if isinstance(obj, (tuple, list)):
                return [project(v) for v in obj]
            return obj

        text = json.dumps(project(value), ensure_ascii=False, default=str)
        raw = len(self.encoder.encode(text, disallowed_special=())) + image_cost
        return math.ceil(raw * max(1.0, self.usage.get("scale", 1.0)))

    def observe(self, estimated, actual):
        if estimated > 0 and actual > 0:
            ratio = actual / estimated
            previous = self.usage.get("scale", 1.0)
            self.usage["scale"] = max(1.0, previous, ratio * previous * 1.15)
            self.usage["last_prompt_tokens"] = actual

    def guard(self, estimated, output_tokens=0):
        reserve = max(self.settings.output_reserve_tokens, output_tokens or 0)
        if estimated + reserve > self.settings.request_limit_tokens:
            raise BudgetExceeded("模型请求预算不足；保留原上下文，未发送超预算请求。"
                                 f" estimated={estimated}, reserve={reserve}, limit={self.settings.request_limit_tokens}")
