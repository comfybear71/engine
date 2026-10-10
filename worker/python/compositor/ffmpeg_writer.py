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


def _silence_input_args(duration_seconds: float) -> list[str]:
    """A finite silent stereo bed covering the whole render.

    ``anullsrc`` is otherwise infinite; ``-t`` on this input (plus
    ``duration=first`` on the mix) is what keeps the audio stream the same
    length as the picture -- including when every dialogue clip is
    estimated/silent and there are no real WAV inputs at all.
    """

    return [
        "-f", "lavfi",
        "-t", f"{duration_seconds:.6f}",
        "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    ]


def _build_audio_filter(
    audio_clips: list[AudioClip],
    duration_seconds: float,
) -> tuple[list[str], str]:
    """Returns (ffmpeg input args for audio, filter_complex producing [aout]).

    Input 0 is the raw video pipe. Input 1 is always a full-length silence
    bed; real dialogue/ambience files (if any) start at input 2. Estimated
    clips never appear here -- they have no file -- so their time is just
    the silence already in the bed.
    """

    input_args = _silence_input_args(duration_seconds)
    labels: list[str] = []
    mix_parts = ["[1:a]"]
    for i, clip in enumerate(audio_clips):
        input_index = i + 2
        if clip.in_seconds > 1e-6:
            input_args += ["-ss", f"{clip.in_seconds:.6f}"]
        if clip.duration_seconds is not None:
            input_args += ["-t", f"{clip.duration_seconds:.6f}"]
        input_args += ["-i", str(clip.path)]
        delay_ms = max(0, round(clip.start_seconds * 1000))
        labels.append(f"[{input_index}:a]adelay={delay_ms}:all=1[a{i}]")
        mix_parts.append(f"[a{i}]")

    n = len(mix_parts)
    labels.append(
        f"{''.join(mix_parts)}amix=inputs={n}:normalize=0:dropout_transition=0:duration=first[aout]"
    )
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

    # Always attach one audio stream covering the full scene length, even
    # when there are no real clips (all estimated / no dialogue at all).
    # Drafts and finished renders then line up the same way in Resolve.
    audio_inputs, filter_complex = _build_audio_filter(audio_clips, duration_seconds)
    cmd += audio_inputs
    cmd += ["-filter_complex", filter_complex]
    cmd += ["-map", "0:v", "-map", "[aout]"]

    if codec == CODEC_H264:
        cmd += [
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18",
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "192k",
        ]
    else:  # prores4444
        cmd += [
            "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuv444p10le",
            "-vendor", "apl0", "-qscale:v", "9",
            "-c:a", "pcm_s16le",
        ]

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


def build_preview_segment_cmd(
    output_path: Path,
    width: int,
    height: int,
    fps: int,
) -> list[str]:
    """Video-only ultrafast H.264 for Stage proxy windows (no audio mix)."""

    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", str(fps),
        "-i", "-",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
        "-an", "-movflags", "+faststart",
        str(output_path),
    ]


def write_preview_segment(
    frames: Iterable[np.ndarray],
    output_path: Path,
    width: int,
    height: int,
    fps: int,
) -> Path:
    """Encode a short preview window. Audio is streamed separately by Studio."""

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = build_preview_segment_cmd(output_path, width, height, fps)
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame_bgr in frames:
            if frame_bgr.ndim == 3 and frame_bgr.shape[2] == 4:
                frame_bgr = frame_bgr[:, :, :3]
            if frame_bgr.shape[:2] != (height, width):
                raise ValueError(
                    f"Frame shape {frame_bgr.shape[:2]} does not match canvas {(height, width)}"
                )
            process.stdin.write(np.ascontiguousarray(frame_bgr, dtype=np.uint8).tobytes())
        process.stdin.close()
    except BrokenPipeError:
        pass
    returncode = process.wait()
    if returncode != 0:
        raise RuntimeError(f"ffmpeg preview segment exited with code {returncode}")
    return output_path


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
