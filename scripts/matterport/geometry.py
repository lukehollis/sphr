"""Metric camera geometry shared by conversion and independent validation."""

import numpy as np

# SPHR plane order: up, +Z, -X, -Z, +X, down. Image rows run downwards.
CENTERS = np.array(
    [[0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, -1, 0]], dtype=float
)
RIGHTS = np.array(
    [[-1, 0, 0], [-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]], dtype=float
)
UPS = np.array(
    [[0, 0, -1], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1]], dtype=float
)
C = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)


def camera_face_assignment(scan_rotation, image_rotations):
    """Use camera poses, never image names, to determine face order and rotation."""
    group = C @ scan_rotation @ C.T
    assignments = []
    used = set()
    for face in range(6):
        target = group @ np.stack([RIGHTS[face], UPS[face], CENTERS[face]], axis=1)
        best = None
        for index, rotation in enumerate(image_rotations):
            r, u, f = (C @ rotation).T
            f = -f  # E57 pinhole cameras look along negative Z.
            for turn in range(4):
                rr, uu = [(r, u), (-u, r), (-r, -u), (u, -r)][turn]
                residual = np.max(np.abs(np.stack([rr, uu, f], axis=1) - target))
                if best is None or residual < best[0]:
                    best = (residual, index, turn * 90)
        residual, index, degrees = best
        if residual > 2e-4 or index in used:
            raise ValueError(
                f"Images do not form a calibrated six-face cube (face {face}, residual {residual})."
            )
        used.add(index)
        assignments.append((index, degrees, float(residual)))
    return group, assignments


def estimate_floor(points, camera, expected_height=None):
    delta = points - camera
    radius = np.linalg.norm(delta[:, [0, 2]], axis=1)
    # Expand only when the nadir is unmeasured (common on dark or reflective floors).
    # The height prior is learned from measured floors in this capture, not a fixed offset.
    minimum = max(0.5, expected_height * 0.72) if expected_height else 0.8
    maximum = min(2.8, expected_height * 1.4) if expected_height else 2.5
    for search_radius in [0.9, 1.5, 3.0, 5.0]:
        sample = points[
            (radius > 0.16)
            & (radius < search_radius)
            & (delta[:, 1] < -minimum)
            & (delta[:, 1] > -maximum)
        ]
        if len(sample) < 50:
            continue
        bins = np.arange(camera[1] - maximum, camera[1] - minimum + 0.026, 0.025)
        hist, edges = np.histogram(sample[:, 1], bins=bins)
        peak = int(np.argmax(hist))
        if hist[peak] < max(50, len(sample) * 0.08):
            continue
        level = (edges[peak] + edges[peak + 1]) * 0.5
        patch = sample[np.abs(sample[:, 1] - level) < 0.045]
        a = np.column_stack(
            [patch[:, 0] - camera[0], patch[:, 2] - camera[2], np.ones(len(patch))]
        )
        coef = np.linalg.lstsq(a, patch[:, 1], rcond=None)[0]
        residual = np.abs(a @ coef - patch[:, 1])
        if np.linalg.norm(coef[:2]) > 0.3:
            continue
        floor = float(coef[2])
        return floor, {
            "method": "measured-local-plane",
            "searchRadiusMeters": search_radius,
            "points": len(patch),
            "cameraHeight": float(camera[1] - floor),
            "medianResidualMeters": float(np.median(residual)),
        }
    raise ValueError("No supported floor plane found within five meters of scan camera")
