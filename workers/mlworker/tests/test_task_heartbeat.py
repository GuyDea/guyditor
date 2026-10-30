from __future__ import annotations

import time
from typing import Any

import pytest

from mlworker import server


class RecordingEvents:
    def __init__(self) -> None:
        self.items: list[tuple[str, Any]] = []
        self.times: list[float] = []

    def put(self, item: tuple[str, Any]) -> None:
        self.items.append(item)
        self.times.append(time.monotonic())


@pytest.fixture(autouse=True)
def in_process_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    # _task_entry normally runs in a spawned child and points its stdout at
    # stderr; keep pytest's own descriptors untouched when calling it here.
    monkeypatch.setattr(server.os, "dup2", lambda *_: None)


def test_silent_task_keeps_reporting_liveness_with_its_last_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A first transcription downloads a 3 GB model without reporting progress;
    # the supervisor kills a worker that stays silent for 120 seconds.
    def slow_task(params: dict[str, Any], progress: Any) -> dict[str, Any]:
        time.sleep(0.25)
        progress(0.5, "decode")
        time.sleep(0.25)
        return {"ok": True}

    monkeypatch.setitem(server.TASKS, "slow", slow_task)
    monkeypatch.setattr(server, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    events = RecordingEvents()

    server._task_entry("slow", {"taskId": "job_slowslow22"}, events)

    kinds = [kind for kind, _ in events.items]
    assert kinds[-1] == "result"
    progress = [payload for kind, payload in events.items if kind == "progress"]
    before = [item for item in progress if item["stage"] == "starting"]
    after = [item for item in progress if item["stage"] == "decode"]
    assert len(before) >= 2
    assert all(item == {"taskId": "job_slowslow22", "progress": 0.0, "stage": "starting"} for item in before)
    assert len(after) >= 2
    assert all(item["progress"] == 0.5 for item in after)


def test_heartbeat_stops_when_the_task_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_task(params: dict[str, Any], progress: Any) -> dict[str, Any]:
        time.sleep(0.12)
        raise RuntimeError("model download failed")

    monkeypatch.setitem(server.TASKS, "failing", failing_task)
    monkeypatch.setattr(server, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    events = RecordingEvents()

    server._task_entry("failing", {"taskId": "job_failfail22"}, events)
    count = len(events.items)
    time.sleep(0.2)

    assert events.items[-1] == (
        "error",
        {"code": -32001, "message": "model download failed"},
    )
    assert len(events.items) == count


def test_heartbeat_stops_once_a_task_stalls_so_a_hung_task_is_still_restarted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def hung_task(params: dict[str, Any], progress: Any) -> dict[str, Any]:
        time.sleep(1.5)
        return {"ok": True}

    monkeypatch.setitem(server.TASKS, "hung", hung_task)
    monkeypatch.setattr(server, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(server, "HEARTBEAT_STALL_LIMIT_SECONDS", 0.15)
    events = RecordingEvents()
    started = time.monotonic()

    server._task_entry("hung", {"taskId": "job_hunghung22"}, events)

    beats = [
        at - started
        for (kind, _), at in zip(events.items, events.times)
        if kind == "progress"
    ]
    assert len(beats) >= 2
    # Beats stop near 0.2 s; the task stays silent until 1.5 s.
    assert max(beats) < 1.0
    assert events.items[-1] == ("result", {"ok": True})
