"""Engine render worker: Python compositor.

Loads a validated ``timeline.json``, composites each frame with cached,
pre-transformed PNG layers (correct z-order, canvas-space positioning,
off-screen clipping and alpha blending), and pipes raw frames into FFmpeg
for H.264 or ProRes 4444 encoding with mixed-in dialogue/ambience audio.
"""

__version__ = "0.1.0"
