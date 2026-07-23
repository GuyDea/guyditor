from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
from typing import Any, Callable


ProgressCallback = Callable[[float, str], None]
MODEL_FILES = {
    "rvm_mobilenetv3": "rvm_mobilenetv3_fp32.torchscript",
    "rvm_resnet50": "rvm_resnet50_fp32.torchscript",
}


def model_directory() -> Path:
    return Path(
        os.environ.get(
            "GUYDITOR_ML_MODEL_DIR",
            str(Path.home() / ".cache" / "guyditor-mlworker"),
        )
    ).expanduser()


def available_models() -> list[str]:
    if os.environ.get("GUYDITOR_RVM_TEST_STUB") == "1":
        return list(MODEL_FILES)
    root = model_directory()
    return [name for name, filename in MODEL_FILES.items() if (root / filename).is_file()]


def engine_version() -> str:
    if os.environ.get("GUYDITOR_RVM_TEST_STUB") == "1":
        return "contract-stub-1"
    digests = []
    for model in available_models():
        path = model_directory() / MODEL_FILES[model]
        digests.append(_sha256_file(path))
    return "torchscript-" + hashlib.sha256("".join(digests).encode()).hexdigest()[:12]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _required_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _required_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _probe_dimensions(path: Path) -> tuple[int, int]:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(completed.stdout).get("streams", [])
    if not streams:
        raise ValueError(f"input has no video stream: {path}")
    return int(streams[0]["width"]), int(streams[0]["height"])


def _stub_alpha(frame: Any) -> Any:
    import numpy as np

    normalized = frame.astype(np.float32) / 255.0
    red = normalized[:, :, 0]
    green = normalized[:, :, 1]
    blue = normalized[:, :, 2]
    key_distance = np.sqrt(
        np.square(red) + np.square(1.0 - green) + np.square(blue)
    ) / math.sqrt(3.0)
    return np.clip((key_distance - 0.08) / 0.22, 0.0, 1.0)


class RvmInference:
    def __init__(self, model_name: str, downsample_ratio: float) -> None:
        self._stub = os.environ.get("GUYDITOR_RVM_TEST_STUB") == "1"
        self._model_name = model_name
        self._downsample_ratio = downsample_ratio
        self._recurrent: list[Any] = [None, None, None, None]
        self._model: Any = None
        if self._stub:
            return
        if model_name not in available_models():
            raise ValueError(f"RVM model is not installed: {model_name}")
        import torch

        model_path = model_directory() / MODEL_FILES[model_name]
        self._model = torch.jit.load(str(model_path), map_location="cpu").eval()

    def reset(self) -> None:
        self._recurrent = [None, None, None, None]

    def infer(self, frame: Any) -> Any:
        if self._stub:
            return _stub_alpha(frame)
        import numpy as np
        import torch

        source = torch.from_numpy(frame).permute(2, 0, 1).unsqueeze(0).float() / 255.0
        with torch.inference_mode():
            _foreground, alpha, *recurrent = self._model(
                source,
                *self._recurrent,
                self._downsample_ratio,
            )
        self._recurrent = recurrent
        return alpha[0, 0].detach().cpu().numpy().astype(np.float32)


def _motion_map(current: Any, previous: Any) -> Any:
    import cv2
    import numpy as np

    coefficients = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    current_luma = np.sum(current.astype(np.float32) * coefficients, axis=2) / 255.0
    previous_luma = np.sum(previous.astype(np.float32) * coefficients, axis=2) / 255.0
    difference = np.abs(current_luma - previous_luma)
    return cv2.blur(difference, (5, 5), borderType=cv2.BORDER_REPLICATE)


