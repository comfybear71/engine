"""468-point face landmarks using MediaPipe's face_landmark.tflite run through
OpenCV DNN (cv2.dnn.readNetFromTFLite). No mediapipe / tensorflow install needed.

Model: worker/python/models/face_landmark.tflite (Apache-2.0, from the
mediapipe 0.10.14 wheel, mediapipe/modules/face_landmark/face_landmark.tflite).

Usage:
    from compositor.face_landmarks import FaceLandmarker
    fl = FaceLandmarker()
    res = fl.detect(bgr_image, alpha=None)   # alpha optional (H,W uint8)
    if res: res["points"]  -> (468, 2) float pixel coords
            res["score"]   -> face presence logit (> 0 means a face)
"""

from __future__ import annotations

import os
from typing import Optional

import cv2
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "face_landmark.tflite")

# Handy landmark index groups (MediaPipe Face Mesh topology).
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191]
MOUTH_LEFT, MOUTH_RIGHT, LIP_TOP_INNER, LIP_BOTTOM_INNER = 61, 291, 13, 14
LIP_TOP_OUTER, LIP_BOTTOM_OUTER = 0, 17
LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]  # subject's right eye (image left)
RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
LEFT_EYE_EAR = (33, 133, 159, 145)    # corner, corner, top, bottom
RIGHT_EYE_EAR = (362, 263, 386, 374)
LEFT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
RIGHT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
NOSE_TIP, CHIN, FOREHEAD = 1, 152, 10
FACE_LEFT_EDGE, FACE_RIGHT_EDGE = 234, 454

_INPUT = 192


class FaceLandmarker:
    def __init__(self, model_path: str = MODEL_PATH):
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"face landmark model missing: {model_path}")
        self.net = cv2.dnn.readNetFromTFLite(model_path)
        self.outs = self.net.getUnconnectedOutLayersNames()

    def _run(self, bgr: np.ndarray, cx: float, cy: float, size: float):
        x0, y0 = cx - size / 2.0, cy - size / 2.0
        k = _INPUT / size
        m = np.float32([[k, 0, -x0 * k], [0, k, -y0 * k]])
        crop = cv2.warpAffine(bgr, m, (_INPUT, _INPUT), borderMode=cv2.BORDER_CONSTANT)
        blob = cv2.dnn.blobFromImage(crop, 1 / 255.0, (_INPUT, _INPUT), swapRB=True)
        self.net.setInput(blob)
        outs = self.net.forward(self.outs)
        lm = next(o for o in outs if o.size == 1404).reshape(468, 3)
        score = float(next(o for o in outs if o.size == 1).ravel()[0])
        pts = lm[:, :2] / k + [x0, y0]
        return pts.astype(np.float32), score

    def detect(self, bgr: np.ndarray, alpha: Optional[np.ndarray] = None, iterations: int = 3):
        """Find the face. Seeds the crop from the subject's bounding box (alpha
        if given, else non-black pixels), assuming a head clip where the face
        sits in the lower ~60% (under the hat). Refines 3 times."""
        mask = alpha if alpha is not None else (bgr.max(axis=2) > 30).astype(np.uint8) * 255
        ys, xs = np.nonzero(mask > 127)
        if xs.size < 100:
            return None
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        cx, cy, size = (x0 + x1) / 2.0, y0 + (y1 - y0) * 0.62, (x1 - x0) * 0.7
        pts, score = None, -1e9
        for _ in range(iterations):
            pts, score = self._run(bgr, cx, cy, size)
            span = pts.max(axis=0) - pts.min(axis=0)
            cx, cy = pts.mean(axis=0)
            size = float(span.max()) * 1.5
        if score < 0:
            return None
        return {"points": pts, "score": score}
