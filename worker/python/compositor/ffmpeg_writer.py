"""Pipes raw composited frames into an FFmpeg subprocess for encoding.

Gemini's draft wrote frames with ``cv2.VideoWriter`` using the ``mp4v``
fourcc, which plays back badly in both browsers and DaVinci Resolve, and
never attached audio at all. Instead we spawn FFmpeg directly, write raw
BGR24 frames to its stdin, and mix in every dialogue/ambience audio clip
as separate FFmpeg inputs with precise start-time offsets.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable

import numpy as np

from .timeline_loader import AudioClip

CODEC_H264 = "h264"
CODEC_PRORES4444 = "prores4444"
SUPPORTED_CODECS = (CODEC_H264, CODEC_PRORES4444)


def _build_audio_filter(audio_clips: list[AudioClip]) -> tuple[list[str], str]:
    """Returns (ffmpeg input args for audio, filter_complex producing [aout])."""

    input_args: list[str] = []
    labels: list[str] = []
    for i, clip in enumerate(audio_clips):
        input_args += ["-i", str(clip.path)]
        delay_ms = max(0, round(clip.start_seconds * 1000))
        labels.append(f"[{i + 1}:a]adelay={delay_ms}:all=1[a{i}]")

    mix_inputs = "".join(f"[a{i}]" for i in range(len(audio_clips)))
    labels.append(f"{mix_inputs}amix=inputs={len(audio_clips)}:normalize=0:dropout_transition=0[aout]")
    return input_args, ";".join(labels)


def build_ffmpeg_cmd(
    output_path: Path,
    width: int,
    height: int,
    fps: int,
    codec: str,
    audio_clips: list[AudioClip],
    duration_seconds: float,
) -> list[str]:
    if codec not in SUPPORTED_CODECS:
        raise ValueError(f"Unsupported codec {codec!r}; expected one of {SUPPORTED_CODECS}")

    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", str(fps),
        "-i", "-",
    ]

    map_args: list[str]
    if audio_clips:
        audio_inputs, filter_complex = _build_audio_filter(audio_clips)
        cmd += audio_inputs
        cmd += ["-filter_complex", filter_complex]
        map_args = ["-map", "0:v", "-map", "[aout]"]
    else:
        map_args = ["-map", "0:v"]

    cmd += map_args

    if codec == CODEC_H264:
        cmd += [
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18",
            "-movflags", "+faststart",
        ]
        if audio_clips:
            cmd += ["-c:a", "aac", "-b:a", "192k"]
    else:  # prores4444
        cmd += [
            "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuv444p10le",
            "-vendor", "apl0", "-qscale:v", "9",
        ]
        if audio_clips:
            cmd += ["-c:a", "pcm_s16le"]

    cmd += ["-t", f"{duration_seconds:.6f}"]
    cmd.append(str(output_path))
    return cmd


class FfmpegFrameWriter:
    """Context manager wrapping an FFmpeg subprocess fed via stdin."""

    def __init__(
        self,
        output_path: Path,
        width: int,
        height: int,
        fps: int,
        codec: str,
        audio_clips: list[AudioClip],
        total_frames: int,
    ) -> None:
        self.output_path = Path(output_path)
        self.width = width
        self.height = height
        duration_seconds = total_frames / float(fps)
        self.cmd = build_ffmpeg_cmd(
            self.output_path, width, height, fps, codec, audio_clips, duration_seconds
        )
        self._process: subprocess.Popen | None = None

    def __enter__(self) -> "FfmpegFrameWriter":
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        # stdout/stderr are inherited (not piped): ffmpeg's own progress/error
        # output goes straight to the console, and -- just as importantly --
        # this avoids a classic deadlock where ffmpeg blocks writing a full
        # stderr pipe while we're blocked writing frames to stdin.
        self._process = subprocess.Popen(self.cmd, stdin=subprocess.PIPE)
        return self

    def write_frame(self, frame_bgr: np.ndarray) -> None:
        assert self._process is not None and self._process.stdin is not None
        if frame_bgr.shape[:2] != (self.height, self.width):
            raise ValueError(
                f"Frame shape {frame_bgr.shape[:2]} does not match canvas "
                f"{(self.height, self.width)}"
            )
        self._process.stdin.write(np.ascontiguousarray(frame_bgr, dtype=np.uint8).tobytes())

    def __exit__(self, exc_type, exc, tb) -> None:
        assert self._process is not None
        if self._process.stdin is not None:
            try:
                self._process.stdin.close()
            except BrokenPipeError:
                pass
        returncode = self._process.wait()
        if returncode != 0 and exc_type is None:
            raise RuntimeError(f"ffmpeg exited with code {returncode} (see its output above)")


def write_frames(
    frames: Iterable[np.ndarray],
    output_path: Path,
    width: int,
    height: int,
    fps: int,
    codec: str,
    audio_clips: list[AudioClip],
    total_frames: int,
) -> None:
    with FfmpegFrameWriter(output_path, width, height, fps, codec, audio_clips, total_frames) as writer:
        for frame in frames:
            writer.write_frame(frame)
