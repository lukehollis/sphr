#!/usr/bin/env python3
"""Removes splats that only add weight to a trained 3DGS PLY, keeping everything the cameras saw.

  python clean_splat.py --input scene.ply --output clean.ply [--model <COLMAP sparse/0>]

Drops, in order:
- splats that are not finite or nearly invisible (opacity under 1/255);
- with --model, splats no capture camera could see (outside every camera's view): nothing constrained them
  in training, so they are guesses that only show up as junk when a visitor moves away from the path.

It does not remove large faint splats: on an outdoor capture, layers of them together make up the sky, and
removing the faintest 0.5 percent left a dark hole in it (held-out renders fell to 16 dB against the uncleaned
splat). Floaters from automatic exposure are fixed in training (sphr-train-3dgs), not afterwards.

Prints JSON with what was removed. Check the result with render_views.py on the held-out frames: the cleaned
splat should look the same from the cameras and cleaner from elsewhere.
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np

PLY_TYPES = {'float': 'f4', 'float32': 'f4', 'double': 'f8', 'uchar': 'u1', 'uint8': 'u1', 'int': 'i4', 'uint': 'u4', 'short': 'i2', 'ushort': 'u2'}
CAMERA_PARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}


def read_ply(path):
    with open(path, 'rb') as handle:
        header, fields, count = [], [], 0
        while True:
            line = handle.readline()
            header.append(line)
            text = line.decode('latin1').strip()
            if text.startswith('format') and 'binary_little_endian' not in text:
                raise SystemExit('Only binary little-endian PLY files are supported.')
            if text.startswith('element vertex'):
                count = int(text.split()[-1])
            elif text.startswith('property') and 'list' not in text:
                _, kind, name = text.split()
                fields.append((name, '<' + PLY_TYPES[kind]))
            elif text == 'end_header':
                break
        data = np.frombuffer(handle.read(count * np.dtype(fields).itemsize), dtype=fields, count=count)
    return header, data


def write_ply(path, header, data):
    with open(path, 'wb') as handle:
        for line in header:
            text = line.decode('latin1')
            handle.write(f'element vertex {len(data)}\n'.encode() if text.startswith('element vertex') else line)
        handle.write(data.tobytes())


def read_cameras(model):
    cameras, images = {}, []
    with open(Path(model) / 'cameras.bin', 'rb') as handle:
        for _ in range(struct.unpack('<Q', handle.read(8))[0]):
            camera, kind, width, height = struct.unpack('<iiQQ', handle.read(24))
            params = struct.unpack(f'<{CAMERA_PARAMS[kind]}d', handle.read(8 * CAMERA_PARAMS[kind]))
            fx, fy, cx, cy = (params[0], params[0], params[1], params[2]) if kind in (0, 2, 3) else params[:4]
            cameras[camera] = (width, height, fx, fy, cx, cy)
    with open(Path(model) / 'images.bin', 'rb') as handle:
        for _ in range(struct.unpack('<Q', handle.read(8))[0]):
            values = struct.unpack('<i7di', handle.read(64))
            while handle.read(1) != b'\x00':
                pass
            handle.seek(struct.unpack('<Q', handle.read(8))[0] * 24, 1)
            w, x, y, z = values[1:5]
            rotation = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                                 [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                                 [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])
            images.append((rotation, np.array(values[5:8]), cameras[values[8]]))
    return images


def seen_by_cameras(points, images, margin=0.1):
    """Whether each point projects inside at least one camera's image (grown by a margin) in front of it."""
    seen = np.zeros(len(points), dtype=bool)
    for rotation, translation, (width, height, fx, fy, cx, cy) in images:
        camera = points @ rotation.T + translation
        depth = camera[:, 2]
        ahead = depth > 1e-3
        u = np.where(ahead, fx * camera[:, 0] / np.where(ahead, depth, 1) + cx, -1e9)
        v = np.where(ahead, fy * camera[:, 1] / np.where(ahead, depth, 1) + cy, -1e9)
        seen |= ahead & (u > -margin * width) & (u < (1 + margin) * width) & (v > -margin * height) & (v < (1 + margin) * height)
    return seen


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', type=Path, help='COLMAP model the splat was trained from')
    args = parser.parse_args()
    header, data = read_ply(args.input)
    names = data.dtype.names
    if not {'x', 'y', 'z', 'opacity', 'scale_0'} <= set(names):
        raise SystemExit('Not a 3DGS PLY (needs x, y, z, opacity and scale fields).')
    points = np.stack([data['x'], data['y'], data['z']], -1).astype(np.float64)
    opacity = 1 / (1 + np.exp(-data['opacity'].astype(np.float64)))
    largest = np.exp(np.max(np.stack([data[f'scale_{axis}'] for axis in range(3)], -1), axis=-1).astype(np.float64))
    removed = {}
    keep = np.isfinite(points).all(axis=1) & np.isfinite(opacity) & np.isfinite(largest)
    removed['notFinite'] = int((~keep).sum())
    faint = keep & (opacity < 1 / 255)
    removed['invisible'] = int(faint.sum())
    keep &= ~faint
    if args.model:
        unseen = keep & ~seen_by_cameras(points, read_cameras(args.model))
        removed['outsideEveryCamera'] = int(unseen.sum())
        keep &= ~unseen
    write_ply(args.output, header, data[keep])
    print(json.dumps({'input': len(data), 'kept': int(keep.sum()), 'removed': removed,
                      'bytes': args.output.stat().st_size, 'output': str(args.output)}))


if __name__ == '__main__':
    main()
