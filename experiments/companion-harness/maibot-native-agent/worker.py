#!/usr/bin/env python3
"""Launch native DSH ACP with private credentials and a dedicated worker home."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tomllib


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, required=True)
    args, forwarded = parser.parse_known_args()
    if forwarded not in ([], ["--profile", "acp"]):
        parser.error("This worker only serves the acp profile")
    cfg = json.loads(args.settings.read_text())
    connection = tomllib.loads(Path(cfg["connection_file"]).read_text())
    key = connection["model"]["api_key"]
    if not key:
        raise SystemExit("Configure the local model connection before starting ACP")
    env = {**os.environ, "DSH_HOME": cfg["dsh_home"], "MAIBOT_DSH_API_KEY": key,
           "DSH_PERMISSION_MODE": "workspace-write", "DO_NOT_TRACK": "1"}
    os.chdir(cfg["workspace"])
    # Replace this process: stdin/stdout remain the native ACP channel; no queue,
    # model loop, prompt copying, credentials in argv, or reply interception.
    os.execve(cfg["node"], [cfg["node"], cfg["dsh_entry"], "--profile", "acp"], env)


if __name__ == "__main__":
    main()
