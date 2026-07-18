# ML worker

The Guyditor ML worker is a Python 3.11+ sidecar using newline-delimited JSON-RPC
2.0 over stdio. It advertises and implements `transcribe` through
`faster-whisper`, CPU CTC `align` through torchaudio's wav2vec2
`WAV2VEC2_ASR_BASE_960H` bundle, and `vad` through faster-whisper's bundled
Silero VAD with an energy-boundary refinement for deterministic silence edges.

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
- `GUYDITOR_ML_DISABLE=align,transcribe,vad` removes named capabilities from the
  startup handshake without preventing the worker from starting.

## Tests

```sh
uv run --project workers/mlworker pytest workers/mlworker/tests
```

The worker writes protocol messages only to stdout. Diagnostics and dependency
failures are returned as JSON-RPC errors; callers capture stderr separately.
