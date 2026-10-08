"""Standalone validate-only entry point: `python -m compositor.validate_cli <timeline.json>`.

Used by the Node side (the script parser and `lint` command) to validate a
timeline.json the same way a real render would -- full schema validation
*and* loading (which resolves every asset path, probes every audio file's
duration, and resolves every lip-sync cues source) -- without actually
rendering a single frame. Reusing this one validator avoids a second,
possibly-drifting JSON Schema implementation on the Node side.

Exit code 0 + "OK" on stdout on success; exit code 1 + the error message on
stderr on failure.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .schema_validate import TimelineValidationError
from .timeline_loader import load_timeline


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: python -m compositor.validate_cli <timeline.json>", file=sys.stderr)
        return 2

    timeline_path = Path(argv[0])
    if not timeline_path.exists():
        print(f"error: file not found: {timeline_path}", file=sys.stderr)
        return 2

    try:
        timeline = load_timeline(timeline_path)
    except TimelineValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - surface any load-time error (bad path, bad audio, etc.)
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"OK: {len(timeline.scenes)} scene(s), {timeline.total_frames} frames @ {timeline.fps}fps")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
