# ML worker

The Guyditor ML worker is a Python 3.11+ sidecar using newline-delimited JSON-RPC
2.0 over stdio. It advertises and implements `transcribe` through
`faster-whisper`, CPU CTC `align` through torchaudio's wav2vec2
`WAV2VEC2_ASR_BASE_960H` bundle, and `vad` through faster-whisper's bundled
Silero VAD with an energy-boundary refinement for deterministic silence edges.
It also exposes `matte` through a locally installed RobustVideoMatting
TorchScript model and writes grayscale FFV1 MKV alpha sequences.

## Setup

From the repository root:

```sh
bash workers/mlworker/setup.sh
```

The idempotent script uses `uv` to provision Python 3.11, recreates
`workers/mlworker/.venv`, and installs this package editable. The desktop side
launches `workers/mlworker/.venv/bin/python -m mlworker --stdio`; user
site-packages are disabled.

Environment variables:

- `GUYDITOR_ML_MODEL_DIR` changes the model cache from
  `~/.cache/guyditor-mlworker`.
- `GUYDITOR_ML_DISABLE=align,transcribe,vad,matte` removes named capabilities
  from the startup handshake without preventing the worker from starting.

## RobustVideoMatting models

Matting is capability-gated. Install an official RobustVideoMatting TorchScript
model under `GUYDITOR_ML_MODEL_DIR` using one of these exact names:

- `rvm_mobilenetv3_fp32.torchscript`
- `rvm_resnet50_fp32.torchscript`

The worker advertises `matte` and engine `rvm` only when PyTorch and at least
one model are available. A missing model degrades cleanly to
`E_MATTE_CAPABILITY_MISSING`; chroma keying remains available.

RVM inference is sequential and CPU-compatible. `rvm_mobilenetv3` is the
recommended CPU model. The UI defaults to a `0.5` downsample ratio for 1080p
and the §6.5 `0.25` recommendation applies to 4K. CPU generation is an offline
pre-render job and may be substantially slower than real time, especially with
ResNet50 or ratios near `1.0`; it never runs during final render. Acceptance
freezes the candidate as a read-only generated asset, after which render uses
only `alphamerge` plus masks, spill suppression, and post-color.

The post-pass resets recurrent state at scene boundaries, applies the specified
motion-adaptive temporal blend, and removes small foreground and hole
components. The automated fixture asserts schema, grayscale FFV1 output, frame
count, and alpha presence. Edge quality and throughput on real footage are M4
dogfood judgments.

## Tests

```sh
uv run --project workers/mlworker pytest workers/mlworker/tests
```

The worker writes protocol messages only to stdout. Diagnostics and dependency
failures are returned as JSON-RPC errors; callers capture stderr separately.
`GUYDITOR_RVM_TEST_STUB=1` selects a deterministic luma-based protocol stub for
the automated greenscreen contract only; it is not a production matting engine.
