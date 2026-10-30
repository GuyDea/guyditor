from __future__ import annotations

import json
import multiprocessing
from multiprocessing.process import BaseProcess
import os
from queue import Empty
import sys
from threading import Event, Lock, Thread
from typing import Any, TextIO

from .capabilities import advertised_capabilities, disabled_tasks, hello_params
from .tasks import TASKS


JsonObject = dict[str, Any]

# The supervisor restarts a worker that stays silent for 120 seconds during a
# task. Model loads (a first transcription downloads about 3 GB) and long
# decode windows report nothing for minutes, so the task process repeats its
# last progress well inside that window for as long as the task runs.
HEARTBEAT_INTERVAL_SECONDS = 15.0

# The supervisor SIGKILLs an unresponsive worker, which skips multiprocessing's
# cleanup of daemonic children. A task child polls for its parent and exits
# once it is gone instead of running on (holding gigabytes of model memory)
# with nobody left to receive its result.
PARENT_POLL_SECONDS = 1.0


def _exit_with_parent(stop: Event, interval: float | None = None) -> None:
    parent = os.getppid()
    period = PARENT_POLL_SECONDS if interval is None else interval

    def watch() -> None:
        while not stop.wait(period):
            if os.getppid() != parent:
                os._exit(1)

    Thread(target=watch, daemon=True).start()


def _task_entry(
    method: str,
    params: JsonObject,
    events: Any,
) -> None:
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    try:
        task_id = str(params["taskId"])
        last: dict[str, Any] = {"progress": 0.0, "stage": "starting"}
        lock = Lock()

        def emit() -> None:
            with lock:
                events.put(("progress", {"taskId": task_id, **last}))

        def progress(value: float, stage: str) -> None:
            with lock:
                last["progress"] = value
                last["stage"] = stage
            emit()

        stop = Event()
        _exit_with_parent(stop)

        def heartbeat() -> None:
            while not stop.wait(HEARTBEAT_INTERVAL_SECONDS):
                emit()

        beat = Thread(target=heartbeat, daemon=True)
        beat.start()
        try:
            result = TASKS[method](params, progress)
        finally:
            stop.set()
            beat.join()
        events.put(("result", result))
    except BaseException as error:
        events.put(("error", {"code": -32001, "message": str(error)}))


class ActiveTask:
    def __init__(
        self,
        request_id: Any,
        task_id: str,
        process: BaseProcess,
        events: Any,
    ) -> None:
        self.request_id = request_id
        self.task_id = task_id
        self.process = process
        self.events = events


class WorkerServer:
    def __init__(self, stdin: TextIO, stdout: TextIO) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._write_lock = Lock()
        self._active_lock = Lock()
        self._active: ActiveTask | None = None
        self._context = multiprocessing.get_context("spawn")

    def _write(self, message: JsonObject) -> None:
        with self._write_lock:
            self._stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
            self._stdout.flush()

    def _response(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _error(self, request_id: Any, code: int, message: str) -> None:
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            }
        )

    def _notification(self, method: str, params: JsonObject) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _monitor(self, active: ActiveTask) -> None:
        while True:
            try:
                kind, payload = active.events.get(timeout=0.1)
            except Empty:
                if active.process.is_alive():
                    continue
                with self._active_lock:
                    if self._active is active:
                        self._active = None
                        self._error(
                            active.request_id,
                            -32002,
                            f"{active.task_id} stopped without a result",
                        )
                return

            with self._active_lock:
                if self._active is not active:
                    return
                if kind == "progress":
                    self._notification("$/progress", payload)
                    continue
                self._active = None
            active.process.join(timeout=1)
            if kind == "result":
                self._response(active.request_id, payload)
            else:
                self._write(
                    {"jsonrpc": "2.0", "id": active.request_id, "error": payload}
                )
            return

    def _start_task(self, request_id: Any, method: str, params: Any) -> None:
        if not isinstance(params, dict):
            self._error(request_id, -32602, "params must be an object")
            return
        task_id = params.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            self._error(request_id, -32602, "params.taskId must be a non-empty string")
            return
        supported = {capability["task"] for capability in advertised_capabilities()}
        if method not in supported or method in disabled_tasks():
            self._error(request_id, -32601, f"capability is unavailable: {method}")
            return
        with self._active_lock:
            if self._active is not None:
                self._error(request_id, -32000, "the worker already has a task in flight")
                return
            events = self._context.Queue()
            process = self._context.Process(
                target=_task_entry,
                args=(method, params, events),
                daemon=True,
            )
            active = ActiveTask(request_id, task_id, process, events)
            self._active = active
            process.start()
        Thread(target=self._monitor, args=(active,), daemon=True).start()

    def _cancel(self, params: Any) -> None:
        if not isinstance(params, dict) or not isinstance(params.get("taskId"), str):
            return
        task_id = params["taskId"]
        with self._active_lock:
            active = self._active
            if active is None or active.task_id != task_id:
                return
            self._active = None
        self._error(active.request_id, -32800, f"request cancelled: {task_id}")
        if active.process.is_alive():
            active.process.terminate()
            active.process.join(timeout=1)
        if active.process.is_alive():
            active.process.kill()
            active.process.join(timeout=1)

    def _handle(self, message: Any) -> None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self._error(message.get("id") if isinstance(message, dict) else None, -32600, "invalid request")
            return
        method = message.get("method")
        request_id = message.get("id")
        if method == "$/cancel":
            self._cancel(message.get("params"))
            return
        if request_id is None:
            return
        if method == "ping":
            self._response(request_id, {"pong": True})
            return
        if method in TASKS:
            self._start_task(request_id, method, message.get("params"))
            return
        self._error(request_id, -32601, f"method not found: {method}")

    def run(self) -> None:
        self._notification("mlworker.hello", hello_params())
        for line in self._stdin:
            try:
                self._handle(json.loads(line))
            except json.JSONDecodeError:
                self._error(None, -32700, "parse error")
        with self._active_lock:
            active = self._active
            self._active = None
        if active is not None and active.process.is_alive():
            active.process.terminate()
            active.process.join(timeout=1)


def run_stdio() -> None:
    WorkerServer(sys.stdin, sys.stdout).run()
