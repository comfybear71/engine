import math
import struct
import sys
import wave
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parents[1]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

REPO_ROOT = PYTHON_ROOT.parents[1]
SAMPLE_PROJECT_DIR = REPO_ROOT / "projects" / "sample"


def write_wav(path: Path, duration_s: float, sample_rate: int = 44100, freq_hz: float = 440.0) -> Path:
    """Writes a tiny sine-tone WAV, for tests that need a real, ffprobe-able audio file."""

    n_samples = int(duration_s * sample_rate)
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        samples = [int(3000 * math.sin(2 * math.pi * freq_hz * i / sample_rate)) for i in range(n_samples)]
        wf.writeframes(b"".join(struct.pack("<h", s) for s in samples))
    return path


def write_png_1x1(path: Path) -> Path:
    import cv2
    import numpy as np

    ok, buf = cv2.imencode(".png", np.zeros((1, 1, 3), dtype=np.uint8))
    assert ok
    path.write_bytes(buf.tobytes())
    return path
