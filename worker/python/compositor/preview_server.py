"""Long-lived preview compositor for Studio.

Reads one JSON object per stdin line and writes a JPEG/PNG plus a JSON
result line. Keeps numpy/cv2 imported and reuses a loaded timeline when
the path and mtime have not changed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2

from .compositor import clamp_preview_frame, compose_frame, scene_at_frame
from .schema_validate import TimelineValidationError
from .timeline_loader import load_timeline

_loaded: dict = {"path": None, "mtime": None, "timeline": None}


def _load(timeline_path: Path, project_dir: Path):
    mtime = timeline_path.stat().st_mtime
    if (
        _loaded["timeline"] is not None
        and _loaded["path"] == str(timeline_path)
        and _loaded["mtime"] == mtime
    ):
        return _loaded["timeline"]
    timeline = load_timeline(timeline_path, project_dir=project_dir)
    _loaded["path"] = str(timeline_path)
    _loaded["mtime"] = mtime
    _loaded["timeline"] = timeline
    return timeline


def _write_image(canvas, output_path: Path, fmt: str, quality: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "jpeg":
        ok = cv2.imwrite(str(output_path), canvas, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    else:
        ok = cv2.imwrite(str(output_path), canvas)
    if not ok:
        raise RuntimeError(f"failed to write {fmt}: {output_path}")


def handle(req: dict) -> dict:
    project_dir = Path(req["projectDir"]).resolve()
    timeline_path = Path(req["timeline"]).resolve() if req.get("timeline") else project_dir / "timeline.json"
    if not timeline_path.exists():
        return {"id": req.get("id"), "ok": False, "error": f"timeline file not found: {timeline_path}"}

    timeline = _load(timeline_path, project_dir)
    if timeline.total_frames <= 0:
        return {"id": req.get("id"), "ok": False, "error": "timeline has no frames"}

    frame_index = clamp_preview_frame(timeline, int(req.get("frame") or 0))
    scene, local_frame = scene_at_frame(timeline, frame_index)
    canvas = compose_frame(timeline, frame_index)

    fmt = "jpeg" if str(req.get("format") or "png").lower() in {"jpg", "jpeg"} else "png"
    quality = int(req.get("quality") or 85)
    output_path = Path(req["output"]).resolve()
    _write_image(canvas, output_path, fmt, quality)

    return {
        "id": req.get("id"),
        "ok": True,
        "frame": frame_index,
        "localFrame": local_frame,
        "totalFrames": timeline.total_frames,
        "fps": timeline.fps,
        "canvas": {"width": timeline.canvas.width, "height": timeline.canvas.height},
        "sceneId": scene.id,
        "outputPath": str(output_path),
        "format": fmt,
    }


def main() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": f"invalid json: {exc}"}), flush=True)
            continue
        try:
            result = handle(req)
        except TimelineValidationError as exc:
            result = {"id": req.get("id"), "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 — session must not die on one frame
            result = {"id": req.get("id"), "ok": False, "error": str(exc)}
        print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
