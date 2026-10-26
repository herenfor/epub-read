"""Install this local adapter into an explicitly selected private MaiBot env."""
import argparse
from pathlib import Path
import shutil

PATCHES = {
    "src/maisaka/runtime.py": ("install_runtime", "MaisakaHeartFlowChatting"),
    "src/maisaka/reasoning_engine.py": ("install_engine", "MaisakaReasoningEngine"),
    "src/services/llm_service.py": ("install_service", "LLMServiceClient"),
    "src/chat/heart_flow/heartflow_manager.py": ("install_manager", "HeartflowManager"),
    "src/webui/routers/chat/routes.py": ("install_deletion", "globals()"),
    "src/llm_models/request_snapshot.py": ("install_diagnostics", "globals()"),
}


def install(site: Path, backup: Path):
    source = Path(__file__).parent / "epub_maibot_context"
    for relative, (hook, cls) in PATCHES.items():
        text = (site / relative).read_text()
        function = "save_failed_request_snapshot" if hook == "install_diagnostics" else "_delete_chat_session_scope"
        if (cls != "globals()" and "class " + cls not in text) or (cls == "globals()" and "def " + function + "(" not in text):
            raise RuntimeError("MaiBot native integration point changed: " + relative)
    backup.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, site / source.name, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    for relative, (hook, cls) in PATCHES.items():
        file = site / relative
        marker = "\n# EPUB local context adapter\n"
        text = file.read_text()
        saved = backup / relative
        if marker not in text:
            saved.parent.mkdir(parents=True, exist_ok=True)
            if not saved.exists():
                shutil.copy2(file, saved)
            text += marker + f"from epub_maibot_context.integration import {hook} as _epub_install_context\n_epub_install_context({cls})\n"
            file.write_text(text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-packages", required=True)
    parser.add_argument("--backup", required=True)
    args = parser.parse_args()
    install(Path(args.site_packages), Path(args.backup))
    print("Installed local context adapter at six native boundaries")
