"""Metric camera geometry shared by conversion and independent validation."""

import numpy as np
from scipy.spatial import ConvexHull, QhullError

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
    # Captures can mix ordinary tripod scans with elevated scans of frescoes.
    # Search the measured vertical extent instead of imposing the previous tripod height.
    below = camera[1] - points[(radius < 5.0) & np.isfinite(points).all(1), 1]
    below = below[below > 0.3]
    if len(below) < 50:
        raise ValueError("No measured floor points below scan camera")
    minimum = 0.3
    maximum = float(np.quantile(below, 0.999)) + 0.05
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
        # A thin horizontal stripe on a wall is not a two-dimensional floor patch.
        spread = np.linalg.eigvalsh(np.cov(patch[:, [0, 2]], rowvar=False))
        if len(patch) < 50 or spread[0] < 0.0036:
            continue
        try:
            footprint = ConvexHull(patch[:, [0, 2]] - camera[[0, 2]])
        except QhullError:
            continue
        # A shelf/ledge beside the scan cannot support a marker under the camera.
        # Permit a small unmeasured edge around the tripod, not meter-scale extrapolation.
        outside = float(np.max(footprint.equations[:, 2]))
        if footprint.volume < 0.04 or outside > 0.25:
            continue
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
            "footprintAreaSquareMeters": float(footprint.volume),
            "footprintExtrapolationMeters": max(0.0, outside),
        }
    raise ValueError("No supported floor plane found within five meters of scan camera")
