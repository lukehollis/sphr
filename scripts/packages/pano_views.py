#!/usr/bin/env python3
"""Cuts equirectangular 360 images into overlapping perspective views for reconstruction.

COLMAP and splat trainers need pinhole photographs, so each 360 frame becomes a ring of views around
the horizon (and optionally a ring looking up), all sharing one pinhole camera. Views stay level or
above it, which leaves out the selfie stick, tripod and photographer below a 360 camera.

  python pano_views.py --input <360 images or a folder> --output <views folder> [--views 8] [--fov 90]
                       [--size 1280] [--up-ring 0]

Views are named <frame>_<ring><index>.jpg so that sorting by name keeps each frame's views together,
in capture order; match them with COLMAP's sequential matcher and an overlap of at least three
frames' worth of views. Prints JSON with the view count and the camera to give COLMAP.
"""
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'}


def rotation(yaw, pitch):
    """Camera-to-world rotation for a camera looking along +z (y down), turned by yaw then tilted by pitch (up)."""
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    turn = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    tilt = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]])
    return turn @ tilt


def view_maps(size, fov, yaw, pitch, width, height):
    """Pixel lookup tables from a size x size pinhole view into a width x height equirectangular image."""
    focal = size / 2 / math.tan(fov / 2)
    u, v = np.meshgrid(np.arange(size) + 0.5, np.arange(size) + 0.5)
    rays = np.stack([(u - size / 2) / focal, (v - size / 2) / focal, np.ones_like(u)], axis=-1)
    rays = rays @ rotation(yaw, pitch).T
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    longitude = np.arctan2(rays[..., 0], rays[..., 2])
    latitude = np.arcsin(np.clip(-rays[..., 1], -1, 1))
    map_x = ((longitude / (2 * math.pi) + 0.5) * width - 0.5).astype(np.float32)
    map_y = ((0.5 - latitude / math.pi) * height - 0.5).astype(np.float32)
    return map_x, map_y, focal


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--views', type=int, default=8, help='Views around the horizon per frame')
    parser.add_argument('--fov', type=float, default=90, help='Field of view of each view, degrees')
    parser.add_argument('--size', type=int, default=1280, help='Width and height of each view, pixels')
    parser.add_argument('--up-ring', type=int, default=0, help='Extra views tilted 45 degrees up (ceilings, canopies)')
    args = parser.parse_args()
    images = sorted(path for source in args.input for path in ([source] if source.is_file() else source.rglob('*'))
                    if path.suffix.lower() in EXTENSIONS)
    if not images:
        raise SystemExit('No 360 images found.')
    args.output.mkdir(parents=True, exist_ok=True)
    fov = math.radians(args.fov)
    rings = [(0.0, args.views, 'h')] + ([(math.radians(45), args.up_ring, 'u')] if args.up_ring else [])
    maps, written, skipped = {}, 0, []
    for index, path in enumerate(images):
        pano = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if pano is None:
            skipped.append({'file': path.name, 'reason': 'unreadable'})
            continue
        height, width = pano.shape[:2]
        if abs(width / height - 2) > 0.05:
            skipped.append({'file': path.name, 'reason': f'not a 2:1 equirectangular image ({width}x{height})'})
            continue
        for pitch, count, ring in rings:
            for view in range(count):
                key = (width, height, pitch, view, count)
                if key not in maps:
                    maps[key] = view_maps(args.size, fov, 2 * math.pi * view / count, pitch, width, height)
                map_x, map_y, focal = maps[key]
                out = cv2.remap(pano, map_x, map_y, cv2.INTER_AREA if width / 4 > args.size else cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_WRAP)
                cv2.imwrite(str(args.output / f'{index + 1:05d}_{ring}{view}.jpg'), out, [cv2.IMWRITE_JPEG_QUALITY, 94])
                written += 1
    if not written:
        raise SystemExit(json.dumps({'error': 'No equirectangular images could be cut.', 'skipped': skipped}))
    focal = args.size / 2 / math.tan(fov / 2)
    camera = f'{focal:.3f},{focal:.3f},{args.size / 2:.1f},{args.size / 2:.1f}'
    print(json.dumps({'frames': len(images) - len(skipped), 'views': written, 'viewsPerFrame': args.views + args.up_ring,
                      'size': args.size, 'fovDegrees': args.fov, 'cameraModel': 'PINHOLE', 'cameraParams': camera,
                      'skipped': skipped, 'output': str(args.output)}))


if __name__ == '__main__':
    main()
