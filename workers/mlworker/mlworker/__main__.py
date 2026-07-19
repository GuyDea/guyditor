from __future__ import annotations

import argparse

from .server import run_stdio


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m mlworker")
    parser.add_argument("--stdio", action="store_true", help="use JSON-RPC on stdio")
    arguments = parser.parse_args()
    if not arguments.stdio:
        parser.error("--stdio is required")
    run_stdio()


if __name__ == "__main__":
    main()

