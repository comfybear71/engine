"""CLI entry point: render a project's timeline.json to a video file.

Usage:
    python -m compositor <project_dir> [--codec h264|prores4444] [--output PATH]

Invoked by the Node orchestrator (see worker/src/render.js) as a child
process, but works standalone for local iteration too.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .compositor import render
from .ffmpeg_writer import CODEC_H264, SUPPORTED_CODECS
from .schema_validate import TimelineValidationError
from .timeline_loader import load_timeline

DEFAULT_OUTPUT_EXT = {"h264": "mp4", "prores4444": "mov"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a timeline.json project to video.")
    parser.add_argument("project_dir", type=Path, help="Path to the project folder containing timeline.json")
    parser.add_argument(
        "--timeline", type=Path, default=None,
        help="Path to the timeline JSON file (default: <project_dir>/timeline.json)",
    )
    parser.add_argument("--codec", choices=SUPPORTED_CODECS, default=CODEC_H264)
    parser.add_argument("--output", type=Path, default=None, help="Output video path")
    args = parser.parse_args(argv)

    project_dir: Path = args.project_dir.resolve()
    timeline_path = args.timeline.resolve() if args.timeline else project_dir / "timeline.json"

    if not timeline_path.exists():
        print(f"error: timeline file not found: {timeline_path}", file=sys.stderr)
        return 2

    try:
        timeline = load_timeline(timeline_path)
    except TimelineValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    output_path = args.output
    if output_path is None:
        ext = DEFAULT_OUTPUT_EXT[args.codec]
        output_path = project_dir / "renders" / f"output.{ext}"

    print(
        f"Rendering {timeline.series} / {timeline.episode}: "
        f"{len(timeline.scenes)} scene(s), {timeline.total_frames} frames "
        f"@ {timeline.fps}fps, codec={args.codec} -> {output_path}"
    )
    render(timeline, output_path, codec=args.codec)
    print(f"Done: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
