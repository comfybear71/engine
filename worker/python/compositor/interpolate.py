"""Per-property keyframe interpolation.

Modeled on ``camera._interpolate``: hold the first specified value before the
first keyframe and the last specified value after the last, and blend between
consecutive keyframes that define the same property. The only addition is an
optional per-segment ease (``linear`` or ``inout``), taken from the departing
keyframe.
"""

from __future__ import annotations


def apply_ease(t: float, ease: str | None) -> float:
    """Map a 0..1 linear parameter through ``ease``. Unknown/None is linear."""

    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    if ease == "inout":
        return t * t * (3.0 - 2.0 * t)
    return t


def interpolate_scalar(
    keys: list[tuple[int, float, str | None]],
    frame: int,
    default: float,
) -> float:
    """Interpolate one property from ``(frame, value, ease)`` samples.

    ``keys`` may be unsorted and may omit the property on some keyframes
    (those samples are simply not in the list). An empty list returns
    ``default`` -- the static field the keyframes sit on top of.
    """

    if not keys:
        return default

    resolved = sorted(keys, key=lambda k: k[0])
    if frame <= resolved[0][0]:
        return resolved[0][1]
    if frame >= resolved[-1][0]:
        return resolved[-1][1]

    for (f0, v0, ease0), (f1, v1, _ease1) in zip(resolved, resolved[1:]):
        if f0 <= frame <= f1:
            t = 0.0 if f1 == f0 else (frame - f0) / (f1 - f0)
            t = apply_ease(t, ease0)
            return v0 + (v1 - v0) * t

    return resolved[-1][1]
