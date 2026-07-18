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


def advertised_capabilities() -> list[dict[str, Any]]:
    disabled = disabled_tasks()
    if util.find_spec("faster_whisper") is None:
        return []

    version = _package_version("faster-whisper")
    capabilities: list[dict[str, Any]] = []
    if "transcribe" not in disabled:
        capabilities.append(
            {
                "task": "transcribe",
                "engine": "faster-whisper",
                "engineVersion": version,
                "models": ["tiny", "base", "small", "medium", "large-v3"],
            }
        )
    if "vad" not in disabled:
        capabilities.append(
            {
                "task": "vad",
                "engine": "faster-whisper-silero-vad+energy-boundaries",
                "engineVersion": version,
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

