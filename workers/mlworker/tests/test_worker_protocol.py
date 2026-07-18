from __future__ import annotations

import json
import math
import os
from pathlib import Path
from queue import Empty, Queue
import subprocess
import sys
from threading import Thread
import time
import wave

import pytest


WORKER_ROOT = Path(__file__).resolve().parents[1]


class WorkerProcess:
    def __init__(self, extra_env: dict[str, str] | None = None) -> None:
        env = os.environ.copy()
        env.update(extra_env or {})
        env["PYTHONNOUSERSITE"] = "1"
        self.process = subprocess.Popen(
            [sys.executable, "-m", "mlworker", "--stdio"],
            cwd=WORKER_ROOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.messages: Queue[dict[str, object]] = Queue()
        self.stderr: list[str] = []
        Thread(target=self._read_stdout, daemon=True).start()
        Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.messages.put(json.loads(line))

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        self.stderr.extend(line.rstrip("\n") for line in self.process.stderr)

    def read(self, timeout: float = 10.0) -> dict[str, object]:
        try:
            return self.messages.get(timeout=timeout)
        except Empty as error:
            raise AssertionError(
                f"worker message timed out; stderr={self.stderr!r}"
            ) from error

    def send(self, message: dict[str, object]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def response(self, request_id: int, timeout: float = 10.0) -> dict[str, object]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.read(max(0.01, deadline - time.monotonic()))
            if message.get("id") == request_id:
                return message
        raise AssertionError(f"response {request_id} timed out")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)


@pytest.fixture
def worker() -> WorkerProcess:
    running = WorkerProcess()
    yield running
    running.close()


def write_tone_wav(path: Path, duration: float = 2.0) -> None:
    rate = 16_000
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = bytearray()
        for index in range(round(duration * rate)):
            seconds = index / rate
            sample = (
                round(12_000 * math.sin(2 * math.pi * 440 * seconds))
                if 0.5 <= seconds < 1.5
                else 0
            )
            frames.extend(sample.to_bytes(2, "little", signed=True))
        output.writeframes(frames)


def test_hello_advertises_importable_capabilities(worker: WorkerProcess) -> None:
    message = worker.read()

    assert message["jsonrpc"] == "2.0"
    assert message["method"] == "mlworker.hello"
    params = message["params"]
    assert isinstance(params, dict)
    assert params["protocol"] == 1
    assert isinstance(params["workerVersion"], str)
    assert tuple(map(int, str(params["python"]).split(".")[:2])) >= (3, 11)
    assert params["device"] == {"type": "cpu"}
    capabilities = params["capabilities"]
    assert isinstance(capabilities, list)
    assert {capability["task"] for capability in capabilities} == {
        "transcribe",
        "vad",
    }
    for capability in capabilities:
        assert isinstance(capability["engine"], str)
        assert isinstance(capability["engineVersion"], str)


def test_disable_env_omits_capabilities_without_preventing_startup() -> None:
    worker = WorkerProcess({"GUYDITOR_ML_DISABLE": "transcribe,vad"})
    try:
        hello = worker.read()
        params = hello["params"]
        assert isinstance(params, dict)
        assert params["capabilities"] == []

        worker.send({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}})
        assert worker.response(1)["result"] == {"pong": True}
    finally:
        worker.close()


def test_vad_reports_speech_and_silence_intervals(
    worker: WorkerProcess,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "silence-tone.wav"
    write_tone_wav(audio_path)
    worker.read()
    worker.send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "vad",
            "params": {"taskId": "job_testvad222", "audioPath": str(audio_path)},
        }
    )

    response = worker.response(1, timeout=30)
    result = response["result"]
    assert isinstance(result, dict)
    speech = result["speech"]
    silence = result["silence"]
    assert isinstance(speech, list) and speech
    assert isinstance(silence, list) and len(silence) == 2
    assert speech[0]["start"] == pytest.approx(0.5, abs=0.12)
    assert speech[-1]["end"] == pytest.approx(1.5, abs=0.12)
    assert silence[0] == pytest.approx({"start": 0.0, "end": 0.5}, abs=0.12)
    assert silence[-1] == pytest.approx({"start": 1.5, "end": 2.0}, abs=0.12)


def test_cancel_acknowledges_request_and_accepts_next_task(
    worker: WorkerProcess,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "cancel.wav"
    write_tone_wav(audio_path, duration=4.0)
    worker.read()
    worker.send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "transcribe",
            "params": {
                "taskId": "job_cancel2222",
                "audioPath": str(audio_path),
                "model": "tiny",
                "language": "auto",
                "wordTimestamps": True,
            },
        }
    )
    started = time.monotonic()
    worker.send(
        {
            "jsonrpc": "2.0",
            "method": "$/cancel",
            "params": {"taskId": "job_cancel2222"},
        }
    )

    cancelled = worker.response(1, timeout=2)
    assert time.monotonic() - started <= 2
    assert cancelled["error"]["code"] == -32800

    worker.send({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}})
    assert worker.response(2, timeout=2)["result"] == {"pong": True}
