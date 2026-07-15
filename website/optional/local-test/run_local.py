#!/usr/bin/env python3
"""One-command local launcher for Dividend Uploader."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve()
if SCRIPT_PATH.parent.name == "local-test" and SCRIPT_PATH.parent.parent.name == "optional":
    ROOT = SCRIPT_PATH.parents[2]
else:
    ROOT = SCRIPT_PATH.parent

LOADER = ROOT / "optional" / "tools" / "project-tools" / "dev" / "load_test_environment.py"


def main() -> int:
    if not LOADER.exists():
        print(f"Missing loader script: {LOADER}", file=sys.stderr)
        return 1

    os.chdir(ROOT)
    spec = importlib.util.spec_from_file_location("dividend_uploader_test_loader", LOADER)
    if spec is None or spec.loader is None:
        print(f"Cannot load loader script: {LOADER}", file=sys.stderr)
        return 1

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
