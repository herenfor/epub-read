"""Private checkpoints and compaction source segments; metadata-only status."""
from pathlib import Path
import asyncio
import json
import os
import threading
import uuid
from urllib.parse import quote


_locks = {}


class Store:
    def __init__(self, root, session_id):
        self.root = Path(root) / quote(session_id, safe="")
        self.lock = _locks.setdefault(str(self.root), threading.RLock())
        with self.lock:
            self.generation = self._generation()

    def _generation(self):
        path = self.root / "generation"
        return path.read_text() if path.exists() else ""

    def write(self, name, value):
        with self.lock:
            if self.generation != self._generation():
                raise RuntimeError("Context was cleared; stale checkpoint writer revoked")
            self.root.mkdir(parents=True, exist_ok=True)
            self.root.chmod(0o700)
            target = self.root / name
            temp = target.with_suffix(".tmp")
            temp.write_text(json.dumps(value, ensure_ascii=False))
            temp.chmod(0o600)
            os.replace(temp, target)

    def read(self):
        with self.lock:
            path = self.root / "checkpoint.json"
            if not path.exists() or self.generation != self._generation():
                return None
            value = json.loads(path.read_text())
            if value.get("schema") != 1:
                raise ValueError("Unknown checkpoint schema; original file preserved")
            return value

    def clear(self):
        # Source archives remain private audit data; /clear must never restore them.
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            self.generation = uuid.uuid4().hex
            marker = self.root / "generation"
            marker.write_text(self.generation)
            marker.chmod(0o600)
            (self.root / "checkpoint.json").unlink(missing_ok=True)
            self.write("status.json", {"state": "cleared"})

    def purge(self):
        with self.lock:
            self.clear()
            for path in self.root.iterdir():
                if path.name != "generation":
                    path.unlink()


async def commit_io(operation):
    # Cancellation must finish the current atomic write before clear/stop returns.
    task = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise
