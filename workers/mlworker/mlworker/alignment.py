from __future__ import annotations

from importlib import metadata
import os
from pathlib import Path
import unicodedata
from typing import Any, Callable


ANALYSIS_RATE = 16_000
MODEL_NAME = "wav2vec2-base-960h"
ENGINE_NAME = "torchaudio-wav2vec2-ctc-forced-align"
ProgressCallback = Callable[[float, str], None]


def _required_string(params: dict[str, Any], name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _sample_time(value: int) -> dict[str, int]:
    return {"samples": value, "rate": ANALYSIS_RATE}


def _segment_time(value: Any, name: str) -> int:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a sample-time object")
    samples = value.get("samples")
    rate = value.get("rate")
    if not isinstance(samples, int) or samples < 0:
        raise ValueError(f"{name}.samples must be a non-negative integer")
    if rate != ANALYSIS_RATE:
        raise ValueError(f"{name}.rate must be {ANALYSIS_RATE}")
    return samples


def _normalized_word(token: str, labels: set[str]) -> str:
    ascii_token = unicodedata.normalize("NFKD", token).encode("ascii", "ignore").decode()
    return "".join(character for character in ascii_token.upper() if character in labels)


def _interpolate(
    segment_index: int,
    start: int,
    end: int,
    words: list[str],
) -> list[dict[str, Any]]:
    if not words:
        return []
    duration = end - start
    if duration < len(words):
        raise ValueError("segment duration is too short to assign positive token intervals")
    weights = [max(1, len(word)) for word in words]
    total = sum(weights)
    consumed = 0
    result: list[dict[str, Any]] = []
    previous_end = start
    for token_index, weight in enumerate(weights):
        raw_start = start + duration * consumed // total
        consumed += weight
        raw_end = end if token_index + 1 == len(words) else start + duration * consumed // total
        token_start = max(previous_end, raw_start)
        remaining = len(words) - token_index - 1
        token_end = max(token_start + 1, min(raw_end, end - remaining))
        result.append(
            {
                "segmentIndex": segment_index,
                "tokenIndex": token_index,
                "start": _sample_time(token_start),
                "end": _sample_time(token_end),
                "score": 0.0,
                "aligned": False,
            }
        )
        previous_end = token_end
    return result


def _aligned_segment(
    model: Any,
    functional: Any,
    torch: Any,
    waveform: Any,
    segment_index: int,
    start: int,
    end: int,
    words: list[str],
    dictionary: dict[str, int],
) -> list[dict[str, Any]]:
    normalized = [_normalized_word(word, set(dictionary)) for word in words]
    if any(not word for word in normalized):
        return _interpolate(segment_index, start, end, normalized)
    targets = [dictionary[character] for word in normalized for character in word]
    clip = waveform[start:end].unsqueeze(0)
    if clip.shape[1] == 0:
        return _interpolate(segment_index, start, end, normalized)
    try:
        with torch.inference_mode():
            emissions, _ = model(clip)
            emissions = torch.log_softmax(emissions, dim=-1)
            alignments, scores = functional.forced_align(
                emissions,
                torch.tensor([targets], dtype=torch.int32),
                blank=0,
            )
        token_spans = functional.merge_tokens(alignments[0], scores[0].exp())
        if len(token_spans) != len(targets):
            return _interpolate(segment_index, start, end, normalized)
    except (RuntimeError, ValueError):
        return _interpolate(segment_index, start, end, normalized)

    emission_frames = int(emissions.shape[1])
    clip_samples = end - start
    result: list[dict[str, Any]] = []
    offset = 0
    previous_end = start
    for token_index, word in enumerate(normalized):
        spans = token_spans[offset : offset + len(word)]
        offset += len(word)
        raw_start = start + int(spans[0].start) * clip_samples // emission_frames
        raw_end = start + (int(spans[-1].end) * clip_samples + emission_frames - 1) // emission_frames
        token_start = max(previous_end, min(raw_start, end - 1))
        token_end = max(token_start + 1, min(raw_end, end))
        score_weight = sum(
            float(span.score) * (int(span.end) - int(span.start))
            for span in spans
        )
        score_frames = sum(int(span.end) - int(span.start) for span in spans)
        score = 0.0 if score_frames == 0 else score_weight / score_frames
        result.append(
            {
                "segmentIndex": segment_index,
                "tokenIndex": token_index,
                "start": _sample_time(token_start),
                "end": _sample_time(token_end),
                "score": max(0.0, min(1.0, score)),
                "aligned": True,
            }
        )
        previous_end = token_end
    return result


def align(params: dict[str, Any], progress: ProgressCallback) -> dict[str, Any]:
    audio_path = Path(_required_string(params, "audioPath"))
    if not audio_path.is_file():
        raise ValueError(f"audioPath does not exist: {audio_path}")
    language = _required_string(params, "language")
    if language.lower().split("-")[0] != "en":
        raise ValueError("wav2vec2-base-960h forced alignment currently supports English only")
    model_name = params.get("model", MODEL_NAME)
    if model_name != MODEL_NAME:
        raise ValueError(f"unsupported alignment model: {model_name}")
    raw_segments = params.get("segments")
    if not isinstance(raw_segments, list):
        raise ValueError("segments must be an array")

    cache_dir = Path(
        os.environ.get(
            "GUYDITOR_ML_MODEL_DIR",
            str(Path.home() / ".cache" / "guyditor-mlworker"),
        )
    ).expanduser()
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["TORCH_HOME"] = str(cache_dir / "torch")

    progress(0.02, "align-load")
    import torch
    import torchaudio
    from faster_whisper.audio import decode_audio

    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model().eval().cpu()
    dictionary = {label: index for index, label in enumerate(bundle.get_labels())}
    audio = decode_audio(str(audio_path), sampling_rate=ANALYSIS_RATE)
    waveform = torch.from_numpy(audio)
    progress(0.1, "align")

    tokens: list[dict[str, Any]] = []
    for position, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict):
            raise ValueError("each segment must be an object")
        segment_index = raw_segment.get("index")
        if not isinstance(segment_index, int) or segment_index < 0:
            raise ValueError("segment.index must be a non-negative integer")
        start = _segment_time(raw_segment.get("start"), "segment.start")
        end = _segment_time(raw_segment.get("end"), "segment.end")
        if start >= end or end > len(audio):
            raise ValueError("segment must be a positive interval within the audio")
        raw_words = raw_segment.get("tokens")
        if not isinstance(raw_words, list) or any(
            not isinstance(word, str) or not word.strip() for word in raw_words
        ):
            raise ValueError("segment.tokens must contain non-empty strings")
        words = [word.strip() for word in raw_words]
        tokens.extend(
            _aligned_segment(
                model,
                torchaudio.functional,
                torch,
                waveform,
                segment_index,
                start,
                end,
                words,
                dictionary,
            )
        )
        progress(0.1 + 0.9 * (position + 1) / max(1, len(raw_segments)), "align")

    progress(1.0, "align")
    return {
        "tokens": tokens,
        "engine": {
            "name": ENGINE_NAME,
            "version": metadata.version("torchaudio"),
            "model": MODEL_NAME,
        },
    }