def _remove_speckles(alpha: Any, minimum_fraction: float) -> Any:
    import cv2
    import numpy as np

    minimum = max(1, math.ceil(alpha.shape[0] * alpha.shape[1] * minimum_fraction))
    cleaned = alpha.copy()
    foreground = (cleaned >= 0.5).astype(np.uint8)
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        foreground, connectivity=4
    )
    for label in range(1, count):
        if int(stats[label, cv2.CC_STAT_AREA]) < minimum:
            cleaned[labels == label] = 0.0

    holes = (cleaned < 0.5).astype(np.uint8)
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        holes, connectivity=4
    )
    height, width = cleaned.shape
    for label in range(1, count):
        if int(stats[label, cv2.CC_STAT_AREA]) >= minimum:
            continue
        left = int(stats[label, cv2.CC_STAT_LEFT])
        top = int(stats[label, cv2.CC_STAT_TOP])
        component_width = int(stats[label, cv2.CC_STAT_WIDTH])
        component_height = int(stats[label, cv2.CC_STAT_HEIGHT])
        touches_edge = (
            left == 0
            or top == 0
            or left + component_width == width
            or top + component_height == height
        )
        if not touches_edge:
            cleaned[labels == label] = 1.0
    return cleaned


def _validated_request(params: dict[str, Any]) -> tuple[
    Path, int, int, str, str, float, dict[str, Any], Path
]:
    source = _required_object(params.get("input"), "input")
    settings = _required_object(params.get("params"), "params")
    output = _required_object(params.get("output"), "output")
    source_path = Path(_required_string(source.get("path"), "input.path"))
    if not source_path.is_file():
        raise ValueError(f"input.path does not exist: {source_path}")
    frames = _required_object(source.get("frames"), "input.frames")
    frame_from = frames.get("from")
    frame_to = frames.get("to")
    if (
        not isinstance(frame_from, int)
        or isinstance(frame_from, bool)
        or not isinstance(frame_to, int)
        or isinstance(frame_to, bool)
        or frame_from < 0
        or frame_to < frame_from
    ):
        raise ValueError("input.frames must contain an inclusive non-negative range")
    fps = _required_string(source.get("fps"), "input.fps")
    model = _required_string(settings.get("model"), "params.model")
    if model not in MODEL_FILES:
        raise ValueError(f"unsupported RVM model: {model}")
    ratio = settings.get("downsampleRatio")
    if not isinstance(ratio, (int, float)) or isinstance(ratio, bool) or not 0.1 <= ratio <= 1:
        raise ValueError("params.downsampleRatio must be between 0.1 and 1")
    stabilization = _required_object(settings.get("stabilization"), "params.stabilization")
    if output.get("format") != "ffv1-gray-mkv":
        raise ValueError("output.format must be ffv1-gray-mkv")
    output_dir = Path(_required_string(output.get("dir"), "output.dir"))
    return source_path, frame_from, frame_to, fps, model, float(ratio), stabilization, output_dir


