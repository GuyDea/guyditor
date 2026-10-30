from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import time


TESTS_DIR = Path(__file__).resolve().parent
WORKER_ROOT = TESTS_DIR.parent

PARENT = """
import multiprocessing, sys, time
sys.path.insert(0, sys.argv[1])
import orphan_helper
if __name__ == "__main__":
    child = multiprocessing.get_context("spawn").Process(
        target=orphan_helper.run, args=(sys.argv[2],), daemon=True,
    )
    child.start()
    print(child.pid, flush=True)
    time.sleep(60)
"""


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    try:
        status = Path(f"/proc/{pid}/status").read_text()
    except FileNotFoundError:
        return True
    return "\nState:\tZ" in status


def test_task_child_exits_when_the_worker_is_killed(tmp_path: Path) -> None:
    # The supervisor SIGKILLs an unresponsive worker; the task child it spawned
    # used to keep running (and holding gigabytes of model memory) as an orphan.
    ready = tmp_path / "ready"
    parent = subprocess.Popen(
        [sys.executable, "-c", PARENT, str(TESTS_DIR), str(ready)],
        cwd=WORKER_ROOT,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert parent.stdout is not None
    child_pid = int(parent.stdout.readline())
    try:
        deadline = time.monotonic() + 15
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert ready.exists(), "task child never started its parent watch"
        assert not _gone(child_pid)
        parent.send_signal(signal.SIGKILL)
        parent.wait(timeout=5)

        deadline = time.monotonic() + 5
        while not _gone(child_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert _gone(child_pid)
    finally:
        if not _gone(child_pid):
            os.kill(child_pid, signal.SIGKILL)
