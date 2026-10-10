"""Long-lived preview compositor for Studio.

Reads one JSON object per stdin line and writes a JPEG/PNG or a short
proxy MP4 plus a JSON result line. Keeps numpy/cv2 imported and reuses a
loaded timeline *and* decoded AssetCache when the path and mtime have
not changed. Segment requests loop frames in-process (no per-frame HTTP).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2

from .asset_cache import AssetCache
from .compositor import clamp_preview_frame, compose_frame, scene_at_frame
from .ffmpeg_writer import write_preview_segment
from .schema_validate import TimelineValidationError
from .timeline_loader import load_timeline

_loaded: dict = {"path": None, "mtime": None, "settings_mtime": None, "timeline": None, "cache": None}

PREVIEW_WIDTH = 960
PREVIEW_HEIGHT = 540


def _settings_mtime(project_dir: Path) -> float:
    studio = project_dir / "studio.json"
    try:
        return studio.stat().st_mtime
    except OSError:
        return 0.0


def _load(timeline_path: Path, project_dir: Path):
    mtime = timeline_path.stat().st_mtime
    settings_mtime = _settings_mtime(project_dir)
    if (
        _loaded["timeline"] is not None
        and _loaded["cache"] is not None
        and _loaded["path"] == str(timeline_path)
        and _loaded["mtime"] == mtime
        and _loaded.get("settings_mtime") == settings_mtime
    ):
        return _loaded["timeline"], _loaded["cache"]
    timeline = load_timeline(timeline_path, project_dir=project_dir)
    cache = AssetCache()
    _loaded["path"] = str(timeline_path)
    _loaded["mtime"] = mtime
    _loaded["settings_mtime"] = settings_mtime
    _loaded["timeline"] = timeline
    _loaded["cache"] = cache
    return timeline, cache


def _write_image(canvas, output_path: Path, fmt: str, quality: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "jpeg":
        ok = cv2.imwrite(str(output_path), canvas, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    else:
        ok = cv2.imwrite(str(output_path), canvas)
    if not ok:
        raise RuntimeError(f"failed to write {fmt}: {output_path}")


def _write_progress(path: Path | None, payload: dict) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)


def _preview_size(req: dict, fmt: str) -> tuple[int | None, int | None]:
    width = req.get("width")
    height = req.get("height")
    if width and height:
        return int(width), int(height)
    if fmt == "jpeg":
        return PREVIEW_WIDTH, PREVIEW_HEIGHT
    return None, None


def handle_frame(req: dict, timeline, cache) -> dict:
    if timeline.total_frames <= 0:
        return {"id": req.get("id"), "ok": False, "error": "timeline has no frames"}

    frame_index = clamp_preview_frame(timeline, int(req.get("frame") or 0))
    scene, local_frame = scene_at_frame(timeline, frame_index)
    fmt = "jpeg" if str(req.get("format") or "png").lower() in {"jpg", "jpeg"} else "png"
    quality = int(req.get("quality") or 85)
    width, height = _preview_size(req, fmt)
    canvas = compose_frame(timeline, frame_index, cache=cache, width=width, height=height)

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
        "preview": {"width": int(canvas.shape[1]), "height": int(canvas.shape[0])},
        "sceneId": scene.id,
        "outputPath": str(output_path),
        "format": fmt,
    }


def handle_segment(req: dict, timeline, cache) -> dict:
    if timeline.total_frames <= 0:
        return {"id": req.get("id"), "ok": False, "error": "timeline has no frames"}

    start = max(0, int(req.get("startFrame") or 0))
    count = max(1, int(req.get("frames") or 1))
    width = max(2, int(req.get("width") or PREVIEW_WIDTH))
    height = max(2, int(req.get("height") or PREVIEW_HEIGHT))
    width -= width % 2
    height -= height % 2
    output_path = Path(req["output"]).resolve()
    progress_path = Path(req["progressPath"]).resolve() if req.get("progressPath") else None

    def frames():
        for i in range(count):
            idx = clamp_preview_frame(timeline, start + i)
            frame = compose_frame(timeline, idx, cache=cache, width=width, height=height)
            if progress_path is not None and (i % 12 == 0 or i + 1 == count):
                _write_progress(
                    progress_path,
                    {
                        "framesDone": i + 1,
                        "framesTotal": count,
                        "progress": (i + 1) / count,
                        "done": False,
                    },
                )
            yield frame

    write_preview_segment(frames(), output_path, width, height, timeline.fps)
    _write_progress(
        progress_path,
        {"framesDone": count, "framesTotal": count, "progress": 1, "done": True},
    )
    return {
        "id": req.get("id"),
        "ok": True,
        "cmd": "segment",
        "startFrame": start,
        "frames": count,
        "fps": timeline.fps,
        "width": width,
        "height": height,
        "totalFrames": timeline.total_frames,
        "outputPath": str(output_path),
    }


def handle(req: dict) -> dict:
    project_dir = Path(req["projectDir"]).resolve()
    timeline_path = Path(req["timeline"]).resolve() if req.get("timeline") else project_dir / "timeline.json"
    if not timeline_path.exists():
        return {"id": req.get("id"), "ok": False, "error": f"timeline file not found: {timeline_path}"}

    timeline, cache = _load(timeline_path, project_dir)
    if str(req.get("cmd") or "") == "segment" or req.get("frames"):
        return handle_segment(req, timeline, cache)
    return handle_frame(req, timeline, cache)


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