def matte(params: dict[str, Any], progress: ProgressCallback) -> dict[str, Any]:
    import numpy as np

    (
        source_path, frame_from, frame_to, fps, model_name, downsample_ratio,
        stabilization, output_dir,
    ) = _validated_request(params)
    enabled = stabilization.get("enabled")
    alpha_min = stabilization.get("alphaMin")
    motion_gain = stabilization.get("motionGain")
    minimum_speckle = stabilization.get("minSpeckleArea")
    if not isinstance(enabled, bool):
        raise ValueError("params.stabilization.enabled must be a boolean")
    for name, value, minimum, maximum in [
        ("alphaMin", alpha_min, 0.0, 1.0),
        ("motionGain", motion_gain, 0.0, 100.0),
        ("minSpeckleArea", minimum_speckle, 0.0, 1.0),
    ]:
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not minimum <= value <= maximum:
            raise ValueError(f"params.stabilization.{name} is outside its valid range")

    source_hash = _sha256_file(source_path)
    version = engine_version()
    identity = json.dumps(
        {
            "sourceSha256": source_hash,
            "frames": {"from": frame_from, "to": frame_to},
            "fps": fps,
            "model": model_name,
            "downsampleRatio": downsample_ratio,
            "stabilization": stabilization,
            "engineVersion": version,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    cache_key = hashlib.sha256(identity.encode()).hexdigest()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{cache_key}.mkv"
    result_path = output_dir / f"{cache_key}.json"
    if output_path.is_file() and result_path.is_file():
        cached = json.loads(result_path.read_text(encoding="utf8"))
        progress(1.0, "cached")
        return cached

    width, height = _probe_dimensions(source_path)
    frame_count = frame_to - frame_from + 1
    decoder = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-i", str(source_path),
            "-vf", f"trim=start_frame={frame_from}:end_frame={frame_to + 1},setpts=PTS-STARTPTS",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    temporary = output_dir / f".{cache_key}.{os.getpid()}.tmp.mkv"
    encoder = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-f", "rawvideo",
            "-pix_fmt", "gray", "-s", f"{width}x{height}", "-r", fps,
            "-i", "pipe:0", "-frames:v", str(frame_count), "-an", "-c:v", "ffv1",
            "-level", "3", "-pix_fmt", "gray", "-y", str(temporary),
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if decoder.stdout is None or encoder.stdin is None:
        raise RuntimeError("failed to open FFmpeg matte pipes")

    inference = RvmInference(model_name, downsample_ratio)
    source = _required_object(params["input"], "input")
    shot_boundaries_value = source.get("shotBoundaries", [])
    if not isinstance(shot_boundaries_value, list) or not all(
        isinstance(value, int) and not isinstance(value, bool)
        for value in shot_boundaries_value
    ):
        raise ValueError("input.shotBoundaries must be an integer array")
    shot_boundaries = set(shot_boundaries_value)
    previous_source = None
    previous_alpha = None
    alpha_low = 255
    alpha_high = 0
    nonzero_frames = 0
    try:
        for index in range(frame_count):
            raw = decoder.stdout.read(width * height * 3)
            if len(raw) != width * height * 3:
                raise RuntimeError(f"decoded {index} of {frame_count} requested matte frames")
            frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3)).copy()
            absolute_frame = frame_from + index
            if index == 0 or absolute_frame in shot_boundaries:
                inference.reset()
                previous_source = None
                previous_alpha = None
            raw_alpha = inference.infer(frame)
            if raw_alpha.shape != (height, width):
                import cv2

                raw_alpha = cv2.resize(raw_alpha, (width, height), interpolation=cv2.INTER_LINEAR)
            alpha = np.clip(raw_alpha, 0.0, 1.0)
            if enabled and previous_source is not None and previous_alpha is not None:
                motion = _motion_map(frame, previous_source)
                weight = np.clip(float(alpha_min) + float(motion_gain) * motion, float(alpha_min), 1.0)
                alpha = weight * alpha + (1.0 - weight) * previous_alpha
            if enabled:
                alpha = _remove_speckles(alpha, float(minimum_speckle))
            alpha_bytes = np.round(alpha * 255).astype(np.uint8)
            encoder.stdin.write(alpha_bytes.tobytes())
            alpha_low = min(alpha_low, int(alpha_bytes.min()))
            alpha_high = max(alpha_high, int(alpha_bytes.max()))
            if int(alpha_bytes.max()) > 0:
                nonzero_frames += 1
            previous_source = frame
            previous_alpha = alpha
            progress((index + 1) / frame_count, "matte")
        encoder.stdin.close()
        decoder_code = decoder.wait(timeout=30)
        encoder_code = encoder.wait(timeout=30)
        if decoder_code != 0:
            raise RuntimeError(decoder.stderr.read().decode(errors="replace"))
        if encoder_code != 0:
            raise RuntimeError(encoder.stderr.read().decode(errors="replace"))
        os.replace(temporary, output_path)
    finally:
        if decoder.poll() is None:
            decoder.terminate()
        if encoder.poll() is None:
            encoder.terminate()
        temporary.unlink(missing_ok=True)

    result = {
        "schema": "guyditor.matte/v1",
        "path": str(output_path),
        "format": "ffv1-gray-mkv",
        "sha256": _sha256_file(output_path),
        "cacheKey": cache_key,
        "source": {
            "path": str(source_path),
            "sha256": source_hash,
            "frames": {"from": frame_from, "to": frame_to},
        },
        "width": width,
        "height": height,
        "frameCount": frame_count,
        "fps": fps,
        "alpha": {
            "minimum": alpha_low,
            "maximum": alpha_high,
            "nonZeroFrames": nonzero_frames,
        },
        "engine": {"name": "rvm", "version": version, "model": model_name},
        "params": {
            "model": model_name,
            "downsampleRatio": downsample_ratio,
            "stabilization": stabilization,
        },
    }
    result_path.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf8")
    return result
