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
REPOSITORY_ROOT = WORKER_ROOT.parents[1]
DISC_FIXTURE = REPOSITORY_ROOT / ".fixtures" / "disc-track-720p30-8s.mp4"
FIXTURE_MANIFEST = REPOSITORY_ROOT / ".fixtures" / "manifest.json"


class WorkerProcess:
    def __init__(self, extra_env: dict[str, str] | None = None) -> None:
        env = os.environ.copy()
        env.update(extra_env or {})
        env["PYTHONNOUSERSITE"] = "1"
        env.setdefault(
            "GUYDITOR_ML_MODEL_DIR",
            str(WORKER_ROOT / ".uv-cache" / "models"),
        )
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
        "align",
        "track",
        "transcribe",
        "vad",
    }
    for capability in capabilities:
        assert isinstance(capability["engine"], str)
        assert isinstance(capability["engineVersion"], str)
    align_capability = next(
        capability for capability in capabilities if capability["task"] == "align"
    )
    assert align_capability == {
        "task": "align",
        "engine": "torchaudio-wav2vec2-ctc-forced-align",
        "engineVersion": pytest.importorskip("torchaudio").__version__,
        "models": ["wav2vec2-base-960h"],
    }


def test_disable_env_omits_capabilities_without_preventing_startup() -> None:
    worker = WorkerProcess({"GUYDITOR_ML_DISABLE": "align,track,transcribe,vad"})
    try:
        hello = worker.read()
        params = hello["params"]
        assert isinstance(params, dict)
        assert params["capabilities"] == []

        worker.send({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}})
        assert worker.response(1)["result"] == {"pong": True}
    finally:
        worker.close()


def test_track_reports_schema_progress_and_disc_path_accuracy() -> None:
    if not DISC_FIXTURE.is_file() or not FIXTURE_MANIFEST.is_file():
        pytest.skip("run pnpm fixtures first")
    manifest = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf8"))
    truth = manifest["files"][DISC_FIXTURE.name]["groundTruth"]["centerPath"]
    worker = WorkerProcess()
    try:
        worker.read()
        worker.send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "track",
                "params": {
                    "taskId": "job_trackcase2",
                    "videoPath": str(DISC_FIXTURE),
                    "sampleEvery": 1,
                },
            }
        )
        progress: list[float] = []
        response: dict[str, object] | None = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            message = worker.read(max(0.01, deadline - time.monotonic()))
            if message.get("method") == "$/progress":
                params = message["params"]
                assert isinstance(params, dict)
                progress.append(float(params["progress"]))
            if message.get("id") == 1:
                response = message
                break
        assert response is not None
        assert "error" not in response, worker.stderr
        assert progress and progress[-1] == 1
        result = response["result"]
        assert isinstance(result, dict)
        assert result["frameCount"] == len(truth)
        assert result["width"] == 1280
        assert result["height"] == 720
        assert result["sampleEvery"] == 1
        assert result["engine"]["name"] == "mediapipe"
        samples = result["samples"]
        assert isinstance(samples, list)
        by_frame = {sample["frame"]: sample for sample in samples}
        accurate = 0
        measured = 0
        track_ids: set[str] = set()
        for expected in truth:
            boxes = by_frame.get(expected["frame"], {}).get("boxes", [])
            objects = [box for box in boxes if box["kind"] == "object"]
            if not objects:
                continue
            measured += 1
            box = max(objects, key=lambda candidate: candidate["conf"])
            track_ids.add(box["trackId"])
            center_x = (box["x"] + box["w"] / 2) * result["width"]
            if abs(center_x - expected["x"]) <= result["width"] * 0.10:
                accurate += 1
            assert all(0 <= box[key] <= 1 for key in ("x", "y", "w", "h", "conf"))
        assert measured >= len(truth) * 0.90
        assert accurate >= len(truth) * 0.90
        assert len(track_ids) == 1
    finally:
        worker.close()


