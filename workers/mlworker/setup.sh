#!/usr/bin/env bash
set -euo pipefail

worker_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$worker_root"

export UV_CACHE_DIR="${UV_CACHE_DIR:-$worker_root/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$worker_root/.uv-python}"
export UV_PYTHON_INSTALL_BIN=0

uv python install 3.11
uv venv .venv --python 3.11 --clear
VIRTUAL_ENV="$worker_root/.venv" uv pip install -e .

"$worker_root/.venv/bin/python" -c \
  'import sys; assert sys.version_info >= (3, 11); import cv2, faster_whisper, mediapipe, mlworker, pytest, torch, torchaudio; assert torch.version.cuda is None'
