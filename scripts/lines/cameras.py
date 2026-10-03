#!/usr/bin/env python3
"""Write cameras.json: the first N capture cameras of a COLMAP model in world space.

  python3 cameras.py --model data/sparse/0 --out cameras.json [--count 3] [--ply color.ply]

"First" means the first N registered images sorted by file name (the capture order
for frame sequences). Every value is in the COLMAP world frame, which is also the
frame of a splat that Brush trains from that model (Brush keeps COLMAP coordinates;
pass --ply to print the splat centroid next to the camera centroid as a check).

Per camera:
  position         camera centre C = -R^T t
  target           C + forward (one unit ahead along the optical axis)
  forward, up      unit vectors in world space (camera looks along +z, image y points down,
                   so up = -y of the camera)
  quaternionOpenCV camera-to-world rotation [x, y, z, w], OpenCV/COLMAP camera axes
                   (x right, y down, z forward)
  quaternionThree  camera-to-world rotation [x, y, z, w] for a three.js camera
                   (x right, y up, looking down -z) = quaternionOpenCV * rotX(180 deg)
  fovY             vertical field of view in degrees from the intrinsics
Plus worldUp: the mean camera up vector over every registered image, a good guess at
the scene's vertical, since COLMAP's world axes are arbitrary.
Reads binary (cameras.bin/images.bin) or text (cameras.txt/images.txt) models.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np

CAMERA_PARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}
MODEL_IDS = {"SIMPLE_PINHOLE": 0, "PINHOLE": 1, "SIMPLE_RADIAL": 2, "RADIAL": 3, "OPENCV": 4,
             "OPENCV_FISHEYE": 5, "FULL_OPENCV": 6, "FOV": 7, "SIMPLE_RADIAL_FISHEYE": 8,
             "RADIAL_FISHEYE": 9, "THIN_PRISM_FISHEYE": 10}


def read_cameras(model: Path) -> dict:
    cams = {}
    if (model / "cameras.bin").exists():
        with open(model / "cameras.bin", "rb") as f:
            for _ in range(struct.unpack("<Q", f.read(8))[0]):
                cid, kind, w, h = struct.unpack("<iiQQ", f.read(24))
                params = struct.unpack(f"<{CAMERA_PARAMS[kind]}d", f.read(8 * CAMERA_PARAMS[kind]))
                cams[cid] = (kind, w, h, params)
    else:
        for line in open(model / "cameras.txt"):
            if line.startswith("#") or not line.strip():
                continue
            p = line.split()
            cams[int(p[0])] = (MODEL_IDS[p[1]], int(p[2]), int(p[3]), tuple(map(float, p[4:])))
    return cams


def read_images(model: Path) -> list:
    """[(name, qvec wxyz world-to-camera, tvec, camera_id)]"""
    out = []
    if (model / "images.bin").exists():
        with open(model / "images.bin", "rb") as f:
            for _ in range(struct.unpack("<Q", f.read(8))[0]):
                v = struct.unpack("<i7di", f.read(64))
                name = b""
                while (c := f.read(1)) != b"\x00":
                    name += c
                n2d = struct.unpack("<Q", f.read(8))[0]
                f.seek(n2d * 24, 1)
                out.append((name.decode(), np.array(v[1:5]), np.array(v[5:8]), v[8]))
    else:
        lines = [l for l in open(model / "images.txt") if not l.startswith("#")]
        for i in range(0, len(lines), 2):
            p = lines[i].split()
            if len(p) < 10:
                continue
            out.append((p[9], np.array(list(map(float, p[1:5]))), np.array(list(map(float, p[5:8]))), int(p[8])))
    return out


def qvec_to_R(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y]])


def R_to_xyzw(R):
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        w, x, y, z = 0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        w, x, y, z = (R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        w, x, y, z = (R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        w, x, y, z = (R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s
    q = np.array([x, y, z, w])
    return q / np.linalg.norm(q)


def ply_centroid(path: Path):
    """Mean of x, y, z in a binary little-endian 3DGS PLY (reads only the header + positions)."""
    types = {"float": "f4", "float32": "f4", "double": "f8", "uchar": "u1", "uint8": "u1",
             "int": "i4", "uint": "u4", "short": "i2", "ushort": "u2"}
    with open(path, "rb") as f:
        fields, count = [], 0
        while True:
            line = f.readline().decode("latin1").strip()
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line.startswith("property") and "list" not in line:
                _, kind, name = line.split()
                fields.append((name, "<" + types[kind]))
            elif line == "end_header":
                break
        data = np.frombuffer(f.read(count * np.dtype(fields).itemsize), dtype=fields, count=count)
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    return count, np.median(xyz, 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="COLMAP sparse/0 folder")
    ap.add_argument("--out", required=True)
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--ply", help="optional splat to sanity-check the frame against")
    a = ap.parse_args()

    model = Path(a.model)
    cams = read_cameras(model)
    imgs = sorted(read_images(model), key=lambda r: r[0])
    flip = np.diag([1.0, -1.0, -1.0])  # OpenCV camera axes -> three.js camera axes

    ups, centres, out = [], [], []
    for name, q, t, cid in imgs:
        Rwc = qvec_to_R(q)              # world -> camera
        Rcw = Rwc.T                     # camera -> world
        C = -Rcw @ t
        ups.append(Rcw @ np.array([0.0, -1.0, 0.0]))
        centres.append(C)
    world_up = np.mean(ups, 0); world_up /= np.linalg.norm(world_up)

    for name, q, t, cid in imgs[: a.count]:
        Rcw = qvec_to_R(q).T
        C = -Rcw @ t
        fwd = Rcw @ np.array([0.0, 0.0, 1.0])
        up = Rcw @ np.array([0.0, -1.0, 0.0])
        kind, w, h, params = cams[cid]
        fy = params[0] if kind in (0, 2, 3, 7, 8, 9) else params[1]
        out.append({
            "name": name,
            "position": [round(float(v), 6) for v in C],
            "target": [round(float(v), 6) for v in C + fwd],
            "forward": [round(float(v), 6) for v in fwd],
            "up": [round(float(v), 6) for v in up],
            "quaternionOpenCV": [round(float(v), 7) for v in R_to_xyzw(Rcw)],
            "quaternionThree": [round(float(v), 7) for v in R_to_xyzw(Rcw @ flip)],
            "fovY": round(math.degrees(2 * math.atan(h / (2 * fy))), 3),
            "width": int(w), "height": int(h),
        })

    doc = {
        "version": 1,
        "frame": "COLMAP world (same frame as the splat PLY files; units are COLMAP's, not metres)",
        "conventions": {
            "position": "camera centre in world space",
            "target": "a point 1 unit ahead of the camera along its optical axis",
            "quaternionOpenCV": "camera-to-world rotation [x,y,z,w]; camera axes x right, y down, z forward",
            "quaternionThree": "camera-to-world rotation [x,y,z,w] for a three.js camera; x right, y up, looks down -z",
            "worldUp": "mean of every registered camera's up vector, the scene's likely vertical",
        },
        "worldUp": [round(float(v), 6) for v in world_up],
        "cameraCentroid": [round(float(v), 6) for v in np.mean(centres, 0)],
        "registeredImages": len(imgs),
        "cameras": out,
    }
    if a.ply:
        n, med = ply_centroid(Path(a.ply))
        doc["splatMedian"] = [round(float(v), 6) for v in med]
        print(f"splat {a.ply}: {n} splats, median {med.round(3)}; camera centroid {np.mean(centres, 0).round(3)}")
    Path(a.out).write_text(json.dumps(doc, indent=1))
    print(f"wrote {a.out} ({len(out)} cameras of {len(imgs)})")


if __name__ == "__main__":
    main()