def test_track_disable_flag_is_honest_and_worker_stays_available() -> None:
    worker = WorkerProcess({"GUYDITOR_ML_DISABLE": "track"})
    try:
        hello = worker.read()
        params = hello["params"]
        assert isinstance(params, dict)
        capabilities = params["capabilities"]
        assert isinstance(capabilities, list)
        assert "track" not in {capability["task"] for capability in capabilities}
        worker.send({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}})
        assert worker.response(1)["result"] == {"pong": True}
    finally:
        worker.close()


def test_cancel_track_acknowledges_and_worker_remains_available() -> None:
    if not DISC_FIXTURE.is_file():
        pytest.skip("run pnpm fixtures first")
    worker = WorkerProcess()
    try:
        worker.read()
        worker.send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "track",
                "params": {
                    "taskId": "job_trackcancl",
                    "videoPath": str(DISC_FIXTURE),
                    "sampleEvery": 1,
                },
            }
        )
        worker.send(
            {
                "jsonrpc": "2.0",
                "method": "$/cancel",
                "params": {"taskId": "job_trackcancl"},
            }
        )

        cancelled = worker.response(1, timeout=2)
        assert cancelled["error"]["code"] == -32800
        worker.send({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}})
        assert worker.response(2, timeout=2)["result"] == {"pong": True}
    finally:
        worker.close()


@pytest.mark.slow
def test_align_reports_progress_and_monotonic_word_schema(
    worker: WorkerProcess,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "align-tone.wav"
    write_tone_wav(audio_path)
    worker.read()
    worker.send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "align",
            "params": {
                "taskId": "job_align22222",
                "audioPath": str(audio_path),
                "language": "en",
                "model": "wav2vec2-base-960h",
                "segments": [
                    {
                        "index": 7,
                        "start": {"samples": 0, "rate": 16_000},
                        "end": {"samples": 32_000, "rate": 16_000},
                        "tokens": ["fake", "three", "words"],
                    }
                ],
            },
        }
    )

    progress: list[float] = []
    response: dict[str, object] | None = None
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        message = worker.read(max(0.01, deadline - time.monotonic()))
        if message.get("method") == "$/progress":
            params = message["params"]
            assert isinstance(params, dict)
            progress.append(float(params["progress"]))
        if message.get("id") == 1:
            response = message
            break
    assert response is not None
    assert "error" not in response, worker.stderr
    assert progress
    assert progress[-1] == 1
    result = response["result"]
    assert isinstance(result, dict)
    assert result["engine"] == {
        "name": "torchaudio-wav2vec2-ctc-forced-align",
        "version": pytest.importorskip("torchaudio").__version__,
        "model": "wav2vec2-base-960h",
    }
    tokens = result["tokens"]
    assert isinstance(tokens, list)
    assert len(tokens) == 3
    previous_end = 0
    for token_index, token in enumerate(tokens):
        assert token["segmentIndex"] == 7
        assert token["tokenIndex"] == token_index
        assert token["start"]["rate"] == 16_000
        assert token["end"]["rate"] == 16_000
        assert previous_end <= token["start"]["samples"]
        assert token["start"]["samples"] < token["end"]["samples"] <= 32_000
        assert 0 <= token["score"] <= 1
        assert isinstance(token["aligned"], bool)
        previous_end = token["end"]["samples"]


def test_cancel_align_acknowledges_and_worker_remains_available(
    worker: WorkerProcess,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "cancel-align.wav"
    write_tone_wav(audio_path, duration=4.0)
    worker.read()
    worker.send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "align",
            "params": {
                "taskId": "job_algncancel",
                "audioPath": str(audio_path),
                "language": "en",
                "model": "wav2vec2-base-960h",
                "segments": [
                    {
                        "index": 0,
                        "start": {"samples": 0, "rate": 16_000},
                        "end": {"samples": 64_000, "rate": 16_000},
                        "tokens": ["cancel", "this", "alignment"],
                    }
                ],
            },
        }
    )
    started = time.monotonic()
    worker.send(
        {
            "jsonrpc": "2.0",
            "method": "$/cancel",
            "params": {"taskId": "job_algncancel"},
        }
    )

    cancelled = worker.response(1, timeout=2)
    assert time.monotonic() - started <= 2
    assert cancelled["error"]["code"] == -32800
    worker.send({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}})
    assert worker.response(2, timeout=2)["result"] == {"pong": True}


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
