"""One local entry point for an existing MaiBot and Windows NapCat installation."""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import http.cookiejar
import json
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    instance_dir: str
    service_script: str
    powershell: str
    windows_helper: str
    windows_qq_dir: str
    browser_handler: str
    embedding_config: str
    adapter_plugin_id: str
    ui_url: str = "http://127.0.0.1:8001"
    qq_login_url: str = "http://127.0.0.1:6099/webui/"


def windows_qq(settings: Settings, *, start: bool) -> dict:
    args = [settings.powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
            "Bypass", "-File", settings.windows_helper, "-InstallRoot", settings.windows_qq_dir]
    if not start:
        args.append("-CheckOnly")
    result = subprocess.run(args, cwd=Path(settings.browser_handler).parent,
                            capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError("QQ 后台启动入口未成功，请检查安装目录和启动脚本。")
    return json.loads(result.stdout.lstrip("\ufeff"))


def service(settings: Settings, command: str) -> None:
    result = subprocess.run([sys.executable, settings.service_script, command],
                            cwd=Path(settings.service_script).parent, timeout=40)
    if result.returncode:
        raise RuntimeError("MaiBot 启动失败，请检查本机服务日志。")


def local_client():
    # These services are local even when the shell has a network proxy enabled.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                      urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def host_info(settings: Settings, *, wait: float) -> dict:
    client = local_client()
    token_file = Path(settings.instance_dir) / "data/webui.json"
    deadline = time.monotonic() + wait
    while True:
        try:
            token = json.loads(token_file.read_text())["access_token"]

            def request(path, payload=None):
                data = json.dumps(payload).encode() if payload is not None else None
                req = urllib.request.Request(settings.ui_url + path, data=data,
                                             headers={"Content-Type": "application/json"})
                with client.open(req, timeout=2) as response:
                    return json.load(response)

            request("/api/webui/auth/verify", {"token": token})
            plugins = request("/api/webui/plugins/installed")
            adapter_loaded = False

            def find_adapter(value):
                nonlocal adapter_loaded
                if isinstance(value, dict):
                    if value.get("id", value.get("plugin_id")) == settings.adapter_plugin_id:
                        adapter_loaded |= value.get("loaded") is True
                    for child in value.values():
                        if isinstance(child, (dict, list)):
                            find_adapter(child)
                elif isinstance(value, list):
                    for child in value:
                        find_adapter(child)

            find_adapter(plugins)
            agent = request("/api/webui/agent")
            if isinstance(agent.get("agent"), dict):
                agent = agent["agent"]
            if not adapter_loaded and time.monotonic() < deadline:
                time.sleep(0.5)
                continue
            # Native `connected` describes the optional desktop bridge, not ACP.
            return {"ready": True, "adapter_loaded": adapter_loaded,
                    "agent_enabled": agent.get("enabled") is True,
                    "agent_paused": agent.get("paused") is True,
                    "agent_error": bool(agent.get("error")),
                    "agent_started": agent.get("agent_state") not in (None, "stopped")}
        except (OSError, ValueError, KeyError, urllib.error.URLError):
            if time.monotonic() >= deadline:
                return {"ready": False, "adapter_loaded": False}
            time.sleep(0.5)


def embedding_ready(settings: Settings) -> bool:
    try:
        config = json.loads(Path(settings.embedding_config).read_text())
        token = Path(config["api_key_file"]).read_text().strip()
        request = urllib.request.Request(config["endpoint"].rstrip("/") + "/models",
                                         headers={"Authorization": "Bearer " + token})
        with local_client().open(request, timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        return False


async def qq_login_state(settings: Settings) -> str:
    """Use a read-only OneBot action; never fetch or send chat messages."""
    from websockets.asyncio.client import connect

    try:
        config = tomllib.loads((Path(settings.instance_dir) /
                               "plugins/MaiBot-SnowLuma-Adapter/config.toml").read_text())["client"]
        host = config["server"]
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        token = config.get("token", "")
        headers = {"Authorization": "Bearer " + token} if token else None
        async with connect(f"ws://{host}:{int(config['port'])}", additional_headers=headers,
                           open_timeout=2, close_timeout=1, max_size=1024 * 1024,
                           proxy=None) as connection:
            echo = "maibot-launcher-status"
            await connection.send(json.dumps({"action": "get_status", "params": {}, "echo": echo}))
            async with asyncio.timeout(3):
                async for raw in connection:
                    result = json.loads(raw)
                    if result.get("echo") == echo:
                        if result.get("status") != "ok":
                            return "unavailable"
                        return "online" if result.get("data", {}).get("online") is True else "offline"
    except (OSError, ValueError, KeyError, TimeoutError):
        return "unavailable"
    except Exception:
        # WebSocket authentication and protocol failures contain private transport
        # details. Report the state without printing credentials or event frames.
        return "unavailable"
    return "unavailable"


def open_browser(settings: Settings, url: str) -> None:
    try:
        subprocess.Popen([settings.browser_handler, "url.dll,FileProtocolHandler", url],
                         cwd=Path(settings.browser_handler).parent,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        print(f"请在浏览器打开：{url}")


def report(settings: Settings, host: dict, qq: str, embedding: bool) -> bool:
    print("MaiBot：" + ("已就绪" if host["ready"] else "尚未就绪"))
    print("本地向量服务：" + ("已就绪" if embedding else "尚未就绪"))
    if qq == "online" and host.get("adapter_loaded"):
        print("QQ：已登录，适配器已加载")
    elif qq == "online":
        print("QQ：已登录，MaiBot 适配器尚未加载，请检查插件开关")
    else:
        print("QQ：连接尚未就绪，请检查登录状态；需要时在登录页扫码")
        print(settings.qq_login_url)
    agent_ready = True
    if host.get("agent_enabled"):
        agent_ready = bool(host.get("agent_started") and not host.get("agent_paused")
                           and not host.get("agent_error"))
        print("DSH 工具：" + ("已启用，由 MaiBot 按需连接" if agent_ready else "尚未就绪，请检查 Agent 状态"))
    print(f"管理页：{settings.ui_url}")
    return bool(host["ready"] and host.get("adapter_loaded") and embedding
                and qq == "online" and agent_ready)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("command", choices=("start", "status", "restart", "stop"), default="start", nargs="?")
    parser.add_argument("--no-open", action="store_true", help="Do not open browser pages")
    args = parser.parse_args()
    settings = Settings(**json.loads(args.settings.read_text()))
    try:
        if args.command == "stop":
            service(settings, "stop")
            print("QQ/NapCat 保留运行；此命令不退出其他 QQ。")
            return 0
        if args.command == "status":
            return 0 if report(settings, host_info(settings, wait=0),
                               asyncio.run(qq_login_state(settings)), embedding_ready(settings)) else 2
        with (Path(settings.instance_dir) / "launcher.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("已有启动操作正在进行，请稍后运行 maibot status。")
                return 2
            print("检查 QQ/NapCat 后台进程……", flush=True)
            windows_qq(settings, start=True)
            if args.command == "restart":
                service(settings, "stop")
            print("检查 MaiBot 和本地向量服务……", flush=True)
            service(settings, "start")
            host = host_info(settings, wait=20)
            qq = asyncio.run(qq_login_state(settings))
            ready = report(settings, host, qq, embedding_ready(settings))
            if not args.no_open:
                open_browser(settings, settings.ui_url)
                if qq != "online":
                    open_browser(settings, settings.qq_login_url)
            return 0 if ready else 2
    except (OSError, ValueError, subprocess.TimeoutExpired, RuntimeError) as error:
        print(f"启动未完成：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
