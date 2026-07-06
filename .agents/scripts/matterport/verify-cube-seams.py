#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


CENTERS = np.array([[0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, -1, 0]], dtype=float)
RIGHTS = np.array([[-1, 0, 0], [-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]], dtype=float)
UPS = np.array([[0, 0, -1], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1]], dtype=float)


def choose_face(direction: np.ndarray) -> int:
    x, y, z = direction
    return int(np.argmax([y, z, -x, -z, x, -y]))


def uv_for(face: int, direction: np.ndarray) -> tuple[float, float]:
    center = CENTERS[face]
    point = direction * (1.0 / np.dot(center, direction))
    offset = point - center
    return float(np.dot(offset, RIGHTS[face])), float(np.dot(offset, UPS[face]))


def sample(face: np.ndarray, u: float, v: float) -> np.ndarray:
    height, width, _ = face.shape
    x = int(np.clip(round((u + 1) * 0.5 * (width - 1)), 0, width - 1))
    y = int(np.clip(round((1 - (v + 1) * 0.5) * (height - 1)), 0, height - 1))
    return face[y, x]


def seam_edges() -> list[tuple[int, int, list[tuple[np.ndarray, float, float]]]]:
    edges = []
    for face in range(6):
        for axis, fixed in [("u", 1), ("u", -1), ("v", 1), ("v", -1)]:
            points = []
            for index in range(120):
                t = -0.92 + (1.84 * index) / 119
                u = fixed if axis == "u" else t
                v = fixed if axis == "v" else t
                direction = CENTERS[face] + RIGHTS[face] * u + UPS[face] * v
                direction = direction / np.linalg.norm(direction)
                points.append((direction, u, v))
            epsilon = (RIGHTS[face] if axis == "u" else UPS[face]) * fixed * 0.001
            adjacent_faces = {choose_face(direction + epsilon) for direction, _, _ in points}
            if len(adjacent_faces) == 1:
                adjacent = next(iter(adjacent_faces))
                if adjacent != face and face < adjacent:
                    edges.append((face, adjacent, points))
    return edges


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("Usage: verify-cube-seams.py face0.jpg face1.jpg face2.jpg face3.jpg face4.jpg face5.jpg")

    faces = [
        np.asarray(Image.open(Path(path)).convert("RGB").resize((512, 512), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        for path in sys.argv[1:]
    ]
    top_bottom_scores = []
    for face, adjacent, points in seam_edges():
        if face not in (0, 5) and adjacent not in (0, 5):
            continue
        point_scores = []
        for direction, u, v in points:
            first = sample(faces[face], u, v)
            adjacent_u, adjacent_v = uv_for(adjacent, direction)
            second = sample(faces[adjacent], adjacent_u, adjacent_v)
            point_scores.append(float(np.mean(np.abs(first - second))))
        top_bottom_scores.append(float(np.median(point_scores)))

    print(
        json.dumps(
            {
                "topBottomMean": float(np.mean(top_bottom_scores)),
                "topBottomMax": float(np.max(top_bottom_scores)),
            }
        )
    )


if __name__ == "__main__":
    main()
