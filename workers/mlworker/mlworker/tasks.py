from __future__ import annotations

from importlib import metadata
import math
import os
from pathlib import Path
from typing import Any, Callable

from .alignment import align
from .tracking import track


ProgressCallback = Callable[[float, str], None]
ANALYSIS_RATE = 16_000


def _sample_time(seconds: float) -> dict[str, int]:
    return {"samples": max(0, round(seconds * ANALYSIS_RATE)), "rate": ANALYSIS_RATE}


def _required_string(params: dict[str, Any], name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def transcribe(params: dict[str, Any], progress: ProgressCallback) -> dict[str, Any]:
    audio_path = Path(_required_string(params, "audioPath"))
    if not audio_path.is_file():
        raise ValueError(f"audioPath does not exist: {audio_path}")
    model_name = params.get("model", "tiny")
    if not isinstance(model_name, str) or not model_name:
        raise ValueError("model must be a non-empty string")
    cache_dir = Path(
        os.environ.get(
            "GUYDITOR_ML_MODEL_DIR",
            str(Path.home() / ".cache" / "guyditor-mlworker"),
        )
    ).expanduser()
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(cache_dir / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(cache_dir / "huggingface" / "hub"))
    os.environ.setdefault("HF_XET_CACHE", str(cache_dir / "huggingface" / "xet"))
    os.environ.setdefault("XDG_CACHE_HOME", str(cache_dir / "xdg"))
    from faster_whisper import WhisperModel

    compute_type = params.get("computeType", "int8")
    if not isinstance(compute_type, str):
        raise ValueError("computeType must be a string")

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=compute_type,
        download_root=str(cache_dir),
    )
    language_value = params.get("language")
    language = None if language_value in (None, "auto") else language_value
    if language is not None and not isinstance(language, str):
        raise ValueError("language must be null, 'auto', or a language code")
    word_timestamps = params.get("wordTimestamps", True)
    if not isinstance(word_timestamps, bool):
        raise ValueError("wordTimestamps must be a boolean")

    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=word_timestamps,
        vad_filter=bool(params.get("vadFilter", False)),
        beam_size=int(params.get("beamSize", 5)),
        temperature=float(params.get("temperature", 0.0)),
        condition_on_previous_text=bool(
            params.get("conditionOnPreviousText", False)
        ),
        initial_prompt=params.get("initialPrompt"),
    )
    duration_seconds = max(0.0, float(info.duration))
    segments: list[dict[str, Any]] = []
    for index, segment in enumerate(segments_iter):
        words = []
        for word in segment.words or []:
            if word.start is None or word.end is None:
                continue
            words.append(
                {
                    "text": word.word,
                    "start": _sample_time(float(word.start)),
                    "end": _sample_time(float(word.end)),
                    "probability": float(word.probability or 0.0),
                }
            )
        segments.append(
            {
                "index": index,
                "start": _sample_time(float(segment.start)),
                "end": _sample_time(float(segment.end)),
                "text": segment.text,
                "avgLogprob": float(segment.avg_logprob),
                "noSpeechProb": float(segment.no_speech_prob),
                "words": words,
            }
        )
        decoded = float(segment.end)
        denominator = duration_seconds if duration_seconds > 0 else decoded
        progress(min(0.99, decoded / denominator if denominator > 0 else 0.0), "decode")

    progress(1.0, "decode")
    return {
        "language": str(info.language),
        "languageProbability": float(info.language_probability),
        "duration": _sample_time(duration_seconds),
        "segments": segments,
        "engine": {
            "name": "faster-whisper",
            "version": metadata.version("faster-whisper"),
            "model": model_name,
        },
    }


def _energy_speech(audio: Any) -> list[dict[str, int]]:
    import numpy as np

    frame_samples = round(0.02 * ANALYSIS_RATE)
    if len(audio) == 0:
        return []
    energies = np.array(
        [
            math.sqrt(float(np.mean(np.square(audio[start : start + frame_samples]))))
            for start in range(0, len(audio), frame_samples)
        ]
    )
    peak = float(np.max(energies)) if len(energies) else 0.0
    if peak <= 1e-6:
        return []
    active = energies >= max(1e-4, peak * 0.08)

    maximum_gap = round(0.08 / 0.02)
    index = 0
    while index < len(active):
        if active[index]:
            index += 1
            continue
        start = index
        while index < len(active) and not active[index]:
            index += 1
        if start > 0 and index < len(active) and index - start <= maximum_gap:
            active[start:index] = True

    intervals: list[dict[str, int]] = []
    index = 0
    while index < len(active):
        if not active[index]:
            index += 1
            continue
        start_frame = index
        while index < len(active) and active[index]:
            index += 1
        if index - start_frame >= 5:
            intervals.append(
                {
                    "start": start_frame * frame_samples,
                    "end": min(len(audio), index * frame_samples),
                }
            )
    return intervals


def _has_internal_energy_silence(
    speech: list[dict[str, int]],
) -> bool:
    return any(
        right["start"] - left["end"] >= round(0.15 * ANALYSIS_RATE)
        for left, right in zip(speech, speech[1:])
    )


def _complement(
    speech: list[dict[str, int]], duration_samples: int
) -> list[dict[str, int]]:
    silence: list[dict[str, int]] = []
    cursor = 0
    for interval in speech:
        if interval["start"] > cursor:
            silence.append({"start": cursor, "end": interval["start"]})
        cursor = max(cursor, interval["end"])
    if cursor < duration_samples:
        silence.append({"start": cursor, "end": duration_samples})
    return silence


def vad(params: dict[str, Any], progress: ProgressCallback) -> dict[str, Any]:
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio_path = Path(_required_string(params, "audioPath"))
    if not audio_path.is_file():
        raise ValueError(f"audioPath does not exist: {audio_path}")
    audio = decode_audio(str(audio_path), sampling_rate=ANALYSIS_RATE)
    energy_speech = _energy_speech(audio)
    silero_speech = get_speech_timestamps(
        audio,
        VadOptions(
            min_silence_duration_ms=100,
            min_speech_duration_ms=100,
            speech_pad_ms=0,
        ),
        sampling_rate=ANALYSIS_RATE,
    )
    if not silero_speech or _has_internal_energy_silence(energy_speech):
        speech_samples = energy_speech
    else:
        speech_samples = [
            {"start": int(interval["start"]), "end": int(interval["end"])}
            for interval in silero_speech
        ]
    silence_samples = _complement(speech_samples, len(audio))
    progress(1.0, "vad")

    def seconds(interval: dict[str, int]) -> dict[str, float]:
        return {
            "start": interval["start"] / ANALYSIS_RATE,
            "end": interval["end"] / ANALYSIS_RATE,
        }

    return {
        "duration": len(audio) / ANALYSIS_RATE,
        "speech": [seconds(interval) for interval in speech_samples],
        "silence": [seconds(interval) for interval in silence_samples],
        "engine": {
            "name": "faster-whisper-silero-vad+energy-boundaries",
            "version": metadata.version("faster-whisper"),
        },
    }


TASKS: dict[str, Callable[[dict[str, Any], ProgressCallback], dict[str, Any]]] = {
    "align": align,
    "transcribe": transcribe,
    "track": track,
    "vad": vad,
}
