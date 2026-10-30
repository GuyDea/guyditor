"""Spawned by test_task_orphan.py: a task child that would outlive its parent."""
from __future__ import annotations

from pathlib import Path
from threading import Event
import time

from mlworker import server


def run(ready: str) -> None:
    server._exit_with_parent(Event(), interval=0.05)
    Path(ready).write_text("ready")
    time.sleep(30)
