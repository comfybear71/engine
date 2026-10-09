"""Generates placeholder tone WAVs + Rhubarb-style cues JSON for every line
in projects/sample/lines.json (produced by `node src/cli.js parse`).

This stands in for a real ElevenLabs generation step: it reads exactly the
audio paths the parser decided on (stable, scene+line-order based -- never
frame-number based) and writes a short tone of about that line's estimated
duration at each one, plus a hand-authored cues file next to it, so the
sample project renders end-to-end with no ElevenLabs or Rhubarb installed.

Run after a first `node src/cli.js parse ../projects/sample` (which writes
lines.json using estimated durations), then re-run `parse` again afterwards
so it picks up the real (ffprobe) durations from these files instead.

    cd worker && node src/cli.js parse ../projects/sample
    worker/python/venv/bin/python worker/python/scripts/generate_sample_audio.py
    cd worker && node src/cli.js parse ../projects/sample
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PROJECT_DIR = REPO_ROOT / "projects" / "sample"

VOICE_PITCH_HZ = {
    "hicks": 150.0,
    "dana": 230.0,
}

MOUTH_CYCLE = ["X", "C", "B", "D", "C", "H", "B", "E", "A", "C", "X"]


def _write_tone_wav(path: Path, duration_s: float, freq_hz: float, sample_rate: int = 44100) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n_samples = max(1, int(duration_s * sample_rate))
    amplitude = 0.28 * 32767
    samples = bytearray()
    for i in range(n_samples):
        t = i / sample_rate
        envelope = min(1.0, t / 0.04, (duration_s - t) / 0.04)
        envelope = max(0.0, envelope)
        # A little vibrato + a second harmonic so lines are distinguishable
        # from a pure test tone and from each other.
        value = (
            amplitude
            * envelope
            * (
                0.8 * math.sin(2 * math.pi * freq_hz * t + 0.4 * math.sin(2 * math.pi * 3.5 * t))
                + 0.2 * math.sin(2 * math.pi * freq_hz * 2.01 * t)
            )
        )
        samples += struct.pack("<h", int(max(-32767, min(32767, value))))

    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(bytes(samples))


def _write_cues(path: Path, duration_s: float) -> None:
    shapes = MOUTH_CYCLE
    n = len(shapes)
    step = duration_s / n
    cues = [{"start": round(i * step, 3), "end": round((i + 1) * step, 3), "value": s} for i, s in enumerate(shapes)]
    data = {"metadata": {"duration": duration_s}, "mouthCues": cues}
    path.write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    lines_path = PROJECT_DIR / "lines.json"
    if not lines_path.exists():
        raise SystemExit(f"{lines_path} not found -- run `node src/cli.js parse ../projects/sample` first.")

    lines = json.loads(lines_path.read_text())["lines"]
    for line in lines:
        duration_s = line.get("estimated_duration_seconds", 2.0)
        audio_path = PROJECT_DIR / line["audio_path"]
        cues_path = PROJECT_DIR / line["cues_path"]
        freq = VOICE_PITCH_HZ.get(line["character"], 190.0)

        _write_tone_wav(audio_path, duration_s, freq)
        _write_cues(cues_path, duration_s)
        print(f"wrote {audio_path.relative_to(PROJECT_DIR)} ({duration_s:.2f}s) + cues")

    print(f"Done: {len(lines)} line(s).")


if __name__ == "__main__":
    main()
