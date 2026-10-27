"""Register local embedding routes while MaiBot is stopped; never print config text."""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
import shutil

import tomlkit


def configure(instance: Path, settings_path: Path, profile: str, enable_memory: bool) -> None:
    instance, settings_path = instance.resolve(), settings_path.resolve()
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    selected = settings["models"][profile]
    paths = [instance / "config" / name for name in ("bot_config.toml", "model_config.toml")]
    bot, models = [tomlkit.loads(path.read_text(encoding="utf-8")) for path in paths]
    provider_name = settings["provider_name"]
    providers = models["api_providers"]
    provider = next((item for item in providers if item["name"] == provider_name), None)
    if provider is None:
        provider = tomlkit.table()
        providers.append(provider)
    provider.update({
        "name": provider_name, "base_url": settings["endpoint"], "client_type": "openai",
        "api_key": Path(settings["api_key_file"]).read_text(encoding="utf-8").strip(),
        "timeout": 180, "max_retry": 1, "retry_interval": 2,
    })
    for model in settings["models"].values():
        item = next((item for item in models["models"] if item["name"] == model["name"]), None)
        if item is None:
            item = tomlkit.table()
            models["models"].append(item)
        item.update({"name": model["name"], "model_identifier": model["id"],
                     "api_provider": provider_name, "model_type": "embedding"})
    # A second model is a deliberate selection, never a retry fallback: its vectors differ.
    models["model_task_config"]["embedding"]["model_list"] = [selected["name"]]
    models["model_task_config"]["embedding"]["hard_timeout"] = 180
    memory = bot["a_memorix"]
    memory["embedding"].update({"model_name": selected["name"], "dimension": selected["dimension"],
        "dimension_request_mode": "never", "batch_size": 4, "max_concurrent": 1})
    # The native recovery probe performs inference even when healthy. Leave time
    # for the idle worker to sleep instead of continuously waking it for probes.
    memory["embedding"]["fallback"]["probe_interval_seconds"] = 600
    if enable_memory:
        memory["plugin"]["enabled"] = True

    # Validate privately; exception output below contains field locations, never input values.
    os.environ["MAIBOT_INSTANCE_DIR"] = str(instance.resolve())
    os.chdir(instance)
    from src.config.config import Config, ModelConfig, _normalize_loaded_bot_config_dict
    from src.config.config_base import AttributeData
    from pydantic import ValidationError
    try:
        bot_data, model_data = bot.unwrap(), models.unwrap()
        bot_data.pop("inner", None)
        model_data.pop("inner", None)
        Config.from_dict(AttributeData(), _normalize_loaded_bot_config_dict(bot_data))
        ModelConfig.from_dict(AttributeData(), model_data)
    except ValidationError as exc:
        fields = [".".join(map(str, item["loc"])) for item in exc.errors(include_input=False)]
        raise SystemExit("Invalid configuration fields: " + ", ".join(fields)) from None
    except TypeError:
        raise SystemExit("Native configuration validation failed; originals were preserved.") from None

    backup = instance.parent / "native-backups" / ("embedding-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    backup.mkdir(parents=True, mode=0o700)
    for path, document in zip(paths, (bot, models)):
        shutil.copy2(path, backup / path.name)
        os.chmod(backup / path.name, 0o600)
        temporary = path.with_suffix(".embedding.tmp")
        temporary.touch(mode=0o600)
        temporary.write_text(tomlkit.dumps(document), encoding="utf-8")
        temporary.replace(path)
    print(json.dumps({"embedding_model": selected["name"], "dimension": selected["dimension"],
                      "memory_enabled": bool(memory["plugin"]["enabled"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instance", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--profile", choices=("small", "large"), default="small")
    parser.add_argument("--enable-memory", action="store_true")
    args = parser.parse_args()
    configure(args.instance, args.settings, args.profile, args.enable_memory)
