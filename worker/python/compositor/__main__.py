"""CLI entry point: render a project's timeline.json to a video file.

Usage:
    python -m compositor <project_dir> [--codec h264|prores4444] [--output PATH]
    python -m compositor <project_dir> --preview-frame N [--output PATH.png]

Invoked by the Node orchestrator (see worker/src/render.js) as a child
process, but works standalone for local iteration too.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from .compositor import clamp_preview_frame, compose_frame, render, scene_at_frame
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
    parser.add_argument("--output", type=Path, default=None, help="Output video or preview PNG path")
    parser.add_argument(
        "--preview-frame",
        type=int,
        default=None,
        metavar="N",
        help="Compose global frame N to a PNG instead of rendering video (Studio preview)",
    )
    args = parser.parse_args(argv)

    project_dir: Path = args.project_dir.resolve()
    timeline_path = args.timeline.resolve() if args.timeline else project_dir / "timeline.json"

    if not timeline_path.exists():
        print(f"error: timeline file not found: {timeline_path}", file=sys.stderr)
        return 2

    try:
        timeline = load_timeline(timeline_path, project_dir=project_dir)
    except TimelineValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.preview_frame is not None:
        return _write_preview(timeline, args.preview_frame, args.output, project_dir)

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


def _write_preview(timeline, frame_index: int, output_path: Path | None, project_dir: Path) -> int:
    if timeline.total_frames <= 0:
        print("error: timeline has no frames", file=sys.stderr)
        return 2
    frame_index = clamp_preview_frame(timeline, frame_index)
    try:
        scene, local_frame = scene_at_frame(timeline, frame_index)
        canvas = compose_frame(timeline, frame_index)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if output_path is None:
        output_path = project_dir / "renders" / f"preview_{frame_index}.png"
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), canvas):
        print(f"error: failed to write PNG: {output_path}", file=sys.stderr)
        return 1

    print(f"Preview frame {frame_index}/{timeline.total_frames} -> {output_path}", file=sys.stderr)
    print(
        json.dumps(
            {
                "ok": True,
                "frame": frame_index,
                "localFrame": local_frame,
                "totalFrames": timeline.total_frames,
                "fps": timeline.fps,
                "canvas": {"width": timeline.canvas.width, "height": timeline.canvas.height},
                "sceneId": scene.id,
                "outputPath": str(output_path),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
