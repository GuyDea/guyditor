from __future__ import annotations

from importlib import metadata, util
import os
from typing import Any

from . import __version__


def disabled_tasks() -> set[str]:
    aliases = {
        "matting": "matte",
        "transcription": "transcribe",
    }
    values = os.environ.get("GUYDITOR_ML_DISABLE", "").split(",")
    return {
        aliases.get(value.strip().lower(), value.strip().lower())
        for value in values
        if value.strip()
    }


def _package_version(package: str) -> str:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:
        return "unknown"


def _alignment_available() -> bool:
    if util.find_spec("torch") is None or util.find_spec("torchaudio") is None:
        return False
    try:
        from torchaudio.functional import forced_align

        return callable(forced_align)
    except (ImportError, OSError):
        return False


def advertised_capabilities() -> list[dict[str, Any]]:
    disabled = disabled_tasks()
    capabilities: list[dict[str, Any]] = []
    whisper_available = util.find_spec("faster_whisper") is not None
    version = _package_version("faster-whisper")
    if whisper_available and "transcribe" not in disabled:
        capabilities.append(
            {
                "task": "transcribe",
                "engine": "faster-whisper",
                "engineVersion": version,
                "models": ["tiny", "base", "small", "medium", "large-v3"],
            }
        )
    if (
        whisper_available
        and "align" not in disabled
        and _alignment_available()
    ):
        capabilities.append(
            {
                "task": "align",
                "engine": "torchaudio-wav2vec2-ctc-forced-align",
                "engineVersion": _package_version("torchaudio"),
                "models": ["wav2vec2-base-960h"],
            }
        )
    if whisper_available and "vad" not in disabled:
        capabilities.append(
            {
                "task": "vad",
                "engine": "faster-whisper-silero-vad+energy-boundaries",
                "engineVersion": version,
            }
        )
    if util.find_spec("mediapipe") is not None and "track" not in disabled:
        capabilities.append(
            {
                "task": "track",
                "engine": "mediapipe",
                "engineVersion": _package_version("mediapipe"),
            }
        )
    return capabilities


def hello_params() -> dict[str, Any]:
    import platform

    return {
        "protocol": 1,
        "workerVersion": __version__,
        "python": platform.python_version(),
        "device": {"type": "cpu"},
        "capabilities": advertised_capabilities(),
    }
