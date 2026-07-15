#!/usr/bin/env python3
"""Validate the single HTML project guide exists."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
GUIDE = ROOT / "index.html"


def main() -> int:
    if not GUIDE.is_file():
        raise SystemExit(f"Missing required guide: {GUIDE}")
    print(f"Guide ready: {GUIDE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
